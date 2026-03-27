/**
 * Shared TypeScript interfaces for fpdf.
 * All coordinates are in PDF point space (1pt = 1/72 inch, origin bottom-left)
 * unless explicitly noted otherwise.
 */

export type FieldType = 'text' | 'textarea' | 'checkbox' | 'radio' | 'select';

/**
 * Classification of a PDF page based on its content stream operators.
 * Determines which extractors run and whether fields are editable or exportable.
 *
 * acroform   — has AcroForm fields (pdf-lib); editable + exportable to PDF
 * vector     — digitally created, no AcroForm; editable via candidateFields, not exportable
 * raster     — scanned image only; no fields auto-detected; fields can be added manually
 * raster+ocr — scanned image with embedded OCR text layer; fields can be added manually
 * hybrid     — images + vector paths; editable via candidateFields, not exportable
 */
export type PageType = 'acroform' | 'vector' | 'raster' | 'raster+ocr' | 'hybrid';

/**
 * Document-level classification of a PDF's form structure.
 *
 * acroform     — has AcroForm fields, no XFA datasets
 * xfa-hybrid   — has AcroForm widgets AND XFA datasets (e.g. Cigna)
 * pure-xfa     — XFA datasets only, no traditional AcroForm widgets
 * no-acroform  — no AcroForm at all (pages are vector/raster/hybrid)
 */
export type PdfKind = 'acroform' | 'xfa-hybrid' | 'pure-xfa' | 'no-acroform';

/** How likely a detected vector path candidate is a real form field. */
export type CandidateFieldConfidence = 'high' | 'medium' | 'low';

/**
 * A form field candidate detected from vector paths (lines, rectangles) in the
 * page content stream. Used for non-AcroForm PDFs where "write here" areas are
 * drawn rather than declared as AcroForm widgets.
 *
 * CandidateFields have no AcroForm backing — on export, values are stamped
 * as drawn text directly onto the page rather than written into AcroForm widgets.
 */
export interface CandidateField {
  /** Stable UUID generated at analysis time. */
  id: string;
  type: 'text' | 'textarea' | 'checkbox';
  /** Derived from the nearest TextBlock above or to the left of the path. Empty if none found. */
  label: string;
  displayName: string;
  placement: Placement;
  value: string | boolean;
  /** Likelihood that this detected path is a real form field, not a decorative rule. */
  confidence: CandidateFieldConfidence;
  /** True when the user has explicitly dismissed this candidate. Hidden in UI; preserved in JSON. */
  dismissed: boolean;
  /** Text alignment for the input field, set by the user. */
  textAlign?: 'left' | 'center' | 'right' | 'justify';
}

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
  /** Current fill value. String for text/select/radio, boolean for checkbox. */
  value: string | boolean;
  required: boolean;
  readOnly: boolean;
  /** Populated for 'select' and 'radio' fields. */
  options: string[];
  /**
   * For `type: 'radio'` only — the specific option (on-value) this widget
   * represents, e.g. `"0"` or `"1"`.  The group's current selection is stored
   * in `value` (same across all widgets for the same radio group name).
   * Allows the UI to render each radio button correctly and store the selected
   * option string rather than a boolean.
   */
  radioValue?: string;
  /** Text alignment for the input field, set by the user. */
  textAlign?: 'left' | 'center' | 'right' | 'justify';
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
  /**
   * Classification based on the pdfjs-dist operator list.
   * Drives which extractors ran and what the UI can offer.
   */
  pageType: PageType;
  fields: PdfField[];
  /**
   * Form field candidates detected from vector paths (lines, rectangles).
   * Empty for pure AcroForm pages. Never written back to the PDF.
   */
  candidateFields: CandidateField[];
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
  /** Document-level form structure classification. Added in schema v1.1. */
  pdfKind?: PdfKind;
}

export interface FpdfDocument {
  metadata: FpdfMetadata;
  pages: PdfPage[];
}
