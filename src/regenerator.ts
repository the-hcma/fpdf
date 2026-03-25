import { readFile, writeFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { analyzePdf } from './analyzer.js';
import { logger } from './logger.js';
import type { FpdfDocument } from './types.js';

/**
 * Regenerate a PDF as a clean AcroForm-only file, stripping any XFA datasets.
 *
 * Steps:
 *  1. Copy all pages from the source PDF into a new pdf-lib document.
 *  2. Re-create each AcroForm field at its original position using the
 *     placement data stored in `doc`.
 *  3. Pre-fill the new fields with the values the user has already entered.
 *  4. Save the result as `<original>-acroform.pdf` in the same directory.
 *  5. Re-analyze the new PDF so the returned FpdfDocument has correct metadata
 *     (pdfKind: 'acroform', stable UUIDs, etc.).
 *
 * @param pdfPath  Absolute path to the source PDF (may be XFA hybrid or pure-XFA).
 * @param doc      The in-memory FpdfDocument for the current session, containing
 *                 field placements and any values entered so far.
 * @returns Paths to the new PDF + JSON files and the freshly analyzed FpdfDocument.
 */
export async function regenerateAsAcroForm(
  pdfPath: string,
  doc: FpdfDocument,
): Promise<{ newPdfPath: string; newJsonPath: string; newDoc: FpdfDocument }> {
  const bytes = await readFile(pdfPath);
  const srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const outDoc = await PDFDocument.create();

  // Copy all visual page content from the source PDF.
  const copiedPages = await outDoc.copyPages(srcDoc, srcDoc.getPageIndices());
  for (const p of copiedPages) outDoc.addPage(p);

  const form = outDoc.getForm();

  // ── Radio groups ─────────────────────────────────────────────────────────
  // Each radio widget is a separate PdfField entry sharing a `field.name`.
  // We must create one PDFRadioGroup per unique name, then add each widget
  // as an option whose name is the widget's `radioValue` (on-value string).
  // Using radioValue as the option name means the standard export path
  // (`acroField.select(storedValue)`) works without any XFA translation.

  const radioGroups = new Map<
    string,
    { field: (typeof doc.pages)[0]['fields'][0]; pageIdx: number }[]
  >();
  for (const pdfPage of doc.pages) {
    for (const f of pdfPage.fields) {
      if (f.type !== 'radio' || !f.radioValue) continue;
      const bucket = radioGroups.get(f.name) ?? [];
      bucket.push({ field: f, pageIdx: pdfPage.pageNumber - 1 });
      radioGroups.set(f.name, bucket);
    }
  }

  for (const [name, widgets] of radioGroups) {
    const group = form.createRadioGroup(name);
    for (const { field, pageIdx } of widgets) {
      const radioValue = field.radioValue ?? '';
      group.addOptionToPage(radioValue, outDoc.getPage(pageIdx), {
        x: field.placement.x,
        y: field.placement.y,
        width: field.placement.width,
        height: field.placement.height,
      });
    }
    // Pre-fill with the currently selected option.
    const currentValue = widgets.find(
      (w) => typeof w.field.value === 'string' && w.field.value !== '',
    )?.field.value;
    if (typeof currentValue === 'string' && currentValue !== '') {
      try {
        group.select(currentValue);
      } catch {
        // Option not found — leave unselected rather than throw.
      }
    }
  }

  // ── Other field types ────────────────────────────────────────────────────
  // Track created names to guard against duplicate field names across pages.
  const createdNames = new Set(radioGroups.keys());

  for (const pdfPage of doc.pages) {
    const page = outDoc.getPage(pdfPage.pageNumber - 1);
    for (const field of pdfPage.fields) {
      if (field.type === 'radio') continue; // already handled above
      if (createdNames.has(field.name)) continue; // deduplicate
      createdNames.add(field.name);

      const { x, y, width, height } = field.placement;

      if (field.type === 'text' || field.type === 'textarea') {
        const tf = form.createTextField(field.name);
        if (field.type === 'textarea') tf.enableMultiline();
        tf.addToPage(page, { x, y, width, height });
        if (typeof field.value === 'string' && field.value !== '') tf.setText(field.value);
      } else if (field.type === 'checkbox') {
        const cb = form.createCheckBox(field.name);
        cb.addToPage(page, { x, y, width, height });
        if (field.value === true) cb.check();
      } else {
        const dd = form.createDropdown(field.name);
        dd.setOptions(field.options);
        dd.addToPage(page, { x, y, width, height });
        if (typeof field.value === 'string' && field.value !== '') {
          try {
            dd.select(field.value);
          } catch {
            // Option not found — leave unselected.
          }
        }
      }
    }
  }

  // ── Save and re-analyze ───────────────────────────────────────────────────
  const base = pdfPath.replace(/\.pdf$/i, '');
  const newPdfPath = `${base}.fpdf-converted.acroform.pdf`;
  const newJsonPath = `${base}.fpdf-converted.acroform.fpdf.json`;

  await writeFile(newPdfPath, await outDoc.save());
  logger.info(`Generated standard AcroForm PDF from XFA source (${pdfPath}) → ${newPdfPath}`);

  const newDoc = await analyzePdf(newPdfPath);
  await writeFile(newJsonPath, JSON.stringify(newDoc, null, 2));

  return { newPdfPath, newJsonPath, newDoc };
}
