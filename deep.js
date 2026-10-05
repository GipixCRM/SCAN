// Глубокий сбор: скачиваем страницу каждого элемента (без открытия вкладок) и
// берём название, медиа, описание, автора, дату и характеристики. Источники:
// JSON-LD → микроразметка → Open Graph → вёрстка.
const Deep = (() => {
  const IMG_BAD = /(icon|sprite|logo|badge|cart|basket|star|rating|flag|arrow|loader|spinner|placeholder|blank|pixel|no-?photo|noimage|1x1|\.svg)/i;
  const GALLERY = /(gallery|galer|photo|foto|slider|swiper|fotorama|zoom|carousel|product[-_]?(img|image|pic)|preview|picture|big-?image)/i;
  const SPECS = /(spec|char|param|propert|attribut|feature|характ|свойств|props|tech)/i;
  const VIDEO_HOST = /(youtube\.com|youtu\.be|vimeo\.com|rutube\.ru|vk\.com\/video|tiktok\.com)/i;
  const VIDEO_EXT = /\.(?:mp4|webm|m3u8|mov|avi)(?:[?#]|$)/i;
  const AUDIO_EXT = /\.(?:mp3|m4a|ogg|wav|flac|aac)(?:[?#]|$)/i;
  const MAX_IMAGES = 10;

  const CARD_COLS = [
    { key: 'card:name', label: 'Карточка: название', type: 'text', role: 'name' },
    { key: 'card:brand', label: 'Карточка: бренд', type: 'text', role: 'brand' },
    { key: 'card:sku', label: 'Карточка: код', type: 'text', role: 'article' },
    { key: 'card:price', label: 'Карточка: цена', type: 'text', role: 'cardPrice' },
    { key: 'card:desc', label: 'Карточка: описание', type: 'text', role: 'description' },
    { key: 'card:specs', label: 'Карточка: характеристики', type: 'text', role: 'specs' },
    { key: 'content:type', label: 'Контент: тип', type: 'text', role: 'contentType' },
    { key: 'content:author', label: 'Контент: автор', type: 'text', role: 'author' },
    { key: 'content:date', label: 'Контент: дата', type: 'text', role: 'date' },
    { key: 'content:duration', label: 'Контент: длительность', type: 'text', role: 'duration' },
    { key: 'content:body', label: 'Контент: текст', type: 'text', role: 'body' },
    { key: 'content:media', label: 'Контент: медиа', type: 'link', role: 'media' },
  ];
  const imgCol = i => ({ key: `card:img${i}`, label: `Карточка: фото ${i + 1}`, type: 'img' });

  // Признаки страницы-проверки («я не робот», Cloudflare, DDoS-Guard, SmartCaptcha…)
  const CAPTCHA_RX = /(captcha|recaptcha|hcaptcha|smartcaptcha|turnstile|я не робот|не робот|подтвердите,? что|проверка браузера|checking your browser|just a moment|ddos-guard|access denied|доступ (ограничен|запрещ)|слишком много запросов|too many requests)/i;
  const CONTENT_SIGNS = /application\/ld\+json[\s\S]{0,5000}(?:Product|Article|VideoObject|AudioObject)|property=["']og:title|itemprop=["']name/i;

  function looksBlocked(html) {
    const title = html.match(/<title[^>]*>([^<]*)/i)?.[1] || '';
    if (CAPTCHA_RX.test(title)) return true;
    // Проверка может быть добавлена поверх обычной страницы с JSON-LD. Такие
    // ответы нельзя принимать за готовую карточку: ищем явные элементы
    // challenge до общего эвристического признака содержимого.
    if (/<(?:iframe|form)[^>]+(?:captcha|turnstile|challenge-form|challenges?\.cloudflare)/i.test(html)
      || /(?:id|class)=["'][^"']*(?:captcha|turnstile|challenge-form|cf-chl)[^"']*["']/i.test(html)) return true;
    if (CONTENT_SIGNS.test(html.slice(0, 300000))) return false;  // капча в форме обратной связи не блокирует публикацию
    return CAPTCHA_RX.test(html.replace(/<script[\s\S]*?<\/script>/gi, '').slice(0, 40000));
  }

  /** → {card} | {blocked, reason} | {error} */
  async function fetchCard(url, externalSignal) {
    const ctrl = new AbortController();
    const abort = () => ctrl.abort();
    if (externalSignal) {
      if (externalSignal.aborted) return { cancelled: true };
      externalSignal.addEventListener('abort', abort, { once: true });
    }
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      const r = await fetch(url, { credentials: 'include', signal: ctrl.signal });
      if ([403, 429, 503].includes(r.status)) return { blocked: true, reason: `сайт ответил ${r.status}` };
      if ([500, 502, 504, 520, 521, 522, 523, 524].includes(r.status)) return { error: 'HTTP ' + r.status, network: true };  // временный сбой сайта
      if (!r.ok) return { error: 'HTTP ' + r.status };
      const buf = await r.arrayBuffer();
      let cs = (r.headers.get('content-type') || '').match(/charset=["']?([\w-]+)/i)?.[1];
      cs ||= new TextDecoder('windows-1252').decode(buf.slice(0, 4096)).match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
      let html;
      try { html = new TextDecoder(cs || 'utf-8').decode(buf); } catch { html = new TextDecoder().decode(buf); }
      if (looksBlocked(html)) return { blocked: true, reason: 'проверка «я не робот»' };
      return { card: parse(html, r.url || url) };
    } catch (e) {
      if (externalSignal?.aborted) return { cancelled: true };
      return { error: e.name === 'AbortError' ? 'таймаут' : e.message, network: true };  // нет сети / сайт не отвечает
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abort);
    }
  }

  function parse(html, url) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const t = s => String(s || '').replace(/\s+/g, ' ').trim();
    const abs = u => { try { return u ? new URL(u, url).href : ''; } catch { return ''; } };
    const out = { type: 'product', name: '', brand: '', sku: '', price: 0, description: '', images: [], specs: [], author: '', date: '', duration: '', body: '', media: [] };
    const addImg = u => {
      u = abs(u);
      if (u && /^https?:/.test(u) && !IMG_BAD.test(u) && !out.images.includes(u) && out.images.length < MAX_IMAGES) out.images.push(u);
    };

    // 1) JSON-LD schema.org/Product
    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      let data;
      try { data = JSON.parse(s.textContent); } catch { continue; }
      const all = [].concat(data).flatMap(d => (d && d['@graph'] ? d['@graph'] : [d]));
      const p = all.find(d => d && /Product/i.test([].concat(d['@type'] || '').join(' ')));
      if (!p) continue;
      out.name ||= t(p.name);
      out.sku ||= t(p.mpn || p.sku);
      out.brand ||= t(typeof p.brand === 'string' ? p.brand : p.brand?.name);
      out.description ||= t(p.description);
      [].concat(p.image || []).forEach(i => addImg(typeof i === 'string' ? i : i?.url || i?.contentUrl));
      const off = [].concat(p.offers || [])[0];
      out.price ||= +(off?.price ?? off?.lowPrice ?? 0) || 0;
    }

    // 2) Микроразметка itemprop
    const ip = n => doc.querySelector(`[itemprop="${n}"]`);
    const ipv = el => t(el && (el.getAttribute('content') || el.getAttribute('src') || el.getAttribute('href') || el.textContent));
    out.name ||= ipv(ip('name'));
    out.sku ||= ipv(ip('mpn')) || ipv(ip('sku'));
    out.brand ||= ipv(doc.querySelector('[itemprop="brand"] [itemprop="name"]')) || ipv(ip('brand'));
    out.description ||= ipv(ip('description'));
    doc.querySelectorAll('[itemprop="image"]').forEach(el => addImg(el.getAttribute('content') || el.getAttribute('src') || el.getAttribute('href')));
    out.price ||= parseFloat(ipv(ip('price')).replace(/[^\d.,]/g, '').replace(',', '.')) || 0;

    // 3) Заголовок страницы и Open Graph
    const meta = p => t(doc.querySelector(`meta[property="${p}"], meta[name="${p}"]`)?.content);
    out.name ||= t(doc.querySelector('h1')?.textContent) || meta('og:title');
    out.description ||= meta('og:description') || meta('description');
    doc.querySelectorAll('meta[property="og:image"]').forEach(m => addImg(m.content));

    // Универсальные типы Schema.org и Open Graph. Товар остаётся основным
    // режимом, но та же карточка теперь корректно описывает видео, статью,
    // аудио и произвольную публикацию.
    const types = [];
    const media = [];
    const addMedia = u => { u = abs(u); if (u && /^https?:/.test(u) && !media.includes(u) && media.length < 10) media.push(u); };
    let schemaBody = '';
    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(s.textContent);
        for (const d of [].concat(data).flatMap(x => x?.['@graph'] || [x])) {
          types.push(...[].concat(d?.['@type'] || []));
          schemaBody ||= t(d?.articleBody || d?.text || '');
          const dtypes = [].concat(d?.['@type'] || []).join(' ');
          if (/VideoObject|AudioObject/i.test(dtypes)) {
            out.name ||= t(d?.name);
            out.description ||= t(d?.description);
            out.date ||= t(d?.uploadDate || d?.datePublished);
            out.duration ||= t(d?.duration);
            [].concat(d?.thumbnailUrl || []).forEach(u => addImg(typeof u === 'string' ? u : u?.url));
            [].concat(d?.contentUrl || d?.embedUrl || []).forEach(u => addMedia(typeof u === 'string' ? u : u?.url));
          }
        }
      } catch { /* битый JSON-LD */ }
    }
    const bodyText = t(doc.querySelector('article, main, [role="main"], .article, .post, .entry-content')?.textContent || '');
    const video = doc.querySelector('video, [itemprop="video"]');
    const audio = doc.querySelector('audio, [itemprop="audio"]');
    doc.querySelectorAll('video, audio, source, iframe, [itemprop="contentUrl"], [itemprop="embedUrl"]').forEach(el => {
      addMedia(el.currentSrc || el.src || el.getAttribute('src') || el.getAttribute('content') || el.getAttribute('data-src'));
    });
    doc.querySelectorAll('a[href]').forEach(a => { if (VIDEO_EXT.test(a.href) || AUDIO_EXT.test(a.href) || VIDEO_HOST.test(a.href)) addMedia(a.href); });
    out.media = media;
    const hasVideo = !!video || types.some(x => /VideoObject|Movie|Episode/i.test(x)) || media.some(u => VIDEO_EXT.test(u) || VIDEO_HOST.test(u));
    const hasAudio = !!audio || types.some(x => /AudioObject|PodcastEpisode|MusicRecording/i.test(x)) || media.some(u => AUDIO_EXT.test(u));
    const hasArticle = !!doc.querySelector('article, .article, .post, .entry-content') || types.some(x => /Article|NewsArticle|BlogPosting|Report/i.test(x));
    const hasEvent = types.some(x => /Event|SportsEvent|MusicEvent/i.test(x)) || !!doc.querySelector('[itemprop="startDate"], [itemprop="location"], .event, .webinar');
    const hasProfile = types.some(x => /Person|ProfilePage/i.test(x)) || !!doc.querySelector('[itemtype*="Person"], .profile, .author-card');
    const hasProduct = types.some(x => /Product/i.test(x)) || !!doc.querySelector('[itemtype*="Product"], [itemprop="price"], [itemprop="sku"]') || !!out.price || !!out.sku;
    if (hasProduct) out.type = 'product';
    else if (hasVideo) out.type = 'video';
    else if (hasAudio) out.type = 'audio';
    else if (hasArticle) out.type = 'article';
    else if (hasEvent) out.type = 'event';
    else if (hasProfile) out.type = 'profile';
    else if (!out.name && media.length) out.type = 'image';
    out.author ||= t(doc.querySelector('[itemprop="author"] [itemprop="name"], [itemprop="author"], .author, [rel="author"]')?.textContent)
      || meta('author') || meta('article:author');
    out.date ||= t(doc.querySelector('[itemprop="datePublished"], time[datetime], time')?.getAttribute('datetime') || doc.querySelector('[itemprop="datePublished"], time')?.textContent)
      || meta('article:published_time') || meta('date');
    const durationEl = doc.querySelector('video,audio');
    const durationValue = doc.querySelector('[itemprop="duration"]')?.getAttribute('content')
      || (Number.isFinite(durationEl?.duration) ? `${Math.round(durationEl.duration)} с` : '');
    out.duration ||= t(durationValue);
    out.body = (hasArticle ? (bodyText || schemaBody) : schemaBody).slice(0, 10000);
    if (!out.description && out.body) out.description = out.body.slice(0, 3000);

    // 4) Фото из галереи товара
    for (const img of doc.querySelectorAll('img')) {
      if (out.images.length >= MAX_IMAGES) break;
      let hit = false;
      for (let box = img, k = 0; box && k < 5 && !hit; box = box.parentElement, k++)
        hit = GALLERY.test(`${typeof box.className === 'string' ? box.className : ''} ${box.id || ''}`);
      if (!hit) continue;
      const a = img.closest('a[href]');
      const big = a && /\.(jpe?g|png|webp|avif)(\?|$)/i.test(a.getAttribute('href')) ? a.getAttribute('href') : '';
      addImg(big || img.getAttribute('data-zoom-image') || img.getAttribute('data-large') || img.getAttribute('data-full')
        || img.getAttribute('data-original') || img.getAttribute('data-src') || img.getAttribute('src'));
    }

    // 5) Характеристики «параметр — значение»
    const seen = new Set();
    const pushSpec = (k, v) => {
      k = t(k).replace(/[:：]\s*$/, ''); v = t(v);
      if (k && v && k.length < 60 && v.length < 200 && k !== v && !seen.has(k.toLowerCase())) { seen.add(k.toLowerCase()); out.specs.push([k, v]); }
    };
    for (const box of doc.querySelectorAll('[class],[id]')) {
      if (out.specs.length >= 30) break;
      if (!SPECS.test(`${typeof box.className === 'string' ? box.className : ''} ${box.id || ''}`)) continue;
      box.querySelectorAll('tr').forEach(tr => { const c = tr.querySelectorAll('td,th'); if (c.length === 2) pushSpec(c[0].textContent, c[1].textContent); });
      box.querySelectorAll('dt').forEach(dt => { if (dt.nextElementSibling?.tagName === 'DD') pushSpec(dt.textContent, dt.nextElementSibling.textContent); });
    }

    if (out.description === out.name) out.description = '';
    out.description = out.description.slice(0, 3000);
    return out;
  }

  /** дописывает данные карточки в строку и нужные колонки в job.columns */
  function merge(job, row, card) {
    const have = new Set(job.columns.map(c => c.key));
    const add = c => { if (!have.has(c.key)) { job.columns.push(c); have.add(c.key); } };
    const set = (key, v) => { if (v) { row[key] = v; add(CARD_COLS.find(c => c.key === key)); } };
    set('card:name', card.name);
    set('card:brand', card.brand);
    set('card:sku', card.sku);
    set('card:price', card.price ? `${card.price} ₽` : '');
    set('card:desc', card.description);
    set('card:specs', card.specs.map(([k, v]) => `${k}: ${v}`).join('; '));
    card.images.forEach((u, i) => { row[`card:img${i}`] = u; add(imgCol(i)); });
    set('content:type', card.type);
    set('content:author', card.author);
    set('content:date', card.date);
    set('content:duration', card.duration);
    set('content:body', card.body);
    if (card.media?.length) set('content:media', card.media.join(' '));
    row.__contentType = card.type || row.__contentType || 'generic';
  }

  const rand = ([a, b]) => a + Math.random() * (b - a);

  /**
   * Обходит строки без карточки с человеческим темпом.
   * ctl — общий регулятор (gate/wait/slow), speed — {threads, cardDelay:[min,max], breakEvery, breakFor}
   * onBlocked(url, reason) → 'retry' | 'skip' | false (стоп) — вызывается, когда сайт показал проверку
   * onOffline(url) → 'retry' | false — связь с сайтом пропала; строка не теряется, вернётся в очередь
   */
  async function run(job, { linkOf, ctl, speed, onProgress, onBlocked, onOffline, onPhase, save, signal }) {
    const queue = job.rows.filter(r => !r.__card);
    const total = queue.length;
    let done = 0, ok = 0, sinceBreak = 0, alive = true, netErrors = 0;
    const worker = async () => {
      while (alive && queue.length) {
        if (!(await ctl.gate())) { alive = false; return; }
        const row = queue.shift();
        const url = linkOf(row);
        if (!url) { row.__card = -1; done++; onProgress(done, total, ok); continue; }
        const res = await fetchCard(url, signal);
        if (res.cancelled || !(await ctl.gate())) { alive = false; return; }
        if (res.network) {
          queue.unshift(row);
          netErrors++;
          if (netErrors >= 3) {
            netErrors = 0;
            if ((await onOffline(url, res.error)) === false) { alive = false; return; }
          } else {
            onPhase?.(`Сайт не ответил (${res.error}) — повтор через ${3 * netErrors} с…`);
            if (!(await ctl.wait(3000 * netErrors))) { alive = false; return; }
          }
          continue;
        }
        netErrors = 0;
        if (res.blocked) {
          const act = await onBlocked(url, res.reason);
          if (act === 'retry') { queue.unshift(row); continue; }
          if (act !== 'skip') { queue.unshift(row); alive = false; return; }
        }
        if (res.card) { merge(job, row, res.card); row.__card = 1; ok++; } else row.__card = -1;
        done++;
        onProgress(done, total, ok);
        if (done % 20 === 0) await save();
        if (speed.breakEvery && ++sinceBreak >= speed.breakEvery) {
          sinceBreak = 0;
          onPhase?.('Короткий перерыв, чтобы сайт не заподозрил робота…');
          if (!(await ctl.wait(rand(speed.breakFor)))) { alive = false; return; }
        }
        if (!(await ctl.wait(rand(speed.cardDelay)))) { alive = false; return; }
      }
    };
    await Promise.all(Array.from({ length: speed.threads }, worker));
    await save();
    return { done, ok, total, left: queue.length };
  }

  return { run, parse, fetchCard, looksBlocked, CAPTCHA_RX };
})();
