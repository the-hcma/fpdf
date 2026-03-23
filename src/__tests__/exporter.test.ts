// integration
import { describe, it, expect, beforeAll } from 'vitest';
import { tmpdir } from 'node:os';
import { writeFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { PDFDocument, PDFName, PDFString, PDFRawStream } from 'pdf-lib';
import { deflateSync } from 'node:zlib';
import { exportPdf } from '../exporter.js';
import { getXfaDatasetsInfo } from '../analyzer.js';
import type { FpdfDocument, PdfField } from '../types.js';

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
    const doc = makeDoc([
      { name: 'topmostSubform.Page1.firstName', type: 'text', value: 'Alice' },
      { name: 'topmostSubform.Page1.lastName', type: 'text', value: 'Smith' },
    ]);

    const bytes = await exportPdf(xfaPdfPath, doc);
    const result = await PDFDocument.load(bytes);
    const info = getXfaDatasetsInfo(result);
    expect(info).not.toBeNull();
    expect(info?.xml).toContain('<firstName>Alice</firstName>');
    expect(info?.xml).toContain('<lastName>Smith</lastName>');
  });

  it('exports successfully even when AcroForm has no matching fields', async () => {
    // XFA-only fields won't be found by form.getField(); export must still succeed
    const doc = makeDoc([{ name: 'topmostSubform.Page1.firstName', type: 'text', value: 'Bob' }]);
    await expect(exportPdf(xfaPdfPath, doc)).resolves.toBeInstanceOf(Uint8Array);
  });

  it('returns a valid PDF when XFA datasets are patched', async () => {
    const doc = makeDoc([{ name: 'topmostSubform.Page1.firstName', type: 'text', value: 'Carol' }]);
    const bytes = await exportPdf(xfaPdfPath, doc);
    expect(Buffer.from(bytes.slice(0, 4)).toString()).toBe('%PDF');
  });

  it('escapes XML special chars in field values', async () => {
    const doc = makeDoc([{ name: 'topmostSubform.Page1.firstName', type: 'text', value: 'A & B' }]);
    const bytes = await exportPdf(xfaPdfPath, doc);
    const result = await PDFDocument.load(bytes);
    const info = getXfaDatasetsInfo(result);
    expect(info?.xml).toContain('<firstName>A &amp; B</firstName>');
  });

  it('inserts absent elements into their parent when the element is not in the initial XML', async () => {
    // The fixture XML has <firstName/> and <lastName/> inside <topmostSubform>
    // but no <radio> element.  A field whose parent leaf is 'topmostSubform'
    // should be inserted there.
    const doc = makeDoc([{ name: 'topmostSubform.radio', type: 'radio', value: '1' }]);
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
    const doc = makeDoc([{ name: 'topmostSubform.Page1.radio', type: 'radio', value: '1' }]);
    const bytes = await exportPdf(xfaPdfPath, doc);
    const result = await PDFDocument.load(bytes);
    const info = getXfaDatasetsInfo(result);
    expect(info?.xml).toContain('<radio>1</radio>');
  });
});
