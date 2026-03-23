import { createServer } from 'node:http';
import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { logger } from './logger.js';
import { exportPdf } from './exporter.js';
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
  const { pdfPath, doc, jsonPath } = options;

  const app = express();
  app.use(express.json());

  // --- PDF bytes ---
  app.get('/pdf', (_req, res) => {
    const run = async (): Promise<void> => {
      const bytes = await readFile(pdfPath);
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
      const filled = await exportPdf(pdfPath, liveDoc);
      const filename = `${path.basename(pdfPath, path.extname(pdfPath))}-filled.pdf`;
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
  // Suppresses the fs.watch echo triggered by the server's own writeFile.
  let ignoringNextChange = false;

  // --- FpdfDocument JSON ---
  app.get('/doc', (_req, res) => {
    res.json(liveDoc);
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
        const { writeFile } = await import('node:fs/promises');
        ignoringNextChange = true;
        await writeFile(jsonPath, JSON.stringify(liveDoc, null, 2), 'utf-8');
        ws.send(JSON.stringify({ type: 'saved', updatedAt: new Date().toISOString() }));
        logger.debug(`Saved ${jsonPath}`);
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
  const jsonDir = path.dirname(jsonPath);
  const jsonFilename = path.basename(jsonPath);

  const jsonWatcher = watch(jsonDir, (_event, filename) => {
    // filename can be null on some platforms even when watching a directory;
    // treat null as "unknown file changed" and attempt the reload anyway.
    if (filename !== null && filename !== jsonFilename) return;
    if (ignoringNextChange) {
      ignoringNextChange = false;
      return;
    }
    const reload = async (): Promise<void> => {
      let text: string;
      try {
        text = await readFile(jsonPath, 'utf-8');
      } catch {
        // File transiently absent (atomic rename in progress) — skip; next event will succeed.
        return;
      }
      liveDoc = JSON.parse(text) as FpdfDocument;
      broadcast(JSON.stringify({ type: 'docReload', doc: liveDoc }));
      logger.debug(`Reloaded liveDoc from ${jsonPath}`);
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
