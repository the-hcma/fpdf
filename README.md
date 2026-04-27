# fpdf

[![npm version](https://img.shields.io/npm/v/@the-hcma/fpdf)](https://www.npmjs.com/package/@the-hcma/fpdf)
[![CI](https://github.com/the-hcma/fpdf/actions/workflows/ci.yml/badge.svg)](https://github.com/the-hcma/fpdf/actions/workflows/ci.yml)
[![Node.js ≥ 20](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org/)
[![License: PolyForm Noncommercial](https://img.shields.io/badge/license-PolyForm--Noncommercial-blue)](https://polyformproject.org/licenses/noncommercial/1.0.0/)

Fill PDF forms interactively in your browser, then export a completed PDF — all from the command line.

`fpdf` spawns a local web server, renders your PDF via PDF.js, and overlays precisely-positioned HTML inputs over each form field. Changes are live-synced to a portable `.fpdf.json` file you can edit by hand, share, or resume later.

## Quickstart (via npx — no install needed)

The easiest way to run `fpdf` on any platform (macOS, Linux, Windows) with Node.js ≥ 20:

```bash
# Launch the file picker — select a PDF and start filling right in your browser
npx @the-hcma/fpdf

# Or go straight to a specific file
npx @the-hcma/fpdf fill form.pdf --open

# Export filled values to a new PDF
npx @the-hcma/fpdf export form.fpdf.json -o filled.pdf
```

Running `npx @the-hcma/fpdf` with no arguments opens a local file-picker UI in your browser — the simplest way to get started without typing a file path.

`npx` downloads and caches the package on first run. No global installation required.
Pin to a specific version with `npx @the-hcma/fpdf@1.0.3`, or always pull the latest with `npx @the-hcma/fpdf@latest`.

For all commands and options, see the [Usage](#usage) section below.

## Quickstart (from source)

```bash
# 1. Clone and install dependencies
git clone https://github.com/the-hcma/fpdf.git
cd fpdf
pnpm install

# 2. Build (TypeScript + browser assets)
pnpm run build

# 3. Run directly from the repo (no global install needed)
./scripts/fpdf fill form.pdf --open

# 4. When you're done, export to a new PDF
./scripts/fpdf export form.fpdf.json -o filled.pdf
```

Alternatively, link the CLI globally so the bare `fpdf` command works anywhere:

```bash
pnpm link --global
fpdf fill form.pdf --open
```

To unlink: `pnpm unlink --global @the-hcma/fpdf`.

### Optional: macOS Finder app

After completing the steps above you can install a double-clickable `fpdf.app` that opens fpdf in your browser directly from Finder:

```bash
./scripts/install-fpdf
```

This installs `fpdf.app` to `/Applications`. Double-clicking it starts the local server in the background and launches the file picker in your default browser. The server shuts down automatically when the browser tab is closed.

To install for the current user only:

```bash
./scripts/install-fpdf --dest ~/Applications
```

To remove:

```bash
./scripts/install-fpdf --remove
# or, if installed to ~/Applications:
./scripts/install-fpdf --remove --dest ~/Applications
```

The app bakes in the path to your local clone at install time. Re-run the script if you move the repo.

### Optional: Persistent Service (Linux systemd)

For Linux users, `fpdf` can be configured as a persistent background service using `systemd` user units. This allows the picker server to start automatically at boot and remain active even after you log out.

Run the setup script from [repository-helpers](https://github.com/the-hcma/repository-helpers):

```bash
export REPO_HELPERS=/path/to/repository-helpers  # optional: set once for convenience
$REPO_HELPERS/scripts/setup-service
```

The script will:
1. Generate `~/.config/systemd/user/fpdf.service` from `etc/systemd/fpdf.service` (substituting the repo path).
2. Enable lingering for your user so the service survives logout.
3. Build the project if the `dist/` output is stale (`scripts/on-deploy`).
4. Enable, start (or restart) the service.
5. Print a status summary — including the start command, health-check URL, and log path.

No manual `systemctl` or `loginctl` commands are needed. Re-run `$REPO_HELPERS/scripts/setup-service` any time you update the repository to apply config changes and restart if necessary.

### Verification & Troubleshooting

#### Check status

```bash
$REPO_HELPERS/scripts/setup-service --status
```

This prints whether the service file is current, whether lingering is enabled, whether the service is active and enabled, the full start command, and the log path.

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
Systemd is configured to restart the service automatically if it crashes. However, if the service fails more than **5 times within 100 seconds**, systemd will stop attempting to restart it to prevent a resource-heavy failure loop.

If this happens, the service will show a `failed` status. To recover:
1. Check the logs: `tail -f ~/scratch/fpdf/fpdf.log`
2. Reset the failure counter: `systemctl --user reset-failed fpdf`
3. Restart the service: `systemctl --user start fpdf`

## Requirements

- Node.js ≥ 20 LTS
- macOS (for the optional Finder app — requires Xcode Command Line Tools: `xcode-select --install`)

## Installation

Run `fpdf` directly without installing it globally using `npx`:

```bash
# Show all commands and options
npx @the-hcma/fpdf --help

# Fill a form (opens the browser UI)
npx @the-hcma/fpdf fill form.pdf

# Fill and auto-open in the default browser
npx @the-hcma/fpdf fill form.pdf --open

# Export filled values to a new PDF
npx @the-hcma/fpdf export form.fpdf.json -o filled.pdf

# Pin to a specific version
npx @the-hcma/fpdf@1.0.1 fill form.pdf

# Always pull the latest published version
npx @the-hcma/fpdf@latest fill form.pdf
```

Alternatively, install it globally to use the `fpdf` command directly:

```bash
npm install -g @the-hcma/fpdf
# or
pnpm add -g @the-hcma/fpdf
```

To build from source instead, see the [Quickstart](#quickstart-from-source).

## Usage

If you used `npx` above, simply replace `fpdf` with `npx @the-hcma/fpdf` in the commands below.

```bash
# Start an interactive fill session (auto-resumes from .fpdf.json if one exists)
fpdf fill form.pdf
fpdf fill form.pdf --open           # auto-launch browser
fpdf fill form.pdf --fresh          # ignore saved session, re-analyze from scratch

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

`fpdf fill` prints a local URL (e.g. `http://127.0.0.1:51234`) to stdout. Open it in any browser to start filling. The server binds to `127.0.0.1` only and uses an OS-assigned port.

Run `fpdf --help` to see all commands and their options in one view, or `fpdf <command> --help` for details on a specific command.

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

See the [Quickstart](#quickstart-from-source) to get a local build running.

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
