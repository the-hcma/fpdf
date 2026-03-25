// integration
import { describe, it, expect, beforeAll } from 'vitest';
import { tmpdir } from 'node:os';
import { writeFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { PDFDocument, PDFName, PDFString, PDFRawStream, PDFDict, PDFRef } from 'pdf-lib';
import { deflateSync } from 'node:zlib';
import { exportPdf } from '../exporter.js';
import { getXfaDatasetsInfo } from '../analyzer.js';
import type { FpdfDocument, PdfField, PdfKind, CandidateField } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makePdfBytes(setup: (doc: PDFDocument) => void): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  setup(doc);
  return doc.save();
}

async function writeTempPdf(name: string, bytes: Uint8Array): Promise<string> {
  const dir = path.join(tmpdir(), 'fpdf-exporter-tests');
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, name);
  await writeFile(p, bytes);
  return p;
}

function makeDoc(fields: Partial<PdfField>[], pdfKind: PdfKind = 'acroform'): FpdfDocument {
  return {
    metadata: {
      version: '1.0',
      originalPdf: '',
      pdfFilename: 'test.pdf',
      pdfHash: 'sha256:abc',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      pageCount: 1,
      pdfKind,
    },
    pages: [
      {
        pageNumber: 1,
        widthPt: 612,
        heightPt: 792,
        pageType: 'acroform' as const,
        fields: fields.map((f) => ({
          id: 'test-id',
          name: 'field',
          type: 'text' as const,
          label: 'Field',
          displayName: 'Field',
          placement: { x: 50, y: 700, width: 200, height: 20 },
          value: '',
          required: false,
          readOnly: false,
          options: [],
          ...f,
        })),
        candidateFields: [],
        textBlocks: [],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let textPdfPath: string;
let checkboxPdfPath: string;
let dropdownPdfPath: string;
let radioPdfPath: string;

beforeAll(async () => {
  const textBytes = await makePdfBytes((doc) => {
    const page = doc.addPage([612, 792]);
    const form = doc.getForm();
    const tf = form.createTextField('firstName');
    tf.addToPage(page, { x: 50, y: 700, width: 200, height: 20 });
  });
  textPdfPath = await writeTempPdf('text.pdf', textBytes);

  const checkboxBytes = await makePdfBytes((doc) => {
    const page = doc.addPage([612, 792]);
    const form = doc.getForm();
    const cb = form.createCheckBox('agree');
    cb.addToPage(page, { x: 50, y: 700, width: 20, height: 20 });
  });
  checkboxPdfPath = await writeTempPdf('checkbox.pdf', checkboxBytes);

  const dropdownBytes = await makePdfBytes((doc) => {
    const page = doc.addPage([612, 792]);
    const form = doc.getForm();
    const dd = form.createDropdown('color');
    dd.setOptions(['red', 'green', 'blue']);
    dd.addToPage(page, { x: 50, y: 700, width: 200, height: 20 });
  });
  dropdownPdfPath = await writeTempPdf('dropdown.pdf', dropdownBytes);

  const radioBytes = await makePdfBytes((doc) => {
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

describe('exportPdf', () => {
  it('writes a text field value into the returned PDF bytes', async () => {
    const doc = makeDoc([{ name: 'firstName', type: 'text', value: 'Alice' }]);
    doc.metadata.originalPdf = textPdfPath;

    const bytes = await exportPdf(textPdfPath, doc);
    const result = await PDFDocument.load(bytes);
    expect(result.getForm().getTextField('firstName').getText()).toBe('Alice');
  });

  it('checks a checkbox when value is true', async () => {
    const doc = makeDoc([{ name: 'agree', type: 'checkbox', value: true }]);
    doc.metadata.originalPdf = checkboxPdfPath;

    const bytes = await exportPdf(checkboxPdfPath, doc);
    const result = await PDFDocument.load(bytes);
    expect(result.getForm().getCheckBox('agree').isChecked()).toBe(true);
  });

  it('unchecks a checkbox when value is false', async () => {
    const doc = makeDoc([{ name: 'agree', type: 'checkbox', value: false }]);
    doc.metadata.originalPdf = checkboxPdfPath;

    const bytes = await exportPdf(checkboxPdfPath, doc);
    const result = await PDFDocument.load(bytes);
    expect(result.getForm().getCheckBox('agree').isChecked()).toBe(false);
  });

  it('selects a dropdown value', async () => {
    const doc = makeDoc([
      { name: 'color', type: 'select', value: 'green', options: ['red', 'green', 'blue'] },
    ]);
    doc.metadata.originalPdf = dropdownPdfPath;

    const bytes = await exportPdf(dropdownPdfPath, doc);
    const result = await PDFDocument.load(bytes);
    expect(result.getForm().getDropdown('color').getSelected()).toContain('green');
  });

  it('skips duplicate field names (processes each name only once)', async () => {
    const doc = makeDoc([
      { name: 'firstName', type: 'text', value: 'First' },
      { name: 'firstName', type: 'text', value: 'Duplicate' },
    ]);
    doc.metadata.originalPdf = textPdfPath;

    const bytes = await exportPdf(textPdfPath, doc);
    const result = await PDFDocument.load(bytes);
    // 'First' should win; 'Duplicate' is skipped
    expect(result.getForm().getTextField('firstName').getText()).toBe('First');
  });

  it('falls back to empty string when a boolean value is passed to a text field', async () => {
    // Covers the `typeof value === 'string' ? value : ''` false branch in setText.
    // pdf-lib returns undefined for an empty field, so we just verify it doesn't throw.
    const doc = makeDoc([{ name: 'firstName', type: 'text', value: false as unknown as string }]);
    await expect(exportPdf(textPdfPath, doc)).resolves.toBeInstanceOf(Uint8Array);
  });

  it('silently skips field names not present in the PDF', async () => {
    const doc = makeDoc([
      { name: 'nonExistentField', type: 'text', value: 'ignored' },
      { name: 'firstName', type: 'text', value: 'Alice' },
    ]);
    doc.metadata.originalPdf = textPdfPath;

    await expect(exportPdf(textPdfPath, doc)).resolves.toBeInstanceOf(Uint8Array);
  });

  it('selects a radio group option when value is a non-empty string', async () => {
    const doc = makeDoc([{ name: 'size', type: 'radio', value: 'large' }]);
    doc.metadata.originalPdf = radioPdfPath;

    const bytes = await exportPdf(radioPdfPath, doc);
    const result = await PDFDocument.load(bytes);
    expect(result.getForm().getRadioGroup('size').getSelected()).toBe('large');
  });

  it('skips a radio group field when value is boolean (no option identity)', async () => {
    const doc = makeDoc([{ name: 'size', type: 'radio', value: true }]);
    doc.metadata.originalPdf = radioPdfPath;

    const bytes = await exportPdf(radioPdfPath, doc);
    const result = await PDFDocument.load(bytes);
    // No option should be selected — boolean value carries no option name
    expect(result.getForm().getRadioGroup('size').getSelected()).toBeUndefined();
  });

  it('returns a valid PDF (starts with %PDF header)', async () => {
    const doc = makeDoc([{ name: 'firstName', type: 'text', value: 'Test' }]);
    doc.metadata.originalPdf = textPdfPath;

    const bytes = await exportPdf(textPdfPath, doc);
    expect(Buffer.from(bytes.slice(0, 4)).toString()).toBe('%PDF');
  });

  it('uses stored pdfKind acroform path without XFA re-detection', async () => {
    const doc = makeDoc([{ name: 'firstName', type: 'text', value: 'KindTest' }], 'acroform');
    doc.metadata.originalPdf = textPdfPath;
    const bytes = await exportPdf(textPdfPath, doc);
    const result = await PDFDocument.load(bytes);
    expect(result.getForm().getTextField('firstName').getText()).toBe('KindTest');
  });

  it('falls back to runtime XFA detection when pdfKind is absent (old file)', async () => {
    const doc = makeDoc([{ name: 'firstName', type: 'text', value: 'Legacy' }]);
    doc.metadata.originalPdf = textPdfPath;
    // Simulate an old .fpdf.json without pdfKind
    delete (doc.metadata as unknown as Record<string, unknown>).pdfKind;
    const bytes = await exportPdf(textPdfPath, doc);
    const result = await PDFDocument.load(bytes);
    expect(result.getForm().getTextField('firstName').getText()).toBe('Legacy');
  });
});

// ---------------------------------------------------------------------------
// XFA datasets patching
// ---------------------------------------------------------------------------

async function makeXfaPdfBytes(): Promise<Uint8Array> {
  const datasetsXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/">',
    '  <xfa:data>',
    '    <topmostSubform>',
    '      <firstName/>',
    '      <lastName/>',
    '    </topmostSubform>',
    '  </xfa:data>',
    '</xfa:datasets>',
  ].join('\n');

  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);

  const compressedBytes = deflateSync(Buffer.from(datasetsXml, 'utf-8'));
  const streamDict = doc.context.obj({
    Filter: PDFName.of('FlateDecode'),
    Length: compressedBytes.length,
  });
  const stream = PDFRawStream.of(streamDict, compressedBytes);
  const streamRef = doc.context.register(stream);

  doc.catalog.set(
    PDFName.of('AcroForm'),
    doc.context.obj({
      XFA: doc.context.obj([PDFString.of('datasets'), streamRef]),
      Fields: doc.context.obj([]),
    }),
  );

  return doc.save();
}

describe('exportPdf — XFA datasets patching', () => {
  let xfaPdfPath: string;

  beforeAll(async () => {
    const bytes = await makeXfaPdfBytes();
    xfaPdfPath = await writeTempPdf('xfa-datasets.pdf', bytes);
  });

  it('patches firstName and lastName in the XFA datasets XML', async () => {
    const doc = makeDoc(
      [
        { name: 'topmostSubform.Page1.firstName', type: 'text', value: 'Alice' },
        { name: 'topmostSubform.Page1.lastName', type: 'text', value: 'Smith' },
      ],
      'xfa-hybrid',
    );

    const bytes = await exportPdf(xfaPdfPath, doc);
    const result = await PDFDocument.load(bytes);
    const info = getXfaDatasetsInfo(result);
    expect(info).not.toBeNull();
    expect(info?.xml).toContain('<firstName>Alice</firstName>');
    expect(info?.xml).toContain('<lastName>Smith</lastName>');
  });

  it('exports successfully even when AcroForm has no matching fields', async () => {
    // XFA-only fields won't be found by form.getField(); export must still succeed
    const doc = makeDoc(
      [{ name: 'topmostSubform.Page1.firstName', type: 'text', value: 'Bob' }],
      'xfa-hybrid',
    );
    await expect(exportPdf(xfaPdfPath, doc)).resolves.toBeInstanceOf(Uint8Array);
  });

  it('returns a valid PDF when XFA datasets are patched', async () => {
    const doc = makeDoc(
      [{ name: 'topmostSubform.Page1.firstName', type: 'text', value: 'Carol' }],
      'xfa-hybrid',
    );
    const bytes = await exportPdf(xfaPdfPath, doc);
    expect(Buffer.from(bytes.slice(0, 4)).toString()).toBe('%PDF');
  });

  it('escapes XML special chars in field values', async () => {
    const doc = makeDoc(
      [{ name: 'topmostSubform.Page1.firstName', type: 'text', value: 'A & B' }],
      'xfa-hybrid',
    );
    const bytes = await exportPdf(xfaPdfPath, doc);
    const result = await PDFDocument.load(bytes);
    const info = getXfaDatasetsInfo(result);
    expect(info?.xml).toContain('<firstName>A &amp; B</firstName>');
  });

  it('inserts absent elements into their parent when the element is not in the initial XML', async () => {
    // The fixture XML has <firstName/> and <lastName/> inside <topmostSubform>
    // but no <radio> element.  A field whose parent leaf is 'topmostSubform'
    // should be inserted there.
    const doc = makeDoc(
      [{ name: 'topmostSubform.radio', type: 'radio', value: '1' }],
      'xfa-hybrid',
    );
    const bytes = await exportPdf(xfaPdfPath, doc);
    const result = await PDFDocument.load(bytes);
    const info = getXfaDatasetsInfo(result);
    expect(info?.xml).toContain('<radio>1</radio>');
  });

  it('inserts absent elements by walking up to a grandparent when the direct parent is absent', async () => {
    // Real XFA PDFs often have deep template nesting (e.g. Page1[0].#subform[3].field[0])
    // but flat datasets XML where all data lives under <topmostSubform> directly.
    // The insertion fallback must skip missing intermediate elements and insert at the
    // first ancestor whose closing tag exists in the XML.
    // Here: 'topmostSubform.Page1.radio' — <Page1> is absent from the fixture XML,
    // so the fallback should walk up to <topmostSubform> and insert there.
    const doc = makeDoc(
      [{ name: 'topmostSubform.Page1.radio', type: 'radio', value: '1' }],
      'xfa-hybrid',
    );
    const bytes = await exportPdf(xfaPdfPath, doc);
    const result = await PDFDocument.load(bytes);
    const info = getXfaDatasetsInfo(result);
    expect(info?.xml).toContain('<radio>1</radio>');
  });
});

// ---------------------------------------------------------------------------
// XFA hybrid PDF — AcroForm radio group translation
// ---------------------------------------------------------------------------

async function makeXfaHybridWithRadioPdfBytes(): Promise<Uint8Array> {
  const datasetsXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/">',
    '  <xfa:data><topmostSubform><agree/></topmostSubform></xfa:data>',
    '</xfa:datasets>',
  ].join('\n');

  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const form = doc.getForm();
  const rg = form.createRadioGroup('agree');
  rg.addOptionToPage('Yes', page, { x: 50, y: 700, width: 15, height: 15 });
  rg.addOptionToPage('No', page, { x: 50, y: 680, width: 15, height: 15 });

  const compressedBytes = deflateSync(Buffer.from(datasetsXml, 'utf-8'));
  const streamDict = doc.context.obj({
    Filter: PDFName.of('FlateDecode'),
    Length: compressedBytes.length,
  });
  const stream = PDFRawStream.of(streamDict, compressedBytes);
  const streamRef = doc.context.register(stream);

  // Inject XFA entry into the AcroForm dict that pdf-lib created for the radio group
  const acroFormVal = doc.catalog.get(PDFName.of('AcroForm'));
  const acroForm = acroFormVal instanceof PDFRef ? doc.context.lookup(acroFormVal) : acroFormVal;
  if (acroForm instanceof PDFDict) {
    acroForm.set(PDFName.of('XFA'), doc.context.obj([PDFString.of('datasets'), streamRef]));
  }

  return doc.save({ useObjectStreams: false });
}

describe('exportPdf — XFA hybrid AcroForm radio translation', () => {
  let xfaHybridRadioPdfPath: string;

  beforeAll(async () => {
    const bytes = await makeXfaHybridWithRadioPdfBytes();
    xfaHybridRadioPdfPath = await writeTempPdf('xfa-hybrid-radio.pdf', bytes);
  });

  it('selects a radio option by matching the on-value index (isXfa=true path)', async () => {
    // In pdf-lib, option name == on-value; 'Yes' on-value is '/Yes'.
    // exportPdf with isXfa=true runs the PDFName translation path.
    const doc = makeDoc([{ name: 'agree', type: 'radio', value: 'Yes' }], 'xfa-hybrid');
    const bytes = await exportPdf(xfaHybridRadioPdfPath, doc);
    const result = await PDFDocument.load(bytes);
    const selected = result.getForm().getRadioGroup('agree').getSelected();
    expect(selected).toBe('Yes');
  });

  // ── Candidate field overlay (drawCandidateValues) ──────────────────────────

  it('draws candidate text values as a text overlay on the exported PDF', async () => {
    // Build a plain PDF with no AcroForm fields.
    const plainBytes = await makePdfBytes((doc) => {
      doc.addPage([612, 792]);
    });
    const plainPath = await writeTempPdf('plain-candidate.pdf', plainBytes);

    const candidate: CandidateField = {
      id: 'c1',
      type: 'text',
      label: 'Name',
      displayName: 'Name',
      placement: { x: 50, y: 700, width: 200, height: 20 },
      value: 'Alice',
      confidence: 'high',
      dismissed: false,
    };

    const doc: FpdfDocument = {
      metadata: {
        version: '1.0',
        originalPdf: plainPath,
        pdfFilename: 'plain-candidate.pdf',
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
          pageType: 'vector',
          fields: [],
          candidateFields: [candidate],
          textBlocks: [],
        },
      ],
    };

    const bytes = await exportPdf(plainPath, doc);
    // The exported PDF should be valid and loadable (text is drawn as content stream).
    const result = await PDFDocument.load(bytes);
    expect(result.getPageCount()).toBe(1);
    // No AcroForm fields — the form has no fields.
    expect(result.getForm().getFields()).toHaveLength(0);
  });

  it('draws an X for a checked candidate checkbox', async () => {
    const plainBytes = await makePdfBytes((doc) => {
      doc.addPage([612, 792]);
    });
    const plainPath = await writeTempPdf('plain-checkbox-candidate.pdf', plainBytes);

    const candidate: CandidateField = {
      id: 'c2',
      type: 'checkbox',
      label: 'Agree',
      displayName: 'Agree',
      placement: { x: 50, y: 700, width: 12, height: 12 },
      value: true,
      confidence: 'medium',
      dismissed: false,
    };

    const doc: FpdfDocument = {
      metadata: {
        version: '1.0',
        originalPdf: plainPath,
        pdfFilename: 'plain-checkbox-candidate.pdf',
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
          pageType: 'vector',
          fields: [],
          candidateFields: [candidate],
          textBlocks: [],
        },
      ],
    };

    const bytes = await exportPdf(plainPath, doc);
    const result = await PDFDocument.load(bytes);
    expect(result.getPageCount()).toBe(1);
  });

  it('skips dismissed candidate fields', async () => {
    const plainBytes = await makePdfBytes((doc) => {
      doc.addPage([612, 792]);
    });
    const plainPath = await writeTempPdf('plain-dismissed.pdf', plainBytes);

    const candidate: CandidateField = {
      id: 'c3',
      type: 'text',
      label: 'Name',
      displayName: 'Name',
      placement: { x: 50, y: 700, width: 200, height: 20 },
      value: 'Alice',
      confidence: 'high',
      dismissed: true,
    };

    const doc: FpdfDocument = {
      metadata: {
        version: '1.0',
        originalPdf: plainPath,
        pdfFilename: 'plain-dismissed.pdf',
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
          pageType: 'vector',
          fields: [],
          candidateFields: [candidate],
          textBlocks: [],
        },
      ],
    };

    // Should not throw; dismissed candidate is silently skipped.
    const bytes = await exportPdf(plainPath, doc);
    const result = await PDFDocument.load(bytes);
    expect(result.getPageCount()).toBe(1);
  });

  it('falls back to direct select when on-value is not found; swallows the error if invalid', async () => {
    // Value '0' is not in the on-values ['/Yes', '/No'] → idx === -1 → fallback
    // pdfField.select('0') throws (not a valid option name) → caught silently.
    const doc = makeDoc([{ name: 'agree', type: 'radio', value: '0' }], 'xfa-hybrid');
    // Should not throw even though neither translation nor direct select succeeds
    await expect(exportPdf(xfaHybridRadioPdfPath, doc)).resolves.toBeInstanceOf(Uint8Array);
  });

  it('skips an XFA radio field when value is an empty string', async () => {
    const doc = makeDoc([{ name: 'agree', type: 'radio', value: '' }], 'xfa-hybrid');
    await expect(exportPdf(xfaHybridRadioPdfPath, doc)).resolves.toBeInstanceOf(Uint8Array);
  });
});
