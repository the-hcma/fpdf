import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PDFDocument, PDFTextField, PDFCheckBox } from 'pdf-lib';
import { exportFromImages, type RenderedPage } from '../exporter.js';
import type { FpdfDocument, CandidateField } from '../types.js';
import { MINIMAL_JPEG, MINIMAL_PNG } from './helpers.js';

function makeDoc(candidateFields: CandidateField[] = []): FpdfDocument {
  return {
    metadata: {
      version: '1.0',
      originalPdf: '/tmp/test.pdf',
      pdfFilename: 'test.pdf',
      pdfHash: 'sha256:abc',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      pageCount: 1,
      pdfKind: 'no-acroform',
    },
    pages: [
      {
        pageNumber: 1,
        widthPt: 612,
        heightPt: 792,
        pageType: 'vector' as const,
        fields: [],
        candidateFields,
        textBlocks: [],
      },
    ],
  };
}

function makeCandidate(overrides: Partial<CandidateField> = {}): CandidateField {
  return {
    id: 'c1',
    type: 'text',
    label: 'Name',
    displayName: 'Name',
    placement: { x: 50, y: 700, width: 200, height: 20 },
    value: '',
    confidence: 'high',
    dismissed: false,
    ...overrides,
  };
}

describe('exportFromImages', () => {
  it('creates a valid PDF from a single JPEG page', async () => {
    const pages: RenderedPage[] = [{ jpeg: MINIMAL_JPEG, widthPt: 612, heightPt: 792 }];
    const bytes = await exportFromImages(pages, makeDoc());
    const result = await PDFDocument.load(bytes);
    expect(result.getPageCount()).toBe(1);
    const page = result.getPage(0);
    expect(page.getWidth()).toBe(612);
    expect(page.getHeight()).toBe(792);
  });

  it('creates multiple pages', async () => {
    const doc = makeDoc();
    doc.metadata.pageCount = 2;
    doc.pages.push({
      pageNumber: 2,
      widthPt: 612,
      heightPt: 792,
      pageType: 'vector' as const,
      fields: [],
      candidateFields: [],
      textBlocks: [],
    });
    const pages: RenderedPage[] = [
      { jpeg: MINIMAL_JPEG, widthPt: 612, heightPt: 792 },
      { jpeg: MINIMAL_JPEG, widthPt: 612, heightPt: 792 },
    ];
    const bytes = await exportFromImages(pages, doc);
    const result = await PDFDocument.load(bytes);
    expect(result.getPageCount()).toBe(2);
  });

  it('produces a non-empty PDF even with no candidate fields', async () => {
    const pages: RenderedPage[] = [{ jpeg: MINIMAL_JPEG, widthPt: 612, heightPt: 792 }];
    const bytes = await exportFromImages(pages, makeDoc());
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('creates an AcroForm text field for a text candidate with a value', async () => {
    const candidate = makeCandidate({ value: 'John Doe', displayName: 'Full Name' });
    const pages: RenderedPage[] = [{ jpeg: MINIMAL_JPEG, widthPt: 612, heightPt: 792 }];
    const bytes = await exportFromImages(pages, makeDoc([candidate]));
    const result = await PDFDocument.load(bytes);
    const form = result.getForm();
    const fields = form.getFields();
    expect(fields).toHaveLength(1);
    const tf = fields[0];
    expect(tf).toBeInstanceOf(PDFTextField);
    expect((tf as PDFTextField).getText()).toBe('John Doe');
  });

  it('creates an AcroForm checkbox for a checked checkbox candidate', async () => {
    const candidate = makeCandidate({
      type: 'checkbox',
      value: true,
      displayName: 'Agree',
      placement: { x: 50, y: 700, width: 14, height: 14 },
    });
    const pages: RenderedPage[] = [{ jpeg: MINIMAL_JPEG, widthPt: 612, heightPt: 792 }];
    const bytes = await exportFromImages(pages, makeDoc([candidate]));
    const result = await PDFDocument.load(bytes);
    const form = result.getForm();
    const fields = form.getFields();
    expect(fields).toHaveLength(1);
    const cb = fields[0];
    expect(cb).toBeInstanceOf(PDFCheckBox);
    expect((cb as PDFCheckBox).isChecked()).toBe(true);
  });

  it('creates an unchecked checkbox widget when value is false', async () => {
    const candidate = makeCandidate({
      type: 'checkbox',
      value: false,
      displayName: 'Opt In',
      placement: { x: 50, y: 700, width: 14, height: 14 },
    });
    const pages: RenderedPage[] = [{ jpeg: MINIMAL_JPEG, widthPt: 612, heightPt: 792 }];
    const bytes = await exportFromImages(pages, makeDoc([candidate]));
    const result = await PDFDocument.load(bytes);
    const form = result.getForm();
    const fields = form.getFields();
    expect(fields).toHaveLength(1);
    expect((fields[0] as PDFCheckBox).isChecked()).toBe(false);
  });

  it('skips dismissed candidate fields', async () => {
    const candidate = makeCandidate({ value: 'Secret', dismissed: true });
    const pages: RenderedPage[] = [{ jpeg: MINIMAL_JPEG, widthPt: 612, heightPt: 792 }];
    const bytes = await exportFromImages(pages, makeDoc([candidate]));
    const result = await PDFDocument.load(bytes);
    const form = result.getForm();
    expect(form.getFields()).toHaveLength(0);
  });

  it('creates a widget even for empty string values when readOnly is false', async () => {
    const candidate = makeCandidate({ value: '', displayName: 'Empty Field' });
    const pages: RenderedPage[] = [{ jpeg: MINIMAL_JPEG, widthPt: 612, heightPt: 792 }];
    const bytes = await exportFromImages(pages, makeDoc([candidate]));
    const result = await PDFDocument.load(bytes);
    const form = result.getForm();
    expect(form.getFields()).toHaveLength(1);
  });

  it('creates editable (non-read-only) fields', async () => {
    const candidate = makeCandidate({ value: 'Editable', displayName: 'Name' });
    const pages: RenderedPage[] = [{ jpeg: MINIMAL_JPEG, widthPt: 612, heightPt: 792 }];
    const bytes = await exportFromImages(pages, makeDoc([candidate]));
    const result = await PDFDocument.load(bytes);
    const tf = result.getForm().getFields()[0] as PDFTextField;
    expect(tf.isReadOnly()).toBe(false);
  });
});

describe('exportFromImages — readOnly=true (finalized export)', () => {
  it('skips an empty text candidate so auto-detected fields do not appear in the output', async () => {
    const candidate = makeCandidate({ value: '', displayName: 'AutoDetected' });
    const pages: RenderedPage[] = [{ jpeg: MINIMAL_JPEG, widthPt: 612, heightPt: 792 }];
    const bytes = await exportFromImages(pages, makeDoc([candidate]), true);
    const result = await PDFDocument.load(bytes);
    expect(result.getForm().getFields()).toHaveLength(0);
  });

  it('includes a text candidate that has a non-empty value', async () => {
    const candidate = makeCandidate({ value: 'Alice', displayName: 'Name' });
    const pages: RenderedPage[] = [{ jpeg: MINIMAL_JPEG, widthPt: 612, heightPt: 792 }];
    const bytes = await exportFromImages(pages, makeDoc([candidate]), true);
    const result = await PDFDocument.load(bytes);
    const fields = result.getForm().getFields();
    expect(fields).toHaveLength(1);
    expect((fields[0] as PDFTextField).getText()).toBe('Alice');
  });

  it('skips an unchecked checkbox candidate', async () => {
    const candidate = makeCandidate({
      type: 'checkbox',
      value: false,
      displayName: 'Agree',
      placement: { x: 50, y: 700, width: 14, height: 14 },
    });
    const pages: RenderedPage[] = [{ jpeg: MINIMAL_JPEG, widthPt: 612, heightPt: 792 }];
    const bytes = await exportFromImages(pages, makeDoc([candidate]), true);
    const result = await PDFDocument.load(bytes);
    expect(result.getForm().getFields()).toHaveLength(0);
  });

  it('includes a checked checkbox candidate', async () => {
    const candidate = makeCandidate({
      type: 'checkbox',
      value: true,
      displayName: 'Agree',
      placement: { x: 50, y: 700, width: 14, height: 14 },
    });
    const pages: RenderedPage[] = [{ jpeg: MINIMAL_JPEG, widthPt: 612, heightPt: 792 }];
    const bytes = await exportFromImages(pages, makeDoc([candidate]), true);
    const result = await PDFDocument.load(bytes);
    const fields = result.getForm().getFields();
    expect(fields).toHaveLength(1);
    expect((fields[0] as PDFCheckBox).isChecked()).toBe(true);
  });

  it('marks the exported text field as read-only', async () => {
    const candidate = makeCandidate({ value: 'Bob', displayName: 'Name' });
    const pages: RenderedPage[] = [{ jpeg: MINIMAL_JPEG, widthPt: 612, heightPt: 792 }];
    const bytes = await exportFromImages(pages, makeDoc([candidate]), true);
    const result = await PDFDocument.load(bytes);
    const tf = result.getForm().getFields()[0] as PDFTextField;
    expect(tf.isReadOnly()).toBe(true);
  });
});

describe('exportFromImages — placed images', () => {
  it('stamps a placed JPEG image into the exported PDF with a Multiply transparency group', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fpdf-img-'));
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    await writeFile(path.join(dir, `${id}.jpg`), MINIMAL_JPEG);
    const doc = makeDoc();
    const page0 = doc.pages[0];
    if (page0 === undefined) throw new Error('expected page 0');
    page0.images = [
      { id, mimeType: 'image/jpeg', placement: { x: 0, y: 0, width: 100, height: 100 } },
    ];
    const pages: RenderedPage[] = [{ jpeg: MINIMAL_JPEG, widthPt: 612, heightPt: 792 }];
    const bytes = await exportFromImages(pages, doc, false, dir);
    const reloaded = await PDFDocument.load(bytes);
    const uncompressed = await reloaded.save({ useObjectStreams: false });
    const pdfText = Buffer.from(uncompressed).toString('latin1');
    expect(pdfText).toContain('/Transparency');
    expect(pdfText).toContain('/Multiply');
  });

  it('stamps a placed PNG image into the exported PDF with a Multiply transparency group', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fpdf-img-'));
    const id = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    await writeFile(path.join(dir, `${id}.png`), MINIMAL_PNG);
    const doc = makeDoc();
    const page0 = doc.pages[0];
    if (page0 === undefined) throw new Error('expected page 0');
    page0.images = [
      { id, mimeType: 'image/png', placement: { x: 0, y: 0, width: 100, height: 100 } },
    ];
    const pages: RenderedPage[] = [{ jpeg: MINIMAL_JPEG, widthPt: 612, heightPt: 792 }];
    const bytes = await exportFromImages(pages, doc, false, dir);
    const reloaded = await PDFDocument.load(bytes);
    const uncompressed = await reloaded.save({ useObjectStreams: false });
    const pdfText = Buffer.from(uncompressed).toString('latin1');
    expect(pdfText).toContain('/Transparency');
    expect(pdfText).toContain('/Multiply');
  });

  it('skips a placed image whose file is missing and still produces a valid PDF', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fpdf-img-'));
    const id = '11111111-2222-3333-4444-555555555555';
    // Intentionally do NOT write the file — drawPlacedImages should warn and skip.
    const doc = makeDoc();
    const page0 = doc.pages[0];
    if (page0 === undefined) throw new Error('expected page 0');
    page0.images = [
      { id, mimeType: 'image/jpeg', placement: { x: 0, y: 0, width: 100, height: 100 } },
    ];
    const pages: RenderedPage[] = [{ jpeg: MINIMAL_JPEG, widthPt: 612, heightPt: 792 }];
    const bytes = await exportFromImages(pages, doc, false, dir);
    const result = await PDFDocument.load(bytes);
    expect(result.getPageCount()).toBe(1);
  });
});

describe('exportFromImages — page exclusion', () => {
  it('omits an excluded page from the output', async () => {
    const doc: FpdfDocument = {
      metadata: {
        version: '1.0',
        originalPdf: '',
        pdfFilename: 'test.pdf',
        pdfHash: 'sha256:abc',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        pageCount: 2,
        pdfKind: 'no-acroform',
      },
      pages: [
        {
          pageNumber: 1,
          widthPt: 612,
          heightPt: 792,
          pageType: 'vector' as const,
          fields: [],
          candidateFields: [],
          textBlocks: [],
          excluded: true,
        },
        {
          pageNumber: 2,
          widthPt: 612,
          heightPt: 792,
          pageType: 'vector' as const,
          fields: [],
          candidateFields: [],
          textBlocks: [],
        },
      ],
    };
    const pages: RenderedPage[] = [
      { jpeg: MINIMAL_JPEG, widthPt: 612, heightPt: 792 },
      { jpeg: MINIMAL_JPEG, widthPt: 612, heightPt: 792 },
    ];
    const bytes = await exportFromImages(pages, doc);
    const result = await PDFDocument.load(bytes);
    expect(result.getPageCount()).toBe(1);
  });

  it('keeps all pages when none are excluded', async () => {
    const doc: FpdfDocument = {
      metadata: {
        version: '1.0',
        originalPdf: '',
        pdfFilename: 'test.pdf',
        pdfHash: 'sha256:abc',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        pageCount: 2,
        pdfKind: 'no-acroform',
      },
      pages: [
        {
          pageNumber: 1,
          widthPt: 612,
          heightPt: 792,
          pageType: 'vector' as const,
          fields: [],
          candidateFields: [],
          textBlocks: [],
        },
        {
          pageNumber: 2,
          widthPt: 612,
          heightPt: 792,
          pageType: 'vector' as const,
          fields: [],
          candidateFields: [],
          textBlocks: [],
        },
      ],
    };
    const pages: RenderedPage[] = [
      { jpeg: MINIMAL_JPEG, widthPt: 612, heightPt: 792 },
      { jpeg: MINIMAL_JPEG, widthPt: 612, heightPt: 792 },
    ];
    const bytes = await exportFromImages(pages, doc);
    const result = await PDFDocument.load(bytes);
    expect(result.getPageCount()).toBe(2);
  });
});
