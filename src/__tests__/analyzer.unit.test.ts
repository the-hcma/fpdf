import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFString, PDFRawStream } from 'pdf-lib';
import { deflateSync } from 'node:zlib';
import {
  deriveLabel,
  deriveDisplayName,
  detectPageType,
  detectCandidateFields,
  suppressContainerCandidates,
  extractOrphanWidgets,
  xfaLeafName,
  getXfaDatasetsInfo,
  parseXfaDatasetValues,
  patchXfaDatasetsXml,
  computePdfKind,
} from '../analyzer.js';
import { makePlacement, makeCandidate } from './helpers.js';

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

  it('truncates at the first colon', () => {
    expect(deriveDisplayName('Patient Name:')).toBe('Patient Name');
  });

  it('truncates at colon preserving text before it', () => {
    expect(deriveDisplayName('Date of Birth: MMDDCCYY')).toBe('Date of Birth');
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
    // Width is inset by FIELD_MARGIN (3pt) on each side: 150 - 2*3 = 144.
    expect(result[0]?.placement.width).toBeCloseTo(144, 0);
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

  it('assigns medium confidence when external label is above the field', () => {
    // Label is above the field (not inside) → external label → medium confidence.
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
    expect(result[0]?.confidence).toBe('medium');
    expect(result[0]?.label).toBe('Full Name');
  });

  it('rejects flat horizontal lines (h normalised to 1pt < MIN_VISIBLE_HEIGHT)', () => {
    // height=0 → bboxToBox normalises to 1pt → below MIN_VISIBLE_HEIGHT → filtered out entirely.
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
    expect(result).toHaveLength(0);
  });

  it('rejects vertical lines (w = 0 < MIN_VISIBLE_HEIGHT)', () => {
    // A vertical table rule: width=0 — filtered out entirely.
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
    expect(result).toHaveLength(0);
  });

  it('detects rectangle with in-box label as high-confidence field', () => {
    // Label is inside the rectangle near the top (high PDF y) → in-box label → high confidence.
    // Field: x=50, y=670, w=200, h=30. Label at top: y=691, h=8 (near cell top=700).
    // After margin+label inset: fieldY=673, newTop=691-3=688, fieldH=688-673=15 > MIN_VISIBLE_HEIGHT.
    const textBlocks = [
      {
        text: 'Patient Name',
        placement: { x: 55, y: 691, width: 60, height: 8 },
        fontSize: 8,
        fontName: 'TT1',
      },
    ];
    const result = detectCandidateFields(
      { fnArray: [19, 20], argsArray: [[50, 670, 200, 30], []] },
      textBlocks,
      612,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.confidence).toBe('high');
    expect(result[0]?.label).toBe('Patient Name');
  });

  it('rejects a box whose computed fill area overlaps a text block', () => {
    // Field underline-style: rect at x=50, y=650, w=150, h=20.
    // Fill area after margins + defaultInset: y≈653, h≈8, x≈53, w≈144.
    // A small text block sitting inside that fill area must cause the candidate to be discarded.
    // (Total text area ≈ 200pt² << 55% of 3000pt² box area — coverage filter does NOT apply.)
    const textBlocks = [
      {
        text: 'pre-printed value',
        placement: { x: 60, y: 655, width: 40, height: 5 },
        fontSize: 5,
        fontName: 'TT1',
      },
    ];
    const result = detectCandidateFields(
      { fnArray: [19, 20], argsArray: [[50, 650, 150, 20], []] },
      textBlocks,
      612,
    );
    expect(result).toHaveLength(0);
  });

  it('keeps a box whose label is outside the fill area (label above, fill area clear)', () => {
    // Label sits above the field — fill area itself is empty, so the box is kept.
    const textBlocks = [
      {
        text: 'Signature',
        placement: { x: 50, y: 675, width: 60, height: 10 },
        fontSize: 10,
        fontName: 'TT1',
      },
    ];
    const result = detectCandidateFields(
      { fnArray: [19, 20], argsArray: [[50, 650, 150, 20], []] },
      textBlocks,
      612,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.label).toBe('Signature');
  });

  it('filters out rectangles whose interior is mostly text (instruction block)', () => {
    // Three large text blocks fill > 55% of the box area → coverage filter removes it.
    // Field: x=50, y=600, w=200, h=80 → area=16000.
    // Each text block: 100×30 = 3000; three of them = 9000; coverage = 9000/16000 = 0.5625 > 0.55.
    const textBlocks = [
      {
        text: 'Please read',
        placement: { x: 55, y: 648, width: 100, height: 30 },
        fontSize: 10,
        fontName: 'TT1',
      },
      {
        text: 'all instructions',
        placement: { x: 55, y: 616, width: 100, height: 30 },
        fontSize: 10,
        fontName: 'TT1',
      },
      {
        text: 'carefully',
        placement: { x: 55, y: 604, width: 100, height: 30 },
        fontSize: 10,
        fontName: 'TT1',
      },
    ];
    const result = detectCandidateFields(
      { fnArray: [19, 20], argsArray: [[50, 600, 200, 80], []] },
      textBlocks,
      612,
    );
    expect(result).toHaveLength(0);
  });

  it('falls back to external label when rectangle has no interior text', () => {
    // Empty rectangle + label directly above it → external label → medium confidence.
    // Field: x=50, y=670, w=150, h=16. Label center at (80, 695) is above the field.
    const textBlocks = [
      {
        text: 'Date of Birth',
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
    expect(result).toHaveLength(1);
    expect(result[0]?.confidence).toBe('medium');
    expect(result[0]?.label).toBe('Date of Birth');
  });

  it('assigns medium confidence to empty rectangle with good geometry and no label', () => {
    // No text blocks at all — good geometry alone yields medium confidence.
    const result = detectCandidateFields(
      { fnArray: [19, 20], argsArray: [[50, 670, 120, 18], []] },
      [],
      612,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.confidence).toBe('medium');
    expect(result[0]?.label).toBe('');
  });

  it('classifies tall wide rectangle as textarea', () => {
    // h=40 > TEXTAREA_MIN_H(30) and w/h > 2 (not tall-non-wide) → textarea type.
    const result = detectCandidateFields(
      { fnArray: [19, 20], argsArray: [[50, 600, 200, 40], []] },
      [],
      612,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe('textarea');
  });

  it('rejects tall non-wide rectangle (column/structural element)', () => {
    // h=80 > MAX_FIELD_HEIGHT(60) and w/h < 2 (narrow) → rejected.
    const result = detectCandidateFields(
      { fnArray: [19, 20], argsArray: [[50, 400, 30, 80], []] },
      [],
      612,
    );
    expect(result).toHaveLength(0);
  });

  it('assigns medium confidence when bad geometry but external label exists', () => {
    // Tall wide box: h=80 > MAX_FIELD_HEIGHT(60), w/h=2.5 ≥ 2 so not rejected, but
    // goodGeometry requires h ≤ MAX_FIELD_HEIGHT → false → bad geometry.
    // External label above → labelSource='external' → medium confidence.
    // fieldTop = y+h = 600+80 = 680; isAbove requires by in [680, 680+2*fontSize=700]
    const textBlocks = [
      {
        text: 'Comments',
        placement: { x: 50, y: 683, width: 60, height: 10 },
        fontSize: 10,
        fontName: 'TT1',
      },
    ];
    const result = detectCandidateFields(
      { fnArray: [19, 20], argsArray: [[50, 600, 200, 80], []] },
      textBlocks,
      612,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.confidence).toBe('medium');
  });

  it('reserves top strip for tall empty rectangle with no inside text (h >= 20)', () => {
    // h=25, no text blocks — insets top by 30% so fieldH is reduced.
    // The field should still be detected (fieldH > MIN_VISIBLE_HEIGHT).
    const result = detectCandidateFields(
      { fnArray: [19, 20], argsArray: [[50, 670, 120, 25], []] },
      [],
      612,
    );
    expect(result).toHaveLength(1);
    // fieldH = 25 - 2*3 - min(round(25*0.3),10) = 19 - 7 = 12, which is > MIN_VISIBLE_HEIGHT(4)
    expect(result[0]?.placement.height).toBeGreaterThan(0);
  });

  it('ignores zero-area text blocks when computing in-box coverage', () => {
    // A text block with width=0 (zero area) should not be counted as coverage.
    const textBlocks = [
      {
        text: 'ghost',
        placement: { x: 55, y: 680, width: 0, height: 10 },
        fontSize: 8,
        fontName: 'TT1',
      },
    ];
    // Despite the text block overlapping in y, zero area means it's not "inside".
    const result = detectCandidateFields(
      { fnArray: [19, 20], argsArray: [[50, 670, 120, 18], []] },
      textBlocks,
      612,
    );
    expect(result).toHaveLength(1); // not filtered out by coverage
  });

  it('rejects a box where two labels span ≥60% of its width (multi-column header)', () => {
    // Simulates "DRUG NAME & STRENGTH" (left) + "NDC" (right) printed at the top
    // border of a wide rectangle — each label straddles the box edge so
    // findInsideText (50% threshold) misses them.  The multi-label span filter
    // requires ≥10% of each text block's area to overlap the box AND combined
    // horizontal span > 60% of box width.
    // Box: x=10, y=100, w=400, h=20  (PDF coords, bottom-left origin)
    const textBlocks = [
      {
        // Left label: x=15..215 (200pt wide), y=115..125 (10pt tall).
        // Box top = y=120.  Vertical overlap = 5pt.  Area overlap = 200*5=1000.
        // Text area = 200*10=2000.  Fraction = 50% ≥ 10% → counted.
        text: 'DRUG NAME & STRENGTH',
        placement: { x: 15, y: 115, width: 200, height: 10 },
        fontSize: 8,
        fontName: 'TT1',
      },
      {
        // Right label: x=330..380 (50pt), same vertical straddle.
        // Area overlap = 50*5=250, text area=500, fraction=50% ≥ 10% → counted.
        text: 'NDC',
        placement: { x: 330, y: 115, width: 50, height: 10 },
        fontSize: 8,
        fontName: 'TT1',
      },
    ];
    const result = detectCandidateFields(
      { fnArray: [19, 20], argsArray: [[10, 100, 400, 20], []] },
      textBlocks,
      612,
    );
    // count=2, combined clipped h-span=250, 250/400=62.5% > 60% → suppressed.
    expect(result).toHaveLength(0);
  });

  it('keeps a field whose single inside label spans less than 60% of box width', () => {
    // A normal labeled field: "Full Name" (60pt) in a 200pt box → 30% span.
    const textBlocks = [
      {
        text: 'Full Name',
        placement: { x: 55, y: 682, width: 60, height: 8 },
        fontSize: 8,
        fontName: 'TT1',
      },
    ];
    const result = detectCandidateFields(
      { fnArray: [19, 20], argsArray: [[50, 670, 200, 20], []] },
      textBlocks,
      612,
    );
    // Only one overlapping block → multi-label filter does not fire.
    expect(result.length).toBeGreaterThan(0);
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

describe('suppressContainerCandidates', () => {
  it('leaves candidates alone when there is no overlap', () => {
    const outer = makeCandidate('text', 0, 0, 200, 30);
    const inner = makeCandidate('checkbox', 300, 0, 12, 12); // completely separate
    suppressContainerCandidates([outer, inner], []);
    expect(outer.confidence).toBe('high');
    expect(inner.confidence).toBe('high');
  });

  it('demotes a text candidate that fully contains a checkbox candidate', () => {
    // outer text rect fully encloses inner checkbox
    const outer = makeCandidate('text', 10, 50, 400, 30);
    const inner = makeCandidate('checkbox', 60, 55, 12, 12);
    suppressContainerCandidates([outer, inner], []);
    expect(outer.confidence).toBe('low');
    expect(inner.confidence).toBe('high'); // inner kept
  });

  it('demotes a text candidate containing multiple checkbox candidates', () => {
    const outer = makeCandidate('text', 10, 50, 400, 30);
    const cb1 = makeCandidate('checkbox', 60, 55, 12, 12);
    const cb2 = makeCandidate('checkbox', 200, 55, 12, 12);
    suppressContainerCandidates([outer, cb1, cb2], []);
    expect(outer.confidence).toBe('low');
    expect(cb1.confidence).toBe('high');
    expect(cb2.confidence).toBe('high');
  });

  it('does not demote a checkbox/radio candidate even if it overlaps another', () => {
    // Two side-by-side overlapping checkboxes (58% overlap) — neither should be demoted.
    // The duplicate threshold is 80%, so this pair is kept as-is.
    const cb1 = makeCandidate('checkbox', 10, 10, 12, 12);
    const cb2 = makeCandidate('checkbox', 15, 10, 12, 12);
    suppressContainerCandidates([cb1, cb2], []);
    expect(cb1.confidence).toBe('high');
    expect(cb2.confidence).toBe('high');
  });

  it('demotes the larger of two near-identical same-type candidates (duplicate detection)', () => {
    // Simulates the pattern where the same checkbox is detected twice at
    // slightly different bounds (stroke rect 6×6 wrapping fill rect 5×5).
    // overlapFraction(6×6, 5×5) = 25/25 = 1.0 → outer demoted.
    // overlapFraction(5×5, 6×6) = 25/36 ≈ 0.69 < 0.8 → inner kept.
    const larger = makeCandidate('checkbox', 32, 654, 6, 6);
    const smaller = makeCandidate('checkbox', 33, 654, 5, 5);
    suppressContainerCandidates([larger, smaller], []);
    expect(larger.confidence).toBe('low');
    expect(smaller.confidence).toBe('high');
  });

  it('demotes a text candidate containing an AcroForm field', () => {
    const outer = makeCandidate('text', 10, 50, 400, 30);
    const acroField = makePlacement(60, 55, 12, 12);
    suppressContainerCandidates([outer], [acroField]);
    expect(outer.confidence).toBe('low');
  });

  it('skips candidates already marked low', () => {
    const outer = makeCandidate('text', 10, 50, 400, 30, 'low');
    const inner = makeCandidate('checkbox', 60, 55, 12, 12);
    // No error, inner stays high
    suppressContainerCandidates([outer, inner], []);
    expect(outer.confidence).toBe('low');
    expect(inner.confidence).toBe('high');
  });

  it('partial overlap below threshold does not demote', () => {
    // outer covers only 20% of inner's area
    const outer = makeCandidate('text', 0, 0, 6, 12); // covers left 6pt of inner
    const inner = makeCandidate('checkbox', 0, 0, 30, 12); // 6/30 = 20% overlap
    suppressContainerCandidates([outer, inner], []);
    expect(outer.confidence).toBe('high');
  });
});
