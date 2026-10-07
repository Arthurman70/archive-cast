// Archive Cast service worker.
// - Toolbar button: toggles the panel (injecting it on any site you open it on).
// - Watches network responses for castable media so JS-built players can be cast too.
// - Routes commands from other extensions and the local MCP bridge to the right tab.
importScripts('lib/generic.js', 'lib/commands.js', 'lib/youtube.js');

const GEN = self.ArchiveCastGeneric;
const CMDS = self.ArchiveCastCommands;
const VERSION = chrome.runtime.getManifest().version;
const ARCHIVE = /^https:\/\/(www\.)?archive\.org\//i;
const ISO_FILES = ['lib/episodes.js', 'lib/generic.js', 'lib/commands.js', 'lib/youtube.js', 'content.js'];
const MAIN_FILES = ['castbridge.js'];
const BRIDGE_DEFAULTS = { enabled: false, port: 47811, allowExtensions: false };
const MAX_FETCH_BYTES = 8 * 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isHttp = (url) => /^https?:\/\//i.test(url || '');

// ================================================================ injection
async function ping(tabId) {
  try { const r = await chrome.tabs.sendMessage(tabId, { type: 'ping' }); return !!(r && r.ok); } catch (_) { return false; }
}

async function ensureInjected(tabId) {
  if (await ping(tabId)) return;
  await chrome.scripting.executeScript({ target: { tabId }, files: MAIN_FILES, world: 'MAIN' });
  await chrome.scripting.executeScript({ target: { tabId }, files: ISO_FILES });
  for (let i = 0; i < 30; i++) {
    if (await ping(tabId)) return;
    await sleep(100);
  }
  throw new Error('Archive Cast could not start in that tab.');
}

async function showPanel(tabId, type) {
  await ensureInjected(tabId);
  await chrome.tabs.sendMessage(tabId, { type }).catch(() => {});
}

// Sites you opened the panel on get the launcher automatically on later visits.
async function getSites() {
  const { 'ac:sites': sites } = await chrome.storage.local.get('ac:sites');
  return Array.isArray(sites) ? sites : [];
}

async function addSite(origin) {
  const sites = await getSites();
  if (sites.includes(origin)) return;
  sites.push(origin);
  await chrome.storage.local.set({ 'ac:sites': sites });
}

const SITE_SCRIPT_IDS = ['ac-sites-main', 'ac-sites-iso'];
let siteSync = Promise.resolve();
// serialized: overlapping unregister/register pairs would collide on the script IDs
function syncSiteScripts() {
  siteSync = siteSync.then(doSyncSiteScripts, doSyncSiteScripts);
  return siteSync;
}

async function doSyncSiteScripts() {
  const sites = await getSites();
  await chrome.scripting.unregisterContentScripts({ ids: SITE_SCRIPT_IDS }).catch(() => {});
  const matches = [...new Set(sites.map((o) => { try { const u = new URL(o); return `${u.protocol}//${u.hostname}/*`; } catch (_) { return null; } }).filter(Boolean))];
  if (!matches.length) return;
  await chrome.scripting.registerContentScripts([
    { id: SITE_SCRIPT_IDS[0], matches, js: MAIN_FILES, runAt: 'document_idle', world: 'MAIN', persistAcrossSessions: true },
    { id: SITE_SCRIPT_IDS[1], matches, js: ISO_FILES, runAt: 'document_idle', persistAcrossSessions: true },
  ]);
}

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.url && isHttp(tab.url) && !/^https:\/\/(chrome|chromewebstore)\.google\.com\//.test(tab.url)) {
    if (!ARCHIVE.test(tab.url)) await addSite(new URL(tab.url).origin);
    try { await showPanel(tab.id, 'toggle-panel'); } catch (_) { /* restricted page */ }
    return;
  }
  // not a web page: go back to the show you were casting
  const { 'ac:last': last } = await chrome.storage.local.get('ac:last');
  chrome.tabs.create({ url: last ? `https://archive.org/details/${encodeURIComponent(last)}#archive-cast` : 'https://archive.org/details/classic_tv#archive-cast' });
});

// ================================================================ stream sniffer
// Remembers whole media files / HLS / DASH manifests each tab loads (never segments).
// Stays in this browser: memory + session storage, cleared when the tab navigates or closes.
const streams = new Map();
const notifyTimers = new Map();

async function getStreams(tabId) {
  if (streams.has(tabId)) return streams.get(tabId);
  const key = 'ac:streams:' + tabId;
  const o = await chrome.storage.session.get(key);
  const list = o[key] || [];
  streams.set(tabId, list);
  return list;
}

function saveStreams(tabId) {
  const list = streams.get(tabId) || [];
  chrome.storage.session.set({ ['ac:streams:' + tabId]: list }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: list.length ? String(list.length) : '' }).catch(() => {});
}

async function addStream(tabId, item) {
  const list = await getStreams(tabId);
  if (list.some((s) => s.url === item.url)) return;
  if (/mpegurl|dash/.test(item.mime)) {
    // variant/rendition playlists usually live next to (or under) the master playlist
    const variant = list.some((s) => /mpegurl|dash/.test(s.mime) && item.url.startsWith(s.url.slice(0, s.url.lastIndexOf('/') + 1)));
    if (variant) return;
  }
  list.push(Object.assign({ at: Date.now() }, item));
  if (list.length > 30) list.shift();
  saveStreams(tabId);
  clearTimeout(notifyTimers.get(tabId));
  notifyTimers.set(tabId, setTimeout(() => chrome.tabs.sendMessage(tabId, { type: 'streams-changed' }).catch(() => {}), 800));
}

chrome.webRequest.onHeadersReceived.addListener((d) => {
  if (d.tabId < 0 || (d.initiator && d.initiator.startsWith('chrome-extension://'))) return;
  const h = {};
  for (const x of d.responseHeaders || []) h[x.name.toLowerCase()] = x.value;
  const item = GEN.classifyResponse({
    url: d.url, contentType: h['content-type'], contentLength: h['content-length'], contentRange: h['content-range'], status: d.statusCode,
  });
  if (item) addStream(d.tabId, item);
}, { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object'] }, ['responseHeaders']);

chrome.webRequest.onBeforeRequest.addListener((d) => {
  if (d.tabId < 0) return;
  streams.set(d.tabId, []);
  saveStreams(d.tabId);
}, { urls: ['<all_urls>'], types: ['main_frame'] });

// ================================================================ messages from content scripts
const tabStatus = new Map();

async function restoreStatus() {
  const { 'ac:tabStatus': saved } = await chrome.storage.session.get('ac:tabStatus');
  for (const [id, s] of Object.entries(saved || {})) if (!tabStatus.has(+id)) tabStatus.set(+id, s);
}
const statusReady = restoreStatus();

function persistStatus() {
  chrome.storage.session.set({ 'ac:tabStatus': Object.fromEntries(tabStatus) }).catch(() => {});
}

chrome.tabs.onRemoved.addListener((tabId) => {
  streams.delete(tabId);
  chrome.storage.session.remove(['ac:streams:' + tabId, 'ac:assist:' + tabId]).catch(() => {});
  if (tabStatus.delete(tabId)) persistStatus();
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId] }).catch(() => {});
  ytGet().then((s) => {
    if (s.playerTabId !== tabId) return;
    Object.assign(s, { playerTabId: null, status: null, finished: false });
    ytSave();
    ytBroadcast();
  });
});

async function fetchForPage(url) {
  if (!isHttp(url)) throw new Error('Only http(s) URLs can be fetched.');
  // never send cookies: a page must not be able to read other sites as the user through us
  const r = await fetch(url, { credentials: 'omit', redirect: 'follow' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const len = +r.headers.get('content-length');
  if (len > MAX_FETCH_BYTES) throw new Error('Response too large');
  const ct = r.headers.get('content-type') || '';
  if (/^(video|audio|image)\//i.test(ct)) throw new Error('Not a page or feed');
  const text = await r.text();
  if (text.length > MAX_FETCH_BYTES) throw new Error('Response too large');
  return text;
}

async function relaxCsp(tabId) {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  if (rules.some((r) => r.id === tabId)) return { ok: false, already: true };
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [{
      id: tabId,
      priority: 1,
      condition: { tabIds: [tabId], resourceTypes: ['main_frame'] },
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'content-security-policy', operation: 'remove' },
          { header: 'content-security-policy-report-only', operation: 'remove' },
        ],
      },
    }],
  });
  chrome.tabs.reload(tabId);
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;
  if (!msg || tabId == null) return;
  const reply = (p) => { p.then((v) => sendResponse(v), (e) => sendResponse({ ok: false, error: e.message || String(e) })); return true; };
  switch (msg.type) {
    case 'streams': return reply(getStreams(tabId).then((list) => ({ ok: true, streams: list })));
    case 'fetch': return reply(fetchForPage(msg.url).then((text) => ({ ok: true, text })));
    case 'status':
      tabStatus.set(tabId, Object.assign({}, msg.status, { at: Date.now() }));
      persistStatus();
      return;
    case 'assist': {
      const key = 'ac:assist:' + tabId;
      if (msg.set) return reply(chrome.storage.session.set({ [key]: msg.set }).then(() => ({ ok: true })));
      return reply(chrome.storage.session.get(key).then(async (o) => {
        if (msg.take) await chrome.storage.session.remove(key);
        return { ok: true, assist: o[key] || null };
      }));
    }
    case 'relaxCsp': return reply(relaxCsp(tabId));
    case 'yt': return reply(ytFromTab(msg, sender.tab));
    case 'api':
      // youtube.com pages may drive the YouTube queue through window.ArchiveCast; nothing else
      if (!/^youtube[A-Z]/.test(msg.cmd || '') || !/^https:\/\/(www\.|m\.)?youtube\.com\//.test(sender.tab.url || '')) return;
      return reply(routeApi(msg.cmd, msg.args).then((result) => ({ ok: true, result })));
    case 'openSettings':
      // Brave: Settings → Extensions holds the "Media Router" (Google Cast) switch
      chrome.tabs.create({ url: 'chrome://settings/extensions' }).catch(() => chrome.tabs.create({ url: 'chrome://settings' }));
      return;
  }
});

// ================================================================ YouTube queue + player tab
// The queue lives in storage.local; playback state in storage.session. Videos play in a dedicated
// youtube.com tab (the "player tab") driven through ytbridge.js. For the TV that tab goes
// full-bleed ("TV mode") in its own window and the browser casts the tab, so the TV's YouTube app
// is never involved and the browser's own ad blocking (e.g. Brave Shields) applies.
const YT = self.ArchiveCastYouTube;
const YT_DEFAULTS = { items: [], index: 0, target: 'computer', tv: false, playerTabId: null, status: null, finished: false, listKey: null, endedFor: null, loadedAt: 0, lastError: null };
let ytState = null;

async function ytGet() {
  if (!ytState) {
    const o = await chrome.storage.session.get('ac:yt');
    ytState = Object.assign({}, YT_DEFAULTS, o['ac:yt']);
  }
  return ytState;
}

function ytSave() { chrome.storage.session.set({ 'ac:yt': ytState }).catch(() => {}); }

async function ytQueue() {
  const o = await chrome.storage.local.get('ac:ytq');
  return Array.isArray(o['ac:ytq']) ? o['ac:ytq'] : [];
}

async function ytSetQueue(q) {
  await chrome.storage.local.set({ 'ac:ytq': q });
  ytBroadcast();
  return q;
}

async function oembed(id) {
  try {
    const r = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(YT.watchUrl(id)), { credentials: 'omit' });
    if (!r.ok) return null;
    const j = await r.json();
    return { title: j.title || null, channel: j.author_name || null };
  } catch (_) { return null; }
}

// videos: IDs, YouTube URLs, or {id|url, title?, channel?, duration?}
async function ytNormalize(videos) {
  const out = [];
  for (const v of [].concat(videos || [])) {
    const id = typeof v === 'string' ? (YT.isId(v) ? v : YT.videoId(v))
      : v && (YT.isId(v.id) ? v.id : YT.videoId(v.url || ''));
    if (!id) throw new Error('Not a YouTube video: ' + (typeof v === 'string' ? v : JSON.stringify(v)));
    out.push({ id, title: (v && v.title) || null, channel: (v && v.channel) || null, duration: (v && v.duration) || null });
  }
  await Promise.all(out.filter((v) => !v.title).map(async (v) => {
    const m = await oembed(v.id);
    if (m) { v.title = m.title; v.channel = v.channel || m.channel; }
  }));
  for (const v of out) if (!v.title) v.title = v.id;
  return out;
}

async function ytQueueAdd(videos, next) {
  const add = await ytNormalize(videos);
  if (!add.length) throw new Error('No videos given.');
  const ids = new Set(add.map((v) => v.id));
  const q = (await ytQueue()).filter((v) => !ids.has(v.id)); // re-adding moves a video
  const s = await ytGet();
  let at = q.length;
  if (next) {
    const playing = s.playerTabId != null && s.listKey === 'ytqueue' && s.items[s.index];
    at = (playing ? q.findIndex((v) => v.id === playing.id) : -1) + 1;
  }
  q.splice(at, 0, ...add);
  await ytSetQueue(q);
  return { added: add.map((v) => v.title), queue: q };
}

async function ytQueueRemove(index) {
  const q = await ytQueue();
  if (!(index >= 0 && index < q.length)) throw new Error(`No queue item ${index} (the queue has ${q.length}).`);
  const [removed] = q.splice(index, 1);
  await ytSetQueue(q);
  return { removed: removed.title, queue: q };
}

async function ytQueueMove(from, to) {
  const q = await ytQueue();
  if (!(from >= 0 && from < q.length) || !(to >= 0 && to < q.length)) throw new Error('Queue position out of range.');
  const [v] = q.splice(from, 1);
  q.splice(to, 0, v);
  await ytSetQueue(q);
  return { queue: q };
}

function ytPublic(s) {
  return {
    active: s.playerTabId != null, target: s.target, tv: s.tv, index: s.index, finished: s.finished, listKey: s.listKey,
    items: s.items.map(({ id, title, channel, duration }) => ({ id, title, channel, duration })),
    status: s.status, lastError: s.lastError, playerTabId: s.playerTabId,
  };
}

let ytTimer = null;
function ytBroadcast() {
  if (ytTimer) return;
  ytTimer = setTimeout(async () => {
    ytTimer = null;
    const msg = { type: 'yt-update', yt: ytPublic(await ytGet()), queue: await ytQueue() };
    for (const t of await chrome.tabs.query({ url: ['*://*.youtube.com/*'] })) chrome.tabs.sendMessage(t.id, msg).catch(() => {});
  }, 250);
}

async function ytPlayerTab() {
  const s = await ytGet();
  return s.playerTabId != null ? chrome.tabs.get(s.playerTabId).catch(() => null) : null;
}

async function ytCmd(cmd) {
  const tab = await ytPlayerTab();
  if (!tab) throw new Error('Nothing is playing. Start the YouTube queue first.');
  try { return await chrome.tabs.sendMessage(tab.id, Object.assign({ type: 'yt-cmd' }, cmd)); } catch (_) {
    throw new Error('The YouTube player tab isn’t responding (it may still be loading).');
  }
}

// Computer: a normal tab. TV: its own window, full-bleed, ready to be cast as a tab.
async function ytApplyTarget(tab) {
  const s = await ytGet();
  s.tv = s.target === 'tv';
  ytSave();
  if (s.tv) {
    const siblings = await chrome.tabs.query({ windowId: tab.windowId });
    if (siblings.length > 1) await chrome.windows.create({ tabId: tab.id, focused: true, width: 1280, height: 760 });
    else await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  chrome.tabs.sendMessage(tab.id, { type: 'yt-cmd', cmd: 'tv', on: s.tv }).catch(() => {});
}

async function ytOpenPlayer(startTime) {
  const s = await ytGet();
  const cur = s.items[s.index];
  let tab = await ytPlayerTab();
  if (tab) {
    await ytApplyTarget(tab);
    await chrome.tabs.sendMessage(tab.id, { type: 'yt-cmd', cmd: 'load', id: cur.id, start: startTime || 0, force: true }).catch(() => {});
    return tab.id;
  }
  const url = YT.watchUrl(cur.id) + '&ac_player=1' + (startTime > 0 ? `&t=${Math.floor(startTime)}s` : '');
  if (s.target === 'tv') tab = (await chrome.windows.create({ url, focused: true, width: 1280, height: 760 })).tabs[0];
  else tab = await chrome.tabs.create({ url, active: true });
  s.playerTabId = tab.id;
  ytSave();
  return tab.id;
}

async function ytPlay({ videos, index = 0, startTime = 0, target, listKey }) {
  const s = await ytGet();
  let items;
  if (videos && [].concat(videos).length) items = await ytNormalize(videos);
  else {
    items = await ytQueue();
    listKey = 'ytqueue';
    if (!items.length) throw new Error('The YouTube queue is empty — add videos first.');
  }
  if (!(index >= 0 && index < items.length)) throw new Error(`Video index ${index} is out of range (0–${items.length - 1}).`);
  if (target && !['computer', 'tv'].includes(target)) throw new Error('target must be "computer" or "tv".');
  Object.assign(s, {
    items: items.slice(0, 1000), index, target: target || s.target || 'computer', finished: false,
    listKey: listKey || null, endedFor: null, loadedAt: Date.now(), lastError: null,
  });
  s.tv = s.target === 'tv';
  ytSave();
  const playerTabId = await ytOpenPlayer(startTime);
  ytBroadcast();
  return Object.assign(ytPublic(s), { playerTabId });
}

async function ytAdvance(dir, natural) {
  const s = await ytGet();
  let i = s.index + dir;
  if (i >= s.items.length) {
    const { 'ac:settings': settings } = await chrome.storage.local.get('ac:settings');
    if (settings && settings.loop) i = 0;
    else if (natural) { s.finished = true; ytSave(); ytBroadcast(); return; } else throw new Error('That was the last video.');
  }
  if (i < 0) { if (natural) i = 0; else throw new Error('This is the first video.'); }
  Object.assign(s, { index: i, finished: false, endedFor: null, loadedAt: Date.now() });
  ytSave();
  await ytCmd({ cmd: 'load', id: s.items[i].id, force: true });
  ytBroadcast();
}

async function ytStatus(tabId, st) {
  const s = await ytGet();
  if (tabId !== s.playerTabId || !st) return;
  s.status = st;
  const cur = s.items[s.index];
  const key = cur && cur.id + ':' + s.index;
  if (cur && st.state === 'ENDED' && st.videoId === cur.id && s.endedFor !== key) {
    s.endedFor = key;
    return ytAdvance(1, true);
  }
  // YouTube's own autoplay (or a stray click) swapped the video: put ours back
  if (cur && st.ready && st.videoId && st.videoId !== cur.id && !st.ad && Date.now() - s.loadedAt > 6000 && !s.finished) {
    s.loadedAt = Date.now();
    ytCmd({ cmd: 'load', id: cur.id, force: true }).catch(() => {});
  }
  ytSave();
  ytBroadcast();
}

async function ytPlayerError(tabId, info) {
  const s = await ytGet();
  if (tabId !== s.playerTabId) return;
  const cur = s.items[s.index];
  s.lastError = { id: info.videoId || (cur && cur.id), code: info.code, title: cur && cur.title };
  ytSave();
  await ytAdvance(1, true).catch(() => {});
}

async function ytControl(a) {
  const s = await ytGet();
  switch (a.action) {
    case 'next': await ytAdvance(1, false); break;
    case 'previous': await ytAdvance(-1, false); break;
    case 'jump':
      if (!(a.index >= 0 && a.index < s.items.length)) throw new Error('Video index out of range.');
      Object.assign(s, { index: a.index, finished: false, endedFor: null, loadedAt: Date.now() });
      ytSave();
      await ytCmd({ cmd: 'load', id: s.items[a.index].id, force: true });
      break;
    case 'pause': await ytCmd({ cmd: 'pause' }); break;
    case 'resume':
    case 'play': await ytCmd({ cmd: 'play' }); break;
    case 'toggle': await ytCmd({ cmd: 'toggle' }); break;
    case 'seek':
      if (a.time == null && a.delta == null) throw new Error('Give "time" or "delta" (seconds).');
      await ytCmd({ cmd: 'seek', time: a.time, delta: a.delta });
      break;
    case 'volume':
      if (!(a.level >= 0 && a.level <= 1)) throw new Error('level must be between 0 and 1.');
      await ytCmd({ cmd: 'volume', level: a.level });
      break;
    case 'mute': await ytCmd({ cmd: 'mute', muted: a.muted !== false }); break;
    case 'stop': {
      const tab = await ytPlayerTab();
      Object.assign(s, { playerTabId: null, status: null, finished: false });
      ytSave();
      if (tab) chrome.tabs.remove(tab.id).catch(() => {});
      ytBroadcast();
      return ytPublic(s);
    }
    case 'target': {
      if (!['computer', 'tv'].includes(a.target)) throw new Error('target must be "computer" or "tv".');
      s.target = a.target;
      s.tv = a.target === 'tv';
      ytSave();
      const tab = await ytPlayerTab();
      if (tab) await ytApplyTarget(tab);
      ytBroadcast();
      return ytPublic(s);
    }
    case 'show': {
      const tab = await ytPlayerTab();
      if (!tab) throw new Error('No player tab is open.');
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return ytPublic(s);
    }
    default: throw new Error(`Unknown YouTube action “${a.action}”.`);
  }
  await sleep(700);
  return ytPublic(await ytGet());
}

async function ytHello(tab) {
  const s = await ytGet();
  let isPlayer = tab.id === s.playerTabId;
  if (!isPlayer && s.playerTabId == null && /[?&]ac_player=1/.test(tab.url || '') && s.items.length) {
    s.playerTabId = tab.id; // adopt a player tab that outlived a service-worker restart
    ytSave();
    isPlayer = true;
  }
  const cur = isPlayer ? s.items[s.index] : null;
  return { ok: true, player: isPlayer, tv: s.tv, current: cur ? { id: cur.id } : null, yt: ytPublic(s), queue: await ytQueue() };
}

async function ytFromTab(msg, tab) {
  switch (msg.action) {
    case 'hello': return ytHello(tab);
    case 'get': return { ok: true, yt: ytPublic(await ytGet()), queue: await ytQueue() };
    case 'status': await ytStatus(tab.id, msg.status); return { ok: true };
    case 'error': await ytPlayerError(tab.id, msg); return { ok: true };
    case 'play': return { ok: true, yt: await ytPlay(msg) };
    case 'queueAdd': return Object.assign({ ok: true }, await ytQueueAdd(msg.videos, msg.next));
    case 'queueRemove': return Object.assign({ ok: true }, await ytQueueRemove(msg.index));
    case 'queueMove': return Object.assign({ ok: true }, await ytQueueMove(msg.from, msg.to));
    case 'queueClear': return { ok: true, queue: await ytSetQueue([]) };
    default: return { ok: true, yt: await ytControl(msg) };
  }
}

function flashBadge(tabId, text) {
  if (tabId == null) return;
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  setTimeout(() => getStreams(tabId).then((l) => chrome.action.setBadgeText({ tabId, text: l.length ? String(l.length) : '' })).catch(() => {}), 1500);
}

function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'ac-yt-link', title: 'Add to Archive Cast queue', contexts: ['link'],
      targetUrlPatterns: ['*://*.youtube.com/watch*', '*://*.youtube.com/shorts/*', '*://youtu.be/*'],
    });
    chrome.contextMenus.create({
      id: 'ac-yt-page', title: 'Add this video to Archive Cast queue', contexts: ['page', 'video'],
      documentUrlPatterns: ['*://*.youtube.com/watch*', '*://*.youtube.com/shorts/*'],
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.menuItemId === 'ac-yt-link' ? info.linkUrl : info.pageUrl || (tab && tab.url);
  try { await ytQueueAdd([url]); flashBadge(tab && tab.id, '+1'); } catch (_) { flashBadge(tab && tab.id, '!'); }
});

// ================================================================ command routing
async function tabExists(id) {
  try { await chrome.tabs.get(id); return true; } catch (_) { return false; }
}

async function pickTab(explicit) {
  if (explicit != null) {
    if (!(await tabExists(explicit))) throw new Error(`No tab with id ${explicit}.`);
    return explicit;
  }
  await statusReady;
  const known = [...tabStatus.entries()].sort((a, b) => b[1].at - a[1].at);
  const casting = known.filter(([, s]) => s.castState === 'CONNECTED' || s.sitePlayer);
  for (const [id] of casting.concat(known)) if (await tabExists(id)) return id;
  const [archive] = await chrome.tabs.query({ url: 'https://archive.org/*' });
  if (archive) return archive.id;
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active && isHttp(active.url)) return active.id;
  throw new Error('No tab to control. Use "open" with a show URL first (e.g. https://archive.org/details/get-smart).');
}

async function tabApi(tabId, cmd, args) {
  const res = await chrome.tabs.sendMessage(tabId, { type: 'api', cmd, args: args || {} });
  if (!res) throw new Error('The tab did not answer.');
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

async function listTabs() {
  await statusReady;
  const out = [];
  for (const [id, s] of tabStatus) {
    let t = null;
    try { t = await chrome.tabs.get(id); } catch (_) { continue; }
    out.push({
      tabId: id, title: t.title, url: t.url, active: t.active, castState: s.castState || null,
      device: s.device || null, nowPlaying: s.nowPlaying || null, episodeCount: s.episodeCount || 0,
    });
  }
  return out;
}

function waitForTabLoad(tabId, ms) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpd); resolve(); };
    const onUpd = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const timer = setTimeout(done, ms);
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete') done(); }, done);
  });
}

async function openUrl({ url, active }) {
  if (!isHttp(url)) throw new Error('url must be an http(s) URL.');
  const tab = await chrome.tabs.create({ url, active: active !== false });
  await waitForTabLoad(tab.id, 30000);
  await ensureInjected(tab.id);
  await tabApi(tab.id, 'openPanel');
  let state = null;
  for (let i = 0; i < 60; i++) {
    state = await tabApi(tab.id, 'state').catch(() => null);
    if (state && !['idle', 'loading', 'collection'].includes(state.page.status)) break;
    await sleep(500);
  }
  const episodes = await tabApi(tab.id, 'episodes', { limit: 25 }).catch(() => null);
  return { tabId: tab.id, state, episodes };
}

async function routeApi(cmd, args) {
  args = args || {};
  const def = CMDS.byName[cmd];
  if (!def) throw new Error(`Unknown command “${cmd}”. Call "help" for the list.`);
  switch (cmd) {
    case 'help':
      return CMDS.COMMANDS.map((c) => ({ name: c.name, scope: c.scope, description: c.description, args: Object.keys(c.args), required: c.required || [] }));
    case 'tabs': return listTabs();
    case 'open': return openUrl(args);
    case 'youtubeQueue': return { queue: await ytQueue(), playback: ytPublic(await ytGet()) };
    case 'youtubeAdd': return ytQueueAdd(args.videos, args.next);
    case 'youtubeRemove': return ytQueueRemove(args.index);
    case 'youtubeMove': return ytQueueMove(args.from, args.to);
    case 'youtubeClear': return { queue: await ytSetQueue([]) };
    case 'youtubePlay': return ytPlay({ videos: args.videos, index: args.index || 0, startTime: args.startTime || 0, target: args.target });
    case 'youtubeControl': return ytControl(args);
    case 'reloadExtension':
      if (chrome.runtime.getManifest().update_url) throw new Error('Only unpacked (developer) installs can be reloaded this way.');
      setTimeout(() => chrome.runtime.reload(), 100);
      return { reloading: true };
  }
  const tabId = await pickTab(args.tabId);
  await ensureInjected(tabId);
  const rest = Object.assign({}, args);
  delete rest.tabId;
  const result = await tabApi(tabId, cmd, rest);
  return result && typeof result === 'object' && !Array.isArray(result) ? Object.assign({ tabId }, result) : result;
}

// ================================================================ outside control (opt-in)
async function bridgeConfig() {
  const { 'ac:bridge': b } = await chrome.storage.local.get('ac:bridge');
  return Object.assign({}, BRIDGE_DEFAULTS, b);
}

// Other extensions: chrome.runtime.sendMessage(ARCHIVE_CAST_ID, {cmd: 'play', args: {index: 0}})
chrome.runtime.onMessageExternal.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (!(await bridgeConfig()).allowExtensions) throw new Error('Archive Cast: control by other extensions is turned off (enable it in the extension’s options).');
    if (!msg || typeof msg.cmd !== 'string') throw new Error('Send {cmd, args}. Try {cmd: "help"}.');
    return routeApi(msg.cmd, msg.args);
  })().then((result) => sendResponse({ ok: true, result }), (e) => sendResponse({ ok: false, error: e.message || String(e) }));
  return true;
});

// Local MCP server (mcp/server.mjs) listens on ws://127.0.0.1:<port>; we dial out to it.
let ws = null;
let wsTimer = null;
let wsBackoff = 2000;
let pingTimer = null;

function setBridgeStatus(state, detail) {
  chrome.storage.session.set({ 'ac:bridgeStatus': { state, detail: detail || null, at: Date.now() } }).catch(() => {});
}

function closeBridge() {
  clearTimeout(wsTimer);
  clearInterval(pingTimer);
  if (ws) { const s = ws; ws = null; try { s.close(); } catch (_) { /* already closed */ } }
}

async function connectBridge() {
  const cfg = await bridgeConfig();
  if (!cfg.enabled) { closeBridge(); setBridgeStatus('off'); chrome.alarms.clear('ac-bridge'); return; }
  chrome.alarms.create('ac-bridge', { periodInMinutes: 1 });
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  let sock;
  try { sock = new WebSocket(`ws://127.0.0.1:${cfg.port}/archive-cast`); } catch (e) { scheduleBridge(); return; }
  ws = sock;
  setBridgeStatus('connecting');
  sock.onopen = () => {
    wsBackoff = 2000;
    setBridgeStatus('connected', `ws://127.0.0.1:${cfg.port}`);
    sock.send(JSON.stringify({ type: 'hello', role: 'extension', version: VERSION, extensionId: chrome.runtime.id }));
    clearInterval(pingTimer);
    pingTimer = setInterval(() => { if (sock.readyState === WebSocket.OPEN) sock.send('{"type":"ping"}'); }, 20000);
  };
  sock.onmessage = async (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch (_) { return; }
    if (!m || m.type !== 'call') return;
    let reply;
    try { reply = { type: 'result', id: m.id, ok: true, result: await routeApi(m.cmd, m.args) }; } catch (err) {
      reply = { type: 'result', id: m.id, ok: false, error: err.message || String(err) };
    }
    if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(reply));
  };
  sock.onclose = () => {
    clearInterval(pingTimer);
    if (ws === sock) { ws = null; setBridgeStatus('waiting', `ws://127.0.0.1:${cfg.port}`); scheduleBridge(); }
  };
  sock.onerror = () => { /* onclose follows */ };
}

function scheduleBridge() {
  clearTimeout(wsTimer);
  wsTimer = setTimeout(connectBridge, wsBackoff);
  wsBackoff = Math.min(60000, wsBackoff * 2);
}

chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'ac-bridge') connectBridge(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes['ac:bridge']) { wsBackoff = 2000; closeBridge(); connectBridge(); }
  if (changes['ac:sites']) syncSiteScripts();
});

chrome.runtime.onInstalled.addListener(() => { syncSiteScripts(); setupMenus(); });
chrome.runtime.onStartup.addListener(() => { connectBridge(); });
connectBridge();
