import { createServer } from 'node:http';
import { homedir, networkInterfaces, tmpdir } from 'node:os';
import { watch } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import Busboy from 'busboy';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { logger } from './logger.js';
import { exportPdf, exportFromImages, ExportError, type RenderedPage } from './exporter.js';
import { regenerateAsAcroForm } from './regenerator.js';
import { analyzePdf } from './analyzer.js';
import type {
  BrowseResponse,
  DirectoryEntry,
  FpdfDocument,
  UiCapabilitiesResponse,
} from './types.js';

/**
 * Write `content` to `dest` atomically by first writing to `dest.tmp` and
 * then renaming into place.  POSIX `rename(2)` is a single syscall, so the
 * `fs.watch` listener can never observe a partial file — it only fires on the
 * rename event, at which point the destination is already complete.
 */
async function writeJsonAtomic(dest: string, content: string): Promise<void> {
  const tmp = `${dest}.tmp`;
  await writeFile(tmp, content, 'utf-8');
  await rename(tmp, dest);
}

export interface ServerOptions {
  /** Absolute path to the PDF file being served. Omit to start in picker mode. */
  pdfPath?: string;
  /** The parsed FpdfDocument for this session. Omit to start in picker mode. */
  doc?: FpdfDocument;
  /** Absolute path to the .fpdf.json file (used for WebSocket save writes). Omit to start in picker mode. */
  jsonPath?: string;
  /** Exit the process 1 s after the last WebSocket client disconnects. Default false. */
  autoShutdown?: boolean;
  /** Hostname to bind to. Defaults to '127.0.0.1'. Use '0.0.0.0' to listen on all interfaces. */
  host?: string;
  /** TCP port to bind to. Defaults to 0 (OS-allocated). If specified and the port is already in use, startServer throws. */
  port?: number;
  /**
   * Session ID used to name the upload temp directory (`os.tmpdir()/fpdf-<sessionId>`).
   * Auto-generated (UUID v4) if omitted. Useful for tests to pin a predictable path.
   */
  sessionId?: string;
}

export interface ServerHandle {
  /** The primary URL the server is listening on, e.g. "http://127.0.0.1:51234". */
  url: string;
  /**
   * All URLs the server is reachable on. When bound to a specific host this is
   * just [url]. When bound to 0.0.0.0 this includes one entry per non-loopback
   * IPv4 interface plus the loopback URL.
   */
  networkUrls: string[];
  /**
   * Session owner token. Set when the server starts in fill mode (either via options
   * or after POST /open / POST /upload). Null in picker mode.
   *
   * The CLI uses this to construct the initial browser URL:
   *   `${url}/?session=${ownerToken}`
   * The catch-all route accepts that query param on first visit, sets the
   * `fpdf-session` cookie, and redirects to `/`. Subsequent requests are
   * authenticated by the cookie; browsers without the cookie see the picker.
   */
  ownerToken: string | null;
  /** Shut down the server and close all WebSocket connections. */
  close: () => Promise<void>;
}

/**
 * Start the local fpdf Express server bound to 127.0.0.1 on an OS-allocated
 * port. Serves:
 *   GET /pdf        — raw PDF bytes
 *   GET /doc        — the FpdfDocument as JSON
 *   GET /browse     — directory listing for the file picker
 *   POST /open      — analyze a PDF and transition to fill mode
 *   GET /           — the web UI shell (picker or fill depending on state)
 *   WS  /ws         — WebSocket channel for live save (field edits → JSON write)
 *
 * When called with no options (or empty options), the server starts in picker
 * mode: it serves the file picker UI and waits for POST /open.
 *
 * @returns A ServerHandle with the allocated URL and a close() function.
 */
/** Cookie name used to authenticate the session owner in the browser. */
const FPDF_SESSION_COOKIE = 'fpdf-session';

export async function startServer(options: ServerOptions): Promise<ServerHandle> {
  const sessionId = options.sessionId ?? randomUUID();

  let liveDoc: FpdfDocument | null = options.doc ?? null;
  let currentPdfPath: string | null = options.pdfPath ?? null;
  let currentJsonPath: string | null = options.jsonPath ?? null;
  let analyzeInProgress = false;
  /** True when the current session was opened via POST /upload (not from a server-local path). */
  let isUploadSession = false;
  /** Temp directory created for upload sessions; cleaned up on reset/close. */
  let sessionTempDir: string | null = null;
  /**
   * Identifies the session owner. Set when fill mode starts (either at server
   * creation or on POST /open / POST /upload). Cleared on POST /reset.
   * The browser that owns the session holds a matching `fpdf-session` cookie;
   * clients without the cookie see the picker even when liveDoc is set.
   */
  let ownerToken: string | null = options.doc !== undefined ? randomUUID() : null;

  async function cleanupTempDir(): Promise<void> {
    if (sessionTempDir === null) return;
    const dir = sessionTempDir;
    sessionTempDir = null;
    logger.info(`Cleaning up temp directory: '${dir}'`);
    await rm(dir, { recursive: true, force: true });
  }

  // Content of the last server-initiated write.  The file watcher compares the
  // reloaded content against this string to detect its own echo: if they match,
  // the event was caused by the server itself and the reload is skipped.
  //
  // A content-hash guard is more reliable than a boolean flag on macOS: if
  // FSEvents coalesces two file-write events into one (a known FSEvents
  // behaviour), the watcher reads the LATEST content.  When that latest content
  // differs from what the server last wrote (i.e. an external edit has since
  // landed), the reload correctly fires.  A boolean would have been consumed by
  // the coalesced event and silently suppressed the external reload.
  let lastServerWriteContent: string | null = null;

  const app = express();
  app.use(express.json({ limit: '50mb' }));

  const localHostAddresses = new Set<string>(['127.0.0.1', '::1']);
  for (const iface of Object.values(networkInterfaces())) {
    if (!iface) continue;
    for (const info of iface) {
      localHostAddresses.add(info.address);
    }
  }

  // --- Helpers ---

  // Resolves a user-supplied path to an absolute, normalised path.
  // path.resolve handles . and .. so no additional root restriction is needed.
  function resolveSafePath(requested: string): string {
    return path.resolve(requested);
  }

  /** Extract the fpdf-session cookie value from an incoming request, or null if absent. */
  function getSessionCookie(req: express.Request): string | null {
    const raw = req.headers.cookie ?? '';
    for (const part of raw.split(';')) {
      const eqIdx = part.indexOf('=');
      if (eqIdx === -1) continue;
      const name = part.slice(0, eqIdx).trim();
      const value = part.slice(eqIdx + 1).trim();
      if (name === FPDF_SESSION_COOKIE) return value || null;
    }
    return null;
  }

  /** Set the fpdf-session cookie on a response. */
  function setSessionCookie(res: express.Response, token: string): void {
    res.setHeader('Set-Cookie', `${FPDF_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`);
  }

  /** Clear the fpdf-session cookie on a response. */
  function clearSessionCookie(res: express.Response): void {
    res.setHeader(
      'Set-Cookie',
      `${FPDF_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    );
  }

  function normalizeIp(raw: string | undefined): string | null {
    if (!raw) return null;
    if (raw.startsWith('::ffff:')) {
      return raw.slice('::ffff:'.length);
    }
    return raw;
  }

  function isSameHostClient(remoteAddress: string | undefined): boolean {
    const normalized = normalizeIp(remoteAddress);
    if (normalized === null) return false;
    return localHostAddresses.has(normalized);
  }

  // Returns the non-null doc context if the server is in fill mode.
  // Otherwise sends 503 and returns null.
  interface DocContext {
    pdfPath: string;
    doc: FpdfDocument;
    jsonPath: string;
  }
  function requireDoc(res: express.Response): DocContext | null {
    if (liveDoc === null || currentPdfPath === null || currentJsonPath === null) {
      res.status(503).json({ error: 'No PDF loaded yet' });
      return null;
    }
    return { pdfPath: currentPdfPath, doc: liveDoc, jsonPath: currentJsonPath };
  }

  // --- Health check ---
  app.get('/health', (_req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    res.send('ok');
  });

  // --- PDF bytes ---
  app.get('/pdf', (_req, res) => {
    const run = async (): Promise<void> => {
      const ctx = requireDoc(res);
      if (ctx === null) return;
      const bytes = await readFile(ctx.pdfPath);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', String(bytes.length));
      res.end(bytes);
    };
    run().catch((err: unknown) => {
      logger.error(`Failed to serve PDF: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: 'Failed to read PDF' });
    });
  });

  // --- Filled PDF export ---
  const sendFilledPdf = (req: express.Request, res: express.Response): void => {
    const run = async (): Promise<void> => {
      const ctx = requireDoc(res);
      if (ctx === null) return;
      const body = (req.body ?? {}) as { doc?: unknown };
      const docForExport =
        typeof body.doc === 'object' && body.doc !== null ? (body.doc as FpdfDocument) : ctx.doc;
      const filled = await exportPdf(ctx.pdfPath, docForExport, { readOnly: true });
      const stem = path.basename(
        docForExport.metadata.pdfFilename,
        path.extname(docForExport.metadata.pdfFilename),
      );
      const filename = `${stem}-filled.pdf`;
      const disposition = isUploadSession ? 'attachment' : 'inline';
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`);
      res.setHeader('Content-Length', String(filled.length));
      res.end(Buffer.from(filled));
    };
    run().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof ExportError) {
        logger.debug(`Primary export unavailable, client will use canvas fallback: ${msg}`);
      } else {
        logger.error(`Failed to export PDF: ${msg}`);
      }
      res.status(500).json({ error: err instanceof ExportError ? msg : 'Failed to export PDF' });
    });
  };
  app.get('/filled-pdf', (req, res) => {
    sendFilledPdf(req, res);
  });
  app.post('/filled-pdf', (req, res) => {
    sendFilledPdf(req, res);
  });

  // --- FpdfDocument JSON ---
  app.get('/doc', (_req, res) => {
    const ctx = requireDoc(res);
    if (ctx === null) return;
    res.json(ctx.doc);
  });

  // --- Save candidate fields as an editable AcroForm PDF to disk ---
  // Produces <name>.fpdf.acroform.pdf alongside the source PDF.  Fields are
  // left editable so the recipient can fill them in any standard PDF viewer.
  //
  // For upload sessions (remote access), the file is returned as an attachment
  // instead of being written to the server's disk.
  app.post('/save-acroform', (_req, res) => {
    const run = async (): Promise<void> => {
      const ctx = requireDoc(res);
      if (ctx === null) return;
      const body = (_req.body ?? {}) as { doc?: unknown };
      const docForExport =
        typeof body.doc === 'object' && body.doc !== null ? (body.doc as FpdfDocument) : ctx.doc;
      const filled = await exportPdf(ctx.pdfPath, docForExport);
      if (isUploadSession) {
        const stem = path.basename(
          docForExport.metadata.pdfFilename,
          path.extname(docForExport.metadata.pdfFilename),
        );
        const filename = `${stem}.fpdf.acroform.pdf`;
        const serverPath = path.join(path.dirname(ctx.pdfPath), filename);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Length', String(filled.length));
        res.end(Buffer.from(filled));
        logger.info(
          `Streamed AcroForm PDF (upload session) → '${filename}' [server path: '${serverPath}']`,
        );
      } else {
        const base = ctx.pdfPath.replace(/\.[^.]+$/, '');
        const outPath = `${base}.fpdf.acroform.pdf`;
        await writeFile(outPath, filled);
        logger.info(`Saved AcroForm PDF → ${outPath}`);
        res.json({ ok: true, path: outPath });
      }
    };
    run().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof ExportError) {
        logger.debug(
          `save-acroform: primary export unavailable, client will use canvas fallback: ${msg}`,
        );
      } else {
        logger.error(`save-acroform failed: ${msg}`);
      }
      res.status(500).json({ error: msg });
    });
  });

  // --- Canvas-based fallback export (encrypted PDFs) ---
  // Accepts pre-rendered page images from the browser and assembles a new PDF.
  app.post('/export-canvas', (_req, res) => {
    const run = async (): Promise<void> => {
      const ctx = requireDoc(res);
      if (ctx === null) return;
      const body = _req.body as {
        pages?: { jpeg: string; widthPt: number; heightPt: number }[];
        doc?: unknown;
      };
      if (!Array.isArray(body.pages) || body.pages.length === 0) {
        res.status(400).json({ error: 'Missing pages array' });
        return;
      }
      const pages: RenderedPage[] = body.pages.map((p) => ({
        jpeg: new Uint8Array(Buffer.from(p.jpeg, 'base64')),
        widthPt: p.widthPt,
        heightPt: p.heightPt,
      }));
      // Prefer the browser's live in-memory doc (includes user-created fields
      // not yet saved via WebSocket) over the server's potentially stale liveDoc.
      const docForExport =
        typeof body.doc === 'object' && body.doc !== null ? (body.doc as FpdfDocument) : ctx.doc;
      // Export PDF: finalized read-only output — fields have no interactive editing.
      const filled = await exportFromImages(pages, docForExport, true);
      const stem = path.basename(
        docForExport.metadata.pdfFilename,
        path.extname(docForExport.metadata.pdfFilename),
      );
      const filename = `${stem}-filled.pdf`;
      const disposition = isUploadSession ? 'attachment' : 'inline';
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`);
      res.setHeader('Content-Length', String(filled.length));
      res.end(Buffer.from(filled));
    };
    run().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`export-canvas failed: ${msg}`);
      res.status(500).json({ error: msg });
    });
  });

  // --- XFA → AcroForm regeneration ---
  app.post('/regenerate-acroform', (_req, res) => {
    const run = async (): Promise<void> => {
      const ctx = requireDoc(res);
      if (ctx === null) return;
      const result = await regenerateAsAcroForm(ctx.pdfPath, ctx.doc);
      currentPdfPath = result.newPdfPath;
      currentJsonPath = result.newJsonPath;
      liveDoc = result.newDoc;
      const content = JSON.stringify(liveDoc, null, 2);
      lastServerWriteContent = content;
      await writeJsonAtomic(currentJsonPath, content);
      resetJsonWatcher(path.dirname(currentJsonPath));
      broadcast(JSON.stringify({ type: 'pdfRegenerated', doc: liveDoc }));
      res.json({ ok: true });
    };
    run().catch((err: unknown) => {
      logger.error(
        `regenerate-acroform failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.status(500).json({ error: String(err) });
    });
  });

  // --- File picker: directory listing ---
  app.get('/browse', (_req, res) => {
    const run = async (): Promise<void> => {
      const raw = typeof _req.query.path === 'string' ? _req.query.path : homedir();
      const safePath = resolveSafePath(raw);
      const dirents = await readdir(safePath, { withFileTypes: true });
      const entries: DirectoryEntry[] = [];
      for (const e of dirents) {
        if (e.name.startsWith('.')) continue;
        if (e.isDirectory()) {
          entries.push({ name: e.name, kind: 'dir' });
        } else if (e.isFile() && e.name.toLowerCase().endsWith('.pdf')) {
          entries.push({ name: e.name, kind: 'pdf' });
        }
      }
      entries.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
        return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      });
      const response: BrowseResponse = { resolvedPath: safePath, entries };
      res.json(response);
    };
    run().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`/browse failed: ${msg}`);
      res.status(500).json({ error: msg });
    });
  });

  // --- UI capabilities ---
  // Browsing the server filesystem is only enabled when the UI is opened from
  // the same host as the backend process. Remote clients can still upload.
  app.get('/ui-capabilities', (req, res) => {
    const response: UiCapabilitiesResponse = {
      canBrowseServerFiles: isSameHostClient(req.socket.remoteAddress),
    };
    res.json(response);
  });

  // --- File picker: open a PDF and transition to fill mode ---
  app.post('/open', (_req, res) => {
    const run = async (): Promise<void> => {
      const body = (_req.body ?? {}) as { filePath?: unknown };
      if (typeof body.filePath !== 'string' || body.filePath === '') {
        res.status(400).json({ error: 'filePath required' });
        return;
      }
      if (!body.filePath.toLowerCase().endsWith('.pdf')) {
        res.status(400).json({ error: 'File must be a .pdf' });
        return;
      }
      if (analyzeInProgress) {
        res.status(409).json({ error: 'Analysis already in progress' });
        return;
      }

      analyzeInProgress = true;
      try {
        const safePath = resolveSafePath(body.filePath);
        const stem = path.basename(safePath, path.extname(safePath));
        const jsonPath = path.join(path.dirname(safePath), `${stem}.fpdf.json`);

        // If a companion .fpdf.json already exists on disk, load it instead of
        // re-analyzing (which would discard previously saved field values).
        let existingJsonText: string | null = null;
        try {
          existingJsonText = await readFile(jsonPath, 'utf-8');
        } catch {
          // No sidecar — will analyze below.
        }

        let doc: FpdfDocument;
        if (existingJsonText !== null) {
          doc = JSON.parse(existingJsonText) as FpdfDocument;
        } else {
          doc = await analyzePdf(safePath);
          const content = JSON.stringify(doc, null, 2);
          lastServerWriteContent = content;
          await writeJsonAtomic(jsonPath, content);
        }

        currentPdfPath = safePath;
        currentJsonPath = jsonPath;
        liveDoc = doc;
        ownerToken = randomUUID();
        resetJsonWatcher(path.dirname(jsonPath));
        broadcast(JSON.stringify({ type: 'pdfOpened', doc }));
        setSessionCookie(res, ownerToken);
        res.json({ ok: true });
      } finally {
        analyzeInProgress = false;
      }
    };
    run().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`/open failed: ${msg}`);
      res.status(500).json({ error: msg });
    });
  });

  // --- Upload: accept a PDF (+ optional session JSON) from the browser ---
  // Used when accessing fpdf remotely; the user's PDF never lives on the server.
  // Multipart body:
  //   pdf  (required) — raw PDF bytes
  //   json (optional) — companion .fpdf.json to resume a prior session
  //
  // Writes to os.tmpdir()/fpdf-<sessionId>/ and transitions to fill mode.
  app.post('/upload', (req, res) => {
    const run = async (): Promise<void> => {
      if (analyzeInProgress) {
        res.status(409).json({ error: 'Analysis already in progress' });
        return;
      }

      analyzeInProgress = true;
      try {
        logger.info(
          `Upload started from ${req.socket.remoteAddress ?? 'unknown'} (session ${sessionId})`,
        );

        const tempDir = path.join(tmpdir(), `fpdf-${sessionId}`);
        await mkdir(tempDir, { recursive: true });

        let pdfUploadedFilename = 'uploaded.pdf';
        let jsonUploadedFilename: string | null = null;

        const uploadedJsonContent = await new Promise<string | null>((resolve, reject) => {
          const bb = Busboy({
            headers: req.headers as Record<string, string>,
            limits: { files: 2, fileSize: 100 * 1024 * 1024 },
          });

          let hasPdf = false;
          let pdfTruncated = false;
          let pdfSizeBytes = 0;
          let jsonSizeBytes = 0;
          let jsonChunks: Buffer[] | null = null;
          const pendingWrites: Promise<void>[] = [];

          bb.on('file', (fieldname, fileStream, info) => {
            if (fieldname === 'pdf') {
              pdfUploadedFilename = path.basename(info.filename) || 'uploaded.pdf';
              const chunks: Buffer[] = [];
              fileStream.on('data', (chunk: Buffer) => {
                chunks.push(chunk);
                pdfSizeBytes += chunk.length;
              });
              fileStream.on('limit', () => {
                pdfTruncated = true;
              });
              fileStream.on('end', () => {
                if (!pdfTruncated) {
                  hasPdf = true;
                  pendingWrites.push(
                    writeFile(path.join(tempDir, 'orig.pdf'), Buffer.concat(chunks)),
                  );
                }
              });
            } else if (fieldname === 'json') {
              jsonUploadedFilename = path.basename(info.filename) || 'session.fpdf.json';
              jsonChunks = [];
              const jc = jsonChunks;
              fileStream.on('data', (chunk: Buffer) => {
                jc.push(chunk);
                jsonSizeBytes += chunk.length;
              });
              fileStream.on('end', () => {
                // jsonChunks stays non-null; we'll read it in finish
              });
            } else {
              fileStream.resume();
            }
          });

          bb.on('finish', () => {
            if (pdfTruncated) {
              reject(new Error('PDF file exceeds the 100 MB upload limit'));
              return;
            }
            if (!hasPdf) {
              reject(new Error('pdf field is required'));
              return;
            }
            const pdfPath = path.join(tempDir, 'orig.pdf');
            const pdfMsg = `pdf='${pdfUploadedFilename}' (${String(pdfSizeBytes)} bytes) → '${pdfPath}'`;
            const fullMsg =
              jsonChunks !== null && jsonUploadedFilename
                ? `${pdfMsg}, json='${jsonUploadedFilename}' (${String(jsonSizeBytes)} bytes) → '${path.join(tempDir, 'session.fpdf.json')}'`
                : pdfMsg;
            logger.info(`Upload received ${fullMsg}`);
            const jsonText =
              jsonChunks !== null ? Buffer.concat(jsonChunks).toString('utf-8') : null;
            Promise.all(pendingWrites)
              .then(() => {
                resolve(jsonText);
              })
              .catch(reject);
          });

          bb.on('error', (err: unknown) => {
            reject(err instanceof Error ? err : new Error(String(err)));
          });

          req.pipe(bb);
        });

        const tempPdfPath = path.join(tempDir, 'orig.pdf');
        const tempJsonPath = path.join(tempDir, 'session.fpdf.json');

        let doc: FpdfDocument;
        if (uploadedJsonContent !== null) {
          doc = JSON.parse(uploadedJsonContent) as FpdfDocument;
        } else {
          doc = await analyzePdf(tempPdfPath);
        }

        // Keep the uploaded filename in metadata so exports use a meaningful name.
        doc.metadata.pdfFilename = pdfUploadedFilename;
        doc.metadata.originalPdf = tempPdfPath;

        const content = JSON.stringify(doc, null, 2);
        lastServerWriteContent = content;
        await writeJsonAtomic(tempJsonPath, content);

        // Record the session temp dir so close() can clean it up on shutdown.
        sessionTempDir = tempDir;
        currentPdfPath = tempPdfPath;
        currentJsonPath = tempJsonPath;
        liveDoc = doc;
        isUploadSession = true;
        ownerToken = randomUUID();
        resetJsonWatcher(tempDir);
        broadcast(JSON.stringify({ type: 'pdfOpened', doc, uploaded: true }));
        setSessionCookie(res, ownerToken);
        res.json({ ok: true });
      } finally {
        analyzeInProgress = false;
      }
    };
    run().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`/upload failed: ${msg}`);
      res.status(500).json({ error: msg });
    });
  });

  // --- Session JSON download (upload sessions) ---
  // Returns the current in-memory FpdfDocument as a JSON attachment so the
  // user can save it locally and re-upload it next time to resume their session.
  app.get('/session-json', (_req, res) => {
    const ctx = requireDoc(res);
    if (ctx === null) return;
    const content = JSON.stringify(ctx.doc, null, 2);
    const stem = path.basename(
      ctx.doc.metadata.pdfFilename,
      path.extname(ctx.doc.metadata.pdfFilename),
    );
    const filename = `${stem}.fpdf.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.end(content);
  });

  // --- Reset: return to picker mode ---
  app.post('/reset', (_req, res) => {
    try {
      liveDoc = null;
      currentPdfPath = null;
      currentJsonPath = null;
      isUploadSession = false;
      ownerToken = null;
      jsonWatcher?.close();
      jsonWatcher = null;
      broadcast(JSON.stringify({ type: 'pickerMode' }));
      clearSessionCookie(res);
      res.json({ ok: true });
    } catch (err: unknown) {
      logger.error(`/reset failed: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: String(err) });
    }
  });

  // --- Static UI assets ---
  const publicDir = path.join(path.dirname(new URL(import.meta.url).pathname), 'public');
  // Disable automatic index.html serving so the catch-all below can decide
  // which shell to serve based on whether a PDF has been loaded.
  app.use(express.static(publicDir, { index: false }));

  // --- Catch-all: serve pick.html in picker mode, index.html in fill mode ---
  //
  // Session isolation: when the server is in fill mode, only the browser that
  // owns the session (identified by the `fpdf-session` cookie) receives
  // index.html.  Any other browser — incognito, a different user, a fresh tab
  // — receives pick.html so they start at the picker instead of landing in the
  // middle of someone else's fill session.
  //
  // First-visit flow (CLI `--open` or any link that includes the token):
  //   GET /?session=<ownerToken>  →  set cookie, 302 to /
  //   GET /                (with cookie)  →  index.html
  app.get(/.*/, (req, res) => {
    const run = async (): Promise<void> => {
      if (liveDoc === null || ownerToken === null) {
        // Picker mode — always serve pick.html.
        const html = await readFile(path.join(publicDir, 'pick.html'), 'utf-8');
        res.setHeader('Content-Type', 'text/html');
        res.end(html);
        return;
      }

      // Fill mode: check session ownership.
      const sessionParam = typeof req.query.session === 'string' ? req.query.session : null;
      if (sessionParam === ownerToken) {
        // First visit with the URL token (e.g. from CLI --open).
        // Mint the cookie and redirect to the clean root URL.
        setSessionCookie(res, ownerToken);
        res.redirect(302, '/');
        return;
      }

      const cookieToken = getSessionCookie(req);
      if (cookieToken !== ownerToken) {
        // No matching cookie — different browser / incognito / different user.
        // Show the picker so they can start their own session.
        const html = await readFile(path.join(publicDir, 'pick.html'), 'utf-8');
        res.setHeader('Content-Type', 'text/html');
        res.end(html);
        return;
      }

      const html = await readFile(path.join(publicDir, 'index.html'), 'utf-8');
      res.setHeader('Content-Type', 'text/html');
      res.end(html);
    };
    run().catch((_err: unknown) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<!DOCTYPE html><html><body><p>UI not yet built. Run <code>npm run build:ui</code>.</p></body></html>',
      );
    });
  });

  const httpServer = createServer(app);

  // --- WebSocket server ---
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  // When httpServer emits an error (e.g. EADDRINUSE), the WebSocketServer
  // re-emits the same error on itself.  The httpServer 'error' handler below
  // already rejects the startup promise; this listener prevents Node from
  // treating the WSS re-emission as an unhandled error event and crashing.
  wss.on('error', () => {
    // intentionally empty — handled by httpServer.once('error', …) below
  });

  function broadcast(msg: string): void {
    for (const client of wss.clients) {
      if (client.readyState === 1 /* OPEN */) client.send(msg);
    }
  }

  // Auto-shutdown: when the last browser tab closes (WS disconnect) start a
  // 30-second grace timer. Cancel it if a new connection arrives (e.g. page
  // refresh or picker → fill navigation). This lets the server die cleanly
  // when the user is done without requiring a manual Ctrl-C.
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleIdleShutdown(): void {
    if (!options.autoShutdown) return;
    // Defer one tick — ws removes the client from wss.clients asynchronously
    // so checking immediately on 'close' can still show size > 0.
    setImmediate(() => {
      if (wss.clients.size > 0) return; // other tabs still open
      if (idleTimer !== null) return; // already scheduled
      idleTimer = setTimeout(() => {
        logger.info('No active connections — shutting down.');
        void close().finally(() => {
          process.exit(0);
        });
      }, 1_000);
    });
  }

  wss.on('connection', (ws: WebSocket) => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    logger.debug('WebSocket client connected');

    ws.on('message', (raw) => {
      const handleMessage = async (): Promise<void> => {
        const text = Array.isArray(raw)
          ? Buffer.concat(raw).toString('utf-8')
          : Buffer.isBuffer(raw)
            ? raw.toString('utf-8')
            : Buffer.from(new Uint8Array(raw)).toString('utf-8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
          return;
        }

        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          (parsed as Record<string, unknown>).type !== 'save'
        ) {
          return;
        }

        const activeJsonPath = currentJsonPath;
        if (liveDoc === null || activeJsonPath === null) {
          ws.send(JSON.stringify({ type: 'error', message: 'No PDF loaded yet' }));
          return;
        }

        const msg = parsed as Record<string, unknown>;
        if (typeof msg.doc !== 'object' || msg.doc === null) {
          ws.send(JSON.stringify({ type: 'error', message: 'Missing doc payload' }));
          return;
        }

        liveDoc = msg.doc as FpdfDocument;
        lastServerWriteContent = JSON.stringify(liveDoc, null, 2);
        await writeJsonAtomic(activeJsonPath, lastServerWriteContent);
        ws.send(
          JSON.stringify({
            type: 'saved',
            updatedAt: new Date().toISOString(),
            uploaded: isUploadSession,
          }),
        );
        logger.debug(`Saved ${activeJsonPath}`);
      };

      handleMessage().catch((err: unknown) => {
        logger.error(`WebSocket save error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });

    ws.on('close', () => {
      logger.debug('WebSocket client disconnected');
      scheduleIdleShutdown();
      // Upload session temp dirs are NOT cleaned up on disconnect — session
      // state survives reconnects (page reload, network hiccup). The only
      // cleanup is on server shutdown via close(), which is the sole
      // unambiguous signal that no client will ever return.
    });
  });

  // --- JSON file watcher ---
  // Reloads liveDoc and notifies all clients when the .fpdf.json is edited externally.
  // Restartable via resetJsonWatcher() so it follows the active JSON path after
  // POST /open or POST /regenerate-acroform switches files.

  let jsonWatcher: ReturnType<typeof watch> | null = null;

  function resetJsonWatcher(dir: string): void {
    jsonWatcher?.close();
    jsonWatcher = watch(dir, (_event, filename) => {
      const jsonPath = currentJsonPath;
      if (jsonPath === null) return;
      // filename can be null on some platforms even when watching a directory;
      // treat null as "unknown file changed" and attempt the reload anyway.
      if (filename !== null && filename !== path.basename(jsonPath)) return;
      const reload = async (): Promise<void> => {
        let text: string;
        try {
          text = await readFile(jsonPath, 'utf-8');
        } catch {
          // File transiently absent (atomic rename in progress) — skip; next event will succeed.
          return;
        }
        if (text === lastServerWriteContent) {
          // This event was triggered by the server's own writeFile — skip the echo.
          lastServerWriteContent = null;
          return;
        }
        lastServerWriteContent = null;
        liveDoc = JSON.parse(text) as FpdfDocument;
        broadcast(JSON.stringify({ type: 'docReload', doc: liveDoc }));
        logger.debug(`Reloaded liveDoc from ${jsonPath}`);
      };
      reload().catch((err: unknown) => {
        logger.error(`JSON reload error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
  }

  // Start the watcher immediately if a JSON path was provided (fill mode start).
  if (options.jsonPath !== undefined) {
    resetJsonWatcher(path.dirname(options.jsonPath));
  }

  const bindHost = options.host ?? '127.0.0.1';
  const bindPort = options.port ?? 0;

  // Bind to the requested host/port. If an explicit port was requested and it
  // is already in use, throw a clear error instead of retrying on a random port.
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && options.port !== undefined) {
        reject(
          new Error(
            `Port ${String(options.port)} is already in use. Choose a different port with --port.`,
          ),
        );
      } else {
        reject(err);
      }
    });
    httpServer.listen(bindPort, bindHost, resolve);
  });

  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Unexpected server address format');
  }
  const port = addr.port;
  const url = `http://${bindHost}:${String(port)}`;

  // When listening on all interfaces, collect the real LAN/loopback addresses.
  let networkUrls: string[];
  if (bindHost === '0.0.0.0') {
    const ifaces = networkInterfaces();
    const ips: string[] = ['127.0.0.1'];
    for (const iface of Object.values(ifaces)) {
      if (!iface) continue;
      for (const info of iface) {
        if (info.family === 'IPv4' && !info.internal) {
          ips.push(info.address);
        }
      }
    }
    networkUrls = ips.map((ip) => `http://${ip}:${String(port)}`);
  } else {
    networkUrls = [url];
  }

  const close = (): Promise<void> =>
    new Promise((resolve, reject) => {
      // Wait for the FSWatcher to finish closing before tearing down the HTTP
      // server.  On macOS, kqueue FD cleanup can lag behind the synchronous
      // close() call; waiting for the 'close' event eliminates EMFILE errors
      // when tests open many servers in quick succession.
      const doClose = (): void => {
        for (const client of wss.clients) {
          client.terminate();
        }
        httpServer.closeAllConnections();
        wss.close(() => {
          httpServer.close((httpErr) => {
            cleanupTempDir()
              .catch((e: unknown) => {
                logger.error(
                  `Temp dir cleanup failed: ${e instanceof Error ? e.message : String(e)}`,
                );
              })
              .finally(() => {
                if (httpErr) reject(httpErr);
                else resolve();
              });
          });
        });
      };

      if (jsonWatcher === null) {
        doClose();
      } else {
        jsonWatcher.once('close', doClose);
        jsonWatcher.close();
        jsonWatcher = null;
      }
    });

  // Use a getter so callers always read the current ownerToken value even after
  // POST /open, POST /upload, or POST /reset mutate it.
  return {
    url,
    networkUrls,
    get ownerToken() {
      return ownerToken;
    },
    close,
  };
}
