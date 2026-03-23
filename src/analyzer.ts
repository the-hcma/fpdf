import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { deflateSync } from 'node:zlib';
import {
  PDFDocument,
  PDFButton,
  PDFCheckBox,
  PDFDropdown,
  PDFRadioGroup,
  PDFSignature,
  PDFTextField,
  PDFName,
  PDFString,
  PDFHexString,
  PDFDict,
  PDFArray,
  PDFNumber,
  PDFRef,
  PDFRawStream,
  decodePDFRawStream,
  type PDFField,
} from 'pdf-lib';
import { getDocument, GlobalWorkerOptions, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type {
  FpdfDocument,
  FpdfMetadata,
  PdfField,
  PdfPage,
  Placement,
  FieldType,
  TextBlock,
  PageType,
  CandidateField,
  CandidateFieldConfidence,
} from './types.js';
import { logger } from './logger.js';

// pdfjs-dist requires a Worker even in Node.js. Resolve the sibling worker
// bundle relative to this module so it works regardless of cwd.
const _require = createRequire(import.meta.url);
GlobalWorkerOptions.workerSrc = `file://${_require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')}`;

/** Thrown when the PDF cannot be read, parsed, or has no usable form fields. */
export class AnalyzerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyzerError';
  }
}

function sha256Hex(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Derive a human-readable label from an AcroForm field name.
 *
 * Many PDFs encode the field number and description in the partial name, e.g.:
 *   "topmostSubform[0].Page1[0]._2_PredeterminationPreauthorization_Number[0]"
 * becomes "2 Predetermination Preauthorization Number".
 *
 * Steps:
 *  1. Take the last dot-separated segment (the partial name).
 *  2. Strip the trailing index suffix, e.g. "[0]".
 *  3. Strip a leading underscore used to prefix numeric field names.
 *  4. Split on underscores.
 *  5. Insert spaces before capital letters in camelCase tokens.
 *  6. Collapse whitespace and trim.
 */
export function deriveLabel(fullName: string): string {
  const dotIdx = fullName.lastIndexOf('.');
  const partial = dotIdx >= 0 ? fullName.slice(dotIdx + 1) : fullName;
  const withoutIndex = partial.replace(/\[\d+\]$/, '');
  const withoutLeadingUnderscore = withoutIndex.replace(/^_/, '');
  const tokens = withoutLeadingUnderscore.split('_');
  const words = tokens.flatMap((token) => token.replace(/([a-z])([A-Z])/g, '$1 $2').split(' '));
  return words.join(' ').replace(/\s+/g, ' ').trim();
}

/** Trailing format fragments that are noise in a display name. */
const DISPLAY_NAME_STOP_PHRASES = [
  'Last First Middle Initial Suffix Address City State Zip Code',
  'Last First Middle Initial Suffix',
  'Address City State Zip Code',
  'Address City State Zip',
];

/**
 * Derive a clean display name from a derived label for UI rendering.
 *
 * Strips the leading field number, removes pure format-hint tokens
 * (e.g. MMDDCCYY), removes back-references to other fields (e.g. "in 4"),
 * and truncates at trailing address/name format fragments.
 * Falls back to the original label if nothing meaningful remains.
 */
export function deriveDisplayName(label: string): string {
  // Strip leading field number ("2 " or "12 ")
  let result = label.replace(/^\d+\s*/, '');

  // Remove "in N" back-references to other field numbers
  result = result.replace(/\s+in\s+\d+\b/gi, '');

  // Remove pure format-hint tokens: 6+ consecutive uppercase letters (e.g. MMDDCCYY)
  result = result.replace(/\b[A-Z]{6,}\b/g, '');

  // Truncate at known trailing format fragments (first match wins)
  for (const stop of DISPLAY_NAME_STOP_PHRASES) {
    const idx = result.indexOf(stop);
    if (idx > 0) {
      result = result.slice(0, idx);
      break;
    }
  }

  result = result.replace(/\s+/g, ' ').trim();

  return result.length > 0 ? result : label;
}

/** Returns null for field types that should be skipped entirely (buttons, signatures). */
function fieldTypeFor(field: PDFField): FieldType | null {
  if (field instanceof PDFTextField) return field.isMultiline() ? 'textarea' : 'text';
  if (field instanceof PDFCheckBox) return 'checkbox';
  if (field instanceof PDFRadioGroup) return 'radio';
  if (field instanceof PDFDropdown) return 'select';
  if (field instanceof PDFButton) return null; // image / push-button widget
  if (field instanceof PDFSignature) return null; // signature widget
  return 'text'; // PDFOptionList → best-effort fallback
}

function fieldValue(field: PDFField): string | boolean {
  if (field instanceof PDFTextField) return field.getText() ?? '';
  if (field instanceof PDFCheckBox) return field.isChecked();
  if (field instanceof PDFRadioGroup) return field.getSelected() ?? '';
  if (field instanceof PDFDropdown) {
    const selected = field.getSelected();
    return selected.length > 0 ? (selected[0] ?? '') : '';
  }
  return '';
}

function fieldOptions(field: PDFField): string[] {
  if (field instanceof PDFRadioGroup) return field.getOptions();
  if (field instanceof PDFDropdown) return field.getOptions();
  return [];
}

// TextItem has a `str` property; TextMarkedContent does not.
function isPdfjsTextItem(
  item: unknown,
): item is { str: string; transform: number[]; width: number; height: number; fontName: string } {
  return typeof (item as { str?: unknown }).str === 'string';
}

/**
 * Extract static text blocks from a single PDF page using pdfjs-dist.
 *
 * Adjacent items on the same logical line (same fontName, fontSize within
 * 0.5pt, y-position within half the font size) are joined into one TextBlock.
 * Returns blocks sorted top-to-bottom.
 */
async function extractTextBlocks(
  pdfjsPage: Awaited<ReturnType<Awaited<ReturnType<typeof getDocument>['promise']>['getPage']>>,
): Promise<TextBlock[]> {
  const content = await pdfjsPage.getTextContent();

  const items = (content.items as unknown[])
    .filter(isPdfjsTextItem)
    .filter((it) => it.str.trim().length > 0 && it.height > 0)
    .map((it) => ({
      str: it.str,
      x: it.transform[4] ?? 0,
      y: it.transform[5] ?? 0,
      width: it.width,
      height: it.height,
      fontName: it.fontName,
    }));

  // Sort top-to-bottom (y descending), then left-to-right.
  items.sort((a, b) => b.y - a.y || a.x - b.x);

  // Group into logical lines.
  const groups: (typeof items)[] = [];
  for (const item of items) {
    let placed = false;
    for (const group of groups) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const rep = group[0]!; // groups only contain non-empty arrays
      if (
        Math.abs(rep.y - item.y) < rep.height / 2 &&
        Math.abs(rep.height - item.height) <= 0.5 &&
        rep.fontName === item.fontName
      ) {
        group.push(item);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([item]);
  }

  return groups.map((group) => {
    group.sort((a, b) => a.x - b.x);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const rep = group[0]!; // groups only contain non-empty arrays

    let text = rep.str;
    let prev = rep;
    for (const curr of group.slice(1)) {
      if (curr.x - (prev.x + prev.width) > 0.25 * rep.height) text += ' ';
      text += curr.str;
      prev = curr;
    }

    const minX = group.reduce((m, it) => Math.min(m, it.x), Infinity);
    const maxX = group.reduce((m, it) => Math.max(m, it.x + it.width), -Infinity);
    const minY = group.reduce((m, it) => Math.min(m, it.y), Infinity);
    const maxH = group.reduce((m, it) => Math.max(m, it.height), 0);

    return {
      text,
      placement: { x: minX, y: minY, width: maxX - minX, height: maxH },
      fontSize: rep.height,
      fontName: rep.fontName,
    };
  });
}

// ── Orphan widget fallback ────────────────────────────────────────────────────

/**
 * Walk the /Parent chain and return the first value found for `key`.
 * Handles both direct dict values and indirect (PDFRef) parents.
 */
/** Lookup a parent ref from a PDFDict, resolving indirect refs. Returns the parent PDFDict or undefined. */
function lookupParent(dict: PDFDict, pdfDoc: PDFDocument): PDFDict | undefined {
  const raw: unknown = dict.get(PDFName.of('Parent'));
  if (!raw) return undefined;
  const resolved: unknown = raw instanceof PDFRef ? pdfDoc.context.lookup(raw) : raw;
  return resolved instanceof PDFDict ? resolved : undefined;
}

function resolveInherited(dict: PDFDict, key: string, pdfDoc: PDFDocument): unknown {
  let current: PDFDict | undefined = dict;
  while (current) {
    const val = current.get(PDFName.of(key));
    if (val !== undefined) return val;
    current = lookupParent(current, pdfDoc);
  }
  return undefined;
}

/**
 * Build the full dotted field name by collecting /T values up the /Parent chain
 * (e.g. "form1.page1.lastName") then joining with ".".
 */
function buildFullFieldName(dict: PDFDict, pdfDoc: PDFDocument): string {
  const parts: string[] = [];
  let current: PDFDict | undefined = dict;
  while (current) {
    const t = current.get(PDFName.of('T'));
    if (t instanceof PDFString || t instanceof PDFHexString) {
      parts.unshift(t.decodeText());
    } else if (t instanceof PDFName) {
      // PDFName.asString() includes the leading '/' — strip it for field names
      parts.unshift(t.asString().replace(/^\//, ''));
    }
    current = lookupParent(current, pdfDoc);
  }
  return parts.join('.');
}

/**
 * Walk a page's /Annots array and extract Widget annotations that pdf-lib's
 * form.getFields() missed — typically because the PDF's /AcroForm field tree is
 * broken or widgets are unlinked from the root fields array.
 *
 * Returns PdfField entries for any widgets whose full field name is absent from
 * `knownNames`. Read-only widgets and non-form widgets (Sig, pushbutton) are skipped.
 */
export function extractOrphanWidgets(
  pdfDoc: PDFDocument,
  pageNum: number, // 1-based
  knownNames: Set<string>,
): PdfField[] {
  const page = pdfDoc.getPage(pageNum - 1);

  const annotsRaw = page.node.get(PDFName.of('Annots'));
  if (!annotsRaw) return [];
  const annotsList = annotsRaw instanceof PDFRef ? pdfDoc.context.lookup(annotsRaw) : annotsRaw;
  if (!(annotsList instanceof PDFArray)) return [];

  const fields: PdfField[] = [];

  for (let i = 0; i < annotsList.size(); i++) {
    try {
      const annotEntry = annotsList.get(i);
      const annotDict =
        annotEntry instanceof PDFRef ? pdfDoc.context.lookup(annotEntry) : annotEntry;
      if (!(annotDict instanceof PDFDict)) continue;

      // Must be a Widget annotation
      const subtype = annotDict.get(PDFName.of('Subtype'));
      if (!(subtype instanceof PDFName) || subtype.asString() !== '/Widget') continue;

      // /FT (field type) — may be inherited from /Parent
      const ftRaw = resolveInherited(annotDict, 'FT', pdfDoc);
      if (!(ftRaw instanceof PDFName)) continue;
      const ftStr = ftRaw.asString(); // '/Tx', '/Btn', '/Ch', '/Sig'

      // /Ff (field flags) — may be inherited
      const ffRaw = resolveInherited(annotDict, 'Ff', pdfDoc);
      const ff = ffRaw instanceof PDFNumber ? ffRaw.asNumber() : 0;

      // Map /FT + /Ff to FieldType (returns null for pushbutton / signature)
      let type: FieldType | null = null;
      if (ftStr === '/Tx') {
        type = (ff & (1 << 12)) !== 0 ? 'textarea' : 'text'; // bit 12 = Multiline
      } else if (ftStr === '/Ch') {
        type = 'select';
      } else if (ftStr === '/Btn') {
        if ((ff & (1 << 16)) !== 0) continue; // bit 16 = Pushbutton — skip
        type = (ff & (1 << 15)) !== 0 ? 'radio' : 'checkbox'; // bit 15 = Radio
      } else {
        continue; // Sig or unknown — skip
      }

      // Skip read-only (bit 0 of Ff)
      if ((ff & 1) !== 0) continue;

      // /T — needed to build the full field name
      const tRaw = resolveInherited(annotDict, 'T', pdfDoc);
      if (!tRaw) continue;
      const fullName = buildFullFieldName(annotDict, pdfDoc);
      if (!fullName) continue;
      if (knownNames.has(fullName)) continue;

      // /Rect [x1 y1 x2 y2]
      const rectRaw = annotDict.get(PDFName.of('Rect'));
      const rectResolved = rectRaw instanceof PDFRef ? pdfDoc.context.lookup(rectRaw) : rectRaw;
      if (!(rectResolved instanceof PDFArray) || rectResolved.size() < 4) continue;
      const rn = (idx: number): number => {
        const v = rectResolved.get(idx);
        return v instanceof PDFNumber ? v.asNumber() : 0;
      };
      const rx1 = rn(0);
      const ry1 = rn(1);
      const rx2 = rn(2);
      const ry2 = rn(3);
      const x = Math.min(rx1, rx2);
      const y = Math.min(ry1, ry2);
      const w = Math.abs(rx2 - rx1);
      const h = Math.abs(ry2 - ry1);
      if (w <= 0 || h <= 0) continue;

      // /V — current value (best-effort)
      const vRaw = resolveInherited(annotDict, 'V', pdfDoc);
      let value: string | boolean = type === 'checkbox' || type === 'radio' ? false : '';
      if (type === 'checkbox' || type === 'radio') {
        if (vRaw instanceof PDFName) value = vRaw.asString() !== '/Off';
      } else {
        if (vRaw instanceof PDFString || vRaw instanceof PDFHexString) value = vRaw.decodeText();
      }

      // /TU — tooltip
      const tuRaw = resolveInherited(annotDict, 'TU', pdfDoc);
      const tooltip =
        tuRaw instanceof PDFString || tuRaw instanceof PDFHexString
          ? tuRaw.decodeText().trim()
          : undefined;

      // /Opt — options for /Ch (select) fields
      const options: string[] = [];
      if (type === 'select') {
        const optRaw = resolveInherited(annotDict, 'Opt', pdfDoc);
        if (optRaw instanceof PDFArray) {
          for (let j = 0; j < optRaw.size(); j++) {
            const opt = optRaw.get(j);
            if (opt instanceof PDFString) options.push(opt.decodeText());
            else if (opt instanceof PDFName) options.push(opt.asString());
            else if (opt instanceof PDFArray && opt.size() >= 2) {
              const display = opt.get(1);
              if (display instanceof PDFString || display instanceof PDFHexString)
                options.push(display.decodeText());
            }
          }
        }
      }

      const required = (ff & 2) !== 0;
      const label = deriveLabel(fullName);
      fields.push({
        id: randomUUID(),
        name: fullName,
        type,
        label,
        displayName: deriveDisplayName(label),
        ...(tooltip ? { tooltip } : {}),
        placement: { x, y, width: w, height: h },
        value,
        required,
        readOnly: false,
        options,
      });
    } catch {
      // best-effort — skip malformed annotations
    }
  }

  return fields;
}

// ── XFA utilities ────────────────────────────────────────────────────────────

/**
 * Extract the leaf field name from a dotted XFA field path.
 * "topmostSubform[0].Page1[0].firstName[0]" → "firstName"
 * "firstName" → "firstName"
 */
export function xfaLeafName(fieldName: string): string {
  const last = fieldName.split('.').pop() ?? fieldName;
  return last.replace(/\[\d+\]$/, '');
}

/**
 * Locate the XFA /datasets packet in a PDF's /AcroForm/XFA array.
 * Returns the PDFRef to the compressed stream and its decoded XML text,
 * or null when the PDF has no XFA.
 */
export function getXfaDatasetsInfo(pdfDoc: PDFDocument): { ref: PDFRef; xml: string } | null {
  const acroFormEntry = pdfDoc.catalog.get(PDFName.of('AcroForm'));
  const acroForm =
    acroFormEntry instanceof PDFRef ? pdfDoc.context.lookup(acroFormEntry) : acroFormEntry;
  if (!(acroForm instanceof PDFDict)) return null;

  const xfaEntry = acroForm.get(PDFName.of('XFA'));
  const xfaArr = xfaEntry instanceof PDFRef ? pdfDoc.context.lookup(xfaEntry) : xfaEntry;
  if (!(xfaArr instanceof PDFArray)) return null;

  for (let i = 0; i + 1 < xfaArr.size(); i += 2) {
    const nameEntry = xfaArr.get(i);
    const packetName =
      nameEntry instanceof PDFString || nameEntry instanceof PDFHexString
        ? nameEntry.decodeText()
        : null;
    if (packetName !== 'datasets') continue;

    const streamEntry = xfaArr.get(i + 1);
    const ref = streamEntry instanceof PDFRef ? streamEntry : null;
    if (!ref) continue;

    const stream = pdfDoc.context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) continue;

    const decoded = decodePDFRawStream(stream).decode();
    const xml = Buffer.from(decoded).toString('utf-8');
    return { ref, xml };
  }
  return null;
}

/**
 * Parse the flat XFA datasets XML and return a map of element name → value.
 * Only elements with non-empty text content are included.
 */
export function parseXfaDatasetValues(xml: string): Map<string, string> {
  const values = new Map<string, string>();
  // Match <ElementName [attrs]>text content</ElementName>
  const re = /<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>([^<]+)<\/[A-Za-z_][\w.-]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const [, name, rawText] = m;
    if (!name || rawText === undefined) continue;
    const text = rawText.trim();
    if (text !== '') values.set(name, unescapeXmlEntities(text));
  }
  return values;
}

function unescapeXmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function escapeXmlEntities(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Patch the XFA datasets XML, replacing element text for each entry in `values`.
 * Handles both self-closing elements (`<Name/>`) and elements with existing content.
 * Field names are mapped to leaf names via `xfaLeafName`.
 *
 * Fallback insertion: if neither pattern matches (element absent from the initial
 * datasets XML — common for radio/checkbox fields that were never set), insert the
 * element as a child of its parent element.  This is determined by the dotted-path
 * field name: the second-to-last component names the parent container.
 */
export function patchXfaDatasetsXml(xml: string, values: Map<string, string | boolean>): string {
  let result = xml;
  for (const [fullName, value] of values) {
    const leaf = xfaLeafName(fullName);
    if (!leaf) continue;
    const strValue = typeof value === 'boolean' ? (value ? '1' : '0') : escapeXmlEntities(value);
    // Escape leaf name for safe use in RegExp
    const re = leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const before = result;
    // Replace self-closing: <Name/> or <Name attrs/>
    result = result.replace(
      new RegExp(`<${re}(\\s[^>]*)?\\/\\s*>`, 'g'),
      () => `<${leaf}>${strValue}</${leaf}>`,
    );
    // Replace element with existing content: <Name [attrs]>old</Name>
    result = result.replace(
      new RegExp(`<${re}(\\s[^>]*)?>([^<]*)<\\/${re}>`, 'g'),
      () => `<${leaf}>${strValue}</${leaf}>`,
    );

    // Insertion fallback: element absent from XML and value is non-empty/non-false.
    // Walk up the ancestor chain (skipping structural elements like #subform) until
    // we find a closing tag that actually exists in the current XML, then insert there.
    // This handles flat datasets XML where all data lives under <topmostSubform> rather
    // than mirroring the deep Page1 / #subform nesting of the XFA template.
    const shouldInsert = result === before && (typeof value === 'string' ? value !== '' : value);
    if (shouldInsert) {
      const parts = fullName.split('.');
      for (let depth = parts.length - 1; depth >= 1; depth--) {
        const parentLeaf = xfaLeafName(parts.slice(0, depth).join('.'));
        if (!parentLeaf || parentLeaf.startsWith('#')) continue;
        const parentRe = parentLeaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const closeTag = new RegExp(`</${parentRe}>`);
        if (!closeTag.test(result)) continue;
        result = result.replace(closeTag, `<${leaf}>${strValue}</${leaf}></${parentLeaf}>`);
        break;
      }
    }
  }
  return result;
}

/**
 * Re-compress the updated datasets XML string and write it back into the
 * PDFRawStream in place, updating the /Length dictionary entry to match.
 */
export function writeXfaDatasetsStream(pdfDoc: PDFDocument, ref: PDFRef, newXml: string): void {
  const stream = pdfDoc.context.lookup(ref);
  if (!(stream instanceof PDFRawStream)) return;
  const newBytes = deflateSync(Buffer.from(newXml, 'utf-8'));
  // PDFRawStream.contents is TypeScript-readonly but mutable at runtime
  (stream as unknown as { contents: Uint8Array }).contents = newBytes;
  stream.dict.set(PDFName.of('Length'), PDFNumber.of(newBytes.length));
}

// ── Candidate field detection constants ──────────────────────────────────────

const MIN_FIELD_WIDTH = 30; // pt — narrower paths are noise
const MAX_FIELD_HEIGHT = 60; // pt — taller non-wide shapes are structural
const CHECKBOX_MAX_DIM = 15; // pt — near-square boxes this size are checkboxes
const TEXTAREA_MIN_H = 30; // pt — tall boxes are textareas
const NOISE_WIDTH_RATIO = 0.85; // fraction of page width → structural rule
const MIN_VISIBLE_HEIGHT = 4; // pt — below this the path is a line, not a visible rectangle

/**
 * Classify a PDF page based on its operator list and AcroForm field count.
 * The operator list scan is O(n) in the number of operators and runs in < 1ms.
 */
export function detectPageType(fnArray: number[], hasAcroFormFields: boolean): PageType {
  if (hasAcroFormFields) return 'acroform';
  const fnSet = new Set(fnArray);
  const hasImages = fnSet.has(OPS.paintImageXObject) || fnSet.has(OPS.paintInlineImageXObject);
  const hasPaths =
    fnSet.has(OPS.stroke) ||
    fnSet.has(OPS.fill) ||
    fnSet.has(OPS.fillStroke) ||
    fnSet.has(OPS.constructPath) ||
    fnSet.has(OPS.rectangle);
  const hasText = fnSet.has(OPS.showText) || fnSet.has(OPS.showSpacedText);
  if (hasImages && !hasPaths && !hasText) return 'raster';
  if (hasImages && !hasPaths && hasText) return 'raster+ocr';
  if (hasImages && (hasPaths || hasText)) return 'hybrid';
  return 'vector';
}

/** 2-D affine transformation matrix in PDF order: [a, b, c, d, e, f]. */
type Matrix = [number, number, number, number, number, number];

/** Apply a CTM to a single point, returning the transformed [x, y]. */
function applyCtm(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Concatenate two matrices: result = m1 * m2. */
function concatMatrix(m1: Matrix, m2: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

/**
 * Transform a local-space bbox [minX, minY, maxX, maxY] to page space via
 * the current CTM, returning a {x, y, w, h} suitable for candidate scoring.
 * A degenerate height (flat underline) is normalised to h=1.
 */
function bboxToBox(
  m: Matrix,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): { x: number; y: number; w: number; h: number } {
  const [px1, py1] = applyCtm(m, minX, minY);
  const [px2, py2] = applyCtm(m, maxX, maxY);
  const x = Math.min(px1, px2);
  const y = Math.min(py1, py2);
  const w = Math.abs(px2 - px1);
  const h = Math.abs(py2 - py1) < 2 ? 1 : Math.abs(py2 - py1); // flat line → 1 pt
  return { x, y, w, h };
}

/**
 * Find the nearest TextBlock that is either directly above or to the left of
 * the candidate bounding box. Returns the block or null.
 */
function findNearestLabel(
  box: { x: number; y: number; w: number; h: number },
  textBlocks: TextBlock[],
): TextBlock | null {
  let best: TextBlock | null = null;
  let bestDist = Infinity;

  const fieldCx = box.x + box.w / 2;
  const fieldCy = box.y + box.h / 2;

  for (const block of textBlocks) {
    const bx = block.placement.x;
    const by = block.placement.y;
    const bw = block.placement.width;
    const bh = block.placement.height;
    const fs = block.fontSize;

    // Above: block baseline within [field.top, field.top + 2*fontSize]
    const fieldTop = box.y + box.h;
    const isAbove = by >= fieldTop && by <= fieldTop + 2 * fs;
    // Horizontal overlap: block x-range overlaps field x-range
    const horizontalOverlap = bx < box.x + box.w && bx + bw > box.x;

    // Left: vertically aligned within 1 line height, block ends before field starts
    const isLeft = Math.abs(by - box.y) < fs && bx + bw < box.x + 5;

    if ((isAbove && horizontalOverlap) || isLeft) {
      const bcx = bx + bw / 2;
      const bcy = by + bh / 2;
      const dist = Math.sqrt((bcx - fieldCx) ** 2 + (bcy - fieldCy) ** 2);
      if (dist < bestDist) {
        bestDist = dist;
        best = block;
      }
    }
  }
  return best;
}

/**
 * Evaluate a bounding box (already in page space) as a candidate field.
 * Applies noise filtering, type inference, label proximity, and confidence scoring.
 */
function evaluateBox(
  box: { x: number; y: number; w: number; h: number },
  textBlocks: TextBlock[],
  pageWidth: number,
  candidates: CandidateField[],
): void {
  const { x, y, w, h } = box;

  // Noise filter
  if (w > pageWidth * NOISE_WIDTH_RATIO) return; // full-width structural rule
  const mightBeCheckbox = Math.abs(w - h) < 4 && w >= 5 && w <= CHECKBOX_MAX_DIM;
  if (!mightBeCheckbox && w < MIN_FIELD_WIDTH && h < MIN_FIELD_WIDTH) return; // tiny artifact
  if (h > MAX_FIELD_HEIGHT && w / (h || 1) < 2) return; // tall non-wide shape

  // Type inference
  let type: CandidateField['type'];
  if (Math.abs(w - h) < 4 && w <= CHECKBOX_MAX_DIM) {
    type = 'checkbox';
  } else if (h > TEXTAREA_MIN_H) {
    type = 'textarea';
  } else {
    type = 'text';
  }

  // Label proximity
  const labelBlock = findNearestLabel({ x, y, w, h }, textBlocks);
  const label = labelBlock?.text ?? '';

  // Confidence
  let confidence: CandidateFieldConfidence;
  const goodGeometry =
    (type === 'checkbox' && w <= CHECKBOX_MAX_DIM) ||
    (type !== 'checkbox' && w >= MIN_FIELD_WIDTH && h <= MAX_FIELD_HEIGHT);
  if (goodGeometry && labelBlock) {
    confidence = 'high';
  } else if (goodGeometry || labelBlock) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }
  // Paths where either dimension is below MIN_VISIBLE_HEIGHT are lines (horizontal or
  // vertical), not visible rectangular boxes. They cannot be medium or high regardless of label.
  if (h < MIN_VISIBLE_HEIGHT || w < MIN_VISIBLE_HEIGHT) confidence = 'low';

  candidates.push({
    id: randomUUID(),
    type,
    label,
    displayName: label,
    placement: { x, y, width: w, height: h },
    value: type === 'checkbox' ? false : '',
    confidence,
    dismissed: false,
  });
}

/**
 * Walk the pdfjs-dist operator list for a page and detect vector path shapes
 * that look like form field blanks (underlines, stroked rectangles, checkboxes).
 * Proximity-matches each candidate to the nearest TextBlock label.
 *
 * Supports two operator formats emitted by pdfjs-dist:
 *   - Legacy: OPS.rectangle (19) followed by OPS.stroke (20) — used in unit tests
 *   - v5+: OPS.constructPath (91) with args = [paintOp, opsAndCoords, Float32Array bbox]
 *
 * CTM tracking via OPS.save / OPS.restore / OPS.transform ensures correct page coords
 * when paths are drawn in a local coordinate space (e.g. pdf-lib drawRectangle).
 */
export function detectCandidateFields(
  ops: { fnArray: number[]; argsArray: unknown[][] },
  textBlocks: TextBlock[],
  pageWidth: number,
): CandidateField[] {
  const candidates: CandidateField[] = [];

  // CTM tracking
  const ctmStack: Matrix[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];

  // Pending rect from OPS.rectangle (legacy path: rectangle → stroke)
  let pendingRect: { x: number; y: number; w: number; h: number } | null = null;

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i] ?? -1;
    const args: unknown[] = ops.argsArray[i] ?? [];

    if (fn === OPS.save) {
      ctmStack.push([...ctm] as Matrix);
    } else if (fn === OPS.restore) {
      const prev = ctmStack.pop();
      if (prev) ctm = prev;
      pendingRect = null;
    } else if (fn === OPS.transform) {
      const m = args as number[];
      if (m.length >= 6) {
        ctm = concatMatrix(ctm, m as Matrix);
      }
    } else if (fn === OPS.rectangle) {
      // Legacy OPS.rectangle (19): args = [x, y, w, h] in current space
      const [rx, ry, rw, rh] = args as number[];
      if (rx !== undefined && ry !== undefined && rw !== undefined && rh !== undefined) {
        pendingRect = bboxToBox(ctm, rx, ry, rx + rw, ry + rh);
      }
    } else if (fn === OPS.stroke || fn === OPS.closeStroke) {
      // Legacy stroke after OPS.rectangle
      if (pendingRect) evaluateBox(pendingRect, textBlocks, pageWidth, candidates);
      pendingRect = null;
    } else if (fn === OPS.constructPath) {
      // pdfjs-dist v5+ format: args = [paintOp, interleavedOpsAndCoords, Float32Array bbox]
      const paintOp = args[0] as number;
      const bbox = args[2] as Float32Array | number[] | undefined;
      if (
        (paintOp === OPS.stroke || paintOp === OPS.closeStroke) &&
        bbox !== undefined &&
        bbox.length >= 4
      ) {
        const [bx0 = 0, bx1 = 0, bx2 = 0, bx3 = 0] = bbox;
        const box = bboxToBox(ctm, bx0, bx1, bx2, bx3);
        evaluateBox(box, textBlocks, pageWidth, candidates);
      }
      pendingRect = null;
    } else if (
      fn === OPS.fill ||
      fn === OPS.eoFill ||
      fn === OPS.fillStroke ||
      fn === OPS.eoFillStroke ||
      fn === OPS.closeFillStroke ||
      fn === OPS.closeEOFillStroke ||
      fn === OPS.endPath
    ) {
      pendingRect = null; // filled/abandoned paths are not blank form fields
    }
  }

  return candidates;
}

/**
 * Analyze a PDF file and extract all AcroForm fields into an FpdfDocument.
 *
 * @param filePath Absolute or relative path to the PDF file.
 * @returns A fully populated FpdfDocument ready to serialize as .fpdf.json.
 * @throws {AnalyzerError} If the file cannot be read or is not a valid PDF.
 */
export async function analyzePdf(filePath: string): Promise<FpdfDocument> {
  const absPath = path.resolve(filePath);

  let bytes: Uint8Array;
  try {
    bytes = await readFile(absPath);
  } catch (err) {
    throw new AnalyzerError(
      `Cannot read file: ${absPath} — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let pdfDoc: PDFDocument;
  try {
    pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch (err) {
    throw new AnalyzerError(
      `Failed to parse PDF: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Load with pdfjs-dist for text extraction (best-effort; errors leave textBlocks empty).
  let pdfjsDoc: Awaited<ReturnType<typeof getDocument>['promise']> | null = null;
  try {
    pdfjsDoc = await getDocument({
      data: new Uint8Array(bytes), // copy — pdfjs-dist takes ownership of TypedArray inputs
      useSystemFonts: true,
      disableFontFace: true,
      verbosity: 0,
    }).promise;
  } catch {
    logger.warn(`pdfjs-dist failed to load ${path.basename(absPath)}; textBlocks will be empty`);
  }

  const now = new Date().toISOString();
  const pdfFilename = path.basename(absPath);
  const pdfHash = `sha256:${sha256Hex(bytes)}`;
  const pageCount = pdfDoc.getPageCount();

  // Build a map: page PDFRef objectNumber → 1-based page index.
  const pageRefToNum = new Map<number, number>();
  for (let i = 0; i < pageCount; i++) {
    const pageRef = pdfDoc.getPage(i).ref;
    pageRefToNum.set(pageRef.objectNumber, i + 1);
  }

  // Check for XFA BEFORE calling getForm() — pdf-lib's getForm() deletes /AcroForm/XFA.
  // For XFA PDFs: include read-only AcroForm widgets (they're locked for non-XFA editors
  // but ARE user-editable via XFA), and source values from the datasets XML instead of /V.
  const xfaDatasetsInfo = getXfaDatasetsInfo(pdfDoc);
  const xfaValues = xfaDatasetsInfo ? parseXfaDatasetValues(xfaDatasetsInfo.xml) : null;
  const isXfaPdf = xfaValues !== null;

  // Group fields by page.
  const pageFields = new Map<number, PdfField[]>();
  for (let p = 1; p <= pageCount; p++) {
    pageFields.set(p, []);
  }

  const form = pdfDoc.getForm();
  let rawFields: PDFField[];
  try {
    rawFields = form.getFields();
  } catch {
    rawFields = []; // malformed /AcroForm — fall through to orphan walk
  }

  for (const field of rawFields) {
    const type = fieldTypeFor(field);
    if (type === null) continue; // skip button/signature widgets
    // For XFA PDFs, include read-only fields (they're editable via XFA, just locked for
    // non-XFA editors).  For non-XFA PDFs, skip display-only fields as before.
    if (!isXfaPdf && field.isReadOnly()) continue;
    const value = isXfaPdf
      ? (xfaValues.get(xfaLeafName(field.getName())) ?? fieldValue(field))
      : fieldValue(field);
    const options = fieldOptions(field);
    const widgets = field.acroField.getWidgets();

    for (const widget of widgets) {
      const rect = widget.getRectangle();
      const placement: Placement = {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };

      // P() returns the PDFRef of the page this widget appears on.
      const pageRef = widget.P();
      const pageNum = pageRef ? (pageRefToNum.get(pageRef.objectNumber) ?? 1) : 1;

      const label = deriveLabel(field.getName());
      const tuEntry = field.acroField.dict.lookupMaybe(PDFName.of('TU'), PDFString);
      const tooltip = tuEntry ? tuEntry.decodeText().trim() : undefined;

      // For radio widgets, record the specific option (on-value) this widget
      // represents so the UI can render each button correctly and store the
      // selected option string instead of a boolean.
      const radioValue =
        type === 'radio' ? (widget.getOnValue()?.decodeText() ?? undefined) : undefined;

      const pdfField: PdfField = {
        id: randomUUID(),
        name: field.getName(),
        type,
        label,
        displayName: deriveDisplayName(label),
        ...(tooltip ? { tooltip } : {}),
        placement,
        value,
        required: field.isRequired(),
        // XFA marks AcroForm widgets as ReadOnly to block non-XFA editors;
        // surface them as editable since the exporter will write via XFA datasets.
        readOnly: isXfaPdf ? false : field.isReadOnly(),
        options,
        ...(radioValue !== undefined ? { radioValue } : {}),
      };

      const bucket = pageFields.get(pageNum) ?? pageFields.get(1);
      if (bucket) bucket.push(pdfField);
    }
  }

  // Orphan widget fallback: walk each page's raw /Annots array to pick up Widget
  // annotations not reachable via form.getFields() (broken /AcroForm field tree).
  const knownNames = new Set(rawFields.map((f) => f.getName()));
  for (let p = 1; p <= pageCount; p++) {
    const orphans = extractOrphanWidgets(pdfDoc, p, knownNames);
    if (orphans.length > 0) {
      const bucket = pageFields.get(p) ?? [];
      bucket.push(...orphans);
      pageFields.set(p, bucket);
    }
  }

  const pages: PdfPage[] = [];
  for (let p = 1; p <= pageCount; p++) {
    const page = pdfDoc.getPage(p - 1);
    const { width, height } = page.getSize();

    let textBlocks: TextBlock[] = [];
    let pageType: PageType = 'vector';
    let candidateFields: CandidateField[] = [];

    if (pdfjsDoc !== null) {
      try {
        const pdfjsPage = await pdfjsDoc.getPage(p); // 1-based
        // Fetch operator list once — shared by pageType detection and candidateFields
        const ops = await pdfjsPage.getOperatorList();
        const pageHasAcroFields = (pageFields.get(p) ?? []).length > 0;
        pageType = detectPageType(ops.fnArray, pageHasAcroFields);
        textBlocks = await extractTextBlocks(pdfjsPage);
        if (pageType !== 'acroform' && pageType !== 'raster') {
          candidateFields = detectCandidateFields(
            { fnArray: ops.fnArray, argsArray: ops.argsArray as unknown[][] },
            textBlocks,
            width,
          );
        }
      } catch {
        // best-effort — leave pageType/textBlocks/candidateFields at defaults
      }
    }

    pages.push({
      pageNumber: p,
      widthPt: width,
      heightPt: height,
      pageType,
      fields: pageFields.get(p) ?? [],
      candidateFields,
      textBlocks,
    });
  }

  const metadata: FpdfMetadata = {
    version: '1.0',
    originalPdf: absPath,
    pdfFilename,
    pdfHash,
    createdAt: now,
    updatedAt: now,
    pageCount,
  };

  return { metadata, pages };
}
