import * as pdfjsLib from 'pdfjs-dist';
import type { FpdfDocument, PdfPage, PdfField } from '../types.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.mjs';

// ── Dark mode ─────────────────────────────────────────────────────────────────
// Default is dark. localStorage key 'fpdf-theme' stores 'light' or 'dark'.
// Applied immediately (before main()) to avoid a flash of the wrong theme.

(function applyTheme() {
  const stored = localStorage.getItem('fpdf-theme');
  const theme = stored === 'light' ? 'light' : 'dark';
  document.body.dataset.theme = theme;
})();

function initDarkToggle(): void {
  const btn = document.getElementById('dark-toggle');
  if (!btn) return;

  function updateButton(b: HTMLElement): void {
    const isDark = document.body.dataset.theme === 'dark';
    b.textContent = isDark ? 'Light mode' : 'Dark mode';
  }

  updateButton(btn);

  btn.addEventListener('click', () => {
    const next = document.body.dataset.theme === 'dark' ? 'light' : 'dark';
    document.body.dataset.theme = next;
    localStorage.setItem('fpdf-theme', next);
    updateButton(btn);
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function humanPdfKind(kind: string): string {
  switch (kind) {
    case 'acroform':
      return 'AcroForm';
    case 'xfa-hybrid':
      return 'XFA + AcroForm';
    case 'pure-xfa':
      return 'Pure XFA';
    case 'no-acroform':
      return 'No AcroForm';
    default:
      return kind;
  }
}

function humanPageType(type: string): string {
  switch (type) {
    case 'acroform':
      return 'AcroForm';
    case 'vector':
      return 'Vector';
    case 'raster':
      return 'Scanned';
    case 'raster+ocr':
      return 'Scanned + OCR';
    case 'hybrid':
      return 'Hybrid';
    default:
      return type;
  }
}

function setStatus(msg: string): void {
  const el = document.getElementById('status');
  if (el) el.textContent = msg;
}

function showError(msg: string): void {
  const banner = document.getElementById('error-banner');
  const msgEl = document.getElementById('error-message');
  if (banner && msgEl) {
    msgEl.textContent = msg;
    banner.removeAttribute('hidden');
  } else {
    setStatus(`Error: ${msg}`);
  }
}

function dismissError(): void {
  document.getElementById('error-banner')?.setAttribute('hidden', '');
}

function showWarning(msg: string): void {
  const banner = document.getElementById('warn-banner');
  const msgEl = document.getElementById('warn-message');
  if (banner && msgEl) {
    msgEl.textContent = msg;
    banner.removeAttribute('hidden');
  }
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

function initWebSocket(
  onSaved: (updatedAt: string) => void,
  onReload: (doc: FpdfDocument) => void,
): (doc: FpdfDocument) => void {
  const ws = new WebSocket(`ws://${location.host}/ws`);

  ws.addEventListener('message', (event) => {
    const raw = typeof event.data === 'string' ? event.data : '';
    let msg: unknown;
    try {
      msg = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as Record<string, unknown>;
    if (m.type === 'saved') {
      const updatedAt = m.updatedAt;
      onSaved(typeof updatedAt === 'string' ? updatedAt : new Date().toISOString());
    } else if (m.type === 'docReload' && typeof m.doc === 'object' && m.doc !== null) {
      onReload(m.doc as FpdfDocument);
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

const FONT_RATIO = 0.72;
const MIN_FONT_SIZE = 6; // px — never shrink below this

/**
 * Measure the rendered width of a string at a given font size using an
 * offscreen canvas. More reliable than scrollWidth for <input> elements,
 * which can report scroll dimensions larger than the visible area due to
 * browser caret-rendering quirks and sub-pixel rounding.
 */
function measureTextWidth(text: string, sizePx: number, fontFamily: string): number {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return 0;
  ctx.font = `${String(sizePx)}px ${fontFamily}`;
  return ctx.measureText(text).width;
}

/**
 * Shrink the font size of a text input or textarea until its content fits
 * within the available space, then restore as large as possible up to the
 * original max size stored in data-max-font-size.
 *
 * For <input> elements we use canvas measureText() rather than scrollWidth —
 * scrollWidth on absolutely-positioned inputs is unreliable in several
 * browsers (sub-pixel rounding + caret-reservation can make scrollWidth
 * exceed clientWidth even for short text, driving the font to MIN_FONT_SIZE).
 */
function fitFontToBox(el: HTMLElement): void {
  const maxSize = Number(el.dataset.maxFontSize);
  if (!maxSize) return;

  let size = maxSize;

  if (el instanceof HTMLTextAreaElement) {
    // scrollHeight is reliable for block-level textarea (line-wrapping).
    el.style.fontSize = `${String(size)}px`;
    while (el.scrollHeight > el.clientHeight && size > MIN_FONT_SIZE) {
      size -= 1;
      el.style.fontSize = `${String(size)}px`;
    }
  } else if (el instanceof HTMLInputElement) {
    const cw = el.clientWidth;
    if (cw > 0 && el.value.length > 0) {
      const family = getComputedStyle(el).fontFamily;
      const textWidth = measureTextWidth(el.value, maxSize, family);
      if (textWidth > cw) {
        // Scale down proportionally, then clamp to minimum.
        size = Math.max(MIN_FONT_SIZE, Math.floor(maxSize * (cw / textWidth)));
      }
    }
    el.style.fontSize = `${String(size)}px`;
  }
}

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
      rb.value = field.radioValue ?? '';
      rb.checked = field.radioValue !== undefined && field.value === field.radioValue;
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

  el.title = field.tooltip ?? field.displayName;
  el.dataset.fieldId = field.id;
  if (field.readOnly) (el as HTMLInputElement).disabled = true;
  if (field.required) el.setAttribute('aria-required', 'true');

  // Scale font size for text-like fields so text visually fits the PDF bounding box.
  // Store the max size so fitFontToBox can reset to it and shrink as needed.
  if (field.type === 'text' || field.type === 'textarea') {
    const maxSize = Math.round(field.placement.height * scale * FONT_RATIO);
    el.dataset.maxFontSize = String(maxSize);
    el.style.fontSize = `${String(maxSize)}px`;
  }

  el.style.width = '100%';
  el.style.height = '100%';

  // Wrap in a positioned div so the required marker can be absolutely placed
  // alongside the input (inputs don't support ::before/::after cross-browser).
  const wrapper = document.createElement('div');
  wrapper.className = 'field-wrapper';
  positionElement(wrapper, field, page, scale);

  if (field.required) {
    wrapper.dataset.required = 'true';
    const marker = document.createElement('span');
    marker.className = 'required-marker';
    marker.setAttribute('aria-hidden', 'true');
    wrapper.appendChild(marker);
  }

  wrapper.appendChild(el);
  return wrapper;
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
    const fieldWrapper = buildFieldElement(field, docPage, scale);
    overlay.appendChild(fieldWrapper);
    // Fit font for pre-filled values once the element is in the DOM.
    const inputEl = fieldWrapper.querySelector<HTMLElement>('[data-max-font-size]');
    if (inputEl) fitFontToBox(inputEl);
  }

  const pageLabel = document.createElement('div');
  pageLabel.className = 'page-type-label';
  pageLabel.textContent = `Page ${String(docPage.pageNumber)} · ${humanPageType(docPage.pageType)}`;

  const wrapper = document.createElement('div');
  wrapper.className = 'page-wrapper';
  wrapper.style.setProperty('--print-width', `${String(docPage.widthPt / 72)}in`);
  wrapper.style.setProperty('--print-height', `${String(docPage.heightPt / 72)}in`);
  wrapper.appendChild(canvas);
  wrapper.appendChild(overlay);
  container.appendChild(pageLabel);
  container.appendChild(wrapper);
}

// ── Input change tracking ─────────────────────────────────────────────────────

function readInputValue(el: HTMLElement, field: PdfField): string | boolean {
  if (field.type === 'checkbox') {
    return (el as HTMLInputElement).checked;
  }
  if (field.type === 'radio') {
    // Return the option string (rb.value = radioValue) so the exporter can select it.
    return (el as HTMLInputElement).value;
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
    const newValue = readInputValue(target, field);
    field.value = newValue;

    // For radio groups: propagate the selected option string to all sibling
    // widgets in the same group (same field.name) so the in-memory doc stays
    // consistent and the exporter receives the same string value for every widget.
    if (field.type === 'radio') {
      for (const f of fieldById.values()) {
        if (f.name === field.name && f.id !== field.id) {
          f.value = newValue;
        }
      }
    }

    fitFontToBox(target);
    onDirty();
  });
}

// ── Tab order ─────────────────────────────────────────────────────────────────

/**
 * Build a position-sorted tab order for all interactive field elements and
 * intercept Tab / Shift+Tab to step through it.
 *
 * Fields are sorted by their PDF placement coordinates: primarily top-to-bottom
 * (by the field's top edge in PDF points, accumulated across pages), then
 * left-to-right within a row.  Two fields are considered "on the same row" when
 * their top edges differ by at most ROW_SNAP points.
 */
function initTabOrder(fpdfDoc: FpdfDocument, container: HTMLElement): void {
  const ROW_SNAP = 6; // pt — fields within 6 pt vertically are treated as one row

  interface Entry {
    el: HTMLElement;
    globalY: number; // pt from top of document (PDF y-axis flipped to screen)
    x: number; // pt from left edge of page
  }

  const entries: Entry[] = [];
  let cumulativeHeight = 0;

  for (const page of fpdfDoc.pages) {
    for (const field of page.fields) {
      if (field.readOnly) continue;
      const el = container.querySelector<HTMLElement>(`[data-field-id="${field.id}"]`);
      if (!el) continue;
      // PDF y=0 is the bottom; convert to top-down screen coordinates.
      const screenY = page.heightPt - field.placement.y - field.placement.height;
      entries.push({ el, globalY: cumulativeHeight + screenY, x: field.placement.x });
    }
    cumulativeHeight += page.heightPt;
  }

  entries.sort((a, b) => {
    if (Math.abs(a.globalY - b.globalY) <= ROW_SNAP) return a.x - b.x;
    return a.globalY - b.globalY;
  });

  const tabOrder = entries.map((e) => e.el);
  if (tabOrder.length === 0) return;

  container.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const active = document.activeElement as HTMLElement | null;
    if (!active) return;
    const idx = tabOrder.indexOf(active);
    if (idx === -1) return;
    event.preventDefault();
    const nextIdx = event.shiftKey
      ? (idx - 1 + tabOrder.length) % tabOrder.length
      : (idx + 1) % tabOrder.length;
    const next = tabOrder[nextIdx];
    if (!next) return;
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
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
  if (stored !== 'false') document.body.classList.add('show-fields');
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
  document.getElementById('error-dismiss')?.addEventListener('click', dismissError);
  document.getElementById('warn-dismiss')?.addEventListener('click', () => {
    document.getElementById('warn-banner')?.setAttribute('hidden', '');
  });
  initToggle();
  initZoom();
  setStatus('Loading…');

  let baseText = '';

  const [docRes, pdfRes] = await Promise.all([fetch('/doc'), fetch('/pdf')]);
  const fpdfDoc = (await docRes.json()) as FpdfDocument;

  const sendSave = initWebSocket(
    (updatedAt) => {
      setStatus(`${baseText} · Saved at ${formatTime(updatedAt)}`);
      setSaveButtonDirty(false);
    },
    (newDoc) => {
      // Apply externally-changed field values to the in-memory doc and DOM inputs.
      for (const newPage of newDoc.pages) {
        const existingPage = fpdfDoc.pages.find((p) => p.pageNumber === newPage.pageNumber);
        if (!existingPage) continue;
        for (const newField of newPage.fields) {
          const existing = existingPage.fields.find((f) => f.id === newField.id);
          if (existing) existing.value = newField.value;
          const el = document.querySelector<HTMLElement>(`[data-field-id="${newField.id}"]`);
          if (!el) continue;
          if (el instanceof HTMLInputElement && el.type === 'checkbox') {
            el.checked = newField.value === true;
          } else if (el instanceof HTMLInputElement && el.type === 'radio') {
            // el.value holds the radioValue (option string); check if it matches selection.
            el.checked = el.value !== '' && el.value === newField.value;
          } else {
            (el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value =
              typeof newField.value === 'string' ? newField.value : '';
          }
        }
      }
      setStatus(`${baseText} · Reloaded`);
      setSaveButtonDirty(false);
    },
  );
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

  initTabOrder(fpdfDoc, pagesContainer);

  const pageWord = pdfDoc.numPages === 1 ? 'page' : 'pages';
  const kindLabel = fpdfDoc.metadata.pdfKind ? ` · ${humanPdfKind(fpdfDoc.metadata.pdfKind)}` : '';
  baseText = `${fpdfDoc.metadata.pdfFilename} — ${String(pdfDoc.numPages)} ${pageWord}${kindLabel}`;
  setStatus(baseText);

  // Show full path as tooltip on the status element.
  const statusEl = document.getElementById('status');
  if (statusEl) statusEl.title = fpdfDoc.metadata.originalPdf;

  // Copy-path button: write the full path to the clipboard.
  const copyPathBtn = document.getElementById('copy-path');
  if (copyPathBtn) {
    copyPathBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(fpdfDoc.metadata.originalPdf).then(
        () => {
          const prev = copyPathBtn.textContent;
          copyPathBtn.textContent = 'Copied!';
          setTimeout(() => {
            copyPathBtn.textContent = prev;
          }, 1500);
        },
        () => {
          /* clipboard write failed — silently ignore */
        },
      );
    });
  }

  const hasUsableFields = fpdfDoc.pages.some(
    (p) =>
      p.fields.length > 0 ||
      p.candidateFields.some(
        (c) => (c.confidence === 'high' || c.confidence === 'medium') && c.type !== 'checkbox',
      ),
  );
  if (!hasUsableFields) {
    showWarning(
      'No fillable fields detected. This PDF appears to be a print-and-fill form — fpdf cannot fill it programmatically.',
    );
    const noFieldsMsg = 'No fillable fields were identified in this PDF';
    const toggleBtn = document.getElementById('toggle-fields') as HTMLButtonElement | null;
    const exportBtn = document.getElementById('export-pdf') as HTMLButtonElement | null;
    const clearBtn = document.getElementById('clear-fields') as HTMLButtonElement | null;
    if (toggleBtn) {
      toggleBtn.disabled = true;
      toggleBtn.title = noFieldsMsg;
    }
    if (exportBtn) {
      exportBtn.disabled = true;
      exportBtn.title = noFieldsMsg;
    }
    if (clearBtn) {
      clearBtn.disabled = true;
      clearBtn.title = noFieldsMsg;
    }
  }

  // Show a banner when the PDF kind has limited or no support.
  const pdfKind = fpdfDoc.metadata.pdfKind;
  if (pdfKind === 'pure-xfa') {
    showWarning(
      'This PDF uses pure XFA forms, which are not yet fully supported. ' +
        'Fields may be missing or export may not work correctly.',
    );
  } else if (pdfKind === 'no-acroform') {
    const pageTypes = new Set(fpdfDoc.pages.map((p) => p.pageType));
    if (pageTypes.has('raster') || pageTypes.has('raster+ocr')) {
      showWarning(
        'This PDF appears to be a scanned document. fpdf cannot detect or fill fields in scanned images.',
      );
    } else {
      // vector or hybrid — candidateFields only, no export
      showWarning(
        'This PDF has no AcroForm fields. Detected fields are approximate and values cannot be exported back to PDF.',
      );
    }
  }

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

  document.getElementById('clear-fields')?.addEventListener('click', () => {
    for (const field of fieldById.values()) {
      field.value = field.type === 'checkbox' ? false : '';
      const el = document.querySelector<HTMLElement>(`[data-field-id="${field.id}"]`);
      if (!el) continue;
      if (el instanceof HTMLInputElement && el.type === 'checkbox') {
        el.checked = false;
      } else if (el instanceof HTMLInputElement && el.type === 'radio') {
        el.checked = false;
      } else {
        (el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value = '';
        fitFontToBox(el);
      }
    }
    setStatus(`${baseText} · Unsaved changes`);
    setSaveButtonDirty(true);
    debouncedSave();
  });

  document.getElementById('export-pdf')?.addEventListener('click', () => {
    window.open('/filled-pdf', '_blank');
  });
}

initDarkToggle();
main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  showError(msg);
});
