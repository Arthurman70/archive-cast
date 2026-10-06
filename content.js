// Archive Cast panel — isolated-world content script.
// On archive.org it builds the episode list from the item/collection metadata; on other sites it
// scans the page, podcast feeds, detected network streams and "next episode" links. It drives
// castbridge.js (page world, owns the Cast SDK) over window.postMessage, and answers the
// command API used by window.ArchiveCast, other extensions and the MCP bridge (see AGENTS.md).
(() => {
  'use strict';
  if (window.__archiveCastPanel) return;
  window.__archiveCastPanel = true;

  const EP = globalThis.ArchiveCastEpisodes;
  const GEN = globalThis.ArchiveCastGeneric;
  const COMMANDS = globalThis.ArchiveCastCommands;
  const VERSION = chrome.runtime.getManifest().version;
  const CMD = 'archive-cast:cmd';
  const EVT = 'archive-cast:evt';
  const API = 'archive-cast:api';
  const API_RES = 'archive-cast:api-result';
  const PUB = 'archive-cast:public';
  const COLLECTION_LIMIT = 150;
  const RECENT_CAST_MS = 12 * 3600 * 1000;
  const IS_ARCHIVE = /^(www\.)?archive\.org$/.test(location.hostname); // not web.archive.org (Wayback)
  const ORIGIN_KEY = IS_ARCHIVE ? '' : ':' + location.origin;

  const send = (cmd, data) => window.postMessage(Object.assign({ [CMD]: true, cmd }, data || {}), location.origin);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const store = {
    async get(key, fallback) {
      try { const o = await chrome.storage.local.get(key); return o[key] === undefined ? fallback : o[key]; } catch (_) { return fallback; }
    },
    set(key, value) { try { chrome.storage.local.set({ [key]: value }); } catch (_) { /* extension reloaded */ } },
  };

  async function bg(type, data) {
    try { return await chrome.runtime.sendMessage(Object.assign({ type }, data || {})); } catch (_) { return null; }
  }

  const S = {
    pageId: null,
    path: null,
    status: 'idle', // idle | nopage | loading | collection | ready | empty | error
    statusText: '',
    // sources: several lists a page can offer (archive: video/audio; web: feed/follow/page/streams/custom)
    lists: {},
    labels: {},
    source: null,
    sourcePinned: false,
    eps: [],
    fileIndex: new Map(),
    // archive.org
    raw: null, // item: {files, meta}; collection: {meta, docs, files: Map, total}
    isCollection: false,
    resolving: null,
    sort: 'title',
    // other sites
    scan: null,
    nextUrl: null,
    streams: [],
    feedTried: false,
    crawling: false,
    crawlText: '',
    autoAdvance: false,
    siteWatch: null,
    advancing: false,
    // shared
    settings: { mode: 'best', loop: false },
    cast: null,
    watched: new Set(),
    progress: null,
    open: false,
    sdkRequested: false,
    pending: null,
    retried: new Set(),
    lastUid: null,
    lastSavedAt: 0,
    castingSavedAt: 0,
    scrolledTo: null,
    seeking: false,
    waiters: new Set(),
    lastReport: '',
  };
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });

  // ================================================================= archive.org
  const firstString = (v) => (Array.isArray(v) ? (v.length ? String(v[0]) : '') : v == null ? '' : String(v));

  async function getJSON(url) {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  function archiveIdFromPath() {
    const m = location.pathname.match(/^\/details\/([^/?#]+)/);
    if (!m) return null;
    const id = decodeURIComponent(m[1]);
    return id.startsWith('@') ? null : id;
  }

  async function loadArchive() {
    S.pageId = archiveIdFromPath();
    S.raw = null;
    S.isCollection = false;
    resetLists();
    if (!S.pageId) { S.status = 'nopage'; render(); return; }
    S.status = 'loading';
    S.statusText = 'Reading episodes…';
    render();
    await loadMemory();
    try {
      const j = await getJSON('/metadata/' + encodeURIComponent(S.pageId));
      if (!j || !j.metadata) throw new Error('item not found');
      if (j.metadata.mediatype === 'collection') {
        S.isCollection = true;
        S.raw = { meta: j.metadata, docs: null, files: new Map(), total: 0 };
        S.status = 'collection';
        if (S.open) resolveCollection();
      } else {
        S.raw = { files: j.files || [], meta: j.metadata };
        rebuildArchive();
      }
    } catch (e) {
      S.status = 'error';
      S.statusText = 'Couldn’t read this item (' + e.message + ').';
    }
    render();
  }

  function resolveCollection() {
    if (!S.isCollection || S.raw.docs) return Promise.resolve();
    if (!S.resolving) S.resolving = doResolveCollection().finally(() => { S.resolving = null; render(); });
    return S.resolving;
  }

  async function doResolveCollection() {
    S.status = 'loading';
    S.statusText = 'Finding items in this collection…';
    render();
    try {
      const p = new URLSearchParams();
      p.set('q', `collection:"${S.pageId}" AND -mediatype:collection`);
      for (const f of ['identifier', 'title', 'date', 'creator']) p.append('fl[]', f);
      p.append('sort[]', S.sort === 'title' ? 'titleSorter asc' : S.sort === 'date' ? 'date asc' : 'date desc');
      p.set('rows', String(COLLECTION_LIMIT));
      p.set('output', 'json');
      const j = await getJSON('/advancedsearch.php?' + p);
      const docs = (j.response && j.response.docs) || [];
      S.raw.total = (j.response && j.response.numFound) || docs.length;
      let done = 0;
      await pool(docs, 6, async (doc) => {
        if (!S.raw.files.has(doc.identifier)) {
          try {
            const r = await getJSON('/metadata/' + encodeURIComponent(doc.identifier) + '/files');
            S.raw.files.set(doc.identifier, r.result || []);
          } catch (_) { S.raw.files.set(doc.identifier, []); }
        }
        done++;
        S.statusText = `Loading items ${done} / ${docs.length}…`;
        renderStatus();
      });
      S.raw.docs = docs;
      rebuildArchive();
    } catch (e) {
      S.status = 'error';
      S.statusText = 'Couldn’t list this collection (' + e.message + ').';
    }
  }

  async function pool(items, n, fn) {
    let next = 0;
    const worker = async () => { while (next < items.length) await fn(items[next++]); };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  }

  function sortedDocs() {
    const docs = S.raw.docs.slice();
    const t = (d) => firstString(d.title) || d.identifier;
    if (S.sort === 'title') return docs.sort((a, b) => EP.collator.compare(t(a), t(b)));
    const dir = S.sort === 'date-desc' ? -1 : 1;
    return docs.sort((a, b) => dir * String(a.date || '').localeCompare(String(b.date || '')) || EP.collator.compare(t(a), t(b)));
  }

  function rebuildArchive() {
    const mode = S.settings.mode;
    let lists;
    if (S.isCollection) {
      if (!S.raw.docs) return;
      lists = { video: [], audio: [] };
      for (const doc of sortedDocs()) {
        const docTitle = firstString(doc.title) || doc.identifier;
        const l = EP.buildEpisodes(doc.identifier, S.raw.files.get(doc.identifier) || [],
          { title: docTitle, creator: doc.creator }, { mode });
        for (const k of ['video', 'audio']) {
          const single = l[k].length === 1;
          for (const ep of l[k]) {
            if (single) { ep.title = docTitle; ep.folder = ''; } else ep.folder = docTitle + (ep.folder ? ' / ' + ep.folder : '');
            lists[k].push(ep);
          }
        }
      }
    } else {
      lists = EP.buildEpisodes(S.pageId, S.raw.files, S.raw.meta, { mode });
    }
    S.lists = lists;
    S.labels = { video: 'Video', audio: 'Audio' };
    if (!S.source || !(S.lists[S.source] || []).length) S.source = EP.defaultKind(S.lists, S.isCollection ? null : S.raw.meta.mediatype);
    setEps();
  }

  // ================================================================= other sites
  function siteName() {
    const og = document.querySelector('meta[property="og:site_name"]');
    return (og && og.content && og.content.trim()) || location.hostname.replace(/^www\./, '');
  }

  function webEp(it, d) {
    return {
      key: it.url, id: 'web', file: it.url, url: it.url, mime: it.mime, kind: it.kind || GEN.kindFor(it.mime),
      title: it.title || GEN.fileTitle(it.url), folder: it.folder || '', duration: it.duration || null, track: NaN,
      format: GEN.formatLabel(it.mime), show: d.show, creator: '', image: it.image || d.image || null, alts: [it.url],
    };
  }

  async function loadWeb() {
    S.pageId = 'web:' + location.host + location.pathname;
    resetLists();
    S.feedTried = false;
    S.status = 'loading';
    S.statusText = 'Looking for video and audio on this page…';
    render();
    await loadMemory();
    await rescanWeb();
  }

  const listsSignature = () => Object.keys(S.lists).sort().map((id) => id + ':' + S.lists[id].map((e) => e.url + '|' + e.title).join(',')).join(';');

  async function rescanWeb() {
    const before = S.status === 'ready' ? listsSignature() : null;
    const show = siteName();
    S.scan = GEN.scanDocument(document, location.href);
    S.nextUrl = S.scan.next;
    setList('page', 'On this page', S.scan.items.map((it) => webEp(it, { show, image: S.scan.image })), false);
    const res = await bg('streams');
    S.streams = (res && res.streams) || [];
    const onPage = new Set(S.scan.items.map((i) => i.url));
    const title = S.scan.title || document.title || show;
    const fresh = S.streams.filter((s) => !onPage.has(s.url));
    setList('streams', 'Detected streams', fresh.map((s, i) => webEp({
      url: s.url, mime: s.mime, kind: s.kind,
      title: fresh.length > 1 ? `${title} · ${GEN.formatLabel(s.mime)} ${i + 1}` : title,
    }, { show, image: S.scan.image })), false);
    if (!S.feedTried && S.scan.feeds.length) {
      S.feedTried = true;
      loadFeed(S.scan.feeds[0]);
    }
    if (before !== null && before === listsSignature()) return; // nothing new; keep the list (and its scroll) as is
    S.status = 'ready';
    pickSource();
    setEps();
    render();
  }

  async function loadFeed(feed) {
    try {
      const xml = await fetchText(feed.url);
      const parsed = GEN.parseFeed(xml, feed.url);
      const show = parsed.title || feed.title || siteName();
      const eps = parsed.items.map((it) => webEp(Object.assign({}, it, { folder: it.season ? 'Season ' + it.season : '' }), { show, image: parsed.image }));
      setList('feed', 'Podcast feed', eps, true);
    } catch (_) { /* pages often advertise feeds that aren't podcasts */ }
  }

  // Same-origin pages are fetched here (with the site's cookies); anything else goes through the
  // service worker without cookies, so a page can't use us to read other sites as the user.
  async function fetchText(url) {
    if (new URL(url, location.href).origin === location.origin) {
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }
    const res = await bg('fetch', { url });
    if (!res || !res.ok) throw new Error((res && res.error) || 'fetch failed');
    return res.text;
  }

  function primaryForThisPage() {
    const items = (S.scan ? S.scan.items : []).concat(S.streams.map((s) => Object.assign({ src: 'stream', title: '' }, s)));
    return GEN.primaryItem({ items });
  }

  // Follow "next episode" links, reading each page's HTML for its media.
  async function findMore(maxPages) {
    if (IS_ARCHIVE) throw new Error('archive.org pages already list every episode.');
    if (S.crawling) throw new Error('Already following next-episode links.');
    if (!S.nextUrl) throw new Error('No “next episode” link found on this page.');
    const limit = Math.min(100, Math.max(1, maxPages || 25));
    S.crawling = true;
    const show = siteName();
    const eps = [];
    const here = primaryForThisPage();
    if (here) eps.push(webEp(Object.assign({}, here, { title: (S.scan && S.scan.title) || here.title }), { show, image: S.scan && S.scan.image }));
    const seen = new Set([GEN.stripHash(location.href)]);
    let url = S.nextUrl, reason = null, pages = 0;
    try {
      while (url && pages < limit) {
        const key = GEN.stripHash(url);
        if (seen.has(key)) { reason = 'loop'; break; }
        seen.add(key);
        pages++;
        S.crawlText = `Following next-episode links… ${pages}`;
        renderControls();
        const doc = new DOMParser().parseFromString(await fetchText(url), 'text/html');
        const scan = GEN.scanDocument(doc, url);
        const item = GEN.primaryItem(scan);
        if (!item) { reason = 'nomedia'; break; }
        eps.push(webEp(Object.assign({}, item, { title: scan.title || item.title }), { show, image: scan.image }));
        url = scan.next;
      }
    } catch (e) { reason = e.message; }
    S.crawling = false;
    S.crawlText = '';
    const added = eps.length - (here ? 1 : 0);
    if (added > 0) {
      setList('follow', `This + next ${added} page${added === 1 ? '' : 's'}`, eps, false);
      S.source = 'follow';
      S.sourcePinned = true;
      setEps();
    } else if (reason === 'nomedia') {
      toast('The next page doesn’t link its video in the HTML (the site builds its player with script), so I can’t read ahead. Turn on Auto-advance and cast with the site’s own player instead.', 'warn');
    }
    render();
    return { added, stoppedBecause: reason || (url ? 'limit' : 'no-more-links') };
  }

  // ---- site player auto-advance -------------------------------------------------
  function watchSite(st) {
    const site = st.site;
    if (IS_ARCHIVE || !S.autoAdvance || !site || !site.connected) { S.siteWatch = null; return; }
    const m = site.media;
    const w = S.siteWatch || (S.siteWatch = { url: null, nearEnd: false });
    if (m && !m.ours && /PLAYING|BUFFERING|PAUSED/.test(m.playerState || '')) {
      if (m.url !== w.url) { w.url = m.url; w.nearEnd = false; }
      if (m.duration && m.time >= m.duration - 15) w.nearEnd = true;
    }
    const ended = w.url && ((m && m.playerState === 'IDLE' && m.idleReason === 'FINISHED') || (!m && w.nearEnd));
    if (ended && !S.advancing) advanceSite(w.url);
  }

  async function advanceSite(prevUrl) {
    if (!S.nextUrl) {
      S.siteWatch = null;
      toast('The episode ended, but I couldn’t find a link to the next one on this page.', 'warn');
      return;
    }
    S.advancing = true;
    await bg('assist', { set: { to: S.nextUrl, prevUrl, at: Date.now() } });
    toast('Episode finished — opening the next one…', 'info');
    location.href = S.nextUrl;
  }

  async function continueAssist() {
    const res = await bg('assist', { take: true });
    const a = res && res.assist;
    if (!a || Date.now() - a.at > 120000) return;
    ensureSdk();
    toast('Starting the next episode on your Chromecast…', 'info');
    const deadline = Date.now() + 40000;
    let attempts = 0;
    while (Date.now() < deadline) {
      await sleep(2500);
      const m = S.cast && S.cast.site && S.cast.site.media;
      if (m && /PLAYING|BUFFERING/.test(m.playerState || '') && m.url !== a.prevUrl) {
        toast('Playing the next episode.', 'info');
        return;
      }
      if (S.cast && S.cast.site && S.cast.site.connected && attempts < 4) { send('sitePlay'); attempts++; }
    }
    toast('I opened the next episode but couldn’t start this site’s player — press play on the page.', 'warn');
  }

  // ================================================================= lists
  function resetLists() {
    S.lists = {};
    S.labels = {};
    S.source = null;
    S.sourcePinned = false;
    setEps();
  }

  const SOURCE_ORDER = ['video', 'audio', 'custom', 'feed', 'follow', 'page', 'streams'];

  function setList(id, label, eps, repick) {
    S.lists[id] = eps;
    S.labels[id] = label;
    if (repick) { pickSource(); setEps(); render(); }
  }

  // Keep the user's choice; otherwise show whichever source has the most episodes.
  function pickSource() {
    const has = (id) => (S.lists[id] || []).length > 0;
    if (S.source && has(S.source) && S.sourcePinned) return;
    let best = null;
    for (const id of SOURCE_ORDER) if (has(id) && (!best || S.lists[id].length > S.lists[best].length)) best = id;
    if (best) S.source = best;
  }

  function sourceIds() { return SOURCE_ORDER.filter((id) => (S.lists[id] || []).length); }

  function setEps() {
    S.eps = (S.source && S.lists[S.source]) || [];
    S.fileIndex = new Map();
    const prefix = commonPrefix(S.eps.map((e) => e.title));
    S.eps.forEach((ep, i) => {
      ep.uid = ep.id + '/' + ep.key;
      ep.short = ep.title.slice(prefix.length) || ep.title;
      for (const f of ep.alts) S.fileIndex.set(ep.id + '/' + f, i);
    });
    if (IS_ARCHIVE) { if (S.raw) S.status = S.eps.length ? 'ready' : 'empty'; }
    else if (S.status !== 'loading') S.status = S.eps.length ? 'ready' : 'empty';
  }

  // "Green Acres - 001 - Pilot", "Green Acres - 002 - …" → strip "Green Acres - " in the list
  function commonPrefix(titles) {
    if (titles.length < 2) return '';
    let p = titles[0];
    for (const t of titles) { while (p && !t.startsWith(p)) p = p.slice(0, -1); if (!p) return ''; }
    const m = p.match(/^.*[\s\-–—:|.]\s*/); // cut back to a word/separator boundary
    p = m ? m[0] : '';
    return p.trim().length >= 3 ? p : '';
  }

  function parseDownloadUrl(url) {
    try {
      const u = new URL(url);
      if (!/(^|\.)archive\.org$/.test(u.hostname) || !u.pathname.startsWith('/download/')) return null;
      const parts = u.pathname.split('/').slice(2).map(decodeURIComponent);
      return parts[0] + '/' + parts.slice(1).join('/');
    } catch (_) { return null; }
  }

  function indexOfMedia(m) {
    if (!m) return -1;
    if (m.custom && m.custom.id && m.custom.f) {
      const i = S.fileIndex.get(m.custom.id + '/' + m.custom.f);
      if (i != null) return i;
    }
    if (m.url) {
      const key = parseDownloadUrl(m.url);
      const i = S.fileIndex.get(key || 'web/' + m.url);
      if (i != null) return i;
    }
    return -1;
  }

  async function loadMemory() {
    const [watched, progress] = await Promise.all([
      store.get('ac:w:' + S.pageId, []),
      store.get('ac:p:' + S.pageId, null),
    ]);
    S.watched = new Set(watched);
    S.progress = progress;
  }

  // ================================================================= casting
  function ensureSdk() {
    if (S.sdkRequested) return;
    S.sdkRequested = true;
    send('init', { own: IS_ARCHIVE });
  }

  const slim = (e) => ({
    url: e.url, mime: e.mime, kind: e.kind, title: e.title, show: e.show, creator: e.creator,
    image: e.image, id: e.id, file: e.file, duration: e.duration,
  });

  let pendingTimer = null;
  function setPending(i) {
    S.pending = i;
    clearTimeout(pendingTimer);
    if (i != null) pendingTimer = setTimeout(() => { S.pending = null; renderList(); }, 20000);
  }

  function loadFrom(i, startTime) {
    if (i < 0 || i >= S.eps.length) return;
    ensureSdk();
    setPending(i);
    send('load', {
      after: S.eps.slice(i).map(slim),
      before: S.eps.slice(0, i).map(slim),
      startTime: startTime || 0,
      repeat: S.settings.loop,
    });
    if (IS_ARCHIVE) store.set('ac:last', S.pageId);
    renderList();
  }

  function playEpisode(i, startTime) {
    if (i < 0 || i >= S.eps.length) return;
    const m = S.cast && S.cast.media;
    if (!startTime && m && m.playerState !== 'IDLE' && indexOfMedia(m) >= 0) {
      setPending(i);
      send('jump', { url: S.eps[i].url });
      renderList();
    } else loadFrom(i, startTime);
  }

  function currentIndex() {
    return S.cast && S.cast.media ? indexOfMedia(S.cast.media) : -1;
  }

  function navigate(dir) {
    // the receiver's own queue is fastest; castbridge reports navMiss and we reload from the neighbour
    if (S.cast && S.cast.media) send(dir > 0 ? 'next' : 'prev');
  }

  function resumeTarget() {
    const p = S.progress;
    if (!p) return null;
    const i = S.eps.findIndex((e) => e.uid === p.uid);
    if (i < 0) return null;
    const ep = S.eps[i];
    if (ep.duration && p.time > ep.duration * 0.92) return i + 1 < S.eps.length ? { i: i + 1, time: 0 } : null;
    return { i, time: Math.max(0, (p.time || 0) - 5) };
  }

  function onCastState(st) {
    S.cast = st;
    const now = Date.now();
    if ((st.castState === 'CONNECTED' || (st.site && st.site.connected)) && now - S.castingSavedAt > 60000) {
      S.castingSavedAt = now;
      store.set('ac:castingAt' + ORIGIN_KEY, now);
    }
    const m = st.media;
    const i = indexOfMedia(m);
    if (i >= 0) {
      if (S.pending === i && m.playerState !== 'IDLE') setPending(null);
      track(i, m);
    }
    handlePlaybackError(i, m);
    watchSite(st);
    for (const w of [...S.waiters]) w.check();
    renderNow();
    if ($ && S.open) renderControls();
    renderList();
    publish();
  }

  function track(i, m) {
    const ep = S.eps[i];
    if (m.duration && m.time / m.duration > 0.9 && !S.watched.has(ep.uid)) {
      S.watched.add(ep.uid);
      store.set('ac:w:' + S.pageId, [...S.watched]);
    }
    const now = Date.now();
    if (m.playerState === 'PLAYING' && (ep.uid !== S.lastUid || now - S.lastSavedAt > 10000)) {
      S.lastUid = ep.uid;
      S.lastSavedAt = now;
      S.progress = { uid: ep.uid, title: ep.title, time: m.time || 0, at: now };
      store.set('ac:p:' + S.pageId, S.progress);
      if (IS_ARCHIVE) store.set('ac:last', S.pageId);
    }
  }

  function handlePlaybackError(i, m) {
    if (i < 0 || !m || m.playerState !== 'IDLE' || m.idleReason !== 'ERROR') return;
    const ep = S.eps[i];
    if (S.retried.has(ep.uid)) return;
    S.retried.add(ep.uid);
    if (IS_ARCHIVE && S.settings.mode === 'best' && ep.alts.length > 1) {
      setMode('compat');
      toast('That episode wouldn’t play on your Chromecast, so I switched to the more compatible versions and retried.', 'warn');
      const j = S.eps.findIndex((e) => e.uid === ep.uid);
      if (j >= 0) loadFrom(j, 0);
    } else if (i + 1 < S.eps.length) {
      toast(`“${ep.title}” can’t play on a Chromecast (${ep.format || ep.mime}) — skipping it.`, 'warn');
      loadFrom(i + 1, 0);
    } else {
      toast(`“${ep.title}” can’t play on a Chromecast (${ep.format || ep.mime}).`, 'error');
    }
  }

  function setMode(mode) {
    S.settings.mode = mode;
    store.set('ac:settings', S.settings);
    if (IS_ARCHIVE && S.raw) rebuildArchive();
    render();
  }

  function setLoop(on) {
    S.settings.loop = !!on;
    store.set('ac:settings', S.settings);
    send('repeat', { on: S.settings.loop });
    render();
  }

  function setAutoAdvance(on) {
    S.autoAdvance = !!on;
    store.set('ac:aa' + ORIGIN_KEY, S.autoAdvance);
    if (S.autoAdvance) ensureSdk();
    render();
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data) return;
    const d = ev.data;
    if (d[API] === true) return answerPageCall(d);
    if (d[EVT] !== true) return;
    if (d.type === 'state') onCastState(d.state);
    else if (d.type === 'error') {
      setPending(null);
      if (d.message) toast(d.message, 'error');
      for (const w of [...S.waiters]) w.fail(d.cancelled ? 'The Chromecast picker was closed without choosing a device.' : d.message);
      renderList();
    } else if (d.type === 'jumpMiss') {
      const i = S.eps.findIndex((e) => e.url === d.url);
      if (i >= 0) loadFrom(i, 0);
    } else if (d.type === 'navMiss') {
      const i = currentIndex();
      if (i >= 0) loadFrom(i + d.dir, 0);
    }
  });

  // ================================================================= command API
  // One dispatcher for window.ArchiveCast, other extensions and the MCP bridge.
  function waitFor(pred, ms, timeoutMsg) {
    return new Promise((resolve, reject) => {
      const w = {
        check() { if (pred()) { done(); resolve(publicState()); } },
        fail(msg) { done(); reject(new Error(msg || 'Cast failed.')); },
      };
      const timer = setTimeout(() => { done(); timeoutMsg ? reject(new Error(timeoutMsg)) : resolve(publicState()); }, ms);
      const done = () => { clearTimeout(timer); S.waiters.delete(w); };
      S.waiters.add(w);
      w.check();
    });
  }

  const isActive = (m) => !!(m && m.playerState && m.playerState !== 'IDLE');

  function canCast() {
    const st = S.cast;
    return !!(st && (st.castState === 'CONNECTED' || (st.site && st.site.connected)));
  }

  async function requireCast() {
    ensureSdk();
    if (!canCast()) {
      send('init', { own: IS_ARCHIVE }); // asks the bridge for a fresh state (e.g. a site session that just connected)
      await waitFor(() => canCast(), 2500);
    }
    if (canCast()) return;
    const st = S.cast;
    if (st && (st.sdk === 'unavailable' || st.sdk === 'blocked')) throw new Error(st.sdkError || 'Google Cast is unavailable on this page.');
    throw new Error('Not connected to a Chromecast. Chrome only opens its device picker from a real click: press “Connect” in the Archive Cast panel (or ask the user to), then try again.');
  }

  async function ensureList() {
    await ready;
    if (IS_ARCHIVE && S.isCollection) await resolveCollection();
    if (!S.eps.length) throw new Error(S.status === 'nopage' ? 'Open a show page first.' : 'No episodes found on this page.');
  }

  function epSummary(ep, i) {
    return {
      index: i, title: ep.title, duration: ep.duration || null, url: ep.url, format: ep.format || ep.mime,
      group: ep.folder || null, watched: S.watched.has(ep.uid), current: currentIndex() === i,
    };
  }

  function publicState() {
    const st = S.cast || {};
    const m = st.media;
    const i = indexOfMedia(m);
    return {
      version: VERSION,
      site: location.hostname,
      url: location.href,
      page: { id: S.pageId, status: S.status, message: S.statusText || null },
      source: S.source,
      sources: sourceIds().map((id) => ({ id, label: S.labels[id], count: S.lists[id].length })),
      episodeCount: S.eps.length,
      cast: {
        sdk: st.sdk || 'idle', mode: st.mode || null, state: st.castState || null, device: st.device || null,
        volume: st.volume == null ? null : Math.round(st.volume * 100) / 100, muted: st.muted == null ? null : st.muted,
        error: st.sdkError || null, loadingQueue: !!st.loading,
      },
      nowPlaying: m ? {
        index: i >= 0 ? i : null, title: i >= 0 ? S.eps[i].title : m.title, state: m.playerState, idleReason: m.idleReason || null,
        time: m.time == null ? null : Math.round(m.time), duration: m.duration || (i >= 0 ? S.eps[i].duration : null) || null,
      } : null,
      sitePlayer: st.site || null,
      settings: { quality: S.settings.mode, loop: S.settings.loop, autoAdvance: S.autoAdvance },
      nextPageUrl: S.nextUrl,
      resume: (() => { const r = resumeTarget(); return r ? { index: r.i, title: S.eps[r.i].title, time: Math.round(r.time) } : null; })(),
      panelOpen: S.open,
    };
  }

  let lastPub = 0;
  let pubTimer = null;
  function publish() {
    const now = Date.now();
    if (now - lastPub < 250) {
      if (!pubTimer) pubTimer = setTimeout(() => { pubTimer = null; publish(); }, 260);
      return;
    }
    lastPub = now;
    const ps = publicState();
    window.postMessage({ [PUB]: true, state: ps }, location.origin);
    reflectInDom(ps);
    const np = ps.nowPlaying;
    const report = JSON.stringify([ps.cast.state, ps.cast.device, np && np.index, np && np.state, np && np.title, ps.episodeCount, S.status]);
    if (report !== S.lastReport) {
      S.lastReport = report;
      bg('status', { status: { site: ps.site, url: ps.url, title: document.title, castState: ps.cast.state, device: ps.cast.device, nowPlaying: np, episodeCount: ps.episodeCount, sitePlayer: !!(ps.sitePlayer && ps.sitePlayer.connected) } });
    }
  }

  const api = {
    async help() {
      return COMMANDS.COMMANDS.filter((c) => c.scope === 'tab').map((c) => ({
        name: c.name, description: c.description, args: Object.keys(c.args).filter((a) => a !== 'tabId'),
      }));
    },
    async state() { await ready; return publicState(); },
    async episodes({ offset = 0, limit = 50, query } = {}) {
      await ensureList();
      const q = (query || '').toLowerCase();
      const all = S.eps.map(epSummary).filter((e) => !q || (e.title + ' ' + S.eps[e.index].file).toLowerCase().includes(q));
      const lim = Math.min(500, Math.max(1, limit));
      return { total: all.length, offset, source: S.source, items: all.slice(offset, offset + lim) };
    },
    async play({ index, query, startTime } = {}) {
      await ensureList();
      let i = index;
      if (i == null && query) {
        const q = String(query).toLowerCase();
        i = S.eps.findIndex((e) => (e.title + ' ' + e.file).toLowerCase().includes(q));
        if (i < 0) throw new Error(`No episode matches “${query}”.`);
      }
      if (i == null) i = 0;
      if (!(i >= 0 && i < S.eps.length)) throw new Error(`Episode index ${i} is out of range (0–${S.eps.length - 1}).`);
      await requireCast();
      playEpisode(i, startTime || 0);
      return waitFor(() => currentIndex() === i && isActive(S.cast.media), 45000, 'The Chromecast didn’t start the episode within 45 seconds.');
    },
    async resume() {
      await ready;
      const m = S.cast && S.cast.media;
      if (isActive(m)) { send('play'); return waitFor(() => S.cast.media && S.cast.media.playerState !== 'PAUSED', 5000); }
      const r = resumeTarget();
      if (!r) throw new Error('Nothing is playing and there is no saved spot for this page.');
      return api.play({ index: r.i, startTime: r.time });
    },
    async pause() { requireMedia(); send('pause'); return waitFor(() => S.cast.media && S.cast.media.playerState === 'PAUSED', 5000); },
    async toggle() { requireMedia(); send('toggle'); await sleep(800); return publicState(); },
    async next() { return step(1); },
    async previous() { return step(-1); },
    async seek({ time, delta } = {}) {
      requireMedia();
      if (time == null && delta == null) throw new Error('Give "time" (seconds) or "delta" (relative seconds).');
      send('seek', delta != null ? { delta: +delta } : { time: +time });
      await sleep(1200);
      return publicState();
    },
    async volume({ level } = {}) {
      await requireCast();
      if (!(level >= 0 && level <= 1)) throw new Error('level must be between 0 and 1.');
      send('volume', { level: +level });
      await sleep(800);
      return publicState();
    },
    async mute({ muted = true } = {}) { await requireCast(); send('mute', { muted: !!muted }); await sleep(800); return publicState(); },
    async loop({ on = true } = {}) { setLoop(on); return publicState(); },
    async quality({ mode } = {}) {
      if (!['best', 'compat'].includes(mode)) throw new Error('mode must be "best" or "compat".');
      setMode(mode);
      return publicState();
    },
    async source({ id } = {}) {
      await ready;
      if (!(S.lists[id] || []).length) throw new Error(`No source “${id}”. Available: ${sourceIds().join(', ') || 'none'}.`);
      S.source = id;
      S.sourcePinned = true;
      setEps();
      render();
      return publicState();
    },
    async castMedia({ items, startIndex = 0 } = {}) {
      await ready;
      if (!Array.isArray(items) || !items.length) throw new Error('items must be a non-empty array of {url, title}.');
      const show = IS_ARCHIVE ? 'Archive Cast' : siteName();
      const eps = items.map((it, n) => {
        if (!it || !/^https?:\/\//i.test(it.url || '')) throw new Error(`items[${n}].url must be an http(s) URL.`);
        const mime = GEN.mimeFor(it.url, it.mime) || 'video/mp4';
        return webEp({ url: it.url, mime, title: it.title, image: it.image }, { show });
      });
      setList('custom', 'Custom queue', eps, false);
      S.source = 'custom';
      S.sourcePinned = true;
      setEps();
      render();
      return api.play({ index: startIndex });
    },
    async findMore({ maxPages } = {}) { await ready; return findMore(maxPages); },
    async autoAdvance({ on = true } = {}) {
      if (IS_ARCHIVE) throw new Error('Not needed on archive.org — the Chromecast queue already autoplays.');
      setAutoAdvance(on);
      return publicState();
    },
    async rescan() {
      await ready;
      if (IS_ARCHIVE) await loadArchive(); else await rescanWeb();
      return publicState();
    },
    async openPanel() { setOpen(true); return publicState(); },
    async closePanel() { setOpen(false); return publicState(); },
    async connect() {
      ensureSdk();
      if (canCast()) return publicState();
      send('connect');
      return waitFor(() => canCast(), 3000).then((s) => {
        if (!canCast()) s.note = 'Chrome only shows its Chromecast picker after a real click. Press “Connect” in the panel (or ask the user to).';
        return s;
      });
    },
    async stop({ keepPlaying = false } = {}) {
      send('disconnect', { stop: !keepPlaying });
      return waitFor(() => !canCast() || (S.cast.site && S.cast.site.connected && !S.cast.media), 4000);
    },
  };

  function requireMedia() {
    if (!isActive(S.cast && S.cast.media)) throw new Error('Nothing is playing on the Chromecast.');
  }

  async function step(dir) {
    requireMedia();
    const from = currentIndex();
    navigate(dir);
    return waitFor(() => currentIndex() !== from && isActive(S.cast.media), 20000, 'The Chromecast didn’t change episode.');
  }

  async function runApi(cmd, args) {
    const fn = Object.prototype.hasOwnProperty.call(api, cmd) && api[cmd];
    if (!fn) throw new Error(`Unknown command “${cmd}”. Call help for the list.`);
    return fn(args || {});
  }

  async function answerPageCall(d) {
    let reply;
    try { reply = { ok: true, result: await runApi(d.cmd, d.args) }; } catch (e) { reply = { ok: false, error: e.message || String(e) }; }
    window.postMessage(Object.assign({ [API_RES]: true, id: d.id }, reply), location.origin);
  }

  // ================================================================= UI
  const ICON = {
    cast: 'M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11zm20-7H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z',
    castOn: 'M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm18-7H5v1.63c3.96 1.28 7.09 4.41 8.37 8.37H19V7zM1 10v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11zm20-7H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z',
    play: 'M8 5v14l11-7z',
    pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
    prev: 'M6 6h2v12H6zm3.5 6l8.5 6V6z',
    next: 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
    replay: 'M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z',
    vol: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
    mute: 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
    close: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    check: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
    more: 'M4 6h12v2H4zm0 5h12v2H4zm0 5h8v2H4zm12 0v-3l5 4-5 4v-3z',
  };
  const svg = (name, cls) =>
    `<svg class="ic ${cls || ''}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON[name]}"/></svg>`;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = (s) => {
    if (s == null || !isFinite(s)) return '–:––';
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
  };

  const CSS = `
:host { all: initial; }
.root {
  --bg: #14161b; --bg2: #1c1f26; --bg3: #262a33; --hover: #2b303a; --line: #2c313b;
  --fg: #eceef2; --fg2: #a7aebb; --fg3: #737b8a; --accent: #5aa9ff; --accent-ink: #04111f;
  --ok: #5fd08a; --warn: #ffb454; --err: #ff6b6b;
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--fg);
  color-scheme: dark; -webkit-font-smoothing: antialiased;
}
* { box-sizing: border-box; }
button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; padding: 0; }
button:disabled { cursor: default; opacity: .35; }
button:focus-visible, input:focus-visible, select:focus-visible, .ep:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ic { width: 20px; height: 20px; fill: currentColor; flex: none; display: block; }
.launcher {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483000; width: 52px; height: 52px; border-radius: 50%;
  background: var(--bg); color: var(--fg); display: grid; place-items: center;
  box-shadow: 0 6px 24px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.06) inset; transition: transform .15s;
}
.launcher:hover { transform: scale(1.06); }
.launcher .ic { width: 24px; height: 24px; }
.launcher.live { color: var(--accent); }
.launcher.live::after {
  content: ""; position: absolute; inset: -3px; border-radius: 50%; border: 2px solid var(--accent); opacity: .55;
  animation: pulse 2s ease-out infinite; pointer-events: none;
}
@keyframes pulse { from { transform: scale(.92); opacity: .7; } to { transform: scale(1.18); opacity: 0; } }
.panel {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483001; width: 384px; max-height: calc(100vh - 40px);
  background: var(--bg); border-radius: 14px; display: flex; flex-direction: column; overflow: hidden;
  box-shadow: 0 18px 60px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.07) inset;
}
@media (max-width: 440px) { .panel { right: 8px; left: 8px; bottom: 8px; width: auto; max-height: calc(100vh - 16px); } }
header { display: flex; align-items: center; gap: 8px; padding: 12px 12px 10px 16px; }
.brand { font-weight: 650; letter-spacing: .01em; flex: 1; display: flex; align-items: center; gap: 8px; min-width: 0; }
.brand .ic { color: var(--accent); }
.device {
  display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 999px; background: var(--bg3);
  font-size: 12px; font-weight: 600; max-width: 190px;
}
.device span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.device .ic { width: 16px; height: 16px; }
.device.on { background: var(--accent); color: var(--accent-ink); }
.device:not(:disabled):hover { filter: brightness(1.12); }
.iconbtn { width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center; color: var(--fg2); }
.iconbtn:not(:disabled):hover { background: var(--hover); color: var(--fg); }
.now { margin: 0 12px; padding: 14px; border-radius: 12px; background: var(--bg2); }
.now-title { font-size: 15px; font-weight: 650; line-height: 1.3; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.now-sub { color: var(--fg2); font-size: 12px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.now-next { color: var(--fg3); font-size: 12px; margin-top: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.seek { display: flex; align-items: center; gap: 8px; margin-top: 12px; font-variant-numeric: tabular-nums; font-size: 11px; color: var(--fg2); }
.seek .t { min-width: 42px; }
.seek .t.dur { text-align: right; }
input[type=range] { -webkit-appearance: none; appearance: none; flex: 1; height: 16px; background: transparent; margin: 0; cursor: pointer; }
input[type=range]::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: linear-gradient(to right, var(--accent) var(--p, 0%), var(--bg3) var(--p, 0%)); }
input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50%; background: #fff; margin-top: -4px; box-shadow: 0 1px 3px rgba(0,0,0,.4); }
input[type=range]:disabled { cursor: default; opacity: .4; }
.transport { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; }
.tbtn { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; color: var(--fg); position: relative; }
.tbtn:not(:disabled):hover { background: var(--hover); }
.tbtn .ic { width: 24px; height: 24px; }
.tbtn b { position: absolute; font-size: 8px; font-weight: 700; top: 50%; left: 50%; transform: translate(-50%, -22%); }
.tbtn.fwd .ic { transform: scaleX(-1); }
.tbtn.main { width: 48px; height: 48px; background: var(--fg); color: var(--bg); }
.tbtn.main:not(:disabled):hover { background: #fff; }
.tbtn.main .ic { width: 28px; height: 28px; }
.vol { display: flex; align-items: center; gap: 4px; margin-top: 6px; color: var(--fg2); }
.vol .iconbtn { width: 28px; height: 28px; }
.vol .ic { width: 18px; height: 18px; }
.msg { margin: 10px 12px 0; padding: 9px 12px; border-radius: 10px; font-size: 12px; display: flex; gap: 8px; align-items: flex-start; }
.msg p { margin: 0; flex: 1; }
.msg.info { background: rgba(90,169,255,.12); color: #cfe4ff; }
.msg.warn { background: rgba(255,180,84,.13); color: #ffe2bb; }
.msg.error { background: rgba(255,107,107,.14); color: #ffd3d3; }
.msg .x { color: inherit; opacity: .7; font-size: 16px; line-height: 1; }
.msg .act { flex: none; align-self: center; padding: 5px 10px; border-radius: 999px; background: rgba(255,255,255,.14); font-weight: 650; }
.msg .act:hover { background: rgba(255,255,255,.22); }
.controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 16px 4px; color: var(--fg2); font-size: 12px; }
.controls .count { flex: 1; min-width: 90px; white-space: nowrap; }
select { font: inherit; font-size: 12px; color: var(--fg); background: var(--bg3); border: 0; border-radius: 7px; padding: 4px 6px; cursor: pointer; max-width: 150px; }
label.chk { display: flex; align-items: center; gap: 5px; cursor: pointer; user-select: none; }
label.chk input { accent-color: var(--accent); margin: 0; }
.actions { display: flex; gap: 8px; padding: 8px 12px 0; }
.btn { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 9px 10px; border-radius: 10px; background: var(--bg3); font-weight: 600; font-size: 12px; min-width: 0; }
.btn span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.btn .ic { width: 16px; height: 16px; }
.btn.primary { background: var(--accent); color: var(--accent-ink); }
.btn:not(:disabled):hover { filter: brightness(1.12); }
.filter { margin: 10px 12px 6px; }
.filter input { width: 100%; font: inherit; color: var(--fg); background: var(--bg2); border: 1px solid var(--line); border-radius: 9px; padding: 8px 10px; outline: none; }
.filter input:focus { border-color: var(--accent); }
.list { position: relative; list-style: none; margin: 0; padding: 0 6px 8px; overflow-y: auto; flex: 1 1 auto; min-height: 60px; overscroll-behavior: contain; }
.list::-webkit-scrollbar { width: 10px; }
.list::-webkit-scrollbar-thumb { background: var(--bg3); border-radius: 10px; border: 3px solid var(--bg); }
.grp { padding: 12px 10px 4px; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--fg3); position: sticky; top: 0; background: var(--bg); z-index: 1; }
.ep { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 9px; cursor: pointer; }
.ep:hover { background: var(--bg2); }
.ep .num { width: 26px; text-align: right; color: var(--fg3); font-variant-numeric: tabular-nums; font-size: 12px; flex: none; }
.ep .txt { flex: 1; min-width: 0; }
.ep .t { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ep .s { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--fg3); font-size: 11px; }
.ep .d { color: var(--fg3); font-size: 11px; font-variant-numeric: tabular-nums; flex: none; }
.ep .w { width: 14px; height: 14px; color: var(--ok); fill: currentColor; flex: none; }
.ep.watched .t { color: var(--fg2); }
.ep.now { background: rgba(90,169,255,.14); }
.ep.now .t, .ep.now .num { color: var(--accent); font-weight: 650; }
.ep.pending .num { color: var(--accent); }
.ep.pending .d::before { content: "Starting… "; color: var(--accent); }
.empty { padding: 20px 16px 24px; color: var(--fg2); text-align: center; }
.empty .btn { display: inline-flex; flex: none; margin-top: 12px; padding: 7px 14px; }
footer { display: flex; gap: 8px; padding: 10px 12px 12px; border-top: 1px solid var(--line); }
footer .btn { background: transparent; border: 1px solid var(--line); color: var(--fg2); font-weight: 500; }
footer .btn:hover { color: var(--fg); }
[hidden] { display: none !important; }
`;

  let host, shadow, $;
  function mount() {
    if (host) return;
    host = document.createElement('archive-cast-ui');
    host.setAttribute('data-ac-version', VERSION);
    shadow = host.attachShadow({ mode: 'open' });
    const b = (cls, action, label, inner, extra) =>
      `<button class="${cls}" data-ac-action="${action}" title="${label}" aria-label="${label}"${extra || ''}>${inner}</button>`;
    shadow.innerHTML = `<style>${CSS}</style>
<div class="root">
  ${b('launcher', 'open-panel', 'Open Archive Cast', svg('cast'), ' hidden')}
  <section class="panel" role="dialog" aria-label="Archive Cast" hidden>
    <header>
      <div class="brand">${svg('cast')}<span>Archive Cast</span></div>
      ${b('device', 'connect', 'Choose a Chromecast', svg('cast') + '<span>Connect</span>')}
      ${b('iconbtn close', 'close-panel', 'Hide panel (casting keeps going)', svg('close'))}
    </header>
    <div class="now" aria-live="polite">
      <div class="now-title">Nothing casting</div>
      <div class="now-sub"></div>
      <div class="seek"><span class="t cur">0:00</span><input class="bar" data-ac-action="seek" type="range" min="0" max="1" step="1" value="0" aria-label="Seek"><span class="t dur">–:––</span></div>
      <div class="transport">
        ${b('tbtn prev', 'previous', 'Previous episode', svg('prev'))}
        ${b('tbtn back', 'back-10', 'Back 10 seconds', svg('replay') + '<b>10</b>')}
        ${b('tbtn main play', 'toggle', 'Play / pause', svg('play'))}
        ${b('tbtn fwd', 'forward-30', 'Forward 30 seconds', svg('replay') + '<b>30</b>')}
        ${b('tbtn next', 'next', 'Next episode', svg('next'))}
      </div>
      <div class="vol">${b('iconbtn mute', 'mute', 'Mute', svg('vol'))}<input class="volbar" data-ac-action="volume" type="range" min="0" max="100" step="1" value="50" aria-label="Volume"></div>
      <div class="now-next"></div>
    </div>
    <div class="msg" role="status" hidden><p></p><button class="act" data-ac-action="message-action" hidden></button><button class="x" title="Dismiss" aria-label="Dismiss">×</button></div>
    <div class="controls">
      <span class="count"></span>
      <select class="source" data-ac-action="source" title="Which list to play" aria-label="Episode source"></select>
      <select class="sort" data-ac-action="sort" title="Order" aria-label="Order"><option value="title">A–Z</option><option value="date">Oldest</option><option value="date-desc">Newest</option></select>
      <select class="mode" data-ac-action="quality" title="Which file to send to the Chromecast" aria-label="Quality"><option value="best">Best quality</option><option value="compat">Most compatible</option></select>
      <label class="chk" title="Start over after the last episode"><input class="loop" data-ac-action="loop" type="checkbox">Loop</label>
      <label class="chk aa" title="When this site’s own Cast episode ends, open the next episode and press play"><input class="aabox" data-ac-action="auto-advance" type="checkbox">Auto-advance</label>
    </div>
    <div class="actions">
      ${b('btn primary playall', 'play-all', 'Play all from the start', svg('play') + '<span>Play all from the start</span>')}
      ${b('btn resume', 'resume', 'Resume', svg('replay') + '<span></span>', ' hidden')}
      ${b('btn more', 'find-more', 'Follow next-episode links to queue the following episodes', svg('more') + '<span>Find next episodes</span>', ' hidden')}
    </div>
    <div class="filter"><input type="search" data-ac-action="filter" placeholder="Find an episode…" aria-label="Filter episodes"></div>
    <ol class="list" aria-label="Episodes"></ol>
    <footer hidden>
      ${b('btn leave', 'disconnect', 'Close this connection; the Chromecast keeps playing', 'Disconnect, keep playing')}
      ${b('btn stop', 'stop', 'Stop playback on the Chromecast', 'Stop casting')}
    </footer>
  </section>
</div>`;
    const q = (s) => shadow.querySelector(s);
    $ = {
      launcher: q('.launcher'), panel: q('.panel'), device: q('.device'), close: q('.close'),
      title: q('.now-title'), sub: q('.now-sub'), next: q('.now-next'), cur: q('.cur'), dur: q('.dur'), bar: q('.bar'),
      prev: q('.prev'), back: q('.back'), play: q('.play'), fwd: q('.fwd'), nextBtn: q('.tbtn.next'),
      mute: q('.mute'), vol: q('.volbar'), msg: q('.msg'), msgAct: q('.msg .act'), count: q('.count'), source: q('.source'),
      sort: q('.sort'), mode: q('.mode'), loop: q('.loop'), aa: q('.aabox'), playall: q('.playall'), resume: q('.resume'),
      more: q('.more'), filter: q('.filter input'), list: q('.list'), footer: q('footer'), leave: q('.leave'), stop: q('.stop'),
    };

    $.launcher.addEventListener('click', () => setOpen(true));
    $.close.addEventListener('click', () => setOpen(false));
    $.device.addEventListener('click', () => { ensureSdk(); send('connect'); });
    $.play.addEventListener('click', () => send('toggle'));
    $.back.addEventListener('click', () => send('seek', { delta: -10 }));
    $.fwd.addEventListener('click', () => send('seek', { delta: 30 }));
    $.prev.addEventListener('click', () => navigate(-1));
    $.nextBtn.addEventListener('click', () => navigate(1));
    $.bar.addEventListener('pointerdown', () => { S.seeking = true; });
    $.bar.addEventListener('input', () => { $.cur.textContent = fmtTime(+$.bar.value); paintRange($.bar); });
    $.bar.addEventListener('change', () => { S.seeking = false; send('seek', { time: +$.bar.value }); });
    $.vol.addEventListener('input', () => { paintRange($.vol); send('volume', { level: $.vol.value / 100 }); });
    $.mute.addEventListener('click', () => send('mute', { muted: !(S.cast && S.cast.muted) }));
    $.msg.querySelector('.x').addEventListener('click', () => { $.msg.hidden = true; });
    $.msgAct.addEventListener('click', () => { const fn = $.msgAct._fn; $.msg.hidden = true; if (fn) fn(); });
    $.source.addEventListener('change', () => { S.source = $.source.value; S.sourcePinned = true; setEps(); render(); });
    $.sort.addEventListener('change', () => {
      S.sort = $.sort.value;
      if (S.isCollection && S.raw) {
        // server-side order decides which items make the cut on big collections
        if (S.raw.total > COLLECTION_LIMIT) { S.raw.docs = null; resolveCollection(); } else { rebuildArchive(); render(); }
      }
    });
    $.mode.addEventListener('change', () => setMode($.mode.value));
    $.loop.addEventListener('change', () => setLoop($.loop.checked));
    $.aa.addEventListener('change', () => setAutoAdvance($.aa.checked));
    $.playall.addEventListener('click', () => loadFrom(0, 0));
    $.resume.addEventListener('click', () => { const r = resumeTarget(); if (r) playEpisode(r.i, r.time); });
    $.more.addEventListener('click', () => findMore().catch((e) => toast(e.message, 'warn')));
    $.filter.addEventListener('input', applyFilter);
    $.list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-ac-action="rescan"]');
      if (btn) { rescanWeb(); return; }
      const li = e.target.closest('.ep');
      if (li) playEpisode(+li.dataset.i, 0);
    });
    $.list.addEventListener('keydown', (e) => {
      const li = e.target.closest('.ep');
      if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); playEpisode(+li.dataset.i, 0); }
    });
    $.leave.addEventListener('click', () => send('disconnect', { stop: false }));
    $.stop.addEventListener('click', () => send('disconnect', { stop: true }));

    (document.body || document.documentElement).appendChild(host);
  }

  function paintRange(el) {
    const max = +el.max || 1;
    el.style.setProperty('--p', ((+el.value / max) * 100).toFixed(2) + '%');
  }

  function setHTML(el, html) {
    if (el._html !== html) { el._html = html; el.innerHTML = html; }
  }

  let toastTimer = null;
  function toast(text, level, action) {
    if (!$) return;
    $.msg.className = 'msg ' + (level || 'info');
    $.msg.querySelector('p').textContent = text;
    $.msgAct.hidden = !action;
    $.msgAct.textContent = action ? action.label : '';
    $.msgAct._fn = action ? action.run : null;
    $.msg.hidden = false;
    clearTimeout(toastTimer);
    if (level === 'info' && !action) toastTimer = setTimeout(() => { $.msg.hidden = true; }, 6000);
  }

  function setOpen(open) {
    S.open = open;
    store.set('ac:open' + ORIGIN_KEY, open);
    if (open) {
      ensureSdk();
      if (S.isCollection) resolveCollection();
      if (!IS_ARCHIVE) rescanWeb();
    }
    render();
    publish();
    if (open) scrollToCurrent(true);
  }

  // Machine-readable state on the host element, for agents that read the DOM.
  function reflectInDom(ps) {
    if (!host) return;
    const np = ps.nowPlaying;
    const state = !ps.cast.state || ps.cast.state === 'NO_DEVICES_AVAILABLE' || ps.cast.state === 'NOT_CONNECTED' ? 'disconnected'
      : ps.cast.state === 'CONNECTING' ? 'connecting'
        : !np ? 'connected'
          : np.state === 'IDLE' ? (np.idleReason === 'FINISHED' ? 'finished' : 'connected') : np.state.toLowerCase();
    const attrs = {
      'data-ac-state': state, 'data-ac-device': ps.cast.device || '', 'data-ac-episode-count': String(ps.episodeCount),
      'data-ac-episode-index': np && np.index != null ? String(np.index) : '', 'data-ac-episode-title': np ? np.title || '' : '',
      'data-ac-source': ps.source || '', 'data-ac-status': ps.page.status,
    };
    for (const [k, v] of Object.entries(attrs)) if (host.getAttribute(k) !== v) host.setAttribute(k, v);
  }

  // ---------------------------------------------------------------- render
  function render() {
    if (!$) return;
    publish();
    const hasContent = S.status === 'collection' || (S.status === 'ready' && S.eps.length > 0);
    const live = !!(S.cast && (S.cast.castState === 'CONNECTED' || (S.cast.site && S.cast.site.connected && S.autoAdvance)));
    $.launcher.hidden = S.open || !(hasContent || live);
    $.launcher.classList.toggle('live', live);
    $.panel.hidden = !S.open;
    if (!S.open) return;
    renderNow();
    renderControls();
    renderList(true);
  }

  function renderStatus() {
    if (!$ || !S.open) return;
    const empty = $.list.querySelector('.empty');
    if (empty && S.status === 'loading') empty.textContent = S.statusText;
  }

  let csrOffered = false;
  function renderNow() {
    if (!$ || !S.open) return;
    const st = S.cast;
    const m = st && st.media;
    const connected = !!(st && st.castState === 'CONNECTED');

    // device pill
    let label = 'Connect', on = false, disabled = false;
    if (!st || st.sdk === 'loading' || st.sdk === 'idle') { label = 'Starting…'; disabled = !!st; }
    else if (st.sdk === 'unavailable' || st.sdk === 'blocked') { label = 'Cast unavailable'; disabled = true; }
    else if (connected) { label = st.device || 'Connected'; on = true; }
    else if (st.castState === 'CONNECTING') { label = 'Connecting…'; disabled = true; }
    else if (st.castState === 'NO_DEVICES_AVAILABLE') label = 'No Chromecast found';
    setHTML($.device, svg(on ? 'castOn' : 'cast') + `<span>${esc(label)}</span>`);
    $.device.classList.toggle('on', on);
    $.device.disabled = disabled;
    const tip = on ? 'Casting to ' + label : st && st.sdkError ? st.sdkError : 'Choose a Chromecast';
    $.device.title = tip;
    $.device.setAttribute('aria-label', tip);
    $.footer.hidden = !connected;

    if (st && st.sdk === 'blocked' && !csrOffered) {
      csrOffered = true;
      toast('This site’s security policy blocks Google Cast. Allow Archive Cast to relax it for this tab only? The page will reload.', 'warn', {
        label: 'Allow',
        run: async () => {
          const r = await bg('relaxCsp');
          if (r && r.already) toast('This page still blocks Google Cast (it sets its policy inside the page), so casting can’t work here.', 'error');
        },
      });
    }

    const i = indexOfMedia(m);
    const ep = i >= 0 ? S.eps[i] : null;
    const site = st && st.site;
    if (m && m.playerState !== 'IDLE') {
      $.title.textContent = ep ? ep.title : m.title || 'Casting';
      $.sub.textContent = ep ? `${ep.show} · ${i + 1} of ${S.eps.length}` : m.subtitle || '';
      $.next.textContent = ep && S.eps[i + 1] ? 'Up next: ' + S.eps[i + 1].title : '';
    } else if (m && m.playerState === 'IDLE' && m.idleReason === 'FINISHED') {
      $.title.textContent = 'Finished';
      $.sub.textContent = 'Reached the end of the queue.';
      $.next.textContent = '';
    } else if (!connected && site && site.connected && site.media) {
      $.title.textContent = site.media.title || 'Casting with this site’s player';
      $.sub.textContent = `This site’s player · ${site.device || 'Chromecast'}`;
      $.next.textContent = S.autoAdvance ? (S.nextUrl ? 'Auto-advance is on — the next episode opens when this one ends.' : 'Auto-advance is on, but there’s no next-episode link here.') : '';
    } else {
      $.title.textContent = connected ? 'Pick an episode to start' : st && st.sdkError ? 'Cast unavailable' : 'Nothing casting';
      $.sub.textContent = connected ? 'Connected to ' + st.device
        : st && st.sdkError ? st.sdkError
          : 'Click an episode — you’ll be asked which Chromecast to use.';
      $.next.textContent = '';
    }
    if (st && st.loading) $.sub.textContent = 'Sending the queue to your Chromecast…';
    else if (m && m.playerState === 'BUFFERING') $.sub.textContent = 'Buffering…';

    const active = !!(m && m.playerState !== 'IDLE');
    for (const el of [$.play, $.back, $.fwd, $.bar]) el.disabled = !active;
    $.prev.disabled = !active || i === 0;
    $.nextBtn.disabled = !active || (i >= 0 && i === S.eps.length - 1 && !S.settings.loop);
    setHTML($.play, svg(m && (m.playerState === 'PLAYING' || m.playerState === 'BUFFERING') ? 'pause' : 'play'));
    const dur = (m && (m.duration || (ep && ep.duration))) || 0;
    if (!S.seeking) {
      $.bar.max = String(Math.max(1, Math.floor(dur)));
      $.bar.value = String(active ? Math.floor(m.time || 0) : 0);
      $.cur.textContent = active ? fmtTime(m.time) : '0:00';
      paintRange($.bar);
    }
    $.dur.textContent = active && dur ? fmtTime(dur) : '–:––';
    $.vol.disabled = $.mute.disabled = !connected;
    if (connected && st.volume != null && shadow.activeElement !== $.vol) {
      $.vol.value = String(Math.round(st.volume * 100));
    }
    paintRange($.vol);
    setHTML($.mute, svg(st && st.muted ? 'mute' : 'vol'));
  }

  function renderControls() {
    const n = S.eps.length;
    let count = '';
    if (S.crawling) count = S.crawlText;
    else if (S.status === 'ready' && n) {
      count = `${n} episode${n === 1 ? '' : 's'}`;
      if (S.isCollection && S.raw.total > COLLECTION_LIMIT) count += ` · first ${COLLECTION_LIMIT} of ${S.raw.total} items`;
    }
    $.count.textContent = count;
    const ids = sourceIds();
    const opts = ids.map((id) => `<option value="${id}">${esc(S.labels[id])} (${S.lists[id].length})</option>`).join('');
    setHTML($.source, opts);
    $.source.hidden = ids.length < 2;
    if (S.source) $.source.value = S.source;
    $.sort.hidden = !S.isCollection;
    $.sort.value = S.sort;
    $.mode.value = S.settings.mode;
    $.loop.checked = S.settings.loop;
    $.aa.checked = S.autoAdvance;
    const ready = S.status === 'ready' && n > 0;
    $.playall.hidden = !ready;
    $.mode.hidden = !ready || !IS_ARCHIVE;
    $.loop.parentElement.hidden = !ready;
    $.aa.parentElement.hidden = IS_ARCHIVE || !(S.nextUrl || (S.cast && S.cast.site && S.cast.site.connected));
    $.more.hidden = IS_ARCHIVE || !S.nextUrl || S.source === 'follow';
    $.more.disabled = S.crawling;
    $.playall.parentElement.hidden = $.playall.hidden && $.more.hidden;
    $.filter.parentElement.hidden = !ready || n < 8;
    const r = ready ? resumeTarget() : null;
    const i = currentIndex();
    $.resume.hidden = !r || i >= 0;
    if (r) {
      const ep = S.eps[r.i];
      $.resume.querySelector('span').textContent = `Resume · ${ep.title}${r.time > 30 ? ' · ' + fmtTime(r.time) : ''}`;
      $.resume.title = `Resume “${ep.title}”`;
      $.resume.setAttribute('aria-label', $.resume.title);
      $.playall.querySelector('span').textContent = 'Start over';
    } else $.playall.querySelector('span').textContent = 'Play all from the start';
  }

  let listKey = null;
  function renderList(force) {
    if (!$ || !S.open) return;
    const key = S.status + '|' + S.eps.length + '|' + (S.eps[0] && S.eps[0].url) + '|' + S.source;
    if (force || key !== listKey) {
      listKey = key;
      $.list.innerHTML = listHtml();
      applyFilter();
      S.scrolledTo = null;
    }
    const cur = currentIndex();
    for (const li of $.list.querySelectorAll('.ep')) {
      const i = +li.dataset.i;
      const now = i === cur;
      if (li.classList.contains('now') !== now) {
        li.classList.toggle('now', now);
        if (now) li.setAttribute('aria-current', 'true'); else li.removeAttribute('aria-current');
      }
      li.classList.toggle('pending', i === S.pending && i !== cur);
      const watched = S.watched.has(S.eps[i].uid);
      if (li.classList.contains('watched') !== watched) {
        li.classList.toggle('watched', watched);
        li.querySelector('.w').innerHTML = watched ? `<path d="${ICON.check}"/>` : '';
      }
    }
    if (cur >= 0 && S.scrolledTo !== cur) scrollToCurrent();
  }

  function listHtml() {
    if (S.status === 'loading') return `<li class="empty">${esc(S.statusText)}</li>`;
    if (S.status === 'nopage') return `<li class="empty">Open a TV show, radio series or podcast on archive.org to pick episodes.<br>The controls above work from any archive.org page.</li>`;
    if (S.status === 'error') return `<li class="empty">${esc(S.statusText)}</li>`;
    if (!S.eps.length) {
      if (IS_ARCHIVE) return `<li class="empty">No Chromecast-playable video or audio files in this item.</li>`;
      return `<li class="empty">No playable video or audio found yet.<br>Start the site’s player for a moment, then rescan.` +
        `<br><button class="btn" data-ac-action="rescan" aria-label="Rescan this page">Rescan</button></li>`;
    }
    const folders = new Set(S.eps.map((e) => e.folder));
    const grouped = folders.size > 1;
    let html = '', lastFolder = null;
    S.eps.forEach((ep, i) => {
      if (grouped && ep.folder !== lastFolder) {
        lastFolder = ep.folder;
        html += `<li class="grp">${esc(ep.folder.split('/').pop() || 'Other')}</li>`;
      }
      let sub = '';
      if (IS_ARCHIVE) {
        const clean = EP.cleanName(ep.file);
        sub = clean.toLowerCase() !== ep.title.toLowerCase() ? clean : '';
      } else {
        let host = '';
        try { host = new URL(ep.url).hostname.replace(/^www\./, ''); } catch (_) { /* ignore */ }
        sub = [ep.format, host].filter(Boolean).join(' · ');
      }
      html += `<li class="ep" role="button" tabindex="0" data-i="${i}" aria-label="Play episode ${i + 1}: ${esc(ep.title)}" title="${esc(ep.file)}"><span class="num">${i + 1}</span>` +
        `<span class="txt"><span class="t">${esc(ep.short)}</span>${sub ? `<span class="s">${esc(sub)}</span>` : ''}</span>` +
        `<svg class="w" viewBox="0 0 24 24" aria-hidden="true"></svg><span class="d">${ep.duration ? fmtTime(ep.duration) : ''}</span></li>`;
    });
    return html;
  }

  function applyFilter() {
    if (!$) return;
    const q = $.filter.value.trim().toLowerCase();
    for (const li of $.list.children) {
      if (li.classList.contains('grp')) { li.hidden = !!q; continue; }
      if (!li.classList.contains('ep')) continue;
      const ep = S.eps[+li.dataset.i];
      li.hidden = !!q && !(ep.title + ' ' + ep.file).toLowerCase().includes(q);
    }
  }

  function scrollToCurrent(force) {
    if (!$ || !S.open) return;
    let i = currentIndex();
    if (i < 0 && force) { const r = resumeTarget(); i = r ? r.i : -1; }
    if (i < 0) return;
    const li = $.list.querySelector(`.ep[data-i="${i}"]`);
    if (!li) return;
    S.scrolledTo = i;
    const top = li.offsetTop - $.list.clientHeight / 3;
    $.list.scrollTo({ top: Math.max(0, top) });
  }

  // ---------------------------------------------------------------- boot
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'ping') { sendResponse({ ok: true, version: VERSION }); return; }
    if (msg.type === 'toggle-panel') setOpen(!S.open);
    else if (msg.type === 'open-panel') setOpen(true);
    else if (msg.type === 'streams-changed' && !IS_ARCHIVE) rescanWeb();
    else if (msg.type === 'api') {
      runApi(msg.cmd, msg.args).then(
        (result) => sendResponse({ ok: true, result }),
        (e) => sendResponse({ ok: false, error: e.message || String(e) }),
      );
      return true;
    }
  });

  async function loadPage() {
    S.path = location.pathname;
    if (IS_ARCHIVE) await loadArchive(); else await loadWeb();
  }

  async function boot() {
    const [settings, open, castingAt, aa] = await Promise.all([
      store.get('ac:settings', null), store.get('ac:open' + ORIGIN_KEY, false),
      store.get('ac:castingAt' + ORIGIN_KEY, 0), store.get('ac:aa' + ORIGIN_KEY, false),
    ]);
    if (settings) Object.assign(S.settings, settings);
    S.autoAdvance = !IS_ARCHIVE && !!aa;
    mount();
    const wantOpen = open || location.hash === '#archive-cast';
    // re-attach to a running cast so progress tracking and the live indicator keep working
    if (wantOpen || S.autoAdvance || Date.now() - castingAt < RECENT_CAST_MS) ensureSdk();
    await loadPage();
    readyResolve();
    if (wantOpen) setOpen(true);
    publish();
    if (!IS_ARCHIVE) {
      continueAssist();
      // players often fetch their media late; look again a few times
      for (const ms of [3000, 8000, 15000]) setTimeout(() => { if (!S.crawling) rescanWeb(); }, ms);
    }
    setInterval(() => {
      if (location.pathname !== S.path) loadPage();
      else if (!IS_ARCHIVE && S.open && !S.crawling) rescanWeb();
    }, IS_ARCHIVE ? 1000 : 4000);
  }

  boot();
})();
