/*
  IGRObeauty – стили на страницах сайта.
  Просмотрщик без зависимостей и внешних запросов. Данные – в data.js (window.SHOWCASE).

  Устройство:
  – снимок страницы стоит в обычном потоке документа, его листает полоса прокрутки браузера;
  – при смене стиля новый снимок грузится и декодируется в фоне, старый остаётся на экране,
    затем снимки меняются местами и прокрутка ставится в то же относительное место;
  – после показа в фоне подгружаются соседние стили той же страницы;
  – состояние живёт в адресе: #cooperation/kv3, с открытым KV – #cooperation/kv3/kv.
*/
(() => {
  'use strict';

  const D = window.SHOWCASE;
  const root = document.documentElement;
  const byId = (id) => document.getElementById(id);

  if (!D || !Array.isArray(D.styles) || !D.styles.length || !Array.isArray(D.pages) || !D.pages.length) {
    const p = document.createElement('p');
    p.className = 'fatal';
    p.textContent = 'Не удалось прочитать data.js: нет списка стилей или страниц.';
    document.body.prepend(p);
    return;
  }

  /* ---------- Данные ---------- */

  const STYLES = D.styles;
  const PAGES = D.pages;
  const PAGE_WIDTH = Number(D.pageWidth) || 1440;
  const PAGE_PATH = D.pagePath || 'assets/pages/{page}-{style}.webp';
  const VERSION = D.version ? String(D.version) : '';
  const PAGE_LETTERS = ['q', 'w', 'e'];
  const RU_LETTERS = { 'й': 'q', 'ц': 'w', 'у': 'e', 'л': 'k', 'р': 'h' };
  const INTRO_KEY = 'igro-style-showcase:intro-seen:v1';
  const CACHE_MAX = 8;        // сколько загруженных картинок держать под рукой
  const BUSY_DELAY = 120;     // мс: быстрые загрузки обходятся без индикатора
  const KV_PAGE_DELAY = 400;  // мс: страница под открытым KV догружается с паузой

  const findIn = (list, id) => {
    if (id == null || id === '') return null;
    const key = String(id).toLowerCase();
    return list.find((x) => String(x.id).toLowerCase() === key) || null;
  };
  const styleIndex = (id) => STYLES.findIndex((s) => s.id === id);
  const DEFAULT_PAGE = (findIn(PAGES, D.defaultPage) || PAGES[0]).id;
  const DEFAULT_STYLE = (findIn(STYLES, D.defaultStyle) || STYLES[0]).id;

  const withVersion = (url) =>
    VERSION ? url + (url.indexOf('?') < 0 ? '?' : '&') + 'v=' + encodeURIComponent(VERSION) : url;
  const pageFile = (pageId, styleId) =>
    PAGE_PATH.split('{page}').join(pageId).split('{style}').join(styleId);
  const pageUrl = (pageId, styleId) => withVersion(pageFile(pageId, styleId));

  function plural(n, one, few, many) {
    const a = n % 10;
    const b = n % 100;
    if (a === 1 && b !== 11) return one;
    if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
    return many;
  }

  const TITLE = 'IGRObeauty · ' + STYLES.length + ' ' +
    plural(STYLES.length, 'стиль', 'стиля', 'стилей') + ' на страницах сайта';

  /* ---------- Элементы ---------- */

  const el = {
    sheet: byId('sheet'),
    bar: byId('bar'),
    meta: byId('meta'),
    metaName: byId('metaName'),
    pageSeg: byId('pageSeg'),
    styleSeg: byId('styleSeg'),
    kvBtn: byId('kvBtn'),
    helpBtn: byId('helpBtn'),
    hideBtn: byId('hideBtn'),
    pill: byId('pill'),
    pillNum: byId('pillNum'),
    pillName: byId('pillName'),
    kv: byId('kv'),
    kvEyebrow: byId('kvEyebrow'),
    kvName: byId('kvName'),
    kvBox: byId('kvBox'),
    kvPrev: byId('kvPrev'),
    kvNext: byId('kvNext'),
    kvClose: byId('kvClose'),
    intro: byId('intro'),
    introOk: byId('introOk'),
  };

  function h(tag, attrs, kids) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((k) => {
        const v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') node.className = v;
        else node.setAttribute(k, v === true ? '' : String(v));
      });
    }
    if (kids != null) {
      (Array.isArray(kids) ? kids : [kids]).forEach((c) => {
        if (c != null) node.append(c);
      });
    }
    return node;
  }

  /* ---------- Состояние ---------- */

  const state = { page: null, style: null, kv: false };

  let pageToken = 0;      // номер последней загрузки страницы; устаревшие загрузки молча бросаются
  let kvToken = 0;
  let current = null;     // { node, url, missing } – что сейчас на странице
  let lastAnchor = null;  // последнее место на настоящем снимке (если сейчас показана заглушка)
  let toTop = true;       // после смены страницы – наверх
  let kvShownKey = '';
  let kvPageTimer = 0;
  let preloadTimer = 0;
  let lastFocus = null;
  let pageButtons = [];
  let styleButtons = [];

  /* ---------- Индикатор загрузки ---------- */

  const busy = { page: false, kv: false };
  let busyTimer = 0;

  function refreshBusy() {
    const on = state.kv ? busy.kv : busy.page;
    clearTimeout(busyTimer);
    if (!on) {
      root.classList.remove('is-loading');
    } else if (!root.classList.contains('is-loading')) {
      busyTimer = setTimeout(() => root.classList.add('is-loading'), BUSY_DELAY);
    }
  }

  function setBusy(kind, on) {
    busy[kind] = on;
    refreshBusy();
  }

  /* ---------- Картинки: кэш, загрузка, декодирование ---------- */

  const cache = new Map(); // url -> HTMLImageElement, по порядку использования

  function getImg(url, low) {
    let img = cache.get(url);
    if (img && img.complete && !img.naturalWidth) img = null; // в прошлый раз файла не было – пробуем снова
    if (img) {
      cache.delete(url);
    } else {
      img = new Image();
      if (low) img.fetchPriority = 'low';
      img.src = url;
    }
    cache.set(url, img);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return img;
  }

  function whenLoaded(img) {
    return new Promise((resolve, reject) => {
      if (img.complete) {
        if (img.naturalWidth) resolve(img);
        else reject(new Error('Файл не найден'));
        return;
      }
      const finish = (ok) => {
        img.removeEventListener('load', onLoad);
        img.removeEventListener('error', onError);
        if (ok) resolve(img);
        else reject(new Error('Файл не найден'));
      };
      const onLoad = () => finish(true);
      const onError = () => finish(false);
      img.addEventListener('load', onLoad);
      img.addEventListener('error', onError);
    });
  }

  // decode() может отказать на очень большой картинке – тогда просто показываем как есть.
  const decodeQuietly = (img) =>
    (typeof img.decode === 'function' ? img.decode().catch(() => {}) : Promise.resolve());

  /* ---------- Снимок страницы ---------- */

  async function loadPage() {
    clearTimeout(kvPageTimer);
    kvPageTimer = 0;
    const token = ++pageToken;
    const pageId = state.page;
    const styleId = state.style;
    const url = pageUrl(pageId, styleId);

    if (current && current.url === url) {
      // Вернулись к тому, что уже на экране (например, W и сразу Q) – место не трогаем.
      toTop = false;
      setBusy('page', false);
      return;
    }

    setBusy('page', true);
    let node;
    let missing = false;
    try {
      const img = getImg(url);
      await whenLoaded(img);
      if (token !== pageToken) return;
      await decodeQuietly(img);
      if (token !== pageToken) return;
      img.className = 'page';
      img.alt = pageName(pageId) + ' – ' + styleName(styleId);
      img.draggable = false;
      node = img;
    } catch (err) {
      if (token !== pageToken) return;
      node = missingBox(pageId, styleId);
      missing = true;
    }

    swapPage(node, url, missing, pageId, styleId);
    setBusy('page', false);
    schedulePreload();
  }

  function swapPage(node, url, missing, pageId, styleId) {
    const prev = current;
    let anchor = null;
    if (prev && !toTop) anchor = prev.missing ? lastAnchor : captureAnchor(prev.node);

    if (prev) prev.node.replaceWith(node);
    else el.sheet.appendChild(node);
    current = { node, url, missing };

    if (!anchor) {
      window.scrollTo(0, 0);
      lastAnchor = null;
    } else {
      lastAnchor = anchor;
      if (missing) window.scrollTo(0, 0);
      else restoreAnchor(node, anchor);
    }
    toTop = false;
    updateMetaTip(pageId, styleId, node, missing);
  }

  // Место на странице – доля высоты снимка у верхнего края окна; низ страницы – отдельно.
  function captureAnchor(node) {
    const se = document.scrollingElement || root;
    const y = window.scrollY || se.scrollTop || 0;
    const max = se.scrollHeight - se.clientHeight;
    const rect = node.getBoundingClientRect();
    if (!rect.height) return null;
    const top = rect.top + y;
    return {
      bottom: max > 48 && y >= max - 2,
      f: Math.min(1, Math.max(0, (y - top) / rect.height)),
    };
  }

  function restoreAnchor(node, a) {
    const se = document.scrollingElement || root;
    let y;
    if (a.bottom) {
      y = se.scrollHeight - se.clientHeight;
    } else {
      const rect = node.getBoundingClientRect();
      y = rect.top + (window.scrollY || se.scrollTop || 0) + a.f * rect.height;
    }
    window.scrollTo(0, Math.max(0, Math.round(y)));
  }

  function missingBox(pageId, styleId) {
    return h('div', { class: 'missing', role: 'img', 'aria-label': 'Снимок ещё не загружен' }, [
      h('div', { class: 'missing__inner' }, [
        h('p', { class: 'missing__title' }, 'Снимок ' + pageId + '/' + styleId + ' ещё не загружен'),
        h('p', { class: 'missing__sub' }, pageName(pageId) + ' · ' + styleName(styleId)),
        h('code', { class: 'missing__path' }, pageFile(pageId, styleId)),
      ]),
    ]);
  }

  function updateMetaTip(pageId, styleId, node, missing) {
    let size = 'снимок не найден';
    if (!missing) {
      const page = findIn(PAGES, pageId);
      const fromFile = node.naturalWidth ? Math.round(node.naturalHeight * PAGE_WIDTH / node.naturalWidth) : 0;
      const fromData = page && page.heights ? Number(page.heights[styleId]) || 0 : 0;
      const hCss = fromFile || fromData;
      if (hCss) size = PAGE_WIDTH + ' × ' + hCss.toLocaleString('ru-RU') + ' px';
    }
    el.meta.title = pageName(pageId) + ' · ' + styleName(styleId) + ' · ' + size;
  }

  function neighbours(styleId) {
    const n = STYLES.length;
    const i = Math.max(0, styleIndex(styleId));
    const ids = [];
    if (n > 1) ids.push(STYLES[(i + 1) % n].id);
    if (n > 2) ids.push(STYLES[(i - 1 + n) % n].id);
    return ids;
  }

  function idle(fn) {
    if ('requestIdleCallback' in window) window.requestIdleCallback(fn, { timeout: 1500 });
    else fn();
  }

  function schedulePreload() {
    clearTimeout(preloadTimer);
    preloadTimer = setTimeout(() => {
      idle(() => neighbours(state.style).forEach((sid) => getImg(pageUrl(state.page, sid), true)));
    }, 250);
  }

  // Под открытым KV страница догружается не сразу: стрелки листают KV быстро.
  function deferPage() {
    pageToken++;
    setBusy('page', false);
    clearTimeout(kvPageTimer);
    kvPageTimer = setTimeout(loadPage, KV_PAGE_DELAY);
  }

  /* ---------- Ключевой визуал ---------- */

  async function loadKv() {
    const token = ++kvToken;
    const s = findIn(STYLES, state.style);
    const key = s.id + '|' + (s.kv || '');
    if (!el.kvBox.firstChild) renderKvHead(s);
    if (key === kvShownKey) {
      renderKvHead(s);
      setBusy('kv', false);
      return;
    }

    let node;
    if (!s.kv) {
      node = kvCard('Ключевой визуал для этого стиля появится позже', s.name);
    } else {
      setBusy('kv', true);
      try {
        const img = getImg(withVersion(s.kv));
        await whenLoaded(img);
        if (token !== kvToken) return;
        await decodeQuietly(img);
        if (token !== kvToken) return;
        img.className = 'kv__img';
        img.alt = 'Ключевой визуал – ' + s.name;
        img.draggable = false;
        node = img;
      } catch (err) {
        if (token !== kvToken) return;
        node = kvCard('Ключевой визуал ещё не загружен', s.name, s.kv);
      }
    }

    el.kvBox.replaceChildren(node);
    kvShownKey = key;
    renderKvHead(s);
    setBusy('kv', false);
    idle(() => neighbours(s.id).forEach((sid) => {
      const n = findIn(STYLES, sid);
      if (n && n.kv) getImg(withVersion(n.kv), true);
    }));
  }

  function renderKvHead(s) {
    el.kvEyebrow.textContent = 'Ключевой визуал · стиль ' + (styleIndex(s.id) + 1) + ' из ' + STYLES.length;
    el.kvName.textContent = s.name;
  }

  function kvCard(title, sub, path) {
    return h('div', { class: 'kv-card' }, [
      h('div', { class: 'kv-card__mark', 'aria-hidden': 'true' }, 'KV'),
      h('p', { class: 'kv-card__title' }, title),
      h('p', { class: 'kv-card__sub' }, sub),
      path ? h('code', { class: 'kv-card__path' }, path) : null,
    ]);
  }

  function setKvOpen(open) {
    root.classList.toggle('is-kv', open);
    el.kv.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (open) {
      lastFocus = document.activeElement;
      el.kv.focus({ preventScroll: true });
    } else {
      kvToken++;
      busy.kv = false;
      if (kvPageTimer) loadPage();
      if (el.kv.contains(document.activeElement)) {
        if (lastFocus && lastFocus !== document.body && document.contains(lastFocus)) {
          lastFocus.focus({ preventScroll: true });
        } else {
          document.activeElement.blur();
        }
      }
      lastFocus = null;
    }
    refreshBusy();
  }

  /* ---------- Переходы ---------- */

  function apply(next) {
    const pageChanged = next.page !== state.page;
    const styleChanged = next.style !== state.style;
    const kvChanged = next.kv !== state.kv;
    state.page = next.page;
    state.style = next.style;
    state.kv = next.kv;
    if (pageChanged) toTop = true;

    render();
    writeHash();

    if (kvChanged) setKvOpen(state.kv);
    if (state.kv && (styleChanged || kvChanged)) loadKv();

    if (pageChanged) loadPage();
    else if (styleChanged) {
      if (state.kv) deferPage();
      else loadPage();
    }
  }

  const go = (patch) => apply(Object.assign({}, state, patch));
  const selectStyle = (id) => go({ style: id });
  const selectPage = (id) => go({ page: id, kv: false });
  const toggleKv = (force) => go({ kv: typeof force === 'boolean' ? force : !state.kv });

  function stepStyle(delta) {
    const n = STYLES.length;
    const i = Math.max(0, styleIndex(state.style));
    selectStyle(STYLES[(i + delta + n) % n].id);
  }

  /* ---------- Адрес ---------- */

  function parseHash(hash, base) {
    let raw = String(hash || '').replace(/^#!?\/?/, '');
    try { raw = decodeURIComponent(raw); } catch (e) { /* оставляем как есть */ }
    const out = { page: base.page, style: base.style, kv: false };
    raw.split('/').map((t) => t.trim()).filter(Boolean).forEach((t) => {
      const page = findIn(PAGES, t);
      const style = findIn(STYLES, t);
      if (page) out.page = page.id;
      else if (style) out.style = style.id;
      else if (t.toLowerCase() === 'kv') out.kv = true;
      else if (/^\d+$/.test(t) && STYLES[Number(t) - 1]) out.style = STYLES[Number(t) - 1].id;
    });
    return out;
  }

  function writeHash() {
    const want = '#' + state.page + '/' + state.style + (state.kv ? '/kv' : '');
    if (location.hash === want) return;
    const url = location.href.split('#')[0] + want; // полный адрес этого же документа, без опоры на <base>
    try {
      history.replaceState(history.state, '', url);
    } catch (e) {
      location.replace(url); // вызовет hashchange, но состояние уже совпадает – ничего не произойдёт
    }
  }

  /* ---------- Панель ---------- */

  const pageName = (id) => (findIn(PAGES, id) || { name: id }).name;
  const styleName = (id) => (findIn(STYLES, id) || { name: id }).name;

  function buildBar() {
    pageButtons = PAGES.map((p, i) => {
      const keys = [PAGE_LETTERS[i] ? PAGE_LETTERS[i].toUpperCase() : '', i < 9 ? 'Shift+' + (i + 1) : '']
        .filter(Boolean).join(' или ');
      return h('button', {
        type: 'button',
        class: 'btn',
        'data-page': p.id,
        'aria-pressed': 'false',
        title: p.name + (keys ? ' – ' + keys : ''),
      }, p.name);
    });
    el.pageSeg.replaceChildren(...pageButtons);

    styleButtons = STYLES.map((s, i) => h('button', {
      type: 'button',
      class: 'btn sbtn',
      'data-style': s.id,
      'data-tip': s.name,
      'aria-pressed': 'false',
      'aria-label': (i + 1) + '. ' + s.name,
    }, [
      h('span', { class: 'sbtn__n', 'aria-hidden': 'true' }, String(i + 1)),
      h('span', { class: 'sbtn__s', 'aria-hidden': 'true' }, s.short || s.name),
    ]));
    el.styleSeg.replaceChildren(...styleButtons);
  }

  function render() {
    const i = Math.max(0, styleIndex(state.style));
    const s = STYLES[i];
    pageButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.page === state.page)));
    styleButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.style === state.style)));
    el.metaName.textContent = s.name;
    el.pillNum.textContent = String(i + 1);
    el.pillName.textContent = s.short || s.name;
    el.pill.title = s.name + ' · ' + pageName(state.page) + ' – показать панель (H)';
    el.kvBtn.setAttribute('aria-pressed', String(state.kv));
    el.kvBtn.classList.toggle('is-empty', !s.kv);
    el.kvBtn.title = s.kv
      ? 'Ключевой визуал стиля – K'
      : 'Ключевой визуал стиля – K (для этого стиля его пока нет)';
  }

  function setPanel(visible) {
    root.classList.toggle('is-bar-hidden', !visible);
    if (!visible && el.bar.contains(document.activeElement)) document.activeElement.blur();
  }

  const panelVisible = () => !root.classList.contains('is-bar-hidden');

  /* ---------- Подсказка при первом входе ---------- */

  const introOpen = () => !el.intro.hidden;

  function openIntro() {
    el.intro.hidden = false;
    el.introOk.focus({ preventScroll: true });
  }

  function closeIntro() {
    if (el.intro.hidden) return;
    el.intro.hidden = true;
    try { localStorage.setItem(INTRO_KEY, '1'); } catch (e) { /* без памяти – покажем ещё раз */ }
    if (el.intro.contains(document.activeElement)) document.activeElement.blur();
  }

  /* ---------- Клавиши ---------- */

  function onKey(e) {
    if (e.defaultPrevented || e.isComposing) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return; // браузерные сочетания не трогаем
    const t = e.target;
    if (t && t.nodeType === 1 &&
        (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;

    const key = e.key || '';
    const code = e.code || '';

    if (key === 'Escape') {
      if (introOpen()) closeIntro();
      else if (state.kv) toggleKv(false);
      else return;
      e.preventDefault();
      return;
    }

    // Буква по физической клавише: работает и в русской раскладке.
    const letter = /^Key[A-Z]$/.test(code)
      ? code.slice(3).toLowerCase()
      : (RU_LETTERS[key.toLowerCase()] || key.toLowerCase());
    // Цифры верхнего ряда – по физической клавише (Shift+1 даёт «!»), цифровой блок – только при NumLock.
    const digit = /^Digit([1-9])$/.exec(code);
    const n = digit ? Number(digit[1]) : (/^[1-9]$/.test(key) ? Number(key) : 0);

    let action = null;
    if (key === 'ArrowRight') action = () => stepStyle(1);
    else if (key === 'ArrowLeft') action = () => stepStyle(-1);
    else if (key === '?') action = () => (introOpen() ? closeIntro() : openIntro());
    else if (letter === 'k') action = e.repeat ? () => {} : () => toggleKv();
    else if (letter === 'h') action = e.repeat ? () => {} : () => setPanel(!panelVisible());
    else if (PAGE_LETTERS.indexOf(letter) >= 0 && !e.shiftKey) {
      const p = PAGES[PAGE_LETTERS.indexOf(letter)];
      if (p) action = () => selectPage(p.id);
    } else if (n) {
      if (e.shiftKey) {
        if (PAGES[n - 1]) action = () => selectPage(PAGES[n - 1].id);
      } else if (STYLES[n - 1]) {
        action = () => selectStyle(STYLES[n - 1].id);
      }
    }

    if (!action) return;
    e.preventDefault();
    if (introOpen() && key !== '?') closeIntro();
    action();
  }

  /* ---------- Запуск ---------- */

  function init() {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

    document.querySelectorAll('[data-title]').forEach((n) => { n.textContent = TITLE; });
    document.querySelectorAll('[data-count]').forEach((n) => { n.textContent = String(Math.min(STYLES.length, 9)); });

    buildBar();

    // Мышью нажатая кнопка не должна держать фокус: иначе пробел нажмёт её, а не пролистает страницу.
    const blurIfMouse = (e, b) => { if (e.detail) b.blur(); };

    el.pageSeg.addEventListener('click', (e) => {
      const b = e.target.closest('[data-page]');
      if (!b) return;
      blurIfMouse(e, b);
      selectPage(b.dataset.page);
    });
    el.styleSeg.addEventListener('click', (e) => {
      const b = e.target.closest('[data-style]');
      if (!b) return;
      blurIfMouse(e, b);
      selectStyle(b.dataset.style);
    });
    el.kvBtn.addEventListener('click', (e) => { blurIfMouse(e, el.kvBtn); toggleKv(); });
    el.helpBtn.addEventListener('click', (e) => {
      blurIfMouse(e, el.helpBtn);
      if (introOpen()) closeIntro(); else openIntro();
    });
    el.hideBtn.addEventListener('click', () => setPanel(false));
    el.pill.addEventListener('click', (e) => {
      blurIfMouse(e, el.pill);
      setPanel(true);
    });
    el.kvPrev.addEventListener('click', (e) => { blurIfMouse(e, el.kvPrev); stepStyle(-1); });
    el.kvNext.addEventListener('click', (e) => { blurIfMouse(e, el.kvNext); stepStyle(1); });
    el.kvClose.addEventListener('click', () => toggleKv(false));
    el.introOk.addEventListener('click', closeIntro);
    el.intro.addEventListener('click', (e) => { if (e.target === el.intro) closeIntro(); });

    document.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', () => apply(parseHash(location.hash, state)));

    // Отступ снизу страницы и экрана KV = реальная высота панели.
    if ('ResizeObserver' in window) {
      new ResizeObserver(() => {
        root.style.setProperty('--bar-space', Math.ceil(el.bar.offsetHeight + 28) + 'px');
      }).observe(el.bar);
    }

    apply(parseHash(location.hash, { page: DEFAULT_PAGE, style: DEFAULT_STYLE }));

    let seen = false;
    try { seen = localStorage.getItem(INTRO_KEY) === '1'; } catch (e) { /* нет доступа – считаем, что не видели */ }
    if (!seen) openIntro();
  }

  init();
})();
