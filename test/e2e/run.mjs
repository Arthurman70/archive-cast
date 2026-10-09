// End-to-end tests: loads the real extension into a throwaway browser profile (Puppeteer) and drives
// it against a local test site that uses a fake Cast SDK (site/fakecast.js), a fake youtube.com
// served over local HTTPS (site/fakeyt.js), plus live archive.org.
//
//   cd test/e2e && npm install && npm test
//   CHROME=/path/to/chrome npm test     (defaults to the usual Google Chrome install locations)
//   CHROME=/path/to/brave npm test      (Brave works too; Brave-only checks switch on automatically)
//   HEADFUL=1 npm test                  (watch it run)
//   LIVE_YOUTUBE=1 npm test             (also smoke-test the real youtube.com)
//   SCREENSHOT=../../docs/panel.png npm test
// The fake YouTube needs openssl on PATH once, to make a throwaway certificate.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '../..');
const SITE = path.join(HERE, 'site');
const puppeteer = (await import(process.env.PUPPETEER_PATH ? pathToFileURL(process.env.PUPPETEER_PATH).href : 'puppeteer-core')).default;
const CHROME = process.env.CHROME || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IS_BRAVE_RUN = /brave/i.test(CHROME || '');

// ---------------------------------------------------------------- local test site
const MEDIA_TYPES = { mp4: 'video/mp4', mp3: 'audio/mpeg', m3u8: 'application/vnd.apple.mpegurl', ts: 'video/mp2t' };
function episodePage(n) {
  const next = n < 3 ? `<a class="next" href="ep${n + 1}.html?speed=1">Next episode ›</a>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Episode ${n} — Test Show</title>
<meta property="og:title" content="Episode ${n}"><script src="/fakecast.js"></script><script src="/siteplayer.js"></script>
<style>body{font:16px system-ui;padding:32px;background:#f4f1ea}</style></head><body>
<h1>Test Show</h1><video src="/media/show-${n}.mp4" data-duration="3" width="320" height="180"></video>
<p><button class="vjs-big-play-button">Play</button> ${next}</p></body></html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  let m;
  if ((m = /^\/show\/ep(\d)\.html$/.exec(p))) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(episodePage(+m[1])); }
  if (p === '/strict.html') {
    // a site with no Cast SDK of its own and a CSP that only allows its own scripts
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "script-src 'self'; object-src 'none'" });
    return res.end('<!doctype html><title>Strict Site</title><h1>Strict Site</h1><a href="/media/strict-1.mp4">Episode 1</a> <a href="/media/strict-2.mp4">Episode 2</a>');
  }
  if (p.startsWith('/media/')) {
    const ext = p.split('.').pop();
    const type = MEDIA_TYPES[ext] || 'application/octet-stream';
    const body = ext === 'm3u8' ? '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv720/index.m3u8\n' : Buffer.alloc(ext === 'ts' ? 900000 : 500000);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
    return res.end(body);
  }
  const file = path.join(SITE, p === '/' ? 'index.html' : p);
  if (!file.startsWith(SITE) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  const type = { html: 'text/html', js: 'text/javascript', xml: 'application/rss+xml' }[file.split('.').pop()] || 'text/plain';
  res.writeHead(200, { 'Content-Type': type });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

// ---------------------------------------------------------------- browser
const profiles = [];
async function launch(extraArgs = [], extra = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-cast-e2e-'));
  profiles.push(profile);
  const b = await puppeteer.launch(Object.assign({
    executablePath: CHROME,
    headless: !process.env.HEADFUL,
    pipe: true,
    enableExtensions: [EXT],
    userDataDir: profile,
    defaultViewport: { width: 1280, height: 860 },
    args: ['--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', ...extraArgs],
  }, extra));
  const t = await b.waitForTarget((x) => x.type() === 'service_worker' && x.url().endsWith('/background.js'));
  return { browser: b, sw: await t.worker() };
}
console.log(`browser: ${CHROME}${IS_BRAVE_RUN ? ' (Brave)' : ''}`);
let { browser, sw } = await launch();

const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push(['ok', name]); console.log(`✔ ${name} (${Date.now() - t0}ms)`); } catch (e) {
    results.push(['fail', name, e]);
    console.log(`✖ ${name}\n    ${String(e && e.stack || e).split('\n').slice(0, 4).join('\n    ')}`);
  }
}

async function waitFor(fn, ms = 10000, label = 'condition') {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}` + (last instanceof Error ? `: ${last.message}` : ''));
}

const api = (page, expr) => page.evaluate(expr);
const state = (page) => api(page, () => window.ArchiveCast.getState());
// a real (trusted) click inside the panel's shadow DOM, like a person or a clicking agent
async function clickPanel(page, action) {
  const el = await page.waitForSelector(`archive-cast-ui >>> [data-ac-action="${action}"]`, { visible: true, timeout: 8000 });
  await el.click();
}

// Register the test site like a toolbar click would, so pages get the panel automatically.
await sw.evaluate(async (origin) => { await addSite(origin); await syncSiteScripts(); }, ORIGIN);

// ================================================================ tests
await step('podcast page: feed and page links become sources; feed plays oldest first', async () => {
  const page = await browser.newPage();
  await page.goto(ORIGIN + '/index.html');
  await page.waitForFunction(() => window.ArchiveCast);
  await api(page, () => ArchiveCast.openPanel());
  const st = await waitFor(async () => { const s = await state(page); return s.sources.some((x) => x.id === 'feed') && s; }, 8000, 'feed source');
  const byId = Object.fromEntries(st.sources.map((s) => [s.id, s.count]));
  assert.equal(byId.feed, 4, 'feed items with audio');
  assert.equal(byId.page, 3, 'links on the page');
  assert.equal(st.source, 'feed', 'the bigger list is shown first');
  const eps = await api(page, () => ArchiveCast.listEpisodes());
  assert.deepEqual(eps.items.map((e) => e.title), ['Episode 1: Beginnings', 'Episode 2: Complications', 'Episode 3: Rising Action', 'Episode 4: Finale']);
  assert.equal(eps.items[0].duration, 40);
  await api(page, () => ArchiveCast.setSource('page'));
  const pageEps = await api(page, () => ArchiveCast.listEpisodes());
  assert.deepEqual(pageEps.items.map((e) => e.title), ['Pilot', 'The Second One', 'Third Time Lucky'], 'generic "Download" link text replaced by card headings');
  await api(page, () => ArchiveCast.setSource('feed'));
  await page.close();
});

let castPage;
await step('scripts cannot open the Chromecast picker; a real click on Connect can', async () => {
  castPage = await browser.newPage();
  await castPage.goto(ORIGIN + '/index.html');
  await castPage.waitForFunction(() => window.ArchiveCast && window.ArchiveCast.state && window.ArchiveCast.state.sources.length > 1);
  await api(castPage, () => ArchiveCast.openPanel());
  await api(castPage, () => ArchiveCast.setSource('feed'));
  const err = await api(castPage, () => ArchiveCast.play(0).then(() => null, (e) => e.message));
  assert.match(err, /Not connected/);
  await waitFor(() => api(castPage, () => ArchiveCast.state.cast.sdk === 'ready'), 5000, 'sdk ready');
  await clickPanel(castPage, 'connect');
  await waitFor(async () => (await state(castPage)).cast.state === 'CONNECTED', 5000, 'connected');
  const st = await state(castPage);
  assert.equal(st.cast.device, 'Living Room TV');
  assert.equal(st.cast.mode, 'shared', 'site already had a Cast SDK, so we share it');
});

await step('play queues the rest in order; skip, jump, seek, volume, pause/resume', async () => {
  let st = await api(castPage, () => ArchiveCast.play(1));
  assert.equal(st.nowPlaying.index, 1);
  assert.equal(st.nowPlaying.title, 'Episode 2: Complications');
  const log = await api(castPage, () => window.__fake.log);
  assert.deepEqual(log.find((l) => l[0] === 'queueLoad'), ['queueLoad', 'CC1AD845', 3], 'our own Default Media Receiver session, episodes 2-4');
  await waitFor(() => api(castPage, () => window.__fake.log.some((l) => l[0] === 'insert' && l[2] === true)), 4000, 'earlier episodes inserted before');
  st = await api(castPage, () => ArchiveCast.next());
  assert.equal(st.nowPlaying.index, 2);
  st = await api(castPage, () => ArchiveCast.previous());
  assert.equal(st.nowPlaying.index, 1);
  st = await api(castPage, () => ArchiveCast.play(3));
  assert.equal(st.nowPlaying.index, 3);
  assert.ok((await api(castPage, () => window.__fake.log)).some((l) => l[0] === 'jump'), 'jumped inside the queue instead of reloading it');
  await api(castPage, () => ArchiveCast.pause());
  st = await state(castPage);
  assert.equal(st.nowPlaying.state, 'PAUSED');
  st = await api(castPage, () => ArchiveCast.seek(30));
  assert.ok(Math.abs(st.nowPlaying.time - 30) <= 1, 'seeked to 30s');
  st = await api(castPage, () => ArchiveCast.resume());
  assert.equal(st.nowPlaying.state, 'PLAYING');
  st = await api(castPage, () => ArchiveCast.setVolume(0.3));
  assert.equal(st.cast.volume, 0.3);
});

await step('autoplay: the queue advances by itself and the panel follows', async () => {
  await api(castPage, () => ArchiveCast.play(0));
  // 40s episodes at 30x speed ≈ 1.3s each
  await waitFor(async () => { const s = await state(castPage); return s.nowPlaying && s.nowPlaying.index >= 2; }, 8000, 'auto-advance to episode 3');
  const dom = await castPage.$eval('archive-cast-ui', (h) => ({ state: h.dataset.acState, index: h.dataset.acEpisodeIndex }));
  assert.ok(['playing', 'buffering', 'finished'].includes(dom.state), 'state mirrored on the host element: ' + dom.state);
  // an episode counts as watched once it is seen past 90% (sampled once a second)
  await api(castPage, () => ArchiveCast.play(0, 38));
  await api(castPage, () => ArchiveCast.pause());
  await sleep(1200);
  const watched = await api(castPage, () => ArchiveCast.listEpisodes().then((r) => r.items.filter((e) => e.watched).map((e) => e.index)));
  assert.ok(watched.includes(0), 'episode seen past 90% is marked watched');
});

if (process.env.SCREENSHOT) {
  await step('screenshot for the README', async () => {
    await api(castPage, () => ArchiveCast.play(1, 14));
    await api(castPage, () => ArchiveCast.pause());
    await sleep(400);
    const box = await castPage.$eval('archive-cast-ui', (h) => { const r = h.shadowRoot.querySelector('.panel').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
    await castPage.screenshot({ path: path.resolve(process.env.SCREENSHOT), clip: { x: box.x - 24, y: box.y - 24, width: box.width + 48, height: box.height + 48 } });
  });
}

await step('stop casting ends the session', async () => {
  const st = await api(castPage, () => ArchiveCast.stop());
  assert.notEqual(st.cast.state, 'CONNECTED');
  await castPage.close();
});

await step('follow "next episode" links to queue the following pages', async () => {
  const page = await browser.newPage();
  await page.goto(ORIGIN + '/show/ep1.html');
  await page.waitForFunction(() => window.ArchiveCast && window.ArchiveCast.state);
  const st0 = await state(page);
  assert.ok(st0.nextPageUrl.endsWith('/show/ep2.html?speed=1'));
  const res = await api(page, () => ArchiveCast.findMoreEpisodes());
  assert.equal(res.added, 2);
  const eps = await api(page, () => ArchiveCast.listEpisodes());
  assert.equal(eps.source, 'follow');
  assert.deepEqual(eps.items.map((e) => e.title), ['Episode 1', 'Episode 2', 'Episode 3']);
  await page.close();
});

await step('network sniffer: a script-built HLS player is detected (variants and segments ignored)', async () => {
  const page = await browser.newPage();
  await page.goto(ORIGIN + '/player.html');
  await page.waitForFunction(() => window.ArchiveCast && window.ArchiveCast.state);
  const st = await waitFor(async () => { const s = await api(page, () => ArchiveCast.rescan()); return s.sources.find((x) => x.id === 'streams') && s; }, 8000, 'streams source');
  assert.equal(st.sources.find((x) => x.id === 'streams').count, 1);
  const eps = await api(page, () => ArchiveCast.listEpisodes());
  assert.match(eps.items[0].url, /master\.m3u8$/);
  assert.equal(eps.items[0].format, 'HLS stream');
  const badge = await sw.evaluate(async (u) => { const [t] = await chrome.tabs.query({ url: u }); return chrome.action.getBadgeText({ tabId: t.id }); }, ORIGIN + '/player.html');
  assert.equal(badge, '1');
  await page.close();
});

await step('site session reuse: a site that is already casting gets our queue with no click', async () => {
  const page = await browser.newPage();
  await page.goto(ORIGIN + '/show/ep1.html');
  await page.waitForFunction(() => window.ArchiveCast && window.ArchiveCast.state);
  await api(page, () => { window.__fake.connectSite(); });
  await api(page, () => ArchiveCast.findMoreEpisodes());
  const st = await api(page, () => ArchiveCast.play(0));
  assert.equal(st.nowPlaying.title, 'Episode 1');
  assert.deepEqual((await api(page, () => window.__fake.log)).find((l) => l[0] === 'queueLoad'), ['queueLoad', 'SITEAPP', 3]);
  await api(page, () => ArchiveCast.stop());
  await api(page, () => { sessionStorage.clear(); });
  await page.close();
});

await step('site receiver refuses our media → falls back to our own receiver', async () => {
  const page = await browser.newPage();
  await page.goto(ORIGIN + '/show/ep1.html');
  await page.waitForFunction(() => window.ArchiveCast && window.ArchiveCast.state);
  await api(page, () => { window.__fake.connectSite(); window.__fake.rejectSiteLoads = true; });
  const st = await api(page, () => ArchiveCast.play(0));
  assert.equal(st.nowPlaying.index, 0);
  const loads = (await api(page, () => window.__fake.log)).filter((l) => l[0] === 'queueLoad').map((l) => l[1]);
  assert.deepEqual(loads, ['SITEAPP', 'CC1AD845']);
  await api(page, () => { sessionStorage.clear(); });
  await page.close();
});

await step('auto-advance: the site’s own player continues to the next episode pages', async () => {
  const page = await browser.newPage();
  await page.goto(ORIGIN + '/show/ep1.html?speed=1');
  await page.waitForFunction(() => window.ArchiveCast && window.ArchiveCast.state);
  await api(page, () => { window.__fake.connectSite(); });
  await api(page, () => ArchiveCast.setAutoAdvance(true));
  await page.click('.vjs-big-play-button'); // the user starts episode 1 with the site's own player
  await waitFor(() => page.url().includes('/show/ep2.html'), 15000, 'navigation to episode 2');
  await waitFor(() => api(page, () => (window.__fake.log || []).some((l) => l[0] === 'siteLoad' && /show-2\.mp4$/.test(l[1]))), 15000, 'site player started episode 2');
  await waitFor(() => page.url().includes('/show/ep3.html'), 15000, 'navigation to episode 3');
  await waitFor(() => api(page, () => (window.__fake.log || []).some((l) => l[0] === 'siteLoad' && /show-3\.mp4$/.test(l[1]))), 15000, 'site player started episode 3');
  await api(page, () => ArchiveCast.setAutoAdvance(false));
  await page.close();
});

await step('a site whose CSP blocks Google Cast: detected, then relaxed for that tab on request', async () => {
  const page = await browser.newPage();
  await page.goto(ORIGIN + '/strict.html');
  await page.waitForFunction(() => window.ArchiveCast && window.ArchiveCast.state);
  await api(page, () => ArchiveCast.openPanel());
  await waitFor(async () => (await state(page)).cast.sdk === 'blocked', 20000, 'CSP block detected');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), clickPanel(page, 'message-action')]);
  await page.waitForFunction(() => window.ArchiveCast && window.ArchiveCast.state && window.ArchiveCast.state.panelOpen, { timeout: 15000 });
  const sdk = await waitFor(async () => { const c = (await state(page)).cast; return c.sdk === 'ready' && c; }, 25000, 'Cast SDK ready after relaxing');
  const csp = await page.evaluate(() => fetch(location.href).then((r) => r.headers.get('content-security-policy')));
  console.log(`    after relaxing: sdk ${sdk.sdk}, mode ${sdk.mode}, state ${sdk.state}; page CSP header seen by the page's own fetch: ${csp ? 'present' : 'absent'}`);
  const rules = await sw.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
  assert.equal(rules.length, 1, 'one tab-scoped rule');
  assert.equal(rules[0].condition.tabIds.length, 1);
  await page.close();
  await waitFor(async () => (await sw.evaluate(() => chrome.declarativeNetRequest.getSessionRules())).length === 0, 5000, 'rule removed when the tab closes');
});

await step('archive.org (live): episodes from metadata, Cast SDK through the page nonce', async () => {
  const page = await browser.newPage();
  await page.goto('https://archive.org/details/get-smart', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(() => window.ArchiveCast && window.ArchiveCast.state && window.ArchiveCast.state.page.status === 'ready', { timeout: 30000 });
  const eps = await api(page, () => ArchiveCast.listEpisodes({ limit: 2 }));
  assert.equal(eps.total, 138);
  assert.match(eps.items[0].title, /S01E01/);
  await api(page, () => ArchiveCast.openPanel());
  const sdk = await waitFor(async () => { const s = (await state(page)).cast; return s.sdk !== 'loading' && s.sdk !== 'idle' && s; }, 25000, 'Cast SDK result');
  console.log(`    archive.org Cast SDK: ${sdk.sdk}${sdk.error ? ' (' + sdk.error + ')' : ''}, mode ${sdk.mode}, state ${sdk.state}`);
  assert.notEqual(sdk.sdk, 'blocked', 'CSP must not block the SDK');
  if (IS_BRAVE_RUN && (sdk.sdk === 'unavailable' || sdk.state === 'NO_DEVICES_AVAILABLE')) {
    // a fresh Brave profile has Google Cast ("Media Router") switched off: the panel must say so
    const msg = await waitFor(() => page.$eval('archive-cast-ui', (h) => { const m = h.shadowRoot.querySelector('.msg'); return !m.hidden && m.textContent; }), 5000, 'Brave hint');
    assert.match(msg, /Media Router/);
    assert.equal((await state(page)).browser, 'brave');
    console.log('    Brave hint shown: ' + msg.replace(/\s+/g, ' ').slice(0, 110) + '…');
  }
  if (process.env.SCREENSHOT) {
    await page.goto('https://archive.org/details/GreenAcresCompleteSeries', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => window.ArchiveCast && window.ArchiveCast.state && window.ArchiveCast.state.page.status === 'ready', { timeout: 30000 });
    await api(page, () => ArchiveCast.openPanel());
    await sleep(2500);
    const box = await page.$eval('archive-cast-ui', (h) => { const r = h.shadowRoot.querySelector('.panel').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
    await page.screenshot({ path: path.resolve(path.dirname(process.env.SCREENSHOT), 'archive.png'), clip: { x: box.x - 360, y: box.y - 24, width: box.width + 384, height: box.height + 48 } });
  }
  await page.close();
});

await step('MCP: an AI client opens a show and reads its episodes through the bridge', async () => {
  const port = 47700 + Math.floor(Math.random() * 200);
  const mcp = spawn(process.execPath, [path.join(EXT, 'mcp/server.mjs')], { env: { ...process.env, ARCHIVE_CAST_PORT: String(port) } });
  try {
    let buf = '';
    const waiting = new Map();
    mcp.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(msg.id)?.(msg); }
    });
    let n = 0;
    const rpc = (method, params) => new Promise((resolve) => { const id = ++n; waiting.set(id, resolve); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    await sw.evaluate((p) => chrome.storage.local.set({ 'ac:bridge': { enabled: true, port: p, allowExtensions: false } }), port);
    await waitFor(() => sw.evaluate(async () => (await chrome.storage.session.get('ac:bridgeStatus'))['ac:bridgeStatus']?.state === 'connected'), 15000, 'extension connected to MCP');
    const call = async (name, args) => {
      const r = await rpc('tools/call', { name, arguments: args || {} });
      if (r.result.isError) throw new Error(r.result.content[0].text);
      return JSON.parse(r.result.content[0].text);
    };
    const opened = await call('open_page', { url: ORIGIN + '/index.html' });
    assert.ok(opened.tabId);
    assert.ok(opened.episodes.total >= 3);
    const st = await call('get_state', { tabId: opened.tabId });
    assert.equal(st.site, '127.0.0.1');
    const tabs = await call('list_tabs');
    assert.ok(tabs.some((t) => t.tabId === opened.tabId));
    const err = await rpc('tools/call', { name: 'play_episode', arguments: { tabId: opened.tabId, index: 0 } });
    assert.equal(err.result.isError, true);
    assert.match(err.result.content[0].text, /Not connected/, 'clear guidance when nobody has picked a Chromecast');
  } finally {
    mcp.kill();
  }
});

await browser.close();

// ================================================================ YouTube (fake youtube.com over local HTTPS)
const YT_VIDEOS = {
  TestVideo01: ['Test Video 1', 'Channel A'], TestVideo02: ['Test Video 2', 'Channel B'], TestVideo03: ['Test Video 3', 'Channel C'],
  TestVideo04: ['Test Video 4', 'Channel D'], TestVideo05: ['Suggested Video', 'Channel E'],
};
const related = (ids) => ids.map((id) => `<ytd-compact-video-renderer><a id="thumbnail" href="/watch?v=${id}"></a>
  <a id="video-title" href="/watch?v=${id}" title="${YT_VIDEOS[id][0]}">${YT_VIDEOS[id][0]}</a><ytd-channel-name><a href="/@x">${YT_VIDEOS[id][1]}</a></ytd-channel-name>
  <ytd-thumbnail-overlay-time-status-renderer><span id="text">0:03</span></ytd-thumbnail-overlay-time-status-renderer></ytd-compact-video-renderer>`).join('');
function ytPage(url) {
  const v = url.searchParams.get('v');
  const shell = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title} - YouTube</title></head>
<body style="margin:0;font:14px system-ui;background:#0f0f0f;color:#f1f1f1"><div id="masthead-container" style="height:56px">FakeTube</div>${body}</body></html>`;
  if (url.pathname === '/watch' && YT_VIDEOS[v]) {
    return shell(YT_VIDEOS[v][0], `<meta name="title" content="${YT_VIDEOS[v][0]}"><meta itemprop="duration" content="PT0M3S">
<div id="primary"><div id="movie_player" style="width:640px;height:360px;background:#222"><div class="html5-video-container"><video></video></div>
<div class="ytp-chrome-bottom"><button class="ytp-autonav-toggle-button" aria-checked="true">Autoplay</button></div></div>
<ytd-watch-metadata><h1 class="ytd-watch-metadata">${YT_VIDEOS[v][0]}</h1><div id="owner"><ytd-channel-name><a href="/@a">${YT_VIDEOS[v][1]}</a></ytd-channel-name></div></ytd-watch-metadata></div>
<div id="secondary">${related(['TestVideo02', 'TestVideo03', 'TestVideo04'].filter((id) => id !== v))}
<ytd-ad-slot-renderer><a id="video-title" href="/watch?v=AdVideo0001" title="Buy things">Buy things</a></ytd-ad-slot-renderer></div>
<script src="/fakeyt.js"></script>`);
  }
  if (url.pathname === '/playlist') {
    const rows = ['TestVideo03', 'TestVideo01', 'TestVideo04'].map((id, i) => `<ytd-playlist-video-renderer>
<a id="video-title" href="/watch?v=${id}&list=PLtest&index=${i + 1}" title="${YT_VIDEOS[id][0]}">${YT_VIDEOS[id][0]}</a></ytd-playlist-video-renderer>`).join('');
    return shell('Test Playlist', `<ytd-playlist-header-renderer><h1 class="title">Test Playlist</h1></ytd-playlist-header-renderer>${rows}${related(['TestVideo02'])}`);
  }
  if (url.pathname === '/results') {
    // the 2025+ "lockup" layout: no #video-title, titles in an h3
    return shell('test', ['TestVideo04', 'TestVideo02'].map((id) => `<yt-lockup-view-model><a href="/watch?v=${id}"><img alt=""></a>
<h3><a href="/watch?v=${id}">${YT_VIDEOS[id][0]}</a></h3></yt-lockup-view-model>`).join(''));
  }
  return null;
}

const certDir = path.join(HERE, 'certs');
if (!fs.existsSync(path.join(certDir, 'cert.pem'))) {
  fs.mkdirSync(certDir, { recursive: true });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'cert.pem'),
    '-days', '3650', '-subj', '/CN=www.youtube.com', '-addext', 'subjectAltName=DNS:www.youtube.com,DNS:youtube.com'], { stdio: 'ignore', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
}
const ytServer = https.createServer({ key: fs.readFileSync(path.join(certDir, 'key.pem')), cert: fs.readFileSync(path.join(certDir, 'cert.pem')) }, (req, res) => {
  const url = new URL(req.url, 'https://www.youtube.com');
  if (url.pathname === '/fakeyt.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return fs.createReadStream(path.join(SITE, 'fakeyt.js')).pipe(res); }
  if (url.pathname === '/oembed') {
    const id = new URL(url.searchParams.get('url')).searchParams.get('v');
    if (!YT_VIDEOS[id]) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ title: YT_VIDEOS[id][0], author_name: YT_VIDEOS[id][1] }));
  }
  const html = ytPage(url);
  if (!html) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
});
await new Promise((r) => ytServer.listen(0, '127.0.0.1', r));
const ytPort = ytServer.address().port;
({ browser, sw } = await launch([`--host-resolver-rules=MAP www.youtube.com:443 127.0.0.1:${ytPort}`, '--ignore-certificate-errors'], { acceptInsecureCerts: true }));

const pageWhere = (b, pred, ms = 10000) => waitFor(async () => (await b.pages()).find((p) => pred(p.url())), ms, 'page');
let ytTab, playerTab;

await step('YouTube: a watch page lists this video and the related ones (ads skipped)', async () => {
  ytTab = await browser.newPage();
  await ytTab.goto('https://www.youtube.com/watch?v=TestVideo01');
  await ytTab.waitForFunction(() => window.ArchiveCast && window.ArchiveCast.state && window.ArchiveCast.state.page.status === 'ready', { timeout: 15000 });
  await api(ytTab, () => ArchiveCast.openPanel());
  const eps = await api(ytTab, () => ArchiveCast.listEpisodes());
  assert.equal(eps.source, 'page');
  assert.deepEqual(eps.items.map((e) => e.title), ['Test Video 1', 'Test Video 2', 'Test Video 3', 'Test Video 4']);
  assert.equal(eps.items[1].duration, 3);
});

await step('YouTube: + queues a video; youtubeAdd takes links and looks up titles', async () => {
  const plus = await ytTab.waitForSelector('archive-cast-ui >>> .ep[data-i="1"] .rowbtn', { visible: true });
  await plus.click(); // a real click, like a person
  await waitFor(async () => (await state(ytTab)).youtube.queueLength === 1, 5000, 'queued by click');
  const r = await api(ytTab, () => ArchiveCast.call('youtubeAdd', { videos: ['https://youtu.be/TestVideo03', 'TestVideo04'] }));
  assert.deepEqual(r.queue.map((v) => v.title), ['Test Video 2', 'Test Video 3', 'Test Video 4']);
  await waitFor(() => ytTab.$eval('archive-cast-ui', (h) => h.shadowRoot.querySelector('.ep[data-i="2"] .rowbtn').classList.contains('in')), 4000, 'row shows ✓');
});

await step('YouTube: playing from a watch page uses that tab (no new tab), in order, with YouTube’s own autoplay kept out', async () => {
  const pagesBefore = (await browser.pages()).length;
  await api(ytTab, () => ArchiveCast.setSource('ytqueue'));
  const t0 = Date.now();
  const st = await api(ytTab, () => ArchiveCast.play(0));
  console.log(`    first video playing ${Date.now() - t0}ms after Play`);
  assert.equal(st.nowPlaying.title, 'Test Video 2');
  assert.equal(st.youtube.target, 'computer');
  assert.equal(st.youtube.isPlayerTab, true, 'the tab you clicked in became the player');
  assert.equal((await browser.pages()).length, pagesBefore, 'no extra tab');
  playerTab = ytTab;
  await waitFor(async () => (await state(ytTab)).nowPlaying?.index === 1, 12000, 'second video');
  await waitFor(async () => (await state(ytTab)).nowPlaying?.index === 2, 12000, 'third video');
  await waitFor(async () => (await state(ytTab)).nowPlaying?.idleReason === 'FINISHED', 12000, 'end of queue');
  await sleep(2500); // the fake would wander to a "suggested" video if autonav were still on
  assert.ok(!playerTab.url().includes('TestVideo05'), 'stayed put after the last video');
  assert.deepEqual(await api(playerTab, () => window.__fakeyt.loads), ['TestVideo02', 'TestVideo03', 'TestVideo04']);
});

let remote;
await step('YouTube: a panel on another page follows the queue that is playing (position, up next, buttons)', async () => {
  remote = await browser.newPage();
  await remote.goto('https://www.youtube.com/results?search_query=test');
  await remote.waitForFunction(() => window.ArchiveCast && window.ArchiveCast.state && window.ArchiveCast.state.page.status === 'ready', { timeout: 15000 });
  await api(remote, () => ArchiveCast.openPanel());
  await api(remote, () => ArchiveCast.setSource('page')); // a different list from the one playing
  await api(remote, () => ArchiveCast.call('youtubePlay', { index: 1 }));
  await waitFor(async () => (await state(remote)).nowPlaying?.state === 'PLAYING', 8000, 'playing');
  const card = () => remote.$eval('archive-cast-ui', (h) => {
    const r = h.shadowRoot;
    return { sub: r.querySelector('.now-sub').textContent, next: r.querySelector('.now-next').textContent,
      prev: r.querySelector('.tbtn.prev').disabled, nextBtn: r.querySelector('.tbtn.next').disabled, highlighted: r.querySelectorAll('.ep.now').length };
  });
  const c = await card();
  assert.equal((await state(remote)).nowPlaying.index, 1, 'position in the playing queue');
  assert.match(c.sub, /2 of 3/);
  assert.equal(c.next, 'Up next: Test Video 4');
  assert.equal(c.prev, false);
  assert.equal(c.nextBtn, false);
  assert.equal(c.highlighted, 0, 'no row lights up in a list that is not the one playing');
  let st = await api(remote, () => ArchiveCast.pause());
  assert.equal(st.nowPlaying.state, 'PAUSED');
  st = await api(remote, () => ArchiveCast.seek(2));
  assert.ok(Math.abs(st.nowPlaying.time - 2) <= 1);
  st = await api(remote, () => ArchiveCast.previous());
  assert.equal(st.nowPlaying.index, 0);
  st = await api(remote, () => ArchiveCast.next());
  assert.equal(st.nowPlaying.index, 1);
  st = await api(remote, () => ArchiveCast.setVolume(0.3));
  assert.equal(st.cast.volume, 0.3);
});

await step('YouTube: a video you pick inside the player is not yanked back; the queue carries on after it', async () => {
  await api(remote, () => ArchiveCast.call('youtubePlay', { index: 0 }));
  await waitFor(async () => (await state(remote)).nowPlaying?.state === 'PLAYING', 8000, 'playing');
  // what YouTube does when you click a related video in the player tab
  await playerTab.evaluate(() => document.getElementById('movie_player').loadVideoById('TestVideo05'));
  await sleep(7000); // the old logic pulled you back to the queue after 6 s
  assert.equal(await playerTab.evaluate(() => document.getElementById('movie_player').getVideoData().video_id), 'TestVideo05', 'left alone');
  const sub = await remote.$eval('archive-cast-ui', (h) => h.shadowRoot.querySelector('.now-sub').textContent);
  assert.match(sub, /picked in the player/);
  assert.equal((await state(remote)).nowPlaying.title, 'Suggested Video');
  await playerTab.evaluate(() => document.getElementById('movie_player').seekTo(58.5, true)); // let it finish
  await waitFor(async () => { const s = await state(remote); return s.nowPlaying?.index === 1 && s.nowPlaying.title === 'Test Video 3' && s.nowPlaying; }, 10000, 'queue resumed with the next video');
});

await step('YouTube TV mode: the player moves to its own window and fills it, ready to cast as a tab', async () => {
  const before = await sw.evaluate(() => chrome.windows.getAll().then((w) => w.length));
  await api(remote, () => ArchiveCast.call('youtubeControl', { action: 'target', target: 'tv' }));
  await waitFor(() => playerTab.evaluate(() => document.documentElement.classList.contains('ac-tv')), 6000, 'TV mode on');
  assert.equal(await sw.evaluate(() => chrome.windows.getAll().then((w) => w.length)), before + 1, 'own window');
  const box = await playerTab.$eval('#movie_player', (el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height, vw: innerWidth, vh: innerHeight }; });
  assert.ok(box.w >= box.vw - 1 && box.h >= box.vh - 1, `player fills the window (${box.w}x${box.h} of ${box.vw}x${box.vh})`);
  assert.ok(await playerTab.$eval('archive-cast-ui', (h) => h.shadowRoot.querySelector('.launcher').hidden), 'no launcher on the TV picture');
  await api(remote, () => ArchiveCast.call('youtubeControl', { action: 'target', target: 'computer' }));
  await waitFor(() => playerTab.evaluate(() => !document.documentElement.classList.contains('ac-tv')), 6000, 'TV mode off');
});

await step('YouTube: stop closes the player tab', async () => {
  const st = await api(remote, () => ArchiveCast.stop());
  assert.notEqual(st.cast.state, 'CONNECTED');
  await waitFor(() => playerTab.isClosed(), 5000, 'player closed');
});

await step('YouTube: starting from a page without a player opens a player tab', async () => {
  const st = await api(remote, () => ArchiveCast.play(0)); // search results: nothing to play in place
  assert.equal(st.youtube.isPlayerTab, false);
  const player = await pageWhere(browser, (u) => u.includes('ac_player=1'));
  await waitFor(async () => (await state(remote)).nowPlaying?.state === 'PLAYING', 8000, 'playing');
  assert.equal(await player.evaluate(() => document.getElementById('movie_player').getVideoData().video_id), 'TestVideo04');
  await api(remote, () => ArchiveCast.stop());
  await remote.close();
});

await step('YouTube: right-click "Add to Archive Cast queue" (menu handler) and MCP-style queue commands', async () => {
  const r = await sw.evaluate(() => ytQueueAdd(['https://www.youtube.com/watch?v=TestVideo01'], true));
  assert.equal(r.queue[0].id, 'TestVideo01', 'next=true puts it first when nothing is playing');
  const q = await sw.evaluate(() => routeApi('youtubeQueue', {}));
  assert.equal(q.queue.length, 4);
  await sw.evaluate(() => routeApi('youtubeMove', { from: 0, to: 3 }));
  await sw.evaluate(() => routeApi('youtubeRemove', { index: 3 }));
  assert.deepEqual((await sw.evaluate(() => routeApi('youtubeQueue', {}))).queue.map((v) => v.id), ['TestVideo02', 'TestVideo03', 'TestVideo04']);
  const err = await sw.evaluate(() => routeApi('youtubeAdd', { videos: ['https://example.com/not-youtube'] }).then(() => null, (e) => e.message));
  assert.match(err, /Not a YouTube video/);
});

await step('YouTube: playlist and search-results pages', async () => {
  const pl = await browser.newPage();
  await pl.goto('https://www.youtube.com/playlist?list=PLtest');
  await pl.waitForFunction(() => window.ArchiveCast && window.ArchiveCast.state && window.ArchiveCast.state.page.status === 'ready', { timeout: 15000 });
  const eps = await api(pl, () => ArchiveCast.listEpisodes());
  assert.equal(eps.source, 'playlist', 'an open playlist is shown first');
  assert.deepEqual(eps.items.map((e) => e.title), ['Test Video 3', 'Test Video 1', 'Test Video 4']);
  await pl.goto('https://www.youtube.com/results?search_query=test');
  await pl.waitForFunction(() => window.ArchiveCast && window.ArchiveCast.state && window.ArchiveCast.state.page.status === 'ready', { timeout: 15000 });
  await api(pl, () => ArchiveCast.setSource('page'));
  const res = await api(pl, () => ArchiveCast.listEpisodes());
  assert.deepEqual(res.items.map((e) => e.title), ['Test Video 4', 'Test Video 2']);
  if (process.env.SCREENSHOT) {
    await api(pl, () => ArchiveCast.openPanel());
    await api(pl, () => ArchiveCast.setSource('ytqueue'));
    await sleep(500);
    const box = await pl.$eval('archive-cast-ui', (h) => { const r = h.shadowRoot.querySelector('.panel').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
    await pl.screenshot({ path: path.resolve(path.dirname(process.env.SCREENSHOT), 'youtube.png'), clip: { x: box.x - 24, y: box.y - 24, width: box.width + 48, height: box.height + 48 } });
  }
  await pl.close();
});

await browser.close();
ytServer.close();

// ================================================================ live youtube.com (optional)
if (process.env.LIVE_YOUTUBE) {
  ({ browser, sw } = await launch());
  await step('youtube.com (live): panel renders under YouTube’s Trusted Types; the player tab drives the real player', async () => {
    const page = await browser.newPage();
    await page.setUserAgent((await browser.userAgent()).replace('HeadlessChrome', 'Chrome'));
    await page.goto('https://www.youtube.com/watch?v=jNQXAC9IVRw', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => window.ArchiveCast && window.ArchiveCast.state && window.ArchiveCast.state.page.status === 'ready', { timeout: 30000 });
    await api(page, () => ArchiveCast.openPanel());
    const eps = await api(page, () => ArchiveCast.listEpisodes({ limit: 5 }));
    console.log(`    found ${eps.total} videos; first: ${eps.items[0] && eps.items[0].title}`);
    assert.equal(eps.items[0].url, 'https://www.youtube.com/watch?v=jNQXAC9IVRw');
    assert.ok(await page.$eval('archive-cast-ui', (h) => !!h.shadowRoot.querySelector('.panel:not([hidden]) .now-title')), 'panel rendered');
    await api(page, () => ArchiveCast.call('youtubeClear'));
    await api(page, () => ArchiveCast.call('youtubePlay', { videos: ['jNQXAC9IVRw'] }));
    const player = await pageWhere(browser, (u) => u.includes('ac_player=1'));
    const st = await waitFor(async () => { const s = (await state(page)).nowPlaying; return s && s.state !== 'BUFFERING' && s; }, 30000, 'real player state').catch((e) => ({ error: e.message }));
    console.log(`    player tab state: ${JSON.stringify(st)}`);
    const ready = await player.evaluate(() => { const p = document.getElementById('movie_player'); return !!(p && p.getPlayerState); });
    assert.ok(ready, 'YouTube’s player API is reachable from the player tab');
    await page.close();
  });
  await browser.close();
}

// ---------------------------------------------------------------- done
server.close();
for (const p of profiles) fs.rmSync(p, { recursive: true, force: true });
const failed = results.filter((r) => r[0] === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
