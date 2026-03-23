# fpdf

Fill PDF forms interactively in your browser, then export a completed PDF — all from the command line.

`fpdf` spawns a local web server, renders your PDF via PDF.js, and overlays precisely-positioned HTML inputs over each form field. Changes are live-synced to a portable `.fpdf.json` file you can edit by hand, share, or resume later.

## Quickstart (from source)

```bash
# 1. Clone and install dependencies
git clone https://github.com/the-hcma/fpdf.git
cd fpdf
npm install

# 2. Build (TypeScript + browser assets)
npm run build

# 3. Link the CLI so `fpdf` is available on your PATH
npm link

# 4. Fill a PDF form
fpdf fill form.pdf --open

# 5. When you're done, export to a new PDF
fpdf export form.fpdf.json -o filled.pdf
```

After step 3, `fpdf` behaves identically to the globally installed package. To unlink: `npm unlink -g fpdf`.

## Requirements

- Node.js ≥ 20 LTS

## Installation

```bash
npm install -g fpdf
```

To build from source instead, see the [Quickstart](#quickstart-from-source).

## Usage

```bash
# Start an interactive fill session (auto-resumes from .fpdf.json if one exists)
fpdf fill form.pdf
fpdf fill form.pdf --open        # auto-launch browser

# Resume from a specific session file
fpdf fill form.pdf --json form.fpdf.json

# Extract fields to JSON without starting a server
fpdf analyze form.pdf

# Write filled values back into a new PDF
fpdf export form.fpdf.json
fpdf export form.fpdf.json -o filled.pdf
```

`fpdf fill` prints a local URL (e.g. `http://127.0.0.1:51234`) to stdout. Open it in any browser to start filling. The server binds to `127.0.0.1` only and uses an OS-assigned port.

## Session file: `.fpdf.json`

Every session produces a `.fpdf.json` file next to the original PDF. It stores field values, positions, and metadata in a human-readable format you can edit in any text editor. Re-running `fpdf fill` on the same PDF automatically resumes from it.

The file is safe to commit to version control — it contains no binary data and diffs cleanly.

## Supported field types

- Text inputs and textareas
- Checkboxes
- Radio groups
- Dropdowns (select)

Signature and button fields are skipped.

## Exporting

```bash
fpdf export form.fpdf.json
```

Writes filled values back into the original PDF and saves a new file alongside it (e.g. `form-filled.pdf`). Use `-o` to specify a different output path.

## Print

Open the browser's print dialog while filling to print the completed form at 1:1 scale. UI chrome is hidden automatically via CSS `@media print`.

## Development

See the [Quickstart](#quickstart-from-source) to get a local build running.

```bash
npm run build          # compile TypeScript + bundle browser assets
npm run typecheck      # tsc --noEmit
npm run lint           # ESLint
npm run format         # Prettier
npm test               # Vitest with coverage
npm run check          # full pre-commit check
```

## License

MIT
