#!/usr/bin/env node
// Archive Cast MCP server — lets AI apps (Claude Code/Desktop, Cursor, …) control the extension.
//
//   MCP (stdio)  ⇄  this process  ⇄  ws://127.0.0.1:47811  ⇄  Archive Cast extension (Chrome)
//
// The extension dials out to this server once "Connect to the local MCP server" is enabled in
// its options page. Zero dependencies; Node 22+.
//
// Several MCP clients can run at once: the first process owns the port, later ones relay
// through it. The same file is also a CLI for shell-only agents:
//   node mcp/server.mjs call play_episode '{"index":0}'
//   node mcp/server.mjs tools
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';

const require = createRequire(import.meta.url);
const { COMMANDS, byTool, schemaFor } = require('../lib/commands.js');

const PORT = +(process.env.ARCHIVE_CAST_PORT || 47811);
const HOST = '127.0.0.1';
const PATH = '/archive-cast';
const VERSION = '2.2.0';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const log = (...a) => process.stderr.write('[archive-cast] ' + a.join(' ') + '\n');

// ============================================================ minimal WebSocket (RFC 6455) server side
class Peer {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frag = [];
    this.onmessage = () => {};
    this.onclose = () => {};
    this.role = null;
    this.closed = false;
    socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }
  finish() { if (!this.closed) { this.closed = true; this.onclose(); } }
  parse() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      const need = off + (masked ? 4 : 0) + len;
      if (b.length < need) return;
      let payload = b.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const mask = b.subarray(off, off + 4);
        payload = Buffer.from(payload.map((x, i) => x ^ mask[i & 3]));
      }
      this.buf = b.subarray(need);
      if (op === 0x8) { this.close(); return; }
      if (op === 0x9) { this.frame(0xa, payload); continue; }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x0) {
        this.frag.push(payload);
        if (fin) {
          const text = Buffer.concat(this.frag).toString('utf8');
          this.frag = [];
          this.onmessage(text);
        }
      }
    }
  }
  frame(op, payload) {
    if (this.closed) return;
    const len = payload.length;
    const head = len < 126 ? Buffer.from([0x80 | op, len])
      : len < 65536 ? Buffer.from([0x80 | op, 126, len >> 8, len & 255])
        : Buffer.concat([Buffer.from([0x80 | op, 127]), (() => { const x = Buffer.alloc(8); x.writeBigUInt64BE(BigInt(len)); return x; })()]);
    this.socket.write(Buffer.concat([head, payload]));
  }
  send(obj) { this.frame(0x1, Buffer.from(JSON.stringify(obj), 'utf8')); }
  close() { try { this.frame(0x8, Buffer.alloc(0)); this.socket.end(); } catch (_) { /* gone */ } this.finish(); }
}

// ============================================================ hub (primary process)
let extension = null; // Peer of the connected extension
const pending = new Map(); // id → {resolve, reject, timer}
let seq = 0;

function startHub() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => { res.writeHead(426, { 'Content-Type': 'text/plain' }); res.end('Archive Cast MCP bridge (WebSocket only)\n'); });
    server.on('upgrade', (req, socket) => {
      const origin = req.headers.origin || '';
      // the extension (chrome-extension://…) or other local node processes (no Origin) — never web pages
      const allowed = (origin === '' || origin.startsWith('chrome-extension://')) && req.url === PATH;
      const key = req.headers['sec-websocket-key'];
      if (!allowed || !key) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
      const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      const peer = new Peer(socket);
      peer.onmessage = (text) => onPeerMessage(peer, text, origin);
      peer.onclose = () => {
        if (extension === peer) { extension = null; log('extension disconnected'); }
      };
    });
    server.once('error', reject);
    server.listen(PORT, HOST, () => { server.removeListener('error', reject); resolve(server); });
  });
}

function onPeerMessage(peer, text, origin) {
  let m;
  try { m = JSON.parse(text); } catch (_) { return; }
  if (m.type === 'hello' && m.role === 'extension' && origin.startsWith('chrome-extension://')) {
    if (extension && extension !== peer) extension.close();
    extension = peer;
    peer.role = 'extension';
    log(`extension connected (v${m.version}, id ${m.extensionId})`);
    return;
  }
  if (m.type === 'hello' && m.role === 'controller') { peer.role = 'controller'; return; }
  if (m.type === 'result' && peer === extension) {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error || 'command failed'));
    return;
  }
  if (m.type === 'relay' && peer.role === 'controller') {
    hubCall(m.cmd, m.args, m.waitMs).then(
      (result) => peer.send({ type: 'result', id: m.id, ok: true, result }),
      (e) => peer.send({ type: 'result', id: m.id, ok: false, error: e.message }),
    );
  }
}

async function waitForExtension(ms) {
  const t0 = Date.now();
  while (!extension && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 250));
  return !!extension;
}

const NOT_CONNECTED = 'The Archive Cast extension is not connected. In Chrome, open Archive Cast’s options (right-click the toolbar icon → Options) and turn on “Connect to the local MCP server”. Chrome must be running.';

async function hubCall(cmd, args, waitMs) {
  if (!extension && !(await waitForExtension(waitMs || 4000))) throw new Error(NOT_CONNECTED);
  const id = 'c' + (++seq);
  const slow = ['open', 'play', 'castMedia', 'findMore', 'resume'].includes(cmd);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out waiting for the extension to finish “${cmd}”.`)); }, slow ? 120000 : 30000);
    pending.set(id, { resolve, reject, timer });
    extension.send({ type: 'call', id, cmd, args: args || {} });
  });
}

// ============================================================ relay (secondary process)
let upstream = null;
const upPending = new Map();

function connectUpstream() {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket === 'undefined') return reject(new Error('Node 22+ is required (global WebSocket).'));
    const ws = new WebSocket(`ws://${HOST}:${PORT}${PATH}`);
    ws.onopen = () => { ws.send(JSON.stringify({ type: 'hello', role: 'controller' })); upstream = ws; resolve(ws); };
    ws.onerror = () => reject(new Error('could not reach the running Archive Cast MCP hub'));
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch (_) { return; }
      const p = upPending.get(m.id);
      if (!p) return;
      upPending.delete(m.id);
      if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error));
    };
    ws.onclose = () => {
      if (upstream === ws) upstream = null;
      for (const p of upPending.values()) p.reject(new Error('The MCP hub went away; retry.'));
      upPending.clear();
    };
  });
}

let mode = null; // 'hub' | 'relay'
async function ensureTransport() {
  if (mode === 'hub') return;
  if (mode === 'relay' && upstream) return;
  try {
    await startHub();
    mode = 'hub';
    log(`listening on ws://${HOST}:${PORT}${PATH}`);
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    await connectUpstream();
    mode = 'relay';
    log(`another Archive Cast MCP server owns port ${PORT}; relaying through it`);
  }
}

async function callExtension(cmd, args, waitMs) {
  await ensureTransport();
  if (mode === 'hub') return hubCall(cmd, args, waitMs);
  const id = 'r' + (++seq);
  return new Promise((resolve, reject) => {
    upPending.set(id, { resolve, reject });
    upstream.send(JSON.stringify({ type: 'relay', id, cmd, args, waitMs }));
  });
}

// ============================================================ MCP (stdio JSON-RPC)
const INSTRUCTIONS = `Archive Cast casts whole shows to a Chromecast as an autoplaying queue (archive.org shows, podcasts, and video/audio on other sites) without casting a tab.
Typical flow: open_page {url} → list_episodes → play_episode {index}. Then pause/resume/next_episode/seek/set_volume.
Picking the Chromecast needs one real click in Chrome ("Connect" in the panel). If play_episode says "Not connected", ask the user to press Connect, then retry. Once connected, everything else works without clicks.
On sites with their own Cast button, set_auto_advance {on:true} makes the site's player continue to the next episode by itself.`;

function toolList() {
  return COMMANDS.filter((c) => c.tool).map((c) => ({
    name: c.tool,
    description: c.description,
    inputSchema: schemaFor(c),
  }));
}

function respond(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
function respondError(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'); }

async function onRpc(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    switch (method) {
      case 'initialize':
        ensureTransport().catch((e) => log('bridge:', e.message));
        return respond(id, {
          protocolVersion: (params && params.protocolVersion) || '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'archive-cast', title: 'Archive Cast', version: VERSION },
          instructions: INSTRUCTIONS,
        });
      case 'ping': return respond(id, {});
      case 'tools/list': return respond(id, { tools: toolList() });
      case 'tools/call': {
        const def = byTool[params && params.name];
        if (!def) return respondError(id, -32602, `Unknown tool: ${params && params.name}`);
        try {
          const result = await callExtension(def.name, (params && params.arguments) || {});
          return respond(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
        } catch (e) {
          return respond(id, { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true });
        }
      }
      default:
        if (method && method.startsWith('notifications/')) return;
        if (isRequest) respondError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    if (isRequest) respondError(id, -32603, e.message);
  }
}

function serveMcp() {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch (_) { return respondError(null, -32700, 'Parse error'); }
    if (Array.isArray(msg)) msg.forEach(onRpc); else onRpc(msg);
  });
  rl.on('close', () => process.exit(0));
}

// ============================================================ CLI
async function cli(argv) {
  const [sub, name, json] = argv;
  if (sub === 'tools') {
    for (const t of toolList()) console.log(`${t.name.padEnd(22)} ${t.description}`);
    return;
  }
  if (sub === 'call') {
    const def = byTool[name] || COMMANDS.find((c) => c.name === name);
    if (!def) throw new Error(`Unknown tool "${name}". Run: node mcp/server.mjs tools`);
    const args = json ? JSON.parse(json) : {};
    // a fresh hub needs a moment for the extension to (re)connect: it retries every few seconds
    const result = await callExtension(def.name, args, 65000);
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }
  console.log(`Archive Cast MCP server ${VERSION}
  node mcp/server.mjs                 run as an MCP server over stdio (what MCP clients launch)
  node mcp/server.mjs tools           list tools
  node mcp/server.mjs call <tool> [json-args]
                                      e.g. call play_episode '{"index":2}'`);
}

const argv = process.argv.slice(2);
if (argv.length) {
  cli(argv).catch((e) => { console.error('Error: ' + e.message); process.exit(1); });
} else {
  serveMcp();
}
