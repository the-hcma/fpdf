import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown } from 'pdf-lib';
import type { FpdfDocument } from './types.js';

/**
 * Load the original PDF, write all current field values from the FpdfDocument
 * back into its AcroForm, and return the resulting PDF bytes.
 *
 * Field names are matched by the raw AcroForm name stored in each PdfField.
 * Duplicate widget entries for the same field name (common for radio groups)
 * are processed only once. Fields whose names are no longer present in the PDF
 * are silently skipped.
 *
 * Note: radio button values are only applied when the stored value is a
 * non-empty string (the selected option). Boolean values written by the UI
 * do not carry enough information to identify the selected option and are
 * skipped; see the field model discussion in types.ts.
 */
export async function exportPdf(pdfPath: string, doc: FpdfDocument): Promise<Uint8Array> {
  const bytes = await readFile(pdfPath);
  const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const form = pdfDoc.getForm();

  const seen = new Set<string>();
  for (const page of doc.pages) {
    for (const field of page.fields) {
      if (seen.has(field.name)) continue;
      seen.add(field.name);

      try {
        const pdfField = form.getField(field.name);

        if (pdfField instanceof PDFTextField) {
          pdfField.setText(typeof field.value === 'string' ? field.value : '');
        } else if (pdfField instanceof PDFCheckBox) {
          if (field.value === true) pdfField.check();
          else pdfField.uncheck();
        } else if (pdfField instanceof PDFRadioGroup) {
          // Only apply when we have a concrete option string (initial value from
          // analysis).  Boolean values set by the UI lack the option name.
          if (typeof field.value === 'string' && field.value !== '') {
            pdfField.select(field.value);
          }
        } else if (pdfField instanceof PDFDropdown) {
          if (typeof field.value === 'string' && field.value !== '') {
            pdfField.select(field.value);
          }
        }
      } catch {
        // Field name absent from PDF (e.g. after a schema migration) — skip.
      }
    }
  }

  return pdfDoc.save();
}
