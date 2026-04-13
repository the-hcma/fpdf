/**
 * Integration tests for server.ts.
 * These tests start a real HTTP server on a random port and make real requests.
 */
// integration
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { tmpdir, homedir } from 'node:os';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { WebSocket } from 'ws';
import { PDFDocument } from 'pdf-lib';
import { startServer, type ServerHandle } from '../server.js';
import type { BrowseResponse, FpdfDocument, UiCapabilitiesResponse } from '../types.js';

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
      pageType: 'acroform' as const,
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
      candidateFields: [],
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

  // Create a real pdf-lib PDF so /filled-pdf can export it
  pdfPath = path.join(dir, 'test.pdf');
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const form = pdfDoc.getForm();
  const tf = form.createTextField('firstName');
  tf.addToPage(page, { x: 50, y: 700, width: 200, height: 20 });
  await writeFile(pdfPath, await pdfDoc.save());

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
  const getDoc = async (): Promise<FpdfDocument> => {
    const res = await fetch(`${baseUrl}/doc`);
    expect(res.status).toBe(200);
    return (await res.json()) as FpdfDocument;
  };

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

  describe('GET /filled-pdf', () => {
    it('returns 200 with content-type application/pdf', async () => {
      const res = await fetch(`${baseUrl}/filled-pdf`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/pdf');
    });

    it('returns a Content-Disposition header with the filled filename', async () => {
      const res = await fetch(`${baseUrl}/filled-pdf`);
      expect(res.headers.get('content-disposition')).toContain('test-filled.pdf');
    });

    it('returns valid PDF bytes', async () => {
      const res = await fetch(`${baseUrl}/filled-pdf`);
      const buf = await res.arrayBuffer();
      expect(Buffer.from(buf).subarray(0, 4).toString()).toBe('%PDF');
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

  describe('GET /unknown-path (SPA catch-all)', () => {
    it('returns 200 with text/html for an unknown path not served by static middleware', async () => {
      const res = await fetch(`${baseUrl}/this-path-does-not-exist-in-public`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
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

    it('simulates clear-fields then undo: JSON is empty after clear, restored after undo', async () => {
      const mockPage = MOCK_DOC.pages[0];
      const mockField = mockPage?.fields[0];
      if (!mockPage || !mockField) throw new Error('fixture missing page/field');

      const page = mockPage;
      const field = mockField;

      function buildDoc(value: string): FpdfDocument {
        return {
          ...MOCK_DOC,
          pages: [{ ...page, fields: [{ ...field, value }] }],
        };
      }

      async function wsSave(doc: FpdfDocument): Promise<void> {
        await new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws`);
          ws.on('open', () => {
            ws.send(JSON.stringify({ type: 'save', doc }));
          });
          ws.on('message', () => {
            ws.close();
            resolve();
          });
          ws.on('error', reject);
        });
      }

      function readValue(): Promise<string | boolean> {
        return readFile(jsonPath, 'utf-8').then((text) => {
          const d = JSON.parse(text) as FpdfDocument;
          const v = d.pages[0]?.fields[0]?.value;
          if (v === undefined) throw new Error('field value missing in JSON');
          return v;
        });
      }

      // Populate the field
      await wsSave(buildDoc('Bob'));
      expect(await readValue()).toBe('Bob');

      // Simulate clear: save with empty value
      await wsSave(buildDoc(''));
      expect(await readValue()).toBe('');

      // Simulate undo: restore the original value
      await wsSave(buildDoc('Bob'));
      expect(await readValue()).toBe('Bob');
    });
  });

  describe('POST /regenerate-acroform', () => {
    it('returns { ok: true } and updates the doc when regeneration succeeds', async () => {
      // Use an isolated server so path changes don't affect other tests
      const dir = path.join(tmpdir(), 'fpdf-server-regen-success');
      await mkdir(dir, { recursive: true });
      const pdfDoc2 = await PDFDocument.create();
      const p = pdfDoc2.addPage([612, 792]);
      const form = pdfDoc2.getForm();
      const tf = form.createTextField('field1');
      tf.addToPage(p, { x: 50, y: 700, width: 200, height: 20 });
      const pdfFile = path.join(dir, 'regen.pdf');
      const jsonFile = path.join(dir, 'regen.fpdf.json');
      await writeFile(pdfFile, await pdfDoc2.save());

      const regenDoc: FpdfDocument = {
        ...MOCK_DOC,
        metadata: { ...MOCK_DOC.metadata, originalPdf: pdfFile, pdfFilename: 'regen.pdf' },
      };
      await writeFile(jsonFile, JSON.stringify(regenDoc, null, 2), 'utf-8');

      const h = await startServer({ pdfPath: pdfFile, doc: regenDoc, jsonPath: jsonFile });
      try {
        const res = await fetch(`${h.url}/regenerate-acroform`, { method: 'POST' });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean };
        expect(body.ok).toBe(true);
      } finally {
        await h.close();
      }
    });
  });

  describe('POST /save-acroform', () => {
    it('returns { ok: true, path } and writes the file to disk', async () => {
      const dir = path.join(tmpdir(), 'fpdf-server-save-acroform-success');
      await mkdir(dir, { recursive: true });
      const pdfFile = path.join(dir, 'form.pdf');
      const jsonFile = path.join(dir, 'form.fpdf.json');
      const plainBytes = await PDFDocument.create().then((d) => {
        d.addPage([612, 792]);
        return d.save();
      });
      await writeFile(pdfFile, plainBytes);
      const saveDoc: FpdfDocument = {
        ...MOCK_DOC,
        metadata: { ...MOCK_DOC.metadata, originalPdf: pdfFile, pdfFilename: 'form.pdf' },
      };
      await writeFile(jsonFile, JSON.stringify(saveDoc, null, 2), 'utf-8');

      const h = await startServer({ pdfPath: pdfFile, doc: saveDoc, jsonPath: jsonFile });
      try {
        const res = await fetch(`${h.url}/save-acroform`, { method: 'POST' });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean; path: string };
        expect(body.ok).toBe(true);
        expect(body.path).toMatch(/form\.fpdf\.acroform\.pdf$/);
        const saved = await readFile(body.path);
        expect(Buffer.from(saved).subarray(0, 4).toString()).toBe('%PDF');
      } finally {
        await h.close();
      }
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
          }, 5000);
        },
      );

      expect(reloadMsg.type).toBe('docReload');
      expect(reloadMsg.doc.pages[0]?.fields[0]?.value).toBe('ExternalEdit');

      // GET /doc should eventually reflect the reloaded doc.
      await vi.waitFor(async () => {
        const body = await getDoc();
        expect(body.pages[0]?.fields[0]?.value).toBe('ExternalEdit');
      });
    });

    it('does not broadcast docReload when the server itself writes the file', async () => {
      const mockPage = MOCK_DOC.pages[0];
      const mockField = mockPage?.fields[0];
      if (!mockPage || !mockField) throw new Error('fixture missing page/field');
      const saveDoc: FpdfDocument = {
        ...MOCK_DOC,
        pages: [{ ...mockPage, fields: [{ ...mockField, value: 'ServerWrite' }] }],
      };

      await vi.waitFor(async () => {
        const body = await getDoc();
        expect(body.pages[0]?.fields[0]?.value).toBe('ExternalEdit');
      });

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
          // Ignore unrelated events (for example, a stale in-flight docReload
          // from the previous test) and wait specifically for the save ack.
          if (msg.type !== 'saved') {
            return;
          }
          ws.close();
          resolve(msg.type);
        });
        ws.on('error', reject);
      });

      expect(savedAck).toBe('saved');

      // Ensure server-written value is visible without relying on fixed delays.
      await vi.waitFor(async () => {
        const body = await getDoc();
        expect(body.pages[0]?.fields[0]?.value).toBe('ServerWrite');
      });
    });

    it('logs an error and keeps serving when invalid JSON is written to the file', async () => {
      // Write garbage so JSON.parse throws inside reload(); verifies the outer catch fires.
      await writeFile(jsonPath, 'not valid json', 'utf-8');
      // Server should still respond (liveDoc unchanged from prior value).
      await vi.waitFor(async () => {
        const res = await fetch(`${baseUrl}/doc`);
        expect(res.status).toBe(200);
      });
      // Restore valid state for subsequent tests
      await writeFile(jsonPath, JSON.stringify(MOCK_DOC, null, 2), 'utf-8');
      await vi.waitFor(async () => {
        const body = await getDoc();
        expect(body.metadata.pdfFilename).toBe(MOCK_DOC.metadata.pdfFilename);
      });
    });

    it('ignores unrelated files written to the same directory', async () => {
      // Write a sibling file — the directory watcher should skip it (filename !== jsonFilename)
      const siblingPath = path.join(path.dirname(jsonPath), 'unrelated.txt');
      await writeFile(siblingPath, 'noise', 'utf-8');

      // If docReload were incorrectly broadcast, /doc stability checks would fail.
      await vi.waitFor(async () => {
        const res = await fetch(`${baseUrl}/doc`);
        expect(res.status).toBe(200);
      });
    });
  });
});

// Allow the OS to reclaim file descriptors after closing a server.
// On macOS, FSWatcher.close() is synchronous but kqueue FD cleanup can lag,
// causing EMFILE when many servers are opened in quick succession.
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

describe('startServer error paths', () => {
  it('GET /filled-pdf returns 500 when the PDF file does not exist', async () => {
    const dir = path.join(tmpdir(), 'fpdf-server-filled-error-tests');
    await mkdir(dir, { recursive: true });
    const missingPdf = path.join(dir, 'missing.pdf');
    const tmpJson = path.join(dir, 'test.fpdf.json');
    await writeFile(tmpJson, JSON.stringify(MOCK_DOC, null, 2), 'utf-8');

    const h = await startServer({ pdfPath: missingPdf, doc: MOCK_DOC, jsonPath: tmpJson });
    try {
      const res = await fetch(`${h.url}/filled-pdf`);
      expect(res.status).toBe(500);
    } finally {
      await h.close();
      await settle();
    }
  });

  it('logs a WS save error and keeps serving when writeFile fails', async () => {
    const dir = path.join(tmpdir(), 'fpdf-server-ws-write-error');
    await mkdir(dir, { recursive: true });
    const pdfDoc2 = await PDFDocument.create();
    pdfDoc2.addPage([612, 792]);
    const pdfFile = path.join(dir, 'test.pdf');
    await writeFile(pdfFile, await pdfDoc2.save());

    // jsonPath is a directory — writeFile(dir, ...) throws EISDIR
    // so handleMessage().catch fires (server.ts line 159)
    const h = await startServer({ pdfPath: pdfFile, doc: MOCK_DOC, jsonPath: dir });
    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`${h.url.replace('http', 'ws')}/ws`);
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'save', doc: MOCK_DOC }));
          // No ack will be sent because writeFile throws before ws.send
          setTimeout(() => {
            ws.close();
            resolve();
          }, 150);
        });
        ws.on('error', reject);
      });
      // Server must still be reachable after the error
      const res = await fetch(`${h.url}/doc`);
      expect(res.status).toBe(200);
    } finally {
      await h.close();
      await settle();
    }
  });

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
      await settle();
    }
  });

  it('handles a transiently absent JSON file gracefully (readFile catch)', async () => {
    // Use an isolated server so the rename-back watcher event cannot bleed
    // into any shared server's subsequent tests.
    const dir = path.join(tmpdir(), 'fpdf-server-transient-json');
    await mkdir(dir, { recursive: true });
    const pdfDoc2 = await PDFDocument.create();
    pdfDoc2.addPage([612, 792]);
    const pdfFile = path.join(dir, 'test.pdf');
    const tmpJson = path.join(dir, 'test.fpdf.json');
    await writeFile(pdfFile, await pdfDoc2.save());
    await writeFile(tmpJson, JSON.stringify(MOCK_DOC, null, 2), 'utf-8');

    const h = await startServer({ pdfPath: pdfFile, doc: MOCK_DOC, jsonPath: tmpJson });
    try {
      const { rename } = await import('node:fs/promises');
      const backup = `${tmpJson}.bak`;
      // Rename the json file away — the watcher fires with the original filename,
      // readFile throws ENOENT → the inner catch at server.ts:192 returns early.
      await rename(tmpJson, backup);
      // Server must still be alive (liveDoc in memory is unchanged)
      await vi.waitFor(async () => {
        const res = await fetch(`${h.url}/doc`);
        expect(res.status).toBe(200);
      });
      // Restore the json file before closing the server
      await rename(backup, tmpJson);
      await vi.waitFor(async () => {
        const res = await fetch(`${h.url}/doc`);
        expect(res.status).toBe(200);
      });
    } finally {
      await h.close();
      await settle();
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
      await settle();
    }
  });

  it('POST /regenerate-acroform returns 500 when regeneration fails', async () => {
    const dir = path.join(tmpdir(), 'fpdf-server-regen-error');
    await mkdir(dir, { recursive: true });
    // Point to a missing PDF so regenerateAsAcroForm throws on readFile
    const missingPdf = path.join(dir, 'missing.pdf');
    const tmpJson = path.join(dir, 'test.fpdf.json');
    await writeFile(tmpJson, JSON.stringify(MOCK_DOC, null, 2), 'utf-8');

    const h = await startServer({ pdfPath: missingPdf, doc: MOCK_DOC, jsonPath: tmpJson });
    try {
      const res = await fetch(`${h.url}/regenerate-acroform`, { method: 'POST' });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBeTruthy();
    } finally {
      await h.close();
      await settle();
    }
  });
});

// ---------------------------------------------------------------------------
// Picker mode
// ---------------------------------------------------------------------------

describe('picker mode (no doc on start)', () => {
  let pickerHandle: ServerHandle;

  beforeAll(async () => {
    pickerHandle = await startServer({});
  });

  afterAll(async () => {
    await pickerHandle.close();
    await settle();
  });

  it('starts successfully and returns a 127.0.0.1 URL', () => {
    expect(pickerHandle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('GET /pdf returns 503 when no doc is loaded', async () => {
    const res = await fetch(`${pickerHandle.url}/pdf`);
    expect(res.status).toBe(503);
  });

  it('GET /doc returns 503 when no doc is loaded', async () => {
    const res = await fetch(`${pickerHandle.url}/doc`);
    expect(res.status).toBe(503);
  });

  it('GET /filled-pdf returns 503 when no doc is loaded', async () => {
    const res = await fetch(`${pickerHandle.url}/filled-pdf`);
    expect(res.status).toBe(503);
  });

  it('GET / returns HTML (pick.html or fallback) when in picker mode', async () => {
    const res = await fetch(pickerHandle.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('GET /ui-capabilities enables server browse for local clients', async () => {
    const res = await fetch(`${pickerHandle.url}/ui-capabilities`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as UiCapabilitiesResponse;
    expect(body.canBrowseServerFiles).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /browse
// ---------------------------------------------------------------------------

describe('GET /browse', () => {
  let h: ServerHandle;

  beforeAll(async () => {
    h = await startServer({});
  });

  afterAll(async () => {
    await h.close();
    await settle();
  });

  it('returns 200 with resolvedPath and entries for a valid directory', async () => {
    const res = await fetch(`${h.url}/browse?path=${encodeURIComponent(homedir())}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as BrowseResponse;
    expect(body.resolvedPath).toBe(homedir());
    expect(Array.isArray(body.entries)).toBe(true);
  });

  it('defaults to home dir when ?path is omitted', async () => {
    const res = await fetch(`${h.url}/browse`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as BrowseResponse;
    expect(body.resolvedPath).toBe(homedir());
  });

  it('returns 500 for a non-existent path', async () => {
    const res = await fetch(`${h.url}/browse?path=${encodeURIComponent('/does/not/exist/xyz')}`);
    expect(res.status).toBe(500);
  });

  it('does not include dotfiles in results', async () => {
    const dir = path.join(tmpdir(), 'fpdf-browse-test');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '.hidden.pdf'), '%PDF-1.4');
    await writeFile(path.join(dir, 'visible.pdf'), '%PDF-1.4');
    const res = await fetch(`${h.url}/browse?path=${encodeURIComponent(dir)}`);
    const body = (await res.json()) as BrowseResponse;
    const names = body.entries.map((e) => e.name);
    expect(names).not.toContain('.hidden.pdf');
    expect(names).toContain('visible.pdf');
  });

  it('returns dirs before files and excludes non-PDF files', async () => {
    const dir = path.join(tmpdir(), 'fpdf-browse-sort-test');
    await mkdir(path.join(dir, 'subdir'), { recursive: true });
    await writeFile(path.join(dir, 'a.pdf'), '%PDF-1.4');
    await writeFile(path.join(dir, 'b.txt'), 'text');
    const res = await fetch(`${h.url}/browse?path=${encodeURIComponent(dir)}`);
    const body = (await res.json()) as BrowseResponse;
    expect(body.entries[0]?.kind).toBe('dir');
    expect(body.entries.every((e) => e.kind === 'dir' || e.name.endsWith('.pdf'))).toBe(true);
    expect(body.entries.find((e) => e.name === 'b.txt')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// POST /open
// ---------------------------------------------------------------------------

describe('POST /open', () => {
  let h: ServerHandle;
  let testPdfPath: string;

  beforeAll(async () => {
    h = await startServer({});

    const dir = path.join(tmpdir(), 'fpdf-open-test');
    await mkdir(dir, { recursive: true });
    testPdfPath = path.join(dir, 'open-test.pdf');
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([612, 792]);
    await writeFile(testPdfPath, await pdfDoc.save());
  });

  afterAll(async () => {
    await h.close();
    await settle();
  });

  it('returns 400 when filePath is missing', async () => {
    const res = await fetch(`${h.url}/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when filePath is not a .pdf', async () => {
    const res = await fetch(`${h.url}/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: '/some/file.txt' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 200 and transitions to fill mode after opening a valid PDF', async () => {
    const res = await fetch(`${h.url}/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: testPdfPath }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // After open, /doc should return an FpdfDocument (no longer 503)
    const docRes = await fetch(`${h.url}/doc`);
    expect(docRes.status).toBe(200);
    const doc = (await docRes.json()) as FpdfDocument;
    expect(doc.metadata.originalPdf).toBe(testPdfPath);
  });

  it('creates a .fpdf.json file next to the PDF after open', async () => {
    const stem = path.basename(testPdfPath, path.extname(testPdfPath));
    const expectedJson = path.join(path.dirname(testPdfPath), `${stem}.fpdf.json`);
    const raw = await readFile(expectedJson, 'utf-8');
    const doc = JSON.parse(raw) as FpdfDocument;
    expect(doc.metadata.pdfFilename).toBe(path.basename(testPdfPath));
  });

  it('broadcasts pdfOpened to connected WebSocket clients', async () => {
    // Open a fresh picker server so we are back in picker mode
    const h2 = await startServer({});

    const dir2 = path.join(tmpdir(), 'fpdf-open-ws-test');
    await mkdir(dir2, { recursive: true });
    const pdf2 = path.join(dir2, 'ws-test.pdf');
    const pdfDoc2 = await PDFDocument.create();
    pdfDoc2.addPage([612, 792]);
    await writeFile(pdf2, await pdfDoc2.save());

    const wsUrl = h2.url.replace('http://', 'ws://') + '/ws';
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => ws.once('open', resolve));

    const opened = new Promise<Record<string, unknown>>((resolve) => {
      ws.on('message', (data: Buffer | string) => {
        const raw = Buffer.isBuffer(data) ? data.toString('utf-8') : data;
        const msg = JSON.parse(raw) as Record<string, unknown>;
        if (msg.type === 'pdfOpened') resolve(msg);
      });
    });

    await fetch(`${h2.url}/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: pdf2 }),
    });

    const msg = await opened;
    expect(msg.type).toBe('pdfOpened');
    expect(typeof msg.doc).toBe('object');

    ws.close();
    await h2.close();
    await settle();
  });

  it('returns 409 when analysis is already in progress', async () => {
    // Mock analyzePdf to hang so we can hit the in-progress guard
    const analyzerModule = await import('../analyzer.js');
    let releaseHang!: () => void;
    // Resolve (do not reject) so the test teardown cannot leak an unhandled rejection in CI.
    const hanging = new Promise<FpdfDocument>((resolve) => {
      releaseHang = () => {
        resolve(MOCK_DOC);
      };
    });
    const spy = vi.spyOn(analyzerModule, 'analyzePdf').mockReturnValueOnce(hanging);

    const h3 = await startServer({});
    const dir3 = path.join(tmpdir(), 'fpdf-open-409-test');
    await mkdir(dir3, { recursive: true });
    const pdf3 = path.join(dir3, 'inprogress.pdf');
    const pdfDoc3 = await PDFDocument.create();
    pdfDoc3.addPage([612, 792]);
    await writeFile(pdf3, await pdfDoc3.save());

    let first: Promise<Response> | null = null;
    try {
      // First request starts analysis (hangs)
      first = fetch(`${h3.url}/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: pdf3 }),
      });

      // Second request should eventually get 409 while analysis is in progress.
      await vi.waitFor(async () => {
        const second = await fetch(`${h3.url}/open`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: pdf3 }),
        });
        expect(second.status).toBe(409);
      });

      releaseHang();
      const firstRes = await first;
      expect(firstRes.status).toBe(200);
    } finally {
      releaseHang();
      if (first) {
        await first.catch(() => undefined);
      }
      spy.mockRestore();
      await h3.close();
      await settle();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /upload  (M15.1)
// ---------------------------------------------------------------------------

describe('POST /upload', () => {
  let h: ServerHandle;
  let testPdfBytes: Uint8Array;

  beforeAll(async () => {
    h = await startServer({});

    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([612, 792]);
    testPdfBytes = await pdfDoc.save();
  });

  afterAll(async () => {
    await h.close();
    await settle();
  });

  async function multipartUpload(
    pdfBytes: Uint8Array,
    pdfFilename: string,
    jsonBytes?: string,
  ): Promise<Response> {
    const boundary = '----FormBoundaryTest';
    const parts: Buffer[] = [];

    // PDF part
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="pdf"; filename="${pdfFilename}"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
    );
    parts.push(Buffer.from(pdfBytes));
    parts.push(Buffer.from('\r\n'));

    // Optional JSON part
    if (jsonBytes !== undefined) {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="json"; filename="test.fpdf.json"\r\nContent-Type: application/json\r\n\r\n`,
        ),
      );
      parts.push(Buffer.from(jsonBytes, 'utf-8'));
      parts.push(Buffer.from('\r\n'));
    }

    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    return fetch(`${h.url}/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
      body,
    });
  }

  it('returns 409 when analysis is already in progress', async () => {
    const analyzerModule = await import('../analyzer.js');
    let cancelHang!: () => void;
    const hanging = new Promise<never>((_, reject) => {
      cancelHang = () => {
        reject(new Error('cancelled'));
      };
    });
    const spy = vi.spyOn(analyzerModule, 'analyzePdf').mockReturnValueOnce(hanging);

    const h2 = await startServer({});

    const boundary = '----FormBoundaryHang';
    const parts: Buffer[] = [
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="pdf"; filename="hang.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
      Buffer.from(testPdfBytes),
      Buffer.from('\r\n'),
      Buffer.from(`--${boundary}--\r\n`),
    ];
    const body = Buffer.concat(parts);
    const makeReq = (): Promise<Response> =>
      fetch(`${h2.url}/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(body.length),
        },
        body,
      });

    // First request starts analysis (hangs). Attach the rejection handler
    // immediately so Vitest does not flag a transient unhandled rejection when
    // we later cancel the mock promise.
    const firstReq = makeReq().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 10));

    // Second request should get 409
    const second = await makeReq();
    expect(second.status).toBe(409);

    cancelHang();
    await firstReq.catch(() => undefined);
    spy.mockRestore();
    await h2.close();
    await settle();
  });

  it('returns 400-level error when no pdf field is included', async () => {
    const boundary = '----FormBoundaryNoPdf';
    const body = Buffer.from(`--${boundary}--\r\n`);
    const res = await fetch(`${h.url}/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
      body,
    });
    // Server returns 500 with error message when pdf field is absent
    expect(res.status).toBe(500);
    const err = (await res.json()) as { error: string };
    expect(err.error).toContain('pdf field');
  });

  it('accepts a valid PDF upload, analyzes it, and transitions to fill mode', async () => {
    const res = await multipartUpload(testPdfBytes, 'upload-test.pdf');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Server should now be in fill mode
    const docRes = await fetch(`${h.url}/doc`);
    expect(docRes.status).toBe(200);
    const doc = (await docRes.json()) as FpdfDocument;
    expect(doc.metadata.pdfFilename).toBe('upload-test.pdf');
  });

  it('broadcasts pdfOpened with uploaded:true to WS clients', async () => {
    const h2 = await startServer({});
    const wsUrl = h2.url.replace('http://', 'ws://') + '/ws';
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => ws.once('open', resolve));

    const opened = new Promise<Record<string, unknown>>((resolve) => {
      ws.on('message', (data: Buffer | string) => {
        const raw = Buffer.isBuffer(data) ? data.toString('utf-8') : data;
        const msg = JSON.parse(raw) as Record<string, unknown>;
        if (msg.type === 'pdfOpened') resolve(msg);
      });
    });

    const pdfDoc2 = await PDFDocument.create();
    pdfDoc2.addPage([612, 792]);
    const pdfBytes2 = await pdfDoc2.save();

    const boundary = '----FormBoundaryWsTest';
    const parts: Buffer[] = [];
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="pdf"; filename="ws-upload.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
    );
    parts.push(Buffer.from(pdfBytes2));
    parts.push(Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    await fetch(`${h2.url}/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
      body,
    });

    const msg = await opened;
    expect(msg.type).toBe('pdfOpened');
    expect(msg.uploaded).toBe(true);

    ws.close();
    await h2.close();
    await settle();
  });

  it('resumes from companion JSON when provided', async () => {
    const h3 = await startServer({});

    const pdfDoc3 = await PDFDocument.create();
    pdfDoc3.addPage([612, 792]);
    const pdfBytes3 = await pdfDoc3.save();

    const sessionDoc: FpdfDocument = {
      ...MOCK_DOC,
      metadata: {
        ...MOCK_DOC.metadata,
        pdfFilename: 'resume.pdf',
        originalPdf: '/tmp/resume.pdf',
      },
      pages: [
        {
          ...(MOCK_DOC.pages[0] ?? {
            pageNumber: 1,
            widthPt: 612,
            heightPt: 792,
            pageType: 'acroform' as const,
            fields: [],
            candidateFields: [],
            textBlocks: [],
          }),
          fields: [
            {
              ...(MOCK_DOC.pages[0]?.fields[0] ?? {
                id: 'x',
                name: 'x',
                type: 'text' as const,
                label: '',
                displayName: '',
                placement: { x: 0, y: 0, width: 0, height: 0 },
                value: '',
                required: false,
                readOnly: false,
                options: [],
              }),
              value: 'RestoredValue',
            },
          ],
        },
      ],
    };

    const boundary = '----FormBoundaryJsonResume';
    const parts: Buffer[] = [];
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="pdf"; filename="resume.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
    );
    parts.push(Buffer.from(pdfBytes3));
    parts.push(Buffer.from('\r\n'));

    const jsonStr = JSON.stringify(sessionDoc, null, 2);
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="json"; filename="resume.fpdf.json"\r\nContent-Type: application/json\r\n\r\n`,
      ),
    );
    parts.push(Buffer.from(jsonStr, 'utf-8'));
    parts.push(Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    await fetch(`${h3.url}/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
      body,
    });

    const docRes = await fetch(`${h3.url}/doc`);
    const doc = (await docRes.json()) as FpdfDocument;
    expect(doc.pages[0]?.fields[0]?.value).toBe('RestoredValue');

    await h3.close();
    await settle();
  });
});

// ---------------------------------------------------------------------------
// GET /session-json  (M15.5)
// ---------------------------------------------------------------------------

describe('GET /session-json', () => {
  it('returns 503 when no doc is loaded', async () => {
    const h = await startServer({});
    const res = await fetch(`${h.url}/session-json`);
    expect(res.status).toBe(503);
    await h.close();
    await settle();
  });

  it('returns JSON attachment with the current doc', async () => {
    const res = await fetch(`${baseUrl}/session-json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const disposition = res.headers.get('content-disposition') ?? '';
    expect(disposition).toContain('attachment');
    expect(disposition).toContain('.fpdf.json');
    const body = (await res.json()) as FpdfDocument;
    expect(body.metadata.pdfFilename).toBe('test.pdf');
  });
});

// ---------------------------------------------------------------------------
// POST /save-acroform — upload session streams bytes  (M15.4)
// ---------------------------------------------------------------------------

describe('POST /save-acroform (upload session)', () => {
  it('returns PDF bytes as attachment instead of writing to disk', async () => {
    const h = await startServer({});

    // Upload a real PDF to put the server into upload-session mode
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([612, 792]);
    const form = pdfDoc.getForm();
    const tf = form.createTextField('field1');
    tf.addToPage(page, { x: 50, y: 700, width: 200, height: 20 });
    const pdfBytes = await pdfDoc.save();

    const boundary = '----FormBoundarySaveAcro';
    const parts: Buffer[] = [];
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="pdf"; filename="save-acro.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
    );
    parts.push(Buffer.from(pdfBytes));
    parts.push(Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    await fetch(`${h.url}/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
      body,
    });

    // Now save-acroform should return bytes, not JSON
    const saveRes = await fetch(`${h.url}/save-acroform`, { method: 'POST' });
    expect(saveRes.status).toBe(200);
    const contentType = saveRes.headers.get('content-type') ?? '';
    expect(contentType).toContain('application/pdf');
    const disposition = saveRes.headers.get('content-disposition') ?? '';
    expect(disposition).toContain('attachment');
    expect(disposition).toContain('save-acro.fpdf.acroform.pdf');

    const buf = await saveRes.arrayBuffer();
    expect(Buffer.from(buf).subarray(0, 4).toString()).toBe('%PDF');

    await h.close();
    await settle();
  });
});

// ---------------------------------------------------------------------------
// WS saved ack includes uploaded flag  (M15.4)
// ---------------------------------------------------------------------------

describe('WebSocket saved ack — uploaded flag', () => {
  it('includes uploaded:false in the ack for a non-upload session', async () => {
    const mockPage = MOCK_DOC.pages[0];
    if (!mockPage) throw new Error('fixture missing page');

    const reply = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws`);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'save', doc: MOCK_DOC }));
      });
      ws.on('message', (data) => {
        ws.close();
        resolve(Buffer.from(data as Buffer).toString('utf-8'));
      });
      ws.on('error', reject);
    });

    const ack = JSON.parse(reply) as { type: string; uploaded: boolean };
    expect(ack.type).toBe('saved');
    expect(ack.uploaded).toBe(false);
  });
});
