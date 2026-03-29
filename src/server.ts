import { createServer } from 'node:http';
import { watch } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { logger } from './logger.js';
import { exportPdf } from './exporter.js';
import { regenerateAsAcroForm } from './regenerator.js';
import type { FpdfDocument } from './types.js';

export interface ServerOptions {
  /** Absolute path to the PDF file being served. */
  pdfPath: string;
  /** The parsed FpdfDocument for this session. */
  doc: FpdfDocument;
  /** Absolute path to the .fpdf.json file (used for WebSocket save writes). */
  jsonPath: string;
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
 *   GET /           — the web UI shell (served from src/public/)
 *   WS  /ws         — WebSocket channel for live save (field edits → JSON write)
 *
 * @returns A ServerHandle with the allocated URL and a close() function.
 */
export async function startServer(options: ServerOptions): Promise<ServerHandle> {
  const { doc } = options;
  let currentPdfPath = options.pdfPath;
  let currentJsonPath = options.jsonPath;

  const app = express();
  app.use(express.json());

  // --- PDF bytes ---
  app.get('/pdf', (_req, res) => {
    const run = async (): Promise<void> => {
      const bytes = await readFile(currentPdfPath);
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
      const filled = await exportPdf(currentPdfPath, liveDoc, { readOnly: true });
      const filename = `${path.basename(currentPdfPath, path.extname(currentPdfPath))}-filled.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.setHeader('Content-Length', String(filled.length));
      res.end(Buffer.from(filled));
    };
    run().catch((err: unknown) => {
      logger.error(`Failed to export PDF: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: 'Failed to export PDF' });
    });
  });

  // Live in-memory doc that WebSocket clients can update
  let liveDoc = doc;
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

  // --- FpdfDocument JSON ---
  app.get('/doc', (_req, res) => {
    res.json(liveDoc);
  });

  // --- Save candidate fields as an editable AcroForm PDF to disk ---
  // Produces <name>.fpdf.acroform.pdf alongside the source PDF.  Fields are
  // left editable so the recipient can fill them in any standard PDF viewer.
  app.post('/save-acroform', (_req, res) => {
    const run = async (): Promise<void> => {
      const filled = await exportPdf(currentPdfPath, liveDoc);
      const base = currentPdfPath.replace(/\.[^.]+$/, '');
      const outPath = `${base}.fpdf.acroform.pdf`;
      await writeFile(outPath, filled);
      logger.info(`Saved AcroForm PDF → ${outPath}`);
      res.json({ ok: true, path: outPath });
    };
    run().catch((err: unknown) => {
      logger.error(`save-acroform failed: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: String(err) });
    });
  });

  // --- XFA → AcroForm regeneration ---
  app.post('/regenerate-acroform', (_req, res) => {
    const run = async (): Promise<void> => {
      const result = await regenerateAsAcroForm(currentPdfPath, liveDoc);
      currentPdfPath = result.newPdfPath;
      currentJsonPath = result.newJsonPath;
      liveDoc = result.newDoc;
      const content = JSON.stringify(liveDoc, null, 2);
      lastServerWriteContent = content;
      await writeFile(currentJsonPath, content, 'utf-8');
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

  // --- Static UI assets (src/public/) ---
  const publicDir = path.join(path.dirname(new URL(import.meta.url).pathname), 'public');
  app.use(express.static(publicDir));

  // --- Catch-all: serve index.html for SPA routing ---
  app.get(/.*/, (_req, res) => {
    const run = async (): Promise<void> => {
      const indexPath = path.join(publicDir, 'index.html');
      const html = await readFile(indexPath, 'utf-8');
      res.setHeader('Content-Type', 'text/html');
      res.end(html);
    };
    run().catch((_err: unknown) => {
      // Public dir not built yet — return a placeholder during development
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<!DOCTYPE html><html><body><p>UI not yet built. Run <code>npm run build:ui</code>.</p></body></html>',
      );
    });
  });

  const httpServer = createServer(app);

  // --- WebSocket server ---
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

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

        const msg = parsed as Record<string, unknown>;
        if (typeof msg.doc !== 'object' || msg.doc === null) {
          ws.send(JSON.stringify({ type: 'error', message: 'Missing doc payload' }));
          return;
        }

        liveDoc = msg.doc as FpdfDocument;
        lastServerWriteContent = JSON.stringify(liveDoc, null, 2);
        await writeFile(currentJsonPath, lastServerWriteContent, 'utf-8');
        ws.send(JSON.stringify({ type: 'saved', updatedAt: new Date().toISOString() }));
        logger.debug(`Saved ${currentJsonPath}`);
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

  function broadcast(msg: string): void {
    for (const client of wss.clients) {
      if (client.readyState === 1 /* OPEN */) client.send(msg);
    }
  }

  // Watch the parent directory so atomic renames (write-to-temp + rename) are detected.
  // Watching the file inode directly breaks when the file is replaced atomically.
  // Use currentJsonPath (not a fixed copy) so the watcher picks up the file even after
  // session switches to a regenerated PDF in the same directory.
  const jsonDir = path.dirname(options.jsonPath);

  const jsonWatcher = watch(jsonDir, (_event, filename) => {
    // filename can be null on some platforms even when watching a directory;
    // treat null as "unknown file changed" and attempt the reload anyway.
    if (filename !== null && filename !== path.basename(currentJsonPath)) return;
    const reload = async (): Promise<void> => {
      let text: string;
      try {
        text = await readFile(currentJsonPath, 'utf-8');
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
      logger.debug(`Reloaded liveDoc from ${currentJsonPath}`);
    };
    reload().catch((err: unknown) => {
      logger.error(`JSON reload error: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

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
      jsonWatcher.close();
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
