// GIPIX Scraper — выбор списка на странице и извлечение строк. Внедряется из боковой панели.
(() => {
  if (window.__gipixScraper) return;
  window.__gipixScraper = true;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let cancelRequested = false;
  const waitCancelable = async ms => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (cancelRequested) return false;
      await sleep(Math.min(100, end - Date.now()));
    }
    return !cancelRequested;
  };
  const esc = s => CSS.escape(s);
  const BAD_CLASS = /^(active|hover|focus|selected|current|odd|even|first|last|open|show|visible|hidden|is-|js-|ng-|v-|css-|sc-|jsx-)/i;
  const stableClasses = el => [...el.classList].filter(c => !BAD_CLASS.test(c) && !/\d{3,}/.test(c) && c.length < 40).slice(0, 3);
  const signature = el => el.tagName + '.' + stableClasses(el).sort().join('.');
  const itemSelectorOf = el => el.tagName.toLowerCase() + stableClasses(el).map(c => '.' + esc(c)).join('');
  const visible = el => el.getClientRects().length > 0;
  const say = msg => {
    try {
      const result = chrome.runtime.sendMessage(msg);
      result?.catch?.(() => {});
    } catch { /* страница могла закрыться в момент отправки */ }
  };

  function cssPath(el) {
    const parts = [];
    for (; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      if (el.id && !/\d{3,}/.test(el.id) && document.querySelectorAll('#' + esc(el.id)).length === 1) {
        parts.unshift('#' + esc(el.id));
        return parts.join(' > ');
      }
      const same = [...el.parentElement.children].filter(c => c.tagName === el.tagName);
      const tag = el.tagName.toLowerCase();
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(el) + 1})` : tag);
    }
    return ['body', ...parts].join(' > ');
  }

  // ── Поиск списков: предки элемента, у которых ≥3 похожих соседей ───────────
  function candidates(target) {
    const out = [];
    for (let el = target; el && el.parentElement && el !== document.body; el = el.parentElement) {
      const sig = signature(el);
      const items = [...el.parentElement.children].filter(c => signature(c) === sig && visible(c));
      if (items.length < 3) continue;
      const sample = items.slice(0, 10);
      const size = sample.reduce((s, x) => s + x.getElementsByTagName('*').length + 1, 0) / sample.length;
      // больше элементов и «толще» каждый — вероятнее это товары, а не ячейки/иконки
      out.push({ container: el.parentElement, items, score: items.length * Math.log(1 + size) });
    }
    return out;
  }

  function findItems(cfg) {
    const match = el => { try { return el.matches(cfg.itemSel); } catch { return false; } };
    let cont = null;
    try { cont = document.querySelector(cfg.containerSel); } catch { /* сломанный селектор */ }
    let items = cont ? [...cont.children].filter(c => match(c) && visible(c)) : [];
    if (items.length < 2) {
      // шаблон страницы сдвинулся — берём родителя, у которого больше всего подходящих детей
      const byParent = new Map();
      for (const el of document.querySelectorAll(cfg.itemSel)) {
        if (visible(el)) byParent.set(el.parentElement, [...(byParent.get(el.parentElement) || []), el]);
      }
      items = [...byParent.values()].sort((a, b) => b.length - a.length)[0] || [];
    }
    return items;
  }

  // ── Подсветка ──────────────────────────────────────────────────────────────
  let ui = null, pick = null, raf = 0;

  function makeUi() {
    const root = document.createElement('div');
    root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646';
    const box = document.createElement('div');
    box.style.cssText = 'display:none;position:fixed;border:2px solid #FFD600;background:rgba(255,214,0,.08);border-radius:6px;box-shadow:0 0 0 100vmax rgba(0,0,0,.28);transition:all .06s';
    const marks = document.createElement('div');
    const tip = document.createElement('div');
    tip.style.cssText = 'position:fixed;left:50%;top:14px;transform:translateX(-50%);background:#FFD600;color:#111;font:600 13px/1.4 system-ui,-apple-system,sans-serif;padding:9px 16px;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.35);max-width:92vw;text-align:center';
    root.append(box, marks, tip);
    document.documentElement.append(root);
    return { root, box, marks, tip };
  }

  function draw(el, items, text) {
    const r = el.getBoundingClientRect();
    Object.assign(ui.box.style, { display: 'block', left: r.left - 3 + 'px', top: r.top - 3 + 'px', width: r.width + 6 + 'px', height: r.height + 6 + 'px' });
    ui.marks.replaceChildren(...items.slice(0, 120).map(it => {
      const q = it.getBoundingClientRect();
      const d = document.createElement('div');
      d.style.cssText = `position:fixed;left:${q.left}px;top:${q.top}px;width:${q.width}px;height:${q.height}px;outline:1px dashed rgba(255,214,0,.95);outline-offset:-1px`;
      return d;
    }));
    ui.tip.textContent = text;
  }

  function render() {
    raf = 0;
    if (!pick || !pick.target) return;
    if (pick.mode === 'list') {
      const c = pick.cands[pick.idx];
      if (!c) return draw(pick.target, [], 'Наведите курсор на элемент в списке');
      draw(c.container, c.items, `Список: ${c.items.length} элементов — клик, чтобы выбрать · ↑/↓ уровень выше/ниже · Esc — отмена`);
    } else {
      const el = pick.target.closest('a,button,[role=button],input[type=submit],input[type=button]') || pick.target;
      pick.el = el;
      const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 30);
      draw(el, [], `Кнопка «${t || '…'}» — клик, чтобы выбрать как «Следующая страница» · Esc — отмена`);
    }
  }

  function onMove(e) {
    if (!pick || e.target === pick.target) return;
    pick.target = e.target;
    if (pick.mode === 'list') {
      pick.cands = candidates(e.target);
      pick.idx = pick.cands.reduce((best, c, i, a) => (c.score > a[best].score ? i : best), 0);
    }
    raf ||= requestAnimationFrame(render);
  }

  function onKey(e) {
    if (!pick) return;
    if (e.key === 'Escape') { stopPick(); say({ type: 'pickCancelled' }); }
    else if (pick.mode === 'list' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      pick.idx = Math.max(0, Math.min(pick.cands.length - 1, pick.idx + (e.key === 'ArrowUp' ? 1 : -1)));
      render();
    } else return;
    e.preventDefault(); e.stopPropagation();
  }

  function swallow(e) {
    if (!pick) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.type !== 'click') return;
    if (pick.mode === 'list') {
      const c = pick.cands[pick.idx];
      if (!c) return;
      const cfg = { containerSel: cssPath(c.container), itemSel: itemSelectorOf(c.items[0]), url: location.href };
      const preview = extract(c.items.slice(0, 5));
      stopPick();
      say({ type: 'picked', mode: 'list', cfg, count: c.items.length, preview });
    } else {
      const el = pick.el;
      const next = { nextSel: cssPath(el), nextText: (el.innerText || el.value || '').trim().slice(0, 40) };
      stopPick();
      say({ type: 'picked', mode: 'next', next });
    }
  }

  const EVENTS = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu'];
  function startPick(mode) {
    stopPick();
    ui = makeUi();
    pick = { mode, target: null, cands: [], idx: 0 };
    ui.tip.textContent = mode === 'list' ? 'Наведите курсор на элемент в списке' : 'Наведите курсор на кнопку «Следующая страница»';
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseover', onMove, true);
    document.addEventListener('keydown', onKey, true);
    EVENTS.forEach(t => window.addEventListener(t, swallow, true));
  }
  function stopPick() {
    pick = null;
    ui?.root.remove(); ui = null;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseover', onMove, true);
    document.removeEventListener('keydown', onKey, true);
    EVENTS.forEach(t => window.removeEventListener(t, swallow, true));
  }

  // ── Извлечение ─────────────────────────────────────────────────────────────
  const IMG_BAD = /(icon|sprite|logo|badge|express|cart|basket|star|rating|flag|arrow|loader|spinner|placeholder|blank|pixel|no-?photo|noimage|1x1)/i;
  const abs = u => { try { return new URL(u, location.href).href; } catch { return ''; } };

  function bestImg(img) {
    const a = img.closest('a[href]');
    if (a && /\.(jpe?g|png|webp|avif)(\?|$)/i.test(a.href)) return a.href;
    for (const k of ['data-zoom-image', 'data-large', 'data-full', 'data-original', 'data-src', 'data-lazy', 'data-lazy-src']) {
      const v = img.getAttribute(k);
      if (v && !v.startsWith('data:')) return abs(v);
    }
    const ss = img.getAttribute('srcset') || img.getAttribute('data-srcset');
    if (ss) {
      const best = ss.split(',').map(s => s.trim().split(/\s+/)).sort((x, y) => (parseFloat(y[1]) || 1) - (parseFloat(x[1]) || 1))[0];
      if (best?.[0] && !best[0].startsWith('data:')) return abs(best[0]);
    }
    const s = img.currentSrc || img.src;
    return s && !/^(data|blob):/.test(s) ? s : '';
  }
  const isJunkImg = (img, url) => IMG_BAD.test(url) || (img.naturalWidth && img.naturalWidth < 32 && img.naturalHeight < 32);

  const width = cells => cells.reduce((s, c) => s + (c.colSpan || 1), 0);
  const textOf = el => (el.innerText || '').replace(/\s+/g, ' ').trim();

  // Шапка → подписи колонок: в самой таблице, в отдельной «липкой» таблице-шапке или у div-сетки
  function headerLabels(item) {
    if (item.tagName === 'TR') {
      const table = item.closest('table');
      let hr = table?.tHead?.rows[table.tHead.rows.length - 1]
        || (table?.rows[0] !== item && table?.rows[0]?.querySelector('th') ? table.rows[0] : null);
      if (!hr) {
        const w = width([...item.cells]);
        hr = [...document.querySelectorAll('tr')]
          .filter(r => r.querySelector('th') && (r.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING))
          .reverse().find(r => width([...r.cells]) === w) || null;
      }
      if (!hr) return null;
      const labels = [];
      for (const c of hr.cells) for (let i = 0; i < (c.colSpan || 1); i++) labels.push(textOf(c));
      return labels.some(Boolean) ? labels : null;
    }
    const n = item.children.length;
    if (n < 3) return null;
    const looksHeader = h => h && h !== item && h.children.length === n && !h.querySelector('img,a[href],input,button')
      && [...h.children].every(c => textOf(c).length <= 40) && [...h.children].filter(c => textOf(c)).length >= n / 2;
    const before = [...item.parentElement.children];
    let h = before.slice(0, before.indexOf(item)).reverse().find(looksHeader);
    for (let p = item.parentElement.previousElementSibling, k = 0; !h && p && k < 3; p = p.previousElementSibling, k++)
      h = looksHeader(p) ? p : [...p.children].find(looksHeader);
    return h ? [...h.children].map(textOf) : null;
  }

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'TEMPLATE', 'SELECT', 'OPTION', 'TEXTAREA']);
  const TYPE_SUFFIX = { text: '', link: ' · ссылка', img: ' · фото' };

  // Тип контента определяется для каждой карточки отдельно: это позволяет
  // собирать смешанные ленты (например, статьи с видео) и не требовать от
  // пользователя ручного выбора режима до начала сбора.
  const CONTENT_LABELS = {
    product: 'Товары', video: 'Видео', article: 'Статьи', image: 'Изображения',
    audio: 'Аудио', event: 'События', profile: 'Профили', generic: 'Другой контент',
  };
  const VIDEO_HOST = /(youtube\.com|youtu\.be|vimeo\.com|rutube\.ru|vk\.com\/video|tiktok\.com)/i;
  const VIDEO_EXT = /\.(?:mp4|webm|m3u8|mov|avi)(?:[?#]|$)/i;
  const AUDIO_EXT = /\.(?:mp3|m4a|ogg|wav|flac|aac)(?:[?#]|$)/i;
  const ARTICLE_CLASS = /(article|post|story|news|blog|publication|стать|новост|публикац)/i;
  const PRODUCT_CLASS = /(product|товар|catalog|catalogue|price|shop|магазин)/i;
  const EVENT_CLASS = /(event|меропр|событ|конференц|webinar|вебинар)/i;
  const PROFILE_CLASS = /(profile|person|author|user|avatar|автор|профил)/i;

  function detectContentType(item, rec = {}) {
    const markup = `${item.tagName} ${item.id || ''} ${typeof item.className === 'string' ? item.className : ''}`;
    const text = textOf(item);
    const hasVideo = !!item.querySelector('video, [itemprop="video"], iframe[src*="youtube"], iframe[src*="vimeo"], iframe[src*="rutube"]')
      || [...item.querySelectorAll('a[href], source[src], video[src]')].some(e => VIDEO_EXT.test(e.href || e.src || e.getAttribute('src') || '') || VIDEO_HOST.test(e.href || e.src || ''));
    const hasAudio = !!item.querySelector('audio, [itemprop="audio"]')
      || [...item.querySelectorAll('a[href], source[src], audio[src]')].some(e => AUDIO_EXT.test(e.href || e.src || e.getAttribute('src') || ''));
    const hasPrice = /(?:₽|руб\.?|р\.)\s*\d|\d[\d\s]{1,10}(?:₽|руб\.?|р\.)/i.test(text);
    const hasProductLink = [...item.querySelectorAll('a[href]')].some(a => /\/(?:product|products|catalog|parts|goods|tovar|item)(?:\/|$)/i.test(a.getAttribute('href') || ''));
    const jsonType = item.querySelector('[itemtype*="Product"], [itemtype*="VideoObject"], [itemtype*="Article"], [itemtype*="ImageObject"], [itemtype*="AudioObject"]')?.getAttribute('itemtype') || '';
    if (hasVideo || /VideoObject/i.test(jsonType)) return 'video';
    if (hasAudio || /AudioObject/i.test(jsonType)) return 'audio';
    if (!PRODUCT_CLASS.test(markup) && (item.querySelector('article') || ARTICLE_CLASS.test(markup) || text.length > 500 && item.querySelector('h1,h2,h3'))) return 'article';
    if (item.querySelector('[itemprop="price"], [itemtype*="Product"], [itemprop="sku"]') || PRODUCT_CLASS.test(markup) || hasPrice || hasProductLink) return 'product';
    if (EVENT_CLASS.test(markup) || item.querySelector('[itemprop="startDate"], [itemprop="location"]')) return 'event';
    if (PROFILE_CLASS.test(markup) && item.querySelector('img')) return 'profile';
    const imgs = item.querySelectorAll('img').length;
    const imageLinks = [...item.querySelectorAll('a[href]')].every(a => /\.(?:jpe?g|png|webp|gif|avif)(?:[?#]|$)/i.test(a.getAttribute('href') || ''));
    if (imgs && !text && (!item.querySelector('button') && (!item.querySelector('a') || imageLinks))) return 'image';
    return 'generic';
  }

  /** item → {рек: {key: value}, cols: [{key,label,type}]} ; key = «метка|тип|№» — одинаковый у одинаковых мест в разных строках */
  function extractOne(item, labels, cols) {
    const rec = {};
    rec.__contentType = detectContentType(item);
    const put = (label, type, value) => {
      value = String(value || '').replace(/\s+/g, ' ').trim();
      if (!value) return;
      let n = 1, key = `${label}|${type}`;
      while (rec[key] !== undefined) key = `${label}|${type}|${++n}`;
      rec[key] = value;
      if (!cols.has(key)) cols.set(key, { key, label: label + TYPE_SUFFIX[type] + (n > 1 ? ' ' + n : ''), type });
    };
    const cellIndex = new Map();
    if (labels && item.tagName === 'TR') { let i = 0; for (const c of item.cells) { cellIndex.set(c, i); i += c.colSpan || 1; } }
    else if (labels) [...item.children].forEach((c, i) => cellIndex.set(c, i));
    const cellOf = el => {
      if (item.tagName === 'TR') return el.closest('td,th');
      while (el && el.parentElement !== item) el = el.parentElement;
      return el;
    };
    const labelFor = el => {
      if (labels) {
        const i = cellIndex.get(cellOf(el));
        return i === undefined ? 'Строка' : labels[i] || `Колонка ${i + 1}`;
      }
      const ip = el.closest('[itemprop]');
      if (ip && item.contains(ip)) return ip.getAttribute('itemprop');
      for (let e = el; e && e !== item.parentElement; e = e.parentElement) {
        const c = stableClasses(e)[0];
        if (c) return c.replace(/^.*?__/, '').replace(/^(js|b|l|g)-/, '');
      }
      return el.tagName.toLowerCase();
    };

    let textOwner = null;
    const walker = document.createTreeWalker(item, NodeFilter.SHOW_ELEMENT, {
      acceptNode: n => (SKIP_TAGS.has(n.tagName.toUpperCase()) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let el = item; el; el = walker.nextNode()) {
      if (el.tagName === 'IMG') {
        const u = bestImg(el);
        if (u && !isJunkImg(el, u)) put(labelFor(el), 'img', u);
        continue;
      }
      if (el.tagName === 'META' && el.getAttribute('itemprop')) { put(el.getAttribute('itemprop'), 'text', el.content); continue; }
      const bg = el.style?.backgroundImage;
      if (bg && bg.includes('url(')) { const u = abs(bg.match(/url\(["']?([^"')]+)/)?.[1] || ''); if (u && !IMG_BAD.test(u)) put(labelFor(el), 'img', u); }
      if (el.tagName === 'A') {
        const h = el.getAttribute('href') || '';
        if (h && !/^(#|javascript:|mailto:|tel:)/i.test(h)) put(labelFor(el), 'link', el.href);
      }
      if (el.tagName === 'VIDEO' || el.tagName === 'AUDIO' || el.tagName === 'SOURCE' || el.tagName === 'IFRAME') {
        const media = el.currentSrc || el.src || el.getAttribute('src') || el.getAttribute('data-src') || '';
        if (media && !/^(data|blob):/i.test(media)) put(labelFor(el), 'link', abs(media));
        const poster = el.getAttribute('poster');
        if (poster) put(labelFor(el), 'img', abs(poster));
      }
      if (textOwner && textOwner.contains(el)) continue;
      if (el.closest('button')) continue;
      const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
      if (!own) continue;
      textOwner = el;
      let text = el.querySelector('br') ? el.innerText : el.textContent;  // <br> в textContent склеивает слова
      const title = el.getAttribute('title');
      if (title && title.length > text.trim().length && /(\.\.\.|…)\s*$/.test(text)) text = title;
      put(labelFor(el), 'text', text);
    }
    return rec;
  }

  function extract(items) {
    const labels = items[0] ? headerLabels(items[0]) : null;
    const cols = new Map();
    const rows = items.map(it => extractOne(it, labels, cols)).filter(r => Object.keys(r).some(k => !k.startsWith('__')));
    const types = {};
    rows.forEach(r => { const k = r.__contentType || 'generic'; types[k] = (types[k] || 0) + 1; });
    const contentType = Object.entries(types).sort((a, b) => b[1] - a[1])[0]?.[0] || 'generic';
    cols.set('content:type', { key: 'content:type', label: 'Контент: тип', type: 'text', role: 'contentType' });
    rows.forEach(r => { r['content:type'] = r.__contentType || 'generic'; });
    return { columns: [...cols.values()], rows, contentType, contentTypes: types, contentLabels: CONTENT_LABELS };
  }

  // Прокрутка к строке, чтобы подгрузились «ленивые» картинки
  let lazyMisses = 0;
  async function prepare(item, { move = true } = {}) {
    if (move) item.scrollIntoView({ block: 'center' });
    if (lazyMisses >= 6) return true;  // на сайте фото не ленивые или их нет — не тратим время
    const pending = () => [...item.querySelectorAll('img')].some(i => !i.complete || !bestImg(i));
    const end = Date.now() + 800;
    while (pending() && Date.now() < end) {
      if (cancelRequested) return false;
      await sleep(100);
    }
    lazyMisses = pending() ? lazyMisses + 1 : 0;
    return !cancelRequested;
  }

  // «Отпечаток» страницы — по нему после сбоя понимаем, какая страница сейчас открыта
  const sigOf = items => (items[0]?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);

  // ── Капча и блокировки ─────────────────────────────────────────────────────
  const CAPTCHA_RX = /(captcha|recaptcha|hcaptcha|smartcaptcha|turnstile|я не робот|не робот|подтвердите,? что|проверка браузера|checking your browser|just a moment|ddos-guard|access denied|доступ (ограничен|запрещ)|слишком много запросов|too many requests)/i;
  const CAPTCHA_SEL = 'iframe[src*="captcha"], iframe[src*="challenges.cloudflare"], .g-recaptcha, .h-captcha, .smart-captcha, #captcha, #challenge-form, #cf-challenge-running';
  // Текст капчи в подвале встречается на обычных страницах. Во время ленты
  // используем только явный виджет/заголовок, а полный текст проверяем лишь
  // пока список ещё не появился.
  const visibleChallenge = () => [...document.querySelectorAll(CAPTCHA_SEL)].some(visible);
  const captchaOnPage = (allowBodyText = true) => visibleChallenge()
    || CAPTCHA_RX.test(document.title || '')
    || (allowBodyText && CAPTCHA_RX.test((document.body?.innerText || '').slice(0, 4000)));
  const challengeOnPage = () => captchaOnPage(false);

  // ── Индикатор на странице: плашка прогресса и подсветка текущей строки ─────
  let pill = null;
  let pageScan = null;
  const PAGE_SCAN_CSS = `
    .gpx-scan-layer{position:fixed;inset:0;z-index:2147483645;pointer-events:none;overflow:hidden}
    .gpx-scan-layer:before{content:"";position:absolute;inset:0;opacity:.16;background:linear-gradient(rgba(255,214,0,.08) 1px,transparent 1px),linear-gradient(90deg,rgba(255,214,0,.08) 1px,transparent 1px);background-size:64px 64px;mask-image:linear-gradient(180deg,transparent,black 18%,black 82%,transparent);animation:gpxScanGrid 2.3s linear infinite}
    .gpx-scan-sweep{position:absolute;left:0;right:0;top:-3px;height:3px;background:linear-gradient(90deg,transparent 0%,rgba(255,214,0,.2) 20%,#ffd600 50%,rgba(255,214,0,.2) 80%,transparent 100%);box-shadow:0 0 18px 4px rgba(255,214,0,.68);animation:gpxScanSweep 2.3s ease-in-out infinite}
    .gpx-scan-shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(255,214,0,.035),transparent 32%,transparent 68%,rgba(255,214,0,.025));animation:gpxScanShade 2.3s ease-in-out infinite}
    .gpx-scan-card{position:fixed;right:16px;bottom:16px;display:flex;align-items:center;gap:9px;max-width:min(340px,calc(100vw - 32px));padding:10px 14px;border:1px solid rgba(255,214,0,.72);border-radius:13px;background:rgba(17,17,18,.9);color:#fff;font:600 13px/1.3 system-ui,-apple-system,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.28),0 0 20px rgba(255,214,0,.13);backdrop-filter:blur(10px)}
    .gpx-scan-dot{width:8px;height:8px;flex:0 0 auto;border-radius:50%;background:#ffd600;box-shadow:0 0 0 0 rgba(255,214,0,.7);animation:gpxScanPulse 1.35s ease-out infinite}
    .gpx-scan-card b{color:#ffd600;font-weight:700}
    .gpx-scan-target{outline:2px solid #ffd600!important;outline-offset:3px!important;box-shadow:0 0 0 5px rgba(255,214,0,.13),0 0 22px rgba(255,214,0,.26)!important;transition:box-shadow .2s,outline-color .2s}
    .gpx-scan-seen{outline:1px solid rgba(255,214,0,.38)!important;outline-offset:2px!important;box-shadow:0 0 0 3px rgba(255,214,0,.06)!important;transition:outline-color .56s ease,box-shadow .56s ease}
    @keyframes gpxScanSweep{0%,100%{transform:translateY(0);opacity:.55}50%{transform:translateY(calc(100vh - 4px));opacity:1}}
    @keyframes gpxScanShade{0%,100%{opacity:.3}50%{opacity:1}}
    @keyframes gpxScanGrid{0%{transform:translateY(-18px)}100%{transform:translateY(18px)}}
    @keyframes gpxScanPulse{0%{box-shadow:0 0 0 0 rgba(255,214,0,.62)}70%{box-shadow:0 0 0 8px rgba(255,214,0,0)}100%{box-shadow:0 0 0 0 rgba(255,214,0,0)}}
    @media(prefers-reduced-motion:reduce){.gpx-scan-sweep,.gpx-scan-shade,.gpx-scan-dot{animation:none}.gpx-scan-sweep{top:48%;opacity:.8}}
  `;
  function ensurePageScanCss() {
    if (document.getElementById('gpx-scan-css')) return;
    const style = document.createElement('style'); style.id = 'gpx-scan-css'; style.textContent = PAGE_SCAN_CSS;
    (document.head || document.documentElement).append(style);
  }
  function startPageScan(text = 'GIPIX · сканирую страницу') {
    stopPageScan();
    ensurePageScanCss();
    const layer = document.createElement('div'); layer.className = 'gpx-scan-layer'; layer.setAttribute('aria-hidden', 'true');
    const shade = document.createElement('div'); shade.className = 'gpx-scan-shade';
    const sweep = document.createElement('div'); sweep.className = 'gpx-scan-sweep';
    const card = document.createElement('div'); card.className = 'gpx-scan-card';
    const dot = document.createElement('span'); dot.className = 'gpx-scan-dot';
    const label = document.createElement('span'); label.textContent = text;
    card.append(dot, label); layer.append(shade, sweep, card); document.documentElement.append(layer);
    pageScan = { layer, card, label, target: null };
  }
  function setPageScan(text, item = null) {
    if (!pageScan) startPageScan();
    if (text) pageScan.label.textContent = text;
    if (pageScan.target && pageScan.target !== item) {
      pageScan.target.classList.remove('gpx-scan-target');
      pageScan.target.classList.add('gpx-scan-seen');
      const seen = pageScan.target;
      setTimeout(() => seen.classList.remove('gpx-scan-seen'), 560);
    }
    pageScan.target = item || null;
    if (item) {
      item.classList.add('gpx-scan-target');
      // Прокруткой управляет сборщик (prepare/scrollStep). Не двигаем страницу
      // из визуального слоя, иначе луч может конкурировать с виртуализированной
      // лентой и создавать ощущение, что элементы пропускаются.
    }
  }
  function stopPageScan() {
    pageScan?.target?.classList.remove('gpx-scan-target');
    document.querySelectorAll('.gpx-scan-seen').forEach(el => el.classList.remove('gpx-scan-seen'));
    pageScan?.layer?.remove(); pageScan = null;
  }
  function showPill(text) {
    if (pageScan) { pageScan.label.textContent = text; return; }
    if (!pill) {
      pill = document.createElement('div');
      pill.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483646;background:#111;color:#FFD600;font:600 13px/1.3 system-ui,sans-serif;padding:10px 14px;border-radius:12px;border:1px solid #FFD600;box-shadow:0 8px 24px rgba(0,0,0,.4);pointer-events:none';
      document.documentElement.append(pill);
    }
    pill.textContent = text;
  }
  const hidePill = () => { pill?.remove(); pill = null; };

  // ── Прокрутка бесконечных лент ───────────────────────────────────────────
  // У многих лент прокручивается не окно, а вложенный div с overflow:auto.
  // Виртуализированные списки дополнительно удаляют карточки, ушедшие вверх,
  // поэтому строки нужно извлекать в момент появления, а не после прокрутки.
  const scrollable = el => {
    if (!el || el === document.body || el === document.documentElement) return false;
    try {
      const s = getComputedStyle(el);
      return /(auto|scroll|overlay)/i.test(`${s.overflowY} ${s.overflow}`)
        && el.scrollHeight > el.clientHeight + 8;
    } catch { return false; }
  };
  function scrollHost(cfg, items) {
    const first = items[0] || (() => { try { return document.querySelector(cfg.containerSel); } catch { return null; } })();
    for (let el = first?.parentElement || first; el; el = el.parentElement) if (scrollable(el)) return el;
    return document.scrollingElement || document.documentElement;
  }
  const isDocumentScroll = el => el === document.scrollingElement || el === document.documentElement || el === document.body;
  function scrollState(el) {
    if (isDocumentScroll(el)) {
      const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
      return { top: window.scrollY || document.documentElement.scrollTop || 0, height, viewport: window.innerHeight || document.documentElement.clientHeight || 0 };
    }
    return { top: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight };
  }
  function scrollStep(el) {
    const m = scrollState(el);
    const step = Math.max(180, Math.floor(m.viewport * 0.8));
    if (isDocumentScroll(el)) window.scrollBy(0, step);
    else {
      el.scrollTop = Math.min(m.top + step, Math.max(0, m.height - m.viewport));
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
  }
  const itemKey = item => {
    const link = item.querySelector('a[href]')?.href || '';
    const id = item.getAttribute('data-id') || item.getAttribute('data-key') || item.id || '';
    const text = (item.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    // Не включаем весь HTML, потому что lazy-картинка или цена могут измениться
    // уже после первого рендера и ошибочно создать дубликат строки.
    if (id || link) return `${id}|${link}`;
    // Для виртуализированных строк без идентификатора остаётся текст, а HTML
    // используем только когда карточка действительно почти пустая.
    return text || item.outerHTML.slice(0, 1200);
  };
  const hasData = row => Object.keys(row).some(k => !k.startsWith('__'));
  function finishRows(cols, rows, items, extra = {}) {
    const types = {};
    rows.forEach(r => { const k = r.__contentType || 'generic'; types[k] = (types[k] || 0) + 1; });
    const contentType = Object.entries(types).sort((a, b) => b[1] - a[1])[0]?.[0] || 'generic';
    cols.set('content:type', { key: 'content:type', label: 'Контент: тип', type: 'text', role: 'contentType' });
    rows.forEach(r => { r['content:type'] = r.__contentType || 'generic'; });
    return { columns: [...cols.values()], rows, url: location.href, sig: sigOf(items), contentType, contentTypes: types, ...extra };
  }

  function flash(cfg) {
    const items = findItems(cfg);
    if (!items.length) return 0;
    stopPick();
    ui = makeUi();
    draw(items[0].parentElement, items, `Выбранный список: ${items.length} элементов`);
    items[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => { if (!pick) { ui?.root.remove(); ui = null; } }, 2200);
    return items.length;
  }

  async function extractPage(cfg, opts) {
    let items = [];
    const t0 = Date.now();
    while (!(items = findItems(cfg)).length && Date.now() - t0 < 10000) {  // ждём отрисовку списка
      if (Date.now() - t0 > 2000 && captchaOnPage()) return { captcha: true, url: location.href };
      if (!(await waitCancelable(250))) return { cancelled: true, url: location.href };
    }
    if (!items.length) return { columns: [], rows: [], url: location.href, captcha: captchaOnPage(), contentType: 'generic', contentTypes: {} };
    startPageScan(opts.infinite ? 'GIPIX · сканирую ленту' : `GIPIX · сканирую ${items.length} элементов`);
    try {
      if (opts.infinite) {
        const loaded = await loadAll(cfg, opts);
        if (loaded?.captcha) return { captcha: true, url: location.href };
        if (loaded?.cancelled || cancelRequested) return { cancelled: true, url: location.href };
        if (loaded?.rows?.length || loaded?.items?.length || loaded?.stalled) {
          return finishRows(loaded.cols, loaded.rows, loaded.items, { stalled: loaded.stalled, reason: loaded.reason });
        }
        items = loaded?.items || findItems(cfg);
      }
      const labels = items[0] ? headerLabels(items[0]) : null;
      const cols = new Map(), rows = [];
      lazyMisses = 0;
      for (let i = 0; i < items.length; i++) {
        if (cancelRequested) return { cancelled: true, url: location.href };
        const it = items[i], outline = it.style.outline;
        it.style.outline = '2px solid #FFD600';
        setPageScan(`GIPIX · сканирую элемент ${i + 1} из ${items.length}`, it);
        if (opts.scroll && !(await prepare(it))) { it.style.outline = outline; return { cancelled: true, url: location.href }; }
        const r = extractOne(it, labels, cols);
        if (Object.keys(r).some(k => !k.startsWith('__'))) rows.push(r);
        it.style.outline = outline;
        if (cancelRequested) return { cancelled: true, url: location.href };
        if (i % 10 === 0) say({ type: 'pageProgress', done: i, total: items.length });
      }
      return finishRows(cols, rows, items);
    } finally {
      hidePill();
      stopPageScan();
    }
  }

  async function loadAll(cfg, opts = {}) {
    const cols = new Map(), rows = [], seen = new Set(), seenItems = [];
    let host = null, stable = 0, stalled = false, reason = '';
    lazyMisses = 0;
    let i = 0;
    for (; i < 120 && stable < 4; i++) {
      if (cancelRequested) return { cancelled: true, items: seenItems, cols, rows };
      const items = findItems(cfg);
      if (challengeOnPage() || (!items.length && captchaOnPage())) return { captcha: true, items: seenItems, cols, rows };
      host ||= scrollHost(cfg, items);
      let added = 0;
      for (const item of items) {
        const key = itemKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        seenItems.push(item);
        setPageScan(`GIPIX · найдено ${seen.size} элементов`, item);
        // Извлекаем сразу, пока виртуализированный узел ещё подключён к DOM.
        // В режиме «Лента» нельзя ждать финального findItems: старые узлы могут
        // быть переиспользованы для новых карточек.
        if (opts.scroll) await prepare(item, { move: false });
        const r = extractOne(item, headerLabels(item), cols);
        if (hasData(r)) { rows.push(r); added++; }
      }
      const before = scrollState(host);
      setPageScan(`GIPIX · найдено ${seen.size} · прокручиваю страницу`);
      say({ type: 'pageProgress', done: seen.size, total: 0, loading: true });
      scrollStep(host);
      if (!(await waitCancelable(Math.max(500, Number(opts.settleMs) || 1100)))) return { cancelled: true, items: seenItems, cols, rows };
      const after = scrollState(host);
      const atBottom = after.top + after.viewport >= after.height - 8;
      const moved = after.top > before.top + 2 || after.height > before.height + 2;
      stable = !added && !moved && atBottom ? stable + 1 : 0;
      // Если скролл не сдвинулся и это не низ ленты, мешает overlay/модалка
      // или сайт не разрешил прокрутку. Не выдаём это за успешный конец.
      if (!added && !moved && !atBottom) {
        stalled = true;
        reason = 'Прокрутка ленты остановилась до конца — проверьте перекрывающий блок или ограничение сайта.';
        break;
      }
    }
    if (!stalled && i >= 120 && stable < 4) {
      stalled = true;
      reason = 'Лента слишком длинная для одного запуска — продолжите сбор ещё раз.';
    }
    return { items: seenItems, cols, rows, stalled, reason };
  }

  // ── Пагинация ──────────────────────────────────────────────────────────────
  const NEXT_RX = /^(далее|дальше|вперед|вперёд|следующая|следующая страница|показать ещ[её]|next|next page|›|»|>|→|>>)$/i;
  const isDisabled = el => el.disabled || el.getAttribute('aria-disabled') === 'true'
    || /(^|\s)disabled(\s|$)/i.test(el.className) || /(^|\s)disabled(\s|$)/i.test(el.parentElement?.className || '');
  const label = el => (el.innerText || el.value || el.getAttribute('aria-label') || el.title || '').replace(/\s+/g, ' ').trim();

  function findNext(cfg) {
    const clickable = [...document.querySelectorAll('a,button,[role=button],input[type=submit],input[type=button]')].filter(visible);
    if (cfg.nextSel) {
      let el = null;
      try { el = document.querySelector(cfg.nextSel); } catch { /* ignore */ }
      if (el && visible(el) && (!cfg.nextText || label(el) === cfg.nextText)) return el;
      if (cfg.nextText) { el = clickable.find(e => label(e) === cfg.nextText); if (el) return el; }
      return null;  // кнопку выбрали вручную, но её нет — значит страницы кончились; не жмём что попало
    }
    return document.querySelector('a[rel~=next]')
      || clickable.find(e => NEXT_RX.test(label(e)))
      || clickable.find(e => /(^|[\s_-])next([\s_-]|$)|след/i.test((e.getAttribute('aria-label') || '') + ' ' + e.title + ' ' + e.className))
      || (() => {
        const cur = document.querySelector('[aria-current=page], .pagination .active, .pager .active, [class*=paginat] [class*=active], [class*=pager] [class*=current]');
        const n = cur && parseInt(cur.innerText, 10);
        return n ? clickable.find(e => label(e) === String(n + 1)) : null;
      })();
  }

  async function goNext(cfg) {
    const el = findNext(cfg);
    if (!el || isDisabled(el)) return { status: 'none' };
    const first = () => {
      const items = findItems(cfg);
      const text = item => (item?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      return `${items.length}|${text(items[0])}|${text(items[items.length - 1])}|${location.href}`;
    };
    const before = first();
    el.scrollIntoView({ block: 'center' });
    el.click();
    // до 15 с ждём смену содержимого (если страница не перезагрузилась); по часам — в фоновой вкладке таймеры замедляются
    for (const end = Date.now() + 15000; Date.now() < end;) {
      if (!(await waitCancelable(250))) return { status: 'cancelled' };
      const now = first();
      if (now && now !== before) { if (!(await waitCancelable(700))) return { status: 'cancelled' }; return { status: 'spa' }; }
    }
    return { status: 'stuck' };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    switch (msg.type) {
      case 'pick': startPick(msg.mode); reply({ ok: true }); return;
      case 'begin': cancelRequested = false; startPageScan('GIPIX · готовлю страницу…'); reply({ ok: true }); return;
      case 'cancelPick': stopPick(); reply({ ok: true }); return;
      case 'cancel': cancelRequested = true; hidePill(); stopPageScan(); reply({ ok: true }); return;
      case 'count': reply({ count: findItems(msg.cfg).length }); return;
      case 'extract': extractPage(msg.cfg, msg.opts || {}).then(reply, e => reply({ error: String(e) })); return true;
      case 'next':
        startPageScan('GIPIX · открываю следующую страницу…');
        goNext(msg.cfg).then(result => {
          if (['none', 'stuck', 'cancelled'].includes(result?.status)) stopPageScan();
          reply(result);
        }, e => { stopPageScan(); reply({ error: String(e) }); });
        return true;
      case 'status': { const items = findItems(msg.cfg); reply({ items: items.length, sig: sigOf(items), captcha: challengeOnPage() || (!items.length && captchaOnPage()), url: location.href }); return; }
      case 'flash': reply({ count: flash(msg.cfg) }); return;
      case 'pill': msg.text ? showPill(msg.text) : hidePill(); reply({ ok: true }); return;
    }
  });
})();
