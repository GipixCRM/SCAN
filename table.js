// Таблица собранных данных: предпросмотр для сайта (с правкой названия и категории) и сырые колонки.
let job, settings, overrides, items = [], view = 'gipix';
let selected = new Set(), undoStack = [], imageTarget = null;
let editQueue = Promise.resolve(), editing = false;
const tableRandomId = () => globalThis.crypto?.randomUUID?.() || `r${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
const tablePlural = (n, one, few, many) => {
  if (typeof globalThis.plural === 'function') return globalThis.plural(n, one, few, many);
  const n10 = n % 10, n100 = n % 100;
  return n10 === 1 && n100 !== 11 ? one : n10 >= 2 && n10 <= 4 && !(n100 >= 12 && n100 <= 14) ? few : many;
};
const tableConfirm = message => typeof globalThis.confirm === 'function' ? globalThis.confirm(message) : true;

// Таблица не зависит от общего ui.js: даже при частично обновлённой вкладке
// уведомление создаётся локально и не вызывает внешний toast.
function tableToast(text) {
  let el = document.querySelector('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(el.__tableToastTimer);
  el.__tableToastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
// Совместимость с уже открытыми вкладками и частично обновлёнными ресурсами.
globalThis.tableToast = tableToast;
if (typeof globalThis.toast !== 'function') globalThis.toast = tableToast;
function tableError(error, fallback = 'Операция не выполнена') {
  const message = String(error?.message || error || '').split('\n')[0].slice(0, 100);
  tableToast(`${fallback}: ${message}`);
}
function runEdit(action, fallback) {
  // Ошибка одной операции не должна отравлять очередь: в Chromium/Yandex
  // следующий клик иначе получает уже отклонённый Promise и пишет в консоль
  // «Uncaught (in promise)».
  const task = editQueue.catch(() => {}).then(async () => {
    if (!job || job.__collecting) {
      tableToast('Сначала остановите сбор в боковой панели, затем редактируйте таблицу');
      return;
    }
    const before = snapshot(), history = [...undoStack], selection = new Set(selected);
    editing = true;
    try { await action(); }
    catch (error) {
      Object.assign(job, { rows: before.rows, columns: before.columns, roles: before.roles });
      overrides = before.overrides;
      undoStack = history;
      selected = selection;
      rebuild();
      tableError(error, fallback);
    } finally { editing = false; syncEditUi(); }
  });
  editQueue = task.catch(error => tableError(error, fallback));
  return editQueue;
}

function rowId(row) {
  if (!row) return '';
  row.__rowId ||= tableRandomId();
  return row.__rowId;
}
function rowById(id) { return job?.rows?.find(r => rowId(r) === id) || null; }
function snapshot() {
  const clone = value => JSON.parse(JSON.stringify(value ?? null));
  const source = job || {};
  return { rows: clone(source.rows || []), columns: clone(source.columns || []), roles: clone(source.roles || {}), overrides: clone(overrides || {}) };
}
function restoreSnapshot(prev) {
  job.rows = prev.rows;
  job.columns = prev.columns;
  job.roles = prev.roles;
  overrides = prev.overrides;
}
async function persistJobOrRollback(prev) {
  try { await Store.saveJob(job); }
  catch (error) {
    restoreSnapshot(prev);
    if (undoStack.length) undoStack.pop();
    rebuild();
    throw error;
  }
}
function remember() {
  if (!job) return false;
  undoStack.push(snapshot());
  if (undoStack.length > 10) undoStack.shift();
  return true;
}
function syncEditUi() {
  const n = selected.size;
  const info = $('#selectionInfo');
  if (info) info.textContent = job?.__collecting ? 'Идёт сбор · редактирование после остановки' : n ? `Выбрано исходных строк: ${n}` : 'Выберите строки для действий';
  const deleteSelected = $('#deleteSelected');
  if (deleteSelected) deleteSelected.disabled = !n || !!job?.__collecting;
  const undoButton = $('#undoBtn');
  if (undoButton) undoButton.disabled = !undoStack.length || !!job?.__collecting;
  ['#addColumn', '#dedupeImages', '#dedupeRows', '#removeEmptyColumns'].forEach(s => { const el = $(s); if (el) el.disabled = !!job?.__collecting; });
  const cleanup = $('#cleanupScope');
  if (cleanup) cleanup.disabled = !!job?.__collecting;
  document.querySelectorAll('#grid [contenteditable]').forEach(el => { el.contentEditable = job?.__collecting ? 'false' : 'plaintext-only'; });
  document.querySelectorAll('#grid [data-delete-row], #grid [data-delete-col], #grid input.cat').forEach(el => { el.disabled = !!job?.__collecting; });
  const visible = visibleRows();
  const check = $('#selectVisible');
  if (check) {
    check.checked = !!visible.length && visible.every(r => selected.has(rowId(r)));
    check.indeterminate = visible.some(r => selected.has(rowId(r))) && !check.checked;
  }
  document.querySelectorAll('[data-select-row]').forEach(el => {
    const rows = actionRows(el.dataset.selectRow);
    el.checked = rows.length > 0 && rows.every(row => selected.has(rowId(row)));
    el.indeterminate = rows.some(row => selected.has(rowId(row))) && !el.checked;
  });
}

const rawRowsForItem = item => (item?._rowIndices || []).map(i => job.rows[i]).filter(Boolean);
const rawRowForItem = item => rawRowsForItem(item)[0] || null;
const visibleRows = () => view === 'raw' ? job?.rows || [] : filtered().flatMap(rawRowsForItem);
function actionRows(id) {
  if (view === 'gipix') {
    const item = items.find(it => rowId(rawRowForItem(it)) === id);
    if (item) return rawRowsForItem(item);
  }
  const row = rowById(id);
  return row ? [row] : [];
}

async function saveRawCell(row, key, value) {
  if (!row || !key || row[key] === value) return;
  const prev = snapshot();
  remember();
  row[key] = value;
  await persistJobOrRollback(prev);
  // Не заменяем DOM на focusout: иначе клик по соседней кнопке теряется.
  items = GIPIX.buildItems(job.columns, job.rows, settings, overrides, job.roles);
  fillCategoryFilter();
  fillStatusFilter();
  fillRoles();
  tableToast('Ячейка сохранена');
}

async function deleteRows(rows, ask = true) {
  const list = [...new Set(rows.filter(Boolean))];
  if (!list.length) return;
  if (ask && !tableConfirm(`Удалить ${list.length} ${tablePlural(list.length, 'строку', 'строки', 'строк')}?`)) return;
  const prev = snapshot();
  remember();
  const gone = new Set(list);
  job.rows = job.rows.filter(r => !gone.has(r));
  list.forEach(r => selected.delete(rowId(r)));
  await persistJobOrRollback(prev);
  rebuild();
  tableToast(`Удалено строк: ${list.length}`);
}

async function deleteColumn(key) {
  const col = job.columns.find(c => c.key === key);
  if (!col || !tableConfirm(`Удалить колонку «${col.label}»? Данные в ней будут удалены из всех строк.`)) return;
  const prev = snapshot();
  remember();
  job.columns = job.columns.filter(c => c.key !== key);
  job.rows.forEach(row => { delete row[key]; });
  job.roles = Object.fromEntries(Object.entries(job.roles || {}).filter(([, v]) => v !== key));
  await persistJobOrRollback(prev);
  rebuild();
  tableToast(`Колонка «${col.label}» удалена`);
}

async function renameColumn(key, label) {
  const col = job.columns.find(c => c.key === key);
  label = String(label || '').replace(/\s+/g, ' ').trim();
  if (!col || !label || col.label === label) return;
  const prev = snapshot();
  remember();
  col.label = label;
  await persistJobOrRollback(prev);
  rebuild();
  tableToast('Название колонки сохранено');
}

async function undo() {
  const current = snapshot();
  const prev = undoStack.pop();
  if (!prev) return;
  restoreSnapshot(prev);
  selected.clear();
  try { await Promise.all([Store.saveJob(job), Store.saveOverrides(overrides)]); }
  catch (error) {
    restoreSnapshot(current);
    undoStack.push(prev);
    rebuild();
    throw error;
  }
  rebuild();
  tableToast('Последнее действие отменено');
}

function openImage(url, row, key = '') {
  imageTarget = { url, rowIds: actionRows(rowId(row)).map(rowId), key };
  $('#imagePreview').src = url;
  $('#imageLink').href = url;
  $('#imageModal').classList.remove('hidden');
}
function closeImage() {
  imageTarget = null;
  $('#imageModal').classList.add('hidden');
  $('#imagePreview').removeAttribute('src');
}
async function removeImage() {
  if (!imageTarget) return;
  const rows = imageTarget.rowIds.map(rowById).filter(Boolean);
  if (!rows.length || !tableConfirm('Удалить это фото из записи?')) return;
  // В нормализованном виде колонка неизвестна, поэтому удаляем URL из всей
  // строки. В сыром виде действие ограничено конкретной ячейкой, чтобы не
  // затронуть такой же URL в другой колонке.
  const columns = imageTarget.key ? job.columns.filter(c => c.key === imageTarget.key) : job.columns;
  const changes = [];
  for (const row of rows) for (const c of columns) {
    const value = String(row[c.key] ?? '');
    // Удаляем только совпавшую ссылку, сохраняя текст и другие URL дословно.
    let found = false;
    const left = value.replace(URL_TOKEN_RE, token => {
      if (imageIdentity(token) !== imageIdentity(imageTarget.url)) return token;
      found = true;
      return '';
    }).trim();
    if (found) changes.push([row, c.key, left]);
  }
  if (!changes.length) { tableToast('Фото уже удалено'); return; }
  const prev = snapshot();
  remember();
  changes.forEach(([row, key, left]) => { if (left) row[key] = left; else delete row[key]; });
  await persistJobOrRollback(prev);
  closeImage();
  rebuild();
  tableToast('Фото удалено');
}

const URL_TOKEN_RE = /https?:\/\/[^\s<>"',;]+/gi;
const cleanUrlToken = value => String(value || '').replace(/[),.;]+$/, '');
const imageUrlTokens = value => (String(value || '').match(URL_TOKEN_RE) || []).map(cleanUrlToken);
const imageColumn = col => col?.type === 'img' || col?.key?.startsWith('card:img') || /(?:фото|изобр|image|picture|img)/i.test(`${col?.label || ''} ${col?.key || ''}`);
const imageIdentity = value => {
  try {
    const u = new URL(cleanUrlToken(value));
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    return u.href;
  } catch { return cleanUrlToken(value); }
};
const cleanImageCell = value => String(value || '')
  .replace(/[ \t]{2,}/g, ' ')
  .replace(/\s*[,;|]\s*(?=[,;|]|$)/g, '')
  .trim();

/**
 * Удаляет только второе и последующие вхождения одного и того же URL.
 * Повторы считаются внутри исходной строки, а не всей таблицы: одинаковый
 * URL в двух товарах не является дублем. В каждой строке остаётся первое
 * вхождение каждого URL, уникальные фото не меняются.
 */
async function dedupeImages() {
  const rows = cleanupRows();
  const changes = [];
  let duplicateCount = 0;
  // Повторы считаются внутри записи, а не по всей таблице. Один и тот же
  // URL может законно использоваться в разных товарах (например, общий
  // логотип или фото упаковки), поэтому глобальный Set здесь разрушителен.
  for (const row of rows) {
    const seen = new Set();
    for (const col of job.columns) {
      const value = String(row[col.key] ?? '');
      if (!value) continue;
      if (!imageColumn(col)) continue;
      let changed = false;
      const next = cleanImageCell(value.replace(URL_TOKEN_RE, token => {
        const normalized = cleanUrlToken(token);
        const identity = imageIdentity(normalized);
        if (seen.has(identity)) {
          duplicateCount++;
          changed = true;
          return '';
        }
        seen.add(identity);
        return token;
      }));
      if (changed) changes.push([row, col.key, next]);
    }
  }
  if (!duplicateCount || !changes.length) { tableToast('Повторов фото не найдено'); return; }
  if (!tableConfirm(`Удалить ${duplicateCount} повтор${tablePlural(duplicateCount, 'ное фото', 'ных фото', 'ных фото')} внутри строк?`)) return;
  const prev = snapshot();
  remember();
  changes.forEach(([row, key, value]) => { if (value) row[key] = value; else delete row[key]; });
  await persistJobOrRollback(prev);
  rebuild();
  tableToast(`Удалено повторов фото: ${duplicateCount}`);
}

async function removeEmptyColumns() {
  const empty = job.columns.filter(col => !job.rows.some(row => String(row[col.key] || '').trim()));
  if (!empty.length) { tableToast('Пустых колонок не найдено'); return; }
  if (!tableConfirm(`Удалить ${empty.length} полностью пуст${tablePlural(empty.length, 'ую колонку', 'ые колонки', 'ых колонок')}?`)) return;
  const prev = snapshot();
  remember();
  const keys = new Set(empty.map(c => c.key));
  job.columns = job.columns.filter(c => !keys.has(c.key));
  job.roles = Object.fromEntries(Object.entries(job.roles || {}).filter(([, v]) => !keys.has(v)));
  await persistJobOrRollback(prev);
  rebuild();
  tableToast(`Удалено пустых колонок: ${empty.length}`);
}

function closeColumnModal() {
  $('#columnModal').classList.add('hidden');
}

async function addColumn() {
  const label = $('#newColumnName').value.replace(/\s+/g, ' ').trim();
  const type = $('#newColumnType').value || 'text';
  const role = $('#newColumnRole').value || '';
  if (!label) { $('#newColumnName').focus(); tableToast('Введите название колонки'); return; }
  if (job.columns.some(c => c.label.toLowerCase() === label.toLowerCase())) { tableToast('Такая колонка уже есть'); return; }
  const slug = label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_|_$/g, '').slice(0, 36) || 'column';
  const key = `custom:${slug}:${Date.now().toString(36)}`;
  const prev = snapshot();
  remember();
  job.columns.push({ key, label, type: role === 'link' ? 'link' : type, ...(role && role !== '-' ? { role } : {}) });
  job.rows.forEach(row => { row[key] = ''; });
  if (role && role !== '-') job.roles = { ...(job.roles || {}), [role]: key };
  await persistJobOrRollback(prev);
  closeColumnModal();
  rebuild();
  view = 'raw';
  $('#tabGipix').classList.remove('on');
  $('#tabRaw').classList.add('on');
  $('#gipixBar').classList.add('hidden');
  $('#rolesBar').classList.add('hidden');
  $('#rawBar').classList.remove('hidden');
  render();
  tableToast(`Колонка «${label}» добавлена`);
}

async function load() {
  [job, settings, overrides] = await Promise.all([Store.job(), Store.settings(), Store.overrides()]);
  job.__collecting = job.progress?.status === 'running';
  const present = new Set(job.rows.map(rowId));
  selected = new Set([...selected].filter(id => present.has(id)));
  $('#markup').value = settings.markup;
  $('#round').value = String(settings.round);
  try { $('#source').textContent = `${new URL(job.url).hostname} · ${job.pages} стр.`; } catch { $('#source').textContent = ''; }
  rebuild();
}

function rebuild() {
  if (!job || !globalThis.GIPIX?.buildItems) return;
  items = GIPIX.buildItems(job.columns, job.rows, settings, overrides, job.roles);
  fillCategoryFilter();
  fillStatusFilter();
  fillRoles();
  render();
}

function fillStatusFilter() {
  const sel = $('#fStatus');
  if (!sel) return;
  const generic = items.some(it => it._contentType && it._contentType !== 'product');
  const cur = sel.value || 'all';
  sel.innerHTML = generic
    ? '<option value="all">Все записи</option><option value="ready">С готовым заголовком</option><option value="draft">Без заголовка</option>'
    : '<option value="all">Все статусы</option><option value="ready">На витрину</option><option value="draft">Черновики</option><option value="low">Проверить категорию</option><option value="nocode">Без кода детали</option>';
  sel.value = [...sel.options].some(o => o.value === cur) ? cur : 'all';
}

function fillCategoryFilter() {
  const sel = $('#fCat');
  if (!sel) return;
  const cur = sel.value || 'all';
  const counts = {};
  items.forEach(it => (counts[it.category] = (counts[it.category] || 0) + 1));
  sel.innerHTML = `<option value="all">Все категории (${items.length})</option>` + Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([slug, n]) => `<option value="${slug}">${escHtml(globalThis.GIPIX?.CATEGORY?.[slug]?.label || slug)} (${n})</option>`).join('');
  sel.value = counts[cur] || cur === 'all' ? cur : 'all';
}

// Ручная настройка: какая колонка сайта — название, бренд, код детали, цена, ссылка
function fillRoles() {
  const bar = $('#rolesBar');
  const api = globalThis.GIPIX;
  if (!bar || !job || !api?.ROLE_NAMES) return;
  const auto = items.roles || {};
  const sample = key => { const r = job.rows.find(r => r[key]); return r ? String(r[key]).slice(0, 28) : ''; };
  const opts = (role, type) => job.columns.filter(c => (role === 'link' ? c.type === 'link' : c.type === 'text') && !c.role)
    .map(c => `<option value="${escHtml(c.key)}">${escHtml(c.label)} — «${escHtml(sample(c.key))}»</option>`).join('');
  const label = key => job.columns.find(c => c.key === key)?.label || 'не найдено';
  bar.innerHTML = '<span class="muted">Колонки:</span>' + Object.entries(api.ROLE_NAMES).map(([role, name]) => `
    <label class="row" style="gap:4px"><span class="muted">${name}</span>
      <select data-role="${role}">
        <option value="">авто: ${escHtml(label((job.roles || {})[role] ? '' : auto[role]))}</option>
        <option value="-">— нет —</option>${opts(role)}
      </select></label>`).join('');
  bar.querySelectorAll('select').forEach(sel => { sel.value = (job.roles || {})[sel.dataset.role] || ''; });
}

function filtered() {
  const cat = $('#fCat')?.value || 'all', st = $('#fStatus')?.value || 'all', q = $('#fText')?.value.trim().toLowerCase() || '';
  return items.filter(it => (cat === 'all' || it.category === cat)
    && (st === 'all' || (st === 'ready' && it.published) || (st === 'draft' && !it.published)
      || (st === 'low' && it.category_confidence !== 'high') || (st === 'nocode' && !it._article))
    && (!q || it.title.toLowerCase().includes(q) || it.brand.toLowerCase().includes(q) || it._article.toLowerCase().includes(q)));
}

function render() {
  const main = document.querySelector('main');
  if (!main || !job) return;
  const scroll = main.scrollTop;
  if (view === 'gipix') renderGipix(); else renderRaw();
  const generic = items.some(it => it._contentType && it._contentType !== 'product');
  $('#rolesBar').classList.toggle('hidden', view !== 'gipix' || generic);
  $('#tablePricing').classList.toggle('hidden', generic || view !== 'gipix');
  main.scrollTop = scroll;
  syncEditUi();
}

function imageTiles(images, row, key = '') {
  return (images || []).map(url => `<button type="button" class="image-tile" data-image-url="${escHtml(url)}" data-image-row="${escHtml(rowId(row))}" data-image-key="${escHtml(key)}" title="Открыть фото"><img src="${escHtml(url)}" loading="lazy" referrerpolicy="no-referrer" alt=""><span>↗</span></button>`).join('');
}

function rowTools(row) {
  const id = rowId(row);
  return `<td class="row-tools"><button type="button" class="icon danger" data-delete-row="${escHtml(id)}" title="Удалить строку">🗑</button></td>`;
}

function renderGipix() {
  const list = filtered();
  if (list.some(it => it._contentType && it._contentType !== 'product')) return renderContent(list);
  const ready = list.filter(i => i.published).length;
  $('#count').textContent = `${list.length} товаров · на витрину ${ready} · с кодом ${list.filter(i => i._article).length}`;
  $('#grid').innerHTML = `<thead><tr><th class="select-col"><input type="checkbox" id="selectVisible" title="Выбрать видимые строки"></th><th>#</th><th>Фото</th><th>Название</th><th>Бренд</th><th>Код детали</th><th>Цена</th><th>Категория</th><th>Статус</th><th></th></tr></thead><tbody>` +
    list.map((it, i) => { const row = rawRowForItem(it); const id = rowId(row); return `<tr data-key="${escHtml(it.key)}" data-row-id="${escHtml(id)}">
      <td class="select-col"><input type="checkbox" data-select-row="${escHtml(id)}" title="Выбрать строку"></td><td class="muted">${i + 1}</td>
      <td><div class="imgs">${imageTiles(it.images.slice(0, 3), row)}</div></td>
      <td class="title" data-field="title" contenteditable="plaintext-only" spellcheck="false">${escHtml(it.title)}</td>
      <td data-field="brand" contenteditable="plaintext-only" spellcheck="false">${escHtml(it.brand)}</td>
      <td class="code" data-field="article" contenteditable="plaintext-only" spellcheck="false">${escHtml(it._article)}</td>
      <td class="num">${it.price ? it.price.toLocaleString('ru') + ' ₽' : '<span class="muted">—</span>'}
        ${it._supplier_price && it._supplier_price !== it.price ? `<div class="muted small">закуп ${it._supplier_price.toLocaleString('ru')}</div>` : ''}</td>
      <td><input class="cat ${it.category_confidence === 'high' ? '' : 'low'}" list="cats" value="${escHtml(GIPIX.CATEGORY[it.category].label)}"></td>
      <td>${it.published ? '<span class="badge ok">витрина</span>' : `<span class="badge draft" title="${!it.price ? 'нет цены' : 'нет фото'}">черновик</span>`}</td>
      ${rowTools(row)}
    </tr>`; }).join('') + '</tbody>';
}

function renderContent(list) {
  const labels = { product: 'Товар', video: 'Видео', article: 'Статья', image: 'Изображение', audio: 'Аудио', event: 'Событие', profile: 'Профиль', generic: 'Контент' };
  $('#count').textContent = `${list.length} записей · готово к экспорту ${list.filter(i => i.published).length}`;
  $('#grid').innerHTML = `<thead><tr><th class="select-col"><input type="checkbox" id="selectVisible" title="Выбрать видимые строки"></th><th>#</th><th>Тип</th><th>Медиа</th><th>Заголовок</th><th>Автор</th><th>Дата</th><th>Длительность</th><th>Источник</th><th></th></tr></thead><tbody>` +
    list.map((it, i) => { const row = rawRowForItem(it); const id = rowId(row); return `<tr data-key="${escHtml(it.key)}" data-row-id="${escHtml(id)}">
      <td class="select-col"><input type="checkbox" data-select-row="${escHtml(id)}" title="Выбрать строку"></td><td class="muted">${i + 1}</td><td><span class="chip ok">${escHtml(labels[it._contentType] || 'Контент')}</span></td>
      <td><div class="imgs">${imageTiles((it.images || []).slice(0, 2), row)}${it.media_urls?.length ? `<button type="button" class="media-link" data-open-url="${escHtml(it.media_urls[0])}" title="Открыть медиа">▶</button>` : ''}</div></td>
      <td class="title" data-field="title" contenteditable="plaintext-only" spellcheck="false">${escHtml(it.title)}</td>
      <td data-field="author" contenteditable="plaintext-only" spellcheck="false">${escHtml(it.author || '')}</td>
      <td>${escHtml(it.published_at || '')}</td><td>${escHtml(it.duration || '')}</td>
      <td>${it.source_url ? `<a class="ell" href="${escHtml(it.source_url)}" target="_blank">открыть</a>` : '<span class="muted">—</span>'}</td>
      ${rowTools(row)}
    </tr>`; }).join('') + '</tbody>';
}

function renderRaw() {
  const cols = job.columns;
  $('#rawCount').textContent = `${job.rows.length} строк · ${cols.length} колонок`;
  const cell = (c, v, row) => {
    const id = rowId(row);
    if (c.type === 'img') return `<td><div class="imgs">${imageTiles(imageUrlTokens(v), row, c.key) || '<span class="muted">—</span>'}</div></td>`;
    const display = v ?? '';
    return `<td><span class="raw-edit ell" contenteditable="plaintext-only" spellcheck="false" data-raw-key="${escHtml(c.key)}" data-raw-row="${escHtml(id)}" title="Изменить значение">${escHtml(display)}</span></td>`;
  };
  $('#grid').innerHTML = `<thead><tr><th class="select-col"><input type="checkbox" id="selectVisible" title="Выбрать все строки"></th><th>#</th>${cols.map(c => `<th><span class="col-label" contenteditable="plaintext-only" spellcheck="false" data-col-label="${escHtml(c.key)}" title="Переименовать колонку">${escHtml(c.label)}</span><button type="button" class="col-delete" data-delete-col="${escHtml(c.key)}" title="Удалить колонку">×</button></th>`).join('')}<th></th></tr></thead><tbody>` +
    job.rows.map((r, i) => `<tr data-row-id="${escHtml(rowId(r))}"><td class="select-col"><input type="checkbox" data-select-row="${escHtml(rowId(r))}" title="Выбрать строку"></td><td class="muted">${i + 1}</td>${cols.map(c => cell(c, r[c.key], r)).join('')}${rowTools(r)}</tr>`).join('') + '</tbody>';
}

async function setOverride(key, patch) {
  const prev = snapshot();
  remember();
  overrides[key] = { ...(overrides[key] || {}), ...patch };
  try { await Store.saveOverrides(overrides); }
  catch (error) {
    restoreSnapshot(prev);
    undoStack.pop();
    rebuild();
    throw error;
  }
  items = GIPIX.buildItems(job.columns, job.rows, settings, overrides, job.roles);
  fillCategoryFilter();
  fillStatusFilter();
  fillRoles();
}

function cleanupRows() {
  const scope = $('#cleanupScope')?.value || 'all';
  if (scope === 'selected') return job.rows.filter(row => selected.has(rowId(row)));
  if (scope === 'visible') return visibleRows();
  return job.rows;
}

async function dedupeRows() {
  const seen = new Set(), duplicates = [];
  for (const row of cleanupRows()) {
    const key = JSON.stringify(job.columns.map(col => String(row[col.key] ?? '').trim()));
    if (seen.has(key)) duplicates.push(row);
    else seen.add(key);
  }
  if (!duplicates.length) { tableToast('Одинаковых строк не найдено'); return; }
  if (!tableConfirm(`Удалить ${duplicates.length} одинаковых строк? Первая строка каждой группы останется.`)) return;
  await deleteRows(duplicates, false);
}

function bind() {
  if ($('#help')) $('#help').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('help.html') });
  $('#cats').innerHTML = Object.values(GIPIX.CATEGORY).map(c => `<option value="${escHtml(c.label)}">`).join('');
  $('#grid').addEventListener('click', e => {
    if (job.__collecting) return;
    const image = e.target.closest('[data-image-url]');
    if (image) {
      e.preventDefault();
      openImage(image.dataset.imageUrl, rowById(image.dataset.imageRow), image.dataset.imageKey);
      return;
    }
    const open = e.target.closest('[data-open-url]');
    if (open) { e.preventDefault(); void chrome.tabs.create({ url: open.dataset.openUrl }).catch(e => tableError(e, 'Не удалось открыть ссылку')); return; }
    const del = e.target.closest('[data-delete-row]');
    if (del) { void deleteRows(actionRows(del.dataset.deleteRow)).catch(e => tableError(e, 'Строка не удалена')); return; }
    const col = e.target.closest('[data-delete-col]');
    if (col) { void deleteColumn(col.dataset.deleteCol).catch(e => tableError(e, 'Колонка не удалена')); }
  });
  $('#grid').addEventListener('change', e => {
    if (job.__collecting && !e.target.matches('#selectVisible, [data-select-row]')) return;
    if (e.target.matches('[data-select-row]')) {
      actionRows(e.target.dataset.selectRow).forEach(row => e.target.checked ? selected.add(rowId(row)) : selected.delete(rowId(row)));
      syncEditUi();
      return;
    }
    if (e.target.matches('#selectVisible')) {
      const visible = visibleRows();
      visible.forEach(row => e.target.checked ? selected.add(rowId(row)) : selected.delete(rowId(row)));
      syncEditUi();
      return;
    }
    if (!e.target.matches('input.cat')) return;
    const slug = GIPIX.BY_LABEL[e.target.value.trim().toLowerCase()];
    if (!slug) return e.target.classList.add('bad');
      void runEdit(() => setOverride(e.target.closest('tr').dataset.key, { category: slug }), 'Категория не сохранена');
  });
  // правка названия, бренда и кода детали прямо в таблице
  $('#grid').addEventListener('focusout', e => {
    if (job.__collecting) return;
    const rawKey = e.target.dataset?.rawKey;
    const colLabel = e.target.dataset?.colLabel;
    if (colLabel) {
      void runEdit(() => renameColumn(colLabel, e.target.textContent), 'Название колонки не сохранено');
      return;
    }
    if (rawKey) {
      const rawRowId = e.target.dataset.rawRow;
      const value = e.target.textContent.replace(/\s+/g, ' ').trim();
      void runEdit(() => saveRawCell(rowById(rawRowId), rawKey, value), 'Ячейка не сохранена');
      return;
    }
    const field = e.target.dataset?.field;
    if (!field) return;
    const key = e.target.closest('tr').dataset.key;
    const it = items.find(i => i.key === key);
    const value = e.target.textContent.replace(/\s+/g, ' ').trim();
    const old = { title: it?.title, brand: it?.brand, article: it?._article, author: it?.author }[field];
    if (value !== old && (value || field !== 'title')) void runEdit(() => setOverride(key, { [field]: value, ...(field !== 'title' ? { title: undefined } : {}) }), 'Изменение не сохранено');
  });
  $('#grid').addEventListener('keydown', e => {
    if ((e.target.dataset?.field || e.target.dataset?.rawKey || e.target.dataset?.colLabel) && e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
  });

  $('#deleteSelected').onclick = () => void runEdit(() => deleteRows([...selected].map(rowById)), 'Строки не удалены');
  $('#undoBtn').onclick = () => void runEdit(undo, 'Отмена не выполнена');
  $('#closeImage').onclick = closeImage;
  $('#imageModal').addEventListener('click', e => { if (e.target.id === 'imageModal') closeImage(); });
  $('#removeImage').onclick = () => void runEdit(removeImage, 'Фото не удалено');
  $('#imageLink').onclick = () => closeImage();
  $('#addColumn').onclick = () => {
    $('#newColumnName').value = '';
    $('#newColumnType').value = 'text';
    $('#newColumnRole').value = '-';
    $('#columnModal').classList.remove('hidden');
    $('#newColumnName').focus();
  };
  $('#cancelColumn').onclick = closeColumnModal;
  $('#cancelColumn2').onclick = closeColumnModal;
  $('#saveColumn').onclick = () => void runEdit(addColumn, 'Колонка не добавлена');
  $('#columnModal').addEventListener('click', e => { if (e.target.id === 'columnModal') closeColumnModal(); });

  ['#fCat', '#fStatus'].forEach(s => ($(s).onchange = render));
  $('#rolesBar').addEventListener('change', e => {
    const role = e.target.dataset.role;
    if (!role) return;
    void runEdit(async () => {
      remember();
      job.roles = { ...(job.roles || {}), [role]: e.target.value };
      await Store.saveJob(job);
      rebuild();
    }, 'Роль колонки не сохранена');
  });
  $('#fText').oninput = render;
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#fText').focus(); $('#fText').select(); }
    if (e.key === 'Escape' && document.activeElement === $('#fText') && $('#fText').value) { $('#fText').value = ''; render(); }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); tableToast('Все изменения сохраняются автоматически'); }
    if (e.key === 'Escape' && !$('#imageModal').classList.contains('hidden')) closeImage();
    if (e.key === 'Escape' && !$('#columnModal').classList.contains('hidden')) closeColumnModal();
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !$('#columnModal').classList.contains('hidden')) void runEdit(addColumn, 'Колонка не добавлена');
  });
  const saveSettings = async () => {
    settings = { ...settings, markup: +$('#markup').value || 0, round: +$('#round').value };
    await Store.saveSettings(settings);
    rebuild();
  };
  $('#markup').onchange = () => void saveSettings().catch(e => tableError(e, 'Настройки не сохранены'));
  $('#round').onchange = () => void saveSettings().catch(e => tableError(e, 'Настройки не сохранены'));

  $('#copyTsv').onclick = e => void copyText(GIPIX.toTSV(filtered()), e.currentTarget).catch(error => tableError(error, 'Не удалось скопировать данные'));
  $('#dlTsv').onclick = () => download(`gipix-${fileStamp(job)}.tsv`, GIPIX.toTSV(filtered()), 'text/tab-separated-values');
  $('#dlJson').onclick = () => download(`gipix-${fileStamp(job)}.json`, GIPIX.toJSON(filtered(), job.url), 'application/json');
  $('#dlCsv').onclick = () => download(`raw-${fileStamp(job)}.csv`, GIPIX.toCSV(job.columns, job.rows), 'text/csv');

  const tab = v => {
    view = v;
    $('#tabGipix').classList.toggle('on', v === 'gipix');
    $('#tabRaw').classList.toggle('on', v === 'raw');
    $('#gipixBar').classList.toggle('hidden', v !== 'gipix');
    $('#rolesBar').classList.toggle('hidden', v !== 'gipix');
    $('#rawBar').classList.toggle('hidden', v !== 'raw');
    render();
  };
  $('#tabGipix').onclick = () => tab('gipix');
  $('#tabRaw').onclick = () => tab('raw');
  $('#dedupeImages').onclick = () => void runEdit(dedupeImages, 'Дубликаты не удалены');
  if ($('#dedupeRows')) $('#dedupeRows').onclick = () => void runEdit(dedupeRows, 'Одинаковые строки не удалены');
  $('#removeEmptyColumns').onclick = () => void runEdit(removeEmptyColumns, 'Пустые колонки не удалены');

  // Пока идёт сбор, таблица обновляется сама
  let t = 0;
  chrome.storage.onChanged.addListener((ch, area) => {
    const ownWriter = typeof storageWriterId === 'string' ? storageWriterId : '';
    if ((area && area !== 'local') || (ownWriter && ch.job?.newValue?.__writerId === ownWriter)) return;
    if (ch.job) {
      clearTimeout(t);
      t = setTimeout(() => void load().catch(e => tableError(e, 'Таблица не обновилась')), editing ? 1500 : 700);
    }
  });
}

bind();
void load().catch(e => tableError(e, 'Таблица не загрузилась'));
