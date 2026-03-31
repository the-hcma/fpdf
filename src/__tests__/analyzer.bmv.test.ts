// integration — Ohio BMV form fixture tests
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { analyzePdf } from '../analyzer.js';

// ---------------------------------------------------------------------------
// BMV 2336 — always-present fixture
//
// This is a 1-page Ohio BMV form with no AcroForm fields. All fillable areas
// are drawn as thin filled hairlines (~0.48pt) forming rectangular borders
// around each input field — a pattern the analyzer was previously blind to
// (it only detected the 3 stroked checkboxes).  After the filled-H-line fix,
// the grid reconstruction should pair the top/bottom hairlines and produce
// candidate text fields.
// ---------------------------------------------------------------------------

describe('BMV 2336 (no-AcroForm, filled-hairline borders)', () => {
  const fixturePath = path.join(__dirname, 'fixtures', 'bmv2336.pdf');

  it('classifies the document as no-acroform', async () => {
    const result = await analyzePdf(fixturePath);
    expect(result.metadata.pdfKind).toBe('no-acroform');
  });

  it('classifies page 1 as hybrid', async () => {
    const result = await analyzePdf(fixturePath);
    const page = result.pages[0];
    expect(page).toBeDefined();
    expect(page?.pageType).toBe('hybrid');
  });

  it('detects at least 20 candidate fields (filled-hairline fix)', async () => {
    const result = await analyzePdf(fixturePath);
    const candidates = result.pages[0]?.candidateFields ?? [];
    expect(candidates.length).toBeGreaterThanOrEqual(20);
  });

  it('detects text-type candidate fields, not only checkboxes', async () => {
    const result = await analyzePdf(fixturePath);
    const candidates = result.pages[0]?.candidateFields ?? [];
    const textFields = candidates.filter((c) => c.type === 'text' || c.type === 'textarea');
    expect(textFields.length).toBeGreaterThanOrEqual(10);
  });

  it('detects the 3 checkboxes from stroked rectangles', async () => {
    const result = await analyzePdf(fixturePath);
    const candidates = result.pages[0]?.candidateFields ?? [];
    const checkboxes = candidates.filter((c) => c.type === 'checkbox');
    expect(checkboxes).toHaveLength(3);
  });

  it('checkbox placements are large enough to click (margin fix)', async () => {
    const result = await analyzePdf(fixturePath);
    const candidates = result.pages[0]?.candidateFields ?? [];
    const checkboxes = candidates.filter((c) => c.type === 'checkbox');
    for (const cb of checkboxes) {
      expect(cb.placement.width).toBeGreaterThanOrEqual(5);
      expect(cb.placement.height).toBeGreaterThanOrEqual(5);
    }
  });

  it('text candidate fields have usable placement dimensions', async () => {
    const result = await analyzePdf(fixturePath);
    const candidates = result.pages[0]?.candidateFields ?? [];
    const textFields = candidates.filter((c) => c.type === 'text' || c.type === 'textarea');
    for (const f of textFields) {
      expect(f.placement.width).toBeGreaterThan(0);
      expect(f.placement.height).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// BMV 5745 — always-present fixture
//
// 2-page Ohio BMV form that uses a mix of stroked checkboxes (56/55 per page)
// and filled-hairline text field outlines.  After the fix, text fields should
// appear alongside the checkboxes.
// ---------------------------------------------------------------------------

describe('BMV 5745 (2-page, mixed stroke checkboxes + filled text fields)', () => {
  const fixturePath = path.join(__dirname, 'fixtures', 'bmv5745.pdf');

  it('classifies the document as no-acroform', async () => {
    const result = await analyzePdf(fixturePath);
    expect(result.metadata.pdfKind).toBe('no-acroform');
  });

  it('detects text candidate fields on both pages (filled-hairline fix)', async () => {
    const result = await analyzePdf(fixturePath);
    expect(result.pages).toHaveLength(2);
    for (const page of result.pages) {
      const textFields = page.candidateFields.filter(
        (c) => c.type === 'text' || c.type === 'textarea',
      );
      expect(textFields.length).toBeGreaterThanOrEqual(10);
    }
  });

  it('retains all stroked checkboxes on both pages', async () => {
    const result = await analyzePdf(fixturePath);
    for (const page of result.pages) {
      const checkboxes = page.candidateFields.filter((c) => c.type === 'checkbox');
      expect(checkboxes.length).toBeGreaterThanOrEqual(50);
    }
  });

  it('checkbox placements are large enough to click (margin fix)', async () => {
    const result = await analyzePdf(fixturePath);
    for (const page of result.pages) {
      for (const cb of page.candidateFields.filter((c) => c.type === 'checkbox')) {
        // Smallest checkbox in this PDF is ~6.96pt; with 1pt margin each side → ~4.96pt.
        // Before the fix, the 3pt margin left only ~0.96pt — effectively invisible.
        expect(cb.placement.width).toBeGreaterThanOrEqual(4);
        expect(cb.placement.height).toBeGreaterThanOrEqual(4);
      }
    }
  });

  // ── Gap-splitting regression guard ────────────────────────────────────────
  // Page 1 row at y≈434.6 has STATE (x≈25, w≈128) and ZIP (x≈159, w≈61) on
  // the same baseline.  Before the gap-splitting fix in extractTextBlocks, the
  // two labels were merged into one wide block; the ZIP cell had < 50% of that
  // block's area inside it, so insideBlocks=[empty] → defaultInset fired with
  // labelAtBottom=true → ZIP was shifted to the wrong y and fell outside the
  // visible row, effectively disappearing.  After the fix each label is its
  // own block, insideBlocks=[ZIP] at 100%, and both fields land at y≈434.6.
  it('detects both STATE and ZIP fields on the same address row (gap-splitting fix)', async () => {
    const result = await analyzePdf(fixturePath);
    const page1 = result.pages[0];
    expect(page1).toBeDefined();
    // Row at y≈434 contains STATE (w≈128pt) and ZIP (w≈61pt) side by side.
    const addressRow = (page1?.candidateFields ?? []).filter(
      (c) => c.placement.y >= 430 && c.placement.y <= 440,
    );
    expect(addressRow.length).toBeGreaterThanOrEqual(2);
    const stateField = addressRow.find((c) => c.placement.width >= 120 && c.placement.width <= 140);
    const zipField = addressRow.find((c) => c.placement.width >= 55 && c.placement.width <= 70);
    expect(stateField).toBeDefined();
    expect(zipField).toBeDefined();
  });

  // ── Full-field snapshot ───────────────────────────────────────────────────
  // Locks down the complete set of non-checkbox candidate fields (label + x/y
  // rounded to 1 decimal, width rounded to 1 decimal) detected across both
  // pages.  Any regression that drops a field, moves it to the wrong position,
  // or changes its label will cause this test to fail and require an explicit
  // snapshot update (`npx vitest run --update-snapshots`).
  it('detects the expected set of named text fields on both pages (snapshot)', async () => {
    const result = await analyzePdf(fixturePath);
    const snapshot = result.pages.map((page, pi) => {
      const fields = page.candidateFields
        .filter((c) => c.type !== 'checkbox')
        .sort((a, b) => b.placement.y - a.placement.y || a.placement.x - b.placement.x)
        .map((c) => ({
          page: pi + 1,
          label: c.label,
          x: Math.round(c.placement.x * 10) / 10,
          y: Math.round(c.placement.y * 10) / 10,
          w: Math.round(c.placement.width * 10) / 10,
        }));
      return fields;
    });
    expect(snapshot).toMatchSnapshot();
  });
});
