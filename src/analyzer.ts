import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
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
  type PDFField,
} from 'pdf-lib';
import type {
  FpdfDocument,
  FpdfMetadata,
  PdfField,
  PdfPage,
  Placement,
  FieldType,
} from './types.js';

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

  // Group fields by page.
  const pageFields = new Map<number, PdfField[]>();
  for (let p = 1; p <= pageCount; p++) {
    pageFields.set(p, []);
  }

  const form = pdfDoc.getForm();
  const rawFields = form.getFields();

  for (const field of rawFields) {
    const type = fieldTypeFor(field);
    if (type === null) continue; // skip button/signature widgets
    if (field.isReadOnly()) continue; // skip display-only fields
    const value = fieldValue(field);
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
        readOnly: field.isReadOnly(),
        options,
      };

      const bucket = pageFields.get(pageNum) ?? pageFields.get(1);
      if (bucket) bucket.push(pdfField);
    }
  }

  const pages: PdfPage[] = [];
  for (let p = 1; p <= pageCount; p++) {
    const page = pdfDoc.getPage(p - 1);
    const { width, height } = page.getSize();
    pages.push({
      pageNumber: p,
      widthPt: width,
      heightPt: height,
      fields: pageFields.get(p) ?? [],
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
