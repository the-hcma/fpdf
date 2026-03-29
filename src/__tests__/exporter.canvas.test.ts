import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
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

  it('stamps text candidate field values onto the page', async () => {
    const candidate = makeCandidate({ value: 'John Doe' });
    const pages: RenderedPage[] = [{ jpeg: MINIMAL_JPEG, widthPt: 612, heightPt: 792 }];
    const bytes = await exportFromImages(pages, makeDoc([candidate]));
    const result = await PDFDocument.load(bytes);
    expect(result.getPageCount()).toBe(1);
    expect(bytes.length).toBeGreaterThan(MINIMAL_JPEG.length);
  });

  it('stamps checkbox marks when value is true', async () => {
    const candidate = makeCandidate({
      type: 'checkbox',
      value: true,
      placement: { x: 50, y: 700, width: 14, height: 14 },
    });
    const pages: RenderedPage[] = [{ jpeg: MINIMAL_JPEG, widthPt: 612, heightPt: 792 }];
    const bytes = await exportFromImages(pages, makeDoc([candidate]));
    const result = await PDFDocument.load(bytes);
    expect(result.getPageCount()).toBe(1);
  });

  it('skips dismissed candidate fields', async () => {
    const candidate = makeCandidate({ value: 'Secret', dismissed: true });
    const pages: RenderedPage[] = [{ jpeg: MINIMAL_JPEG, widthPt: 612, heightPt: 792 }];
    const withDismissed = await exportFromImages(pages, makeDoc([candidate]));

    const noCandidates = await exportFromImages(pages, makeDoc([]));
    expect(withDismissed.length).toBe(noCandidates.length);
  });

  it('skips empty string values', async () => {
    const candidate = makeCandidate({ value: '' });
    const pages: RenderedPage[] = [{ jpeg: MINIMAL_JPEG, widthPt: 612, heightPt: 792 }];
    const withEmpty = await exportFromImages(pages, makeDoc([candidate]));
    const noCandidates = await exportFromImages(pages, makeDoc([]));
    expect(withEmpty.length).toBe(noCandidates.length);
  });
});
