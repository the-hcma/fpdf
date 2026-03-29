// integration — Cigna fixture tests
import { describe, it, expect, beforeAll } from 'vitest';
import { homedir } from 'node:os';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { analyzePdf, getXfaDatasetsInfo } from '../analyzer.js';

// ---------------------------------------------------------------------------
// Section container heuristic — Cigna pharmacy claim form (always-present fixture)
// ---------------------------------------------------------------------------

describe('section container heuristic (Cigna pharmacy claim form)', () => {
  // Fixture lives in the repo — always present, no skip guard needed.
  const fixturePath = path.join(__dirname, 'fixtures', 'cigna-pharmacy-claim-form.pdf');

  it('classifies the prescription page as hybrid', async () => {
    const result = await analyzePdf(fixturePath);
    const page2 = result.pages[1];
    expect(page2).toBeDefined();
    expect(page2?.pageType).toBe('hybrid');
  });

  it('suppresses section-spanning container cells from the prescription section', async () => {
    const result = await analyzePdf(fixturePath);
    const page2 = result.pages[1];
    const prescriptionCands = (page2?.candidateFields ?? []).filter(
      (c) => c.placement.y >= 200 && c.placement.y <= 350,
    );
    // Full-section-spanning container cells (w ≥ 300pt) must not appear.
    // Individual fields like DRUG NAME & STRENGTH (w ≈ 184pt) are expected.
    const containerWidthCells = prescriptionCands.filter((c) => c.placement.width >= 300);
    expect(containerWidthCells).toHaveLength(0);
  });

  it('emits individual-field cells for both prescription sections', async () => {
    const result = await analyzePdf(fixturePath);
    const page2 = result.pages[1];
    const prescriptionCands = (page2?.candidateFields ?? []).filter(
      (c) => c.placement.y >= 200 && c.placement.y <= 350,
    );
    // Each prescription section has 3+ detectable rows, 2 sections = ≥ 6 cells.
    // With all 3 detectable rows: row1(×2=6) + row2(×2=4) + row3(×2=2) = 12 cells.
    expect(prescriptionCands.length).toBeGreaterThanOrEqual(10);
  });

  it('assigns medium confidence to prescription-section candidates', async () => {
    const result = await analyzePdf(fixturePath);
    const page2 = result.pages[1];
    const prescriptionCands = (page2?.candidateFields ?? []).filter(
      (c) => c.placement.y >= 200 && c.placement.y <= 350,
    );
    for (const c of prescriptionCands) {
      expect(c.confidence).not.toBe('low');
    }
  });

  // ── Row 1: DATE FILLED | RX NUMBER | QTY | DAY SUPPLY ──────────────────────
  // The form has two side-by-side prescription sections (left x≈24-291, right x≈315-588).
  // Row 1 underlines at y≈267 PDF space, field boxes placed above each underline.
  // Expected: 2 DATE FILLED + 2 DAY SUPPLY (solid underlines, w≈111pt each)
  //           2 RX NUMBER + 2 NDC (dashed underlines, w≈88pt each)
  //           2 QTY + 2 AMT PAID equivalent (short underlines, w≈31pt each)
  it('detects all 6 row-1 prescription fields (DATE FILLED, RX NUMBER, QTY × both sections)', async () => {
    const result = await analyzePdf(fixturePath);
    const page2 = result.pages[1];
    const row1 = (page2?.candidateFields ?? []).filter(
      (c) => c.placement.y >= 287 && c.placement.y <= 298,
    );
    expect(row1).toHaveLength(6);
    // All row-1 fields should have a usable fill height above the underline.
    for (const c of row1) {
      expect(c.placement.height).toBeGreaterThanOrEqual(15);
    }
  });

  it('detects DATE FILLED fields (wide, solid underline, leftmost column in each section)', async () => {
    const result = await analyzePdf(fixturePath);
    const page2 = result.pages[1];
    const row1 = (page2?.candidateFields ?? []).filter(
      (c) => c.placement.y >= 287 && c.placement.y <= 298,
    );
    // DATE FILLED on left (x≈35-38) and DAY SUPPLY on right (x≈315-320): both w≈111pt.
    const dateFilled = row1.filter((c) => c.placement.width >= 108 && c.placement.width <= 120);
    expect(dateFilled).toHaveLength(2);
    // Both instances should be at similar y (above the underline).
    for (const c of dateFilled) {
      expect(c.placement.height).toBeGreaterThanOrEqual(15);
    }
  });

  it('detects RX NUMBER fields (dashed underline, middle column in each section)', async () => {
    const result = await analyzePdf(fixturePath);
    const page2 = result.pages[1];
    const row1 = (page2?.candidateFields ?? []).filter(
      (c) => c.placement.y >= 287 && c.placement.y <= 298,
    );
    // RX NUMBER on left (x≈159-163) and equivalent on right (x≈440-445): both w≈88pt.
    const rxNumber = row1.filter((c) => c.placement.width >= 82 && c.placement.width <= 96);
    expect(rxNumber).toHaveLength(2);
    for (const c of rxNumber) {
      expect(c.placement.height).toBeGreaterThanOrEqual(15);
    }
  });

  it('detects QTY fields (short underline, rightmost column in each half-section)', async () => {
    const result = await analyzePdf(fixturePath);
    const page2 = result.pages[1];
    const row1 = (page2?.candidateFields ?? []).filter(
      (c) => c.placement.y >= 287 && c.placement.y <= 298,
    );
    // QTY on left (x≈262-266) and equivalent on right (x≈543-547): both w≈31pt.
    const qty = row1.filter((c) => c.placement.width >= 25 && c.placement.width <= 40);
    expect(qty).toHaveLength(2);
    for (const c of qty) {
      expect(c.placement.height).toBeGreaterThanOrEqual(15);
    }
  });

  // ── Row 2: DRUG NAME & STRENGTH | NDC | AMT. PAID ──────────────────────────
  it('detects DRUG NAME & STRENGTH fields (wide field in row 2, both sections)', async () => {
    const result = await analyzePdf(fixturePath);
    const page2 = result.pages[1];
    // DRUG NAME cells have h<20 so labelAtBottom inset doesn't apply; unchanged at y≈247.
    const row2 = (page2?.candidateFields ?? []).filter(
      (c) => c.placement.y >= 243 && c.placement.y <= 253,
    );
    // DRUG NAME & STRENGTH: w≈184pt, leftmost in each section.
    const drugName = row2.filter((c) => c.placement.width >= 178 && c.placement.width <= 194);
    expect(drugName).toHaveLength(2);
  });

  it('detects NDC fields (dashed underline in row 2, both sections)', async () => {
    const result = await analyzePdf(fixturePath);
    const page2 = result.pages[1];
    // NDC cells have h<20 so labelAtBottom inset doesn't apply; they stay at their
    // original fill-area y (≈247), unlike DRUG NAME which shifts up to ≈266.
    const row2 = (page2?.candidateFields ?? []).filter(
      (c) => c.placement.y >= 243 && c.placement.y <= 253,
    );
    // NDC: w≈52pt, middle column in each section.
    const ndc = row2.filter((c) => c.placement.width >= 46 && c.placement.width <= 60);
    expect(ndc).toHaveLength(2);
  });

  // ── Row 3: PHARMACY NAME | PHARMACY NABP ───────────────────────────────────
  it('detects PHARMACY NAME fields (wide field in row 3, both sections)', async () => {
    const result = await analyzePdf(fixturePath);
    const page2 = result.pages[1];
    const row3 = (page2?.candidateFields ?? []).filter(
      (c) => c.placement.y >= 221 && c.placement.y <= 231,
    );
    // PHARMACY NAME: w≈259pt, each section.
    const pharmacyName = row3.filter((c) => c.placement.width >= 250 && c.placement.width <= 268);
    expect(pharmacyName).toHaveLength(2);
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
