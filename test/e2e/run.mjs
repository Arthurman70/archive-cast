// End-to-end tests: loads the real extension into a throwaway Chrome profile (Puppeteer) and drives
// it against a local test site that uses a fake Cast SDK (site/fakecast.js), plus live archive.org.
//
//   cd test/e2e && npm install && npm test
//   CHROME=/path/to/chrome npm test     (defaults to the usual Google Chrome install locations)
//   HEADFUL=1 npm test                  (watch it run)
//   SCREENSHOT=../../docs/panel.png npm test
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-cast-e2e-'));
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: !process.env.HEADFUL,
  pipe: true,
  enableExtensions: [EXT],
  userDataDir: profile,
  defaultViewport: { width: 1280, height: 860 },
  args: ['--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required'],
});
const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'));
const sw = await swTarget.worker();

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

// ---------------------------------------------------------------- done
await browser.close();
server.close();
fs.rmSync(profile, { recursive: true, force: true });
const failed = results.filter((r) => r[0] === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
