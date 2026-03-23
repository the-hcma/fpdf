import * as pdfjsLib from 'pdfjs-dist';
import type { FpdfDocument, PdfPage, PdfField } from '../types.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.mjs';

// ── Helpers ──────────────────────────────────────────────────────────────────

function setStatus(msg: string): void {
  const el = document.getElementById('status');
  if (el) el.textContent = msg;
}

// ── Field rendering ───────────────────────────────────────────────────────────

function positionElement(el: HTMLElement, field: PdfField, page: PdfPage, scale: number): void {
  const { x, y, width, height } = field.placement;
  el.style.left = `${String(x * scale)}px`;
  el.style.top = `${String((page.heightPt - y - height) * scale)}px`;
  el.style.width = `${String(width * scale)}px`;
  el.style.height = `${String(height * scale)}px`;
}

function buildFieldElement(field: PdfField, page: PdfPage, scale: number): HTMLElement {
  let el: HTMLElement;

  switch (field.type) {
    case 'textarea': {
      const ta = document.createElement('textarea');
      ta.value = typeof field.value === 'string' ? field.value : '';
      el = ta;
      break;
    }
    case 'checkbox': {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = field.value === true;
      el = cb;
      break;
    }
    case 'radio': {
      const rb = document.createElement('input');
      rb.type = 'radio';
      rb.name = field.name;
      rb.checked = field.value === true;
      el = rb;
      break;
    }
    case 'select': {
      const sel = document.createElement('select');
      for (const opt of field.options) {
        const option = document.createElement('option');
        option.value = opt;
        option.textContent = opt;
        if (opt === field.value) option.selected = true;
        sel.appendChild(option);
      }
      el = sel;
      break;
    }
    default: {
      // 'text' and any future types
      const input = document.createElement('input');
      input.type = 'text';
      input.value = typeof field.value === 'string' ? field.value : '';
      el = input;
      break;
    }
  }

  el.title = field.displayName;
  if (field.readOnly) (el as HTMLInputElement).disabled = true;
  positionElement(el, field, page, scale);
  return el;
}

// ── Page rendering ────────────────────────────────────────────────────────────

async function renderPage(
  pdfPage: pdfjsLib.PDFPageProxy,
  docPage: PdfPage,
  container: HTMLElement,
): Promise<void> {
  const viewport = pdfPage.getViewport({ scale: window.devicePixelRatio > 1 ? 1.5 : 1 });

  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  canvas.style.width = `${String(viewport.width)}px`;
  canvas.style.height = `${String(viewport.height)}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get 2d context');

  await pdfPage.render({ canvasContext: ctx, viewport, canvas }).promise;

  const overlay = document.createElement('div');
  overlay.className = 'overlay';

  const scale = viewport.width / docPage.widthPt;
  for (const field of docPage.fields) {
    overlay.appendChild(buildFieldElement(field, docPage, scale));
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'page-wrapper';
  wrapper.appendChild(canvas);
  wrapper.appendChild(overlay);
  container.appendChild(wrapper);
}

// ── Toggle ────────────────────────────────────────────────────────────────────

function initToggle(): void {
  const stored = localStorage.getItem('fpdf-show-fields');
  if (stored === 'true') document.body.classList.add('show-fields');
  updateToggleLabel();

  const btn = document.getElementById('toggle-fields');
  btn?.addEventListener('click', () => {
    document.body.classList.toggle('show-fields');
    const on = document.body.classList.contains('show-fields');
    localStorage.setItem('fpdf-show-fields', String(on));
    updateToggleLabel();
  });
}

function updateToggleLabel(): void {
  const btn = document.getElementById('toggle-fields');
  if (!btn) return;
  btn.textContent = document.body.classList.contains('show-fields') ? 'Hide fields' : 'Show fields';
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  initToggle();
  setStatus('Loading…');

  const [docRes, pdfRes] = await Promise.all([fetch('/doc'), fetch('/pdf')]);
  const fpdfDoc = (await docRes.json()) as FpdfDocument;
  const pdfData = await pdfRes.arrayBuffer();

  setStatus('Rendering…');

  const pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(pdfData) }).promise;
  const pagesContainer = document.getElementById('pages');
  if (!pagesContainer) throw new Error('Missing #pages element');

  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const pdfPage = await pdfDoc.getPage(i);
    const docPage = fpdfDoc.pages.find((p) => p.pageNumber === i);
    if (!docPage) continue;
    await renderPage(pdfPage, docPage, pagesContainer);
  }

  const pageWord = pdfDoc.numPages === 1 ? 'page' : 'pages';
  setStatus(`${fpdfDoc.metadata.pdfFilename} — ${String(pdfDoc.numPages)} ${pageWord}`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  setStatus(`Error: ${msg}`);
});
