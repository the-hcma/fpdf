import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { logger } from './logger.js';
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
  degrees,
  rgb,
} from 'pdf-lib';

const MAX_FONT_SIZE = 12; // pt — hard cap for all text fields
const MIN_FONT_SIZE = 4; // pt — lower bound; matches pdf-lib's internal minimum
const FIELD_PADDING = 2; // pt — inner margin assumed on each side
import type { CandidateField, FpdfDocument, PdfKind } from './types.js';

/** Maps pdf-lib StandardFonts string values (as stored in fontName) to enum entries. */
const STANDARD_FONT_MAP: Partial<Record<string, StandardFonts>> = {
  Helvetica: StandardFonts.Helvetica,
  HelveticaBold: StandardFonts.HelveticaBold,
  HelveticaOblique: StandardFonts.HelveticaOblique,
  HelveticaBoldOblique: StandardFonts.HelveticaBoldOblique,
  TimesRoman: StandardFonts.TimesRoman,
  TimesRomanBold: StandardFonts.TimesRomanBold,
  TimesRomanItalic: StandardFonts.TimesRomanItalic,
  TimesRomanBoldItalic: StandardFonts.TimesRomanBoldItalic,
  Courier: StandardFonts.Courier,
  CourierBold: StandardFonts.CourierBold,
  CourierOblique: StandardFonts.CourierOblique,
  CourierBoldOblique: StandardFonts.CourierBoldOblique,
  Symbol: StandardFonts.Symbol,
  ZapfDingbats: StandardFonts.ZapfDingbats,
};

/**
 * Look up or embed a StandardFont by name. Falls back to Helvetica when the
 * name is unknown. Results are cached so each font is embedded only once.
 */
async function resolveFont(
  pdfDoc: PDFDocument,
  fontName: string | undefined,
  cache: Map<string, PDFFont>,
): Promise<PDFFont> {
  const key = fontName ?? 'Helvetica';
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const sf =
    (fontName !== undefined ? STANDARD_FONT_MAP[fontName] : undefined) ?? StandardFonts.Helvetica;
  const font = await pdfDoc.embedFont(sf);
  cache.set(key, font);
  return font;
}
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
/** Thrown when the PDF cannot be exported (e.g. encrypted and unreadable by pdf-lib). */
export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

/**
 * Remove pages marked `excluded: true` from `pdfDoc`, in reverse order so
 * earlier page indices remain valid during removal.
 */
function removeExcludedPages(pdfDoc: PDFDocument, doc: FpdfDocument): void {
  const indices = doc.pages
    .filter((p) => p.excluded)
    .map((p) => p.pageNumber - 1)
    .sort((a, b) => b - a);
  for (const idx of indices) {
    pdfDoc.removePage(idx);
  }
}

/**
 * Stamp all placed images for every page onto `pdfDoc`.  Missing image files
 * are skipped with a warning so a missing upload never blocks the export.
 */
async function drawPlacedImages(
  pdfDoc: PDFDocument,
  doc: FpdfDocument,
  imagesDir: string,
): Promise<void> {
  for (const docPage of doc.pages) {
    if (!docPage.images?.length) continue;
    const page = pdfDoc.getPage(docPage.pageNumber - 1);
    const pageRotation = docPage.rotationDeg ?? 0;
    for (const img of docPage.images) {
      const ext = img.mimeType === 'image/jpeg' ? 'jpg' : 'png';
      const imgPath = path.join(imagesDir, `${img.id}.${ext}`);
      let buf: Buffer;
      try {
        buf = await readFile(imgPath);
      } catch {
        logger.warn(`Placed image ${img.id}.${ext} not found on disk — skipping`);
        continue;
      }
      const embedded =
        img.mimeType === 'image/jpeg' ? await pdfDoc.embedJpg(buf) : await pdfDoc.embedPng(buf);
      // For PNG images: if the embedder produced a soft mask (alpha channel),
      // ensure the page declares a PDF transparency group.  Without a
      // /Group /Transparency dict on the page, some viewers (notably Acrobat)
      // do not composite the SMask and render the image with a solid background.
      if (img.mimeType === 'image/png') {
        // pdf-lib defers XObject embedding until save().  Force it now so that
        // the stream is present in the context and we can inspect its /SMask key.
        await embedded.embed();
        // pdf-lib stores the image XObject as a PDFRawStream (which extends PDFStream),
        // not a PDFDict.  PDFStream is not exported from pdf-lib's public API, so we
        // use unknown-based narrowing to access its .dict without unsafe member access.
        const rawObj: unknown = pdfDoc.context.lookup(embedded.ref);
        const imgDict =
          rawObj !== null &&
          typeof rawObj === 'object' &&
          'dict' in rawObj &&
          rawObj.dict instanceof PDFDict
            ? rawObj.dict
            : undefined;
        if (imgDict?.has(PDFName.of('SMask'))) {
          if (!page.node.has(PDFName.of('Group'))) {
            const groupDict = pdfDoc.context.obj({});
            groupDict.set(PDFName.of('S'), PDFName.of('Transparency'));
            groupDict.set(PDFName.of('CS'), PDFName.of('DeviceRGB'));
            page.node.set(PDFName.of('Group'), groupDict);
          }
        }
      }
      const raw = toRawRect(
        img.placement.x,
        img.placement.y,
        img.placement.width,
        img.placement.height,
        docPage.widthPt,
        docPage.heightPt,
        pageRotation,
      );
      page.drawImage(embedded, raw);
    }
  }
}

export async function exportPdf(
  pdfPath: string,
  doc: FpdfDocument,
  options: { readOnly?: boolean; imagesDir?: string } = {},
): Promise<Uint8Array> {
  const bytes = await readFile(pdfPath);
  let pdfDoc: PDFDocument;
  try {
    pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    pdfDoc.getPageCount(); // probe — encrypted PDFs load but fail on access
  } catch {
    throw new ExportError(
      'This PDF is encrypted and cannot be modified for export. ' +
        'Use your browser\u2019s Print function (Ctrl+P / Cmd+P) to save a filled copy.',
    );
  }

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

  // Build font cache — embed helv as the default, then pre-embed any other
  // StandardFonts referenced by fields so measurement and appearance rendering
  // use the correct per-field font metrics.
  const fontCache = new Map<string, PDFFont>();
  fontCache.set('Helvetica', helv);
  for (const page of doc.pages) {
    for (const field of [...page.fields, ...page.candidateFields]) {
      if (field.fontName !== undefined && !fontCache.has(field.fontName)) {
        await resolveFont(pdfDoc, field.fontName, fontCache);
      }
    }
  }

  // fieldFonts: field name → resolved PDFFont, for fields with a non-default font.
  // Used to regenerate per-field appearances with the correct font after the
  // global updateFieldAppearances(helv) pass.
  const fieldFonts = new Map<string, PDFFont>();
  for (const page of doc.pages) {
    for (const field of page.fields) {
      if (field.fontName !== undefined) {
        const font = fontCache.get(field.fontName);
        if (font !== undefined && !fieldFonts.has(field.name)) {
          fieldFonts.set(field.name, font);
        }
      }
    }
  }

  const { fontSizes, noScrollDisable } = buildFontSizeMap(doc, allValues, fontCache, helv);

  // Candidate fields: create real AcroForm widgets for non-XFA PDFs.
  // For XFA PDFs, fall back to stamped text — calling getForm() before the XFA
  // branch captures /XFA would strip it from the in-memory AcroForm dict.
  if (isXfa) {
    await drawCandidateValues(pdfDoc, doc);
  } else {
    createCandidateWidgets(pdfDoc, doc, fontCache, options.readOnly ?? false);
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
    // Re-render fields with non-default fonts using the correct font.
    applyNonDefaultFontAppearances(pdfDoc, fieldFonts);

    // Step 5: Restore /XFA so it is serialised into the output bytes.
    if (acroForm instanceof PDFDict && xfaValue !== undefined) {
      acroForm.set(PDFName.of('XFA'), xfaValue);
    }

    // Step 6: Save without ObjStm compression so every in-memory dict change
    // (including the restored /XFA) is written via copyBytesInto().
    if (options.imagesDir !== undefined) {
      await drawPlacedImages(pdfDoc, doc, options.imagesDir);
    }
    removeExcludedPages(pdfDoc, doc);
    return pdfDoc.save({ useObjectStreams: false, updateFieldAppearances: false });
  } else {
    // ── Pure AcroForm PDF ─────────────────────────────────────────────────────
    // Phase 1: fill fields registered in the AcroForm field tree.
    writeAcroFormValues(pdfDoc, allValues, allAlignments, fontSizes, noScrollDisable, 'acroform');
    // Phase 2: fill orphan widget annotations (present in page /Annots but not
    // in the AcroForm field tree — common in XFA-derived PDFs).  Each orphan
    // widget's appearance is regenerated inside this function using per-field font.
    writeOrphanWidgetValues(
      pdfDoc,
      allValues,
      allAlignments,
      fontSizes,
      noScrollDisable,
      helv,
      fieldFonts,
    );
    // Regenerate appearances for AcroForm-tree fields using helv as base.
    pdfDoc.getForm().updateFieldAppearances(helv);
    // Re-render fields with non-default fonts using the correct font.
    applyNonDefaultFontAppearances(pdfDoc, fieldFonts);
  }

  // updateFieldAppearances: false — we already ran it explicitly above with
  // helv so every field is guaranteed to have a rendered appearance stream.
  if (options.imagesDir !== undefined) {
    await drawPlacedImages(pdfDoc, doc, options.imagesDir);
  }
  removeExcludedPages(pdfDoc, doc);
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
  maxFontSize = MAX_FONT_SIZE,
): number {
  const availW = fieldWidth - FIELD_PADDING * 2;
  const availH = fieldHeight - FIELD_PADDING * 2;

  if (!multiline) {
    // Round availH to 1 decimal to avoid float noise (e.g. 15.6 - 4 = 11.60000…2).
    let size = Math.round(Math.min(maxFontSize, availH) * 10) / 10;
    while (size > MIN_FONT_SIZE && font.widthOfTextAtSize(value, size) > availW) {
      size -= 0.5;
    }
    return Math.max(MIN_FONT_SIZE, size);
  }

  for (let size = maxFontSize; size >= MIN_FONT_SIZE; size -= 0.5) {
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
  fontCache: Map<string, PDFFont>,
  defaultFont: PDFFont,
): { fontSizes: Map<string, number>; noScrollDisable: Set<string> } {
  const fontSizes = new Map<string, number>();
  const noScrollDisable = new Set<string>();

  for (const page of doc.pages) {
    for (const field of page.fields) {
      if (field.type !== 'text' && field.type !== 'textarea') continue;
      if (fontSizes.has(field.name)) continue; // first definition wins
      const value = allValues.get(field.name);
      if (typeof value !== 'string' || value === '') continue;
      const font =
        (field.fontName !== undefined ? fontCache.get(field.fontName) : undefined) ?? defaultFont;
      const ceiling = field.fontSize ?? MAX_FONT_SIZE;
      const size = computeTextFontSize(
        value,
        field.placement.width,
        field.placement.height,
        field.type === 'textarea',
        font,
        ceiling,
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
 * Convert a visual-space text anchor (x = left start of text, y = baseline from visual bottom)
 * to the raw PDF content-stream draw coordinates required by pdf-lib.
 *
 * Candidate field placements are stored in visual space: y-up from the visual bottom-left
 * corner of the page, after any viewer rotation is applied.  pdf-lib draws into the raw
 * content stream (pre-rotation).  For each /Rotate value we must invert the transform:
 *
 *   0°  : no change
 *   90° : page is rotated CW 90° by viewer → visual (vx, vy) maps to raw (vy, pageW − vx)
 *         text must be drawn at 90° so it appears upright after the viewer applies its rotation
 *   180°: visual (vx, vy) maps to raw (pageW − vx, pageH − vy), text drawn at 180°
 *   270°: page is rotated CCW 90° by viewer → visual (vx, vy) maps to raw (pageH − vy, vx)
 *         text must be drawn at 270°
 */
function resolveDrawCoords(
  visX: number,
  visY: number,
  pageWidth: number,
  pageHeight: number,
  rotation: number,
): { drawX: number; drawY: number; drawRot: ReturnType<typeof degrees> } {
  if (rotation === 90) {
    return { drawX: visY, drawY: pageWidth - visX, drawRot: degrees(90) };
  }
  if (rotation === 180) {
    return { drawX: pageWidth - visX, drawY: pageHeight - visY, drawRot: degrees(180) };
  }
  if (rotation === 270) {
    return { drawX: pageHeight - visY, drawY: visX, drawRot: degrees(270) };
  }
  return { drawX: visX, drawY: visY, drawRot: degrees(0) };
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
    // Page rotation (0, 90, 180, 270): candidate field placements are stored in
    // visual (post-rotation) coordinate space, so we must convert to the raw PDF
    // content-stream space before drawing.  Only 0° and 180° are handled; 90°/270°
    // fall back to 0° (a separate fix is needed if those rotations are encountered).
    const pageRotation = page.getRotation().angle;
    const pageWidth = docPage.widthPt;
    const pageHeight = docPage.heightPt;

    for (const candidate of candidatesWithValues) {
      const { x: vx, y: vy, width, height } = candidate.placement;
      const fontSize = Math.max(6, Math.round(height * 0.7));

      if (candidate.type === 'checkbox') {
        // Draw a centred "X" for checked checkboxes.
        const mark = 'X';
        const markSize = Math.max(6, Math.round(height * 0.8));
        const markWidth = font.widthOfTextAtSize(mark, markSize);
        // Visual start x of mark (centred horizontally) and baseline y (centred vertically).
        const visMarkX = vx + (width - markWidth) / 2;
        const visMarkY = vy + (height - markSize) / 2;
        const { drawX, drawY, drawRot } = resolveDrawCoords(
          visMarkX,
          visMarkY,
          pageWidth,
          pageHeight,
          pageRotation,
        );
        page.drawText(mark, {
          x: drawX,
          y: drawY,
          size: markSize,
          font,
          color: COLOR,
          rotate: drawRot,
        });
      } else {
        const value = candidate.value as string;
        // Clamp the font size so the text fits within the field width.
        let size = fontSize;
        while (size > 6 && font.widthOfTextAtSize(value, size) > width - TEXT_PADDING * 2) {
          size -= 0.5;
        }
        const textWidth = font.widthOfTextAtSize(value, size);
        // Compute the visual left-start x of the text (alignment in visual space).
        let textVisX: number;
        if (candidate.textAlign === 'center') {
          textVisX = vx + (width - textWidth) / 2;
        } else if (candidate.textAlign === 'right') {
          textVisX = vx + width - textWidth - TEXT_PADDING;
        } else {
          textVisX = vx + TEXT_PADDING;
        }
        const textVisY = vy + TEXT_PADDING;
        const { drawX, drawY, drawRot } = resolveDrawCoords(
          textVisX,
          textVisY,
          pageWidth,
          pageHeight,
          pageRotation,
        );
        page.drawText(value, {
          x: drawX,
          y: drawY,
          size,
          font,
          color: COLOR,
          rotate: drawRot,
          // maxWidth only applies to unrotated draws; the size-clamping loop above
          // already ensures the text fits horizontally.
          ...(pageRotation === 0 ? { maxWidth: width - TEXT_PADDING * 2 } : {}),
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
 *
 * When `readOnly` is true every created field is marked read-only so PDF
 * viewers do not apply the "editable field" blue-highlight overlay. Use this
 * for finalized exports; leave false (default) for interactive exports where
 * the recipient should still be able to type into the fields.
 */
function createCandidateWidgets(
  pdfDoc: PDFDocument,
  doc: FpdfDocument,
  fontCache: Map<string, PDFFont>,
  readOnly = false,
): void {
  const hasCandidates = doc.pages.some((p) => p.candidateFields.some((c) => !c.dismissed));
  if (!hasCandidates) return;

  const form = pdfDoc.getForm();
  const usedNames = new Set<string>();
  const helv = fontCache.get('Helvetica') ?? fontCache.values().next().value;

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
    // For finalized (readOnly) exports, skip radio groups where no option was selected —
    // they have no visible content and would only add invisible interactive annotations.
    const hasSelection = buttons.some(
      ({ candidate: c }) => typeof c.value === 'string' && c.value === c.radioValue,
    );
    if (readOnly && !hasSelection) continue;

    const name = uniqueFieldName(groupKey, usedNames);
    const rg = form.createRadioGroup(name);
    let selectedOption: string | undefined;
    for (const { candidate: c, pageIdx } of buttons) {
      const optVal = c.radioValue ?? 'option';
      const btnPage = pdfDoc.getPage(pageIdx);
      const btnRotation = btnPage.getRotation().angle;
      const btnPageW = doc.pages[pageIdx]?.widthPt ?? 0;
      const btnPageH = doc.pages[pageIdx]?.heightPt ?? 0;
      const rawRect = toRawRect(
        c.placement.x,
        c.placement.y,
        c.placement.width,
        c.placement.height,
        btnPageW,
        btnPageH,
        btnRotation,
      );
      rg.addOptionToPage(optVal, btnPage, rawRect);
      if (typeof c.value === 'string' && c.value === c.radioValue) selectedOption = optVal;
    }
    if (selectedOption !== undefined) rg.select(selectedOption);
  }

  // Text, textarea, and checkbox candidates — processed per page in order.
  for (const docPage of doc.pages) {
    const page = pdfDoc.getPage(docPage.pageNumber - 1);
    const pageRotation = page.getRotation().angle;
    const pageW = docPage.widthPt;
    const pageH = docPage.heightPt;
    for (const c of docPage.candidateFields) {
      if (c.dismissed || c.type === 'radio') continue;
      // For finalized (readOnly) exports, skip fields with no user-entered content.
      // Auto-detected candidates (e.g. table-line detections) with no value would
      // otherwise produce invisible or accidentally-filled widgets in the output.
      if (readOnly) {
        if (c.type === 'checkbox' && c.value !== true) continue;
        if ((c.type === 'text' || c.type === 'textarea') && !c.value) continue;
      }
      const name = uniqueFieldName(c.displayName || c.label || 'Field', usedNames);
      const { x, y, width, height } = c.placement;
      const rawRect = toRawRect(x, y, width, height, pageW, pageH, pageRotation);
      if (c.type === 'checkbox') {
        const cb = form.createCheckBox(name);
        cb.addToPage(page, rawRect);
        makeWidgetTransparent(pdfDoc, cb);
        if (pageRotation !== 0) setWidgetRotation(pdfDoc, cb, pageRotation);
        if (c.value === true) cb.check();
        if (readOnly) cb.enableReadOnly();
        cb.updateAppearances();
      } else {
        const tf = form.createTextField(name);
        const multiline = c.type === 'textarea';
        if (multiline) tf.enableMultiline();
        tf.addToPage(page, rawRect);
        makeWidgetTransparent(pdfDoc, tf);
        if (pageRotation !== 0) setWidgetRotation(pdfDoc, tf, pageRotation);
        const value = typeof c.value === 'string' ? c.value : '';
        if (value !== '') tf.setText(value);
        const align = toTextAlignment(c.textAlign);
        tf.setAlignment(align);
        const font = (c.fontName !== undefined ? fontCache.get(c.fontName) : undefined) ?? helv;

        // Auto-fit font size so text doesn't overflow the field bounds.
        // For single-line fields containing embedded newlines, measure only
        // the longest line — PDF viewers typically display up to the first \n.
        if (value !== '' && font !== undefined) {
          const measureValue = multiline
            ? value
            : value.split('\n').reduce((a, b) => (a.length >= b.length ? a : b), '');
          const size = computeTextFontSize(
            measureValue,
            width,
            height,
            multiline,
            font,
            c.fontSize ?? MAX_FONT_SIZE,
          );
          tf.setFontSize(size);
          // Disable scrolling only when the text actually fits at the computed size.
          const overflows =
            !multiline && font.widthOfTextAtSize(measureValue, size) > width - FIELD_PADDING * 2;
          if (!overflows) tf.disableScrolling();
        }

        if (readOnly) tf.enableReadOnly();
        if (font !== undefined) tf.updateAppearances(font);
      }
    }
  }
}

/**
 * Convert a candidate field placement (visual space, y-up from visual bottom-left)
 * to the raw PDF coordinate rect expected by pdf-lib's addToPage / addOptionToPage.
 *
 * For 0°, visual space == raw PDF space (identity).
 * For 180°, both axes are flipped around the page centre.
 * 90° and 270° additionally swap the apparent width/height; those cases are not
 * yet handled and fall back to the identity (0°) transform.
 */
function toRawRect(
  vx: number,
  vy: number,
  vw: number,
  vh: number,
  pageW: number,
  pageH: number,
  rotation: number,
): { x: number; y: number; width: number; height: number } {
  // pageW/pageH are the VISUAL page dimensions (widthPt/heightPt from FpdfDocument).
  // Widget placements are stored in that same visual space.  Convert them back to
  // raw PDF MediaBox space (which is what pdf-lib expects) based on page rotation.
  if (rotation === 90) {
    // /Rotate 90 CW: visual width = MediaBox height, visual height = MediaBox width
    //   MediaBox x = visual_pageH − vy − vh
    //   MediaBox y = vx
    //   width/height swap
    return { x: pageH - vy - vh, y: vx, width: vh, height: vw };
  }
  if (rotation === 270) {
    // /Rotate 270 CW (= 90 CCW): visual width = MediaBox height, visual height = MediaBox width
    //   MediaBox x = vy
    //   MediaBox y = visual_pageW − vx − vw
    //   width/height swap
    return { x: vy, y: pageW - vx - vw, width: vh, height: vw };
  }
  if (rotation === 180) {
    return { x: pageW - vx - vw, y: pageH - vy - vh, width: vw, height: vh };
  }
  return { x: vx, y: vy, width: vw, height: vh };
}

/**
 * Set the widget annotation rotation (/MK /R) for every widget in a field.
 * This must be called AFTER makeWidgetTransparent (which deletes /MK entirely)
 * and BEFORE updateAppearances so pdf-lib generates an appearance stream that
 * counter-rotates the text, making it appear upright after the page rotation is
 * applied by the viewer.
 */
function setWidgetRotation(
  pdfDoc: PDFDocument,
  field: { acroField: { getWidgets(): { dict: PDFDict }[] } },
  rotation: number,
): void {
  for (const widget of field.acroField.getWidgets()) {
    const mkDict = pdfDoc.context.obj({ R: PDFNumber.of(rotation) });
    widget.dict.set(PDFName.of('MK'), mkDict);
  }
}

/**
 * Remove the white background fill and border from a candidate field widget
 * so it renders transparently over the existing PDF content.
 *
 * pdf-lib stores background (/MK /BG) and border color (/MK /BC) on each
 * widget annotation and reads them when generating the /AP appearance stream.
 * Deleting /MK before updateAppearances causes pdf-lib to omit the fill and
 * border rectangles from the generated stream.
 *
 * /BS W=0 additionally suppresses the border in viewers that render the
 * annotation border directly from the dict rather than from /AP.
 */
function makeWidgetTransparent(
  pdfDoc: PDFDocument,
  field: { acroField: { getWidgets(): { dict: PDFDict }[] } },
): void {
  const bsDict = pdfDoc.context.obj({ W: 0 });
  for (const widget of field.acroField.getWidgets()) {
    widget.dict.delete(PDFName.of('MK'));
    widget.dict.set(PDFName.of('BS'), bsDict);
  }
}

/**
 * After the global updateFieldAppearances(helv) pass, re-render text fields
 * that have a non-Helvetica font stored in fieldFonts using their correct font.
 * This overrides the Helvetica appearance for those fields.
 */
function applyNonDefaultFontAppearances(
  pdfDoc: PDFDocument,
  fieldFonts: Map<string, PDFFont>,
): void {
  if (fieldFonts.size === 0) return;
  const form = pdfDoc.getForm();
  for (const [name, font] of fieldFonts) {
    try {
      const pdfField = form.getField(name);
      if (pdfField instanceof PDFTextField) {
        pdfField.updateAppearances(font);
      }
    } catch {
      // Field absent from the PDF — skip silently.
    }
  }
}

/**
 * Rewrite the Default Appearance (/DA) entry of a text field so the
 * non-stroking colour is black.
 *
 * Many real-world forms (e.g. Cigna) embed a coloured fill operator in /DA
 * (e.g. `0 0.39 1 rg` for Cigna blue).  pdf-lib copies this operator verbatim
 * into every generated appearance stream, making all filled text appear in the
 * original colour instead of black.  We normalise the colour to `0 g` (black
 * grayscale) before appearances are regenerated.
 *
 * Operators handled (non-stroking / fill only):
 *   n n n n k  (CMYK)  →  0 g
 *   n n n rg   (RGB)   →  0 g
 *   n g        (gray)  →  0 g  (no-op when already `0 g`)
 */
function forceBlackDA(field: PDFTextField): void {
  const da = field.acroField.getDefaultAppearance();
  if (da === undefined) return;
  const patched = da
    .replace(/[\d.]+\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+k(?=\s|$)/g, '0 g')
    .replace(/[\d.]+\s+[\d.]+\s+[\d.]+\s+rg(?=\s|$)/g, '0 g')
    .replace(/[\d.]+\s+g(?=\s|$)/g, '0 g');
  if (patched !== da) {
    field.acroField.setDefaultAppearance(patched);
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
function toTextAlignment(align: string | undefined): TextAlignment {
  if (align === 'center') return TextAlignment.Center;
  if (align === 'right') return TextAlignment.Right;
  // 'left', 'justify', and undefined all fall back to Left.
  // Returning Left (not undefined) ensures we always call setAlignment so the
  // original PDF's quadding (which may be center in XFA-derived forms like
  // Cigna) is overridden rather than preserved in the appearance stream.
  return TextAlignment.Left;
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
        pdfField.setAlignment(toTextAlignment(alignments.get(name)));
        const fontSize = fontSizes.get(name);
        if (fontSize !== undefined) pdfField.setFontSize(fontSize);
        // Force black text: strip any non-black colour operator from /DA so
        // the generated appearance stream renders text in black, not the
        // original form colour (e.g. Cigna blue).
        forceBlackDA(pdfField);
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
  fieldFonts: Map<string, PDFFont>,
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
          textField.setAlignment(toTextAlignment(alignments.get(name)));
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
          // Force black text: same colour normalisation as writeAcroFormValues.
          forceBlackDA(textField);
          textField.updateAppearances(fieldFonts.get(name) ?? helv);
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

/**
 * Rendered-image page data sent from the browser when pdf-lib cannot modify
 * the original PDF (encrypted or corrupted).
 */
export interface RenderedPage {
  /** JPEG bytes for the rendered page. */
  jpeg: Uint8Array;
  /** Page width in PDF points. */
  widthPt: number;
  /** Page height in PDF points. */
  heightPt: number;
}

/**
 * Create a new PDF from pre-rendered page images with real AcroForm widgets
 * for all candidate fields.  Used as a fallback when pdf-lib cannot load the
 * original PDF (e.g. encrypted).  The browser captures each page canvas as
 * JPEG and sends it here; this function assembles them into a proper PDF with
 * editable AcroForm fields positioned at the correct coordinates on top of
 * the page images.
 */
export async function exportFromImages(
  pages: RenderedPage[],
  doc: FpdfDocument,
  readOnly = false,
  imagesDir?: string,
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();

  for (const rp of pages) {
    const { jpeg, widthPt, heightPt } = rp;
    const img = await pdfDoc.embedJpg(jpeg);
    const page = pdfDoc.addPage([widthPt, heightPt]);
    page.drawImage(img, { x: 0, y: 0, width: widthPt, height: heightPt });
  }

  const fontCache = new Map<string, PDFFont>();
  const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
  fontCache.set('Helvetica', helv);
  for (const docPage of doc.pages) {
    for (const field of docPage.candidateFields) {
      if (field.fontName !== undefined && !fontCache.has(field.fontName)) {
        await resolveFont(pdfDoc, field.fontName, fontCache);
      }
    }
  }

  createCandidateWidgets(pdfDoc, doc, fontCache, readOnly);

  if (imagesDir !== undefined) {
    await drawPlacedImages(pdfDoc, doc, imagesDir);
  }

  removeExcludedPages(pdfDoc, doc);
  return pdfDoc.save();
}
