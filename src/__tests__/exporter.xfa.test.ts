// integration
import { describe, it, expect, beforeAll } from 'vitest';
import { PDFDocument, PDFName, PDFString, PDFRawStream, PDFDict, PDFRef } from 'pdf-lib';
import { deflateSync } from 'node:zlib';
import { exportPdf } from '../exporter.js';
import { getXfaDatasetsInfo } from '../analyzer.js';
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
    xfaPdfPath = await writeTempPdf('xfa-datasets.pdf', bytes, 'fpdf-exporter-tests');
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
    xfaHybridRadioPdfPath = await writeTempPdf(
      'xfa-hybrid-radio.pdf',
      bytes,
      'fpdf-exporter-tests',
    );
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

  // ── Candidate field AcroForm export (createCandidateWidgets) ────────────────

  it('exports candidate text fields as AcroForm widgets', async () => {
    const plainBytes = await makePdfBytes((doc) => {
      doc.addPage([612, 792]);
    });
    const plainPath = await writeTempPdf('plain-candidate.pdf', plainBytes, 'fpdf-exporter-tests');

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
    const result = await PDFDocument.load(bytes);
    expect(result.getPageCount()).toBe(1);
    // Candidate is now exported as a real AcroForm text widget.
    const fields = result.getForm().getFields();
    expect(fields).toHaveLength(1);
    expect(result.getForm().getTextField('Name').getText()).toBe('Alice');
  });

  it('exports a checked candidate checkbox as an AcroForm checkbox widget', async () => {
    const plainBytes = await makePdfBytes((doc) => {
      doc.addPage([612, 792]);
    });
    const plainPath = await writeTempPdf(
      'plain-checkbox-candidate.pdf',
      plainBytes,
      'fpdf-exporter-tests',
    );

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
    // Candidate exported as a real AcroForm checkbox widget that is checked.
    expect(result.getForm().getCheckBox('Agree').isChecked()).toBe(true);
  });

  it('skips dismissed candidate fields', async () => {
    const plainBytes = await makePdfBytes((doc) => {
      doc.addPage([612, 792]);
    });
    const plainPath = await writeTempPdf('plain-dismissed.pdf', plainBytes, 'fpdf-exporter-tests');

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

  it('exports candidate radio buttons as an AcroForm radio group', async () => {
    const plainBytes = await makePdfBytes((doc) => {
      doc.addPage([612, 792]);
    });
    const plainPath = await writeTempPdf(
      'plain-radio-candidate.pdf',
      plainBytes,
      'fpdf-exporter-tests',
    );

    const radioA: CandidateField = {
      id: 'r1',
      type: 'radio',
      label: 'Choice',
      displayName: 'Choice',
      placement: { x: 50, y: 700, width: 16, height: 16 },
      value: 'yes',
      confidence: 'high',
      dismissed: false,
      radioValue: 'yes',
      groupName: 'Answer',
    };
    const radioB: CandidateField = {
      id: 'r2',
      type: 'radio',
      label: 'Choice',
      displayName: 'Choice',
      placement: { x: 50, y: 670, width: 16, height: 16 },
      value: 'yes',
      confidence: 'high',
      dismissed: false,
      radioValue: 'no',
      groupName: 'Answer',
    };

    const doc: FpdfDocument = {
      metadata: {
        version: '1.0',
        originalPdf: plainPath,
        pdfFilename: 'plain-radio-candidate.pdf',
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
          candidateFields: [radioA, radioB],
          textBlocks: [],
        },
      ],
    };

    const bytes = await exportPdf(plainPath, doc);
    const result = await PDFDocument.load(bytes);
    expect(result.getPageCount()).toBe(1);
    // One radio group with two options; 'yes' is selected.
    const rg = result.getForm().getRadioGroup('Answer');
    expect(rg.getOptions()).toEqual(expect.arrayContaining(['yes', 'no']));
    expect(rg.getSelected()).toBe('yes');
  });

  it('deduplicates candidate field names with a numeric suffix', async () => {
    const plainBytes = await makePdfBytes((doc) => {
      doc.addPage([612, 792]);
    });
    const plainPath = await writeTempPdf(
      'plain-dedup-candidate.pdf',
      plainBytes,
      'fpdf-exporter-tests',
    );

    const makeCandidate = (id: string, y: number): CandidateField => ({
      id,
      type: 'text',
      label: 'Name',
      displayName: 'Name',
      placement: { x: 50, y, width: 200, height: 20 },
      value: id,
      confidence: 'high',
      dismissed: false,
    });

    const doc: FpdfDocument = {
      metadata: {
        version: '1.0',
        originalPdf: plainPath,
        pdfFilename: 'plain-dedup-candidate.pdf',
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
          candidateFields: [makeCandidate('c1', 700), makeCandidate('c2', 660)],
          textBlocks: [],
        },
      ],
    };

    const bytes = await exportPdf(plainPath, doc);
    const result = await PDFDocument.load(bytes);
    // Both candidates share displayName 'Name'; second gets 'Name_1'.
    const fields = result.getForm().getFields();
    expect(fields).toHaveLength(2);
    const names = fields.map((f) => f.getName()).sort();
    expect(names).toEqual(['Name', 'Name_1']);
  });

  it('auto-fits font size for candidate text fields so long values fit', async () => {
    // Narrow (50pt) field with a long value — without setFontSize the default
    // size 0 ("auto") causes PDF viewers to stretch the font to fill the field
    // height, which overflows the width.  With auto-fit the exported font size
    // must be ≤ 12pt (MAX_FONT_SIZE) and the field value must be stored.
    const plainBytes = await makePdfBytes((doc) => {
      doc.addPage([612, 792]);
    });
    const plainPath = await writeTempPdf(
      'plain-candidate-autofit.pdf',
      plainBytes,
      'fpdf-exporter-tests',
    );

    const candidate: CandidateField = {
      id: 'caf1',
      type: 'text',
      label: 'Rx Number',
      displayName: 'Rx Number',
      placement: { x: 50, y: 700, width: 50, height: 14 },
      value: '123350117225',
      confidence: 'medium',
      dismissed: false,
    };

    const doc: FpdfDocument = {
      metadata: {
        version: '1.0',
        originalPdf: plainPath,
        pdfFilename: 'plain-candidate-autofit.pdf',
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
    const tf = result.getForm().getTextField('Rx_Number');
    // Value is preserved regardless of font-size shrinking.
    expect(tf.getText()).toBe('123350117225');
    // Font size must have been set (non-zero) and must not exceed MAX_FONT_SIZE.
    const daStr = tf.acroField.getDefaultAppearance()?.match(/[\d.]+\s+Tf/)?.[0] ?? '0';
    const size = parseFloat(daStr);
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThanOrEqual(12);
  });

  it('auto-fits font size for candidate textarea fields with multiline values', async () => {
    const plainBytes = await makePdfBytes((doc) => {
      doc.addPage([612, 792]);
    });
    const plainPath = await writeTempPdf(
      'plain-candidate-textarea-autofit.pdf',
      plainBytes,
      'fpdf-exporter-tests',
    );

    const candidate: CandidateField = {
      id: 'caf2',
      type: 'textarea',
      label: 'Rx Number',
      displayName: 'Rx Number',
      placement: { x: 50, y: 700, width: 75, height: 22 },
      value: '123350117225\n(on file Express Scripts)',
      confidence: 'medium',
      dismissed: false,
    };

    const doc: FpdfDocument = {
      metadata: {
        version: '1.0',
        originalPdf: plainPath,
        pdfFilename: 'plain-candidate-textarea-autofit.pdf',
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
    const tf = result.getForm().getTextField('Rx_Number');
    expect(tf.getText()).toBe('123350117225\n(on file Express Scripts)');
    const daStr = tf.acroField.getDefaultAppearance()?.match(/[\d.]+\s+Tf/)?.[0] ?? '0';
    const size = parseFloat(daStr);
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThanOrEqual(12);
  });

  it('falls back to drawCandidateValues for XFA PDFs with candidate fields', async () => {
    // For XFA PDFs we stamp text rather than creating AcroForm widgets, to avoid
    // calling getForm() before the XFA branch captures the /XFA entry.
    const candidate: CandidateField = {
      id: 'cx1',
      type: 'text',
      label: 'Note',
      displayName: 'Note',
      placement: { x: 50, y: 700, width: 200, height: 20 },
      value: 'hello',
      confidence: 'high',
      dismissed: false,
    };
    const doc = makeDoc([{ name: 'agree', type: 'checkbox', value: true }], 'xfa-hybrid', [
      candidate,
    ]);
    const bytes = await exportPdf(xfaHybridRadioPdfPath, doc);
    const result = await PDFDocument.load(bytes);
    expect(result.getPageCount()).toBeGreaterThan(0);
    // The candidate is not added as a separate AcroForm field on the XFA path.
    const fieldNames = result
      .getForm()
      .getFields()
      .map((f) => f.getName());
    expect(fieldNames).not.toContain('Note');
  });
});
