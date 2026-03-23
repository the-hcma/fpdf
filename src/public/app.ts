import * as pdfjsLib from 'pdfjs-dist';
import type { FpdfDocument, PdfPage, PdfField } from '../types.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.mjs';

// ── Helpers ──────────────────────────────────────────────────────────────────

function setStatus(msg: string): void {
  const el = document.getElementById('status');
  if (el) el.textContent = msg;
}

function setSaveButtonDirty(dirty: boolean): void {
  const btn = document.getElementById('save') as HTMLButtonElement | null;
  if (btn) btn.disabled = !dirty;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

function debounce<T extends unknown[]>(fn: (...args: T) => void, ms: number): (...args: T) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: T) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      fn(...args);
    }, ms);
  };
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

function initWebSocket(onSaved: (updatedAt: string) => void): (doc: FpdfDocument) => void {
  const ws = new WebSocket(`ws://${location.host}/ws`);

  ws.addEventListener('message', (event) => {
    const raw = typeof event.data === 'string' ? event.data : '';
    let msg: unknown;
    try {
      msg = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    if (
      typeof msg === 'object' &&
      msg !== null &&
      (msg as Record<string, unknown>).type === 'saved'
    ) {
      const updatedAt = (msg as Record<string, unknown>).updatedAt;
      onSaved(typeof updatedAt === 'string' ? updatedAt : new Date().toISOString());
    }
  });

  ws.addEventListener('error', () => {
    setStatus('Disconnected');
  });
  ws.addEventListener('close', () => {
    setStatus('Disconnected');
  });

  return (doc: FpdfDocument) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    doc.metadata.updatedAt = new Date().toISOString();
    ws.send(JSON.stringify({ type: 'save', doc }));
  };
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
  el.dataset.fieldId = field.id;
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
    if (field.readOnly) continue;
    overlay.appendChild(buildFieldElement(field, docPage, scale));
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'page-wrapper';
  wrapper.appendChild(canvas);
  wrapper.appendChild(overlay);
  container.appendChild(wrapper);
}

// ── Input change tracking ─────────────────────────────────────────────────────

function readInputValue(el: HTMLElement, field: PdfField): string | boolean {
  if (field.type === 'checkbox' || field.type === 'radio') {
    return (el as HTMLInputElement).checked;
  }
  return (el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
}

function watchInputs(
  container: HTMLElement,
  fieldById: Map<string, PdfField>,
  onDirty: () => void,
): void {
  container.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const fieldId = target.dataset.fieldId;
    if (!fieldId) return;
    const field = fieldById.get(fieldId);
    if (!field) return;
    field.value = readInputValue(target, field);
    onDirty();
  });
}

// ── Zoom ──────────────────────────────────────────────────────────────────────

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3.0;
const ZOOM_STEP = 0.1;
const ZOOM_STORAGE_KEY = 'fpdf-zoom';

function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

function initZoom(): void {
  const stored = localStorage.getItem(ZOOM_STORAGE_KEY);
  let zoom = stored ? clampZoom(parseFloat(stored)) : 1.0;

  function applyZoom(): void {
    const pages = document.getElementById('pages');
    if (pages) {
      pages.style.transform = zoom === 1.0 ? '' : `scale(${String(zoom)})`;
      pages.style.transformOrigin = 'top center';
    }
    const label = document.getElementById('zoom-level');
    if (label) label.textContent = `${String(Math.round(zoom * 100))}%`;
    localStorage.setItem(ZOOM_STORAGE_KEY, String(zoom));
  }

  document.getElementById('zoom-in')?.addEventListener('click', () => {
    zoom = clampZoom(Math.round((zoom + ZOOM_STEP) * 10) / 10);
    applyZoom();
  });

  document.getElementById('zoom-out')?.addEventListener('click', () => {
    zoom = clampZoom(Math.round((zoom - ZOOM_STEP) * 10) / 10);
    applyZoom();
  });

  window.addEventListener(
    'wheel',
    (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const delta = event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
      zoom = clampZoom(Math.round((zoom + delta) * 10) / 10);
      applyZoom();
    },
    { passive: false },
  );

  applyZoom();
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
  initZoom();
  setStatus('Loading…');

  let baseText = '';

  const sendSave = initWebSocket((updatedAt) => {
    setStatus(`${baseText} · Saved at ${formatTime(updatedAt)}`);
    setSaveButtonDirty(false);
  });

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
  baseText = `${fpdfDoc.metadata.pdfFilename} — ${String(pdfDoc.numPages)} ${pageWord}`;
  setStatus(baseText);

  const fieldById = new Map<string, PdfField>();
  for (const page of fpdfDoc.pages) {
    for (const field of page.fields) {
      fieldById.set(field.id, field);
    }
  }

  const debouncedSave = debounce(() => {
    setStatus(`${baseText} · Saving…`);
    sendSave(fpdfDoc);
  }, 800);

  watchInputs(pagesContainer, fieldById, () => {
    setStatus(`${baseText} · Unsaved changes`);
    setSaveButtonDirty(true);
    debouncedSave();
  });

  const saveBtn = document.getElementById('save');
  saveBtn?.addEventListener('click', () => {
    setStatus(`${baseText} · Saving…`);
    sendSave(fpdfDoc);
  });
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  setStatus(`Error: ${msg}`);
});
