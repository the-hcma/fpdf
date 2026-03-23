import { describe, it, expect, beforeAll } from 'vitest';
import { tmpdir } from 'node:os';
import { writeFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { analyzePdf, AnalyzerError, deriveLabel, deriveDisplayName } from '../analyzer.js';

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
let textFieldPdfPath: string;
let checkboxPdfPath: string;
let dropdownPdfPath: string;
let radioGroupPdfPath: string;
let multilineTextPdfPath: string;
let twoPagePdfPath: string;
let readonlyPdfPath: string;
let buttonPdfPath: string;

beforeAll(async () => {
  // 1. PDF with no AcroForm fields
  const emptyBytes = await makePdfBytes((doc) => {
    doc.addPage();
  });
  emptyPdfPath = await writeTempPdf('empty.pdf', emptyBytes);

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
