# fpdf — Implementation Plan

## Overview

A TypeScript/Node CLI that analyzes a PDF, extracts field geometry, spawns a local web server, and overlays an interactive HTML form precisely on top of the rendered PDF. State is stored in a portable `.fpdf.json` file.

---

## Architecture

```
fpdf/
├── src/
│   ├── cli.ts              # Entry point, command parsing
│   ├── analyzer.ts         # PDF field + geometry extraction
│   ├── server.ts           # Express local server + WebSocket for live save
│   ├── types.ts            # Shared TypeScript interfaces
│   └── public/
│       ├── index.html      # Web UI shell
│       ├── app.ts          # Frontend: renders PDF canvas + overlays
│       └── styles.css
├── package.json
├── tsconfig.json
└── tsconfig.web.json       # Separate build for browser bundle
```

---

## Key Libraries

| Purpose | Library |
|---|---|
| PDF form field extraction | `pdf-lib` (AcroForm fields, coordinates, types) |
| PDF rendering in browser | `pdfjs-dist` (client-side canvas rendering) |
| CLI argument parsing | `commander` |
| Local web server | `express` |
| Live sync (save/reload) | `ws` (WebSocket) |
| Open browser automatically | `open` |
| Frontend bundling | `esbuild` (fast, simple) |

---

## The JSON Schema (`.fpdf.json`)

```json
{
  "metadata": {
    "version": "1.0",
    "originalPdf": "/abs/path/to/file.pdf",
    "pdfFilename": "form.pdf",
    "pdfHash": "sha256:abc123...",
    "createdAt": "2026-03-22T10:00:00Z",
    "updatedAt": "2026-03-22T10:05:00Z",
    "pageCount": 2
  },
  "pages": [
    {
      "pageNumber": 1,
      "widthPt": 612,
      "heightPt": 792,
      "pageType": "acroform",
      "fields": [
        {
          "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          "name": "topmostSubform[0].Page1[0]._6_Date_of_Birth_MMDDCCYY[0]",
          "type": "text",
          "label": "6 Date of Birth MMDDCCYY",
          "displayName": "Date of Birth",
          "placement": {
            "x": 144.0,
            "y": 600.0,
            "width": 180.0,
            "height": 18.0
          },
          "value": "",
          "required": false,
          "readOnly": false,
          "options": []
        }
      ],
      "candidateFields": [
        {
          "id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
          "type": "text",
          "label": "First Name",
          "displayName": "First Name",
          "placement": {
            "x": 50.0,
            "y": 648.0,
            "width": 200.0,
            "height": 14.0
          },
          "value": "",
          "confidence": "high",
          "dismissed": false
        }
      ],
      "textBlocks": [
        {
          "text": "Patient Information",
          "placement": {
            "x": 50.0,
            "y": 720.0,
            "width": 120.0,
            "height": 14.0
          },
          "fontSize": 14.0,
          "fontName": "TT1"
        },
        {
          "text": "First Name",
          "placement": {
            "x": 50.0,
            "y": 675.0,
            "width": 60.0,
            "height": 10.0
          },
          "fontSize": 10.0,
          "fontName": "TT2"
        }
      ]
    }
  ]
}
```

### pageType notes
- `pageType` is one of `"acroform" | "vector" | "raster" | "raster+ocr" | "hybrid"`
- Determined per-page by scanning the pdfjs-dist operator list; `acroform` takes precedence if `pdf-lib` finds any AcroForm fields on the page
- The UI uses `pageType` to show a banner for unsupported types (`raster`, `raster+ocr`) and to decide whether to render `candidateFields`

### Field notes
- `id` is a UUID generated at analysis time — stable across re-analyses of the same PDF
- `name` is the raw AcroForm field name as embedded in the PDF (may be an XFA-style path)
- `label` is a derived, number-prefixed label useful for cross-referencing the paper form (e.g. `"6 Date of Birth MMDDCCYY"`)
- `displayName` is a cleaned-up version of the label for UI rendering — strips the field number, format hints like `MMDDCCYY`, back-references like `in 4`, and trailing address/name format fragments (e.g. `"Date of Birth"`)
- `placement` is in **PDF coordinate space** (points, bottom-left origin) — the UI transforms these to CSS positions
- `options` is populated for dropdowns and radio groups
- `value` is what the user fills in (string for text/select, boolean for checkboxes)
- The file is human-editable: a user can fill in `value` fields directly in a text editor

### textBlocks notes
- `textBlocks` contains static text extracted from the page content stream — section headers, field labels, instructions — anything drawn as PDF text rather than an AcroForm widget
- Each block is a logical line: adjacent `TextItem`s with the same `fontName`, fontSize within 0.5pt, and y-position within half the font size are merged into one block
- `placement` uses the same PDF coordinate space (bottom-left origin) as `fields` — use proximity to associate a label block with nearby form fields
- `fontSize` is in points, derived from the rendered glyph height as reported by `pdfjs-dist`
- `fontName` is the PDF font resource name (e.g. `"TT1"`, `"g_d0_f1"`) — consistent within a document, useful to distinguish header fonts from body/label fonts
- `textBlocks` is always present (never omitted), but may be an empty array if text extraction fails

### candidateFields notes
- `candidateFields` contains fields detected from vector paths (lines, rectangles) in the page content stream — present only on pages where the PDF has no AcroForm, or always populated alongside AcroForm `fields`
- Each candidate has the same `placement` coordinate space as `fields`
- `label` / `displayName` are derived from the nearest `TextBlock` above or to the left of the path; empty string if no nearby text was found
- `type` is inferred: `checkbox` if near-square (w ≈ h < 15pt); `textarea` if height > 30pt; `text` otherwise
- `confidence` is one of `"high" | "medium" | "low"` — signals how likely a detected path is a real form field:
  - `"high"`: correct aspect ratio for a form field **and** a nearby `TextBlock` label was matched
  - `"medium"`: correct aspect ratio but no label found nearby, or label found but geometry is ambiguous
  - `"low"`: geometry looks like a structural rule or border (full-width line, page-margin rect, etc.) but wasn't filtered out
- `dismissed: true` means the user has explicitly discarded this candidate — the UI hides it; it remains in the JSON so re-analysis doesn't resurface it
- `candidateFields` are **never** written back to the PDF by `fpdf export` (no AcroForm backing); their `value`s are only saved in `.fpdf.json`
- `candidateFields` is always present (never omitted), but will be `[]` for pure AcroForm PDFs where all fields are already in `fields`

---

## CLI Commands

```bash
fpdf fill <file.pdf>                              # Analyze PDF, start server, print URL to stdout
fpdf fill <file.pdf> --open                       # Same, and also launch the default browser
fpdf fill <file.pdf> --json <existing.fpdf.json>  # Resume from a saved JSON session
fpdf analyze <file.pdf>                           # Only extract fields, write JSON, no server
fpdf export <file.fpdf.json>                      # Write filled values back into a new PDF (v2)
```

- The server always binds on **port 0** — the OS picks a free port at runtime.
- The CLI prints the allocated URL to stdout: `Listening on http://127.0.0.1:PORT`
- `--open` (optional flag) calls the system's default browser automatically. Without it the user copies the URL manually.

---

## Web UI Behavior

1. Server sends the PDF bytes and the JSON to the browser
2. **`pdfjs-dist`** renders each PDF page to a `<canvas>` at full fidelity; this canvas is the **print watermark** (see below)
3. A `<div>` overlay layer sits absolutely on top of each canvas
4. For each field, a matching HTML input element is positioned using translated coordinates:
   - `<input type="text">` / `<textarea>` for text fields
   - `<select>` for dropdowns
   - `<input type="checkbox">` for checkboxes
   - `<input type="radio">` for radio groups
5. All changes are debounce-saved via WebSocket → server writes `.fpdf.json` in real time
6. A status bar shows last-saved timestamp and dirty state

### Print layout

- The PDF canvas layer is **always visible** — it acts as the page background, not a separate overlay.
- CSS `@media print` rules hide all chrome (status bar, browser UI) and preserve the canvas + input overlay exactly.
- Inputs use a transparent background and no visible border so printed output looks like a natively filled PDF.
- Page dimensions are locked to the PDF's point dimensions (converted to inches) so the browser print dialog produces a 1:1 match with the original page size.

---

## PDF Analysis Strategy

### Page type detection

Before running any extractor, each page is classified by scanning `pdfjsPage.getOperatorList()` once. The result is stored as `pageType` on `PdfPage` and drives which extractors run and what the UI shows.

| `pageType` | `hasImages` | `hasPaths` | `hasText` | Extractors that run | Fields editable? | Exportable to PDF? |
|---|---|---|---|---|---|---|
| `acroform` | any | any | any | AcroForm (pdf-lib) + textBlocks | ✅ Now | ✅ Now (`fpdf export`) |
| `vector` | ✗ | ✓ | ✓ | textBlocks + candidateFields (vector path) | 🔲 M11 (values saved to `.fpdf.json` only) | ❌ No AcroForm backing |
| `raster` | ✓ | ✗ | ✗ | none — scanned image only | ❌ No fields detected | ❌ |
| `raster+ocr` | ✓ | ✗ | ✓ | textBlocks only (hidden OCR text layer) | ❌ No fields detected | ❌ |
| `hybrid` | ✓ | ✓ | ✓ | textBlocks + candidateFields | 🔲 M11 (values saved to `.fpdf.json` only) | ❌ No AcroForm backing |

Detection (single pass over `fnArray`):
```typescript
const fnSet = new Set(ops.fnArray);
const hasImages = fnSet.has(OPS.paintImageXObject) || fnSet.has(OPS.paintInlineImageXObject);
const hasPaths  = fnSet.has(OPS.stroke) || fnSet.has(OPS.fill)
               || fnSet.has(OPS.fillStroke) || fnSet.has(OPS.constructPath);
const hasText   = fnSet.has(OPS.showText) || fnSet.has(OPS.showSpacedText);
```

AcroForm is checked independently via `pdf-lib` and takes precedence: a page can be `acroform` even if it also has vector paths or images underneath.

### Phase 1 — MVP: AcroForm fields
- `pdf-lib` enumerates all AcroForm fields: type, name, rectangle, current value
- Covers the majority of fillable PDFs (government forms, contracts, etc.)

### Phase 2 — Vector path detection (non-AcroForm PDFs)

PDFs that were not created with AcroForm draw their "write here" areas as vector paths.
Two dominant patterns:

| Pattern | PDF operators | Example |
|---|---|---|
| Underline / blank line | `m x1 y1 l x2 y1 S` or very thin `re` | `Name: ___________` |
| Box / text field outline | `re x y w h S` (stroked only) | Outlined input box |
| Checkbox | Small near-square `re` (w ≈ h, both < 15pt) | `□ Yes` |

Detection algorithm (in `analyzer.ts`):

1. Call `pdfjsPage.getOperatorList()` — returns a flat list of operator codes + argument arrays
2. Walk the list maintaining a graphics-state stack (tracking current transform matrix for `cm`)
3. Recognize candidate paths:
   - **Thin horizontal line** `m`/`l`/`S`: width > 30pt, height < 3pt → text field
   - **Stroked rectangle** `re`/`S` (no fill): aspect ratio > 3:1 → text field; near-square (aspect < 1.5:1, both dims < 15pt) → checkbox
4. Filter out noise: rectangles that perfectly match page margins or are full-page-width are structural rules, not fields
5. **Label proximity matching**: for each candidate, search `textBlocks` for the nearest block with `y` just above the candidate (within 2× the block's fontSize) or immediately to its left (within 1 line height); that block becomes the candidate's `label` / `displayName`
6. Infer `type`: `checkbox` if near-square; `textarea` if height > 30pt; `text` otherwise
7. **Assign confidence**:
   - `"high"` — good form-field geometry (correct aspect ratio, reasonable size) **and** a label was matched
   - `"medium"` — good geometry but no label found, or label found but geometry is borderline
   - `"low"` — geometry survived noise filtering but is ambiguous (e.g., short line, unlabelled box)
8. Emit each candidate as a `CandidateField` — these are **never** written back to the PDF (no AcroForm backing), only saved in `.fpdf.json`

### Phase 3 — Scanned PDFs (future)
- Would require OCR (e.g. `tesseract.js`) or a vision LLM — out of scope for now

---

## Coordinate Handling

PDF coordinate space: points (1 pt = 1/72 inch), origin at bottom-left.

The browser UI transforms to CSS top-left origin:

```
scale    = canvasWidthPx / pageWidthPt
cssLeft  = field.x * scale
cssTop   = (pageHeightPt - field.y - field.height) * scale
cssWidth = field.width * scale
cssHeight = field.height * scale
```

---

## Data Flow

```
fpdf fill form.pdf
   │
   ├─ Does form.fpdf.json exist?
   │     ├─ Yes → load it (skip analysis, restore existing values)
   │     └─ No  → run analyzer → write form.fpdf.json
   │
   ├─ Start Express server on port 0 (OS-allocated)
   ├─ Serve: PDF bytes, JSON data, static UI assets
   ├─ Print "Listening on http://127.0.0.1:PORT" to stdout
   ├─ If --open flag: launch default browser automatically
   │
   └─ WebSocket channel:
         UI ──(field change)──▶ server ──▶ writes form.fpdf.json
         server ──(saved ack)──▶ UI status bar
```

---

## Milestones

Each milestone is implemented as exactly one branch in a Graphite stack (`gt create -m "feat: ..."`) and submitted as its own PR via `gt submit`. Branches stack on top of each other in order — do not merge a milestone PR before the one beneath it has landed on `main`.

| # | Branch name | Milestone | Status |
|---|---|---|---|
| 1 | `03-22-feat_project_scaffold` | Project scaffold: TypeScript, `esbuild`, `commander`, basic CLI wiring | ✅ |
| 2 | `03-22-feat_analyzer_acroform_extraction_with_pdf-lib` | `analyzer.ts`: AcroForm extraction with `pdf-lib`, produces `.fpdf.json` | ✅ |
| 3 | `03-22-feat_server_express_websocket_serving_pdf_json_and_static_assets` | `server.ts`: Express serves PDF + JSON + static files + WebSocket endpoint | ✅ |
| 4 | `03-22-feat_ui_render_pdf.js_canvas_field_overlay` | `app.ts` (browser): PDF.js canvas render + computed field overlay | ✅ |
| 5 | `03-22-feat_websocket_save_loop` | WebSocket save loop: field edits → debounced JSON write → ack to UI | ✅ |
| 5a | `03-22-feat_zoom_ctrl_wheel_with_tooltip_hover_hints` | Zoom (Ctrl+scroll + toolbar buttons), AcroForm `/TU` tooltip on hover | ✅ |
| 5b | `03-22-feat_watch_json_file_for_external_changes_and_reload_livedoc` | Watch `.fpdf.json` for external edits; broadcast `docReload` to UI | ✅ |
| 6 | `03-22-feat_auto-resume_from_existing_.fpdf.json_milestone_6_` | JSON resume: auto-detect existing `.fpdf.json`, restore previous field values | ✅ |
| 6a | `03-22-feat_add_acroform_tooltip__tu_to_pdffield_json` | Add AcroForm `/TU` tooltip field to `.fpdf.json` schema and analyzer | ✅ |
| 7 | `03-22-feat_polish_font_scaling_required_markers_print_sizing_error_banner_m7_` | Polish: font size scaling, required-field markers, print page sizing, error banner | ✅ |
| 7a | `03-22-feat_dynamic_font_scaling_to_prevent_overflow_in_text_fields` | Dynamic font shrink on input so text always fits the field without scrolling | ✅ |
| 8 | `03-22-feat_export_filled_pdf_via_browser_button_and_cli_milestone_8_` | `fpdf export`: write filled values back into AcroForm PDF; browser Export PDF button | ✅ |
| 9 | `03-22-feat_extract_static_page_text_into_textblocks_on_each_page` | `textBlocks`: extract static page text (headers, labels) via pdfjs-dist; add to schema | ✅ |
| 10 | `03-22-feat_vector_path_candidate_field_detection` | `pageType` detection + `candidateFields`: classify each page via `getOperatorList()`; parse paths to find line/rect blanks; proximity-match `TextBlock` labels; assign `confidence`; add `PageType`, `CandidateField` types + both fields to schema | 🔲 |
| 11 | `03-22-feat_ui_overlay_candidate_fields_with_dismiss` | UI renders `candidateFields` in a distinct style per confidence level (dashed border, muted background); each widget has a dismiss × button that sets `dismissed: true` and saves; toolbar toggle shows/hides dismissed candidates | 🔲 |
