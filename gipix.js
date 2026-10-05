// Собранные строки → товары GIPIX (порт tools/scraper-export/scraper_to_gipix.py + роли колонок).
// Роли (название, бренд, код детали, цена, ссылка…) определяются по всей таблице: по заголовкам и по статистике значений.
(function (root) {
  // const на верхнем уровне скрипта не попадает в window — проверяем саму привязку
  const R = typeof GIPIX_RULES !== 'undefined' ? GIPIX_RULES : require('./gipix_rules.js');

  const CATEGORY = {};
  for (const [section, items] of R.SECTIONS)
    for (const [slug, name] of items) CATEGORY[slug] = { section, name, label: `${section} · ${name}` };
  // Виртуальная категория для режима публикаций. Она нужна только в
  // локальном предпросмотре и не меняет товарные категории GIPIX.
  CATEGORY.content = { section: 'Контент', name: 'Публикации', label: 'Контент · Публикации' };
  const RULES = R.RULES.map(([slug, p]) => [slug, new RegExp(p, 'iu')]);
  const BY_LABEL = Object.fromEntries(Object.entries(CATEGORY).map(([slug, c]) => [c.label.toLowerCase(), slug]));

  const W = '[\\p{L}\\p{N}_]';
  const EMPTY = new Set(['', '—', '-', '...', '…', 'null', 'none', 'n/a']);
  const PRICE_RE = /^\s*(\d[\d\s\u00a0\u202f]*(?:[.,]\d{1,2})?)\s*(?:₽|руб\.?|р\.)\s*$/i;
  const NUM_RE = /^\s*(\d[\d\s\u00a0\u202f]*(?:[.,]\d{1,2})?)\s*$/;
  const QTY_RE = /^\s*[>≥]?\s*(\d+)\s*(?:шт\.?)?\s*$/;
  const TRUNC_RE = /\s*(?:\.\.\.|…)\s*$/;
  const PIECES_RE = new RegExp(`(\\d+)\\s*(?:пр(?!${W})|пр\\.|предм|шт(?!${W})|шт\\.)`, 'iu');
  const PACK_CODE_RE = /\s+\/\d+(?:\/\d+)*(?=[\s,;]|$)|,\s*шт\.?(?=[,;]|\s*$)/g;
  const IMG_RE = /https?:\/\/[^\s"']+?\.(?:jpe?g|png|webp|gif|avif)(?:\?[^\s"']*)?/gi;
  const URL_RE = /^https?:\/\/\S+$/;
  const PRODUCT_URL = /\/(?:parts|part|product|products|catalog|item|items|goods|tovar|p)\//i;
  const HINT = {
    name: /описан|наимен|назван|товар|name|title|продукт/i,
    brand: /бренд|производит|brand|марка|vendor|manufacturer/i,
    article: /код|артикул|арт\.|sku|партном|mpn|model|номер детали|каталожн/i,
    price: /цена|стоим|price/i,
    qty: /наличи|остат|кол-?во|stock|qty/i,
  };
  // ключевые роли для ручной настройки в таблице
  const ROLE_NAMES = { name: 'Название', brand: 'Бренд', article: 'Код детали', price: 'Цена', qty: 'Количество', link: 'Ссылка на товар' };
  const CONTENT_NAMES = { product: 'Товар', video: 'Видео', article: 'Статья', image: 'Изображение', audio: 'Аудио', event: 'Событие', profile: 'Профиль', generic: 'Контент' };

  function clean(s) {
    s = String(s ?? '');
    for (let i = 0; i < 2; i++)
      s = s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
    return s.replace(/""/g, '"').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }
  const num = s => parseFloat(String(s).replace(/[\s\u202f]/g, '').replace(',', '.'));
  const isCode = s => s.length >= 3 && s.length <= 30 && !s.includes(' ') && /\d/.test(s) && !URL_RE.test(s);
  const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const decode = s => { try { return decodeURIComponent(s); } catch { return s; } };

  function trimTruncated(name) {
    name = name.replace(TRUNC_RE, '');
    const cut = Math.max(name.lastIndexOf(','), name.lastIndexOf(';'));
    name = cut > name.length * 0.6 ? name.slice(0, cut) : name.replace(/\s+\S*$/, '');
    if ((name.match(/\(/g) || []).length > (name.match(/\)/g) || []).length) name = name.slice(0, name.lastIndexOf('('));
    return name.replace(/[\s,;:\-—/]+$/, '');
  }

  function plural(n, [one, few, many]) {
    const n100 = n % 100, n10 = n % 10;
    return n10 === 1 && n100 !== 11 ? one : n10 >= 2 && n10 <= 4 && !(n100 >= 12 && n100 <= 14) ? few : many;
  }

  // ── Роли колонок ───────────────────────────────────────────────────────────
  /** columns: [{key,label,type,role?}] → { name, nameAlt[], brand, article, price, link, description, specs, cardPrice } */
  function detectRoles(columns, rows, forced = {}) {
    const sample = rows.slice(0, 400);
    const total = sample.length || 1;
    const linkCols = columns.filter(c => c.type === 'link');
    const rowLinks = sample.map(r => linkCols.map(c => decode(r[c.key] || '')).join(' ').toLowerCase());
    const st = columns.map(c => {
      const filled = sample.map((r, i) => [clean(r[c.key]), i]).filter(([v]) => v && !EMPTY.has(v.toLowerCase()));
      const n = filled.length || 1;
      const frac = f => filled.filter(([v, i]) => f(v, i)).length / n;
      return {
        c, fill: filled.length / total, distinct: new Set(filled.map(([v]) => v)).size / n,
        avgLen: filled.reduce((s, [v]) => s + v.length, 0) / n,
        price: frac(v => PRICE_RE.test(v)), code: frac(isCode), time: frac(v => /\d{1,2}:\d\d/.test(v)),
        letters: frac(v => /\p{L}{3}/u.test(v)), product: frac(v => PRODUCT_URL.test(v)), url: frac(v => /https?:\/\//.test(v)),
        inLink: frac((v, i) => v.length >= 2 && rowLinks[i].includes(v.toLowerCase())),
      };
    });
    const of = key => st.find(s => s.c.key === key);
    const text = st.filter(s => s.c.type === 'text' && s.fill >= 0.3 && !s.c.role && s.url < 0.3);
    const best = (arr, score, exclude = []) => arr.filter(s => !exclude.includes(s.c.key))
      .map(s => [score(s), s]).filter(([x]) => x > 0).sort((a, b) => b[0] - a[0])[0]?.[1].c.key || '';
    const byRole = role => st.find(s => s.c.role === role && s.fill >= 0.3)?.c.key || '';
    const hint = (kind, ok, exclude = []) => text.find(s => HINT[kind].test(s.c.label) && ok(s) && !exclude.includes(s.c.key))?.c.key || '';

    const r = {};
    r.price = hint('price', s => s.price > 0.5) || best(text, s => (s.price > 0.5 ? s.price * s.fill : 0));
    r.qty = byRole('qty') || hint('qty', s => s.avgLen < 12 && s.code < 0.5);
    r.article = hint('article', s => s.code > 0.5, [r.price])
      || best(text, s => (s.code > 0.6 && s.distinct > 0.6 && s.avgLen < 25 ? s.code + s.distinct + s.inLink : 0), [r.price]);
    r.brand = hint('brand', s => s.avgLen < 40 && s.code < 0.5, [r.article])
      || best(text, s => (s.avgLen < 30 && s.distinct < 0.6 && s.code < 0.3 && s.letters > 0.7 && s.time < 0.2 && s.price < 0.1 && s.inLink > 0.3
        ? s.inLink * 2 + (1 - s.distinct) : 0), [r.price, r.article]);
    const taken = [r.price, r.article, r.brand];
    r.name = hint('name', s => s.letters > 0.8 && s.avgLen > 8, taken)
      || best(text, s => (s.letters > 0.8 && s.distinct > 0.1 && s.price < 0.1 && s.time < 0.2 ? s.avgLen * s.distinct * s.fill : 0), taken);
    r.link = best(st.filter(s => s.c.type === 'link'), s => s.fill * (0.5 + s.product) * s.distinct);
    // из карточки товара (глубокий сбор): полное название главнее, бренд и код — запасные (в карточке «артикул» бывает внутренним ID сайта)
    r.cardName = byRole('name');
    r.brandAlt = byRole('brand');
    r.articleAlt = byRole('article');
    r.description = byRole('description');
    r.specs = byRole('specs');
    r.cardPrice = byRole('cardPrice');
    r.contentType = byRole('contentType');
    for (const [k, v] of Object.entries(forced || {})) if (v) r[k] = v === '-' ? '' : v;
    // запасные колонки с названием: та же «форма» данных (например, обрезанное и полное описание)
    const main = of(r.name);
    r.nameAlt = main ? text.filter(s => s.c.key !== r.name && !taken.includes(s.c.key) && s.letters > 0.8 && s.distinct > 0.1
      && s.price < 0.1 && s.time < 0.2 && s.avgLen >= main.avgLen * 0.7).map(s => s.c.key) : [];
    return r;
  }

  // Код детали и бренд из ссылки вида /parts/АвтоDело/40640
  function fromLinks(links, texts) {
    const low = new Map(texts.map(t => [t.toLowerCase(), t]));
    for (const u of links) {
      let segs;
      try { segs = new URL(u).pathname.split('/').filter(Boolean).map(decode); } catch { continue; }
      for (let i = segs.length - 1; i > 0; i--) {
        const code = segs[i], prev = segs[i - 1].toLowerCase();
        if (!/^[\p{L}\p{N}._-]{3,30}$/u.test(code) || !/\d/.test(code) || /\.html?$|[a-z]{3,}-[a-z]{3,}/i.test(code)) continue;
        // /parts/{бренд}/{код} — схема магазинов автозапчастей на ABCP (berru и др.)
        const abcp = i === segs.length - 1 && i >= 2 && /^(parts|part|search)$/i.test(segs[i - 2]);
        if (low.has(code.toLowerCase()) || low.has(prev) || abcp)
          return { article: low.get(code.toLowerCase()) || code, brand: low.get(prev) || (abcp ? segs[i - 1] : '') };
      }
    }
    return {};
  }

  /** cells: [{key,label,type,value}] в порядке колонок */
  function parseRow(cells, roles = {}) {
    const images = [], links = [], prices = [], texts = [];
    const get = k => (k ? clean(cells.find(c => c.key === k)?.value) : '');
    const special = new Set([roles.description, roles.specs, roles.cardPrice, roles.cardName, roles.brandAlt, roles.articleAlt, roles.contentType, roles.qty].filter(Boolean));
    let qty = 0;
    cells.forEach((c, i) => {
      const v = clean(c.value);
      if (c.key === roles.qty) { qty = +(QTY_RE.exec(v)?.[1] || NUM_RE.exec(v)?.[1] || 0); return; }
      if (EMPTY.has(v.toLowerCase()) || special.has(c.key)) return;
      if (c.type === 'img') { v.split(' ').filter(u => URL_RE.test(u) && !images.includes(u)).forEach(u => images.push(u)); return; }
      const found = c.type === 'text' ? [...v.matchAll(IMG_RE)].map(m => m[0]) : [];
      if (found.length) { found.filter(u => !images.includes(u)).forEach(u => images.push(u)); return; }
      if (c.type === 'link' || URL_RE.test(v)) { links.push(v); return; }
      const m = PRICE_RE.exec(v) || (c.key === roles.price && NUM_RE.exec(v));
      if (m) {
        const prev = i ? clean(cells[i - 1].value) : '';
        const q = QTY_RE.exec(prev);
        if (q && !PRICE_RE.test(prev)) qty ||= +q[1];
        prices.push([num(m[1]), q && !PRICE_RE.test(prev) ? +q[1] : null]);
        return;
      }
      texts.push(v);
    });
    if (!prices.length && get(roles.cardPrice)) prices.push([num(get(roles.cardPrice)), null]);

    // Бренд и код: сначала колонки-роли, потом «текст, с которого начинается название», потом ссылка
    const uniq = [...new Set(texts)].sort((a, b) => a.length - b.length);
    const starts = t => uniq.some(o => o !== t && o.toLowerCase().startsWith(t.toLowerCase() + ' '));
    let brand = [get(roles.brand), get(roles.brandAlt)].find(v => v && v.length < 40) || '';
    let article = [get(roles.article), get(roles.articleAlt)].find(v => v && v.length <= 40) || '';
    brand ||= uniq.find(t => !isCode(t) && t.length < 40 && starts(t)) || '';
    article ||= uniq.find(t => isCode(t) && t !== brand && uniq.some(o => o !== t && o.includes(t))) || '';
    if (!brand || !article) {
      const l = fromLinks([get(roles.link), ...links].filter(Boolean), texts);
      brand ||= l.brand || '';
      article ||= l.article || '';
    }

    const stripName = t => {
      let prev;
      do {
        prev = t;
        for (const p of [brand, article])
          if (p && t.toLowerCase().startsWith(p.toLowerCase())) t = t.slice(p.length).replace(/^[\s,\-—:]+/, '');
      } while (prev !== t);
      if (article) t = t.replace(new RegExp(`(^|[\\s,(])${brand ? `(?:${escRe(brand)}\\s+)?` : ''}${escRe(article)}(?=$|[\\s,).;])`, 'iu'), '$1');
      t = t.replace(PACK_CODE_RE, '');
      if (brand && t.toLowerCase().replace(/[\s,.]+$/, '').endsWith(brand.toLowerCase()))
        t = t.replace(/[\s,.]+$/, '').slice(0, -brand.length);
      return t.replace(/\s{2,}/g, ' ').replace(/\(\s*\)/g, '').replace(/^[\s,;]+|[\s,;]+$/g, '');
    };

    // Название: полное из карточки товара → лучшее из колонок-названий → самый длинный текст строки
    let pool = get(roles.cardName) ? [get(roles.cardName)] : [roles.name, ...(roles.nameAlt || [])].map(get).filter(Boolean);
    if (!pool.length) pool = [...new Set(texts)];
    const names = pool
      .filter(t => t !== brand && t !== article && !/^[>≥]?\d+$|^\S+ \d\d:\d\d$/.test(t))
      .map(stripName)
      .filter(n => n.length >= 3 && /\p{L}{3}/u.test(n))
      .map(n => [!TRUNC_RE.test(n), n.length, n])
      .sort((a, b) => (b[0] - a[0]) || (b[1] - a[1]));
    let name = '', truncated = false;
    if (names.length) {
      [, , name] = names[0];
      truncated = !names[0][0];
      if (truncated) name = trimTruncated(name);
    }
    const source = get(roles.link) || links.find(u => PRODUCT_URL.test(u)) || links[0] || '';
    return { images, prices, qty, brand, article, name, truncated, source, description: get(roles.description), specs: get(roles.specs) };
  }

  function classify(name) {
    const low = name.toLowerCase().replace(/ё/g, 'е');
    for (const [slug, rx] of RULES) if (rx.test(low)) return slug;
    return null;
  }

  // Универсальный разбор строки. Товарные строки проходят старый строгий
  // нормализатор ниже, остальные сохраняются как самостоятельные публикации
  // с медиа, автором, датой и текстом.
  function parseContentRow(columns, row) {
    const images = [], media = [], texts = [];
    let title = '', body = '', author = '', date = '', duration = '', source = '', type = row.__contentType || '', price = 0;
    const putUrl = u => {
      if (!URL_RE.test(u)) return;
      const image = /\.(?:jpe?g|png|webp|gif|avif)(?:[?#]|$)/i.test(u);
      const isMedia = image || /\.(?:mp4|webm|m3u8|mov|avi|mp3|m4a|ogg|wav|flac|aac)(?:[?#]|$)|youtube\.com|youtu\.be|vimeo\.com|rutube/i.test(u);
      if (!source) source = u;
      if (image) { if (!images.includes(u)) images.push(u); }
      else if (isMedia && !media.includes(u)) media.push(u);
    };
    for (const c of columns) {
      if (c.key.startsWith('__')) continue;
      const v = clean(row[c.key]);
      if (!v || EMPTY.has(v.toLowerCase())) continue;
      if (c.type === 'img') { v.split(/\s+/).forEach(putUrl); continue; }
      const label = `${c.label} ${c.role || ''}`;
      if (/контент:\s*тип|content.*type/i.test(label)) { type ||= v; continue; }
      if (/медиа|media|video|audio/i.test(label)) {
        v.split(/\s+/).filter(u => URL_RE.test(u)).forEach(u => { if (!media.includes(u)) media.push(u); if (!source) source = u; });
        continue;
      }
      if (c.type === 'link' || URL_RE.test(v)) { v.split(/\s+/).forEach(putUrl); continue; }
      if (/автор|author|creator|редактор/i.test(label)) { author ||= v; continue; }
      if (/дата|date|published|publish/i.test(label)) { date ||= v; continue; }
      if (/длит|duration|время|time/i.test(label)) { duration ||= v; continue; }
      if (/цена|price|стоим/i.test(label)) { price ||= num(v); continue; }
      if (/текст|body|article|описан|description|content/i.test(label) && v.length > body.length) { body = v; continue; }
      if (/назван|заголов|title|headline|name|card:name/i.test(label) && v.length > title.length) { title = v; continue; }
      texts.push(v);
    }
    if (!title) title = texts.filter(v => !/^\d{1,2}:\d\d$/.test(v)).sort((a, b) => b.length - a.length)[0] || source;
    if (!body) body = texts.filter(v => v !== title).sort((a, b) => b.length - a.length)[0] || '';
    if (!type) {
      const urls = media.join(' ');
      type = /\.(?:mp4|webm|m3u8|mov|avi)(?:[?#]|$)|youtube\.com|youtu\.be|vimeo\.com|rutube/i.test(urls) ? 'video'
        : /\.(?:mp3|m4a|ogg|wav|flac|aac)(?:[?#]|$)/i.test(urls) ? 'audio' : images.length && !body ? 'image' : 'generic';
    }
    return { type: Object.keys(CONTENT_NAMES).find(k => k === type) || 'generic', title: clean(title), body: clean(body), author: clean(author), date: clean(date), duration: clean(duration), source, images, media, price };
  }

  function buildContentItem(r, key) {
    const name = r.title || r.source || 'Без названия';
    const kind = CONTENT_NAMES[r.type] || CONTENT_NAMES.generic;
    const desc = r.body || [r.author && `Автор: ${r.author}`, r.date && `Дата: ${r.date}`].filter(Boolean).join(' · ');
    return {
      key, title: name, subtitle: [kind, r.author, r.date].filter(Boolean).join(' · '), category: 'content', category_confidence: 'high',
      content_type: r.type, price: r.price || 0, old_price: 0, qty: 0, brand: r.author, sku: '', image_url: r.images[0] || '', images: r.images,
      media_urls: r.media, source_url: r.source, author: r.author, published_at: r.date, duration: r.duration,
      pack_label: '', unit: '', min_order_qty: 0, tags: [kind, r.author].filter(Boolean), description: desc,
      specs: { 'Тип контента': kind, 'Автор': r.author, 'Дата': r.date, 'Длительность': r.duration }, advantages: [], applicability: [],
      published: !!(name || r.source || r.images.length || r.media.length), in_stock: false, on_order: false, recommended: false, is_new: false, popular: false, sort_order: 0,
      _contentType: r.type, _article: '', _source: r.source, _supplier_price: null,
    };
  }

  function buildContentItems(columns, rows, overrides = {}) {
    const out = [], seen = new Map();
    for (const [index, row] of rows.entries()) {
      const r = parseContentRow(columns, row);
      const key = (r.source || `${r.type}|${r.title}`).toLowerCase();
      if (seen.has(key)) { seen.get(key)._rowIndices.push(index); continue; }
      const o = overrides[key] || {};
      if (o.title !== undefined) r.title = o.title;
      if (o.author !== undefined) r.author = o.author;
      const item = buildContentItem(r, key);
      item._rowIndices = [index];
      seen.set(key, item); out.push(item);
    }
    out.roles = {};
    out.contentType = out.length ? out.reduce((m, x) => { m[x.content_type] = (m[x.content_type] || 0) + 1; return m; }, {}) : {};
    return out;
  }

  function nicePrice(p, markup, step) {
    p *= 1 + (markup || 0) / 100;
    return step > 1 ? Math.ceil(p / step) * step : Math.round(p * 100) / 100;
  }

  function buildItem(r, slug, confident, s) {
    const cat = CATEGORY[slug];
    const name = r.name ? r.name[0].toUpperCase() + r.name.slice(1) : '';
    const tail = [r.brand, r.article].filter(Boolean).join(' ');
    const title = [name, tail].filter(Boolean).join(', ').slice(0, 300);
    let offer = null;
    if (r.prices.length) {
      offer = s.priceMode === 'max' ? r.prices.reduce((a, b) => (b[0] > a[0] ? b : a))
        : s.priceMode === 'first' ? r.prices[0] : r.prices.reduce((a, b) => (b[0] < a[0] ? b : a));
    }
    const price = offer ? nicePrice(offer[0], s.markup, s.round) : 0;
    const pieces = PIECES_RE.exec(name);
    const isSet = /^(?:набор|комплект)/i.test(name) || / набор/i.test(name);
    const desc = r.description ? [r.description.slice(0, 2500)] : [name && !name.endsWith('.') ? name + '.' : name];
    if (r.brand) desc.push(`Производитель — ${r.brand}` + (r.article ? `, код детали ${r.article}.` : '.'));
    if (pieces && isSet && !r.description) { const n = +pieces[1]; desc.push(`В комплекте ${n} ${plural(n, ['предмет', 'предмета', 'предметов'])}.`); }
    if (r.specs) desc.push(`Характеристики: ${r.specs.slice(0, 1200)}.`);
    const image = r.images[0] || '';
    return {
      key: '',
      title,
      subtitle: [r.brand, r.article ? `арт. ${r.article}` : ''].filter(Boolean).join(' · '),
      category: slug,
      category_confidence: confident ? 'high' : 'low',
      price,
      old_price: 0,
      qty: r.qty || 0,
      brand: r.brand,
      sku: r.article,
      image_url: image,
      images: r.images,
      pack_label: '',
      unit: isSet ? 'комплект' : 'шт',
      min_order_qty: 1,
      tags: [cat.name.toLowerCase(), r.brand].filter(Boolean).slice(0, 5),
      description: desc.filter(Boolean).join(' '),
      specs: {
        'Партномер (артикул производителя)': r.article,
        'Тип': cat.name,
        'Цвет': 'не указан',
        'Гарантия': '12 месяцев',
        'Страна-изготовитель': 'Россия',
      },
      advantages: [],
      applicability: [],
      published: !!(title && price > 0 && image),
      in_stock: false,
      on_order: true,
      recommended: false,
      is_new: false,
      popular: false,
      sort_order: 0,
      _section: cat.section,
      _sub: cat.name,
      _article: r.article,
      _source: r.source,
      _truncated: r.truncated,
      _supplier_price: offer ? offer[0] : null,
    };
  }

  /** columns: [{key,label,type,role?}], rows: [{key: value}], forcedRoles — выбор пользователя */
  function buildItems(columns, rows, settings = {}, overrides = {}, forcedRoles = {}) {
    const nonProducts = rows.filter(r => r.__contentType && r.__contentType !== 'product');
    if (nonProducts.length && nonProducts.length >= rows.length / 2) return buildContentItems(columns, rows, overrides);
    const s = { markup: 0, round: 1, priceMode: 'min', ...settings };
    const roles = detectRoles(columns, rows, forcedRoles);
    const parsed = rows.map(row => parseRow(columns.map(c => ({ key: c.key, label: c.label, type: c.type, role: c.role, value: row[c.key] })), roles));
    const guessed = parsed.map(p => classify(p.name));
    const counts = {};
    guessed.filter(Boolean).forEach(g => (counts[g] = (counts[g] || 0) + 1));
    const fallback = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'specialty_tools';
    const items = [], seen = new Map();
    parsed.forEach((p, i) => {
      if (!(p.name || p.article)) return;
      const key = p.article ? `${p.brand}|${p.article}`.toLowerCase() : p.name.toLowerCase();
      if (seen.has(key)) { seen.get(key)._rowIndices.push(i); return; }
      const o = overrides[key] || {};
      if (o.article !== undefined) p.article = o.article;
      if (o.brand !== undefined) p.brand = o.brand;
      const slug = o.category && CATEGORY[o.category] ? o.category : guessed[i] || fallback;
      const it = buildItem(p, slug, !!(o.category || guessed[i]), s);
      it.key = key;
      it._rowIndices = [i];
      seen.set(key, it);
      if (o.title) { it.title = o.title; it.published = !!(it.title && it.price > 0 && it.image_url); }
      items.push(it);
    });
    items.roles = roles;
    return items;
  }

  // ── Экспорт ────────────────────────────────────────────────────────────────
  const numOut = x => (x ? String(x) : '');
  const TSV_COLUMNS = [
    ['Название', it => it.title],
    ['Цена', it => numOut(it.price)],
    ['Старая цена', it => numOut(it.old_price)],
    ['Остаток', it => it.qty],
    ['Бренд', it => it.brand],
    ['Партномер производителя', it => it._article],
    ['Ваш артикул', it => it._article],
    ['Категория', it => CATEGORY[it.category].label],
    ['Код подкатегории', it => it.category],
    ['URL фото', it => it.image_url],
    ['Доп. фото', it => it.images.slice(1).join(' ')],
    ['Кратко', it => it.subtitle],
    ['Описание', it => it.description],
    ['Теги', it => it.tags.join(', ')],
    ['Ед.', it => it.unit],
    ['Гарантия', it => it.specs['Гарантия']],
    ['Страна-изготовитель', it => it.specs['Страна-изготовитель']],
    ['Наличие', it => (it.on_order ? 'Под заказ' : 'В наличии')],
  ];
  const cell = v => String(v ?? '').replace(/[\t\r\n]+/g, ' ');

  function toTSV(items, { onlyReady = true } = {}) {
    const list = onlyReady ? items.filter(it => it.published) : items;
    if (list.some(it => it._contentType && it._contentType !== 'product')) {
      const cols = [['Тип', it => CONTENT_NAMES[it._contentType] || 'Контент'], ['Заголовок', it => it.title], ['Цена', it => numOut(it.price)], ['Автор', it => it.author], ['Дата', it => it.published_at], ['Длительность', it => it.duration], ['URL', it => it.source_url], ['Медиа', it => (it.media_urls || []).join(' ')], ['Изображения', it => (it.images || []).join(' ')], ['Текст', it => it.description]];
      return [cols.map(c => c[0]).join('\t'), ...list.map(it => cols.map(([, f]) => cell(f(it))).join('\t'))].join('\n') + '\n';
    }
    return [TSV_COLUMNS.map(c => c[0]).join('\t'), ...list.map(it => TSV_COLUMNS.map(([, f]) => cell(f(it))).join('\t'))].join('\n') + '\n';
  }

  function toJSON(items, query = '') {
    const pub = items.map(it => Object.fromEntries(Object.entries(it).filter(([k]) => !k.startsWith('_') && k !== 'key')));
    return JSON.stringify({ ok: true, query, items: pub }, null, 2);
  }

  function toCSV(columns, rows) {
    const esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    return '\uFEFF' + [columns.map(c => esc(c.label)).join(';'), ...rows.map(r => columns.map(c => esc(r[c.key])).join(';'))].join('\n');
  }

  const api = { CATEGORY, BY_LABEL, ROLE_NAMES, CONTENT_NAMES, detectRoles, parseRow, classify, parseContentRow, buildItems, toTSV, toJSON, toCSV, clean };
  root.GIPIX = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
