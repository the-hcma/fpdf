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
      ]
    }
  ]
}
```

### Field notes
- `id` is a UUID generated at analysis time — stable across re-analyses of the same PDF
- `name` is the raw AcroForm field name as embedded in the PDF (may be an XFA-style path)
- `label` is a derived, number-prefixed label useful for cross-referencing the paper form (e.g. `"6 Date of Birth MMDDCCYY"`)
- `displayName` is a cleaned-up version of the label for UI rendering — strips the field number, format hints like `MMDDCCYY`, back-references like `in 4`, and trailing address/name format fragments (e.g. `"Date of Birth"`)
- `placement` is in **PDF coordinate space** (points, bottom-left origin) — the UI transforms these to CSS positions
- `options` is populated for dropdowns and radio groups
- `value` is what the user fills in (string for text/select, boolean for checkboxes)
- The file is human-editable: a user can fill in `value` fields directly in a text editor

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

### Phase 1 — MVP: AcroForm fields
- `pdf-lib` enumerates all AcroForm fields: type, name, rectangle, current value
- Covers the majority of fillable PDFs (government forms, contracts, etc.)

### Phase 2 — Heuristic text detection
- Use `pdfjs-dist` text layer to detect label text near blank lines/boxes
- Surface detected regions as candidate fields the user can promote/discard

### Phase 3 — Scanned PDFs (future)
- Would require OCR (e.g. `tesseract.js`) — out of scope for now

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
| 1 | `feat/scaffold` | Project scaffold: TypeScript, `esbuild`, `commander`, basic CLI wiring | ✅ |
| 2 | `feat/analyzer` | `analyzer.ts`: AcroForm extraction with `pdf-lib`, produces `.fpdf.json` | — |
| 3 | `feat/server` | `server.ts`: Express serves PDF + JSON + static files + WebSocket endpoint | — |
| 4 | `feat/ui-render` | `app.ts` (browser): PDF.js canvas render + computed field overlay | — |
| 5 | `feat/ws-save` | WebSocket save loop: field edits → debounced JSON write → ack to UI | — |
| 6 | `feat/json-resume` | JSON resume: detect existing `.fpdf.json`, restore previous field values | — |
| 7 | `feat/polish` | Polish: transparent input styling, accurate field sizing, status bar, error handling | — |
| 8 | `feat/export` | `fpdf export`: write filled values back into AcroForm PDF (`pdf-lib`) | — |
