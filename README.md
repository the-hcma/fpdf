# fpdf

[![npm version](https://img.shields.io/npm/v/@the-hcma/fpdf)](https://www.npmjs.com/package/@the-hcma/fpdf)
[![CI](https://github.com/the-hcma/fpdf/actions/workflows/ci.yml/badge.svg)](https://github.com/the-hcma/fpdf/actions/workflows/ci.yml)
[![Node.js ≥ 20](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org/)
[![License: PolyForm Noncommercial](https://img.shields.io/badge/license-PolyForm--Noncommercial-blue)](https://polyformproject.org/licenses/noncommercial/1.0.0/)

Fill PDF forms interactively in your browser, then export a completed PDF — all from the command line.

`fpdf` spawns a local web server, renders your PDF via PDF.js, and overlays precisely-positioned HTML inputs over each form field. Changes are live-synced to a portable `.fpdf.json` file you can edit by hand, share, or resume later.

## Get started

> **Requires Node.js ≥ 20.** See [Installing Node.js](#installing-nodejs) if you don't have it yet.

```bash
# Open the file picker — your browser opens automatically
npx @the-hcma/fpdf

# Or go straight to a specific file
npx @the-hcma/fpdf fill form.pdf

# Export filled values to a new PDF
npx @the-hcma/fpdf export form.fpdf.json -o filled.pdf
```

`npx` downloads and caches the package on first run — no global installation required. On headless servers (no display detected) fpdf skips the browser launch and prints the URL to open manually. Pass `--no-open` to suppress auto-open explicitly.

Pin to a specific version with `npx @the-hcma/fpdf@1.0.3`, or always pull the latest with `npx @the-hcma/fpdf@latest`.

### Installing Node.js

**macOS** — install [Homebrew](https://brew.sh/) then: `brew install node`

**Windows** — install [nvm-windows](https://github.com/coreybutler/nvm-windows/releases), then in PowerShell: `nvm install lts && nvm use lts`

**Linux (Ubuntu/Debian)**
```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs
```

## Global install (optional)

To use the bare `fpdf` command without typing `npx @the-hcma/fpdf` every time:

```bash
npm install -g @the-hcma/fpdf
# or
pnpm add -g @the-hcma/fpdf
```

Then just run `fpdf` anywhere:

```bash
fpdf                        # open the file picker
fpdf fill form.pdf          # go straight to a file
fpdf export form.fpdf.json  # export to PDF
```

## Filling a form

1. **Open a PDF** — the file picker lists PDFs in the current directory. Click one to start a session, or run `fpdf fill form.pdf` to skip the picker.
2. **Click a field and type** — fpdf overlays interactive inputs over every detected form field.
3. **Right-click anywhere on the page** for a context menu:
   - **Add field here** — draw a new text field at the cursor position.
   - **Duplicate field** — copy the selected field with a small offset.
   - **Name field** — assign a label stored in the `.fpdf.json` session file.
   - **Text alignment** — left, center, right, or justified (cascading submenu); alignment is preserved on export.
   - **Delete field** — remove a manually-added or candidate field.
4. **Export when done** — click **Export PDF** in the toolbar to download a flattened, print-ready PDF. Click **Save AcroForm** for an editable PDF that keeps fields interactive in any standard PDF viewer.

The toolbar also provides: dark/light mode toggle, show/hide field boundaries, zoom, copy PDF path, and clear all fields (with one-step undo). See [UI features](#ui-features) for details.

## Commands

If you used `npx` above, replace `fpdf` with `npx @the-hcma/fpdf` in the commands below.

```bash
# Start an interactive fill session (auto-resumes from .fpdf.json if one exists)
fpdf fill form.pdf
fpdf fill form.pdf --no-open          # suppress the browser auto-open
fpdf fill form.pdf --fresh            # ignore saved session, re-analyze from scratch

# Resume from a specific session file
fpdf fill form.pdf --json form.fpdf.json

# Extract fields to JSON without starting a server
fpdf analyze form.pdf

# Write filled values back into a new PDF
fpdf export form.fpdf.json
fpdf export form.fpdf.json -o filled.pdf

# Export an editable AcroForm PDF (prompts to pre-fill from .fpdf.json if one exists)
fpdf save-acroform form.pdf
fpdf save-acroform form.pdf -o editable.pdf
```

Run `fpdf --help` or `fpdf <command> --help` for full options.

## Session file: `.fpdf.json`

Every session produces a `.fpdf.json` file next to the original PDF. It stores field values, positions, and metadata in a human-readable format you can edit in any text editor. Re-running `fpdf fill` on the same PDF automatically resumes from it.

Use `--fresh` to discard an existing session and re-analyze the PDF from scratch (useful when the PDF has changed or you want to start over without deleting the file manually).

The file is safe to commit to version control — it contains no binary data and diffs cleanly.

## Supported PDF types

fpdf classifies every PDF by its form structure on first open and shows a status label in the UI:

| Kind | Description | Fill | Export |
|---|---|---|---|
| **AcroForm** | Standard interactive PDF with AcroForm fields | ✅ | ✅ |
| **XFA + AcroForm** (hybrid) | Has both XFA datasets and AcroForm widgets (e.g. Cigna forms) | ✅ | ✅ |
| **Pure XFA** | XFA-only; no traditional AcroForm | ✅ | ✅ — use Regenerate for a universally compatible output |
| **No AcroForm — vector/hybrid** | Digitally created PDF with draw-in fields (no AcroForm); fields detected from vector paths | ✅ | ✅ text stamped |
| **No AcroForm — scanned** | Scanned image-only PDF; no auto-detected fields; add fields manually | ✅ manual | ✅ text stamped |
| **Encrypted** | Password-protected or DRM-encrypted PDF; rendered via pdfjs-dist | ✅ | ✅ editable AcroForm (canvas fallback) |

### XFA regeneration

For XFA-based PDFs (hybrid or pure), the UI offers a **Regenerate as standard PDF** button. This copies all page content into a new, XFA-free PDF with clean AcroForm widgets at the original field positions — pre-filled with any values you've already entered. The regenerated file is saved as `<original>.fpdf-converted.acroform.pdf` alongside the source, and the session switches to it automatically.

## Supported field types

- Text inputs and textareas
- Checkboxes
- Radio groups
- Dropdowns (select)

Signature and button fields are skipped.

## Exporting

### CLI export

```bash
fpdf export form.fpdf.json
```

Writes filled values back into the original PDF and saves a new file alongside it (e.g. `form-filled.pdf`). Use `-o` to specify a different output path.

### CLI save-acroform

```bash
fpdf save-acroform form.pdf
```

Exports the PDF as an editable AcroForm PDF saved as `<name>.fpdf.acroform.pdf` alongside the source. If a `.fpdf.json` session file exists, you are prompted whether to pre-fill the output with saved values (default: yes). Use `-o` to specify a different output path.

If the PDF already has AcroForm fields, a warning is printed and no file is written — use `fpdf export` instead to write filled values back into an AcroForm PDF.

### Browser export buttons

The toolbar offers two in-browser export actions:

| Button | Output | Fields |
|---|---|---|
| **Export PDF** | `<name>-filled.pdf` (download) | Read-only — fields are flattened; no blue viewer highlight |
| **Save AcroForm** | `<name>.fpdf.acroform.pdf` (saved next to source) | Editable — fields remain interactive in any standard PDF viewer |

**Save AcroForm** is shown for all PDF types except pure AcroForm (which already has live editable fields). It is useful when you want to hand off a pre-filled but still-editable form to a recipient.

### Encrypted PDF fallback

Encrypted PDFs can be viewed and filled (pdfjs-dist handles decryption for rendering), but pdf-lib cannot modify them for standard export. When **Export PDF** detects an encrypted PDF, it automatically falls back to a canvas-based export: each rendered page is captured as a JPEG and a fresh PDF is assembled with the page images as backgrounds and real AcroForm widgets at the correct field positions. The result is an editable PDF — the recipient can still modify field values in any standard PDF viewer.

## UI features

- **Dark mode** — default theme; toggle between light and dark via the toolbar button. Preference is persisted in `localStorage`.
- **Show/hide fields** — highlight all field boundaries as a blue overlay.
- **Zoom** — toolbar buttons or Ctrl+scroll (mouse wheel).
- **Tab order** — Tab and Shift+Tab step through fields in reading order (top-to-bottom, left-to-right).
- **Copy path** — copies the absolute path of the current PDF to the clipboard.
- **Export PDF** — download a printable, read-only PDF with all field values baked in (no blue viewer highlight).
- **Save AcroForm** — (non-AcroForm PDFs) save an editable `.fpdf.acroform.pdf` alongside the source; fields stay interactive in any PDF viewer.
- **Clear fields** — erase all filled values. The button flips to ↩ immediately after, allowing a one-step undo; the next manual field edit commits the cleared state and discards the undo.

### Edit layout (vector/no-AcroForm PDFs)

For PDFs where fields are detected from vector paths rather than declared as AcroForm widgets, fpdf lets you adjust the detected layout before filling:

- **Click a field** to select it (move/resize handles appear). Click the selected field again to switch to typing mode.
- **Ctrl/Cmd+click** any field (including focused text fields) to select it for repositioning without losing context.
- **Drag** a selected field to reposition it; edges of other fields snap horizontally.
- **Resize** using the 8 corner/edge handles.
- **Right-click** anywhere on the page for a context menu:
  - **Add field here** — draw a new text field at the cursor position.
  - **Duplicate field** — copy the right-clicked field with a small offset.
  - **Name field** — set a label stored in the `.fpdf.json`.
  - **Text alignment** — set left, center, right, or justified alignment (cascading submenu); alignment is preserved on export.
  - **Delete field** — remove a candidate field (candidate fields only).
- **Delete key** — delete the selected candidate field.
- **ESC** — exit edit mode without changing the selection.
- **Hover** over a field for 600 ms to see its name and available operations in a tooltip.

## Print

Open the browser's print dialog while filling to print the completed form at 1:1 scale. UI chrome is hidden automatically via CSS `@media print`.

## Development

### Building from source

```bash
# 0. Enable pnpm (one-time setup, requires Node.js ≥ 20)
corepack enable pnpm

# 1. Clone and install dependencies
git clone https://github.com/the-hcma/fpdf.git
cd fpdf
pnpm install

# 2. Build (TypeScript + browser assets)
pnpm run build

# 3. Run directly from the repo
./scripts/fpdf fill form.pdf

# 4. Export a completed PDF
./scripts/fpdf export form.fpdf.json -o filled.pdf
```

Link globally to use the bare `fpdf` command anywhere:

```bash
pnpm link --global
fpdf fill form.pdf
```

To unlink: `pnpm unlink --global @the-hcma/fpdf`.

### Optional: macOS Finder app

Install a double-clickable `fpdf.app` that opens fpdf in your browser directly from Finder:

```bash
./scripts/install-fpdf
```

This installs `fpdf.app` to `/Applications`. Double-clicking it starts the local server in the background and launches the file picker in your default browser. The server shuts down automatically when the browser tab is closed.

To install for the current user only: `./scripts/install-fpdf --dest ~/Applications`

To remove: `./scripts/install-fpdf --remove` (add `--dest ~/Applications` if installed there)

The app bakes in the path to your local clone at install time. Re-run the script if you move the repo. Also requires Xcode Command Line Tools: `xcode-select --install`

### Optional: Persistent service (Linux systemd)

`fpdf` can run as a persistent background service that starts automatically at boot and survives logout. Run the setup script from [repository-helpers](https://github.com/the-hcma/repository-helpers):

```bash
export REPO_HELPERS=/path/to/repository-helpers
$REPO_HELPERS/scripts/setup-service
```

The script generates the systemd unit, enables lingering, builds if needed, and starts the service. Re-run it any time you update the repository.

#### Check status

```bash
$REPO_HELPERS/scripts/setup-service --status
```

#### Confirm it's reachable

```bash
curl http://localhost:8002/health
# Returns "ok"
```

#### Viewing logs

```bash
tail -f ~/scratch/fpdf/fpdf.log
```

#### What if it fails to restart?

If the service fails more than **5 times within 100 seconds**, systemd stops retrying. To recover:

1. Check the logs: `tail -f ~/scratch/fpdf/fpdf.log`
2. Reset the failure counter: `systemctl --user reset-failed fpdf`
3. Restart the service: `systemctl --user start fpdf`

### Dev commands

```bash
pnpm run build          # compile TypeScript + bundle browser assets
pnpm run typecheck      # tsc --noEmit
pnpm run lint           # ESLint
pnpm run format         # Prettier
pnpm test               # Vitest with coverage
pnpm run check          # full pre-commit check
```

### Internal Scripts

- **`scripts/fpdf`**: The primary entry point. Handles Node.js environment setup (via `fnm` or `brew`), `pnpm install` checks, and invokes the built CLI.
- **`scripts/build-ui.mjs`**: Invoked by `pnpm run build`. It uses **esbuild** to bundle the TypeScript frontend (`src/public`) and copies static assets (HTML/CSS) and the PDF.js worker into `dist/public`. This is required for the web interface to function.

## Releasing

See [RELEASING.md](RELEASING.md) for documentation on the automated Release Please and NPM publishing process.

## License

Copyright (c) 2026 Henrique Andrade

Licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). Free for noncommercial use.
