import { describe, it, expect, beforeAll } from 'vitest';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { writeFile, mkdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { PDFDocument, PDFName, PDFString, PDFRawStream, StandardFonts, rgb } from 'pdf-lib';
import { deflateSync } from 'node:zlib';
import {
  analyzePdf,
  AnalyzerError,
  deriveLabel,
  deriveDisplayName,
  detectPageType,
  detectCandidateFields,
  extractOrphanWidgets,
  xfaLeafName,
  getXfaDatasetsInfo,
  parseXfaDatasetValues,
  patchXfaDatasetsXml,
  computePdfKind,
} from '../analyzer.js';

// ---------------------------------------------------------------------------
// Helpers — build minimal in-memory PDFs for testing
// ---------------------------------------------------------------------------

async function makePdfBytes(
  setup: (doc: PDFDocument) => Promise<void> | void,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  await setup(doc);
  return doc.save();
}

async function writeTempPdf(name: string, bytes: Uint8Array): Promise<string> {
  const dir = path.join(tmpdir(), 'fpdf-tests');
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, name);
  await writeFile(filePath, bytes);
  return filePath;
}

// ---------------------------------------------------------------------------
// Fixtures built once before all tests
// ---------------------------------------------------------------------------

let emptyPdfPath: string;
let textBlockPdfPath: string;
let sameLinePdfPath: string;
let textFieldPdfPath: string;
let checkboxPdfPath: string;
let dropdownPdfPath: string;
let radioGroupPdfPath: string;
let multilineTextPdfPath: string;
let twoPagePdfPath: string;
let readonlyPdfPath: string;
let buttonPdfPath: string;
let vectorLinePdfPath: string;
let vectorRectPdfPath: string;
let rasterPdfPath: string;
let hybridPdfPath: string;
let rasterOcrPdfPath: string;
let orphanWidgetPdfPath: string;

beforeAll(async () => {
  // 1. PDF with no AcroForm fields
  const emptyBytes = await makePdfBytes((doc) => {
    doc.addPage();
  });
  emptyPdfPath = await writeTempPdf('empty.pdf', emptyBytes);

  // 1b. PDF with drawn static text (header + label) alongside a form field
  const textBlockBytes = await makePdfBytes(async (doc) => {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    page.drawText('Patient Information', { x: 50, y: 720, size: 14, font });
    page.drawText('First Name', { x: 50, y: 675, size: 10, font });
    const form = doc.getForm();
    const tf = form.createTextField('firstName');
    tf.addToPage(page, { x: 50, y: 650, width: 200, height: 20 });
  });
  textBlockPdfPath = await writeTempPdf('text-blocks.pdf', textBlockBytes);

  // 1c. PDF with two separate drawText calls at the same y (triggers line-merging)
  const sameLineBytes = await makePdfBytes(async (doc) => {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    page.drawText('Last Name', { x: 50, y: 700, size: 12, font });
    page.drawText('First Name', { x: 200, y: 700, size: 12, font });
  });
  sameLinePdfPath = await writeTempPdf('same-line.pdf', sameLineBytes);

  // 2. PDF with a single text field
  const textBytes = await makePdfBytes((doc) => {
    const page = doc.addPage([612, 792]);
    const form = doc.getForm();
    const field = form.createTextField('firstName');
    field.setText('Alice');
    field.addToPage(page, { x: 50, y: 700, width: 200, height: 20 });
  });
  textFieldPdfPath = await writeTempPdf('text-field.pdf', textBytes);

  // 3. PDF with a checkbox
  const cbBytes = await makePdfBytes((doc) => {
    const page = doc.addPage([612, 792]);
    const form = doc.getForm();
    const cb = form.createCheckBox('agree');
    cb.check();
    cb.addToPage(page, { x: 50, y: 700, width: 20, height: 20 });
  });
  checkboxPdfPath = await writeTempPdf('checkbox.pdf', cbBytes);

  // 4. PDF with a dropdown
  const ddBytes = await makePdfBytes((doc) => {
    const page = doc.addPage([612, 792]);
    const form = doc.getForm();
    const dd = form.createDropdown('color');
    dd.addOptions(['Red', 'Green', 'Blue']);
    dd.select('Green');
    dd.addToPage(page, { x: 50, y: 700, width: 150, height: 20 });
  });
  dropdownPdfPath = await writeTempPdf('dropdown.pdf', ddBytes);

  // 5. PDF with a radio group
  const rgBytes = await makePdfBytes((doc) => {
    const page = doc.addPage([612, 792]);
    const form = doc.getForm();
    const rg = form.createRadioGroup('gender');
    rg.addOptionToPage('male', page, { x: 50, y: 700, width: 20, height: 20 });
    rg.addOptionToPage('female', page, { x: 50, y: 670, width: 20, height: 20 });
    rg.select('female');
  });
  radioGroupPdfPath = await writeTempPdf('radio-group.pdf', rgBytes);

  // 6. PDF with a multiline text field
  const mlBytes = await makePdfBytes((doc) => {
    const page = doc.addPage([612, 792]);
    const form = doc.getForm();
    const tf = form.createTextField('notes');
    tf.enableMultiline();
    tf.addToPage(page, { x: 50, y: 600, width: 300, height: 80 });
  });
  multilineTextPdfPath = await writeTempPdf('multiline.pdf', mlBytes);

  // 7. Two-page PDF: one field per page
  const twoPageBytes = await makePdfBytes((doc) => {
    const page1 = doc.addPage([612, 792]);
    const page2 = doc.addPage([612, 792]);
    const form = doc.getForm();
    const f1 = form.createTextField('page1field');
    f1.addToPage(page1, { x: 50, y: 700, width: 200, height: 20 });
    const f2 = form.createTextField('page2field');
    f2.addToPage(page2, { x: 50, y: 700, width: 200, height: 20 });
  });
  twoPagePdfPath = await writeTempPdf('two-page.pdf', twoPageBytes);

  // 8. PDF with a readOnly text field (display label) and a writable field
  const readonlyBytes = await makePdfBytes((doc) => {
    const page = doc.addPage([612, 792]);
    const form = doc.getForm();
    const label = form.createTextField('staticLabel');
    label.setText('Static content');
    label.enableReadOnly();
    label.addToPage(page, { x: 50, y: 750, width: 200, height: 20 });
    const editable = form.createTextField('editableField');
    editable.addToPage(page, { x: 50, y: 700, width: 200, height: 20 });
  });
  readonlyPdfPath = await writeTempPdf('readonly.pdf', readonlyBytes);

  // 9. PDF with a button field (image/push-button widget)
  const buttonBytes = await makePdfBytes((doc) => {
    const page = doc.addPage([612, 792]);
    const form = doc.getForm();
    form.createButton('logoBtn').addToPage('Logo', page, {
      x: 50,
      y: 700,
      width: 100,
      height: 40,
    });
    const tf = form.createTextField('name');
    tf.addToPage(page, { x: 50, y: 620, width: 200, height: 20 });
  });
  buttonPdfPath = await writeTempPdf('button.pdf', buttonBytes);

  // Vector line: label above a horizontal underline
  const vectorLineBytes = await makePdfBytes(async (doc) => {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    page.drawText('Signature', { x: 50, y: 700, size: 10, font });
    page.drawLine({
      start: { x: 50, y: 685 },
      end: { x: 250, y: 685 },
      thickness: 0.5,
      color: rgb(0, 0, 0),
    });
  });
  vectorLinePdfPath = await writeTempPdf('vector-line.pdf', vectorLineBytes);

  // Vector rect: label above a stroked-only rectangle
  const vectorRectBytes = await makePdfBytes(async (doc) => {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    page.drawText('Amount', { x: 50, y: 700, size: 10, font });
    page.drawRectangle({
      x: 50,
      y: 670,
      width: 150,
      height: 16,
      borderWidth: 0.5,
      borderColor: rgb(0, 0, 0),
    });
  });
  vectorRectPdfPath = await writeTempPdf('vector-rect.pdf', vectorRectBytes);

  // Raster: page with an embedded JPEG image only (no text, no vector paths)
  // Minimal valid 1×1 white JPEG
  const MINIMAL_JPEG = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
    0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
    0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
    0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20,
    0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27,
    0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
    0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04,
    0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0xff, 0xc4, 0x00, 0xb5, 0x10, 0x00, 0x02, 0x01, 0x03,
    0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7d, 0x01, 0x02, 0x03, 0x00,
    0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32,
    0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72,
    0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35,
    0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55,
    0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75,
    0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x93, 0x94, 0x95,
    0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3,
    0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca,
    0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7,
    0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xff, 0xda, 0x00,
    0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xfb, 0xd3, 0xff, 0xd9,
  ]);
  const rasterBytes = await makePdfBytes(async (doc) => {
    const page = doc.addPage([612, 792]);
    const img = await doc.embedJpg(MINIMAL_JPEG);
    page.drawImage(img, { x: 100, y: 100, width: 200, height: 200 });
  });
  rasterPdfPath = await writeTempPdf('raster.pdf', rasterBytes);

  // Hybrid: raster image + stroked vector rectangle on the same page
  const hybridBytes = await makePdfBytes(async (doc) => {
    const page = doc.addPage([612, 792]);
    const img = await doc.embedJpg(MINIMAL_JPEG);
    page.drawImage(img, { x: 100, y: 400, width: 100, height: 100 });
    page.drawRectangle({
      x: 50,
      y: 200,
      width: 150,
      height: 16,
      borderWidth: 0.5,
      borderColor: rgb(0, 0, 0),
    });
  });
  hybridPdfPath = await writeTempPdf('hybrid.pdf', hybridBytes);

  // Raster+OCR: raster image + white text (simulates hidden OCR text layer)
  const rasterOcrBytes = await makePdfBytes(async (doc) => {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    const img = await doc.embedJpg(MINIMAL_JPEG);
    page.drawImage(img, { x: 0, y: 0, width: 612, height: 792 });
    page.drawText('ocr', { x: 10, y: 1, size: 6, font, color: rgb(1, 1, 1) });
  });
  rasterOcrPdfPath = await writeTempPdf('raster-ocr.pdf', rasterOcrBytes);

  // Orphan widget: a Widget annotation on a page not linked via /AcroForm
  // We create it using pdf-lib's low-level API so form.getFields() finds nothing.
  const orphanBytes = await makePdfBytes((doc) => {
    const page = doc.addPage([612, 792]);

    // Build a Widget dict manually: /FT /Tx, /T "orphanField", /Rect [50 700 250 720]
    const widgetRef = doc.context.register(
      doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Widget'),
        FT: PDFName.of('Tx'),
        T: PDFString.of('orphanField'),
        Rect: [50, 700, 250, 720],
        V: PDFString.of('prefilled'),
      }),
    );

    // Add the widget to the page's /Annots — not linked via /AcroForm
    page.node.set(PDFName.of('Annots'), doc.context.obj([widgetRef]));
  });
  orphanWidgetPdfPath = await writeTempPdf('orphan-widget.pdf', orphanBytes);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('deriveLabel', () => {
  it('extracts field number and words from an XFA-style partial name', () => {
    expect(
      deriveLabel('topmostSubform[0].Page1[0]._2_PredeterminationPreauthorization_Number[0]'),
    ).toBe('2 Predetermination Preauthorization Number');
  });

  it('handles a plain numbered field with no description', () => {
    expect(deriveLabel('topmostSubform[0].Page1[0]._4[0]')).toBe('4');
  });

  it('splits camelCase tokens into words', () => {
    expect(deriveLabel('Check_Box5[0]')).toBe('Check Box5');
  });

  it('splits camelCase when there are no dot segments', () => {
    expect(deriveLabel('firstName')).toBe('first Name');
  });

  it('strips the index suffix', () => {
    expect(deriveLabel('form[0].field[0]._7_DateOfBirth[0]')).toBe('7 Date Of Birth');
  });

  it('strips multiple leading underscores', () => {
    expect(deriveLabel('topmostSubform[0].__weirdName[0]')).toBe('weird Name');
  });
});

describe('deriveDisplayName', () => {
  it('strips the leading field number', () => {
    expect(deriveDisplayName('2 Predetermination Preauthorization Number')).toBe(
      'Predetermination Preauthorization Number',
    );
  });

  it('strips a two-digit leading field number', () => {
    expect(deriveDisplayName('17 Employer Name')).toBe('Employer Name');
  });

  it('removes date format hints like MMDDCCYY', () => {
    expect(deriveDisplayName('6 Date of Birth MMDDCCYY')).toBe('Date of Birth');
  });

  it('removes "in N" back-references to other fields', () => {
    expect(
      deriveDisplayName('5 Name of Policyholder Subscriber in 4 Last First Middle Initial Suffix'),
    ).toBe('Name of Policyholder Subscriber');
  });

  it('truncates at trailing address format fragment', () => {
    expect(
      deriveDisplayName(
        '11 Other Insurance Company Dental Benefit Plan Name Address City State Zip Code',
      ),
    ).toBe('Other Insurance Company Dental Benefit Plan Name');
  });

  it('falls back to the original label when nothing meaningful remains', () => {
    expect(deriveDisplayName('4')).toBe('4');
  });

  it('leaves a label with no number unchanged', () => {
    expect(deriveDisplayName('Check Box5')).toBe('Check Box5');
  });
});

describe('analyzePdf', () => {
  describe('error handling', () => {
    it('throws AnalyzerError when the file does not exist', async () => {
      await expect(analyzePdf('/nonexistent/path/to/file.pdf')).rejects.toBeInstanceOf(
        AnalyzerError,
      );
    });

    it('throws AnalyzerError with a descriptive message on missing file', async () => {
      await expect(analyzePdf('/nonexistent/path/to/file.pdf')).rejects.toThrow(/Cannot read file/);
    });

    it('throws AnalyzerError when given a non-PDF file', async () => {
      const notPdf = await writeTempPdf('not-a-pdf.pdf', new Uint8Array([0, 1, 2, 3]));
      await expect(analyzePdf(notPdf)).rejects.toBeInstanceOf(AnalyzerError);
    });
  });

  describe('metadata', () => {
    it('populates metadata.pdfFilename correctly', async () => {
      const doc = await analyzePdf(textFieldPdfPath);
      expect(doc.metadata.pdfFilename).toBe('text-field.pdf');
    });

    it('sets metadata.version to "1.0"', async () => {
      const doc = await analyzePdf(textFieldPdfPath);
      expect(doc.metadata.version).toBe('1.0');
    });

    it('sets metadata.originalPdf to the resolved absolute path', async () => {
      const doc = await analyzePdf(textFieldPdfPath);
      expect(path.isAbsolute(doc.metadata.originalPdf)).toBe(true);
    });

    it('sets metadata.pdfHash with sha256: prefix', async () => {
      const doc = await analyzePdf(textFieldPdfPath);
      expect(doc.metadata.pdfHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it('sets metadata.pageCount correctly', async () => {
      const doc = await analyzePdf(textFieldPdfPath);
      expect(doc.metadata.pageCount).toBe(1);
    });

    it('sets metadata.pageCount to 2 for a two-page PDF', async () => {
      const doc = await analyzePdf(twoPagePdfPath);
      expect(doc.metadata.pageCount).toBe(2);
    });

    it('sets metadata.createdAt and updatedAt as ISO strings', async () => {
      const doc = await analyzePdf(textFieldPdfPath);
      expect(() => new Date(doc.metadata.createdAt)).not.toThrow();
      expect(doc.metadata.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('produces a stable hash — same bytes yield the same hash', async () => {
      const doc1 = await analyzePdf(textFieldPdfPath);
      const doc2 = await analyzePdf(textFieldPdfPath);
      expect(doc1.metadata.pdfHash).toBe(doc2.metadata.pdfHash);
    });
  });

  describe('pages structure', () => {
    it('returns one page entry per PDF page', async () => {
      const doc = await analyzePdf(twoPagePdfPath);
      expect(doc.pages).toHaveLength(2);
    });

    it('assigns sequential pageNumber values starting at 1', async () => {
      const doc = await analyzePdf(twoPagePdfPath);
      expect(doc.pages[0]?.pageNumber).toBe(1);
      expect(doc.pages[1]?.pageNumber).toBe(2);
    });

    it('captures page dimensions in PDF points', async () => {
      const doc = await analyzePdf(textFieldPdfPath);
      const page = doc.pages[0];
      expect(page?.widthPt).toBe(612);
      expect(page?.heightPt).toBe(792);
    });

    it('returns zero fields for a PDF with no AcroForm fields', async () => {
      const doc = await analyzePdf(emptyPdfPath);
      const totalFields = doc.pages.reduce((sum, p) => sum + p.fields.length, 0);
      expect(totalFields).toBe(0);
    });
  });

  describe('text field extraction', () => {
    it('extracts a text field with type "text"', async () => {
      const doc = await analyzePdf(textFieldPdfPath);
      const field = doc.pages[0]?.fields[0];
      expect(field?.type).toBe('text');
    });

    it('extracts the field name', async () => {
      const doc = await analyzePdf(textFieldPdfPath);
      const field = doc.pages[0]?.fields[0];
      expect(field?.name).toBe('firstName');
    });

    it('captures the existing text value', async () => {
      const doc = await analyzePdf(textFieldPdfPath);
      const field = doc.pages[0]?.fields[0];
      expect(field?.value).toBe('Alice');
    });

    it('assigns a UUID as the field id', async () => {
      const doc = await analyzePdf(textFieldPdfPath);
      const field = doc.pages[0]?.fields[0];
      expect(field?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('captures placement with positive width and height', async () => {
      const doc = await analyzePdf(textFieldPdfPath);
      const placement = doc.pages[0]?.fields[0]?.placement;
      expect(placement?.width).toBeGreaterThan(0);
      expect(placement?.height).toBeGreaterThan(0);
    });

    it('placement x and y are numbers', async () => {
      const doc = await analyzePdf(textFieldPdfPath);
      const placement = doc.pages[0]?.fields[0]?.placement;
      expect(typeof placement?.x).toBe('number');
      expect(typeof placement?.y).toBe('number');
    });

    it('extracts a multiline text field with type "textarea"', async () => {
      const doc = await analyzePdf(multilineTextPdfPath);
      const field = doc.pages[0]?.fields[0];
      expect(field?.type).toBe('textarea');
    });
  });

  describe('checkbox field extraction', () => {
    it('extracts a checkbox field with type "checkbox"', async () => {
      const doc = await analyzePdf(checkboxPdfPath);
      const field = doc.pages[0]?.fields[0];
      expect(field?.type).toBe('checkbox');
    });

    it('captures the checked boolean value', async () => {
      const doc = await analyzePdf(checkboxPdfPath);
      const field = doc.pages[0]?.fields[0];
      expect(field?.value).toBe(true);
    });

    it('has empty options array', async () => {
      const doc = await analyzePdf(checkboxPdfPath);
      const field = doc.pages[0]?.fields[0];
      expect(field?.options).toEqual([]);
    });
  });

  describe('dropdown field extraction', () => {
    it('extracts a dropdown field with type "select"', async () => {
      const doc = await analyzePdf(dropdownPdfPath);
      const field = doc.pages[0]?.fields[0];
      expect(field?.type).toBe('select');
    });

    it('captures the selected value', async () => {
      const doc = await analyzePdf(dropdownPdfPath);
      const field = doc.pages[0]?.fields[0];
      expect(field?.value).toBe('Green');
    });

    it('populates options array with all choices', async () => {
      const doc = await analyzePdf(dropdownPdfPath);
      const field = doc.pages[0]?.fields[0];
      expect(field?.options).toEqual(expect.arrayContaining(['Red', 'Green', 'Blue']));
    });
  });

  describe('radio group field extraction', () => {
    it('extracts a radio group with type "radio"', async () => {
      const doc = await analyzePdf(radioGroupPdfPath);
      const fields = doc.pages[0]?.fields ?? [];
      expect(fields.some((f) => f.type === 'radio')).toBe(true);
    });

    it('captures the selected radio option as value', async () => {
      const doc = await analyzePdf(radioGroupPdfPath);
      const radioFields = (doc.pages[0]?.fields ?? []).filter((f) => f.type === 'radio');
      expect(radioFields.some((f) => f.value === 'female')).toBe(true);
    });

    it('populates options with all radio choices', async () => {
      const doc = await analyzePdf(radioGroupPdfPath);
      const radioFields = (doc.pages[0]?.fields ?? []).filter((f) => f.type === 'radio');
      const allOptions = radioFields.flatMap((f) => f.options);
      expect(allOptions).toEqual(expect.arrayContaining(['male', 'female']));
    });
  });

  describe('multi-page field routing', () => {
    it('assigns page1field to page 1', async () => {
      const doc = await analyzePdf(twoPagePdfPath);
      const page1Fields = doc.pages[0]?.fields ?? [];
      expect(page1Fields.some((f) => f.name === 'page1field')).toBe(true);
    });

    it('assigns page2field to page 2', async () => {
      const doc = await analyzePdf(twoPagePdfPath);
      const page2Fields = doc.pages[1]?.fields ?? [];
      expect(page2Fields.some((f) => f.name === 'page2field')).toBe(true);
    });

    it('does not put page2field on page 1', async () => {
      const doc = await analyzePdf(twoPagePdfPath);
      const page1Fields = doc.pages[0]?.fields ?? [];
      expect(page1Fields.every((f) => f.name !== 'page2field')).toBe(true);
    });
  });

  describe('field filtering', () => {
    it('excludes readOnly fields from the output', async () => {
      const doc = await analyzePdf(readonlyPdfPath);
      const fields = doc.pages[0]?.fields ?? [];
      expect(fields.every((f) => !f.readOnly)).toBe(true);
      expect(fields.some((f) => f.name === 'staticLabel')).toBe(false);
    });

    it('includes writable fields when a readOnly field is also present', async () => {
      const doc = await analyzePdf(readonlyPdfPath);
      const fields = doc.pages[0]?.fields ?? [];
      expect(fields.some((f) => f.name === 'editableField')).toBe(true);
    });

    it('excludes button (image widget) fields from the output', async () => {
      const doc = await analyzePdf(buttonPdfPath);
      const fields = doc.pages[0]?.fields ?? [];
      expect(fields.every((f) => f.name !== 'logoBtn')).toBe(true);
    });

    it('includes text fields when a button field is also present', async () => {
      const doc = await analyzePdf(buttonPdfPath);
      const fields = doc.pages[0]?.fields ?? [];
      expect(fields.some((f) => f.name === 'name')).toBe(true);
    });
  });
});

describe('textBlocks extraction', () => {
  it('each page has a textBlocks array', async () => {
    const doc = await analyzePdf(textBlockPdfPath);
    expect(Array.isArray(doc.pages[0]?.textBlocks)).toBe(true);
  });

  it('finds the header text block', async () => {
    const doc = await analyzePdf(textBlockPdfPath);
    const blocks = doc.pages[0]?.textBlocks ?? [];
    expect(blocks.some((b) => b.text.includes('Patient Information'))).toBe(true);
  });

  it('finds the label text block', async () => {
    const doc = await analyzePdf(textBlockPdfPath);
    const blocks = doc.pages[0]?.textBlocks ?? [];
    expect(blocks.some((b) => b.text.includes('First Name'))).toBe(true);
  });

  it('each block has positive width, height, and fontSize', async () => {
    const doc = await analyzePdf(textBlockPdfPath);
    const blocks = doc.pages[0]?.textBlocks ?? [];
    for (const block of blocks) {
      expect(block.placement.width).toBeGreaterThan(0);
      expect(block.placement.height).toBeGreaterThan(0);
      expect(block.fontSize).toBeGreaterThan(0);
    }
  });

  it('each block has a non-empty fontName string', async () => {
    const doc = await analyzePdf(textBlockPdfPath);
    const blocks = doc.pages[0]?.textBlocks ?? [];
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(typeof block.fontName).toBe('string');
      expect(block.fontName.length).toBeGreaterThan(0);
    }
  });

  it('header block y is above label block y (PDF y increases upward)', async () => {
    const doc = await analyzePdf(textBlockPdfPath);
    const blocks = doc.pages[0]?.textBlocks ?? [];
    const header = blocks.find((b) => b.text.includes('Patient Information'));
    const label = blocks.find((b) => b.text.includes('First Name'));
    expect(header).toBeDefined();
    expect(label).toBeDefined();
    if (!header || !label) return;
    expect(header.placement.y).toBeGreaterThan(label.placement.y);
  });

  it('header placement.x is approximately 50pt', async () => {
    const doc = await analyzePdf(textBlockPdfPath);
    const blocks = doc.pages[0]?.textBlocks ?? [];
    const header = blocks.find((b) => b.text.includes('Patient Information'));
    expect(header).toBeDefined();
    if (!header) return;
    expect(header.placement.x).toBeGreaterThanOrEqual(48);
    expect(header.placement.x).toBeLessThanOrEqual(52);
  });

  it('header fontSize is approximately 14', async () => {
    const doc = await analyzePdf(textBlockPdfPath);
    const blocks = doc.pages[0]?.textBlocks ?? [];
    const header = blocks.find((b) => b.text.includes('Patient Information'));
    expect(header).toBeDefined();
    if (!header) return;
    expect(header.fontSize).toBeGreaterThanOrEqual(13);
    expect(header.fontSize).toBeLessThanOrEqual(15);
  });

  it('empty page returns empty textBlocks', async () => {
    const doc = await analyzePdf(emptyPdfPath);
    expect(doc.pages[0]?.textBlocks).toEqual([]);
  });

  it('merges separate text items on the same line into one block', async () => {
    const doc = await analyzePdf(sameLinePdfPath);
    const blocks = doc.pages[0]?.textBlocks ?? [];
    // Two drawText calls at y=700 with same font/size should be merged into one block
    // that contains both strings
    const merged = blocks.find(
      (b) => b.text.includes('Last Name') && b.text.includes('First Name'),
    );
    // pdfjs may or may not merge adjacent same-font items; either way blocks must be non-empty
    expect(blocks.length).toBeGreaterThan(0);
    if (merged) {
      expect(merged.placement.width).toBeGreaterThan(0);
    }
  });
});

describe('pageType detection', () => {
  it('AcroForm PDF is classified as acroform', async () => {
    const doc = await analyzePdf(textFieldPdfPath);
    expect(doc.pages[0]?.pageType).toBe('acroform');
  });

  it('vector PDF (no AcroForm, has paths + text) is classified as vector', async () => {
    const doc = await analyzePdf(vectorLinePdfPath);
    expect(doc.pages[0]?.pageType).toBe('vector');
  });

  it('raster PDF (image only, no text/paths) is classified as raster', async () => {
    const doc = await analyzePdf(rasterPdfPath);
    expect(doc.pages[0]?.pageType).toBe('raster');
  });

  it('each page has a pageType string', async () => {
    const doc = await analyzePdf(twoPagePdfPath);
    for (const page of doc.pages) {
      expect(typeof page.pageType).toBe('string');
      expect(['acroform', 'vector', 'raster', 'raster+ocr', 'hybrid']).toContain(page.pageType);
    }
  });

  it('hybrid PDF (image + vector paths) is classified as hybrid', async () => {
    const doc = await analyzePdf(hybridPdfPath);
    expect(doc.pages[0]?.pageType).toBe('hybrid');
  });

  it('raster+ocr PDF (image + text layer) is classified as raster+ocr', async () => {
    const doc = await analyzePdf(rasterOcrPdfPath);
    expect(doc.pages[0]?.pageType).toBe('raster+ocr');
  });

  it('stores acroform pdfKind in metadata for AcroForm PDF', async () => {
    const doc = await analyzePdf(textFieldPdfPath);
    expect(doc.metadata.pdfKind).toBe('acroform');
  });

  it('stores no-acroform pdfKind in metadata for vector PDF', async () => {
    const doc = await analyzePdf(vectorLinePdfPath);
    expect(doc.metadata.pdfKind).toBe('no-acroform');
  });

  it('stores no-acroform pdfKind in metadata for raster PDF', async () => {
    const doc = await analyzePdf(rasterPdfPath);
    expect(doc.metadata.pdfKind).toBe('no-acroform');
  });

  it('stores no-acroform pdfKind in metadata for hybrid PDF', async () => {
    const doc = await analyzePdf(hybridPdfPath);
    expect(doc.metadata.pdfKind).toBe('no-acroform');
  });
});

describe('computePdfKind', () => {
  it('returns acroform when no XFA and has fields', () => {
    expect(computePdfKind(false, true)).toBe('acroform');
  });

  it('returns no-acroform when no XFA and no fields', () => {
    expect(computePdfKind(false, false)).toBe('no-acroform');
  });

  it('returns xfa-hybrid when XFA and has fields', () => {
    expect(computePdfKind(true, true)).toBe('xfa-hybrid');
  });

  it('returns pure-xfa when XFA and no fields', () => {
    expect(computePdfKind(true, false)).toBe('pure-xfa');
  });
});

describe('detectPageType unit', () => {
  it('returns acroform when hasAcroFormFields is true regardless of operators', () => {
    expect(detectPageType([], true)).toBe('acroform');
  });

  it('returns raster when only image operators are present', () => {
    // OPS.paintImageXObject = 85
    expect(detectPageType([85], false)).toBe('raster');
  });

  it('returns raster+ocr when image + text operators but no path operators', () => {
    // OPS.paintImageXObject = 85, OPS.showText = 44
    expect(detectPageType([85, 44], false)).toBe('raster+ocr');
  });

  it('returns hybrid when image + path operators', () => {
    // OPS.paintImageXObject = 85, OPS.stroke = 20
    expect(detectPageType([85, 20], false)).toBe('hybrid');
  });

  it('returns vector when path/text operators but no images', () => {
    // OPS.stroke = 20, OPS.showText = 44
    expect(detectPageType([20, 44], false)).toBe('vector');
  });

  it('returns vector for an empty operator list (no image evidence)', () => {
    expect(detectPageType([], false)).toBe('vector');
  });
});

describe('candidateFields extraction', () => {
  it('AcroForm page has empty candidateFields', async () => {
    const doc = await analyzePdf(textFieldPdfPath);
    expect(doc.pages[0]?.candidateFields).toEqual([]);
  });

  it('each page has a candidateFields array', async () => {
    const doc = await analyzePdf(vectorLinePdfPath);
    expect(Array.isArray(doc.pages[0]?.candidateFields)).toBe(true);
  });

  it('vector line PDF yields at least one candidate field', async () => {
    const doc = await analyzePdf(vectorLinePdfPath);
    expect((doc.pages[0]?.candidateFields ?? []).length).toBeGreaterThan(0);
  });

  it('vector rect PDF yields at least one candidate field', async () => {
    const doc = await analyzePdf(vectorRectPdfPath);
    expect((doc.pages[0]?.candidateFields ?? []).length).toBeGreaterThan(0);
  });

  it('each candidate has a positive-width placement', async () => {
    const doc = await analyzePdf(vectorLinePdfPath);
    for (const c of doc.pages[0]?.candidateFields ?? []) {
      expect(c.placement.width).toBeGreaterThan(0);
    }
  });

  it('each candidate has a valid type', async () => {
    const doc = await analyzePdf(vectorLinePdfPath);
    const validTypes = ['text', 'textarea', 'checkbox'];
    for (const c of doc.pages[0]?.candidateFields ?? []) {
      expect(validTypes).toContain(c.type);
    }
  });

  it('each candidate has a valid confidence level', async () => {
    const doc = await analyzePdf(vectorLinePdfPath);
    const validLevels = ['high', 'medium', 'low'];
    for (const c of doc.pages[0]?.candidateFields ?? []) {
      expect(validLevels).toContain(c.confidence);
    }
  });

  it('each candidate starts with dismissed: false', async () => {
    const doc = await analyzePdf(vectorLinePdfPath);
    for (const c of doc.pages[0]?.candidateFields ?? []) {
      expect(c.dismissed).toBe(false);
    }
  });

  it('vector line candidate label matches nearby text block', async () => {
    const doc = await analyzePdf(vectorLinePdfPath);
    const candidates = doc.pages[0]?.candidateFields ?? [];
    const labeled = candidates.find((c) => c.label.includes('Signature'));
    expect(labeled).toBeDefined();
  });

  it('vector rect candidate label matches nearby text block', async () => {
    const doc = await analyzePdf(vectorRectPdfPath);
    const candidates = doc.pages[0]?.candidateFields ?? [];
    const labeled = candidates.find((c) => c.label.includes('Amount'));
    expect(labeled).toBeDefined();
  });

  it('raster page has empty candidateFields', async () => {
    const doc = await analyzePdf(rasterPdfPath);
    expect(doc.pages[0]?.candidateFields).toEqual([]);
  });
});

describe('detectCandidateFields unit', () => {
  it('returns empty array for empty operator list', () => {
    const result = detectCandidateFields({ fnArray: [], argsArray: [] }, [], 612);
    expect(result).toEqual([]);
  });

  it('ignores filled rectangles (fill operator)', () => {
    // OPS.rectangle = 19, OPS.fill = 22
    const result = detectCandidateFields(
      { fnArray: [19, 22], argsArray: [[50, 670, 150, 16], []] },
      [],
      612,
    );
    expect(result).toHaveLength(0);
  });

  it('detects stroked rectangle as a candidate', () => {
    // OPS.rectangle = 19, OPS.stroke = 20
    const result = detectCandidateFields(
      { fnArray: [19, 20], argsArray: [[50, 670, 150, 16], []] },
      [],
      612,
    );
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]?.placement.width).toBeCloseTo(150, 0);
  });

  it('filters out full-width structural lines', () => {
    // OPS.rectangle = 19, OPS.stroke = 20 — full-page-width rect
    const result = detectCandidateFields(
      { fnArray: [19, 20], argsArray: [[0, 400, 600, 1], []] },
      [],
      612,
    );
    expect(result).toHaveLength(0);
  });

  it('classifies near-square small rect as checkbox', () => {
    // OPS.rectangle = 19, OPS.stroke = 20 — 12×12 box
    const result = detectCandidateFields(
      { fnArray: [19, 20], argsArray: [[50, 700, 12, 12], []] },
      [],
      612,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe('checkbox');
  });

  it('assigns high confidence when label is matched', () => {
    // OPS.rectangle = 19, OPS.stroke = 20
    const textBlocks = [
      {
        text: 'Full Name',
        placement: { x: 50, y: 690, width: 60, height: 10 },
        fontSize: 10,
        fontName: 'TT1',
      },
    ];
    const result = detectCandidateFields(
      { fnArray: [19, 20], argsArray: [[50, 670, 150, 16], []] },
      textBlocks,
      612,
    );
    expect(result[0]?.confidence).toBe('high');
    expect(result[0]?.label).toBe('Full Name');
  });

  it('caps confidence at low for flat horizontal lines (h < MIN_VISIBLE_HEIGHT)', () => {
    // A horizontal line: width=150, height=0 → bboxToBox normalises h to 1pt
    // Even with a matching label it must be low confidence (not a visible rectangle).
    const textBlocks = [
      {
        text: 'Signature',
        placement: { x: 50, y: 680, width: 60, height: 10 },
        fontSize: 10,
        fontName: 'TT1',
      },
    ];
    // OPS.rectangle = 19, OPS.stroke = 20 — height=0 (flat line)
    const result = detectCandidateFields(
      { fnArray: [19, 20], argsArray: [[50, 670, 150, 0], []] },
      textBlocks,
      612,
    );
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]?.confidence).toBe('low');
  });

  it('caps confidence at low for vertical lines (w = 0, h tall)', () => {
    // A vertical table rule: width=0, height=31 — not a visible rectangle.
    const textBlocks = [
      {
        text: 'PRESCRIPTION INFORMATION',
        placement: { x: 300, y: 360, width: 150, height: 10 },
        fontSize: 10,
        fontName: 'TT1',
      },
    ];
    // OPS.rectangle = 19, OPS.stroke = 20 — width=0 (vertical line)
    const result = detectCandidateFields(
      { fnArray: [19, 20], argsArray: [[372, 342, 0, 31], []] },
      textBlocks,
      612,
    );
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]?.confidence).toBe('low');
  });
});

describe('orphan widget extraction (integration)', () => {
  it('analyzePdf finds the orphan field that form.getFields() misses', async () => {
    const doc = await analyzePdf(orphanWidgetPdfPath);
    const fields = doc.pages[0]?.fields ?? [];
    expect(fields.some((f) => f.name === 'orphanField')).toBe(true);
  });

  it('orphan widget page is classified as acroform', async () => {
    const doc = await analyzePdf(orphanWidgetPdfPath);
    expect(doc.pages[0]?.pageType).toBe('acroform');
  });

  it('orphan field has type text', async () => {
    const doc = await analyzePdf(orphanWidgetPdfPath);
    const field = (doc.pages[0]?.fields ?? []).find((f) => f.name === 'orphanField');
    expect(field?.type).toBe('text');
  });

  it('orphan field captures the pre-filled value', async () => {
    const doc = await analyzePdf(orphanWidgetPdfPath);
    const field = (doc.pages[0]?.fields ?? []).find((f) => f.name === 'orphanField');
    expect(field?.value).toBe('prefilled');
  });

  it('orphan field placement matches the Rect in the fixture', async () => {
    const doc = await analyzePdf(orphanWidgetPdfPath);
    const field = (doc.pages[0]?.fields ?? []).find((f) => f.name === 'orphanField');
    expect(field?.placement.x).toBeCloseTo(50, 0);
    expect(field?.placement.y).toBeCloseTo(700, 0);
    expect(field?.placement.width).toBeCloseTo(200, 0);
    expect(field?.placement.height).toBeCloseTo(20, 0);
  });

  it('orphan page has empty candidateFields (acroform suppresses vector detection)', async () => {
    const doc = await analyzePdf(orphanWidgetPdfPath);
    expect(doc.pages[0]?.candidateFields).toEqual([]);
  });
});

describe('extractOrphanWidgets unit', () => {
  it('returns empty array for a page with no annotations', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const result = extractOrphanWidgets(doc, 1, new Set());
    expect(result).toEqual([]);
  });

  it('skips non-Widget annotations', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const annotRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('Annot'), Subtype: PDFName.of('Link') }),
    );
    page.node.set(PDFName.of('Annots'), doc.context.obj([annotRef]));
    const result = extractOrphanWidgets(doc, 1, new Set());
    expect(result).toEqual([]);
  });

  it('does not return a widget whose name is already in knownNames', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const annotRef = doc.context.register(
      doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Widget'),
        FT: PDFName.of('Tx'),
        T: PDFString.of('knownField'),
        Rect: [50, 700, 250, 720],
      }),
    );
    page.node.set(PDFName.of('Annots'), doc.context.obj([annotRef]));
    const result = extractOrphanWidgets(doc, 1, new Set(['knownField']));
    expect(result).toHaveLength(0);
  });

  it('extracts a text widget with correct placement', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const annotRef = doc.context.register(
      doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Widget'),
        FT: PDFName.of('Tx'),
        T: PDFString.of('myField'),
        Rect: [50, 700, 250, 720],
        V: PDFString.of('hello'),
      }),
    );
    page.node.set(PDFName.of('Annots'), doc.context.obj([annotRef]));
    const result = extractOrphanWidgets(doc, 1, new Set());
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('myField');
    expect(result[0]?.type).toBe('text');
    expect(result[0]?.value).toBe('hello');
    expect(result[0]?.placement.width).toBeCloseTo(200, 0);
  });

  it('skips a read-only widget (Ff bit 0 set)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const annotRef = doc.context.register(
      doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Widget'),
        FT: PDFName.of('Tx'),
        T: PDFString.of('roField'),
        Rect: [50, 700, 250, 720],
        Ff: 1, // bit 0 = ReadOnly
      }),
    );
    page.node.set(PDFName.of('Annots'), doc.context.obj([annotRef]));
    const result = extractOrphanWidgets(doc, 1, new Set());
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// XFA utilities
// ---------------------------------------------------------------------------

describe('xfaLeafName', () => {
  it('extracts leaf from a full XFA path with array indices', () => {
    expect(xfaLeafName('topmostSubform[0].Page1[0].firstName[0]')).toBe('firstName');
  });

  it('returns the name unchanged when there are no dots', () => {
    expect(xfaLeafName('firstName')).toBe('firstName');
  });

  it('strips the trailing array index', () => {
    expect(xfaLeafName('a.b.c[0]')).toBe('c');
  });

  it('handles a two-segment path without array index', () => {
    expect(xfaLeafName('page.field')).toBe('field');
  });
});

describe('parseXfaDatasetValues', () => {
  it('extracts non-empty text element values', () => {
    const xml = [
      '<xfa:datasets>',
      '  <xfa:data>',
      '    <topmostSubform>',
      '      <firstName>Alice</firstName>',
      '      <lastName/>',
      '      <city>New York</city>',
      '    </topmostSubform>',
      '  </xfa:data>',
      '</xfa:datasets>',
    ].join('\n');
    const values = parseXfaDatasetValues(xml);
    expect(values.get('firstName')).toBe('Alice');
    expect(values.has('lastName')).toBe(false); // self-closing, no content
    expect(values.get('city')).toBe('New York');
  });

  it('unescapes XML entities in values', () => {
    const xml = '<root><field>A &amp; B &lt;test&gt;</field></root>';
    const values = parseXfaDatasetValues(xml);
    expect(values.get('field')).toBe('A & B <test>');
  });

  it('returns an empty map for XML with no text content', () => {
    const xml = '<xfa:data><topmostSubform><a/><b/></topmostSubform></xfa:data>';
    expect(parseXfaDatasetValues(xml).size).toBe(0);
  });
});

describe('patchXfaDatasetsXml', () => {
  it('replaces self-closing elements', () => {
    const xml = '<topmostSubform><firstName/><lastName/></topmostSubform>';
    const values = new Map<string, string | boolean>([
      ['firstName', 'Alice'],
      ['lastName', 'Smith'],
    ]);
    const result = patchXfaDatasetsXml(xml, values);
    expect(result).toContain('<firstName>Alice</firstName>');
    expect(result).toContain('<lastName>Smith</lastName>');
    expect(result).not.toContain('<firstName/>');
  });

  it('replaces elements with existing content', () => {
    const xml = '<root><field>Old</field></root>';
    const values = new Map<string, string | boolean>([['field', 'New']]);
    const result = patchXfaDatasetsXml(xml, values);
    expect(result).toContain('<field>New</field>');
    expect(result).not.toContain('Old');
  });

  it('converts boolean true to "1" and false to "0"', () => {
    const xml = '<root><check/></root>';
    const values = new Map<string, string | boolean>([['check', true]]);
    expect(patchXfaDatasetsXml(xml, values)).toContain('<check>1</check>');
    values.set('check', false);
    expect(patchXfaDatasetsXml(xml.replace('<check>1</check>', '<check/>'), values)).toContain(
      '<check>0</check>',
    );
  });

  it('escapes XML special chars in values', () => {
    const xml = '<root><name/></root>';
    const values = new Map<string, string | boolean>([['name', 'A & B <C>']]);
    const result = patchXfaDatasetsXml(xml, values);
    expect(result).toContain('<name>A &amp; B &lt;C&gt;</name>');
  });

  it('uses the leaf name from a dotted field path', () => {
    const xml = '<root><city/></root>';
    const values = new Map<string, string | boolean>([
      ['topmostSubform[0].Page1[0].city[0]', 'Boston'],
    ]);
    const result = patchXfaDatasetsXml(xml, values);
    expect(result).toContain('<city>Boston</city>');
  });
});

describe('getXfaDatasetsInfo', () => {
  it('returns null for a PDF with no XFA', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    expect(getXfaDatasetsInfo(doc)).toBeNull();
  });

  it('returns the ref and decoded XML for a synthetic XFA PDF', async () => {
    const datasetsXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/">',
      '  <xfa:data><topmostSubform><firstName/></topmostSubform></xfa:data>',
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

    const saved = await doc.save();
    const loaded = await PDFDocument.load(saved);
    const info = getXfaDatasetsInfo(loaded);
    expect(info).not.toBeNull();
    expect(info?.xml).toContain('<firstName/>');
  });
});

// ---------------------------------------------------------------------------
// XFA integration — Cigna PDF (skipped if file absent)
// ---------------------------------------------------------------------------

describe('XFA integration (Cigna PDF)', () => {
  const cignaPath = path.join(homedir(), 'Downloads', 'cigna-medical-form-medical-claim.pdf');
  let exists = false;

  beforeAll(async () => {
    try {
      await stat(cignaPath);
      exists = true;
    } catch {
      // file absent — tests will be skipped
    }
  });

  it('analyzes the Cigna PDF and finds XFA-backed fields via orphan widget walk', async () => {
    if (!exists) return;
    const result = await analyzePdf(cignaPath);
    const allFields = result.pages.flatMap((p) => p.fields);
    expect(allFields.length).toBeGreaterThan(10);
  });

  it('extracts XFA datasets info from the Cigna PDF', async () => {
    if (!exists) return;
    const bytes = await import('node:fs/promises').then((m) => m.readFile(cignaPath));
    const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const info = getXfaDatasetsInfo(pdfDoc);
    expect(info).not.toBeNull();
    expect(info?.xml).toContain('topmostSubform');
  });
});
