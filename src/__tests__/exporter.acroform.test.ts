// integration
import { describe, it, expect, beforeAll } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { exportPdf } from '../exporter.js';
import type { FpdfDocument, PdfField, PdfKind, CandidateField } from '../types.js';
import { makePdfBytes, writeTempPdf } from './helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDoc(
  fields: Partial<PdfField>[],
  pdfKind: PdfKind = 'acroform',
  candidateFields: CandidateField[] = [],
): FpdfDocument {
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
        candidateFields,
        textBlocks: [],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let textPdfPath: string;
let narrowTextPdfPath: string;
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
  textPdfPath = await writeTempPdf('text.pdf', textBytes, 'fpdf-exporter-tests');

  // A very narrow (50pt) single-line field — text that overflows at 12pt triggers auto-shrink.
  const narrowBytes = await makePdfBytes((doc) => {
    const page = doc.addPage([612, 792]);
    const form = doc.getForm();
    const tf = form.createTextField('narrow');
    tf.addToPage(page, { x: 50, y: 700, width: 50, height: 14 });
  });
  narrowTextPdfPath = await writeTempPdf('narrow.pdf', narrowBytes, 'fpdf-exporter-tests');

  const checkboxBytes = await makePdfBytes((doc) => {
    const page = doc.addPage([612, 792]);
    const form = doc.getForm();
    const cb = form.createCheckBox('agree');
    cb.addToPage(page, { x: 50, y: 700, width: 20, height: 20 });
  });
  checkboxPdfPath = await writeTempPdf('checkbox.pdf', checkboxBytes, 'fpdf-exporter-tests');

  const dropdownBytes = await makePdfBytes((doc) => {
    const page = doc.addPage([612, 792]);
    const form = doc.getForm();
    const dd = form.createDropdown('color');
    dd.setOptions(['red', 'green', 'blue']);
    dd.addToPage(page, { x: 50, y: 700, width: 200, height: 20 });
  });
  dropdownPdfPath = await writeTempPdf('dropdown.pdf', dropdownBytes, 'fpdf-exporter-tests');

  const radioBytes = await makePdfBytes((doc) => {
    const page = doc.addPage([612, 792]);
    const form = doc.getForm();
    const rg = form.createRadioGroup('size');
    rg.addOptionToPage('small', page, { x: 50, y: 700, width: 15, height: 15 });
    rg.addOptionToPage('large', page, { x: 50, y: 680, width: 15, height: 15 });
  });
  radioPdfPath = await writeTempPdf('radio.pdf', radioBytes, 'fpdf-exporter-tests');
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

  it('auto-fits font size when text overflows a narrow field', async () => {
    const longValue = 'This is a very long string that will not fit at 12pt';
    const doc = makeDoc([
      {
        name: 'narrow',
        type: 'text',
        value: longValue,
        placement: { x: 50, y: 700, width: 50, height: 14 },
      },
    ]);
    doc.metadata.originalPdf = narrowTextPdfPath;

    const bytes = await exportPdf(narrowTextPdfPath, doc);
    const result = await PDFDocument.load(bytes);
    // Value must still be stored correctly even with a reduced font size.
    expect(result.getForm().getTextField('narrow').getText()).toBe(longValue);
  });

  it('disables scrolling on exported text fields', async () => {
    const doc = makeDoc([{ name: 'firstName', type: 'text', value: 'Alice' }]);
    doc.metadata.originalPdf = textPdfPath;

    const bytes = await exportPdf(textPdfPath, doc);
    const result = await PDFDocument.load(bytes);
    expect(result.getForm().getTextField('firstName').isScrollable()).toBe(false);
  });

  it('preserves scrolling when text overflows even at minimum font size', async () => {
    // 200 'x' chars at 4pt Helvetica (~400pt) far exceeds the 46pt available
    // in the 50pt-wide narrow field. noScrollDisable must skip disableScrolling().
    const overflowValue = 'x'.repeat(200);
    const doc = makeDoc([
      {
        name: 'narrow',
        type: 'text',
        value: overflowValue,
        placement: { x: 50, y: 700, width: 50, height: 14 },
      },
    ]);
    doc.metadata.originalPdf = narrowTextPdfPath;

    const bytes = await exportPdf(narrowTextPdfPath, doc);
    const result = await PDFDocument.load(bytes);
    expect(result.getForm().getTextField('narrow').isScrollable()).toBe(true);
    expect(result.getForm().getTextField('narrow').getText()).toBe(overflowValue);
  });

  it('exports field value when font must shrink below 6pt', async () => {
    // A 30-char value overflows at 6pt in the narrow (50pt) field but fits at
    // a smaller size thanks to MIN_FONT_SIZE being lowered to 4pt. The value
    // must be stored correctly regardless of the chosen font size.
    const value = 'W'.repeat(30);
    const doc = makeDoc([
      {
        name: 'narrow',
        type: 'text',
        value,
        placement: { x: 50, y: 700, width: 50, height: 14 },
      },
    ]);
    doc.metadata.originalPdf = narrowTextPdfPath;

    const bytes = await exportPdf(narrowTextPdfPath, doc);
    const result = await PDFDocument.load(bytes);
    expect(result.getForm().getTextField('narrow').getText()).toBe(value);
  });
});
