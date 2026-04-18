import { describe, it, expect } from 'vitest';
import { getExcludeAllAfterTarget, applyExcludeAfter } from '../exclude-pages.js';

describe('getExcludeAllAfterTarget', () => {
  it('returns true when at least one subsequent page is not excluded', () => {
    const pages = [
      { pageNumber: 1, excluded: true },
      { pageNumber: 2, excluded: false },
      { pageNumber: 3, excluded: true },
    ];
    expect(getExcludeAllAfterTarget(1, pages)).toBe(true);
  });

  it('returns false when all subsequent pages are already excluded', () => {
    const pages = [
      { pageNumber: 1, excluded: true },
      { pageNumber: 2, excluded: true },
      { pageNumber: 3, excluded: true },
    ];
    expect(getExcludeAllAfterTarget(1, pages)).toBe(false);
  });

  it('returns false when there are no subsequent pages', () => {
    const pages = [{ pageNumber: 3, excluded: true }];
    expect(getExcludeAllAfterTarget(3, pages)).toBe(false);
  });

  it('treats a missing excluded field as false (not excluded)', () => {
    const pages = [
      { pageNumber: 1, excluded: true },
      { pageNumber: 2 }, // excluded property absent → treated as false
    ];
    expect(getExcludeAllAfterTarget(1, pages)).toBe(true);
  });

  it('ignores pages at or before the given page number', () => {
    const pages = [
      { pageNumber: 1, excluded: false },
      { pageNumber: 2, excluded: false },
      { pageNumber: 3, excluded: false },
    ];
    // Pages 1–2 are before/at page 2, only page 3 matters
    expect(getExcludeAllAfterTarget(2, pages)).toBe(true);
  });
});

describe('applyExcludeAfter', () => {
  it('sets excluded=true on all subsequent pages and returns changed page numbers', () => {
    const pages = [
      { pageNumber: 1, excluded: true },
      { pageNumber: 2, excluded: false },
      { pageNumber: 3, excluded: false },
    ];
    const changed = applyExcludeAfter(1, pages, true);
    expect(changed).toEqual([2, 3]);
    expect(pages[0]?.excluded).toBe(true); // page 1 unchanged
    expect(pages[1]?.excluded).toBe(true);
    expect(pages[2]?.excluded).toBe(true);
  });

  it('sets excluded=false on all subsequent pages and returns changed page numbers', () => {
    const pages = [
      { pageNumber: 1, excluded: true },
      { pageNumber: 2, excluded: true },
      { pageNumber: 3, excluded: true },
    ];
    const changed = applyExcludeAfter(1, pages, false);
    expect(changed).toEqual([2, 3]);
    expect(pages[0]?.excluded).toBe(true); // page 1 unchanged
    expect(pages[1]?.excluded).toBe(false);
    expect(pages[2]?.excluded).toBe(false);
  });

  it('skips pages already at the target value and omits them from changed', () => {
    const pages = [
      { pageNumber: 1, excluded: true },
      { pageNumber: 2, excluded: true }, // already excluded
      { pageNumber: 3, excluded: false },
    ];
    const changed = applyExcludeAfter(1, pages, true);
    expect(changed).toEqual([3]);
  });

  it('does not mutate pages at or before the given page number', () => {
    const pages = [
      { pageNumber: 2, excluded: true },
      { pageNumber: 3, excluded: false },
    ];
    applyExcludeAfter(2, pages, true);
    expect(pages[0]?.excluded).toBe(true); // page 2 untouched
    expect(pages[1]?.excluded).toBe(true); // page 3 updated
  });

  it('mutates objects in place so docPage references stay in sync', () => {
    const page2 = { pageNumber: 2, excluded: false };
    const pages = [{ pageNumber: 1, excluded: true }, page2];
    applyExcludeAfter(1, pages, true);
    // The same object reference should be updated, mirroring how FpdfDocument.pages works
    expect(page2.excluded).toBe(true);
  });

  it('returns an empty array when there are no subsequent pages', () => {
    const pages = [{ pageNumber: 1, excluded: false }];
    expect(applyExcludeAfter(1, pages, true)).toHaveLength(0);
    expect(pages[0]?.excluded).toBe(false); // unchanged
  });
});

describe('getExcludeAllAfterTarget + applyExcludeAfter toggle roundtrip', () => {
  it('correctly excludes then un-excludes on two successive clicks', () => {
    const pages = [
      { pageNumber: 1, excluded: true },
      { pageNumber: 2, excluded: false },
      { pageNumber: 3, excluded: false },
    ];

    // First click: at least one subsequent page is not excluded → should exclude
    const firstTarget = getExcludeAllAfterTarget(1, pages);
    expect(firstTarget).toBe(true);
    applyExcludeAfter(1, pages, firstTarget);
    expect(pages[1]?.excluded).toBe(true);
    expect(pages[2]?.excluded).toBe(true);

    // Second click: all subsequent pages are now excluded → should un-exclude
    const secondTarget = getExcludeAllAfterTarget(1, pages);
    expect(secondTarget).toBe(false);
    applyExcludeAfter(1, pages, secondTarget);
    expect(pages[1]?.excluded).toBe(false);
    expect(pages[2]?.excluded).toBe(false);

    // Third click should behave like the first again
    const thirdTarget = getExcludeAllAfterTarget(1, pages);
    expect(thirdTarget).toBe(true);
  });

  it('reflects the correct JSON state (docPage.excluded) after each toggle', () => {
    const docPages = [
      { pageNumber: 1, excluded: true },
      { pageNumber: 2, excluded: false },
      { pageNumber: 3, excluded: false },
      { pageNumber: 4, excluded: false },
    ];
    // Simulate: user clicks "+ all after" on page 1
    applyExcludeAfter(1, docPages, getExcludeAllAfterTarget(1, docPages));
    expect(docPages[1]?.excluded).toBe(true);
    expect(docPages[2]?.excluded).toBe(true);
    expect(docPages[3]?.excluded).toBe(true);

    // Simulate: user manually unchecks page 3
    const page3 = docPages.find((p) => p.pageNumber === 3);
    if (page3) page3.excluded = false;

    // Now page 1's "all after" should see page 3 as not excluded → target = exclude again
    expect(getExcludeAllAfterTarget(1, docPages)).toBe(true);

    // Simulate: user clicks button again (re-excludes page 3)
    applyExcludeAfter(1, docPages, true);
    expect(docPages[2]?.excluded).toBe(true); // page 3 re-excluded
  });
});
