// Общие помощники страниц расширения: хранилище, скачивание, буфер обмена.
const storageWrites = new Map();
const randomId = () => globalThis.crypto?.randomUUID?.() || `r${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
const storageWriterId = randomId();
function ensureRowIds(job) {
  const used = new Set();
  for (const row of job.rows || []) {
    if (!row.__rowId || used.has(row.__rowId)) row.__rowId = randomId();
    used.add(row.__rowId);
  }
  return job;
}
function queuedStorageSet(key, value) {
  // Chrome storage клонирует значение, но несколько быстрых focusout/click
  // могут завершиться в другом порядке. Последовательная очередь сохраняет
  // последнее редактирование и не даёт старому снимку затереть новое.
  let snapshot;
  try { snapshot = structuredClone(value); } catch { snapshot = JSON.parse(JSON.stringify(value)); }
  const previous = storageWrites.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => chrome.storage.local.set({ [key]: snapshot }));
  storageWrites.set(key, next);
  return next;
}
const Store = {
  async job() {
    const stored = (await chrome.storage.local.get('job')).job;
    const raw = stored && typeof stored === 'object' ? stored : {};
    const columns = Array.isArray(raw.columns)
      ? raw.columns.filter(c => c && typeof c === 'object' && c.key).map(c => ({ ...c, type: c.type || 'text', key: String(c.key), label: String(c.label || c.key) }))
      : [];
    const rows = Array.isArray(raw.rows)
      ? raw.rows.map(row => row && typeof row === 'object' && !Array.isArray(row) ? row : {})
      : [];
    return ensureRowIds({ ...raw, columns, rows, pages: Number(raw.pages) || 0 });
  },
  saveJob: job => {
    ensureRowIds(job);
    job.__writerId = storageWriterId;
    return queuedStorageSet('job', job);
  },
  async settings() { const stored = (await chrome.storage.local.get('settings')).settings; const raw = stored && typeof stored === 'object' ? stored : {}; return { markup: 0, round: 1, priceMode: 'min', ...raw }; },
  saveSettings: settings => queuedStorageSet('settings', settings),
  async overrides() { const raw = (await chrome.storage.local.get('overrides')).overrides; return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}; },
  saveOverrides: overrides => queuedStorageSet('overrides', overrides),
};

function download(name, text, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function copyText(text, btn) {
  if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
  else {
    const area = document.createElement('textarea');
    area.value = text; area.style.cssText = 'position:fixed;opacity:0';
    document.body.append(area); area.select();
    try {
      if (!document.execCommand('copy')) throw new Error('Буфер обмена недоступен');
    } finally { area.remove(); }
  }
  if (btn) { const t = btn.textContent; btn.textContent = '✓ Скопировано'; setTimeout(() => (btn.textContent = t), 1600); }
}

const fileStamp = job => {
  let host = 'data';
  try { host = new URL(job.url).hostname.replace(/^www\./, ''); } catch { /* нет url */ }
  return `${host}-${new Date().toISOString().slice(0, 10)}`;
};

const $ = s => document.querySelector(s);
const escHtml = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Общее уведомление для страниц расширения. В таблице контейнер создаётся
// по требованию, а боковая панель использует уже существующий #toast.
function toast(text) {
  let el = document.querySelector('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.append(el);
  }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(el.__toastTimer);
  el.__toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
const plural = (n, one, few, many) => {
  const n10 = n % 10, n100 = n % 100;
  return n10 === 1 && n100 !== 11 ? one : n10 >= 2 && n10 <= 4 && !(n100 >= 12 && n100 <= 14) ? few : many;
};
const goods = n => typeof job !== 'undefined' && job?.contentType && job.contentType !== 'product'
  ? `${n} ${plural(n, 'запись', 'записи', 'записей')}`
  : `${n} ${plural(n, 'товар', 'товара', 'товаров')}`;
