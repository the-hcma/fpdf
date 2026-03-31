import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { watch } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { logger } from './logger.js';
import { exportPdf, exportFromImages, ExportError, type RenderedPage } from './exporter.js';
import { regenerateAsAcroForm } from './regenerator.js';
import { analyzePdf } from './analyzer.js';
import type { BrowseResponse, DirectoryEntry, FpdfDocument } from './types.js';

export interface ServerOptions {
  /** Absolute path to the PDF file being served. Omit to start in picker mode. */
  pdfPath?: string;
  /** The parsed FpdfDocument for this session. Omit to start in picker mode. */
  doc?: FpdfDocument;
  /** Absolute path to the .fpdf.json file (used for WebSocket save writes). Omit to start in picker mode. */
  jsonPath?: string;
}

export interface ServerHandle {
  /** The base URL the server is listening on, e.g. "http://127.0.0.1:51234". */
  url: string;
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
export async function startServer(options: ServerOptions): Promise<ServerHandle> {
  let liveDoc: FpdfDocument | null = options.doc ?? null;
  let currentPdfPath: string | null = options.pdfPath ?? null;
  let currentJsonPath: string | null = options.jsonPath ?? null;
  let analyzeInProgress = false;

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

  // --- Helpers ---

  // Resolves a user-supplied path to an absolute, normalised path.
  // path.resolve handles . and .. so no additional root restriction is needed.
  function resolveSafePath(requested: string): string {
    return path.resolve(requested);
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
  app.get('/filled-pdf', (_req, res) => {
    const run = async (): Promise<void> => {
      const ctx = requireDoc(res);
      if (ctx === null) return;
      const filled = await exportPdf(ctx.pdfPath, ctx.doc, { readOnly: true });
      const filename = `${path.basename(ctx.pdfPath, path.extname(ctx.pdfPath))}-filled.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
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
  app.post('/save-acroform', (_req, res) => {
    const run = async (): Promise<void> => {
      const ctx = requireDoc(res);
      if (ctx === null) return;
      const filled = await exportPdf(ctx.pdfPath, ctx.doc);
      const base = ctx.pdfPath.replace(/\.[^.]+$/, '');
      const outPath = `${base}.fpdf.acroform.pdf`;
      await writeFile(outPath, filled);
      logger.info(`Saved AcroForm PDF → ${outPath}`);
      res.json({ ok: true, path: outPath });
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
      const body = _req.body as { pages?: { jpeg: string; widthPt: number; heightPt: number }[] };
      if (!Array.isArray(body.pages) || body.pages.length === 0) {
        res.status(400).json({ error: 'Missing pages array' });
        return;
      }
      const pages: RenderedPage[] = body.pages.map((p) => ({
        jpeg: new Uint8Array(Buffer.from(p.jpeg, 'base64')),
        widthPt: p.widthPt,
        heightPt: p.heightPt,
      }));
      const filled = await exportFromImages(pages, ctx.doc);
      const filename = `${path.basename(ctx.pdfPath, path.extname(ctx.pdfPath))}-filled.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
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
      await writeFile(currentJsonPath, content, 'utf-8');
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

  // --- File picker: open a PDF and transition to fill mode ---
  app.post('/open', (_req, res) => {
    const run = async (): Promise<void> => {
      const body = _req.body as { filePath?: unknown };
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
      const safePath = resolveSafePath(body.filePath);
      analyzeInProgress = true;
      let doc: FpdfDocument;
      try {
        doc = await analyzePdf(safePath);
      } finally {
        analyzeInProgress = false;
      }
      const stem = path.basename(safePath, path.extname(safePath));
      const newJsonPath = path.join(path.dirname(safePath), `${stem}.fpdf.json`);
      const content = JSON.stringify(doc, null, 2);
      lastServerWriteContent = content;
      await writeFile(newJsonPath, content, 'utf-8');
      currentPdfPath = safePath;
      currentJsonPath = newJsonPath;
      liveDoc = doc;
      resetJsonWatcher(path.dirname(newJsonPath));
      broadcast(JSON.stringify({ type: 'pdfOpened', doc }));
      res.json({ ok: true });
    };
    run().catch((err: unknown) => {
      analyzeInProgress = false;
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`/open failed: ${msg}`);
      res.status(500).json({ error: msg });
    });
  });

  // --- Static UI assets ---
  const publicDir = path.join(path.dirname(new URL(import.meta.url).pathname), 'public');
  app.use(express.static(publicDir));

  // --- Catch-all: serve pick.html in picker mode, index.html in fill mode ---
  app.get(/.*/, (_req, res) => {
    const run = async (): Promise<void> => {
      const filename = liveDoc === null ? 'pick.html' : 'index.html';
      const html = await readFile(path.join(publicDir, filename), 'utf-8');
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

  function broadcast(msg: string): void {
    for (const client of wss.clients) {
      if (client.readyState === 1 /* OPEN */) client.send(msg);
    }
  }

  wss.on('connection', (ws: WebSocket) => {
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
        await writeFile(activeJsonPath, lastServerWriteContent, 'utf-8');
        ws.send(JSON.stringify({ type: 'saved', updatedAt: new Date().toISOString() }));
        logger.debug(`Saved ${activeJsonPath}`);
      };

      handleMessage().catch((err: unknown) => {
        logger.error(`WebSocket save error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });

    ws.on('close', () => {
      logger.debug('WebSocket client disconnected');
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

  // Bind to 127.0.0.1, port 0 (OS-allocated)
  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', resolve);
  });

  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Unexpected server address format');
  }
  const url = `http://127.0.0.1:${String(addr.port)}`;

  const close = (): Promise<void> =>
    new Promise((resolve, reject) => {
      jsonWatcher?.close();
      for (const client of wss.clients) {
        client.terminate();
      }
      httpServer.closeAllConnections();
      wss.close(() => {
        httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });

  return { url, close };
}
