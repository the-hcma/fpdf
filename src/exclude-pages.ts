import type { PdfPage } from './types.js';

type PageExcludeState = Pick<PdfPage, 'pageNumber' | 'excluded'>;

/**
 * Returns `true` (should exclude) when at least one page after `pageNumber`
 * is not yet excluded, or `false` (should un-exclude) when all are already
 * excluded.  Returns `false` when there are no subsequent pages.
 */
export function getExcludeAllAfterTarget(
  pageNumber: number,
  pages: readonly PageExcludeState[],
): boolean {
  const subsequent = pages.filter((p) => p.pageNumber > pageNumber);
  if (subsequent.length === 0) return false;
  return !subsequent.every((p) => p.excluded ?? false);
}

/**
 * Sets `excluded` to `value` on every page whose `pageNumber` is greater
 * than `pageNumber`.  Mutates the objects in place so that any reference to
 * the same `PdfPage` object (e.g. inside `FpdfDocument.pages`) is updated
 * automatically.  Returns the page numbers that were actually changed.
 */
export function applyExcludeAfter(
  pageNumber: number,
  pages: PageExcludeState[],
  value: boolean,
): number[] {
  const changed: number[] = [];
  for (const p of pages) {
    if (p.pageNumber > pageNumber && (p.excluded ?? false) !== value) {
      p.excluded = value;
      changed.push(p.pageNumber);
    }
  }
  return changed;
}
