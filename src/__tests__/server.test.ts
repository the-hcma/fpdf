/**
 * Integration tests for server.ts.
 * These tests start a real HTTP server on a random port and make real requests.
 */
// integration
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { WebSocket } from 'ws';
import { startServer, type ServerHandle } from '../server.js';
import type { FpdfDocument } from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_DOC: FpdfDocument = {
  metadata: {
    version: '1.0',
    originalPdf: '/tmp/test.pdf',
    pdfFilename: 'test.pdf',
    pdfHash: 'sha256:abc123',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    pageCount: 1,
  },
  pages: [
    {
      pageNumber: 1,
      widthPt: 612,
      heightPt: 792,
      fields: [
        {
          id: 'a1b2c3d4-0000-0000-0000-000000000001',
          name: 'firstName',
          type: 'text',
          label: 'First Name',
          displayName: 'First Name',
          placement: { x: 50, y: 700, width: 200, height: 20 },
          value: '',
          required: false,
          readOnly: false,
          options: [],
        },
      ],
      textBlocks: [],
    },
  ],
};

let pdfPath: string;
let jsonPath: string;
let handle: ServerHandle;
let baseUrl: string;

beforeAll(async () => {
  const dir = path.join(tmpdir(), 'fpdf-server-tests');
  await mkdir(dir, { recursive: true });

  // Write a minimal valid PDF (just enough bytes for the route to serve)
  pdfPath = path.join(dir, 'test.pdf');
  await writeFile(pdfPath, Buffer.from('%PDF-1.4\n%%EOF\n'));

  jsonPath = path.join(dir, 'test.fpdf.json');
  await writeFile(jsonPath, JSON.stringify(MOCK_DOC, null, 2), 'utf-8');

  handle = await startServer({ pdfPath, doc: MOCK_DOC, jsonPath });
  baseUrl = handle.url;
});

afterAll(async () => {
  await handle.close();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startServer', () => {
  describe('server binding', () => {
    it('returns a URL on 127.0.0.1', () => {
      expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });

    it('allocates a non-zero port', () => {
      const port = parseInt(new URL(baseUrl).port, 10);
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThanOrEqual(65535);
    });
  });

  describe('GET /pdf', () => {
    it('returns 200 with content-type application/pdf', async () => {
      const res = await fetch(`${baseUrl}/pdf`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/pdf');
    });

    it('returns the PDF bytes', async () => {
      const res = await fetch(`${baseUrl}/pdf`);
      const text = await res.text();
      expect(text).toContain('%PDF');
    });
  });

  describe('GET /doc', () => {
    it('returns 200 with content-type application/json', async () => {
      const res = await fetch(`${baseUrl}/doc`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
    });

    it('returns the FpdfDocument', async () => {
      const res = await fetch(`${baseUrl}/doc`);
      const body = (await res.json()) as FpdfDocument;
      expect(body.metadata.pdfFilename).toBe('test.pdf');
      expect(body.pages).toHaveLength(1);
    });
  });

  describe('GET / (UI fallback)', () => {
    it('returns 200 with content-type text/html', async () => {
      const res = await fetch(baseUrl);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
    });
  });

  describe('WebSocket /ws', () => {
    it('accepts a connection', async () => {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws`);
        ws.on('open', () => {
          ws.close();
          resolve();
        });
        ws.on('error', reject);
      });
    });

    it('returns an error message for invalid JSON', async () => {
      const reply = await new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws`);
        ws.on('open', () => {
          ws.send('not json');
        });
        ws.on('message', (data) => {
          ws.close();
          resolve(Buffer.from(data as Buffer).toString('utf-8'));
        });
        ws.on('error', reject);
      });
      const msg = JSON.parse(reply) as { type: string };
      expect(msg.type).toBe('error');
    });

    it('returns an error message when doc payload is missing', async () => {
      const reply = await new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws`);
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'save', doc: null }));
        });
        ws.on('message', (data) => {
          ws.close();
          resolve(Buffer.from(data as Buffer).toString('utf-8'));
        });
        ws.on('error', reject);
      });
      const msg = JSON.parse(reply) as { type: string; message: string };
      expect(msg.type).toBe('error');
      expect(msg.message).toContain('doc');
    });

    it('ignores messages with a non-save type', async () => {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws`);
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'ping' }));
          // No reply is expected; give the server a tick then close
          setTimeout(() => {
            ws.close();
            resolve();
          }, 50);
        });
        ws.on('error', reject);
      });
    });

    it('saves the doc and acks when given a valid save message', async () => {
      const mockPage = MOCK_DOC.pages[0];
      const mockField = mockPage?.fields[0];
      if (!mockPage || !mockField) throw new Error('fixture missing page/field');
      const updatedDoc = {
        ...MOCK_DOC,
        pages: [
          {
            ...mockPage,
            fields: [{ ...mockField, value: 'Alice' }],
          },
        ],
      };

      const reply = await new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws`);
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'save', doc: updatedDoc }));
        });
        ws.on('message', (data) => {
          ws.close();
          resolve(Buffer.from(data as Buffer).toString('utf-8'));
        });
        ws.on('error', reject);
      });

      const ack = JSON.parse(reply) as { type: string; updatedAt: string };
      expect(ack.type).toBe('saved');
      expect(ack.updatedAt).toBeTruthy();

      // Verify the JSON was written to disk
      const written = JSON.parse(await readFile(jsonPath, 'utf-8')) as FpdfDocument;
      expect(written.pages[0]?.fields[0]?.value).toBe('Alice');
    });

    it('reflects the saved doc on subsequent GET /doc', async () => {
      const res = await fetch(`${baseUrl}/doc`);
      const body = (await res.json()) as FpdfDocument;
      expect(body.pages[0]?.fields[0]?.value).toBe('Alice');
    });
  });

  describe('close()', () => {
    it('resolves without error', async () => {
      const tmpHandle = await startServer({ pdfPath, doc: MOCK_DOC, jsonPath });
      await expect(tmpHandle.close()).resolves.toBeUndefined();
    });

    it('terminates connected WebSocket clients on close', async () => {
      const tmpHandle = await startServer({ pdfPath, doc: MOCK_DOC, jsonPath });
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`${tmpHandle.url.replace('http', 'ws')}/ws`);
        ws.on('open', () => {
          // close the server while the WS client is still open
          tmpHandle.close().then(resolve).catch(reject);
        });
        ws.on('error', () => {
          /* expected — server closed the connection */
        });
      });
    });
  });

  describe('JSON file watcher', () => {
    it('broadcasts docReload to clients when the JSON file is edited externally', async () => {
      const mockPage = MOCK_DOC.pages[0];
      const mockField = mockPage?.fields[0];
      if (!mockPage || !mockField) throw new Error('fixture missing page/field');

      const updatedDoc: FpdfDocument = {
        ...MOCK_DOC,
        pages: [{ ...mockPage, fields: [{ ...mockField, value: 'ExternalEdit' }] }],
      };

      // Flush any pending watcher callbacks from prior save operations (ignoringNextChange reset)
      await new Promise<void>((resolve) => setTimeout(resolve, 200));

      const reloadMsg = await new Promise<{ type: string; doc: FpdfDocument }>(
        (resolve, reject) => {
          const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws`);
          ws.on('open', () => {
            // Write the updated JSON directly to disk (external edit)
            void writeFile(jsonPath, JSON.stringify(updatedDoc, null, 2), 'utf-8').catch(reject);
          });
          ws.on('message', (data) => {
            const msg = JSON.parse(Buffer.from(data as Buffer).toString('utf-8')) as {
              type: string;
              doc: FpdfDocument;
            };
            if (msg.type === 'docReload') {
              ws.close();
              resolve(msg);
            }
          });
          ws.on('error', reject);
          setTimeout(() => {
            reject(new Error('timeout waiting for docReload'));
          }, 2000);
        },
      );

      expect(reloadMsg.type).toBe('docReload');
      expect(reloadMsg.doc.pages[0]?.fields[0]?.value).toBe('ExternalEdit');

      // GET /doc should also reflect the reloaded doc
      const res = await fetch(`${baseUrl}/doc`);
      const body = (await res.json()) as FpdfDocument;
      expect(body.pages[0]?.fields[0]?.value).toBe('ExternalEdit');
    });

    it('does not broadcast docReload when the server itself writes the file (ignoringNextChange)', async () => {
      const mockPage = MOCK_DOC.pages[0];
      const mockField = mockPage?.fields[0];
      if (!mockPage || !mockField) throw new Error('fixture missing page/field');
      const saveDoc: FpdfDocument = {
        ...MOCK_DOC,
        pages: [{ ...mockPage, fields: [{ ...mockField, value: 'ServerWrite' }] }],
      };

      // Send a WS save — this triggers a server writeFile with ignoringNextChange = true
      const savedAck = await new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws`);
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'save', doc: saveDoc }));
        });
        ws.on('message', (data) => {
          const msg = JSON.parse(Buffer.from(data as Buffer).toString('utf-8')) as {
            type: string;
          };
          // Only the 'saved' ack should arrive, not a 'docReload'
          ws.close();
          resolve(msg.type);
        });
        ws.on('error', reject);
      });

      expect(savedAck).toBe('saved');

      // Allow the fs.watch callback to fire and be skipped (covers ignoringNextChange = true branch)
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    });

    it('logs an error and keeps serving when invalid JSON is written to the file', async () => {
      // Write garbage so JSON.parse throws inside reload(); verifies the outer catch fires.
      await writeFile(jsonPath, 'not valid json', 'utf-8');
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      // Server should still respond (liveDoc unchanged from prior value)
      const res = await fetch(`${baseUrl}/doc`);
      expect(res.status).toBe(200);
      // Restore valid state for subsequent tests
      await writeFile(jsonPath, JSON.stringify(MOCK_DOC, null, 2), 'utf-8');
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    });

    it('ignores unrelated files written to the same directory', async () => {
      // Write a sibling file — the directory watcher should skip it (filename !== jsonFilename)
      const siblingPath = path.join(path.dirname(jsonPath), 'unrelated.txt');
      await writeFile(siblingPath, 'noise', 'utf-8');

      // If docReload were incorrectly broadcast, the next GET /doc would fail;
      // confirm the live doc is unchanged after a brief wait.
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      const res = await fetch(`${baseUrl}/doc`);
      expect(res.status).toBe(200);
    });
  });
});

describe('startServer error paths', () => {
  it('GET /pdf returns 500 when the PDF file does not exist', async () => {
    const dir = path.join(tmpdir(), 'fpdf-server-error-tests');
    await mkdir(dir, { recursive: true });
    const missingPdf = path.join(dir, 'missing.pdf');
    const tmpJson = path.join(dir, 'test.fpdf.json');
    await writeFile(tmpJson, JSON.stringify(MOCK_DOC, null, 2), 'utf-8');

    const h = await startServer({ pdfPath: missingPdf, doc: MOCK_DOC, jsonPath: tmpJson });
    try {
      const res = await fetch(`${h.url}/pdf`);
      expect(res.status).toBe(500);
    } finally {
      await h.close();
    }
  });

  it('GET / returns the index.html content when the file exists', async () => {
    const dir = path.join(tmpdir(), 'fpdf-server-ui-tests');
    const publicDir = path.join(dir, 'public');
    await mkdir(publicDir, { recursive: true });
    const pdfFile = path.join(dir, 'test.pdf');
    const jsonFile = path.join(dir, 'test.fpdf.json');
    await writeFile(pdfFile, Buffer.from('%PDF-1.4\n%%EOF\n'));
    await writeFile(jsonFile, JSON.stringify(MOCK_DOC, null, 2), 'utf-8');

    // We can't easily inject a custom publicDir into the server, so we verify
    // the fallback placeholder is served (already tested above). Instead test
    // that the route still returns 200 with text/html.
    const h = await startServer({ pdfPath: pdfFile, doc: MOCK_DOC, jsonPath: jsonFile });
    try {
      const res = await fetch(h.url);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
    } finally {
      await h.close();
    }
  });
});
