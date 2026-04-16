import type { BrowseResponse, DirectoryEntry, UiCapabilitiesResponse } from '../types.js';

// ── Dark mode (mirrors app.ts) ────────────────────────────────────────────────
// Applied immediately to avoid flash of wrong theme.
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
    b.textContent = isDark ? '☀' : '☾';
  }

  updateButton(btn);

  btn.addEventListener('click', () => {
    const next = document.body.dataset.theme === 'dark' ? 'light' : 'dark';
    document.body.dataset.theme = next;
    localStorage.setItem('fpdf-theme', next);
    updateButton(btn);
  });
}

// ── State ─────────────────────────────────────────────────────────────────────

let currentPath = '';
let busy = false;
let canBrowseServerFiles = true;

// ── DOM helpers ───────────────────────────────────────────────────────────────

function setStatus(msg: string): void {
  const el = document.getElementById('picker-status');
  if (el) el.textContent = msg;
}

function showError(msg: string): void {
  const banner = document.getElementById('picker-error');
  const msgEl = document.getElementById('picker-error-message');
  if (banner && msgEl) {
    msgEl.textContent = msg;
    banner.hidden = false;
  }
}

function hideError(): void {
  const banner = document.getElementById('picker-error');
  if (banner) banner.hidden = true;
}

function setEntriesDisabled(disabled: boolean): void {
  const list = document.getElementById('entry-list');
  if (!list) return;
  list.querySelectorAll('button.entry').forEach((btn) => {
    (btn as HTMLButtonElement).disabled = disabled;
  });
}

function setUploadProgress(loadedBytes: number, totalBytes: number | null): void {
  const progressEl = document.getElementById('upload-progress');
  const labelEl = document.getElementById('upload-progress-label');
  const barEl = document.getElementById('upload-progress-bar') as HTMLProgressElement | null;
  if (!progressEl || !labelEl || !barEl) return;

  progressEl.hidden = false;

  if (totalBytes !== null && totalBytes > 0) {
    const pct = Math.min(100, Math.round((loadedBytes / totalBytes) * 100));
    barEl.value = pct;
    labelEl.textContent = `Uploading… ${String(pct)}%`;
    setStatus(`Uploading… ${String(pct)}%`);
  } else {
    barEl.value = 0;
    labelEl.textContent = `Uploading… ${String(Math.round(loadedBytes / 1024))} KB`;
    setStatus('Uploading…');
  }
}

function resetUploadProgress(): void {
  const progressEl = document.getElementById('upload-progress');
  const labelEl = document.getElementById('upload-progress-label');
  const barEl = document.getElementById('upload-progress-bar') as HTMLProgressElement | null;
  if (progressEl) progressEl.hidden = true;
  if (labelEl) labelEl.textContent = 'Uploading… 0%';
  if (barEl) barEl.value = 0;
}

function applyUiCapabilities(canBrowse: boolean): void {
  canBrowseServerFiles = canBrowse;

  const navEl = document.getElementById('picker-nav');
  const statusEl = document.getElementById('picker-status');
  const entryListEl = document.getElementById('entry-list');
  const introMsgEl = document.getElementById('picker-intro-message');

  if (canBrowse) {
    if (navEl) navEl.hidden = false;
    if (statusEl) statusEl.hidden = false;
    if (entryListEl) entryListEl.hidden = false;
    if (introMsgEl)
      introMsgEl.textContent =
        'Browse to a PDF on this server, or upload one from your device below.';
  } else {
    if (navEl) navEl.hidden = true;
    if (statusEl) statusEl.hidden = true;
    if (entryListEl) entryListEl.hidden = true;
    if (introMsgEl) introMsgEl.textContent = 'Upload a PDF from your device to get started.';
  }
}

async function loadUiCapabilities(): Promise<void> {
  try {
    const res = await fetch('/ui-capabilities');
    if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
    const data = (await res.json()) as UiCapabilitiesResponse;
    applyUiCapabilities(data.canBrowseServerFiles);
  } catch {
    // On any failure, keep upload mode available and hide server browse UI.
    applyUiCapabilities(false);
  }
}

// ── Nav ───────────────────────────────────────────────────────────────────────

function updateNav(resolvedPath: string): void {
  const pathEl = document.getElementById('nav-path');
  const upBtn = document.getElementById('nav-up') as HTMLButtonElement | null;
  if (pathEl) {
    const home = sessionStorage.getItem('fpdf-home');
    pathEl.textContent =
      home && (resolvedPath === home || resolvedPath.startsWith(home + '/'))
        ? '~' + resolvedPath.slice(home.length)
        : resolvedPath;
  }
  if (upBtn) upBtn.disabled = resolvedPath === '/';
}

// ── Browse ────────────────────────────────────────────────────────────────────

async function browse(dirPath: string | null): Promise<void> {
  if (!canBrowseServerFiles) return;
  if (busy) return;
  hideError();

  const url = dirPath === null ? '/browse' : `/browse?path=${encodeURIComponent(dirPath)}`;
  setStatus('Loading…');

  let data: BrowseResponse;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const body = (await res.json()) as { error?: string };
      throw new Error(body.error ?? `HTTP ${String(res.status)}`);
    }
    data = (await res.json()) as BrowseResponse;
  } catch (err) {
    setStatus('');
    showError(err instanceof Error ? err.message : String(err));
    return;
  }

  // Store home directory on the first (null) browse
  if (dirPath === null) {
    sessionStorage.setItem('fpdf-home', data.resolvedPath);
  }

  currentPath = data.resolvedPath;
  setStatus('');
  updateNav(data.resolvedPath);
  renderEntries(data.entries);
}

// ── Entry list ────────────────────────────────────────────────────────────────

function renderEntries(entries: DirectoryEntry[]): void {
  const list = document.getElementById('entry-list');
  if (!list) return;
  list.innerHTML = '';

  if (entries.length === 0) {
    const li = document.createElement('li');
    li.style.padding = '8px 12px';
    li.style.color = 'var(--color-status)';
    li.style.fontSize = '0.88rem';
    li.textContent = 'No PDF files or folders here.';
    list.appendChild(li);
    return;
  }

  for (const entry of entries) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `entry entry--${entry.kind}`;
    btn.textContent = entry.name;

    if (entry.kind === 'dir') {
      btn.addEventListener('click', () => {
        void browse(`${currentPath}/${entry.name}`);
      });
    } else {
      btn.addEventListener('click', () => {
        void openPdf(`${currentPath}/${entry.name}`);
      });
    }

    li.appendChild(btn);
    list.appendChild(li);
  }
}

// ── Open PDF ──────────────────────────────────────────────────────────────────

async function openPdf(filePath: string): Promise<void> {
  if (busy) return;
  busy = true;
  hideError();
  setEntriesDisabled(true);
  setStatus('Analyzing…');

  try {
    const res = await fetch('/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath }),
    });
    if (!res.ok) {
      const body = (await res.json()) as { error?: string };
      throw new Error(body.error ?? `HTTP ${String(res.status)}`);
    }
    // Success: server broadcasts pdfOpened; WS handler navigates to fill UI.
    setStatus('Opening…');
  } catch (err) {
    busy = false;
    setEntriesDisabled(false);
    setStatus('');
    showError(err instanceof Error ? err.message : String(err));
  }
}

// ── Upload ────────────────────────────────────────────────────────────────────

/** Currently-active upload XHR, used to abort on cancel. */
let activeXhr: XMLHttpRequest | null = null;

function pickCompanionJson(candidates: File[], pdfFile: File): File | null {
  const jsonFiles = candidates.filter((f) => f.name.toLowerCase().endsWith('.json'));
  if (jsonFiles.length === 0) return null;
  const pdfStem = pdfFile.name.replace(/\.[^.]+$/, '').toLowerCase();
  const exactFpdf = jsonFiles.find((f) => f.name.toLowerCase() === `${pdfStem}.fpdf.json`);
  if (exactFpdf) return exactFpdf;
  const exactJson = jsonFiles.find((f) => f.name.toLowerCase() === `${pdfStem}.json`);
  if (exactJson) return exactJson;
  if (jsonFiles.length === 1) return jsonFiles[0] ?? null;
  return null;
}

function cancelUpload(): void {
  activeXhr?.abort();
  activeXhr = null;
  resetUploadProgress();

  const confirmEl = document.getElementById('upload-confirm');
  const dropZone = document.getElementById('drop-zone');
  const pdfInput = document.getElementById('pdf-input') as HTMLInputElement | null;

  if (confirmEl) confirmEl.hidden = true;
  if (dropZone) dropZone.hidden = false;
  if (pdfInput) pdfInput.value = '';
}

function uploadWithProgress(formData: FormData): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    activeXhr = xhr;
    xhr.open('POST', '/upload');

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        setUploadProgress(event.loaded, event.total);
      } else {
        setUploadProgress(event.loaded, null);
      }
    });

    xhr.addEventListener('load', () => {
      activeXhr = null;
      if (xhr.status >= 200 && xhr.status < 300) {
        setUploadProgress(1, 1);
        resolve();
        return;
      }

      let message = `HTTP ${String(xhr.status)}`;
      if (xhr.responseText) {
        try {
          const parsed = JSON.parse(xhr.responseText) as unknown;
          if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
            const err = (parsed as { error?: unknown }).error;
            if (typeof err === 'string' && err.length > 0) {
              message = err;
            }
          }
        } catch {
          // ignore parse failures and keep HTTP message
        }
      }
      reject(new Error(message));
    });

    xhr.addEventListener('error', () => {
      activeXhr = null;
      reject(new Error('Network error while uploading'));
    });

    xhr.addEventListener('abort', () => {
      activeXhr = null;
      reject(new Error('Upload cancelled'));
    });

    xhr.send(formData);
  });
}

async function executeUpload(pdfFile: File, jsonFile: File | null): Promise<void> {
  if (busy) return;
  busy = true;
  hideError();

  // Show upload UI: filename + progress bar + cancel button; hide drop zone.
  const pdfNameEl = document.getElementById('upload-confirm-pdf');
  const confirmEl = document.getElementById('upload-confirm');
  const dropZone = document.getElementById('drop-zone');
  if (pdfNameEl) pdfNameEl.textContent = `📄 ${pdfFile.name}`;
  if (confirmEl) confirmEl.hidden = false;
  if (dropZone) dropZone.hidden = true;

  setStatus('Uploading…');
  resetUploadProgress();

  const formData = new FormData();
  formData.append('pdf', pdfFile);
  if (jsonFile) formData.append('json', jsonFile);

  try {
    await uploadWithProgress(formData);
    // Navigate directly after a successful upload — don't rely on the WebSocket
    // broadcast, which requires nginx WS upgrade headers to be active and the
    // connection to be established before the response arrives.
    sessionStorage.setItem('fpdf-upload-session', 'true');
    window.location.replace('/');
  } catch (err) {
    busy = false;
    setStatus('');
    resetUploadProgress();
    if (confirmEl) confirmEl.hidden = true;
    if (dropZone) dropZone.hidden = false;
    // 'Upload cancelled' is user-initiated — don't show an error banner.
    if (err instanceof Error && err.message !== 'Upload cancelled') {
      showError(err.message);
    }
  }
}

function initUpload(): void {
  const uploadBtn = document.getElementById('upload-btn');
  const pdfInput = document.getElementById('pdf-input') as HTMLInputElement | null;
  const cancelBtn = document.getElementById('upload-cancel-btn');
  const dropZone = document.getElementById('drop-zone');

  uploadBtn?.addEventListener('click', () => {
    pdfInput?.click();
  });

  pdfInput?.addEventListener('change', () => {
    const files = Array.from(pdfInput.files ?? []);
    const pdfFile = files.find((f) => f.name.toLowerCase().endsWith('.pdf'));
    if (!pdfFile) {
      showError('Please choose a PDF file.');
      return;
    }
    const jsonFile = pickCompanionJson(files, pdfFile);
    void executeUpload(pdfFile, jsonFile);
  });

  cancelBtn?.addEventListener('click', cancelUpload);

  // Drag-and-drop: support dropping a PDF (+ optional .fpdf.json) onto the zone.
  dropZone?.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone?.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
  });

  dropZone?.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');

    const files = Array.from(e.dataTransfer?.files ?? []);
    const pdfFile = files.find((f) => f.name.toLowerCase().endsWith('.pdf'));
    if (!pdfFile) {
      showError('Please drop a PDF file.');
      return;
    }

    const jsonFile = pickCompanionJson(files, pdfFile);
    void executeUpload(pdfFile, jsonFile);
  });
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

function initWebSocket(): void {
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${wsProtocol}//${location.host}/ws`);
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
    if (m.type === 'pdfOpened') {
      // Persist upload-session flag so app.ts can read it after navigation.
      if (m.uploaded === true) {
        sessionStorage.setItem('fpdf-upload-session', 'true');
      } else {
        sessionStorage.removeItem('fpdf-upload-session');
      }
      // Server transitioned to fill mode; navigate to the fill UI.
      // replace() avoids adding the picker to the browser history.
      window.location.replace('/');
    }
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.getElementById('picker-error-dismiss')?.addEventListener('click', hideError);

document.getElementById('nav-home')?.addEventListener('click', () => {
  if (!canBrowseServerFiles) return;
  const home = sessionStorage.getItem('fpdf-home');
  void browse(home ?? null);
});

document.getElementById('nav-up')?.addEventListener('click', () => {
  if (!canBrowseServerFiles) return;
  if (currentPath && currentPath !== '/') {
    const parent = currentPath.slice(0, currentPath.lastIndexOf('/')) || '/';
    void browse(parent);
  }
});

async function init(): Promise<void> {
  initDarkToggle();
  initWebSocket();
  initUpload();
  await loadUiCapabilities();
  if (canBrowseServerFiles) {
    void browse(null);
  }
}

void init();
