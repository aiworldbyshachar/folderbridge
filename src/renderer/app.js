'use strict';

(async function main() {
  const I18N = window.FolderBridgeI18n;
  let tr = I18N.createTranslator(new URLSearchParams(location.search).get('lang') || 'en');
  const t = (key, vars) => tr.t(key, vars);

  // Locale-aware formatters, rebuilt whenever the language changes.
  let fmt = {};
  function buildFormatters() {
    fmt = {
      rtf: new Intl.RelativeTimeFormat(tr.code, { numeric: 'auto' }),
      time: new Intl.DateTimeFormat(tr.code, { hour: '2-digit', minute: '2-digit' }),
      dateTime: new Intl.DateTimeFormat(tr.code, { dateStyle: 'medium', timeStyle: 'short' }),
      day: new Intl.DateTimeFormat(tr.code, { weekday: 'long', day: 'numeric', month: 'long' }),
      dayWithYear: new Intl.DateTimeFormat(tr.code, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
      number: new Intl.NumberFormat(tr.code, { maximumFractionDigits: 1 }),
    };
  }

  // Static text in the page carries data-i18n* attributes.
  function translatePage() {
    document.documentElement.lang = tr.code;
    document.documentElement.dir = tr.dir;
    for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of document.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
    for (const el of document.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
    for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
    for (const el of document.querySelectorAll('[data-i18n-title]')) {
      el.title = t(el.dataset.i18nTitle);
      el.setAttribute('aria-label', el.title);
    }
  }

  buildFormatters();
  translatePage();

  // Outside Electron (design preview in a browser) a mock API stands in.
  if (!window.api) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '../../dev/mock-api.js';
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  const api = window.api;
  const isMac = api.platform === 'darwin';

  const PAGE = 100;
  // Other computers; this one always uses the accent color.
  const DEVICE_COLORS = ['#0e9f6e', '#d97706', '#db2777', '#0891b2', '#65a30d'];

  const ICONS = {
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
    back: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    trash: '<path d="M4 7h16M9 7V4.5h6V7M18 7l-.8 12.5a1.5 1.5 0 0 1-1.5 1.5H8.3a1.5 1.5 0 0 1-1.5-1.5L6 7M10 11v6M14 11v6"/>',
    folder: '<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4.2l2 2H19a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
    laptop: '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19.5h20"/>',
    desktop: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8.5 20h7M12 16v4"/>',
    device: '<rect x="6" y="3" width="12" height="18" rx="2"/><path d="M11 18h2"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    sync: '<path d="M20 12a8 8 0 0 1-14.2 5M4 12a8 8 0 0 1 14.2-5"/><path d="M18.5 3v4h-4M5.5 21v-4h4"/>',
    pause: '<path d="M9 6v12M15 6v12"/>',
    warn: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17.2v.1"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
    move: '<path d="M4 12h14M13 7l5 5-5 5"/>',
    restore: '<path d="M4 12a8 8 0 1 0 2.5-5.8"/><path d="M4 4v4.5h4.5"/>',
    show: '<path d="M14 4h6v6M20 4l-8.5 8.5"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
    off: '<path d="M4 4l16 16"/><path d="M8.5 5.5a8 8 0 0 1 11 11M5.2 8.3a8 8 0 0 0 10.5 10.5"/>',
  };

  const svg = (name) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  // A translated sentence with one element (a <code>, a <kbd>) placed inside it.
  function tWith(key, name, node, vars) {
    const MARK = '\u0001';
    const [before, after = ''] = t(key, { ...vars, [name]: MARK }).split(MARK);
    return [before, node, after];
  }

  const $ = (sel) => document.querySelector(sel);
  for (const el of document.querySelectorAll('[data-icon]')) el.innerHTML = svg(el.dataset.icon);

  const els = {
    status: $('#status'),
    syncLine: $('#sync-line'),
    progress: $('#progress'),
    devices: $('#devices'),
    banners: $('#banners'),
    search: $('#search'),
    filters: $('#filters'),
    list: $('#list'),
    count: $('#count'),
    hint: $('#shortcut-hint'),
    settings: $('#settings'),
    trash: $('#trash'),
    toast: $('#toast'),
  };

  const S = {
    app: null,
    q: '',
    filter: 'all',
    items: [],
    total: 0,
    loadingMore: false,
    busy: new Set(), // conflicts being settled
  };

  // ---------- formatting ----------

  const startOfDay = (ts) => {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };

  function dayLabel(ts) {
    const diff = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / 86400000);
    if (diff === 0) return t('today');
    if (diff === 1) return t('yesterday');
    const sameYear = new Date(ts).getFullYear() === new Date().getFullYear();
    return (sameYear ? fmt.day : fmt.dayWithYear).format(ts);
  }

  function timeLabel(ts) {
    const diff = Date.now() - ts;
    if (diff < 45e3) return fmt.rtf.format(0, 'second');
    if (diff < 3600e3) return fmt.rtf.format(-Math.max(1, Math.round(diff / 60e3)), 'minute');
    if (startOfDay(ts) === startOfDay(Date.now())) return fmt.time.format(ts);
    return fmt.dateTime.format(ts);
  }

  function formatBytes(n) {
    if (!n) return t('bytes', { n: 0 });
    if (n < 1024) return t('bytes', { n });
    if (n < 1024 * 1024) return `${fmt.number.format(Math.round(n / 1024))} KB`;
    if (n < 1024 * 1024 * 1024) return `${fmt.number.format(n / 1024 / 1024)} MB`;
    return `${fmt.number.format(n / 1024 / 1024 / 1024)} GB`;
  }

  function formatShortcut(acc) {
    if (!acc) return '';
    const parts = acc.replace('CommandOrControl', isMac ? 'Command' : 'Ctrl').split('+');
    if (!isMac) return parts.join('+');
    const map = { Command: '⌘', Cmd: '⌘', Ctrl: '⌃', Control: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧' };
    return parts.map((p) => map[p] || p).join('');
  }

  function hashColor(text) {
    let n = 0;
    for (const ch of String(text)) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
    return DEVICE_COLORS[n % DEVICE_COLORS.length];
  }

  const platformIcon = (platform) => (platform === 'darwin' ? 'laptop' : platform === 'win32' ? 'desktop' : 'device');

  // "Documents/Q3/report.docx" -> { name: "report.docx", dir: "Documents/Q3" }
  function splitKey(key) {
    const i = key.lastIndexOf('/');
    return i < 0 ? { name: key, dir: '' } : { name: key.slice(i + 1), dir: key.slice(0, i) };
  }

  function baseOf(p) {
    return String(p).split(/[\\/]/).filter(Boolean).pop() || p;
  }

  // ---------- toast ----------

  let toastTimer;
  function toast(text) {
    els.toast.textContent = text;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 1800);
  }

  // ---------- header and folder card ----------

  function renderStatus() {
    const app = S.app;
    const online = app.status.peers.filter((p) => p.online);
    let cls = 'searching';
    let label = t('statusSearching');
    if (app.settings.paused) {
      cls = 'paused';
      label = t('statusPaused');
    } else if (online.length === 1) {
      cls = 'online';
      label = t('statusConnectedTo', { name: online[0].name });
    } else if (online.length > 1) {
      cls = 'online';
      label = t('statusConnectedMany', { n: online.length });
    }
    els.status.className = `status ${cls}`;
    els.status.querySelector('.status-label').textContent = label;
  }

  function syncState(s) {
    switch (s.state) {
      case 'syncing':
        return {
          cls: 'busy',
          icon: 'sync',
          title: t('stSyncing', { n: s.pending }),
          detail: s.bytesLeft ? t('stLeft', { size: formatBytes(s.bytesLeft) }) : t('stSyncingDetail'),
        };
      case 'alone':
        return { cls: '', icon: 'off', title: t('stAlone'), detail: s.pending ? t('stAloneWaiting', { n: s.pending }) : t('stAloneDetail') };
      case 'paused':
        return { cls: 'warn', icon: 'pause', title: t('stPaused'), detail: t('stPausedDetail') };
      case 'conflicts':
        return { cls: 'warn', icon: 'warn', title: t('stConflicts', { n: s.conflicts }), detail: t('stConflictsDetail') };
      case 'confirm-delete':
        return { cls: 'warn', icon: 'warn', title: t('stConfirmDelete'), detail: t('stConfirmDeleteDetail', { n: s.holdDeletes }) };
      case 'unavailable':
        return { cls: 'warn', icon: 'warn', title: t('stUnavailable'), detail: t('stUnavailableDetail') };
      default:
        return { cls: 'ok', icon: 'check', title: t('stUpToDate'), detail: t('files', { n: s.files }) };
    }
  }

  function renderFolder() {
    const app = S.app;
    const s = app.status;
    $('#folder-name').textContent = baseOf(app.settings.folder);
    $('#folder-path').textContent = app.settings.folder;
    $('#folder-path').title = app.settings.folder;

    const st = syncState(s);
    els.syncLine.className = `sync-line ${st.cls}`;
    els.syncLine.querySelector('.sync-icon').innerHTML = svg(st.icon);
    els.syncLine.querySelector('b').textContent = st.title;
    const transfer = s.transfers[0];
    els.syncLine.querySelector('small').textContent =
      s.state === 'syncing' && transfer ? t('stReceiving', { name: splitKey(transfer.path).name, device: transfer.peer }) : st.detail;

    // Progress of the file arriving right now (or a moving bar when there's no size).
    const bar = els.progress.querySelector('span');
    els.progress.hidden = s.state !== 'syncing';
    if (transfer && transfer.size) {
      els.progress.classList.remove('indeterminate');
      bar.style.width = `${Math.min(100, (transfer.done / transfer.size) * 100).toFixed(1)}%`;
    } else {
      els.progress.classList.add('indeterminate');
      bar.style.width = '';
    }

    const chips = [];
    for (const p of [...s.peers].sort((a, b) => b.online - a.online)) {
      chips.push(
        h(
          'span',
          { class: `dev-chip${p.online ? ' online' : ''}`, title: p.online ? t('peerOnline') : t('peerOffline') },
          h('span', { html: svg(platformIcon(p.platform)) }),
          h('span', { dir: 'auto' }, p.name),
          h('span', { class: 'dot' })
        )
      );
    }
    els.devices.replaceChildren(...chips);
  }

  // ---------- banners ----------

  function banner(kind, title, body, actions) {
    return h(
      'div',
      { class: `banner${kind ? ` ${kind}` : ''}` },
      h('div', { class: 'body' }, h('b', { dir: 'auto' }, title), body ? h('p', {}, body) : null, actions && actions.length ? h('div', { class: 'actions' }, actions) : null)
    );
  }

  const button = (label, onclick, kind) => h('button', { class: `btn small${kind ? ` ${kind}` : ''}`, type: 'button', onclick }, label);

  function nameList(paths) {
    const shown = paths.slice(0, 3).map((p) => `“${splitKey(p).name}”`);
    const more = paths.length - shown.length;
    return more > 0 ? t('andMore', { names: shown.join(', '), n: more }) : shown.join(', ');
  }

  async function resolve(conf, choice) {
    if (S.busy.has(conf.id)) return;
    S.busy.add(conf.id);
    renderBanners();
    const res = await api.resolveConflict(conf.id, choice);
    S.busy.delete(conf.id);
    if (res && res.ok) toast(t('toastResolved'));
    else toast((res && res.error) || t('toastSaveFailed'));
    refreshState();
  }

  function renderBanners() {
    const app = S.app;
    const s = app.status;
    const out = [];
    if (app.listenError) out.push(banner('warn', t('bannerNetworkTitle'), t('bannerNetworkBody', { error: app.listenError })));

    if (s.state === 'unavailable') {
      out.push(
        banner('warn', t('bannerUnavailableTitle'), tWith('bannerUnavailableBody', 'path', h('code', { dir: 'ltr' }, app.settings.folder)), [
          button(t('chooseFolder'), () => chooseFolder()),
        ])
      );
    }

    if (s.holdDeletes) {
      out.push(
        banner('warn', t('bannerDeleteTitle', { n: s.holdDeletes }), t('bannerDeleteBody'), [
          button(t('deleteHereToo'), () => api.approveDeletes().then(refreshState)),
          button(t('keepMyFiles'), () => api.keepFiles().then(refreshState), 'primary'),
        ])
      );
    }

    for (const conf of app.conflicts.slice(0, 5)) {
      const { name } = splitKey(conf.path);
      const theirs = t('versionInfo', { size: formatBytes(conf.remote.size), time: timeLabel(conf.remote.mtime) });
      const mine = conf.local ? t('versionInfo', { size: formatBytes(conf.local.size), time: timeLabel(conf.local.mtime) }) : t('deletedHere');
      const busy = S.busy.has(conf.id);
      out.push(
        banner('warn', t('bannerConflictTitle', { name }), t('bannerConflictBody', { device: conf.remote.device, theirs, mine }), [
          button(t('keepMine'), () => resolve(conf, 'local')),
          button(t('keepTheirs', { device: conf.remote.device }), () => resolve(conf, 'remote')),
          button(t('keepBoth'), () => resolve(conf, 'both'), 'primary'),
        ].map((b) => {
          if (busy) b.disabled = true;
          return b;
        }))
      );
    }
    if (app.conflicts.length > 5) out.push(banner('warn', t('moreConflicts', { n: app.conflicts.length - 5 }), ''));

    // Problems, one banner per kind.
    const groups = {};
    for (const p of s.problems) (groups[p.type === 'windows-name' ? `win-${p.side}` : p.type] ||= []).push(p);
    if (groups['win-local']) {
      const paths = groups['win-local'].map((p) => p.path);
      out.push(banner('warn', t('probWinLocalTitle'), t('probWinLocalBody', { names: nameList(paths) }), [button(t('show'), () => api.showFile(paths[0]))]));
    }
    if (groups['win-remote']) {
      const paths = groups['win-remote'].map((p) => p.path);
      const device = groups['win-remote'][0].device || t('otherComputer');
      out.push(banner('warn', t('probWinRemoteTitle', { device }), t('probWinRemoteBody', { names: nameList(paths), device })));
    }
    if (groups.case) {
      const p = groups.case[0];
      out.push(banner('warn', t('probCaseTitle'), t('probCaseBody', { a: splitKey(p.path).name, b: splitKey(p.twin || p.path).name })));
    }
    if (groups.locked) {
      const paths = groups.locked.map((p) => p.path);
      out.push(banner('', t('probLockedTitle', { names: nameList(paths) }), t('probLockedBody')));
    }
    if (groups['disk-full']) out.push(banner('warn', t('probDiskTitle'), t('probDiskBody')));

    if (app.settings.paused) {
      out.push(banner('warn', t('bannerPausedTitle'), t('bannerPausedBody'), [button(t('resumeSync'), () => updateSetting({ paused: false }))]));
    }

    const online = s.peers.filter((p) => p.online);
    if (!online.length && s.foreign.length) {
      out.push(
        banner('', t('bannerForeignTitle', { name: s.foreign[0].name }), t('bannerForeignBody'), [
          button(t('enterCode'), () => openSettings('#code-input'), 'primary'),
        ])
      );
    } else if (!s.peers.length && !s.foreign.length) {
      out.push(
        banner('', t('bannerAloneTitle'), tWith('bannerAloneBody', 'code', h('code', { dir: 'ltr' }, app.settings.code)), [
          button(t('copyCode'), () => copyCode()),
          button(t('settings'), () => openSettings()),
        ])
      );
    }
    els.banners.replaceChildren(...out);
  }

  // ---------- activity list ----------

  function renderFilters() {
    const chips = [
      { key: 'all', label: t('filterAll') },
      { key: 'local', label: t('filterLocal') },
      { key: 'remote', label: t('filterRemote') },
      { key: 'conflict', label: t('filterConflicts') },
    ];
    els.filters.replaceChildren(
      ...chips.map((c) =>
        h('button', { class: 'chip', type: 'button', 'aria-pressed': String(S.filter === c.key), onclick: () => setFilter(c.key) }, c.label)
      )
    );
  }

  function renderFooter() {
    const s = S.app.status;
    els.count.textContent = S.q || S.filter !== 'all' ? t('results', { n: S.total }) : t('filesInFolder', { n: s.files });
    const acc = S.app.settings.shortcut;
    els.hint.replaceChildren(...(acc ? tWith('quickOpen', 'shortcut', h('kbd', { dir: 'ltr' }, formatShortcut(acc))) : []));
  }

  // Every reload bumps this, so a slow, older response can't overwrite a newer one.
  let listVersion = 0;

  async function loadList(keep) {
    const version = ++listVersion;
    const limit = keep ? Math.max(PAGE, S.items.length) : PAGE;
    const res = await api.activity({ q: S.q, filter: S.filter, offset: 0, limit });
    if (version !== listVersion) return;
    S.items = res.items;
    S.total = res.total;
    if (!keep) els.list.scrollTop = 0;
    renderList();
    renderFooter();
  }

  async function loadMore() {
    if (S.loadingMore || S.items.length >= S.total) return;
    S.loadingMore = true;
    const version = listVersion;
    try {
      const res = await api.activity({ q: S.q, filter: S.filter, offset: S.items.length, limit: PAGE });
      if (version !== listVersion) return;
      S.items = S.items.concat(res.items);
      S.total = res.total;
      renderList();
    } finally {
      S.loadingMore = false;
    }
  }

  const ACTION_ICONS = { added: 'plus', changed: 'edit', deleted: 'trash', moved: 'move', conflict: 'warn', restored: 'restore' };

  function actionText(e) {
    switch (e.action) {
      case 'added':
        return t('actAdded');
      case 'changed':
        return t('actChanged');
      case 'deleted':
        return e.local ? t('actDeleted') : t('actDeletedTrash');
      case 'moved': {
        const from = splitKey(e.from || '');
        return from.dir === splitKey(e.path).dir ? t('actRenamed', { name: from.name }) : t('actMoved', { dir: from.dir || '/' });
      }
      case 'restored':
        return t('actRestored');
      case 'conflict':
        if (e.resolved === 'local') return t('actResolvedLocal');
        if (e.resolved === 'remote') return t('actResolvedRemote');
        if (e.resolved === 'both') return t('actResolvedBoth');
        if (e.kept === 'both') return t('actKeptBoth');
        if (e.kept) return t('actKeptNewest');
        if (e.path.includes(' (conflict - ')) return t('actConflictCopy');
        return t('actConflict');
      default:
        return '';
    }
  }

  // Details joined by a middle dot. Separate elements (not CSS) so they stay
  // in the right place when right-to-left and left-to-right text mix.
  function metaLine(parts) {
    const out = [];
    for (const p of parts) {
      if (out.length) out.push(h('i', { class: 'sep', 'aria-hidden': 'true' }, '·'));
      out.push(p);
    }
    return out;
  }

  function renderItem(e) {
    const { name, dir } = splitKey(e.path);
    const who = h('span', { class: 'who' }, e.local ? t('thisComputer') : e.device || t('otherComputer'));
    who.style.setProperty('--c', e.local ? 'var(--accent)' : hashColor(e.device));
    const meta = [who, h('span', {}, actionText(e))];
    if (dir) meta.push(h('span', { title: dir }, dir));
    if (e.size && e.action !== 'deleted') meta.push(h('span', { dir: 'ltr' }, formatBytes(e.size)));
    meta.push(h('span', { class: 'when', title: fmt.dateTime.format(e.ts) }, timeLabel(e.ts)));
    return h(
      'article',
      { class: `act${e.exists ? '' : ' gone'}`, 'data-ts': e.ts },
      h('span', { class: `act-icon ${e.action}`, html: svg(ACTION_ICONS[e.action] || 'edit') }),
      h('div', { class: 'act-main' }, h('div', { class: 'act-name', title: e.path }, name), h('div', { class: 'act-meta' }, metaLine(meta))),
      e.exists
        ? h('button', {
            class: 'icon-btn',
            type: 'button',
            title: t(isMac ? 'showInFinder' : 'showInExplorer'),
            html: svg('show'),
            onclick: () => api.showFile(e.path),
          })
        : null
    );
  }

  function renderList() {
    const scroll = els.list.scrollTop;
    if (!S.items.length) {
      const searching = S.q || S.filter !== 'all';
      const body = searching ? (S.q ? t('emptyNoMatch', { q: S.q }) : t('emptyNoFilter')) : t('emptyActivityBody');
      els.list.replaceChildren(
        h(
          'div',
          { class: 'empty' },
          h('div', { class: 'art', html: svg(searching ? 'search' : 'folder') }),
          h('b', {}, searching ? t('emptyNoResults') : t('emptyActivity')),
          h('p', {}, body)
        )
      );
      return;
    }
    const nodes = [];
    let lastDay = null;
    for (const e of S.items) {
      const day = startOfDay(e.ts);
      if (day !== lastDay) {
        nodes.push(h('div', { class: 'day' }, dayLabel(e.ts)));
        lastDay = day;
      }
      nodes.push(renderItem(e));
    }
    const sentinel = h('div', { class: 'sentinel' });
    nodes.push(sentinel);
    els.list.replaceChildren(...nodes);
    els.list.scrollTop = scroll;
    sentinelObserver.disconnect();
    sentinelObserver.observe(sentinel);
  }

  const sentinelObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMore();
    },
    { root: els.list, rootMargin: '400px' }
  );

  function setFilter(key) {
    S.filter = key;
    renderFilters();
    loadList(false);
  }

  // ---------- trash ----------

  function reasonText(item) {
    if (item.reason === 'replaced') return item.byName ? t('trashReplacedBy', { device: item.byName }) : t('trashReplaced');
    if (item.reason === 'conflict') return t('trashConflict');
    return item.byName ? t('trashDeletedOn', { device: item.byName }) : t('trashDeleted');
  }

  async function renderTrash() {
    const items = await api.trash();
    const list = $('#trash-list');
    if (!items.length) {
      list.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'art', html: svg('trash') }), h('b', {}, t('trashEmpty')), h('p', {}, t('trashEmptyBody'))));
      return;
    }
    list.replaceChildren(
      ...items.map((item) => {
        const { dir } = splitKey(item.path);
        const meta = [h('span', {}, reasonText(item))];
        if (dir) meta.push(h('span', {}, dir));
        if (item.size) meta.push(h('span', { dir: 'ltr' }, formatBytes(item.size)));
        meta.push(h('span', { class: 'when', title: fmt.dateTime.format(item.at) }, timeLabel(item.at)));
        return h(
          'article',
          { class: 'act' },
          h('span', { class: 'act-icon', html: svg('trash') }),
          h('div', { class: 'act-main' }, h('div', { class: 'act-name', title: item.path }, item.name), h('div', { class: 'act-meta' }, metaLine(meta))),
          h(
            'button',
            {
              class: 'btn small',
              type: 'button',
              onclick: async () => {
                const res = await api.restore(item.id);
                if (res && res.ok) toast(t('toastRestored', { name: splitKey(res.path).name }));
                else toast((res && res.error) || t('toastSaveFailed'));
                renderTrash();
              },
            },
            t('restore')
          )
        );
      })
    );
  }

  function openTrash() {
    els.settings.hidden = true;
    els.trash.hidden = false;
    renderTrash();
    setTimeout(() => $('#close-trash').focus(), 50);
  }

  function closeTrash() {
    els.trash.hidden = true;
    els.search.focus();
  }

  // ---------- settings ----------

  function openSettings(focusSel) {
    els.trash.hidden = true;
    els.settings.hidden = false;
    renderSettings();
    const target = focusSel ? $(focusSel) : $('#close-settings');
    if (target) setTimeout(() => target.focus(), 50);
  }

  function closeSettings() {
    els.settings.hidden = true;
    stopRecording();
    els.search.focus();
  }

  function showMsg(sel, text, kind) {
    const el = $(sel);
    el.textContent = text;
    el.className = `msg ${kind || ''}`;
    el.hidden = !text;
  }

  const languageSelect = $('#language');
  languageSelect.replaceChildren(...I18N.LANGUAGES.map((l) => h('option', { value: l.code, lang: l.code, dir: l.dir }, l.name)));
  languageSelect.addEventListener('change', () => updateSetting({ language: languageSelect.value }));

  function renderSettings() {
    const app = S.app;
    if (!app || els.settings.hidden) return;
    languageSelect.value = tr.code;
    $('#code').textContent = app.settings.code;
    $('#folder-setting').textContent = app.settings.folder;
    $('#reset-folder').hidden = app.isDefaultFolder;
    const name = $('#device-name');
    if (document.activeElement !== name) name.value = app.settings.deviceName;
    const sc = $('#shortcut');
    if (!sc.classList.contains('recording')) sc.value = formatShortcut(app.settings.shortcut);
    $('#clear-shortcut').hidden = !app.settings.shortcut;
    for (const input of document.querySelectorAll('[data-setting]')) input.checked = !!app.settings[input.dataset.setting];
    for (const radio of document.querySelectorAll('input[name="conflictMode"]')) radio.checked = radio.value === app.settings.conflictMode;
    $('#login-hint').textContent = t(isMac ? 'loginHintMac' : 'loginHintWin');
    $('#login-approval').hidden = !(app.settings.openAtLogin && app.loginStatus === 'requires-approval');
    $('#my-addr').textContent = app.addresses.length ? app.addresses.join(' · ') : t('noNetwork');
    $('#version').textContent = app.version;

    const peerItems = [];
    for (const p of [...app.status.peers].sort((a, b) => b.online - a.online)) {
      const detail = p.online
        ? p.lastSyncAt
          ? t('peerSynced', { address: p.address, time: timeLabel(p.lastSyncAt) })
          : p.address
        : t('peerLastSeen', { time: timeLabel(p.lastSeen) });
      peerItems.push(
        h(
          'li',
          { class: 'peer' },
          h('span', { class: 'icon', html: svg(platformIcon(p.platform)) }),
          h('span', { class: 'who' }, h('b', { dir: 'auto' }, p.name), h('small', {}, detail)),
          h('span', { class: `badge ${p.online ? 'ok' : ''}` }, p.online ? t('peerOnline') : t('peerOffline'))
        )
      );
    }
    for (const f of app.status.foreign) {
      peerItems.push(
        h(
          'li',
          { class: 'peer' },
          h('span', { class: 'icon', html: svg(platformIcon(f.platform)) }),
          h('span', { class: 'who' }, h('b', { dir: 'auto' }, f.name), h('small', {}, t('peerForeignDetail', { address: f.address }))),
          h('span', { class: 'badge warn' }, t('peerForeignBadge'))
        )
      );
    }
    if (!peerItems.length) peerItems.push(h('li', { class: 'peer-empty' }, t('peersEmpty')));
    $('#peer-list').replaceChildren(...peerItems);

    $('#manual-list').replaceChildren(
      ...app.settings.manualPeers.map((addr) =>
        h(
          'li',
          {},
          h('span', { dir: 'ltr' }, addr),
          h('button', { class: 'icon-btn', type: 'button', title: t('remove'), html: svg('x'), onclick: () => api.removePeer(addr) })
        )
      )
    );
  }

  async function updateSetting(patch) {
    const res = await api.setSettings(patch);
    if (res && !res.ok) toast(res.error || t('toastSaveFailed'));
    return res;
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(S.app.settings.code);
      toast(t('toastCodeCopied'));
    } catch {
      toast(t('toastCantCopy'));
    }
  }

  async function chooseFolder() {
    showMsg('#folder-msg', '', '');
    const res = await api.chooseFolder();
    if (res && res.ok) {
      toast(t('toastFolderChanged'));
      refreshState();
    } else if (res && !res.canceled) {
      showMsg('#folder-msg', res.error || t('toastSaveFailed'), 'error');
      toast(res.error || t('toastSaveFailed'));
    }
  }

  // Two-step confirm for buttons with big consequences, without a modal.
  function confirmButton(btn, labelKey, confirmKey, action) {
    let timer;
    const reset = () => {
      clearTimeout(timer);
      btn.classList.remove('confirm');
      btn.textContent = t(labelKey);
    };
    btn.addEventListener('click', () => {
      if (btn.classList.contains('confirm')) {
        reset();
        action();
        return;
      }
      btn.classList.add('confirm');
      btn.textContent = t(confirmKey);
      timer = setTimeout(reset, 4000);
    });
  }

  $('#open-settings').addEventListener('click', () => openSettings());
  $('#open-trash').addEventListener('click', openTrash);
  els.status.addEventListener('click', () => openSettings());
  $('#close-settings').addEventListener('click', closeSettings);
  $('#close-trash').addEventListener('click', closeTrash);
  $('#open-trash-folder').addEventListener('click', () => api.showTrashFolder());
  $('#open-folder').addEventListener('click', () => api.openFolder());
  $('#copy-code').addEventListener('click', copyCode);
  $('#change-folder').addEventListener('click', chooseFolder);
  $('#reset-folder').addEventListener('click', async () => {
    const res = await api.resetFolder();
    if (res && res.ok) toast(t('toastFolderChanged'));
    else showMsg('#folder-msg', (res && res.error) || t('toastSaveFailed'), 'error');
    refreshState();
  });

  $('#apply-code').addEventListener('click', async () => {
    const value = $('#code-input').value.trim();
    if (!value) return showMsg('#code-msg', t('codeMissing'), 'error');
    const res = await api.setSettings({ code: value });
    if (res && res.ok) {
      $('#code-input').value = '';
      showMsg('#code-msg', t('codeUpdated'), 'ok');
    } else {
      showMsg('#code-msg', (res && res.error) || t('codeInvalid'), 'error');
    }
  });
  $('#code-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#apply-code').click();
  });

  confirmButton($('#regen-code'), 'newCode', 'regenConfirm', async () => {
    await api.regenerateCode();
    showMsg('#code-msg', t('regenDone'), 'ok');
  });

  $('#open-data').addEventListener('click', () => api.openDataDir());
  $('#sync-now').addEventListener('click', () => {
    api.syncNow();
    toast(t('toastSyncing'));
  });

  $('#device-name').addEventListener('change', (e) => updateSetting({ deviceName: e.target.value }));
  $('#device-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.target.blur();
  });

  for (const input of document.querySelectorAll('[data-setting]')) {
    input.addEventListener('change', () => updateSetting({ [input.dataset.setting]: input.checked }));
  }
  for (const radio of document.querySelectorAll('input[name="conflictMode"]')) {
    radio.addEventListener('change', async () => {
      if (!radio.checked) return;
      const res = await updateSetting({ conflictMode: radio.value });
      if (res && res.ok) toast(t('toastConflictMode'));
    });
  }

  $('#add-peer').addEventListener('click', async () => {
    const value = $('#peer-input').value.trim();
    if (!value) return;
    showMsg('#peer-msg', t('checking'), '');
    const res = await api.addPeer(value);
    if (!res.ok) return showMsg('#peer-msg', res.error, 'error');
    $('#peer-input').value = '';
    if (res.self) showMsg('#peer-msg', t('peerSelf'), 'error');
    else if (!res.found) showMsg('#peer-msg', t('peerNotFound'), 'error');
    else if (!res.sameCode) showMsg('#peer-msg', t('peerOtherCode', { name: res.name }), 'error');
    else showMsg('#peer-msg', t('peerConnected', { name: res.name }), 'ok');
  });
  $('#peer-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#add-peer').click();
  });

  // Shortcut recorder. Uses physical key codes so it works in any keyboard layout.
  const shortcutInput = $('#shortcut');
  function stopRecording() {
    shortcutInput.classList.remove('recording');
    if (S.app) shortcutInput.value = formatShortcut(S.app.settings.shortcut);
  }
  shortcutInput.addEventListener('focus', () => {
    shortcutInput.classList.add('recording');
    shortcutInput.value = t('shortcutRecording');
    showMsg('#shortcut-msg', '', '');
  });
  shortcutInput.addEventListener('blur', stopRecording);
  shortcutInput.addEventListener('keydown', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') return shortcutInput.blur();
    const code = e.code;
    let key = null;
    if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
    else if (/^Digit\d$/.test(code)) key = code.slice(5);
    else if (/^F\d{1,2}$/.test(code)) key = code;
    else if (code === 'Space') key = 'Space';
    else if (code === 'Backquote') key = '`';
    if (!key) return;
    const mods = [];
    if (e.ctrlKey) mods.push(isMac ? 'Control' : 'Ctrl');
    if (e.metaKey) mods.push(isMac ? 'Command' : 'Super');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (!mods.length && !/^F\d/.test(key)) {
      return showMsg('#shortcut-msg', t('shortcutNeedsModifier', { keys: isMac ? '⌘ / ⌃ / ⌥ / ⇧' : 'Ctrl / Alt / Shift' }), 'error');
    }
    const accelerator = [...mods, key].join('+');
    const res = await api.setSettings({ shortcut: accelerator });
    if (res && res.ok) {
      showMsg('#shortcut-msg', t('saved'), 'ok');
      S.app.settings.shortcut = accelerator;
    } else {
      showMsg('#shortcut-msg', (res && res.error) || t('toastSaveFailed'), 'error');
    }
    shortcutInput.blur();
  });
  $('#clear-shortcut').addEventListener('click', async () => {
    await api.setSettings({ shortcut: '' });
    showMsg('#shortcut-msg', t('saved'), 'ok');
  });

  // ---------- keyboard & search ----------

  let searchTimer;
  els.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      S.q = els.search.value;
      loadList(false);
    }, 120);
  });

  document.addEventListener('keydown', (e) => {
    if (!els.settings.hidden || !els.trash.hidden) {
      if (e.key === 'Escape') {
        if (!els.settings.hidden) closeSettings();
        else closeTrash();
      }
      return;
    }
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (mod && (e.code === 'KeyF' || e.code === 'KeyK')) {
      e.preventDefault();
      els.search.focus();
      els.search.select();
      return;
    }
    if (mod && e.code === 'Comma') {
      e.preventDefault();
      openSettings();
      return;
    }
    if (e.key === 'Escape') {
      if (els.search.value) {
        els.search.value = '';
        els.search.dispatchEvent(new Event('input'));
      } else {
        api.hide();
      }
    }
  });

  // ---------- wiring ----------

  async function refreshState() {
    S.app = await api.getState();
    const languageChanged = S.app.settings.language !== tr.code;
    if (languageChanged) {
      tr = I18N.createTranslator(S.app.settings.language);
      buildFormatters();
      translatePage();
      for (const sel of ['#code-msg', '#peer-msg', '#shortcut-msg', '#folder-msg']) showMsg(sel, '', '');
    }
    renderStatus();
    renderFolder();
    renderBanners();
    renderFilters();
    renderFooter();
    renderSettings();
    if (languageChanged) {
      renderList();
      if (!els.trash.hidden) renderTrash();
    }
  }

  api.on('state:changed', () => refreshState().catch((err) => console.error(err)));
  api.on('activity:changed', () => {
    loadList(true).catch((err) => console.error(err));
    if (!els.trash.hidden) renderTrash();
  });
  api.on('ui:open-settings', () => openSettings());
  api.on('ui:open-trash', () => openTrash());

  // Keep relative times fresh.
  setInterval(() => {
    if (document.hidden || !S.app) return;
    renderList();
    renderFolder();
  }, 30000);

  await refreshState();
  await loadList(false);
})();
