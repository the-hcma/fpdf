/**
 * Shared TypeScript interfaces for fpdf.
 * All coordinates are in PDF point space (1pt = 1/72 inch, origin bottom-left)
 * unless explicitly noted otherwise.
 */

export type FieldType = 'text' | 'textarea' | 'checkbox' | 'radio' | 'select';

export interface Placement {
  /** Left edge of the field in PDF points (bottom-left origin). */
  x: number;
  /** Bottom edge of the field in PDF points (bottom-left origin). */
  y: number;
  width: number;
  height: number;
}

export interface PdfField {
  /** Stable UUID for this field widget. */
  id: string;
  /** AcroForm field name as embedded in the PDF. */
  name: string;
  type: FieldType;
  /** Derived label including the form field number, e.g. "6 Date of Birth". */
  label: string;
  /** Cleaned-up display name for UI rendering, e.g. "Date of Birth". */
  displayName: string;
  /**
   * AcroForm alternate field name (/TU entry) — human-readable instructions
   * embedded in the PDF, e.g. "Enter patient's date of birth (MM/DD/YYYY)".
   * Omitted when the field has no /TU entry.
   */
  tooltip?: string;
  placement: Placement;
  /** Current fill value. String for text/select, boolean for checkbox/radio. */
  value: string | boolean;
  required: boolean;
  readOnly: boolean;
  /** Populated for 'select' and 'radio' fields. */
  options: string[];
}

/**
 * A run of static text from the page content stream (not an AcroForm field).
 * Useful for LLM-based form filling: proximity to a TextBlock identifies the
 * section or label that explains what belongs in a nearby field.
 */
export interface TextBlock {
  text: string;
  placement: Placement;
  /** Font size in points, derived from the rendered glyph height. */
  fontSize: number;
  /**
   * PDF font resource name as reported by pdfjs-dist, e.g. "TT1" or "g_d0_f1".
   * Consistent within a document — use it to distinguish header fonts from
   * label fonts (they typically differ).
   */
  fontName: string;
}

export interface PdfPage {
  pageNumber: number;
  /** Page width in PDF points. */
  widthPt: number;
  /** Page height in PDF points. */
  heightPt: number;
  fields: PdfField[];
  /**
   * Static text blocks extracted from the page content stream, sorted
   * top-to-bottom. Includes headers, labels, and instructions — anything
   * that is drawn text rather than an AcroForm widget.
   */
  textBlocks: TextBlock[];
}

export interface FpdfMetadata {
  /** Schema version for future migrations. */
  version: string;
  /** Absolute path to the source PDF. */
  originalPdf: string;
  pdfFilename: string;
  /** SHA-256 content hash, prefixed with "sha256:". */
  pdfHash: string;
  createdAt: string;
  updatedAt: string;
  pageCount: number;
}

export interface FpdfDocument {
  metadata: FpdfMetadata;
  pages: PdfPage[];
}
