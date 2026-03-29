import { readFile } from 'node:fs/promises';
import {
  PDFDocument,
  PDFFont,
  PDFTextField,
  PDFCheckBox,
  PDFRadioGroup,
  PDFDropdown,
  PDFRef,
  PDFName,
  PDFNumber,
  PDFDict,
  PDFArray,
  PDFString,
  PDFHexString,
  PDFAcroText,
  PDFAcroCheckBox,
  StandardFonts,
  TextAlignment,
  rgb,
} from 'pdf-lib';

const MAX_FONT_SIZE = 12; // pt — hard cap for all text fields
const MIN_FONT_SIZE = 4; // pt — lower bound; matches pdf-lib's internal minimum
const FIELD_PADDING = 2; // pt — inner margin assumed on each side
import type { CandidateField, FpdfDocument, PdfKind } from './types.js';
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

  // Determine XFA branch using the stored pdfKind when available (new .fpdf.json).
  // Fall back to runtime detection for old files that predate the pdfKind field.
  const storedKind = doc.metadata.pdfKind;
  const isXfaKind: boolean | null =
    storedKind === undefined
      ? null // unknown: detect at runtime below
      : storedKind === 'xfa-hybrid' || storedKind === 'pure-xfa';

  // Only call getXfaDatasetsInfo when we don't already know it's non-XFA.
  // Must happen BEFORE getForm() — pdf-lib deletes /AcroForm/XFA on getForm().
  const xfaInfo = isXfaKind === false ? null : getXfaDatasetsInfo(pdfDoc);
  const isXfa = isXfaKind ?? xfaInfo !== null;

  const allValues = new Map<string, string | boolean>();
  const allAlignments = new Map<string, string>();
  for (const page of doc.pages) {
    for (const field of page.fields) {
      if (!allValues.has(field.name)) allValues.set(field.name, field.value);
      if (field.textAlign && !allAlignments.has(field.name))
        allAlignments.set(field.name, field.textAlign);
    }
  }

  // Embed Helvetica once — used both for font-size measurement and for
  // updateFieldAppearances().  Passing a font explicitly to
  // updateFieldAppearances ensures appearances are always regenerated
  // (pdf-lib silently skips fields whose original font it cannot load).
  // Must happen before getForm() is called on the XFA path (getForm()
  // strips /XFA from the in-memory AcroForm dict).
  const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const { fontSizes, noScrollDisable } = buildFontSizeMap(doc, allValues, helv);

  // Candidate fields: create real AcroForm widgets for non-XFA PDFs.
  // For XFA PDFs, fall back to stamped text — calling getForm() before the XFA
  // branch captures /XFA would strip it from the in-memory AcroForm dict.
  if (isXfa) {
    await drawCandidateValues(pdfDoc, doc);
  } else {
    createCandidateWidgets(pdfDoc, doc);
  }

  if (isXfa && xfaInfo !== null) {
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
    writeAcroFormValues(pdfDoc, allValues, allAlignments, fontSizes, noScrollDisable, 'xfa-hybrid');

    // Step 4: Generate widget appearances now that /XFA is already absent from
    // the in-memory dict — a second deleteXFA() call inside updateFieldAppearances
    // is a no-op since /XFA is already gone.  Pass helv explicitly so pdf-lib
    // can always render (avoids silent skips for fields with custom fonts).
    pdfDoc.getForm().updateFieldAppearances(helv);

    // Step 5: Restore /XFA so it is serialised into the output bytes.
    if (acroForm instanceof PDFDict && xfaValue !== undefined) {
      acroForm.set(PDFName.of('XFA'), xfaValue);
    }

    // Step 6: Save without ObjStm compression so every in-memory dict change
    // (including the restored /XFA) is written via copyBytesInto().
    return pdfDoc.save({ useObjectStreams: false, updateFieldAppearances: false });
  } else {
    // ── Pure AcroForm PDF ─────────────────────────────────────────────────────
    // Phase 1: fill fields registered in the AcroForm field tree.
    writeAcroFormValues(pdfDoc, allValues, allAlignments, fontSizes, noScrollDisable, 'acroform');
    // Phase 2: fill orphan widget annotations (present in page /Annots but not
    // in the AcroForm field tree — common in XFA-derived PDFs).  Each orphan
    // widget's appearance is regenerated inside this function using helv.
    writeOrphanWidgetValues(pdfDoc, allValues, allAlignments, fontSizes, noScrollDisable, helv);
    // Regenerate appearances for AcroForm-tree fields.
    pdfDoc.getForm().updateFieldAppearances(helv);
  }

  // updateFieldAppearances: false — we already ran it explicitly above with
  // helv so every field is guaranteed to have a rendered appearance stream.
  return pdfDoc.save({ updateFieldAppearances: false });
}

/**
 * Count the number of lines produced by word-wrapping `text` to `maxWidth` at
 * `size` points.  Explicit `\n` characters are always treated as line breaks.
 */
function wrapTextLineCount(text: string, maxWidth: number, size: number, font: PDFFont): number {
  let count = 0;
  for (const para of text.split('\n')) {
    if (para === '' || font.widthOfTextAtSize(para, size) <= maxWidth) {
      count += 1;
      continue;
    }
    let line = '';
    for (const word of para.split(' ')) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
      } else {
        if (line) count += 1;
        line = word;
      }
    }
    if (line) count += 1;
  }
  return Math.max(1, count);
}

/**
 * Return the largest font size in [MIN_FONT_SIZE, MAX_FONT_SIZE] at which
 * `value` fits inside a field of `fieldWidth × fieldHeight` points.
 *
 * For single-line fields the text must not exceed the available width.
 * For multiline fields the word-wrapped line count must not exceed available height.
 */
function computeTextFontSize(
  value: string,
  fieldWidth: number,
  fieldHeight: number,
  multiline: boolean,
  font: PDFFont,
): number {
  const availW = fieldWidth - FIELD_PADDING * 2;
  const availH = fieldHeight - FIELD_PADDING * 2;

  if (!multiline) {
    // Round availH to 1 decimal to avoid float noise (e.g. 15.6 - 4 = 11.60000…2).
    let size = Math.round(Math.min(MAX_FONT_SIZE, availH) * 10) / 10;
    while (size > MIN_FONT_SIZE && font.widthOfTextAtSize(value, size) > availW) {
      size -= 0.5;
    }
    return Math.max(MIN_FONT_SIZE, size);
  }

  for (let size = MAX_FONT_SIZE; size >= MIN_FONT_SIZE; size -= 0.5) {
    const lineCount = wrapTextLineCount(value, availW, size, font);
    if (lineCount * (size * 1.3) <= availH) return size;
  }
  return MIN_FONT_SIZE;
}

/**
 * Build a map of field name → computed font size for every text/textarea field
 * in `doc` that has a non-empty string value.  Uses Helvetica metrics as a
 * representative approximation for standard AcroForm fields.
 *
 * Also returns a set of field names where the text still overflows even at the
 * minimum font size — those fields should NOT have scrolling disabled, so that
 * PDF viewers show the content as scrollable rather than hard-clipping it.
 */
function buildFontSizeMap(
  doc: FpdfDocument,
  allValues: Map<string, string | boolean>,
  font: PDFFont,
): { fontSizes: Map<string, number>; noScrollDisable: Set<string> } {
  const fontSizes = new Map<string, number>();
  const noScrollDisable = new Set<string>();

  for (const page of doc.pages) {
    for (const field of page.fields) {
      if (field.type !== 'text' && field.type !== 'textarea') continue;
      if (fontSizes.has(field.name)) continue; // first definition wins
      const value = allValues.get(field.name);
      if (typeof value !== 'string' || value === '') continue;
      const size = computeTextFontSize(
        value,
        field.placement.width,
        field.placement.height,
        field.type === 'textarea',
        font,
      );
      fontSizes.set(field.name, size);
      // If the text still overflows at the computed (minimum) font size,
      // leave scrolling enabled so viewers scroll rather than hard-clip.
      if (
        field.type !== 'textarea' &&
        font.widthOfTextAtSize(value, size) > field.placement.width - FIELD_PADDING * 2
      ) {
        noScrollDisable.add(field.name);
      }
    }
  }
  return { fontSizes, noScrollDisable };
}

/**
 * Stamp candidate field values directly onto the page as drawn text.
 * Used for PDFs that have no AcroForm widgets (vector/no-acroform PDFs).
 * Each candidate field with a non-empty value gets a text overlay drawn at
 * the field's placement rectangle.  Checkboxes get an "X" when checked.
 */
async function drawCandidateValues(pdfDoc: PDFDocument, doc: FpdfDocument): Promise<void> {
  const hasCandidates = doc.pages.some((p) => p.candidateFields.some((c) => !c.dismissed));
  if (!hasCandidates) return;

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const COLOR = rgb(0, 0, 0);
  const TEXT_PADDING = 2; // pt from the left/bottom edge of the field

  for (const docPage of doc.pages) {
    const candidatesWithValues = docPage.candidateFields.filter((c) => {
      if (c.dismissed) return false;
      if (c.type === 'checkbox') return c.value === true;
      return typeof c.value === 'string' && c.value.trim() !== '';
    });
    if (candidatesWithValues.length === 0) continue;

    // pdf-lib pages are 1-indexed via getPage(index) where index is 0-based.
    const page = pdfDoc.getPage(docPage.pageNumber - 1);

    for (const candidate of candidatesWithValues) {
      const { x, y, width, height } = candidate.placement;
      const fontSize = Math.max(6, Math.round(height * 0.7));

      if (candidate.type === 'checkbox') {
        // Draw a centred "X" for checked checkboxes.
        const mark = 'X';
        const markSize = Math.max(6, Math.round(height * 0.8));
        page.drawText(mark, {
          x: x + (width - font.widthOfTextAtSize(mark, markSize)) / 2,
          y: y + (height - markSize) / 2,
          size: markSize,
          font,
          color: COLOR,
        });
      } else {
        const value = candidate.value as string;
        // Clamp the font size so the text fits within the field width.
        let size = fontSize;
        while (size > 6 && font.widthOfTextAtSize(value, size) > width - TEXT_PADDING * 2) {
          size -= 0.5;
        }
        const textWidth = font.widthOfTextAtSize(value, size);
        let textX: number;
        if (candidate.textAlign === 'center') {
          textX = x + (width - textWidth) / 2;
        } else if (candidate.textAlign === 'right') {
          textX = x + width - textWidth - TEXT_PADDING;
        } else {
          textX = x + TEXT_PADDING;
        }
        page.drawText(value, {
          x: textX,
          y: y + TEXT_PADDING,
          size,
          font,
          color: COLOR,
          maxWidth: width - TEXT_PADDING * 2,
        });
      }
    }
  }
}

/**
 * Sanitize a display name into a valid AcroForm field name and deduplicate it
 * within the set of already-used names by appending _1, _2, … as needed.
 */
function uniqueFieldName(base: string, used: Set<string>): string {
  const safe = base.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'Field';
  if (!used.has(safe)) {
    used.add(safe);
    return safe;
  }
  for (let i = 1; ; i++) {
    const candidate = `${safe}_${String(i)}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

/**
 * Create real AcroForm widget annotations for all non-dismissed candidate fields.
 * Used for non-XFA PDFs (vector, raster, hybrid) where candidates have no
 * existing AcroForm backing. Radio candidates sharing a groupName are grouped
 * into a single PDFRadioGroup.
 */
function createCandidateWidgets(pdfDoc: PDFDocument, doc: FpdfDocument): void {
  const hasCandidates = doc.pages.some((p) => p.candidateFields.some((c) => !c.dismissed));
  if (!hasCandidates) return;

  const form = pdfDoc.getForm();
  const usedNames = new Set<string>();

  // Collect radio candidates grouped by groupName first so we can create each
  // PDFRadioGroup once and add all its widgets in a single pass.
  const radioGroups = new Map<string, { candidate: CandidateField; pageIdx: number }[]>();
  for (const docPage of doc.pages) {
    for (const c of docPage.candidateFields) {
      if (c.dismissed || c.type !== 'radio') continue;
      const key = c.groupName ?? c.id;
      if (!radioGroups.has(key)) radioGroups.set(key, []);
      const group = radioGroups.get(key);
      if (group) group.push({ candidate: c, pageIdx: docPage.pageNumber - 1 });
    }
  }

  for (const [groupKey, buttons] of radioGroups) {
    const name = uniqueFieldName(groupKey, usedNames);
    const rg = form.createRadioGroup(name);
    let selectedOption: string | undefined;
    for (const { candidate: c, pageIdx } of buttons) {
      const optVal = c.radioValue ?? 'option';
      rg.addOptionToPage(optVal, pdfDoc.getPage(pageIdx), c.placement);
      if (typeof c.value === 'string' && c.value === c.radioValue) selectedOption = optVal;
    }
    if (selectedOption !== undefined) rg.select(selectedOption);
  }

  // Text, textarea, and checkbox candidates — processed per page in order.
  for (const docPage of doc.pages) {
    const page = pdfDoc.getPage(docPage.pageNumber - 1);
    for (const c of docPage.candidateFields) {
      if (c.dismissed || c.type === 'radio') continue;
      const name = uniqueFieldName(c.displayName || c.label || 'Field', usedNames);
      const { x, y, width, height } = c.placement;
      if (c.type === 'checkbox') {
        const cb = form.createCheckBox(name);
        cb.addToPage(page, { x, y, width, height });
        if (c.value === true) cb.check();
      } else {
        const tf = form.createTextField(name);
        if (c.type === 'textarea') tf.enableMultiline();
        tf.addToPage(page, { x, y, width, height });
        if (typeof c.value === 'string' && c.value !== '') tf.setText(c.value);
        const align = toTextAlignment(c.textAlign);
        if (align !== undefined) tf.setAlignment(align);
      }
    }
  }
}

/**
 * Write field values into the AcroForm widgets of `pdfDoc`.
 *
 * @param pdfKind  Document-level PDF kind.  Radio buttons in XFA hybrid PDFs
 *   store on-values ('0', '1', …) rather than option names ('Yes', 'No', …).
 *   PDFRadioGroup.select() only accepts option names, so we translate via the
 *   widget on-value array: stored value → index in getOnValues() → option name
 *   at that index in getOptions().
 */
function toTextAlignment(align: string | undefined): TextAlignment | undefined {
  if (align === 'center') return TextAlignment.Center;
  if (align === 'right') return TextAlignment.Right;
  if (align === 'left') return TextAlignment.Left;
  return undefined; // 'justify' and undefined: leave the field's existing alignment
}

function writeAcroFormValues(
  pdfDoc: PDFDocument,
  values: Map<string, string | boolean>,
  alignments: Map<string, string>,
  fontSizes: Map<string, number>,
  noScrollDisable: Set<string>,
  pdfKind: PdfKind,
): void {
  const form = pdfDoc.getForm();
  for (const [name, value] of values) {
    try {
      const pdfField = form.getField(name);

      if (pdfField instanceof PDFTextField) {
        pdfField.setText(typeof value === 'string' ? value : '');
        const alignment = toTextAlignment(alignments.get(name));
        if (alignment !== undefined) pdfField.setAlignment(alignment);
        const fontSize = fontSizes.get(name);
        if (fontSize !== undefined) pdfField.setFontSize(fontSize);
        // Disable scrolling so viewers don't render a scroll bar — but only
        // when the text actually fits at the computed font size.  For fields
        // where the text overflows even at the minimum size, leave scrolling
        // enabled so viewers scroll/truncate rather than hard-clipping.
        if (!noScrollDisable.has(name)) pdfField.disableScrolling();
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

        if (pdfKind === 'xfa-hybrid' || pdfKind === 'pure-xfa') {
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

/**
 * Decode a /T (field name) value from a widget annotation dict.
 * /T may be a PDFString, PDFHexString, or PDFName.
 */
function decodeFieldName(t: unknown): string | undefined {
  if (t instanceof PDFString || t instanceof PDFHexString) return t.decodeText();
  return undefined;
}

/**
 * Write field values into orphan widget annotations — widget annotations that
 * appear in a page's /Annots array but are NOT linked to the AcroForm field
 * tree (no /Parent pointer).  This is common in XFA-derived PDFs and some
 * third-party form builders where the form fields are stored directly as page
 * annotations without being registered in /AcroForm/Fields.
 *
 * For each matching widget we create a lightweight pdf-lib field wrapper,
 * set the value, apply font size, and regenerate the appearance stream so the
 * text is visible in all viewers (not just ones that honour NeedAppearances).
 */
function writeOrphanWidgetValues(
  pdfDoc: PDFDocument,
  values: Map<string, string | boolean>,
  alignments: Map<string, string>,
  fontSizes: Map<string, number>,
  noScrollDisable: Set<string>,
  helv: PDFFont,
): void {
  for (let pageIdx = 0; pageIdx < pdfDoc.getPageCount(); pageIdx++) {
    const page = pdfDoc.getPage(pageIdx);
    const annotsRaw = page.node.get(PDFName.of('Annots'));
    if (!annotsRaw) continue;
    const annots = annotsRaw instanceof PDFRef ? pdfDoc.context.lookup(annotsRaw) : annotsRaw;
    if (!(annots instanceof PDFArray)) continue;

    for (let i = 0; i < annots.size(); i++) {
      try {
        const annotEntry = annots.get(i);
        const annotRef = annotEntry instanceof PDFRef ? annotEntry : undefined;
        if (!annotRef) continue;
        const annotDict = pdfDoc.context.lookup(annotRef);
        if (!(annotDict instanceof PDFDict)) continue;

        // Only Widget annotations
        const subtype = annotDict.get(PDFName.of('Subtype'));
        if (!(subtype instanceof PDFName) || subtype.asString() !== '/Widget') continue;

        // Orphan widgets have no /Parent — skip widgets already in the tree.
        if (annotDict.get(PDFName.of('Parent'))) continue;

        // Resolve field name from /T
        const name = decodeFieldName(annotDict.get(PDFName.of('T')));
        if (!name || !values.has(name)) continue;

        const value = values.get(name);
        if (value === undefined) continue;

        // Resolve field type (FT may be inherited but for orphan root widgets
        // it is almost always present directly).
        const ftRaw = annotDict.get(PDFName.of('FT'));
        if (!(ftRaw instanceof PDFName)) continue;
        const ft = ftRaw.asString();

        if (ft === '/Tx') {
          // ── Text / textarea ─────────────────────────────────────────────
          const acroText = PDFAcroText.fromDict(annotDict, annotRef);
          const textField = PDFTextField.of(acroText, annotRef, pdfDoc);
          textField.setText(typeof value === 'string' ? value : '');
          const alignment = toTextAlignment(alignments.get(name));
          if (alignment !== undefined) textField.setAlignment(alignment);
          const fontSize = fontSizes.get(name);
          if (fontSize !== undefined) {
            try {
              textField.setFontSize(fontSize);
            } catch {
              // Field has no /DA with Tf operator — skip font-size override.
            }
          }
          if (!noScrollDisable.has(name)) {
            try {
              textField.disableScrolling();
            } catch {
              // Not all widgets support scrolling flags — safe to skip.
            }
          }
          textField.updateAppearances(helv);
        } else if (ft === '/Btn') {
          // ── Checkbox ────────────────────────────────────────────────────
          // Distinguish checkbox from radio/pushbutton via field flags.
          const ffRaw = annotDict.get(PDFName.of('Ff'));
          const ff = ffRaw instanceof PDFNumber ? ffRaw.asNumber() : 0;
          const isRadio = (ff & 0x8000) !== 0;
          const isPushButton = (ff & 0x10000) !== 0;
          if (isRadio || isPushButton) continue;

          const acroCheckBox = PDFAcroCheckBox.fromDict(annotDict, annotRef);
          const checkBox = PDFCheckBox.of(acroCheckBox, annotRef, pdfDoc);
          checkBox.updateAppearances();
          if (value === true) checkBox.check();
          else checkBox.uncheck();
        }
      } catch {
        // Any error for an individual widget — skip silently.
      }
    }
  }
}
