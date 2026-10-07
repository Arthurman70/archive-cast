// node --test test/  — YouTube URL handling. (Page scanning and the player tab run in test/e2e.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Y = require('../lib/youtube.js');
const G = require('../lib/generic.js');

test('video IDs from every kind of YouTube link', () => {
  const id = 'dQw4w9WgXcQ';
  for (const url of [
    `https://www.youtube.com/watch?v=${id}`,
    `https://www.youtube.com/watch?feature=share&v=${id}&t=42s`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}&list=RD123`,
    `https://youtu.be/${id}?si=abc`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/embed/${id}?autoplay=1`,
    `https://www.youtube-nocookie.com/embed/${id}`,
    `https://www.youtube.com/live/${id}`,
    `/watch?v=${id}&index=3`,
  ]) assert.equal(Y.videoId(url), id, url);
});

test('non-video and malformed links give null', () => {
  for (const url of [
    'https://www.youtube.com/', 'https://www.youtube.com/@channel', 'https://www.youtube.com/playlist?list=PL123',
    'https://www.youtube.com/watch?v=short', 'https://example.com/watch?v=dQw4w9WgXcQ', 'not a url at all', '',
  ]) assert.equal(Y.videoId(url), null, url);
  assert.ok(Y.isId('dQw4w9WgXcQ'));
  assert.ok(!Y.isId('dQw4w9WgXc'));
});

test('durations from thumbnail badges and ISO meta tags', () => {
  assert.equal(Y.clockSeconds('4:13'), 253);
  assert.equal(Y.clockSeconds(' 1:02:03 '), 3723);
  assert.equal(Y.clockSeconds('LIVE'), null);
  assert.equal(Y.isoSeconds('PT4M13S'), 253);
  assert.equal(Y.isoSeconds('PT1H'), 3600);
});

test('YouTube’s own googlevideo streams are never offered for direct casting', () => {
  assert.equal(G.classifyResponse({ url: 'https://rr3---sn-abc.googlevideo.com/videoplayback?itag=18', contentType: 'video/mp4', contentLength: '9000000' }), null);
});
