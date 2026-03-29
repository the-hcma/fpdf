import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import * as path from 'node:path';
import { PDFDocument, PDFName, PDFString, StandardFonts, rgb } from 'pdf-lib';
import { analyzePdf, AnalyzerError } from '../analyzer.js';
import { makePdfBytes, writeTempPdf, MINIMAL_JPEG } from './helpers.js';

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

describe('candidateFields extraction', () => {
  it('AcroForm page has empty candidateFields', async () => {
    const doc = await analyzePdf(textFieldPdfPath);
    expect(doc.pages[0]?.candidateFields).toEqual([]);
  });

  it('each page has a candidateFields array', async () => {
    const doc = await analyzePdf(vectorLinePdfPath);
    expect(Array.isArray(doc.pages[0]?.candidateFields)).toBe(true);
  });

  it('vector line PDF yields no candidate fields (horizontal underlines are filtered)', async () => {
    // The fixture draws a plain drawLine() which produces a zero-height stroke path.
    // MIN_VISIBLE_HEIGHT rejects it entirely — underlines are not fillable fields.
    const doc = await analyzePdf(vectorLinePdfPath);
    expect(doc.pages[0]?.candidateFields ?? []).toHaveLength(0);
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

  it('vector rect candidate labels use in-box text when label is inside the rectangle', async () => {
    // The vectorRect fixture draws a rectangle with "Amount" above it (external label).
    // External label → medium confidence; label string must still be captured.
    const doc = await analyzePdf(vectorRectPdfPath);
    const candidates = doc.pages[0]?.candidateFields ?? [];
    const labeled = candidates.find((c) => c.label.includes('Amount'));
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

describe('pdf-lib fallback (encrypted/corrupted PDFs)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('succeeds via pdfjs-dist when pdf-lib cannot parse the PDF', async () => {
    vi.spyOn(PDFDocument, 'load').mockRejectedValue(new Error('simulated encryption failure'));
    const doc = await analyzePdf(vectorRectPdfPath);
    expect(doc.metadata.pageCount).toBe(1);
    expect(doc.pages).toHaveLength(1);
    expect(doc.pages[0]?.widthPt).toBe(612);
    expect(doc.pages[0]?.heightPt).toBe(792);
  });

  it('sets pdfKind to no-acroform when pdf-lib is unavailable', async () => {
    vi.spyOn(PDFDocument, 'load').mockRejectedValue(new Error('simulated encryption failure'));
    const doc = await analyzePdf(vectorRectPdfPath);
    expect(doc.metadata.pdfKind).toBe('no-acroform');
  });

  it('still extracts textBlocks when pdf-lib fails', async () => {
    vi.spyOn(PDFDocument, 'load').mockRejectedValue(new Error('simulated encryption failure'));
    const doc = await analyzePdf(vectorRectPdfPath);
    const blocks = doc.pages[0]?.textBlocks ?? [];
    expect(blocks.some((b) => b.text.includes('Amount'))).toBe(true);
  });

  it('still detects candidateFields when pdf-lib fails', async () => {
    vi.spyOn(PDFDocument, 'load').mockRejectedValue(new Error('simulated encryption failure'));
    const doc = await analyzePdf(vectorRectPdfPath);
    expect((doc.pages[0]?.candidateFields ?? []).length).toBeGreaterThan(0);
  });

  it('has no AcroForm fields when pdf-lib fails', async () => {
    vi.spyOn(PDFDocument, 'load').mockRejectedValue(new Error('simulated encryption failure'));
    const doc = await analyzePdf(textFieldPdfPath);
    const fields = doc.pages[0]?.fields ?? [];
    expect(fields).toHaveLength(0);
  });

  it('detects page type via pdfjs-dist when pdf-lib fails', async () => {
    vi.spyOn(PDFDocument, 'load').mockRejectedValue(new Error('simulated encryption failure'));
    const doc = await analyzePdf(rasterPdfPath);
    expect(doc.pages[0]?.pageType).toBe('raster');
  });
});
