import * as pdfjsLib from 'pdfjs-dist';
import type { FpdfDocument, PdfPage, PdfField, CandidateField } from '../types.js';

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
    } else if (m.type === 'pdfRegenerated') {
      // Server switched to the regenerated PDF — reload the page to pick up the new PDF + doc.
      window.location.reload();
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

function positionElement(
  el: HTMLElement,
  field: { placement: PdfField['placement'] },
  page: PdfPage,
  scale: number,
): void {
  const { x, y, width, height } = field.placement;
  el.style.left = `${String(x * scale)}px`;
  el.style.top = `${String((page.heightPt - y - height) * scale)}px`;
  el.style.width = `${String(width * scale)}px`;
  el.style.height = `${String(height * scale)}px`;
}

const MIN_FIELD_SIZE_PT = 8; // minimum width/height in PDF points when resizing

// ── Edit-layout selection ─────────────────────────────────────────────────────

let editSelectedWrapper: HTMLElement | null = null;
const editDeleteCallbacks = new WeakMap<HTMLElement, () => void>();

function editSelectField(wrapper: HTMLElement | null): void {
  if (editSelectedWrapper) editSelectedWrapper.classList.remove('field-selected');
  editSelectedWrapper = wrapper;
  if (wrapper) {
    wrapper.classList.add('field-selected');
    document.body.classList.add('edit-layout');
  } else {
    document.body.classList.remove('edit-layout');
  }
}

// ── Tooltip ───────────────────────────────────────────────────────────────────

const tooltipEl = document.createElement('div');
tooltipEl.className = 'field-tooltip';
document.body.appendChild(tooltipEl);
let tooltipTimer = 0;
let tooltipMouseX = 0;
let tooltipMouseY = 0;

function showTooltip(text: string, x: number, y: number): void {
  tooltipEl.textContent = text;
  tooltipEl.style.left = `${String(x + 14)}px`;
  tooltipEl.style.top = `${String(y + 14)}px`;
  tooltipEl.style.display = 'block';
}

function hideTooltip(): void {
  clearTimeout(tooltipTimer);
  tooltipEl.style.display = 'none';
}

// ── Context menu ──────────────────────────────────────────────────────────────

type MenuItem =
  | { label: string; action: () => void; submenu?: never }
  | { label: string; submenu: { label: string; action: () => void }[]; action?: never };

const contextMenuEl = document.createElement('div');
contextMenuEl.className = 'field-context-menu';
document.body.appendChild(contextMenuEl);

const subMenuEl = document.createElement('div');
subMenuEl.className = 'field-context-menu';
document.body.appendChild(subMenuEl);

function hideSubMenu(): void {
  subMenuEl.style.display = 'none';
  subMenuEl.innerHTML = '';
}

function showSubMenu(
  items: { label: string; action: () => void }[],
  triggerBtn: HTMLElement,
): void {
  subMenuEl.innerHTML = '';
  for (const item of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = item.label;
    btn.addEventListener('click', () => {
      hideContextMenu();
      item.action();
    });
    subMenuEl.appendChild(btn);
  }
  // Measure off-screen then position flush with the right edge of the main menu.
  subMenuEl.style.left = '-9999px';
  subMenuEl.style.top = '-9999px';
  subMenuEl.style.display = 'block';
  const mainRect = contextMenuEl.getBoundingClientRect();
  const btnRect = triggerBtn.getBoundingClientRect();
  const subW = subMenuEl.offsetWidth;
  const subH = subMenuEl.offsetHeight;
  let left = mainRect.right;
  let top = btnRect.top;
  if (left + subW > window.innerWidth) left = mainRect.left - subW;
  if (top + subH > window.innerHeight) top = window.innerHeight - subH - 4;
  subMenuEl.style.left = `${String(left)}px`;
  subMenuEl.style.top = `${String(top)}px`;
}

function showContextMenu(items: MenuItem[], x: number, y: number): void {
  hideSubMenu();
  contextMenuEl.innerHTML = '';
  for (const item of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = item.label;
    if (item.submenu) {
      const arrow = document.createElement('span');
      arrow.className = 'submenu-arrow';
      arrow.textContent = '▶';
      arrow.setAttribute('aria-hidden', 'true');
      btn.appendChild(arrow);
      const sub = item.submenu;
      btn.addEventListener('mouseenter', () => {
        showSubMenu(sub, btn);
      });
    } else {
      btn.addEventListener('mouseenter', () => {
        hideSubMenu();
      });
      btn.addEventListener('click', () => {
        hideContextMenu();
        item.action();
      });
    }
    contextMenuEl.appendChild(btn);
  }
  contextMenuEl.style.left = `${String(x)}px`;
  contextMenuEl.style.top = `${String(y)}px`;
  contextMenuEl.style.display = 'block';
  // Hide submenu when mouse leaves the main menu (unless entering the submenu).
  contextMenuEl.addEventListener(
    'mouseleave',
    (e) => {
      if (!subMenuEl.contains(e.relatedTarget as Node)) hideSubMenu();
    },
    { once: true },
  );
}

function hideContextMenu(): void {
  hideSubMenu();
  contextMenuEl.style.display = 'none';
  contextMenuEl.innerHTML = '';
}

// ── Snap guide ────────────────────────────────────────────────────────────────

/**
 * Find the best horizontal snap for a field being moved.
 * Compares the field's top and bottom edges against every other field's
 * top and bottom edges on the same overlay.
 * Returns the snapped top position (canvas-scale px) and the guide y position,
 * or null if nothing is within threshold.
 */
function findYSnap(
  wrapper: HTMLElement,
  overlay: HTMLElement,
  myTopPx: number,
  myHeightPx: number,
  thresholdPx: number,
): { snappedTopPx: number; guidePx: number } | null {
  const myBottomPx = myTopPx + myHeightPx;
  let bestDist = thresholdPx;
  let result: { snappedTopPx: number; guidePx: number } | null = null;

  for (const other of Array.from(overlay.querySelectorAll<HTMLElement>('.field-wrapper'))) {
    if (other === wrapper) continue;
    const ot = parseFloat(other.style.top);
    const ob = ot + parseFloat(other.style.height);

    for (const guidePx of [ot, ob]) {
      const d1 = Math.abs(myTopPx - guidePx);
      if (d1 < bestDist) {
        bestDist = d1;
        result = { snappedTopPx: guidePx, guidePx };
      }
      const d2 = Math.abs(myBottomPx - guidePx);
      if (d2 < bestDist) {
        bestDist = d2;
        result = { snappedTopPx: guidePx - myHeightPx, guidePx };
      }
    }
  }

  return result;
}

function showSnapGuide(overlay: HTMLElement, topPx: number): void {
  let guide = overlay.querySelector<HTMLElement>('.snap-guide');
  if (!guide) {
    guide = document.createElement('div');
    guide.className = 'snap-guide';
    overlay.appendChild(guide);
  }
  guide.style.top = `${String(topPx)}px`;
}

function hideSnapGuide(overlay: HTMLElement): void {
  overlay.querySelector('.snap-guide')?.remove();
}

// ── Field name editor ─────────────────────────────────────────────────────────

function hideNameEditor(): void {
  document.querySelector('.field-name-editor')?.remove();
}

function showNameEditor(
  initialValue: string,
  onConfirm: (name: string) => void,
  x: number,
  y: number,
): void {
  hideNameEditor();

  const editor = document.createElement('div');
  editor.className = 'field-name-editor';
  editor.style.left = `${String(x)}px`;
  editor.style.top = `${String(y)}px`;

  const input = document.createElement('input');
  input.type = 'text';
  input.value = initialValue;
  input.placeholder = 'Field name';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save';

  function confirm(): void {
    onConfirm(input.value.trim());
    hideNameEditor();
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      confirm();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      hideNameEditor();
    }
  });
  saveBtn.addEventListener('click', confirm);

  editor.append(input, saveBtn);
  document.body.appendChild(editor);

  // Close on outside click (deferred so this same event doesn't immediately dismiss)
  window.setTimeout(() => {
    function onOutside(ev: PointerEvent): void {
      if (!editor.contains(ev.target as Node)) {
        hideNameEditor();
        document.removeEventListener('pointerdown', onOutside);
      }
    }
    document.addEventListener('pointerdown', onOutside);
  }, 0);

  input.focus();
  input.select();
}

/**
 * Attach a move handle and 8 resize handles to a field wrapper.
 * Handles are only visible when `body.edit-layout` is active (CSS-controlled).
 * Works for both AcroForm (PdfField) and candidate fields — both share the same
 * `placement` shape.
 */
function makeFieldInteractive(
  wrapper: HTMLElement,
  field: { placement: PdfField['placement'] },
  page: PdfPage,
  scale: number,
  onMutate: () => void,
  onDelete?: () => void,
): void {
  if (onDelete) editDeleteCallbacks.set(wrapper, onDelete);

  // Enter edit mode on click when not already in edit mode (capture phase).
  // Skip if this wrapper's input already has focus — user is typing, let clicks through normally.
  wrapper.addEventListener(
    'pointerdown',
    (e) => {
      if (document.body.classList.contains('edit-layout')) return;
      if (e.button !== 0) return;
      // Never intercept clicks on radio/checkbox — let them toggle normally.
      const target = e.target as HTMLElement;
      if (
        target instanceof HTMLInputElement &&
        (target.type === 'radio' || target.type === 'checkbox')
      )
        return;
      if (wrapper.contains(document.activeElement)) return;
      e.stopPropagation();
      e.preventDefault();
      hideContextMenu();
      hideNameEditor();
      editSelectField(wrapper);
    },
    { capture: true },
  );

  wrapper.addEventListener('mouseenter', (e) => {
    tooltipMouseX = e.clientX;
    tooltipMouseY = e.clientY;
    clearTimeout(tooltipTimer);
    tooltipTimer = window.setTimeout(() => {
      const inputEl = wrapper.querySelector<HTMLElement>('[data-field-id]');
      const name = inputEl ? (inputEl.dataset.fieldName ?? '').trim() : '';
      const inEdit = document.body.classList.contains('edit-layout');
      const hints = onDelete
        ? 'Drag: move · Corners: resize · Del: delete'
        : 'Drag: move · Corners: resize';
      let text = name;
      if (inEdit) text = text ? `${text} · ${hints}` : hints;
      if (text) showTooltip(text, tooltipMouseX, tooltipMouseY);
    }, 600);
  });
  wrapper.addEventListener('mousemove', (e) => {
    tooltipMouseX = e.clientX;
    tooltipMouseY = e.clientY;
    if (tooltipEl.style.display !== 'none') {
      tooltipEl.style.left = `${String(e.clientX + 14)}px`;
      tooltipEl.style.top = `${String(e.clientY + 14)}px`;
    }
  });
  wrapper.addEventListener('mouseleave', () => {
    hideTooltip();
  });

  // ── Move handle ──────────────────────────────────────────────────────────────
  const moveHandle = document.createElement('div');
  moveHandle.className = 'field-move-handle';
  wrapper.prepend(moveHandle);

  let dragStartX = 0;
  let dragStartY = 0;
  let hasDragged = false;
  let isCaptured = false;
  let origPlacement = { ...field.placement };

  moveHandle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; // ignore right-click and other non-primary buttons
    e.preventDefault();
    e.stopPropagation();
    editSelectField(wrapper);
    moveHandle.setPointerCapture(e.pointerId);
    isCaptured = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    hasDragged = false;
    origPlacement = { ...field.placement };
  });

  moveHandle.addEventListener('pointermove', (e) => {
    if (!moveHandle.hasPointerCapture(e.pointerId)) return;
    if (Math.abs(e.clientX - dragStartX) > 3 || Math.abs(e.clientY - dragStartY) > 3) {
      hasDragged = true;
    }
    // Use bounding rect to get the effective scale (canvas scale × CSS zoom).
    const pageWrapper = wrapper.closest<HTMLElement>('.page-wrapper');
    const effectiveScale = pageWrapper
      ? pageWrapper.getBoundingClientRect().width / page.widthPt
      : scale;
    const dx = (e.clientX - dragStartX) / effectiveScale;
    const dy = (e.clientY - dragStartY) / effectiveScale;
    field.placement.x = origPlacement.x + dx;
    field.placement.y = origPlacement.y - dy; // PDF y is from bottom
    positionElement(wrapper, field, page, scale);

    // Horizontal snap: compare canvas-scale pixel top against nearby fields
    const overlay = wrapper.closest<HTMLElement>('.overlay');
    if (overlay) {
      const myTopPx = parseFloat(wrapper.style.top);
      const myHeightPx = parseFloat(wrapper.style.height);
      const snap = findYSnap(wrapper, overlay, myTopPx, myHeightPx, 8);
      if (snap) {
        // Adjust PDF y to match the snapped pixel top
        field.placement.y = page.heightPt - snap.snappedTopPx / scale - field.placement.height;
        positionElement(wrapper, field, page, scale);
        showSnapGuide(overlay, snap.guidePx);
      } else {
        hideSnapGuide(overlay);
      }
    }
  });

  moveHandle.addEventListener('pointerup', () => {
    if (!isCaptured) return; // pointerup without a prior pointerdown on this handle — ignore
    isCaptured = false;
    const overlay = wrapper.closest<HTMLElement>('.overlay');
    if (overlay) hideSnapGuide(overlay);
    if (!hasDragged) {
      // Click on selected field (no drag): exit edit mode and focus the input.
      const inputEl = wrapper.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        'input[type="text"], textarea',
      );
      editSelectField(null);
      if (inputEl) inputEl.focus();
      return;
    }
    onMutate();
  });

  moveHandle.addEventListener('pointercancel', () => {
    isCaptured = false;
    hasDragged = false;
  });

  // ── Resize handles ───────────────────────────────────────────────────────────
  for (const dir of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const) {
    const handle = document.createElement('div');
    handle.className = 'field-resize-handle';
    handle.dataset.dir = dir;
    wrapper.appendChild(handle);
    attachResize(handle, dir, field, page, scale, wrapper, onMutate);
  }
}

type ResizeDir = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

function attachResize(
  handle: HTMLElement,
  dir: ResizeDir,
  field: { placement: PdfField['placement'] },
  page: PdfPage,
  scale: number,
  wrapper: HTMLElement,
  onMutate: () => void,
): void {
  let dragStartX = 0;
  let dragStartY = 0;
  let origPlacement = { ...field.placement };

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    origPlacement = { ...field.placement };
  });

  handle.addEventListener('pointermove', (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    const pageWrapper = wrapper.closest<HTMLElement>('.page-wrapper');
    const effectiveScale = pageWrapper
      ? pageWrapper.getBoundingClientRect().width / page.widthPt
      : scale;
    const dx = (e.clientX - dragStartX) / effectiveScale;
    // dy: positive = moving down in screen = decreasing PDF y
    const dy = (e.clientY - dragStartY) / effectiveScale;

    let { x, y, width, height } = origPlacement;

    // North edge: top moves up (dy < 0) → height increases, y unchanged
    if (dir === 'n' || dir === 'ne' || dir === 'nw') {
      height = Math.max(MIN_FIELD_SIZE_PT, origPlacement.height - dy);
    }
    // South edge: bottom moves down (dy > 0) → y decreases, height increases
    if (dir === 's' || dir === 'se' || dir === 'sw') {
      y = origPlacement.y - dy;
      height = Math.max(MIN_FIELD_SIZE_PT, origPlacement.height + dy);
      if (height === MIN_FIELD_SIZE_PT)
        y = origPlacement.y + origPlacement.height - MIN_FIELD_SIZE_PT;
    }
    // East edge: right moves right (dx > 0) → width increases, x unchanged
    if (dir === 'e' || dir === 'ne' || dir === 'se') {
      width = Math.max(MIN_FIELD_SIZE_PT, origPlacement.width + dx);
    }
    // West edge: left moves left (dx < 0) → x decreases, width increases
    if (dir === 'w' || dir === 'nw' || dir === 'sw') {
      x = origPlacement.x + dx;
      width = Math.max(MIN_FIELD_SIZE_PT, origPlacement.width - dx);
      if (width === MIN_FIELD_SIZE_PT)
        x = origPlacement.x + origPlacement.width - MIN_FIELD_SIZE_PT;
    }

    field.placement.x = x;
    field.placement.y = y;
    field.placement.width = width;
    field.placement.height = height;
    positionElement(wrapper, field, page, scale);

    // Keep font size proportional to the new height
    const inputEl = wrapper.querySelector<HTMLElement>('[data-max-font-size]');
    if (inputEl) {
      const maxSize = Math.round(height * scale * FONT_RATIO);
      inputEl.dataset.maxFontSize = String(maxSize);
      fitFontToBox(inputEl);
    }
  });

  handle.addEventListener('pointerup', () => {
    onMutate();
  });
}

function initEditInteractions(
  fpdfDoc: FpdfDocument,
  pagesContainer: HTMLElement,
  candidateById: Map<string, CandidateField>,
  fieldById: Map<string, PdfField>,
  onDirty: () => void,
): void {
  // Deselect and hide context menu on click outside
  document.addEventListener('pointerdown', (e) => {
    const target = e.target as HTMLElement;
    if (!target.closest('.field-wrapper')) editSelectField(null);
    if (!target.closest('.field-context-menu')) hideContextMenu(); // also hides submenu
  });

  // Delete key: remove selected candidate field
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete') return;
    if (!editSelectedWrapper) return;
    // Only bail if focus is inside the selected wrapper itself (user is typing).
    // Focus in another wrapper (or nowhere) should still trigger deletion.
    const active = document.activeElement;
    if (active && editSelectedWrapper.contains(active)) return;
    const cb = editDeleteCallbacks.get(editSelectedWrapper);
    if (!cb) return;
    e.preventDefault();
    cb();
  });

  // Escape key: exit edit mode, dismiss context menu and name editor
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      editSelectField(null);
      hideContextMenu();
      hideNameEditor();
    }
  });

  // Typing while a text field is selected: exit edit mode and route keystroke to input
  document.addEventListener('keydown', (e) => {
    if (!editSelectedWrapper) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length !== 1 && e.key !== 'Backspace') return;
    const active = document.activeElement;
    if (
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      active instanceof HTMLSelectElement
    )
      return;
    const inputEl = editSelectedWrapper.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      'input[type="text"], textarea',
    );
    if (!inputEl) return;
    editSelectField(null); // exit edit mode — makes input interactive
    inputEl.focus();
    // Don't preventDefault; the keypress will now land on the focused input
  });

  // Right-click context menu — exits edit mode only when not clicking on a field
  pagesContainer.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const onField = (e.target as HTMLElement).closest('.field-wrapper') !== null;
    if (!onField) editSelectField(null);

    // Resolve page wrapper first — works whether click lands on overlay, canvas, or wrapper itself
    const pageWrapper = (e.target as HTMLElement).closest<HTMLElement>('.page-wrapper');
    if (!pageWrapper) return;
    const overlay = pageWrapper.querySelector<HTMLElement>('.overlay');
    if (!overlay) return;
    const pageWrappers = Array.from(pagesContainer.querySelectorAll<HTMLElement>('.page-wrapper'));
    const pageIndex = pageWrappers.indexOf(pageWrapper);
    const docPage = fpdfDoc.pages[pageIndex];
    if (!docPage) return;

    // Capture non-null references for closures
    const safeOverlay = overlay;
    const safePageWrapper = pageWrapper;
    const safePage = docPage;

    const overlayRect = safeOverlay.getBoundingClientRect();
    const effectiveScale = overlayRect.width / safePage.widthPt;
    const canvas = safePageWrapper.querySelector('canvas');
    const canvasScale = canvas ? canvas.width / safePage.widthPt : effectiveScale;

    const clickX = e.clientX - overlayRect.left;
    const clickY = e.clientY - overlayRect.top;

    const DEFAULT_W = 120;
    const DEFAULT_H = 20;
    const xPdf = Math.max(0, clickX / effectiveScale - DEFAULT_W / 2);
    const yPdf = Math.max(0, safePage.heightPt - clickY / effectiveScale - DEFAULT_H / 2);

    const items: MenuItem[] = [];

    const fieldWrapper = (e.target as HTMLElement).closest<HTMLElement>('.field-wrapper');
    if (fieldWrapper) {
      // Resolve the underlying field object (candidate or AcroForm)
      const candidateInputEl = fieldWrapper.querySelector<HTMLElement>('[data-candidate="true"]');
      const candidateId = candidateInputEl?.dataset.fieldId;
      const candidateField = candidateId ? candidateById.get(candidateId) : undefined;
      const acroInputEl = candidateInputEl
        ? null
        : fieldWrapper.querySelector<HTMLElement>('[data-field-id]');
      const acroId = acroInputEl?.dataset.fieldId;
      const acroField = acroId ? fieldById.get(acroId) : undefined;
      const anyField: CandidateField | PdfField | undefined = candidateField ?? acroField;
      const inputEl = fieldWrapper.querySelector<HTMLElement>('input, textarea, select');

      // Duplicate: copy placement from wrapper CSS (canvas-scale pixels → PDF pts)
      const wLeft = parseFloat(fieldWrapper.style.left);
      const wTop = parseFloat(fieldWrapper.style.top);
      const wWidth = parseFloat(fieldWrapper.style.width);
      const wHeight = parseFloat(fieldWrapper.style.height);
      const dupX = wLeft / canvasScale;
      const dupW = wWidth / canvasScale;
      const dupH = wHeight / canvasScale;
      const dupY = safePage.heightPt - wTop / canvasScale - dupH;

      items.push({
        label: 'Duplicate field',
        action: () => {
          const OFFSET = 10;
          const newField: CandidateField = {
            id: crypto.randomUUID(),
            type: 'text',
            label: '',
            displayName: 'Field',
            placement: { x: dupX + OFFSET, y: dupY - OFFSET, width: dupW, height: dupH },
            value: '',
            confidence: 'high',
            dismissed: false,
          };
          safePage.candidateFields.push(newField);
          candidateById.set(newField.id, newField);
          const wrapper = buildCandidateFieldElement(newField, safePage, canvasScale, onDirty);
          safeOverlay.appendChild(wrapper);
          const newInputEl = wrapper.querySelector<HTMLElement>('[data-max-font-size]');
          if (newInputEl) fitFontToBox(newInputEl);
          editSelectField(wrapper);
          onDirty();
        },
      });

      // Name field
      if (anyField) {
        const currentName = candidateField
          ? candidateField.label || candidateField.displayName
          : (acroField?.displayName ?? '');
        items.push({
          label: 'Name field',
          action: () => {
            showNameEditor(
              currentName,
              (newName) => {
                if (candidateField) {
                  candidateField.label = newName;
                  candidateField.displayName = newName || 'Field';
                } else if (acroField) {
                  acroField.displayName = newName || acroField.name;
                }
                if (inputEl) inputEl.dataset.fieldName = newName;
                onDirty();
              },
              e.clientX,
              e.clientY,
            );
          },
        });
      }

      // Text alignment
      if (anyField && inputEl) {
        const safeField = anyField;
        const safeInputEl = inputEl;
        items.push({
          label: 'Text alignment',
          submenu: (
            [
              { label: 'Center', value: 'center' },
              { label: 'Justified', value: 'justify' },
              { label: 'Left', value: 'left' },
              { label: 'Right', value: 'right' },
            ] as { label: string; value: 'left' | 'center' | 'right' | 'justify' }[]
          ).map(({ label, value }) => ({
            label,
            action: () => {
              safeField.textAlign = value;
              safeInputEl.style.textAlign = value;
              onDirty();
            },
          })),
        });
      }

      // Delete (candidate fields only)
      if (candidateField) {
        items.push({
          label: 'Delete field',
          action: () => {
            const cb = editDeleteCallbacks.get(fieldWrapper);
            cb?.();
          },
        });
      }
    }

    items.push({
      label: 'Add field here',
      action: () => {
        const newField: CandidateField = {
          id: crypto.randomUUID(),
          type: 'text',
          label: '',
          displayName: 'Field',
          placement: { x: xPdf, y: yPdf, width: DEFAULT_W, height: DEFAULT_H },
          value: '',
          confidence: 'high',
          dismissed: false,
        };
        safePage.candidateFields.push(newField);
        candidateById.set(newField.id, newField);
        const wrapper = buildCandidateFieldElement(newField, safePage, canvasScale, onDirty);
        safeOverlay.appendChild(wrapper);
        const inputEl = wrapper.querySelector<HTMLElement>('[data-max-font-size]');
        if (inputEl) fitFontToBox(inputEl);
        editSelectField(wrapper);
        onDirty();
      },
    });

    items.sort((a, b) => a.label.localeCompare(b.label));
    showContextMenu(items, e.clientX, e.clientY);
  });
}

function buildFieldElement(
  field: PdfField,
  page: PdfPage,
  scale: number,
  onDirty: () => void,
): HTMLElement {
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

  el.dataset.fieldName = field.tooltip ?? field.displayName;
  el.dataset.fieldId = field.id;
  if (field.readOnly) (el as HTMLInputElement).disabled = true;
  if (field.required) el.setAttribute('aria-required', 'true');

  // Scale font size for text-like fields so text visually fits the PDF bounding box.
  // Store the max size so fitFontToBox can reset to it and shrink as needed.
  if (field.type === 'text' || field.type === 'textarea') {
    const maxSize = Math.round(field.placement.height * scale * FONT_RATIO);
    el.dataset.maxFontSize = String(maxSize);
    el.style.fontSize = `${String(maxSize)}px`;
    (el as HTMLInputElement | HTMLTextAreaElement).addEventListener('dblclick', () => {
      (el as HTMLInputElement | HTMLTextAreaElement).select();
    });
  }

  el.style.width = '100%';
  el.style.height = '100%';
  if (field.textAlign) el.style.textAlign = field.textAlign;

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

  makeFieldInteractive(wrapper, field, page, scale, onDirty);
  wrapper.appendChild(el);
  return wrapper;
}

function buildCandidateFieldElement(
  field: CandidateField,
  page: PdfPage,
  scale: number,
  onDirty: () => void,
): HTMLElement {
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
    default: {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = typeof field.value === 'string' ? field.value : '';
      el = input;
      break;
    }
  }

  el.dataset.fieldName = field.label || field.displayName;
  el.dataset.fieldId = field.id;
  el.dataset.candidate = 'true';

  if (field.type === 'text' || field.type === 'textarea') {
    const maxSize = Math.round(field.placement.height * scale * FONT_RATIO);
    el.dataset.maxFontSize = String(maxSize);
    el.style.fontSize = `${String(maxSize)}px`;
    (el as HTMLInputElement | HTMLTextAreaElement).addEventListener('dblclick', () => {
      (el as HTMLInputElement | HTMLTextAreaElement).select();
    });
  }

  el.style.width = '100%';
  el.style.height = '100%';
  if (field.textAlign) el.style.textAlign = field.textAlign;

  const wrapper = document.createElement('div');
  wrapper.className = 'field-wrapper';
  positionElement(wrapper, field, page, scale);

  const onDelete = (): void => {
    const idx = page.candidateFields.indexOf(field);
    if (idx !== -1) page.candidateFields.splice(idx, 1);
    if (editSelectedWrapper === wrapper) editSelectField(null);
    wrapper.remove();
    onDirty();
  };

  makeFieldInteractive(wrapper, field, page, scale, onDirty, onDelete);
  wrapper.appendChild(el);
  return wrapper;
}

// ── Page rendering ────────────────────────────────────────────────────────────

async function renderPage(
  pdfPage: pdfjsLib.PDFPageProxy,
  docPage: PdfPage,
  container: HTMLElement,
  onDirty: () => void,
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
    const fieldWrapper = buildFieldElement(field, docPage, scale, onDirty);
    overlay.appendChild(fieldWrapper);
    // Fit font for pre-filled values once the element is in the DOM.
    const inputEl = fieldWrapper.querySelector<HTMLElement>('[data-max-font-size]');
    if (inputEl) fitFontToBox(inputEl);
  }
  for (const field of docPage.candidateFields) {
    if (field.dismissed || field.confidence === 'low') continue;
    const fieldWrapper = buildCandidateFieldElement(field, docPage, scale, onDirty);
    overlay.appendChild(fieldWrapper);
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
  candidateById: Map<string, CandidateField> = new Map<string, CandidateField>(),
): void {
  container.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const fieldId = target.dataset.fieldId;
    if (!fieldId) return;

    const field = fieldById.get(fieldId);
    if (field) {
      const newValue = readInputValue(target, field);
      field.value = newValue;
      // For radio groups: propagate value to all sibling widgets.
      if (field.type === 'radio') {
        for (const f of fieldById.values()) {
          if (f.name === field.name && f.id !== field.id) f.value = newValue;
        }
      }
    } else {
      const candidate = candidateById.get(fieldId);
      if (candidate) {
        candidate.value =
          target instanceof HTMLInputElement && target.type === 'checkbox'
            ? target.checked
            : (target as HTMLInputElement | HTMLTextAreaElement).value;
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
      const screenY = page.heightPt - field.placement.y - field.placement.height;
      entries.push({ el, globalY: cumulativeHeight + screenY, x: field.placement.x });
    }
    for (const field of page.candidateFields) {
      if (field.dismissed || field.confidence === 'low') continue;
      const el = container.querySelector<HTMLElement>(`[data-field-id="${field.id}"]`);
      if (!el) continue;
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

  // Build field maps early so they're available to drag/resize handlers during rendering.
  const fieldById = new Map<string, PdfField>();
  for (const page of fpdfDoc.pages) {
    for (const field of page.fields) fieldById.set(field.id, field);
  }
  const candidateById = new Map<string, CandidateField>();
  for (const page of fpdfDoc.pages) {
    for (const field of page.candidateFields) candidateById.set(field.id, field);
  }

  // Hoist debouncedSave and onDirty before renderPage so layout-drag mutations
  // can trigger saves the same way input changes do. Both capture `baseText` by
  // reference — it will be populated before any user interaction fires the callback.
  const debouncedSave = debounce(() => {
    setStatus(`${baseText} · Saving…`);
    sendSave(fpdfDoc);
  }, 800);
  const onDirty = (): void => {
    setStatus(`${baseText} · Unsaved changes`);
    setSaveButtonDirty(true);
    debouncedSave();
  };

  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const pdfPage = await pdfDoc.getPage(i);
    const docPage = fpdfDoc.pages.find((p) => p.pageNumber === i);
    if (!docPage) continue;
    await renderPage(pdfPage, docPage, pagesContainer, onDirty);
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

  // Show a banner when the PDF kind has limited or no support.
  const pdfKind = fpdfDoc.metadata.pdfKind;

  const hasUsableFields = fpdfDoc.pages.some(
    (p) =>
      p.fields.length > 0 ||
      p.candidateFields.some(
        (c) => (c.confidence === 'high' || c.confidence === 'medium') && c.type !== 'checkbox',
      ),
  );
  // For no-acroform PDFs the user can always add fields manually — don't disable UI.
  if (!hasUsableFields && pdfKind !== 'no-acroform') {
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
  if (pdfKind === 'xfa-hybrid') {
    showWarning(
      'This PDF uses XFA form technology. Fill it normally, or regenerate for broader PDF reader compatibility.',
    );
    const regenBtn = document.getElementById('regen-btn');
    if (regenBtn) {
      regenBtn.removeAttribute('hidden');
      regenBtn.addEventListener('click', () => {
        (regenBtn as HTMLButtonElement).disabled = true;
        regenBtn.textContent = 'Regenerating\u2026';
        fetch('/regenerate-acroform', { method: 'POST' })
          .then((r) => {
            if (!r.ok) return r.text().then((t) => Promise.reject(new Error(t)));
            // pdfRegenerated WS message will trigger window.location.reload()
          })
          .catch((err: unknown) => {
            (regenBtn as HTMLButtonElement).disabled = false;
            regenBtn.textContent = 'Regenerate as standard PDF';
            showError(err instanceof Error ? err.message : String(err));
          });
      });
    }
  } else if (pdfKind === 'pure-xfa') {
    showWarning(
      'This PDF uses pure XFA form technology. Page content may not be visible in all viewers.',
    );
    const regenBtn = document.getElementById('regen-btn');
    if (regenBtn) {
      regenBtn.removeAttribute('hidden');
      regenBtn.addEventListener('click', () => {
        (regenBtn as HTMLButtonElement).disabled = true;
        regenBtn.textContent = 'Regenerating\u2026';
        fetch('/regenerate-acroform', { method: 'POST' })
          .then((r) => {
            if (!r.ok) return r.text().then((t) => Promise.reject(new Error(t)));
          })
          .catch((err: unknown) => {
            (regenBtn as HTMLButtonElement).disabled = false;
            regenBtn.textContent = 'Regenerate as standard PDF';
            showError(err instanceof Error ? err.message : String(err));
          });
      });
    }
  } else if (pdfKind === 'no-acroform') {
    const pageTypes = new Set(fpdfDoc.pages.map((p) => p.pageType));
    if (pageTypes.has('raster') || pageTypes.has('raster+ocr')) {
      showWarning(
        'This PDF appears to be a scanned document. No fields were detected automatically — right-click anywhere on the page to add fields manually. Exported values will be stamped directly onto the page.',
      );
    } else {
      // vector or hybrid — candidateFields only; export stamps text onto the page
      showWarning(
        'This PDF has no AcroForm fields. Detected field positions are approximate — click a field to adjust its layout. Exported values will be stamped directly onto the page.',
      );
    }
  }

  watchInputs(pagesContainer, fieldById, onDirty, candidateById);
  initEditInteractions(fpdfDoc, pagesContainer, candidateById, fieldById, onDirty);

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
    for (const field of candidateById.values()) {
      field.value = field.type === 'checkbox' ? false : '';
      const el = document.querySelector<HTMLElement>(`[data-field-id="${field.id}"]`);
      if (!el) continue;
      if (el instanceof HTMLInputElement && el.type === 'checkbox') {
        el.checked = false;
      } else {
        (el as HTMLInputElement | HTMLTextAreaElement).value = '';
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
