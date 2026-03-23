import { readFile } from 'node:fs/promises';
import {
  PDFDocument,
  PDFTextField,
  PDFCheckBox,
  PDFRadioGroup,
  PDFDropdown,
  PDFRef,
  PDFName,
  PDFDict,
} from 'pdf-lib';
import type { FpdfDocument } from './types.js';
import { getXfaDatasetsInfo, patchXfaDatasetsXml, writeXfaDatasetsStream } from './analyzer.js';

/**
 * Load the original PDF, write all current field values from the FpdfDocument
 * back into it, and return the resulting PDF bytes.
 *
 * # XFA hybrid PDFs  (e.g. Cigna insurance forms)
 *
 * XFA PDFs embed two parallel representations of form data:
 *   - /AcroForm widgets  — used by non-XFA viewers (PDF.js without XFA, Preview)
 *   - /AcroForm/XFA datasets XML  — used by XFA-capable viewers (Chrome ≥ 108,
 *     Acrobat, Edge) which render the XFA template using values from the datasets
 *
 * For these PDFs we fill BOTH representations in a single pdf-lib save() call:
 *
 *   Step 1 — Patch the XFA datasets stream in-memory (writeXfaDatasetsStream) so
 *     that XFA-capable viewers (Acrobat, Edge) see the updated field values.
 *
 *   Step 2 — Capture the /XFA entry from the AcroForm dict before getForm()
 *     strips it.  pdf-lib's getForm() calls form.deleteXFA() internally, which
 *     removes /XFA from the in-memory AcroForm dict.
 *
 *   Step 3 — Fill AcroForm widgets with pdf-lib's form API so that non-XFA
 *     viewers (Chrome, Preview) see the correct values.  Radio buttons require
 *     translating the stored on-value ('0', '1', …) to the /Opt option name
 *     ('Yes', 'No', …) because PDFRadioGroup.select() accepts only option names.
 *
 *   Step 4 — Call form.updateFieldAppearances() explicitly.  At this point /XFA
 *     is already gone from the in-memory dict (stripped by getForm()), so
 *     updateFieldAppearances() will NOT call deleteXFA() a second time — it is
 *     safe to invoke here.
 *
 *   Step 5 — Restore /XFA on the AcroForm dict so the entry survives into the
 *     saved bytes.
 *
 *   Step 6 — save({ useObjectStreams: false, updateFieldAppearances: false })
 *     - useObjectStreams: false → pdf-lib calls copyBytesInto() on every object,
 *       including the AcroForm dict, so the restored /XFA entry is serialised.
 *       With useObjectStreams: true (default) the AcroForm dict lives in a
 *       compressed ObjStm whose original bytes are reused verbatim — any
 *       in-memory changes (including the /XFA restore) are silently dropped.
 *     - updateFieldAppearances: false → suppresses the second internal getForm()
 *       call inside save(), which would otherwise strip /XFA again.
 *
 * # Pure AcroForm PDFs  (no XFA)
 *
 * Use pdf-lib's form API (getField / setText / check / select) to fill widgets.
 * Field names are matched by the raw AcroForm name stored in each PdfField.
 * Duplicate widget entries for the same field name (common for radio groups) are
 * processed only once.  Fields absent from the PDF are silently skipped.
 *
 * Note: radio button values are only applied when the stored value is a non-empty
 * string (the selected option identity).  Boolean values written by the UI lack
 * the option name and are skipped; see types.ts for the field value model.
 */
export async function exportPdf(pdfPath: string, doc: FpdfDocument): Promise<Uint8Array> {
  const bytes = await readFile(pdfPath);
  const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });

  // Check for XFA BEFORE calling getForm() — pdf-lib deletes /AcroForm/XFA
  // when getForm() is called, so we must check and patch first.
  const xfaInfo = getXfaDatasetsInfo(pdfDoc);

  const allValues = new Map<string, string | boolean>();
  for (const page of doc.pages) {
    for (const field of page.fields) {
      if (!allValues.has(field.name)) allValues.set(field.name, field.value);
    }
  }

  if (xfaInfo !== null) {
    // ── XFA hybrid PDF ───────────────────────────────────────────────────────
    //
    // Step 1: Patch the XFA datasets stream in-memory.
    const patchedXml = patchXfaDatasetsXml(xfaInfo.xml, allValues);
    writeXfaDatasetsStream(pdfDoc, xfaInfo.ref, patchedXml);

    // Step 2: Capture the raw /XFA entry from AcroForm BEFORE getForm() strips it.
    const acroFormEntry = pdfDoc.catalog.get(PDFName.of('AcroForm'));
    const acroForm =
      acroFormEntry instanceof PDFRef ? pdfDoc.context.lookup(acroFormEntry) : acroFormEntry;
    const xfaValue = acroForm instanceof PDFDict ? acroForm.get(PDFName.of('XFA')) : undefined;

    // Step 3: Fill AcroForm widget values (getForm() strips /XFA internally).
    writeAcroFormValues(pdfDoc, allValues, /* isXfa */ true);

    // Step 4: Generate widget appearances now that /XFA is already absent from
    // the in-memory dict — a second deleteXFA() call inside updateFieldAppearances
    // is a no-op since /XFA is already gone.
    pdfDoc.getForm().updateFieldAppearances();

    // Step 5: Restore /XFA so it is serialised into the output bytes.
    if (acroForm instanceof PDFDict && xfaValue !== undefined) {
      acroForm.set(PDFName.of('XFA'), xfaValue);
    }

    // Step 6: Save without ObjStm compression so every in-memory dict change
    // (including the restored /XFA) is written via copyBytesInto().
    return pdfDoc.save({ useObjectStreams: false, updateFieldAppearances: false });
  } else {
    // ── Pure AcroForm PDF ─────────────────────────────────────────────────────
    writeAcroFormValues(pdfDoc, allValues, /* isXfa */ false);
  }

  return pdfDoc.save();
}

/**
 * Write field values into the AcroForm widgets of `pdfDoc`.
 *
 * @param isXfa  When true the PDF is an XFA hybrid.  Radio buttons in XFA
 *   hybrid PDFs store on-values ('0', '1', …) rather than option names
 *   ('Yes', 'No', …).  PDFRadioGroup.select() only accepts option names, so
 *   we translate via the widget on-value array: stored value → index in
 *   getOnValues() → option name at that index in getOptions().
 */
function writeAcroFormValues(
  pdfDoc: PDFDocument,
  values: Map<string, string | boolean>,
  isXfa: boolean,
): void {
  const form = pdfDoc.getForm();
  for (const [name, value] of values) {
    try {
      const pdfField = form.getField(name);

      if (pdfField instanceof PDFTextField) {
        pdfField.setText(typeof value === 'string' ? value : '');
      } else if (pdfField instanceof PDFCheckBox) {
        // Generate /AP /N appearance entries BEFORE check()/uncheck().
        // XFA checkbox widgets have no /AP /N entries (XFA renders its own
        // appearance), so widget.getOnValue() returns undefined.  check() then
        // calls setValue(), which compares undefined === /Yes → false and sets
        // /AS = /Off — leaving the checkbox visually unchecked even though
        // /V = /Yes.  Calling updateAppearances() first creates the /AP /N
        // /Yes entry, making getOnValue() return /Yes so setValue() correctly
        // sets /AS = /Yes.  Safe for non-XFA checkboxes too (just regenerates).
        pdfField.updateAppearances();
        if (value === true) pdfField.check();
        else pdfField.uncheck();
      } else if (pdfField instanceof PDFRadioGroup) {
        if (typeof value !== 'string' || value === '') continue;

        if (isXfa) {
          // XFA hybrid radio groups store on-values (e.g. '0', '1') in the
          // fpdf.json, but PDFRadioGroup.select() expects the /Opt option name
          // (e.g. 'Yes', 'No').  Translate via index: find the position of
          // the stored on-value in getOnValues(), then use that index to look
          // up the option name from getOptions().
          // acroField.getOnValues() returns PDFName[] (e.g. [/0, /1]), not
          // plain strings.  The stored value is the on-value string without
          // the leading slash (e.g. '1').  Compare via PDFName.toString() so
          // '/1' === '/1' instead of PDFName === '1' which always mismatches.
          const acroField = (
            pdfField as unknown as {
              acroField: { getOnValues(): { toString(): string }[] };
            }
          ).acroField;
          const onValues = acroField.getOnValues();
          const targetName = PDFName.of(value).toString(); // e.g. '/1'
          const idx = onValues.findIndex((v) => v.toString() === targetName);
          if (idx !== -1) {
            const optionName = pdfField.getOptions()[idx];
            if (optionName !== undefined) {
              pdfField.select(optionName);
            }
          } else {
            // Value may already be an option name — try directly.
            try {
              pdfField.select(value);
            } catch {
              // Not a valid option name either — skip.
            }
          }
        } else {
          pdfField.select(value);
        }
      } else if (pdfField instanceof PDFDropdown) {
        if (typeof value === 'string' && value !== '') {
          pdfField.select(value);
        }
      }
    } catch {
      // Field name absent from PDF (e.g. after a schema migration) — skip.
    }
  }
}
