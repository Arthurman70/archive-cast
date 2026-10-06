// Archive Cast service worker.
// - Toolbar button: toggles the panel (injecting it on any site you open it on).
// - Watches network responses for castable media so JS-built players can be cast too.
// - Routes commands from other extensions and the local MCP bridge to the right tab.
importScripts('lib/generic.js', 'lib/commands.js');

const GEN = self.ArchiveCastGeneric;
const CMDS = self.ArchiveCastCommands;
const VERSION = chrome.runtime.getManifest().version;
const ARCHIVE = /^https:\/\/(www\.)?archive\.org\//i;
const ISO_FILES = ['lib/episodes.js', 'lib/generic.js', 'lib/commands.js', 'content.js'];
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
  }
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

chrome.runtime.onInstalled.addListener(() => { syncSiteScripts(); });
chrome.runtime.onStartup.addListener(() => { connectBridge(); });
connectBridge();
