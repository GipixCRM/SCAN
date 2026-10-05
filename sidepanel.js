// Боковая панель: выбор списка, бережный обход страниц, глубокий сбор контента, экспорт.
// Цикл сбора живёт здесь, пока панель открыта. После каждой страницы сохраняется контрольная точка (job.progress),
// поэтому при потере связи, закрытии вкладки или панели сбор продолжается с той же страницы.

// Темп «как у человека»: случайные паузы и перерывы. Медленнее — меньше капч.
const SPEEDS = {
  careful: {
    label: '🐢 Бережно', note: 'Страницы раз в 4–8 с, карточки по одной раз в 3–6 с, перерывы. Для сайтов с капчей.',
    pageDelay: [4000, 8000], cardDelay: [3000, 6000], threads: 1, breakEvery: 25, breakFor: [30000, 60000], pageBreakEvery: 8,
  },
  normal: {
    label: '🚶 Обычно', note: 'Страницы раз в 2–4 с, карточки по одной раз в 1,5–3 с, перерыв каждые 40.',
    pageDelay: [2000, 4000], cardDelay: [1500, 3000], threads: 1, breakEvery: 40, breakFor: [15000, 30000], pageBreakEvery: 15,
  },
  fast: {
    label: '🚀 Быстро', note: 'Почти без пауз, 2 потока. Только для сайтов без защиты — может вызвать капчу.',
    pageDelay: [700, 1400], cardDelay: [300, 800], threads: 2, breakEvery: 0, breakFor: [0, 0], pageBreakEvery: 0,
  },
};
const MODES = {
  one: { label: 'Эта страница', note: 'Соберу только открытую страницу.' },
  pages: { label: 'Все страницы', note: 'Буду нажимать «Далее», пока страницы не закончатся.' },
  infinite: { label: 'Лента', note: 'Буду прокручивать вниз, пока подгружаются элементы.' },
};
const RETRY_WAITS = [5000, 15000, 45000];  // повторы при потере связи со страницей

let job = null;
let prefs = { mode: 'pages', speed: 'normal', scroll: true, deep: false, maxPages: 100, speedByHost: {} };
let tick = 0;
let runAbort = null;
// Tab that is currently being used for visual list/button selection. Messages
// from unrelated pages must never be allowed to change the active job.
let pickerTabId = null;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = ([a, b]) => a + Math.random() * (b - a);
const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const short = s => String(s || '').split('\n')[0].slice(0, 80);
const fmtTime = ms => { const s = Math.round(ms / 1000); return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

// ── Регулятор: пауза / стоп / замедление ──────────────────────────────────
const ctl = {
  state: 'idle',   // idle | running | paused | blocked | stopping
  slow: 1,         // растёт после каждой капчи
  t0: 0,
  get busy() { return this.state !== 'idle'; },
  async gate() {
    while (this.state === 'paused' || this.state === 'blocked') await sleep(300);
    return this.state === 'running';
  },
  async wait(ms) {
    const end = Date.now() + ms * this.slow;
    while (Date.now() < end) {
      if (!(await this.gate())) return false;
      await sleep(Math.min(250, Math.max(0, end - Date.now())));
    }
    return this.state === 'running';
  },
};
const speed = () => SPEEDS[prefs.speed] || SPEEDS.normal;

// ── Связь со страницей ─────────────────────────────────────────────────────
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
async function send(tabId, msg) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  return chrome.tabs.sendMessage(tabId, msg);
}
async function cancelPageWork() {
  const tabId = job?.tabId;
  if (tabId === undefined || tabId === null) return;
  // Если «Стоп» нажали в момент навигации, content.js мог ещё не успеть
  // загрузиться. Сначала гарантируем его наличие, затем отправляем отмену.
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }); } catch { /* вкладка закрывается */ }
  try { await chrome.tabs.sendMessage(tabId, { type: 'cancel' }); } catch { /* страница уже ушла */ }
}

// Открываем одну и ту же страницу таблицы: повторное нажатие не плодит вкладки.
async function openTablePage() {
  const url = chrome.runtime.getURL('table.html');
  const version = chrome.runtime.getManifest().version;
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find(t => t.url === url);
  if (existing?.id) {
    // Уже открытая вкладка могла остаться от предыдущей версии расширения.
    // Обновляем её только при смене версии, чтобы не сбрасывать текущий ввод.
    if (!String(existing.title || '').includes(`v${version}`)) await chrome.tabs.reload(existing.id);
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) {
      try {
        const focus = chrome.windows?.update?.(existing.windowId, { focused: true });
        focus?.catch?.(() => {});
      } catch { /* окно могло закрыться одновременно */ }
    }
    return existing;
  }
  return chrome.tabs.create({ url, active: true });
}
function waitTabComplete(tabId, timeout = 30000, { checkCurrent = true } = {}) {
  return new Promise(resolve => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      chrome.tabs.onUpdated.removeListener(fn);
      clearTimeout(timer);
      clearInterval(cancelPoll);
      resolve();
    };
    const fn = (id, info) => {
      if (id !== tabId) return;
      if (info.status === 'complete') done();
    };
    const timer = setTimeout(done, timeout);
    const cancelPoll = setInterval(() => { if (ctl.state === 'stopping') done(); }, 100);
    chrome.tabs.onUpdated.addListener(fn);
    // Navigation can complete between tabs.update/reload and listener setup
    // (especially on cached pages). Check the current state as a fallback.
    if (checkCurrent) {
      // Give a just-started navigation a chance to publish its `loading`
      // event before accepting a cached `complete` status from the old page.
      setTimeout(() => {
        if (finished) return;
        chrome.tabs.get(tabId).then(tab => {
          if (tab?.status === 'complete') done();
        }).catch(() => done());
      }, 120);
    }
  });
}
const getTab = () => chrome.tabs.get(job.tabId).catch(() => null);

/** открыть адрес во вкладке сбора; если её закрыли — открыть новую */
async function openUrl(url) {
  const tab = await getTab();
  if (!tab) {
    const t = await chrome.tabs.create({ url, active: true });
    job.tabId = t.id;
    await saveJob();
    log('Вкладка с каталогом была закрыта — открыл заново.');
  } else if (tab.url === url) {
    // Register the listener before reload: fast/cached navigations may emit
    // the complete event before a listener added after reload can observe it.
    const ready = waitTabComplete(job.tabId, 45000, { checkCurrent: false });
    await chrome.tabs.reload(job.tabId);
    await ready;
    return ctl.state === 'running' && (await ctl.wait(1000));
  } else {
    const ready = waitTabComplete(job.tabId, 45000, { checkCurrent: false });
    await chrome.tabs.update(job.tabId, { url });
    await ready;
  }
  await waitTabComplete(job.tabId, 45000);
  if (ctl.state === 'stopping') return false;
  await ctl.wait(1000);
  return ctl.state === 'running';
}

const badge = (text, color = '#FFB800') => {
  try { chrome.action?.setBadgeText?.({ text })?.catch?.(() => {}); } catch { /* API отсутствует в старом Chromium */ }
  if (text) try { chrome.action?.setBadgeBackgroundColor?.({ color })?.catch?.(() => {}); } catch { /* API отсутствует */ }
};

// ── Вывод ──────────────────────────────────────────────────────────────────
function phase(text, pct) {
  $('#phase').textContent = text;
  $('#phase').classList.toggle('muted', !ctl.busy);
  if (pct !== undefined) $('#bar').style.width = Math.max(0, Math.min(100, pct)) + '%';
}
function log(text) {
  const d = document.createElement('div');
  d.textContent = `${new Date().toLocaleTimeString().slice(0, 5)} ${text}`;
  $('#log').prepend(d);
}
let toastTimer = 0;
function toast(text) {
  $('#toast').textContent = text;
  $('#toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 2600);
}
function reportError(error, fallback = 'Операция не выполнена') {
  const message = short(error?.message || error);
  log(`${fallback}: ${message}`);
  toast(`${fallback}: ${message}`);
}
function counters(extra = {}) {
  $('#cRows').textContent = job?.rows?.length || 0;
  $('#cPages').textContent = job?.progress?.page || job?.pages || 0;
  $('#cCards').textContent = job?.rows?.filter(r => r.__card === 1).length || 0;
  $('#cDeepLabel').textContent = job?.contentType && job.contentType !== 'product' ? 'глубоких записей' : 'глубоких карточек';
  if (extra.eta !== undefined) $('#eta').textContent = extra.eta;
}

// Страница 0 — это только созданный чекпоинт. Пока pageUrls пуст, первая
// страница не была успешно сохранена и продолжать «после страницы 0» нельзя.
const hasListCheckpoint = P => !!(P?.phase === 'list' && (P.page || 0) > 0 && (P.pageUrls?.length || 0));

// Можно ли продолжить прерванный сбор и с чего
function resumeInfo() {
  const P = job?.progress;
  if (!job?.cfg || !P || P.status !== 'interrupted') return null;
  if (P.phase === 'list' && hasListCheckpoint(P)) {
    const infinite = P.mode === 'infinite';
    const issue = P.error ? `<br><span class="muted">${escHtml(P.error)}</span>` : '';
    return { text: `⏸ ${infinite ? 'Сбор ленты прерван' : `Сбор прерван после <b>страницы ${P.page}</b>`}${P.at ? ` · ${new Date(P.at).toLocaleString('ru').slice(0, 17)}` : ''}.<br><span class="muted">Всё собранное сохранено — продолжу с того же места.</span>${issue}`, button: infinite ? '▶ Продолжить сбор ленты' : `▶ Продолжить со страницы ${P.page + 1}` };
  }
  const left = job.rows.filter(r => !r.__card).length;
  if (P.phase === 'deep' && left) return { text: `⏸ Страницы собраны не все: осталось <b>${goods(left)}</b>.`, button: `▶ Дособрать ${left}` };
  return null;
}

function setSteps() {
  const has = !!job?.cfg, rows = job?.rows?.length || 0;
  const set = (id, cls) => { $(id).classList.remove('active', 'done'); if (cls) $(id).classList.add(cls); };
  set('#s1', has ? 'done' : 'active');
  set('#s2', has ? 'done' : '');
  set('#s3', has && (ctl.busy || !rows || resumeInfo()) ? 'active' : rows ? 'done' : '');
  set('#s4', rows && !ctl.busy ? 'active' : '');
  const ri = !ctl.busy && resumeInfo();
  $('#resumeBox').classList.toggle('hidden', !ri);
  if (ri) { $('#resumeText').innerHTML = ri.text; $('#resume').textContent = ri.button; }
  $('#ctlIdle').classList.toggle('hidden', ctl.busy || !!ri);
  $('#run').disabled = !has;
  $('#run').textContent = rows ? '▶ Собрать ещё раз' : '▶ Начать сбор';

  // Состояние секции используется только для визуального индикатора сканирования.
  // Прогресс и управление сбором по-прежнему живут в ctl/job.
  const scanState = ctl.state !== 'idle'
    ? ctl.state
    : job?.progress?.phase === 'done' && rows ? 'done' : 'idle';
  const scan = $('#s3');
  scan.dataset.scanState = scanState;
  scan.setAttribute('aria-busy', scanState === 'running' ? 'true' : 'false');
}

function setRunUi() {
  const busy = ctl.busy;
  $('#ctlRun').classList.toggle('hidden', !busy);
  $('#s3').dataset.scanState = busy ? ctl.state : job?.progress?.phase === 'done' ? 'done' : 'idle';
  $('#scanVisual').className = `scan-visual ${busy ? ctl.state : 'idle'}`;
  $('#pause').textContent = ctl.state === 'paused' ? '▶ Продолжить' : '⏸ Пауза';
  ['#pick', '#deepBtn', '#clear', '#pickNext'].forEach(s => ($(s).disabled = busy));
  document.querySelectorAll('#settingsBody button, #settingsBody input').forEach(el => { el.disabled = busy; });
  $('#s3chip').innerHTML = { running: '<span class="chip warn pulse">идёт</span>', paused: '<span class="chip">пауза</span>',
    blocked: '<span class="chip bad">ожидание</span>', stopping: '<span class="chip">останавливаю</span>' }[ctl.state] || '';
  setSteps();
}

// ── Настройки ──────────────────────────────────────────────────────────────
async function loadPrefs() {
  const saved = (await chrome.storage.local.get('prefs')).prefs || {};
  const next = { ...prefs, ...saved };
  if (!MODES[next.mode]) next.mode = 'pages';
  if (!SPEEDS[next.speed]) next.speed = 'normal';
  const maxPages = Number(next.maxPages);
  next.maxPages = Number.isFinite(maxPages) ? Math.max(1, Math.min(10000, Math.floor(maxPages))) : 100;
  next.scroll = next.scroll !== false;
  next.deep = next.deep === true;
  next.speedByHost = next.speedByHost && typeof next.speedByHost === 'object'
    ? Object.fromEntries(Object.entries(next.speedByHost).filter(([host, value]) => typeof host === 'string' && SPEEDS[value]))
    : {};
  prefs = next;
}
const savePrefs = () => Promise.resolve().then(() => chrome.storage.local.set({ prefs })).catch(e => reportError(e, 'Настройки не сохранены'));

function renderSettings() {
  const h = hostOf(job?.url);
  if (h && prefs.speedByHost?.[h]) prefs.speed = prefs.speedByHost[h];
  document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === prefs.mode));
  document.querySelectorAll('#speedSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === prefs.speed));
  $('#modeNote').textContent = MODES[prefs.mode].note;
  $('#speedNote').textContent = speed().note;
  $('#pagesOpts').classList.toggle('hidden', prefs.mode !== 'pages');
  $('#maxPages').value = prefs.maxPages;
  $('#scroll').checked = prefs.scroll;
  $('#deep').checked = prefs.deep;
  $('#nextLabel').textContent = job?.next ? `«${job.next.nextText || 'выбрана'}»` : 'найдётся сама';
  $('#settingsSummary').textContent = [
    MODES[prefs.mode].label + (prefs.mode === 'pages' ? ` (до ${prefs.maxPages})` : ''),
    speed().label,
    prefs.deep ? '🔎 страницы' : '',
  ].filter(Boolean).join(' · ');
}

// ── Ожидание: капча, блокировка карточек, потеря связи ────────────────────
// probe() — проверка «можно продолжать»; вызывается сама каждые every мс и по кнопке «Повторить сейчас»
let blocker = null;
function blocked({ kind, url, reason, page, probe, every = 30000 }) {
  if (blocker) return blocker.promise;
  ctl.state = 'blocked';
  if (kind !== 'net') {
    ctl.slow = Math.min(ctl.slow * 1.5, 4);
    if (prefs.speed !== 'careful') {
      prefs.speed = 'careful';
      prefs.speedByHost = { ...(prefs.speedByHost || {}), [hostOf(job.url)]: 'careful' };
      savePrefs();
      renderSettings();
      log('Сайт показал проверку — скорость снижена до «Бережно».');
    }
  }
  let resolve;
  const promise = new Promise(r => (resolve = r));
  blocker = { promise, resolve, kind, probe };
  const texts = {
    page: `<b>Сайт попросил подтвердить, что вы не робот.</b><br>Сбор на паузе. Перейдите на вкладку сайта и пройдите проверку —
       я продолжу сам, как только список элементов снова появится.`,
    card: `<b>Сайт начал ограничивать открытие карточек</b> (${escHtml(reason || 'проверка')}).<br>Откройте карточку, пройдите проверку
       в браузере и нажмите «Продолжить». Темп снижен.`,
    net: `<b>Нет связи с сайтом</b>${page ? ` (страница ${page})` : ''}${reason ? ` — ${escHtml(short(reason))}` : ''}.<br>
       Всё собранное сохранено. Проверяю связь каждые ${Math.round(every / 1000)} с и продолжу с того же места сам.`,
  };
  const buttons = {
    page: '<button id="bGo" class="primary">Перейти к вкладке</button><button id="bGoOn">Продолжить</button>',
    card: '<button id="bGo" class="primary">Открыть карточку</button><button id="bGoOn">Продолжить</button><button id="bSkip">Пропустить</button>',
    net: '<button id="bNow" class="primary">↻ Повторить сейчас</button>',
  };
  const b = $('#captcha');
  b.innerHTML = `${texts[kind]}<div class="row">${buttons[kind]}<button id="bStop" class="danger">Стоп</button></div>`;
  b.classList.remove('hidden');
  $('#bGo') && ($('#bGo').onclick = () => {
    const action = kind === 'page'
      ? chrome.tabs.update(job.tabId, { active: true }).then(t => chrome.windows.update(t.windowId, { focused: true }))
      : chrome.tabs.create({ url, active: true });
    void action.catch(e => reportError(e, 'Не удалось открыть вкладку'));
  });
  $('#bGoOn') && ($('#bGoOn').onclick = () => unblock('retry'));
  $('#bSkip') && ($('#bSkip').onclick = () => unblock('skip'));
  $('#bNow') && ($('#bNow').onclick = () => void (async () => {
    phase('Проверяю связь…');
    if (!(await tryProbe(blocker))) { toast('Сайт пока недоступен'); phase('Жду связь с сайтом…'); }
  })().catch(e => reportError(e, 'Проверка связи не выполнена')));
  $('#bStop').onclick = () => unblock(false);
  badge('!', '#EF4444');
  log({ page: 'Проверка «я не робот» на странице — жду.', card: `Карточки: ${reason} — жду.`, net: `Связь с сайтом потеряна${page ? ` на странице ${page}` : ''} — жду.` }[kind]);
  phase(kind === 'net' ? 'Жду связь с сайтом…' : 'Жду, пока вы пройдёте проверку на сайте…');
  setRunUi();
  if (probe) void pollProbe(blocker, every).catch(e => reportError(e, 'Автопроверка связи остановлена'));
  return promise;
}
async function tryProbe(b) {
  if (!b || blocker !== b || b.busy) return false;
  b.busy = true;
  try {
    if (await b.probe()) { log(b.kind === 'net' ? 'Связь восстановлена — продолжаю.' : 'Проверка пройдена — продолжаю.'); unblock('retry'); return true; }
  } catch { /* ещё не готово */ } finally { b.busy = false; }
  return false;
}
async function pollProbe(b, every) {
  while (blocker === b) {
    await sleep(every);
    await tryProbe(b);
  }
}
function unblock(result) {
  if (!blocker) return;
  const b = blocker;
  blocker = null;
  $('#captcha').classList.add('hidden');
  if (ctl.state === 'blocked') ctl.state = result === false ? 'stopping' : 'running';
  badge(ctl.state === 'running' ? String(job.rows.length) : '');
  setRunUi();
  if (result === 'skip') log('Карточка пропущена.');
  b.resolve(result);
}
window.addEventListener('online', () => { if (blocker?.kind === 'net') void tryProbe(blocker).catch(e => reportError(e, 'Проверка связи не выполнена')); });

// ── Выбор списка / кнопки «Далее» ──────────────────────────────────────────
async function startPick(mode) {
  const tab = await activeTab();
  if (!tab?.id || /^(chrome|edge|about|chrome-extension):/.test(tab.url || '')) {
    toast('Откройте страницу сайта со списком контента');
    return;
  }
  try {
    if (pickerTabId !== null && pickerTabId !== tab.id) {
      try { await send(pickerTabId, { type: 'cancelPick' }); } catch { /* прежняя вкладка могла закрыться */ }
    }
    pickerTabId = tab.id;
    await send(tab.id, { type: 'pick', mode });
  } catch (e) {
    pickerTabId = null;
    toast('Не удалось подключиться к странице');
    log('Ошибка подключения: ' + short(e.message));
    return;
  }
  if (mode === 'list') $('#pickHint').classList.remove('hidden');
  toast(mode === 'list' ? 'Наведите курсор на элемент на странице' : 'Наведите курсор на кнопку «Следующая страница»');
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!sender.tab) return;
  const pickerMessage = msg.type === 'picked' || msg.type === 'pickCancelled';
  if (pickerMessage ? sender.tab.id !== pickerTabId : sender.tab.id !== job?.tabId) return;
  if (msg.type === 'picked' && msg.mode === 'list') {
    pickerTabId = null;
    void onPickedList(sender.tab, msg).catch(e => reportError(e, 'Список не сохранён'));
  }
  if (msg.type === 'picked' && msg.mode === 'next') {
    pickerTabId = null;
    job.next = msg.next;
    void saveJob().catch(e => reportError(e, 'Кнопка не сохранена'));
    renderSettings();
    toast('Кнопка «Далее» запомнена');
  }
  if (msg.type === 'pickCancelled') { pickerTabId = null; $('#pickHint').classList.add('hidden'); }
  if (msg.type === 'pageProgress' && ctl.state === 'running') {
    const page = (job.progress?.page || 0) + 1;
    phase(msg.loading ? `Прокручиваю ленту: ${goods(msg.done)}…` : `Страница ${page}: элемент ${msg.done} из ${msg.total}`,
      msg.total ? (msg.done / msg.total) * 100 : undefined);
  }
});

async function onPickedList(tab, msg) {
  const sameSite = hostOf(job?.url) === hostOf(tab.url);
  job = { ...(sameSite ? job : { columns: [], rows: [], pages: 0 }), next: null, tabId: tab.id, url: tab.url, cfg: msg.cfg, count: msg.count, progress: null,
    contentType: msg.preview?.contentType || msg.contentType || 'generic', contentTypes: msg.preview?.contentTypes || {} };
  $('#pickHint').classList.add('hidden');
  showPicked(msg.count);
  renderPreview(msg.preview);
  renderSettings();
  phase('Список выбран — можно начинать.', 0);
  toast(`Найдено ${goods(msg.count)} на странице`);
  await saveJob();
  setSteps();
}

function showPicked(count) {
  $('#picked').classList.remove('hidden');
  $('#pickedCount').textContent = count ? `✓ ${goods(count)} на странице` : '✓ Список выбран';
  const labels = { product: 'товары', video: 'видео', article: 'статьи', image: 'изображения', audio: 'аудио', event: 'события', profile: 'профили', generic: 'контент' };
  $('#s1chip').innerHTML = `<span class="chip">${escHtml(hostOf(job.url))}</span>${job.contentType ? ` <span class="chip ok">${labels[job.contentType] || 'контент'}</span>` : ''}`;
  $('#pick').textContent = '↺ Другой список';
  $('#pick').classList.remove('primary');
}

function renderPreview({ columns, rows }) {
  const sampleType = rows?.[0]?.__contentType || 'product';
  if (sampleType !== 'product') {
    const labels = { video: 'Видео', article: 'Статья', audio: 'Аудио', image: 'Изображение', event: 'Событие', profile: 'Профиль', generic: 'Контент' };
    const text = row => { const c = columns.find(c => c.type === 'text' && row[c.key]); return c ? row[c.key] : columns.map(c => row[c.key]).find(Boolean) || ''; };
    $('#preview').innerHTML = `<div class="hint" style="margin:0 0 6px">Распознано: <b>${labels[sampleType] || 'Контент'}</b>. Поля сохранятся для экспорта: заголовок, текст, автор, дата и медиа.</div>` + rows.slice(0, 3).map(row => {
      const image = columns.find(c => c.type === 'img' && row[c.key])?.key;
      const title = text(row);
      return `<div class="pv">${image ? `<img class="thumb" src="${escHtml(row[image])}" referrerpolicy="no-referrer">` : '<div class="thumb"></div>'}<div class="grow"><div class="t">${escHtml(title || '— заголовок не найден —')}</div><div class="p"><span class="chip ok">${labels[row.__contentType] || 'Контент'}</span></div></div></div>`;
    }).join('');
    return;
  }
  const items = GIPIX.buildItems(columns, rows);
  $('#preview').innerHTML = items.slice(0, 3).map(it => `
    <div class="pv">
      ${it.image_url ? `<img class="thumb" src="${escHtml(it.image_url)}" referrerpolicy="no-referrer">` : '<div class="thumb"></div>'}
      <div class="grow">
        <div class="t">${escHtml(it.title || '— название не найдено —')}</div>
        <div class="p">${it._supplier_price ? it._supplier_price.toLocaleString('ru') + ' ₽' : '<span class="muted">цена не найдена</span>'}
          ${it._article ? `<span class="chip ok">код ${escHtml(it._article)}</span>` : '<span class="chip warn">без кода</span>'}</div>
      </div>
    </div>`).join('') || '<div class="muted small">Не удалось распознать элементы — выберите заново и попробуйте ↑/↓.</div>';
}

// ── Сбор списка с контрольными точками ────────────────────────────────────
function merge(res) {
  if (res.contentType) job.contentType = res.contentType;
  if (res.contentTypes) {
    job.contentTypes = { ...(job.contentTypes || {}) };
    for (const [k, v] of Object.entries(res.contentTypes)) job.contentTypes[k] = (job.contentTypes[k] || 0) + v;
  }
  const known = new Set(job.columns.map(c => c.key));
  for (const c of res.columns) if (!known.has(c.key)) { job.columns.push(c); known.add(c.key); }
  const seen = new Set(job.rows.map(r => JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('card:') && !['__card', '__rowId'].includes(k))))));
  let added = 0;
  for (const r of res.rows) {
    const k = JSON.stringify(Object.fromEntries(Object.entries(r).filter(([key]) => key !== '__rowId')));
    if (!seen.has(k)) { seen.add(k); job.rows.push(r); added++; }
  }
  return added;
}

const listCfg = () => ({ ...job.cfg, ...(job.next || {}) });
const urlBased = urls => urls.length >= 2 && new Set(urls).size === urls.length;

/** вкладка сбора → страница n (1 = первая). Адресная пагинация — открываем адрес; иначе листаем «Далее» с первой */
async function gotoPage(n) {
  const P = job.progress;
  const urls = [...P.pageUrls, ...(P.pendingUrl ? [P.pendingUrl] : [])];
  // адресная пагинация — открываем ближайшую известную страницу; иначе листаем с первой
  const from = urlBased(urls) ? Math.max(1, Math.min(n, urls.length)) : 1;
  if (!(await openUrl(urls[from - 1] || P.startUrl))) return false;
  for (let i = from; i < n; i++) {
    if (!(await ctl.gate())) return false;
    phase(`Восстанавливаю позицию: листаю до страницы ${n} (${i + 1}/${n})…`);
    let r;
    try { r = await send(job.tabId, { type: 'next', cfg: listCfg() }); } catch { r = { status: 'navigating' }; }
    if (r?.status === 'cancelled' || ctl.state === 'stopping') return false;
    if (r?.status === 'navigating') { await waitTabComplete(job.tabId); if (!(await ctl.wait(800))) return false; }
    else if (r?.status !== 'spa') throw new Error('не удалось пролистать до нужной страницы');
    if (!(await ctl.wait(rand([700, 1400])))) return false;
  }
  return true;
}

/** шаг «Далее»: 'ok' | 'end' | 'stop' */
async function nextStep() {
  phase('Перехожу на следующую страницу…');
  let r;
  try { r = await send(job.tabId, { type: 'next', cfg: listCfg() }); } catch { r = { status: (await getTab()) ? 'navigating' : 'lost' }; }
  if (ctl.state === 'stopping') return 'stop';
  if (r?.status === 'lost') return 'ok';  // вкладку закрыли — следующий шаг сам откроет нужную страницу
  if (r?.status === 'cancelled' || ctl.state === 'stopping') return 'stop';
  if (r?.status === 'navigating') {
    await waitTabComplete(job.tabId);
    if (!(await ctl.wait(800))) return 'stop';
    const t = await getTab();
    if (t?.url && /^https?:/.test(t.url)) { job.progress.pendingUrl = t.url; await saveJob(); }
    return 'ok';
  }
  if (r?.status === 'spa') return ctl.state === 'stopping' ? 'stop' : 'ok';
  if (r?.status === 'none') { log('Кнопки «Далее» больше нет — это была последняя страница.'); return 'end'; }
  let st = {};
  try { st = await send(job.tabId, { type: 'status', cfg: listCfg() }); } catch { /* ignore */ }
  if (st.captcha) return (await blocked({ kind: 'page', url: st.url, probe: pageReady, every: 3000 })) === false ? 'stop' : 'ok';
  if (r?.status === 'stuck') {
    log('Сайт не переключил страницу за 15 секунд. Сбор остановлен, прогресс сохранён.');
    return 'stop';
  }
  log('Нажал «Далее», но список не сменился. Укажите кнопку вручную в настройках.');
  return 'stop';
}

async function pageReady() {
  if (ctl.state === 'stopping') return false;
  if (!(await getTab()) && !(await gotoPage(job.progress.page + 1))) return false;  // вкладку закрыли, пока ждали, — откроем нужную страницу
  if (ctl.state === 'stopping') return false;
  const st = await send(job.tabId, { type: 'status', cfg: listCfg() });
  return st.items > 0 && !st.captcha;
}

/** после перерыва встаём на следующую несобранную страницу: 'ready' | 'end' | 'stop' */
async function resumePosition() {
  const P = job.progress;
  if (P.page === 0) return (await openUrl(P.startUrl)) ? 'ready' : 'stop';
  // вкладка уже на последней собранной странице? (например, нажали «Стоп» и сразу «Продолжить»)
  let st = null;
  try { st = await send(job.tabId, { type: 'status', cfg: listCfg() }); } catch { /* вкладки нет или ошибка сети */ }
  // В бесконечной ленте нет шага «Далее»: после остановки повторяем сбор
  // той же ленты, а не считаем отсутствие пагинации концом работы.
  if ((P.mode || prefs.mode) === 'infinite') {
    if (st?.items && !st.captcha) return 'ready';
    return (await openUrl(P.startUrl)) ? 'ready' : 'stop';
  }
  const toNext = async () => { const step = await nextStep(); return step === 'ok' ? 'ready' : step; };
  if (st?.items && st.sig === P.lastSig) return toNext();
  if (st?.items && P.pendingUrl && st.url === P.pendingUrl) return 'ready';
  if (P.pendingUrl && urlBased([...P.pageUrls, P.pendingUrl])) return (await openUrl(P.pendingUrl)) ? 'ready' : 'stop';
  if (!(await gotoPage(P.page))) return 'stop';
  return toNext();
}

/** сбор одной страницы с повторами при потере связи: результат | {end} | null (стоп) */
async function extractStep(page, opts) {
  for (let attempt = 0; ; attempt++) {
    if (!(await ctl.gate())) return null;
    phase(`Страница ${page}: собираю элементы…`, 0);
    let res = null, err = null;
    try { res = await send(job.tabId, { type: 'extract', cfg: listCfg(), opts }); } catch (e) { err = e; }
    if (res?.error) err = new Error(res.error);
    if (res?.cancelled || ctl.state === 'stopping') return null;
    if (res?.captcha) {
      if ((await blocked({ kind: 'page', url: res.url, probe: pageReady, every: 3000 })) === false) return null;
      attempt = -1;
      continue;
    }
    if (res?.stalled && res.reason) {
      log(res.reason);
      phase(res.reason);
    }
    if (res?.stalled && !res?.rows?.length) return res;
    if (res?.rows?.length) return res;

    const tab = await getTab();
    const lost = !!err || !tab || !navigator.onLine;
    if (!lost && page === 1) return { end: true, reason: 'На странице не найдены элементы — проверьте выбранный список.' };
    if (attempt < RETRY_WAITS.length) {
      const wait = RETRY_WAITS[attempt];
      log(lost ? `Страница ${page}: нет связи${err ? ` (${short(err.message)})` : ''} — повтор через ${wait / 1000} с.` : `Страница ${page} пустая — перезагружу через ${wait / 1000} с.`);
      phase(`Нет связи со страницей ${page} — повтор ${attempt + 1} из ${RETRY_WAITS.length} через ${wait / 1000} с…`);
      if (!(await ctl.wait(wait))) return null;
      try { await gotoPage(page); } catch (e) { log('Не удалось открыть страницу: ' + short(e.message)); }
      continue;
    }
    if (!lost) return { end: true, reason: `Страница ${page} пустая после ${RETRY_WAITS.length} попыток — похоже, каталог закончился.` };
    job.progress.status = 'interrupted';
    job.progress.error = short(err?.message || 'Нет связи со страницей');
    await saveJob();
    const act = await blocked({
      kind: 'net', page, reason: err?.message,
      probe: async () => { if (!navigator.onLine) return false; await gotoPage(page); return pageReady(); },
    });
    if (act === false) return null;
    job.progress.status = 'running';
    job.progress.error = '';
    attempt = -1;
  }
}

/** true — список собран до конца; false — остановлено/прервано */
async function runList(resume) {
  const runMode = resume && job.progress?.mode ? job.progress.mode : prefs.mode;
  const maxPages = runMode === 'pages' ? Math.max(1, prefs.maxPages) : 1;
  const opts = {
    scroll: prefs.scroll,
    infinite: runMode === 'infinite',
    settleMs: prefs.speed === 'careful' ? 1600 : prefs.speed === 'fast' ? 700 : 1100,
  };
  if (resume && job.progress?.phase === 'list') {
    job.progress.status = 'running';
    log(`Продолжаю со страницы ${job.progress.page + 1}.`);
    phase('Восстанавливаю позицию…');
    let pos;
    try { pos = await resumePosition(); } catch (e) { log('Не удалось вернуться к странице: ' + short(e.message)); pos = 'stop'; }
    if (pos !== 'ready') return pos === 'end';
  } else {
    const tab = await getTab();
    if (!tab) { toast('Вкладка с каталогом закрыта — выберите список заново'); return false; }
    job.progress = { phase: 'list', mode: runMode, page: 0, startUrl: tab.url, pageUrls: [], pendingUrl: '', lastSig: '', status: 'running', error: '', at: Date.now() };
  }
  await saveJob();
  const P = job.progress, pageTimes = [];
  for (;;) {
    const page = P.page + 1, t = Date.now();
    const res = await extractStep(page, opts);
    if (!res) return false;
    if (res.end) { log(res.reason); return true; }
    const added = merge(res);
    Object.assign(P, { page, lastSig: res.sig, pendingUrl: '', at: Date.now() });
    P.error = '';
    P.pageUrls.push(res.url);
    job.pages = page;
    await saveJob();  // ← контрольная точка: после сбоя продолжим со страницы page + 1
    pageTimes.push(Date.now() - t);
    counters({ eta: `≈${Math.round(pageTimes.reduce((a, b) => a + b, 0) / pageTimes.length / 1000)} с/стр.` });
    badge(String(job.rows.length));
    log(`Стр. ${page}: ${goods(res.rows.length)}, новых ${added}`);
    if (res.stalled) {
      log('Лента остановлена на доступных элементах. Исправьте препятствие и запустите продолжение.');
      P.error = res.reason || 'Прокрутка ленты остановилась до конца';
      await saveJob();
      return false;
    }
    if (!added && page > 1) { log('Новых элементов нет — страницы закончились.'); return true; }
    if (page >= maxPages) return true;

    const sp = speed();
    const longBreak = sp.pageBreakEvery && page % sp.pageBreakEvery === 0;
    const pause = rand(sp.pageDelay) + (longBreak ? rand(sp.breakFor) : 0);
    phase(longBreak ? `Перерыв ${Math.round(pause * ctl.slow / 1000)} с, чтобы не злить сайт…` : `Пауза ${Math.round(pause * ctl.slow / 1000)} с перед следующей страницей…`);
    if (!(await ctl.wait(pause))) return false;
    const step = await nextStep();
    if (step !== 'ok') return step === 'end';
  }
}

// ── Глубокий сбор: страницы контента ───────────────────────────────────────
async function runDeep() {
  const roles = GIPIX.detectRoles(job.columns, job.rows, job.roles);
  const linkCols = job.columns.filter(c => c.type === 'link').map(c => c.key);
  const linkOf = row => row[roles.link] || linkCols.map(k => row[k]).find(Boolean) || '';
  const todo = job.rows.filter(r => !r.__card).length;
  if (!todo) { log('Все карточки уже собраны.'); return { left: 0 }; }
  log(`Открываю страницы контента: ${todo} шт. (${speed().label})`);
  const t0 = Date.now();
  return Deep.run(job, {
    linkOf, ctl,
    signal: runAbort?.signal,
    speed: new Proxy({}, { get: (_, k) => speed()[k] }),  // скорость может снизиться на ходу после капчи
    save: saveJob,
    onPhase: text => phase(text),
    onBlocked: (url, reason) => blocked({ kind: 'card', url, reason }),
    onOffline: (url, reason) => blocked({
      kind: 'net', url, reason, every: 20000,
      probe: async () => navigator.onLine && (await fetch(url, { credentials: 'include' })).ok,
    }),
    onProgress: (done, total, ok) => {
      const per = (Date.now() - t0) / done;
      phase(`Карточки: ${done} из ${total}, получено ${ok}`, (done / total) * 100);
      counters({ eta: `осталось ≈ ${fmtTime(per * (total - done))}` });
      badge(`${Math.round((done / total) * 100)}%`);
    },
  });
}

/** what: 'new' — с текущей страницы вкладки; 'resume' — с места остановки; 'deep' — только карточки */
async function start(what) {
  if (ctl.busy || !job?.cfg) return;
  ctl.state = 'running';
  ctl.slow = 1;
  runAbort = new AbortController();
  ctl.t0 = Date.now();
  setRunUi();
  clearInterval(tick);
  tick = setInterval(() => ($('#cTime').textContent = fmtTime(Date.now() - ctl.t0)), 1000);
  const phaseNow = job.progress?.phase;
  try {
    try { await send(job.tabId, { type: 'begin' }); } catch { /* вкладка может быть ещё на переходе */ }
    if (what === 'new' || (what === 'resume' && phaseNow === 'list')) {
      const finished = await runList(what === 'resume');
      if (finished) job.progress.phase = prefs.deep ? 'deep' : 'done';
    } else if (what === 'deep') {
      job.progress = { ...(job.progress || { page: job.pages || 0, pageUrls: [], pendingUrl: '' }), phase: 'deep' };
    }
    if (ctl.state === 'running' && job.progress?.phase === 'deep') {
      job.progress.status = 'running';
      const r = await runDeep();
      if (r && !r.left && ctl.state === 'running') job.progress.phase = 'done';
    }
  } catch (e) {
    const message = short(e.message);
    if (job.progress) job.progress.error = message;
    log('Ошибка: ' + message);
  } finally {
    const stopped = ctl.state !== 'running' || job.progress?.phase !== 'done';
    const noCheckpoint = job.progress?.phase === 'list' && !hasListCheckpoint(job.progress);
    if (job.progress) {
      job.progress.status = job.progress.phase === 'done' ? 'done' : noCheckpoint ? 'ready' : 'interrupted';
      if (job.progress.phase === 'done') job.progress.error = '';
      job.progress.at = Date.now();
    }
    ctl.state = 'idle';
    runAbort = null;
    clearInterval(tick);
    await saveJob();
    // Снимаем слой сканирования даже если страница закончилась без extract
    // (например, кнопка «Далее» больше не нашлась или произошла ошибка).
    try { await cancelPageWork(); } catch { /* вкладка могла закрыться */ }
    setRunUi();
    counters({ eta: '' });
    badge('');
    phase(stopped ? (noCheckpoint
      ? `Первая страница не собрана. Проверьте вкладку и попробуйте ещё раз.`
      : `Остановлено. Собрано ${goods(job.rows.length)} — можно продолжить с того же места.`)
      : `Готово: ${goods(job.rows.length)} с ${job.progress?.page || job.pages} стр.`, 100);
    toast(stopped
      ? (noCheckpoint ? 'Первая страница не собрана — попробуйте ещё раз' : 'Сбор остановлен — прогресс сохранён')
      : 'Сбор завершён');
    renderResult();
    if (!stopped && job.rows.length) openTablePage().catch(() => {});
  }
}

// ── Результат и экспорт ────────────────────────────────────────────────────
async function currentItems() {
  return GIPIX.buildItems(job.columns, job.rows, await Store.settings(), await Store.overrides(), job.roles);
}

async function renderResult() {
  counters();
  const items = job?.rows?.length ? await currentItems() : [];
  const ready = items.filter(i => i.published).length;
  const generic = items.some(i => i._contentType && i._contentType !== 'product');
  const kindNames = { product: 'товаров', video: 'видео', article: 'статей', image: 'изображений', audio: 'аудиозаписей', event: 'событий', profile: 'профилей', generic: 'записей' };
  const typeCounts = items.reduce((m, i) => { const k = i._contentType || 'product'; m[k] = (m[k] || 0) + 1; return m; }, {});
  $('#ready').textContent = ready;
  $('#total').textContent = items.length;
  $('#resultReadyLabel').textContent = generic ? 'готовы к экспорту' : 'готовы к витрине';
  $('#resultKind').textContent = generic ? 'записей' : 'товаров';
  $('#pricing').classList.toggle('hidden', generic);
  $('#typeSummary').classList.toggle('hidden', !items.length);
  $('#typeSummary').innerHTML = Object.entries(typeCounts).map(([type, n]) => `<span class="type-pill type-${escHtml(type)}"><i></i>${escHtml(kindNames[type] || 'контента')} <b>${n}</b></span>`).join('');
  const n = f => items.filter(f).length;
  $('#stats').innerHTML = items.length ? (generic ? [
    ['📝 заголовок', n(i => i.title)], ['🔗 источник', n(i => i.source_url)], ['📷 изображения', n(i => i.image_url)], ['▶ медиа', n(i => i.media_urls?.length)],
  ] : [
    ['📷 фото', n(i => i.image_url)], ['₽ цена', n(i => i.price)], ['# код', n(i => i._article)], ['бренд', n(i => i.brand)],
  ]).map(([t, v]) => `<span class="chip ${v === items.length ? 'ok' : v ? 'warn' : 'bad'}">${t} ${v}</span>`).join('') : '';
  setSteps();
}

const saveJob = () => Store.saveJob(job);

async function updateSite() {
  const tab = await activeTab();
  const h = hostOf(tab?.url);
  $('#site').innerHTML = h
    ? `${tab.favIconUrl ? `<img src="${escHtml(tab.favIconUrl)}" alt="">` : ''}<span>${escHtml(h)}</span>`
      + (job?.cfg && hostOf(job.url) !== h ? ' <span class="chip warn">список выбран на другом сайте</span>' : '')
    : '<span>Откройте страницу сайта</span>';
}

async function init() {
  job = await Store.job();
  await loadPrefs();
  // Панель закрыли или браузер упал посреди сбора. Чекпоинт страницы 0
  // ещё не является прогрессом: возвращаем обычную кнопку запуска вместо
  // вводящего в заблуждение сообщения «прервано после страницы 0».
  if (job.progress?.phase === 'list' && !hasListCheckpoint(job.progress)
      && ['running', 'interrupted'].includes(job.progress.status)) {
    job.progress.status = 'ready';
    job.progress.error = job.progress.error || 'Первая страница не была сохранена';
    await saveJob();
    log('Прошлый запуск не успел сохранить первую страницу — можно запустить заново.');
  } else if (job.progress?.status === 'running') {
    job.progress.status = 'interrupted';
    await saveJob();
    log('Прошлый сбор прервался — его можно продолжить с того же места.');
  }
  const s = await Store.settings();
  $('#markup').value = s.markup;
  $('#round').value = String(s.round);
  if (job.cfg) {
    showPicked(job.count);
    phase(job.rows.length ? `Собрано ранее: ${goods(job.rows.length)}.` : 'Список выбран — можно начинать.');
  }
  renderSettings();
  renderResult();
  setRunUi();
  void updateSite().catch(e => reportError(e, 'Сайт не определён'));
  const refreshSite = () => void updateSite().catch(() => {});
  chrome.tabs.onActivated.addListener(refreshSite);
  chrome.tabs.onUpdated.addListener((_, info) => { if (info.status === 'complete' || info.favIconUrl) refreshSite(); });

  $('#pick').onclick = () => void startPick('list').catch(e => reportError(e, 'Не удалось выбрать список'));
  const openHelp = () => chrome.tabs.create({ url: chrome.runtime.getURL('help.html') }).catch(e => reportError(e, 'Инструкция не открыта'));
  $('#help').onclick = openHelp;
  $('#helpIntro').onclick = openHelp;
  $('#flash').onclick = async () => {
    try { const r = await send(job.tabId, { type: 'flash', cfg: job.cfg }); if (!r.count) toast('На открытой странице список не найден'); }
    catch { toast('Вкладка со списком закрыта'); }
  };
  $('#pickNext').onclick = () => void startPick('next').catch(e => reportError(e, 'Не удалось выбрать пагинацию'));
  $('#toggleSettings').onclick = () => {
    const body = $('#settingsBody');
    body.classList.toggle('hidden');
    $('#toggleSettings').textContent = body.classList.contains('hidden') ? 'настроить' : 'свернуть';
  };
  $('#modeSeg').onclick = e => { if (e.target.dataset.v) { prefs.mode = e.target.dataset.v; void savePrefs(); renderSettings(); } };
  $('#speedSeg').onclick = e => {
    if (!e.target.dataset.v) return;
    prefs.speed = e.target.dataset.v;
    const h = hostOf(job?.url);
    if (h) prefs.speedByHost = { ...(prefs.speedByHost || {}), [h]: prefs.speed };
    void savePrefs();
    renderSettings();
  };
  $('#maxPages').onchange = () => {
    const value = Number($('#maxPages').value);
    prefs.maxPages = Number.isFinite(value) ? Math.max(1, Math.min(10000, Math.floor(value))) : 1;
    void savePrefs();
    renderSettings();
  };
  $('#scroll').onchange = () => { prefs.scroll = $('#scroll').checked; void savePrefs(); renderSettings(); };
  $('#deep').onchange = () => { prefs.deep = $('#deep').checked; void savePrefs(); renderSettings(); };

  $('#run').onclick = () => void start('new').catch(e => reportError(e, 'Сбор завершился с ошибкой'));
  $('#resume').onclick = () => void start('resume').catch(e => reportError(e, 'Продолжение не выполнено'));
  $('#restart').onclick = () => { if (confirm('Начать заново с открытой страницы? Уже собранное останется.')) void start('new').catch(e => reportError(e, 'Сбор завершился с ошибкой')); };
  $('#deepBtn').onclick = () => void start('deep').catch(e => reportError(e, 'Глубокий сбор завершился с ошибкой'));
  $('#pause').onclick = () => {
    if (ctl.state === 'running') { ctl.state = 'paused'; phase('Пауза. Нажмите «Продолжить», когда будете готовы.'); }
    else if (ctl.state === 'paused') ctl.state = 'running';
    setRunUi();
  };
  $('#stop').onclick = () => {
    ctl.state = 'stopping';
    runAbort?.abort();
    void cancelPageWork();
    if (blocker) unblock(false);
    phase('Останавливаю…');
    setRunUi();
  };

  const saveSettings = async () => {
    await Store.saveSettings({ ...(await Store.settings()), markup: +$('#markup').value || 0, round: +$('#round').value });
    renderResult();
  };
  $('#markup').onchange = () => void saveSettings().catch(e => reportError(e, 'Настройки не сохранены'));
  $('#round').onchange = () => void saveSettings().catch(e => reportError(e, 'Настройки не сохранены'));
  $('#openTable').onclick = () => openTablePage().catch(() => toast('Не удалось открыть таблицу'));
  $('#copyTsv').onclick = () => void (async () => {
    const items = await currentItems();
    await copyText(GIPIX.toTSV(items));
    toast(`Скопировано: ${goods(items.filter(i => i.published).length)} в формате TSV`);
  })().catch(e => reportError(e, 'Не удалось скопировать данные'));
  $('#dlTsv').onclick = () => void (async () => download(`gipix-${fileStamp(job)}.tsv`, GIPIX.toTSV(await currentItems()), 'text/tab-separated-values'))().catch(e => reportError(e, 'TSV не скачан'));
  $('#dlJson').onclick = () => void (async () => download(`gipix-${fileStamp(job)}.json`, GIPIX.toJSON(await currentItems(), job.url), 'application/json'))().catch(e => reportError(e, 'JSON не скачан'));
  $('#dlCsv').onclick = () => download(`raw-${fileStamp(job)}.csv`, GIPIX.toCSV(job.columns, job.rows), 'text/csv');
  $('#clear').onclick = () => void (async () => {
    if (!confirm('Удалить все собранные данные? Выбранный список и настройки останутся.')) return;
    job = { ...job, columns: [], rows: [], pages: 0, progress: null, contentType: '', contentTypes: {} };
    await saveJob();
    $('#log').replaceChildren();
    renderResult();
    phase('Очищено. Можно собирать заново.', 0);
  })().catch(e => reportError(e, 'Данные не очищены'));
}

void init().catch(e => reportError(e, 'Панель не загрузилась'));
