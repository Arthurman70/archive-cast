// node --test test/  — archive.org metadata → ordered episode lists, against trimmed real items.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const EP = require('../lib/episodes.js');
const fixture = (id) => JSON.parse(readFileSync(new URL(`./fixtures/${id}.json`, import.meta.url), 'utf8'));
const build = (id, mode) => { const j = fixture(id); return EP.buildEpisodes(id, j.files, j.metadata, { mode }); };

test('original MP4s win in "best", archive h.264 encodes in "compat"', () => {
  const best = build('get-smart', 'best').video;
  const compat = build('get-smart', 'compat').video;
  assert.equal(best.length, 12);
  assert.equal(best[0].file, 'Get Smart S01E01 (Mr. Big).mp4');
  assert.equal(compat[0].file, 'Get Smart S01E01 (Mr. Big).ia.mp4');
  assert.deepEqual(best.map((e) => e.key), compat.map((e) => e.key), 'same episodes, same order');
  assert.ok(best[0].alts.includes('Get Smart S01E01 (Mr. Big).ia.mp4'), 'alternates are remembered for fallback');
});

test('uncastable originals (MPEG-1, Cinepak AVI) fall back to their h.264 derivative; Ogg Theora is never picked', () => {
  const eps = build('GreenAcresCompleteSeries', 'best').video;
  assert.ok(eps.length > 20);
  for (const e of eps) assert.match(e.file, /\.mp4$/);
  assert.equal(eps[0].title, 'Green Acres - 001 - Oliver Buys A Farm');
  assert.equal(eps[0].folder, 'Green Acres Season 1');
  assert.equal(eps.at(-1).folder, 'Green Acres Season 6/Green Acres Season 6', 'nested folders kept for grouping');
});

test('radio series: mixed "Gunsmoke 52-…" / "Gunsmoke_60-…" names and .MP3 sort chronologically', () => {
  const eps = build('OTRR_Gunsmoke_Singles', 'best').audio;
  assert.equal(eps.length, 487);
  assert.equal(eps[0].file, 'Gunsmoke 52-04-26 (001) Billy the Kid.mp3');
  const i52 = eps.findIndex((e) => e.file.startsWith('Gunsmoke 52'));
  const i60 = eps.findIndex((e) => e.file.startsWith('Gunsmoke_60'));
  assert.ok(i60 > i52, '1960 episodes come after 1952 ones despite the underscore');
  assert.ok(eps.some((e) => /\.MP3$/.test(e.file)), 'upper-case extensions are recognised');
  assert.equal(eps[0].mime, 'audio/mpeg');
  assert.equal(EP.defaultKind(build('OTRR_Gunsmoke_Singles'), 'audio'), 'audio');
});

test('numbered episodes sort numerically and keep their metadata titles and durations', () => {
  const eps = build('the-world-at-war-1973-thames-television-world-war-two', 'best').video;
  assert.equal(eps.length, 37);
  assert.match(eps[0].title, /^Episode 1 - A New Germany/);
  assert.match(eps[9].file, /^10 /, '10 comes after 9, not after 1');
  assert.ok(eps[0].duration > 3000);
});

test('download URLs are encoded per path segment', () => {
  assert.equal(
    EP.downloadUrl('GreenAcresCompleteSeries', "Green Acres Season 1/Green Acres - 002 - Lisa's First Day.mp4"),
    "https://archive.org/download/GreenAcresCompleteSeries/Green%20Acres%20Season%201/Green%20Acres%20-%20002%20-%20Lisa's%20First%20Day.mp4",
  );
});

test('durations parse from seconds or clock strings', () => {
  assert.equal(EP.parseDuration('1520.14'), 1520.14);
  assert.equal(EP.parseDuration('25:20'), 1520);
  assert.equal(EP.parseDuration('1:00:01'), 3601);
  assert.equal(EP.parseDuration(''), null);
});
