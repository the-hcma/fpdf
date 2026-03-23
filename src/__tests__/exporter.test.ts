// integration
import { describe, it, expect, beforeAll } from 'vitest';
import { tmpdir } from 'node:os';
import { writeFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { exportPdf } from '../exporter.js';
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
