// integration
import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PDFDocument, TextAlignment, degrees } from 'pdf-lib';
import { exportPdf, ExportError } from '../exporter.js';
import type { FpdfDocument, PdfField, PdfKind, CandidateField } from '../types.js';
import {
  makePdfBytes,
  writeTempPdf,
  MINIMAL_JPEG,
  MINIMAL_PNG,
  MINIMAL_TRANSPARENT_PNG,
  MINIMAL_TRANSPARENT_GRAY_PNG,
} from './helpers.js';

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
let rotated90PdfPath: string;
let rotated180PdfPath: string;
let rotated270PdfPath: string;

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

  // A 595×842 portrait PDF with /Rotate 90, so viewers display it as 842×595 landscape.
  const rotated90Bytes = await makePdfBytes((doc) => {
    const page = doc.addPage([595, 842]);
    page.setRotation(degrees(90));
  });
  rotated90PdfPath = await writeTempPdf('rotated90.pdf', rotated90Bytes, 'fpdf-exporter-tests');

  // /Rotate 180 — same MediaBox size but upside-down; viewers show 612×792.
  const rotated180Bytes = await makePdfBytes((doc) => {
    const page = doc.addPage([612, 792]);
    page.setRotation(degrees(180));
  });
  rotated180PdfPath = await writeTempPdf('rotated180.pdf', rotated180Bytes, 'fpdf-exporter-tests');

  // /Rotate 270 (= 90 counter-clockwise) — MediaBox 595×842, visual 842×595.
  const rotated270Bytes = await makePdfBytes((doc) => {
    const page = doc.addPage([595, 842]);
    page.setRotation(degrees(270));
  });
  rotated270PdfPath = await writeTempPdf('rotated270.pdf', rotated270Bytes, 'fpdf-exporter-tests');
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
    const doc = makeDoc([{ name: 'firstName', type: 'text', value: false }]);
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

  it('forces black font color when the original /DA contains a non-black colour operator', async () => {
    // Create a PDF whose text field /DA has a blue colour (`0 0 1 rg`).
    const blueBytes = await makePdfBytes((doc) => {
      const page = doc.addPage([612, 792]);
      const form = doc.getForm();
      const tf = form.createTextField('colorField');
      tf.addToPage(page, { x: 50, y: 700, width: 200, height: 20 });
      tf.acroField.setDefaultAppearance('/Helv 10 Tf 0 0 1 rg');
    });
    const bluePath = await writeTempPdf('blue-da.pdf', blueBytes, 'fpdf-exporter-tests');

    const doc = makeDoc([{ name: 'colorField', type: 'text', value: 'Hello' }]);
    doc.metadata.originalPdf = bluePath;

    const bytes = await exportPdf(bluePath, doc);
    const result = await PDFDocument.load(bytes);
    const da = result.getForm().getTextField('colorField').acroField.getDefaultAppearance();
    expect(da).toBeDefined();
    // The colour portion must be normalised to `0 g` (black grayscale) — the
    // original `0 0 1 rg` (blue) must not appear in the output /DA.
    expect(da).not.toContain('0 0 1 rg');
    expect(da).toContain('0 g');
  });

  it('defaults to left alignment when the original widget has center quadding and no textAlign is set', async () => {
    // Create a PDF whose text field has center quadding (Q=1) — typical of
    // XFA-derived Cigna forms where AcroForm widgets inherit XFA centering.
    const centeredBytes = await makePdfBytes((doc) => {
      const page = doc.addPage([612, 792]);
      const form = doc.getForm();
      const tf = form.createTextField('centeredField');
      tf.addToPage(page, { x: 50, y: 700, width: 200, height: 20 });
      tf.setAlignment(TextAlignment.Center);
    });
    const centeredPath = await writeTempPdf('center-q.pdf', centeredBytes, 'fpdf-exporter-tests');

    // No textAlign on the field — simulates user not touching alignment.
    const doc = makeDoc([{ name: 'centeredField', type: 'text', value: 'Shopify Inc.' }]);
    doc.metadata.originalPdf = centeredPath;

    const bytes = await exportPdf(centeredPath, doc);
    const result = await PDFDocument.load(bytes);
    const tf = result.getForm().getTextField('centeredField');
    // Quadding must have been forced to Left.
    expect(tf.getAlignment()).toBe(TextAlignment.Left);
  });
});

describe('encrypted PDF export', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws ExportError when pdf-lib cannot parse the PDF', async () => {
    vi.spyOn(PDFDocument, 'load').mockRejectedValue(new Error('simulated encryption failure'));
    const doc = makeDoc([]);
    doc.metadata.originalPdf = textPdfPath;
    await expect(exportPdf(textPdfPath, doc)).rejects.toBeInstanceOf(ExportError);
  });

  it('includes a user-friendly message suggesting browser print', async () => {
    vi.spyOn(PDFDocument, 'load').mockRejectedValue(new Error('simulated encryption failure'));
    const doc = makeDoc([]);
    doc.metadata.originalPdf = textPdfPath;
    await expect(exportPdf(textPdfPath, doc)).rejects.toThrow(/Print function/);
  });
});

// ---------------------------------------------------------------------------
// Candidate-field placement on a /Rotate 90 page
// ---------------------------------------------------------------------------
//
// Placement coordinates are stored in the VISUAL (post-rotation) space.
// The exporter must convert them back to the PDF MediaBox space.
//
// For a 595×842 /Rotate 90 page (visual: 842 wide × 595 tall):
//   toRawRect(vx, vy, vw, vh, pageW=842, pageH=595, rotation=90)
//     → { x: 595−vy−vh, y: vx, width: vh, height: vw }
//
// Visually: field at (vx=100, vy=50, vw=120, vh=20)
//   → MediaBox: x=525, y=100, width=20, height=120

describe('candidate field on a /Rotate 90 page', () => {
  function makeRotatedDoc(candidateFields: CandidateField[]): Parameters<typeof exportPdf>[1] {
    return {
      metadata: {
        version: '1.0',
        originalPdf: rotated90PdfPath,
        pdfFilename: 'rotated90.pdf',
        pdfHash: 'sha256:test',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        pageCount: 1,
        pdfKind: 'no-acroform',
      },
      pages: [
        {
          pageNumber: 1,
          widthPt: 842, // visual landscape width (after /Rotate 90)
          heightPt: 595, // visual landscape height
          rotationDeg: 90,
          pageType: 'vector' as const,
          fields: [],
          candidateFields,
          textBlocks: [],
        },
      ],
    };
  }

  it('places a text candidate at the correct MediaBox position for /Rotate 90', async () => {
    // Visual field at (vx=100, vy=50, vw=120, vh=20) on a 842×595 landscape page.
    // Expected MediaBox rect: x=595−50−20=525, y=100, width=20, height=120
    const candidate: CandidateField = {
      id: 'rot-test',
      type: 'text',
      label: 'Name',
      displayName: 'Name',
      placement: { x: 100, y: 50, width: 120, height: 20 },
      value: 'Hello',
      confidence: 'high',
      dismissed: false,
    };
    const bytes = await exportPdf(rotated90PdfPath, makeRotatedDoc([candidate]));
    const result = await PDFDocument.load(bytes);
    const tf = result.getForm().getTextField('Name');
    const widget = tf.acroField.getWidgets()[0];
    if (!widget) throw new Error('no widget found');
    const rect = widget.getRectangle();
    // pdf-lib may adjust widget bounds by up to ±1pt; verify the transform landed
    // in the correct zone (within 1.5pt of the theoretical MediaBox position).
    // Expected: x=595−vy(50)−vh(20)=525, y=vx(100)=100, w=vh(20)=20, h=vw(120)=120
    expect(Math.abs(rect.x - 525)).toBeLessThan(1.5);
    expect(Math.abs(rect.y - 100)).toBeLessThan(1.5);
    expect(Math.abs(rect.width - 20)).toBeLessThan(1.5);
    expect(Math.abs(rect.height - 120)).toBeLessThan(1.5);
  });

  it('carries the field value correctly through the rotation transform', async () => {
    const candidate: CandidateField = {
      id: 'rot-val',
      type: 'text',
      label: 'Note',
      displayName: 'Note',
      placement: { x: 200, y: 100, width: 150, height: 25 },
      value: 'test value',
      confidence: 'high',
      dismissed: false,
    };
    const bytes = await exportPdf(rotated90PdfPath, makeRotatedDoc([candidate]));
    const result = await PDFDocument.load(bytes);
    expect(result.getForm().getTextField('Note').getText()).toBe('test value');
  });
});

describe('candidate field on a /Rotate 270 page', () => {
  // MediaBox 595×842, /Rotate 270, visual 842×595.
  // toRawRect(vx, vy, vw, vh, pageW=842, pageH=595, rotation=270)
  //   → { x: vy, y: pageW − vx − vw, width: vh, height: vw }
  // For visual field (100, 50, 120, 20): x=50, y=842−100−120=622, w=20, h=120
  it('places a text candidate at the correct MediaBox position for /Rotate 270', async () => {
    const candidate: CandidateField = {
      id: 'rot270',
      type: 'text',
      label: 'Name',
      displayName: 'Name',
      placement: { x: 100, y: 50, width: 120, height: 20 },
      value: 'Hello',
      confidence: 'high',
      dismissed: false,
    };
    const doc: Parameters<typeof exportPdf>[1] = {
      metadata: {
        version: '1.0',
        originalPdf: rotated270PdfPath,
        pdfFilename: 'rotated270.pdf',
        pdfHash: 'sha256:test',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        pageCount: 1,
        pdfKind: 'no-acroform',
      },
      pages: [
        {
          pageNumber: 1,
          widthPt: 842,
          heightPt: 595,
          rotationDeg: 270,
          pageType: 'vector' as const,
          fields: [],
          candidateFields: [candidate],
          textBlocks: [],
        },
      ],
    };
    const bytes = await exportPdf(rotated270PdfPath, doc);
    const result = await PDFDocument.load(bytes);
    const tf = result.getForm().getTextField('Name');
    const widget = tf.acroField.getWidgets()[0];
    if (!widget) throw new Error('no widget found');
    const rect = widget.getRectangle();
    // Expected: x=vy(50), y=pagW(842)−vx(100)−vw(120)=622, w=vh(20), h=vw(120)
    expect(Math.abs(rect.x - 50)).toBeLessThan(1.5);
    expect(Math.abs(rect.y - 622)).toBeLessThan(1.5);
    expect(Math.abs(rect.width - 20)).toBeLessThan(1.5);
    expect(Math.abs(rect.height - 120)).toBeLessThan(1.5);
  });
});

describe('candidate field on a /Rotate 180 page', () => {
  // MediaBox 612×792, /Rotate 180, visual 612×792 (dimensions unchanged, flipped).
  // toRawRect(vx, vy, vw, vh, pageW=612, pageH=792, rotation=180)
  //   → { x: pageW − vx − vw, y: pageH − vy − vh, width: vw, height: vh }
  // For visual field (100, 50, 120, 20): x=392, y=722, w=120, h=20
  it('places a text candidate at the correct MediaBox position for /Rotate 180', async () => {
    const candidate: CandidateField = {
      id: 'rot180',
      type: 'text',
      label: 'Name',
      displayName: 'Name',
      placement: { x: 100, y: 50, width: 120, height: 20 },
      value: 'Hello',
      confidence: 'high',
      dismissed: false,
    };
    const doc: Parameters<typeof exportPdf>[1] = {
      metadata: {
        version: '1.0',
        originalPdf: rotated180PdfPath,
        pdfFilename: 'rotated180.pdf',
        pdfHash: 'sha256:test',
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
          rotationDeg: 180,
          pageType: 'vector' as const,
          fields: [],
          candidateFields: [candidate],
          textBlocks: [],
        },
      ],
    };
    const bytes = await exportPdf(rotated180PdfPath, doc);
    const result = await PDFDocument.load(bytes);
    const tf = result.getForm().getTextField('Name');
    const widget = tf.acroField.getWidgets()[0];
    if (!widget) throw new Error('no widget found');
    const rect = widget.getRectangle();
    // Expected: x=612−100−120=392, y=792−50−20=722, w=120, h=20
    expect(Math.abs(rect.x - 392)).toBeLessThan(1.5);
    expect(Math.abs(rect.y - 722)).toBeLessThan(1.5);
    expect(Math.abs(rect.width - 120)).toBeLessThan(1.5);
    expect(Math.abs(rect.height - 20)).toBeLessThan(1.5);
  });
});

// ---------------------------------------------------------------------------
// Placed images — exportPdf (AcroForm path)
// ---------------------------------------------------------------------------

describe('exportPdf — placed images', () => {
  let blankPdfPath: string;

  beforeAll(async () => {
    const blankBytes = await makePdfBytes((doc) => {
      doc.addPage([612, 792]);
    });
    blankPdfPath = await writeTempPdf('blank.pdf', blankBytes, 'fpdf-placed-img-tests');
  });

  function makeBlankDoc(): FpdfDocument {
    return {
      metadata: {
        version: '1.0',
        originalPdf: '',
        pdfFilename: 'blank.pdf',
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
          candidateFields: [],
          textBlocks: [],
        },
      ],
    };
  }

  it('stamps a placed JPEG into the exported PDF with a Multiply transparency group', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fpdf-placed-'));
    const id = 'cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa';
    await writeFile(path.join(dir, `${id}.jpg`), MINIMAL_JPEG);
    const doc = makeBlankDoc();
    const page0 = doc.pages[0];
    if (page0 === undefined) throw new Error('expected page 0');
    page0.images = [
      { id, mimeType: 'image/jpeg', placement: { x: 50, y: 650, width: 120, height: 60 } },
    ];
    const bytes = await exportPdf(blankPdfPath, doc, { imagesDir: dir });
    const reloaded = await PDFDocument.load(bytes);
    const uncompressed = await reloaded.save({ useObjectStreams: false });
    const pdfText = Buffer.from(uncompressed).toString('latin1');
    expect(pdfText).toContain('/Transparency');
    expect(pdfText).toContain('/Multiply');
  });

  it('stamps a placed opaque PNG into the exported PDF with a Multiply transparency group', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fpdf-placed-'));
    const id = 'dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb';
    await writeFile(path.join(dir, `${id}.png`), MINIMAL_PNG);
    const doc = makeBlankDoc();
    const page0 = doc.pages[0];
    if (page0 === undefined) throw new Error('expected page 0');
    page0.images = [
      { id, mimeType: 'image/png', placement: { x: 100, y: 600, width: 80, height: 80 } },
    ];
    const bytes = await exportPdf(blankPdfPath, doc, { imagesDir: dir });
    const reloaded = await PDFDocument.load(bytes);
    const uncompressed = await reloaded.save({ useObjectStreams: false });
    const pdfText = Buffer.from(uncompressed).toString('latin1');
    expect(pdfText).toContain('/Transparency');
    expect(pdfText).toContain('/Multiply');
  });

  it('adds a page transparency group and uses Multiply blend mode for placed PNGs', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fpdf-placed-'));
    const id = 'ffffffff-0000-1111-2222-333333333333';
    await writeFile(path.join(dir, `${id}.png`), MINIMAL_TRANSPARENT_PNG);
    const doc = makeBlankDoc();
    const page0 = doc.pages[0];
    if (page0 === undefined) throw new Error('expected page 0');
    page0.images = [
      { id, mimeType: 'image/png', placement: { x: 50, y: 600, width: 100, height: 100 } },
    ];
    const bytes = await exportPdf(blankPdfPath, doc, { imagesDir: dir });
    // Re-save without object stream compression so every in-memory dict key is
    // readable as plain text — this lets us assert /Group /Transparency and
    // /BM /Multiply are present without needing pdf-lib internals.
    const reloaded = await PDFDocument.load(bytes);
    const uncompressed = await reloaded.save({ useObjectStreams: false });
    const pdfText = Buffer.from(uncompressed).toString('latin1');
    expect(pdfText).toContain('/Transparency');
    expect(pdfText).toContain('/Multiply');
  });

  it('adds a page transparency group and uses Multiply blend mode for a Grayscale+Alpha PNG', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fpdf-placed-'));
    const id = 'aaaaaaaa-1111-2222-3333-444444444444';
    await writeFile(path.join(dir, `${id}.png`), MINIMAL_TRANSPARENT_GRAY_PNG);
    const doc = makeBlankDoc();
    const page0 = doc.pages[0];
    if (page0 === undefined) throw new Error('expected page 0');
    page0.images = [
      { id, mimeType: 'image/png', placement: { x: 50, y: 600, width: 100, height: 100 } },
    ];
    const bytes = await exportPdf(blankPdfPath, doc, { imagesDir: dir });
    const reloaded = await PDFDocument.load(bytes);
    const uncompressed = await reloaded.save({ useObjectStreams: false });
    const pdfText = Buffer.from(uncompressed).toString('latin1');
    expect(pdfText).toContain('/Transparency');
    expect(pdfText).toContain('/Multiply');
  });

  it('skips a placed image whose file is missing and still produces a valid PDF', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fpdf-placed-'));
    const id = 'eeeeeeee-ffff-aaaa-bbbb-cccccccccccc';
    // Intentionally do NOT write the file — drawPlacedImages should warn and continue.
    const doc = makeBlankDoc();
    const page0 = doc.pages[0];
    if (page0 === undefined) throw new Error('expected page 0');
    page0.images = [
      { id, mimeType: 'image/jpeg', placement: { x: 0, y: 0, width: 100, height: 50 } },
    ];
    const bytes = await exportPdf(blankPdfPath, doc, { imagesDir: dir });
    const result = await PDFDocument.load(bytes);
    expect(result.getPageCount()).toBe(1);
  });

  it('exports successfully when imagesDir is omitted and the page has no placed images', async () => {
    const doc = makeBlankDoc();
    const bytes = await exportPdf(blankPdfPath, doc);
    const result = await PDFDocument.load(bytes);
    expect(result.getPageCount()).toBe(1);
  });
});

describe('exportPdf — page exclusion', () => {
  let twoPdfPath: string;

  beforeAll(async () => {
    const twoPageBytes = await makePdfBytes((doc) => {
      doc.addPage([612, 792]);
      doc.addPage([612, 792]);
    });
    twoPdfPath = await writeTempPdf('two-pages.pdf', twoPageBytes, 'fpdf-exclusion-tests');
  });

  it('omits an excluded page from the exported PDF', async () => {
    const doc: FpdfDocument = {
      metadata: {
        version: '1.0',
        originalPdf: '',
        pdfFilename: 'two-pages.pdf',
        pdfHash: 'sha256:abc',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        pageCount: 2,
        pdfKind: 'no-acroform',
      },
      pages: [
        {
          pageNumber: 1,
          widthPt: 612,
          heightPt: 792,
          pageType: 'vector' as const,
          fields: [],
          candidateFields: [],
          textBlocks: [],
          excluded: true,
        },
        {
          pageNumber: 2,
          widthPt: 612,
          heightPt: 792,
          pageType: 'vector' as const,
          fields: [],
          candidateFields: [],
          textBlocks: [],
        },
      ],
    };
    const bytes = await exportPdf(twoPdfPath, doc);
    const result = await PDFDocument.load(bytes);
    expect(result.getPageCount()).toBe(1);
  });

  it('keeps all pages when none are excluded', async () => {
    const doc: FpdfDocument = {
      metadata: {
        version: '1.0',
        originalPdf: '',
        pdfFilename: 'two-pages.pdf',
        pdfHash: 'sha256:abc',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        pageCount: 2,
        pdfKind: 'no-acroform',
      },
      pages: [
        {
          pageNumber: 1,
          widthPt: 612,
          heightPt: 792,
          pageType: 'vector' as const,
          fields: [],
          candidateFields: [],
          textBlocks: [],
        },
        {
          pageNumber: 2,
          widthPt: 612,
          heightPt: 792,
          pageType: 'vector' as const,
          fields: [],
          candidateFields: [],
          textBlocks: [],
        },
      ],
    };
    const bytes = await exportPdf(twoPdfPath, doc);
    const result = await PDFDocument.load(bytes);
    expect(result.getPageCount()).toBe(2);
  });
});
