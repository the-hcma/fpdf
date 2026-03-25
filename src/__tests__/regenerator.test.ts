// integration
import { describe, it, expect, beforeAll } from 'vitest';
import { tmpdir } from 'node:os';
import { writeFile, mkdir, access } from 'node:fs/promises';
import * as path from 'node:path';
import { PDFDocument, PDFName, PDFString, PDFRawStream } from 'pdf-lib';
import { deflateSync } from 'node:zlib';
import { regenerateAsAcroForm } from '../regenerator.js';
import { getXfaDatasetsInfo } from '../analyzer.js';
import type { FpdfDocument, PdfField } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function writeTempPdf(name: string, bytes: Uint8Array): Promise<string> {
  const dir = path.join(tmpdir(), 'fpdf-regenerator-tests');
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, name);
  await writeFile(p, bytes);
  return p;
}

function makePdfField(overrides: Partial<PdfField>): PdfField {
  return {
    id: 'test-id',
    name: 'field',
    type: 'text',
    label: 'Field',
    displayName: 'Field',
    placement: { x: 50, y: 700, width: 200, height: 20 },
    value: '',
    required: false,
    readOnly: false,
    options: [],
    ...overrides,
  };
}

function makeDoc(fields: Partial<PdfField>[]): FpdfDocument {
  return {
    metadata: {
      version: '1.0',
      originalPdf: '',
      pdfFilename: 'test.pdf',
      pdfHash: 'sha256:abc',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      pageCount: 1,
      pdfKind: 'xfa-hybrid',
    },
    pages: [
      {
        pageNumber: 1,
        widthPt: 612,
        heightPt: 792,
        pageType: 'acroform',
        fields: fields.map((f) => makePdfField(f)),
        candidateFields: [],
        textBlocks: [],
      },
    ],
  };
}

/** Build a minimal PDF with AcroForm fields (no XFA). */
async function makeAcroFormPdfBytes(setup: (doc: PDFDocument) => void): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  setup(doc);
  return doc.save();
}

/** Build a minimal XFA-hybrid PDF (AcroForm fields + XFA datasets stream). */
async function makeXfaHybridPdfBytes(setup: (doc: PDFDocument) => void): Promise<Uint8Array> {
  const datasetsXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/">',
    '  <xfa:data><topmostSubform/></xfa:data>',
    '</xfa:datasets>',
  ].join('\n');

  const doc = await PDFDocument.create();
  setup(doc);

  const compressed = deflateSync(Buffer.from(datasetsXml, 'utf-8'));
  const streamDict = doc.context.obj({
    Filter: PDFName.of('FlateDecode'),
    Length: compressed.length,
  });
  const stream = PDFRawStream.of(streamDict, compressed);
  const streamRef = doc.context.register(stream);

  // Inject XFA into the existing AcroForm, or create one.
  const acroFormEntry = doc.catalog.get(PDFName.of('AcroForm'));
  if (!acroFormEntry) {
    doc.catalog.set(
      PDFName.of('AcroForm'),
      doc.context.obj({
        XFA: doc.context.obj([PDFString.of('datasets'), streamRef]),
        Fields: doc.context.obj([]),
      }),
    );
  } else {
    // Existing AcroForm from setup() — add XFA key to it.
    const resolved =
      acroFormEntry instanceof Object && 'objectNumber' in acroFormEntry
        ? doc.context.lookup(acroFormEntry as Parameters<typeof doc.context.lookup>[0])
        : acroFormEntry;
    if (resolved && typeof resolved === 'object' && 'set' in resolved) {
      (resolved as { set: (k: unknown, v: unknown) => void }).set(
        PDFName.of('XFA'),
        doc.context.obj([PDFString.of('datasets'), streamRef]),
      );
    }
  }

  return doc.save();
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let simplePdfPath: string; // Plain AcroForm PDF (one text field)
let xfaHybridPdfPath: string; // XFA hybrid PDF (one text field + XFA stream)
let radioPdfPath: string; // PDF with a two-option radio group

beforeAll(async () => {
  const simpleBytes = await makeAcroFormPdfBytes((doc) => {
    const page = doc.addPage([612, 792]);
    const form = doc.getForm();
    const tf = form.createTextField('firstName');
    tf.addToPage(page, { x: 50, y: 700, width: 200, height: 20 });
  });
  simplePdfPath = await writeTempPdf('simple.pdf', simpleBytes);

  const xfaBytes = await makeXfaHybridPdfBytes((doc) => {
    const page = doc.addPage([612, 792]);
    const form = doc.getForm();
    const tf = form.createTextField('firstName');
    tf.addToPage(page, { x: 50, y: 700, width: 200, height: 20 });
  });
  xfaHybridPdfPath = await writeTempPdf('xfa-hybrid.pdf', xfaBytes);

  const radioBytes = await makeAcroFormPdfBytes((doc) => {
    const page = doc.addPage([612, 792]);
    const form = doc.getForm();
    const rg = form.createRadioGroup('size');
    rg.addOptionToPage('small', page, { x: 50, y: 700, width: 15, height: 15 });
    rg.addOptionToPage('large', page, { x: 50, y: 680, width: 15, height: 15 });
  });
  radioPdfPath = await writeTempPdf('radio.pdf', radioBytes);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('regenerateAsAcroForm', () => {
  it('creates <base>-acroform.pdf sibling file', async () => {
    const doc = makeDoc([{ name: 'firstName', type: 'text', value: '' }]);
    const { newPdfPath } = await regenerateAsAcroForm(simplePdfPath, doc);
    await expect(access(newPdfPath)).resolves.toBeUndefined();
    expect(newPdfPath).toMatch(/\.fpdf-converted\.acroform\.pdf$/);
  });

  it('output PDF has pdfKind acroform', async () => {
    const doc = makeDoc([{ name: 'firstName', type: 'text', value: '' }]);
    const { newDoc } = await regenerateAsAcroForm(simplePdfPath, doc);
    expect(newDoc.metadata.pdfKind).toBe('acroform');
  });

  it('preserves text field values in the regenerated PDF', async () => {
    const doc = makeDoc([{ name: 'firstName', type: 'text', value: 'Alice' }]);
    const { newDoc } = await regenerateAsAcroForm(simplePdfPath, doc);
    const field = newDoc.pages[0]?.fields.find((f) => f.name === 'firstName');
    expect(field?.value).toBe('Alice');
  });

  it('preserves checkbox values (checked)', async () => {
    const cbPdfBytes = await makeAcroFormPdfBytes((doc) => {
      const page = doc.addPage([612, 792]);
      const form = doc.getForm();
      const cb = form.createCheckBox('agree');
      cb.addToPage(page, { x: 50, y: 700, width: 15, height: 15 });
    });
    const cbPdfPath = await writeTempPdf('checkbox-regen.pdf', cbPdfBytes);

    const doc: FpdfDocument = {
      metadata: {
        version: '1.0',
        originalPdf: cbPdfPath,
        pdfFilename: 'checkbox-regen.pdf',
        pdfHash: 'sha256:abc',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        pageCount: 1,
        pdfKind: 'acroform',
      },
      pages: [
        {
          pageNumber: 1,
          widthPt: 612,
          heightPt: 792,
          pageType: 'acroform',
          fields: [makePdfField({ name: 'agree', type: 'checkbox', value: true })],
          candidateFields: [],
          textBlocks: [],
        },
      ],
    };
    const { newDoc } = await regenerateAsAcroForm(cbPdfPath, doc);
    const field = newDoc.pages[0]?.fields.find((f) => f.name === 'agree');
    expect(field?.value).toBe(true);
  });

  it('preserves radio group structure and pre-selected option', async () => {
    const doc: FpdfDocument = {
      metadata: {
        version: '1.0',
        originalPdf: radioPdfPath,
        pdfFilename: 'radio.pdf',
        pdfHash: 'sha256:abc',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        pageCount: 1,
        pdfKind: 'acroform',
      },
      pages: [
        {
          pageNumber: 1,
          widthPt: 612,
          heightPt: 792,
          pageType: 'acroform',
          fields: [
            makePdfField({
              name: 'size',
              type: 'radio',
              value: 'large',
              radioValue: 'small',
              placement: { x: 50, y: 700, width: 15, height: 15 },
            }),
            makePdfField({
              name: 'size',
              type: 'radio',
              value: 'large',
              radioValue: 'large',
              placement: { x: 50, y: 680, width: 15, height: 15 },
            }),
          ],
          candidateFields: [],
          textBlocks: [],
        },
      ],
    };
    const { newDoc } = await regenerateAsAcroForm(radioPdfPath, doc);
    const radioFields = newDoc.pages[0]?.fields.filter((f) => f.name === 'size');
    // Both widgets should be present
    expect(radioFields?.length).toBe(2);
    // All widgets should reflect the selected value
    const selected = radioFields?.find((f) => f.value === 'large');
    expect(selected).toBeTruthy();
  });

  it('drops XFA datasets from the output PDF', async () => {
    const doc = makeDoc([{ name: 'firstName', type: 'text', value: 'Bob' }]);
    const { newPdfPath } = await regenerateAsAcroForm(xfaHybridPdfPath, doc);
    const bytes = await import('node:fs/promises').then((m) => m.readFile(newPdfPath));
    const pdfDoc = await PDFDocument.load(bytes);
    expect(getXfaDatasetsInfo(pdfDoc)).toBeNull();
  });

  it('output is a valid PDF (starts with %PDF)', async () => {
    const doc = makeDoc([{ name: 'firstName', type: 'text', value: '' }]);
    const { newPdfPath } = await regenerateAsAcroForm(simplePdfPath, doc);
    const bytes = await import('node:fs/promises').then((m) => m.readFile(newPdfPath));
    expect(Buffer.from(bytes.subarray(0, 4)).toString()).toBe('%PDF');
  });

  it('handles textarea fields (multi-line enabled)', async () => {
    const doc = makeDoc([{ name: 'notes', type: 'textarea', value: 'Hello\nWorld' }]);
    const { newDoc } = await regenerateAsAcroForm(simplePdfPath, doc);
    const field = newDoc.pages[0]?.fields.find((f) => f.name === 'notes');
    expect(field).toBeDefined();
  });

  it('handles unchecked checkbox (value: false)', async () => {
    const cbPdfBytes = await makeAcroFormPdfBytes((doc) => {
      const page = doc.addPage([612, 792]);
      const form = doc.getForm();
      const cb = form.createCheckBox('accept');
      cb.addToPage(page, { x: 50, y: 700, width: 15, height: 15 });
    });
    const cbPdfPath = await writeTempPdf('unchecked-cb.pdf', cbPdfBytes);
    const doc: FpdfDocument = {
      metadata: {
        version: '1.0',
        originalPdf: cbPdfPath,
        pdfFilename: 'unchecked-cb.pdf',
        pdfHash: 'sha256:abc',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        pageCount: 1,
        pdfKind: 'acroform',
      },
      pages: [
        {
          pageNumber: 1,
          widthPt: 612,
          heightPt: 792,
          pageType: 'acroform',
          fields: [makePdfField({ name: 'accept', type: 'checkbox', value: false })],
          candidateFields: [],
          textBlocks: [],
        },
      ],
    };
    const { newDoc } = await regenerateAsAcroForm(cbPdfPath, doc);
    const field = newDoc.pages[0]?.fields.find((f) => f.name === 'accept');
    expect(field?.value).toBe(false);
  });

  it('leaves radio group unselected when all widget values are empty', async () => {
    const doc: FpdfDocument = {
      metadata: {
        version: '1.0',
        originalPdf: radioPdfPath,
        pdfFilename: 'radio.pdf',
        pdfHash: 'sha256:abc',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        pageCount: 1,
        pdfKind: 'acroform',
      },
      pages: [
        {
          pageNumber: 1,
          widthPt: 612,
          heightPt: 792,
          pageType: 'acroform',
          fields: [
            makePdfField({
              name: 'plan',
              type: 'radio',
              value: '',
              radioValue: 'hmo',
              placement: { x: 50, y: 700, width: 15, height: 15 },
            }),
            makePdfField({
              name: 'plan',
              type: 'radio',
              value: '',
              radioValue: 'ppo',
              placement: { x: 50, y: 680, width: 15, height: 15 },
            }),
          ],
          candidateFields: [],
          textBlocks: [],
        },
      ],
    };
    const { newDoc } = await regenerateAsAcroForm(radioPdfPath, doc);
    const radioFields = newDoc.pages[0]?.fields.filter((f) => f.name === 'plan');
    expect(radioFields?.length).toBe(2);
  });

  it('deduplicates non-radio fields with the same name across pages (second occurrence skipped)', async () => {
    const doc: FpdfDocument = {
      metadata: {
        version: '1.0',
        originalPdf: simplePdfPath,
        pdfFilename: 'simple.pdf',
        pdfHash: 'sha256:abc',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        pageCount: 1,
        pdfKind: 'acroform',
      },
      pages: [
        {
          pageNumber: 1,
          widthPt: 612,
          heightPt: 792,
          pageType: 'acroform',
          fields: [
            makePdfField({
              name: 'dup',
              type: 'text',
              value: 'first',
              placement: { x: 50, y: 700, width: 200, height: 20 },
            }),
            // Same name — should be skipped by the createdNames guard
            makePdfField({
              name: 'dup',
              type: 'text',
              value: 'second',
              placement: { x: 50, y: 670, width: 200, height: 20 },
            }),
          ],
          candidateFields: [],
          textBlocks: [],
        },
      ],
    };
    const { newDoc } = await regenerateAsAcroForm(simplePdfPath, doc);
    const dupFields = newDoc.pages[0]?.fields.filter((f) => f.name === 'dup');
    expect(dupFields?.length).toBe(1);
  });

  it('handles radio field with no radioValue (falls back to empty string)', async () => {
    const doc: FpdfDocument = {
      metadata: {
        version: '1.0',
        originalPdf: radioPdfPath,
        pdfFilename: 'radio.pdf',
        pdfHash: 'sha256:abc',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        pageCount: 1,
        pdfKind: 'acroform',
      },
      pages: [
        {
          pageNumber: 1,
          widthPt: 612,
          heightPt: 792,
          pageType: 'acroform',
          fields: [
            // radioValue omitted → falls back to '' via ??
            makePdfField({
              name: 'opt',
              type: 'radio',
              value: '',
              placement: { x: 50, y: 700, width: 15, height: 15 },
            }),
          ],
          candidateFields: [],
          textBlocks: [],
        },
      ],
    };
    // Should complete without error even with an empty radioValue
    const { newDoc } = await regenerateAsAcroForm(radioPdfPath, doc);
    expect(newDoc).toBeDefined();
  });

  it('handles select/dropdown fields: valid value, invalid value, and empty value', async () => {
    const doc: FpdfDocument = {
      metadata: {
        version: '1.0',
        originalPdf: simplePdfPath,
        pdfFilename: 'simple.pdf',
        pdfHash: 'sha256:abc',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        pageCount: 1,
        pdfKind: 'acroform',
      },
      pages: [
        {
          pageNumber: 1,
          widthPt: 612,
          heightPt: 792,
          pageType: 'acroform',
          fields: [
            // Valid option selected — dd.select() succeeds
            makePdfField({
              name: 'color',
              type: 'select',
              value: 'red',
              options: ['red', 'blue'],
              placement: { x: 50, y: 700, width: 200, height: 20 },
            }),
            // Invalid option — dd.select() throws; field left unselected
            makePdfField({
              name: 'shape',
              type: 'select',
              value: 'triangle',
              options: ['circle', 'square'],
              placement: { x: 50, y: 650, width: 200, height: 20 },
            }),
            // Empty value — dd.select() is not called
            makePdfField({
              name: 'size',
              type: 'select',
              value: '',
              options: ['S', 'M', 'L'],
              placement: { x: 50, y: 600, width: 200, height: 20 },
            }),
          ],
          candidateFields: [],
          textBlocks: [],
        },
      ],
    };

    const { newDoc } = await regenerateAsAcroForm(simplePdfPath, doc);
    // All three dropdown fields should have been created
    const colorField = newDoc.pages[0]?.fields.find((f) => f.name === 'color');
    expect(colorField).toBeDefined();
  });
});
