// node --test test/  — the MCP server end to end with a fake extension on the WebSocket side.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../mcp/server.mjs', import.meta.url));
const PORT = 47000 + Math.floor(Math.random() * 900);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startMcp() {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, ARCHIVE_CAST_PORT: String(PORT) }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const waiting = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
  let id = 0;
  const rpc = (method, params) => new Promise((resolve) => {
    const n = ++id;
    waiting.set(n, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  });
  return { child, rpc };
}

// Stands in for the Chrome extension: dials the hub and answers calls.
async function fakeExtension(handler, origin = 'chrome-extension://fakeid') {
  for (let i = 0; i < 40; i++) {
    try {
      const ws = await new Promise((resolve, reject) => {
        const s = new WebSocket(`ws://127.0.0.1:${PORT}/archive-cast`, { headers: { origin } });
        s.onopen = () => resolve(s);
        s.onerror = () => reject(new Error('no hub yet'));
      });
      ws.send(JSON.stringify({ type: 'hello', role: 'extension', version: 'test', extensionId: 'fakeid' }));
      ws.onmessage = async (e) => {
        const m = JSON.parse(e.data);
        if (m.type !== 'call') return;
        try { ws.send(JSON.stringify({ type: 'result', id: m.id, ok: true, result: await handler(m.cmd, m.args) })); } catch (err) {
          ws.send(JSON.stringify({ type: 'result', id: m.id, ok: false, error: err.message }));
        }
      };
      return ws;
    } catch (_) { await sleep(100); }
  }
  throw new Error('hub never came up');
}

test('MCP: initialize, list tools, call through the bridge, report errors', async (t) => {
  const { child, rpc } = startMcp();
  t.after(() => child.kill());

  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'archive-cast');
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.tools);

  const list = await rpc('tools/list', {});
  const names = list.result.tools.map((x) => x.name);
  for (const n of ['play_episode', 'list_episodes', 'open_page', 'cast_media', 'set_auto_advance', 'get_state']) assert.ok(names.includes(n), n);
  const play = list.result.tools.find((x) => x.name === 'play_episode');
  assert.equal(play.inputSchema.properties.index.type, 'integer');

  const calls = [];
  const ext = await fakeExtension(async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'play') return { nowPlaying: { index: args.index, title: 'Ep ' + args.index } };
    throw new Error('Not connected to a Chromecast.');
  });
  t.after(() => ext.close());
  await sleep(100);

  const ok = await rpc('tools/call', { name: 'play_episode', arguments: { index: 3 } });
  assert.equal(ok.result.isError, undefined);
  assert.equal(JSON.parse(ok.result.content[0].text).nowPlaying.index, 3);
  assert.deepEqual(calls[0], ['play', { index: 3 }]);

  const bad = await rpc('tools/call', { name: 'pause', arguments: {} });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /Not connected/);

  const unknown = await rpc('tools/call', { name: 'nope', arguments: {} });
  assert.equal(unknown.error.code, -32602);
});

test('MCP: web pages cannot connect to the bridge', async (t) => {
  const { child, rpc } = startMcp();
  t.after(() => child.kill());
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  await sleep(300);
  const refused = await new Promise((resolve) => {
    const s = new WebSocket(`ws://127.0.0.1:${PORT}/archive-cast`, { headers: { origin: 'https://evil.example' } });
    s.onopen = () => { s.close(); resolve(false); };
    s.onerror = () => resolve(true);
  });
  assert.ok(refused);
});

test('MCP: a second server process relays through the first', async (t) => {
  const a = startMcp();
  t.after(() => a.child.kill());
  await a.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const ext = await fakeExtension(async (cmd) => ({ answeredBy: 'extension', cmd }));
  t.after(() => ext.close());

  const b = startMcp();
  t.after(() => b.child.kill());
  await b.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  await sleep(400);
  const res = await b.rpc('tools/call', { name: 'get_state', arguments: {} });
  assert.equal(JSON.parse(res.result.content[0].text).answeredBy, 'extension');
});
