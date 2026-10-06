// node --test test/  — the DOM-free parts of the generic site support.
// (Page scanning, feeds and next-link following run against real pages in test/e2e.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const G = require('../lib/generic.js');
const C = require('../lib/commands.js');

test('network responses: whole files and manifests are castable, segments and tiny files are not', () => {
  const big = '5000000';
  assert.equal(G.classifyResponse({ url: 'https://cdn.x/ep1.mp4', contentType: 'video/mp4', contentLength: big }).mime, 'video/mp4');
  assert.equal(G.classifyResponse({ url: 'https://cdn.x/master.m3u8?t=1', contentType: 'application/vnd.apple.mpegurl' }).mime, 'application/x-mpegurl');
  assert.equal(G.classifyResponse({ url: 'https://cdn.x/a/manifest', contentType: 'application/dash+xml' }).mime, 'application/dash+xml');
  assert.equal(G.classifyResponse({ url: 'https://cdn.x/show.mp3', contentType: 'audio/mpeg', contentLength: big }).kind, 'audio');
  // byte-range responses report the full size in Content-Range
  assert.ok(G.classifyResponse({ url: 'https://cdn.x/ep.mp4', contentType: 'video/mp4', contentLength: '2', contentRange: 'bytes 0-1/90000000', status: 206 }));
  assert.equal(G.classifyResponse({ url: 'https://cdn.x/seg-12.ts', contentType: 'video/mp2t', contentLength: big }), null);
  assert.equal(G.classifyResponse({ url: 'https://cdn.x/chunk.m4s', contentType: 'video/iso.segment', contentLength: big }), null);
  assert.equal(G.classifyResponse({ url: 'https://cdn.x/click.mp3', contentType: 'audio/mpeg', contentLength: '4000' }), null);
  assert.equal(G.classifyResponse({ url: 'https://cdn.x/a.vtt', contentType: 'text/vtt' }), null);
  assert.equal(G.classifyResponse({ url: 'https://cdn.x/x.mp4', contentType: 'video/mp4', status: 404 }), null);
  assert.equal(G.classifyResponse({ url: 'blob:https://x/123', contentType: 'video/mp4' }), null);
});

test('MIME detection prefers the declared type and falls back to the extension', () => {
  assert.equal(G.mimeFor('https://x/a.MP4'), 'video/mp4');
  assert.equal(G.mimeFor('https://x/a?file=b', 'audio/mp4; codecs="mp4a.40.2"'), 'audio/mp4');
  assert.equal(G.mimeFor('https://x/a.mov'), 'video/mp4');
  assert.equal(G.mimeFor('https://x/a.html'), null);
  assert.equal(G.formatLabel('application/x-mpegurl'), 'HLS stream');
});

test('durations: ISO 8601 and clock formats', () => {
  assert.equal(G.isoDuration('PT1H2M3S'), 3723);
  assert.equal(G.isoDuration('PT45M'), 2700);
  assert.equal(G.clockDuration('1:02:03'), 3723);
  assert.equal(G.clockDuration('3723'), 3723);
  assert.equal(G.clockDuration('PT2M'), 120);
  assert.equal(G.clockDuration(''), null);
});

test('command catalog: every tab command takes tabId, every tool has a schema', () => {
  for (const c of C.COMMANDS) {
    if (c.scope === 'tab') assert.ok(c.args.tabId, c.name);
    if (c.tool) {
      const s = C.schemaFor(c);
      assert.equal(s.type, 'object');
      for (const r of s.required) assert.ok(s.properties[r], `${c.name}.${r} declared`);
    }
  }
  assert.equal(new Set(C.COMMANDS.map((c) => c.tool).filter(Boolean)).size, C.COMMANDS.filter((c) => c.tool).length, 'tool names unique');
});
