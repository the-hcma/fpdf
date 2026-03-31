import type { BrowseResponse, DirectoryEntry } from '../types.js';

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

// ── WebSocket ─────────────────────────────────────────────────────────────────

function initWebSocket(): void {
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
    if (m.type === 'pdfOpened') {
      // Server transitioned to fill mode; navigate to the fill UI.
      // replace() avoids adding the picker to the browser history.
      window.location.replace('/');
    }
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.getElementById('picker-error-dismiss')?.addEventListener('click', hideError);

document.getElementById('nav-home')?.addEventListener('click', () => {
  const home = sessionStorage.getItem('fpdf-home');
  void browse(home ?? null);
});

document.getElementById('nav-up')?.addEventListener('click', () => {
  if (currentPath && currentPath !== '/') {
    const parent = currentPath.slice(0, currentPath.lastIndexOf('/')) || '/';
    void browse(parent);
  }
});

initDarkToggle();
initWebSocket();
void browse(null);
