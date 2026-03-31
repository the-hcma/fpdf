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
│   ├── exporter.ts         # Write filled values back into a PDF (AcroForm + XFA)
│   ├── regenerator.ts      # XFA → clean AcroForm PDF regeneration
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
    "pageCount": 2,
    "pdfKind": "acroform"
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
          "options": [],
          "fontName": "TimesRoman",
          "fontSize": 10
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
          "dismissed": false,
          "fontName": "Courier",
          "fontSize": 11
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

### pdfKind notes
- `pdfKind` is a document-level classification: `"acroform" | "xfa-hybrid" | "pure-xfa" | "no-acroform"`
- Computed once in `analyzePdf()` via `computePdfKind(hasXfa, hasAcroFormFields)` and stored in `metadata`
- The UI uses it to show banners: `xfa-hybrid` and `pure-xfa` offer a "Regenerate as standard PDF" action; `no-acroform` shows a scanned/vector warning
- The exporter uses the stored `pdfKind` to choose the XFA or AcroForm write path without re-detecting at export time; falls back to runtime detection for old `.fpdf.json` files that predate this field

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

### Field font notes
- `fontName` (optional) — a `pdf-lib` `StandardFonts` name (e.g. `"Helvetica"`, `"TimesRoman"`, `"Courier"`). For `PdfField`, extracted from the `/DA` (Default Appearance) entry during analysis; omitted when Helvetica (the pdf-lib default) or unknown. For `CandidateField`, set by the user via the context-menu font picker. Used as the font on export.
- `fontSize` (optional) — point size extracted from `/DA` (e.g. `10`, `12`). A PDF `/DA` size of `0` means "auto-size" — this is treated as omitted. When present, used as the auto-fit ceiling during export instead of the hard-coded 12 pt maximum.

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
- `candidateFields` are exported as real AcroForm widget annotations by `fpdf export` for non-XFA PDFs; for XFA PDFs their values are stamped as drawn text instead
- `candidateFields` is always present (never omitted), but will be `[]` for pure AcroForm PDFs where all fields are already in `fields`

---

## CLI Commands

```bash
fpdf fill <file.pdf>                              # Analyze PDF, start server, print URL to stdout
fpdf fill <file.pdf> --open                       # Same, and also launch the default browser
fpdf fill <file.pdf> --json <existing.fpdf.json>  # Resume from a specific saved session file
fpdf fill <file.pdf> --fresh                      # Ignore any existing .fpdf.json; re-analyze from scratch
fpdf analyze <file.pdf>                           # Only extract fields, write JSON, no server
fpdf export <file.fpdf.json>                      # Write filled values back into a new PDF
fpdf export <file.fpdf.json> -o out.pdf           # Same, with an explicit output path
```

- The server always binds on **port 0** — the OS picks a free port at runtime.
- The CLI prints the allocated URL to stdout: `Listening on http://127.0.0.1:PORT`
- `--open` (optional flag) calls the system's default browser automatically. Without it the user copies the URL manually.
- `--fresh` discards the existing session and re-runs `analyzePdf()`, overwriting the `.fpdf.json`. Use this when the PDF has changed or you want to start over without manual file deletion.

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
| `vector` | ✗ | ✓ | ✓ | textBlocks + candidateFields (vector path) | ✅ | ✅ AcroForm widgets (M11.2) |
| `raster` | ✓ | ✗ | ✗ | none — fields added manually via right-click | ✅ manual | ✅ AcroForm widgets (M11.2) |
| `raster+ocr` | ✓ | ✗ | ✓ | textBlocks only (hidden OCR text layer); fields added manually | ✅ manual | ✅ AcroForm widgets (M11.2) |
| `hybrid` | ✓ | ✓ | ✓ | textBlocks + candidateFields | ✅ | ✅ AcroForm widgets (M11.2) |

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
- `pdf-lib` enumerates all AcroForm fields via `form.getFields()`: type, name, rectangle, current value
- Covers the majority of fillable PDFs (government forms, contracts, etc.)

**Phase 1.5 — Orphan widget fallback (M10.5)**
Some real-world PDFs have Widget annotations on pages whose `/AcroForm` field tree is broken or whose root fields array doesn't link back to all widgets. `form.getFields()` misses these; the widgets are still reachable via each page's `/Annots` array.

After calling `form.getFields()`, the analyzer walks each page's raw annotation list and picks up any Widget annotations not already captured. A Widget is "orphan" if its full dotted field name (composed by walking the `/Parent` chain and joining `/T` values with `.`) is absent from the set of names already collected. Orphan widgets are extracted into `PdfField` entries and added to the same `pageFields` map, making the page type `acroform` so export via pdf-lib still works.

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

### Phase 2.5 — Section container heuristic (M10.10)

Forms that draw fields as **horizontal lines inside outer rectangular sections** (e.g. Cigna pharmacy claim form) produce two detection problems:

1. **Wide container cells** — Grid reconstruction creates cells for EVERY H-line pair, including wide H-lines that span multiple columns. These wide cells (which contain narrower per-field cells) appear as oversized yellow boxes in the UI.
2. **Labels below the line** — Many print-and-fill forms place the field label *below* the fill-in blank, not above. The existing `findNearestLabel` only looks above or to the left.

**Fix — Part A: Phase 1 container-cell suppression**

After grid reconstruction phases 1/2/2b, post-process all raw cells before emitting:
- A cell at `(x, y, w, h)` is a **container** if ≥ 2 other cells share the same approximate y-range (`|Δy| ≤ HLINE_SNAP`, `|Δh| ≤ HLINE_SNAP`) and their x-range is strictly contained within it (inner.x ≥ outer.x and inner.x + inner.w ≤ outer.x + outer.w).
- Container cells are NOT emitted as `CandidateField` entries.
- Non-container cells whose x-range is fully contained within a container cell are emitted with `labelHint: 'below'`.

**Fix — Part B: `findLabelBelow`**

New function, mirroring `findNearestLabel` but looking *downward*:
- A text block qualifies if its baseline `by` is in `[box.y - 2*fontSize, box.y)` (just below the field's lower edge in PDF point space) and its centre-x falls within the field's x-range.

**Fix — Part C: Phase 3 stroked-rect container heuristic**

For forms where outer section boundaries are drawn as tall stroked rectangles (not H-line pairs):
- Collect all stroked boxes with `h > MAX_FIELD_HEIGHT` into `deferredLargeBoxes` for deferred evaluation.
- After collecting all H-lines, identify which deferred boxes are **section containers**: they enclose ≥ `SECTION_CONTAINER_MIN_HLINES` (2) H-lines within their x/y bounds.
- Section containers are NOT emitted as fields.
- H-lines inside a section container are grouped by approximate y (rows). Each row's lines are emitted as individual fields using `labelHint: 'below'`, with height = distance to the next row above (or container top).
- Non-container deferred boxes are evaluated normally.

**New constants:**
```
SECTION_CONTAINER_MIN_HLINES = 2   // min H-lines to treat a stroked rect as a container
```

**Integration test:** `src/__tests__/fixtures/cigna-pharmacy-claim-form.pdf` — a Cigna pharmacy claim form (PDF 1.3, 6 pages, vector/hybrid). Page 2 contains the prescription section with H-line fields inside outer section boxes. Expected: page 2 is `hybrid`, has ≥ 8 candidate fields in the prescription section, no container-width (≥ 250pt) fields emitted.

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
fpdf fill form.pdf [--fresh] [--open] [--json path]
   │
   ├─ --fresh flag set?
   │     ├─ Yes → run analyzer → overwrite form.fpdf.json
   │     └─ No  → does form.fpdf.json exist?
   │                 ├─ Yes → load it (skip analysis, restore existing values)
   │                 └─ No  → run analyzer → write form.fpdf.json
   │
   ├─ Start Express server on port 0 (OS-allocated)
   ├─ Serve: PDF bytes (/pdf), JSON (/doc), read-only filled export (/filled-pdf), static UI assets
   ├─ POST /save-acroform → exportPdf() → saves <name>.fpdf.acroform.pdf (editable AcroForm)
   ├─ POST /export-canvas → exportFromImages() → fallback for encrypted PDFs (JPEG pages + stamped values)
   ├─ POST /regenerate-acroform → regenerator.ts → saves <name>.fpdf-converted.acroform.pdf
   ├─ Print URL to stdout
   ├─ If --open flag: launch default browser automatically
   │
   └─ WebSocket channel:
         UI ──(field change)──▶ server ──▶ writes form.fpdf.json
         server ──(saved ack)──▶ UI status bar
         server ──(pdfRegenerated)──▶ UI reloads page
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
| 10 | `03-23-feat_vector_path_candidate_field_detection` | `pageType` detection + `candidateFields`: classify each page via `getOperatorList()`; parse paths to find line/rect blanks; proximity-match `TextBlock` labels; assign `confidence`; add `PageType`, `CandidateField` types + both fields to schema | ✅ |
| 10.5 | `03-23-feat_orphan_widget_fallback` | Walk each page's raw `/Annots` array after `form.getFields()` to recover Widget annotations missed due to a broken `/AcroForm` field tree; extract orphans as regular `PdfField` entries (fully AcroForm-backed, exportable) | ✅ |
| 10.6 | `03-23-feat_orphan_widget_fallback` | XFA support: detect `/AcroForm/XFA` datasets packet, decode FlateDecode stream, parse flat XML for initial values; on export, patch datasets XML with filled values and re-compress; `PDFHexString` support in `buildFullFieldName` so orphan widget walk works for hybrid XFA+AcroForm PDFs (e.g. Cigna); radio `PDFName` on-value fix | ✅ |
| 10.7 | `03-23-feat_orphan_widget_fallback` | "No usable fields" handling for print-and-fill forms (e.g. Cigna pharmacy claim form): PDFs where `/Fields[]` is empty, no orphan widgets exist, and all candidate fields are low-confidence (flat lines that are not visible rectangles). Confidence cap: paths with height < `MIN_VISIBLE_HEIGHT` (4pt) are always `low` regardless of label. CLI warns and UI shows a dismissable yellow banner when no page has AcroForm fields or medium/high candidateFields. | ✅ |
| 10.8 | `03-24-feat_add_pdfkind_discriminant_and_ui_support_banners_for_pdf_type` | `PdfKind` document-level discriminant: `computePdfKind()` stored in `.fpdf.json` metadata; exporter uses stored kind instead of re-detecting XFA; UI status bar shows human-readable kind + per-page type labels; banners for `pure-xfa`, `no-acroform/raster`, `no-acroform/vector`; regression fix for field overlay positioning (page label moved outside `.page-wrapper`) | ✅ |
| UI.1 | `03-24-feat_dark_mode_toggle_default_dark` | Dark mode: default dark via `<body data-theme="dark">`; all colours replaced with CSS custom properties; theme IIFE applied before `main()` to prevent flash; `localStorage` persistence; toolbar toggle button | ✅ |
| 10.9 | `03-24-feat_xfa_acroform_regeneration` `03-24-feat_xfa_acroform_regeneration_m10.8_` | XFA → AcroForm regeneration: `regenerator.ts` copies pages via `pdf-lib.copyPages()`, re-creates AcroForm widgets at stored field positions, pre-fills values, saves as `<original>.fpdf-converted.acroform.pdf`; `POST /regenerate-acroform` server endpoint; server session switches to regenerated file; "Regenerate as standard PDF" button in warn banner for `xfa-hybrid`/`pure-xfa` docs; `pdfRegenerated` WS message triggers page reload | ✅ |
| CLI.2 | `03-24-feat_add_--fresh_flag_to_fpdf_fill_to_force_re-analysis` | `--fresh` flag for `fpdf fill`: skips loading any existing `.fpdf.json` and re-runs `analyzePdf()` unconditionally; top-level `--help` now shows all subcommand options inline (built dynamically from registered commands) | ✅ |
| CI | `03-23-chore_ci_workflow` | GitHub Actions CI: `npm run check` + `npm test` on every PR and push to `main`; Node 24; v8 branch coverage threshold set to 73% (Node 22/24 measure ~2% lower than Node 25) | ✅ |
| CI.1 | `03-23-fix_ci_branch_coverage` | Fix CI branch coverage regression: add tests for XFA radio translation, `/filled-pdf` route, WS write-error path, boolean-to-text fallback, transiently-absent JSON file; isolate watcher race condition in test suite | ✅ |
| CI.2 | `03-24-test_increase_branch_coverage_to_80_` | Increase branch coverage from 74% → 80% (macOS): add tests for `debug-export` command, radio migration path, `POST /regenerate-acroform`, SPA catch-all route, select/dropdown fields in regenerator, textarea, unchecked checkbox, radio deduplication | ✅ |
| CI.3 | `03-24-chore_apply_graphite-recommended_ci_trigger_config` | Apply Graphite-recommended CI trigger config: explicit `types: [opened, reopened, synchronize]` + `branches-ignore: ['**/graphite-base/**']` to prevent merge-queue draft PRs from blocking CI | ✅ |
| CI.4 | `03-24-chore_add_new-pr_checklist_rule_to_agents.md` | Add new-PR checklist rule to AGENTS.md: confirm current PR is merged or all CI checks pass before starting new work | ✅ |
| 10.10 | `03-26-feat_section-container-heuristic` | Section container heuristic: Phase 1 container-cell suppression (wide H-line pair cells that contain narrower cells at the same y-range are filtered out); `findLabelBelow` for fields whose labels sit below the fill-in line; Phase 3 stroked-rect container detection (large outer rectangles that enclose ≥ 2 H-lines are treated as structural containers, not fields; H-lines inside are emitted as individual fields with below-label search); Cigna pharmacy claim form added as integration test fixture | ✅ PR #116 |
| 11 | `candidate-edit/move-resize` | Edit-layout mode for candidate fields: click-to-select (outline + resize handles); drag to move; 8-handle resize; snap guide; `EditLayout` button in toolbar | ✅ PR #117 |
| 11.1 | `candidate-edit/draw-field` | Full edit-layout UX: draw new fields by right-click → "Add field here"; click-to-enter-edit / second-click-to-type; Delete key removes candidate; cascading context menu (duplicate, name, text alignment, delete); hover tooltip; font auto-shrinks to fit; export respects text alignment; scanned PDFs supported (right-click-to-add works on raster pages); radio/checkbox clicks not intercepted | ✅ PR #118 |
| 11.2 | — | AcroForm export for candidate fields: replace text-stamp export with real AcroForm widget creation (`form.createTextField` / `createCheckBox`); `uniqueFieldName()` sanitizes `displayName` with dedup suffix; text alignment preserved via `setAlignment()`; XFA PDFs keep stamped-text fallback | ✅ |
| 11.3 | — | Radio button support for candidate fields: add `type: 'radio'` + `radioValue?` + `groupName?` to `CandidateField`; "Add field here" becomes a type-picker submenu (text / textarea / checkbox / radio); radio buttons share a group via `groupName`; export creates one `PDFRadioGroup` per group via `addOptionToPage()` | 🔲 |
| 12 | `03-28-feat_font-name-size-storage` | Font name + size: parse `/DA` entry during analysis, store `fontName`/`fontSize` on both `PdfField` and `CandidateField`; font cache + `resolveFont` in exporter; use stored `fontSize` as auto-fit ceiling instead of hard-coded 12 pt; font picker submenu in context menu; `toCssFontFamily` helper applies stored font in UI preview | ✅ PR #129 |
| 12.1 | `03-28-feat_doc-reload-on-external-edit` | External JSON reload: file watcher (directory-level, atomic-rename safe) detects third-party edits to `.fpdf.json`; content-hash guard skips server-initiated echo; broadcasts `docReload` to all connected UI clients | ✅ PR #130 |
| fix | `03-28-fix_candidate-field-font-size` | Fix candidate field font size ceiling: auto-fit computation was ignoring `field.fontSize` for candidate text fields on export | ✅ PR #131 |
| fix | `03-28-fix_candidate-widget-transparent` | Fix candidate widget appearance: `makeWidgetTransparent` deletes `/MK` and sets `/BS {W:0}` so candidate AcroForm widgets render without white fill or visible border; `updateAppearances` called after `/MK` deletion so the new `/AP` stream is generated without background | ✅ PR #132 |
| fix | `03-28-fix_stale-no-acroform-warning` | Fix stale no-AcroForm warning: warn banner messages updated to reflect that candidate fields are now exported as AcroForm widgets rather than stamped text | ✅ PR #133 |
| UI.2 | `03-28-feat_save-acroform-local` | Save AcroForm + toolbar redesign: `POST /save-acroform` saves editable AcroForm PDF as `<name>.fpdf.acroform.pdf`; `GET /filled-pdf` produces read-only printable PDF; toolbar reorganised into visual groups with CSS dividers; secondary buttons (copy path, clear fields, dark toggle) shrunk to icon-only with tooltips | ✅ PR #134 |
| UI.3 | `03-28-feat_undo-clear-fields` | Undo clear fields: snapshot all field values before clearing; ✕ button flips to ↩ for a one-step undo; any subsequent manual field edit discards the snapshot and reverts the button | ✅ PR #135 |
| UI.4 | `03-28-feat_button-tooltips` | Button tooltips: all toolbar and banner buttons have `title` attributes; `updateToggleLabel` syncs title with text so "Hide fields" state also has a tooltip | ✅ PR #136 |
| UI.5 | `03-28-feat_fast-tooltips` | Fast custom toolbar tooltips: replaces 500ms OS-delay native title tooltip with a 150ms custom `#toolbar-tooltip` div; viewport-clamped (8 px margin), max-width 240 px with word-wrap; native `title` stashed/restored to prevent double tooltip | ✅ PR #137 |
| docs | — | Update PLAN.md and README for PRs #129–137 | ✅ PR #138 |
| test | `03-28-test_clear-fields-undo` | Integration test for clear-fields + undo cycle | ✅ PR #140 |
| UI.6 | `03-28-feat_font-submenu-sorted` | Sort font picker submenu lexicographically | ✅ PR #141 |
| CLI.3 | `03-28-feat_cli-save-acroform` | `fpdf save-acroform` CLI subcommand: export editable AcroForm PDF from the command line; prompts to pre-fill from `.fpdf.json` if one exists; warns and skips if the PDF already has AcroForm fields | ✅ PR #143 |
| 13 | `encrypted-pdf-export` | Encrypted PDF support: graceful `pdf-lib` fallback in analyzer (nullable `pdfDoc`, falls back to `pdfjs-dist` for page data); `ExportError` class + canvas-based fallback export assembles new PDF from browser-rendered JPEG pages with real AcroForm widgets; `POST /export-canvas` server endpoint; UI export button auto-falls back for encrypted PDFs; suppress noisy `pdf-lib` parser warnings | ✅ PR #145 |
| UI.7 | `ctrl-click-select-field` | Ctrl/Cmd+click selects any field type for repositioning, even text fields with focus | ✅ PR #146 |
| test | `03-29-test_fix_pre-existing_flaky_tests` | Fix pre-existing flaky tests: Cigna XFA tests guard on PDF content (not just file existence); server docReload timeout increased to 5s; settle delays between error-path server teardowns | ✅ PR #147 |
| fix | `03-29-fix_save-acroform_falls_back_to_canvas_export_for_encrypted_pdfs` | `save-acroform` falls back to canvas export for encrypted PDFs (mirrors `export` behavior) | ✅ PR #162 base |
| 14 | `03-30-feat_no-args_file_picker_mode` | No-args file picker: bare `fpdf` starts a server in picker mode, serves `pick.html`, `/browse` + `/open` routes let the user navigate their filesystem and select a PDF; transitions to fill mode via WS `pdfOpened`; `POST /reset` returns to picker; nav buttons (⌂ home, ↑ up) replace breadcrumb; `autoShutdown` flag triggers 1s idle shutdown when last browser tab closes | ✅ PR #163 |
| installer | `03-30-feat_macos_finder_app` | macOS Finder app installer (`scripts/install-fpdf`): builds `.app` bundle manually for correct icon; login-shell launcher via `dscl`; `--remove` flag with Dock entry cleanup via `PlistBuddy`; background launcher with no Terminal window | ✅ PR #162 |
| docs | `03-30-docs_add_merge-it_label_rule_to_agents.md` | Add `merge-it` label rule to AGENTS.md | ✅ PR #164 |
| installer.2 | — | `.app` launcher handles missing Node.js gracefully: `scripts/fpdf` interactive prompts (Node install, `npm install`) hang silently when run in the background with no terminal. Need a pre-flight check before launching the background process — detect missing node/node_modules and open a Terminal window for first-time setup, then re-launch headlessly once the environment is ready. | 🔲 |
