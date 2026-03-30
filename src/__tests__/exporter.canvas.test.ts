import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFTextField, PDFCheckBox } from 'pdf-lib';
import { exportFromImages, type RenderedPage } from '../exporter.js';
import type { FpdfDocument, CandidateField } from '../types.js';
import { MINIMAL_JPEG } from './helpers.js';

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

  it('creates a widget even for empty string values (field is present but blank)', async () => {
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
