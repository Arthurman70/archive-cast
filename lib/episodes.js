// Turns Internet Archive metadata into an ordered, castable episode list.
// Loaded as a content script (attaches to globalThis) and by node tests (module.exports).
(function (root) {
  'use strict';

  // What a Chromecast (Default Media Receiver) can actually play.
  const CAST_MIME = {
    mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/mp4',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg',
    opus: 'audio/ogg', flac: 'audio/flac', wav: 'audio/wav',
  };
  const VIDEO_EXT = new Set(['mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi', 'mpg', 'mpeg', 'mpe', 'wmv', 'flv',
    'ogv', '3gp', 'ts', 'm2ts', 'mts', 'vob', 'divx', 'rm', 'rmvb', 'asf', 'dv', 'f4v']);
  const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wav', 'wma', 'aif', 'aiff',
    'ape', 'shn', 'm4b', 'ra', 'au', 'mp2']);

  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

  function ext(name) {
    const m = /\.([a-z0-9]+)$/i.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }

  function kindOfExt(e) {
    if (VIDEO_EXT.has(e)) return 'video';
    if (AUDIO_EXT.has(e)) return 'audio';
    return null;
  }

  // Higher is better. mode: 'best' = original quality first, 'compat' = archive's h.264/mp3 encodes first.
  function score(file, mode) {
    const e = ext(file.name);
    if (!CAST_MIME[e]) return -1;
    const fmt = String(file.format || '').toLowerCase();
    const orig = file.source === 'original';
    const compat = mode === 'compat';
    if (e === 'mp4' || e === 'm4v') {
      if (/h\.264 hd/.test(fmt)) return compat ? 86 : 85;
      if (/h\.264 ia/.test(fmt)) return compat ? 88 : 78;
      if (/h\.264/.test(fmt)) return compat ? 90 : 80;
      if (/512kb/.test(fmt)) return compat ? 70 : 60;
      if (orig) return compat ? 75 : 95;
      return compat ? 80 : 70; // other MPEG4 derivatives
    }
    if (e === 'webm') return compat ? 40 : 50;
    if (e === 'mkv' || e === 'mov') return compat ? 20 : 30;
    // audio
    if (e === 'mp3') {
      if (orig) return compat ? 92 : 90;
      if (/vbr/.test(fmt)) return compat ? 90 : 80;
      if (/128/.test(fmt)) return compat ? 85 : 75;
      return compat ? 80 : 55;
    }
    if (e === 'flac') return orig ? (compat ? 50 : 88) : 45;
    if (e === 'm4a' || e === 'aac') return orig ? (compat ? 70 : 86) : 65;
    if (e === 'ogg' || e === 'oga' || e === 'opus') return orig ? (compat ? 60 : 84) : 58;
    if (e === 'wav') return compat ? 40 : 82;
    return 10;
  }

  function parseDuration(len) {
    if (len == null || len === '') return null;
    const s = String(len);
    if (s.includes(':')) {
      const parts = s.split(':').map(Number);
      if (parts.some(isNaN)) return null;
      return parts.reduce((acc, p) => acc * 60 + p, 0);
    }
    const n = parseFloat(s);
    return isFinite(n) && n > 0 ? n : null;
  }

  function basename(p) { const i = p.lastIndexOf('/'); return i < 0 ? p : p.slice(i + 1); }
  function dirname(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }

  function cleanName(name) {
    return basename(name)
      .replace(/(\.ia)?\.[a-z0-9]+$/i, '')
      .replace(/_/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function downloadUrl(identifier, name) {
    return 'https://archive.org/download/' + encodeURIComponent(identifier) + '/' +
      name.split('/').map(encodeURIComponent).join('/');
  }

  function firstString(v) {
    if (Array.isArray(v)) return v.length ? String(v[0]) : '';
    return v == null ? '' : String(v);
  }

  /**
   * Build episode lists from an archive.org item.
   * @param {string} identifier
   * @param {Array} files  metadata `files` array
   * @param {object} [itemMeta] metadata `metadata` object
   * @param {object} [opts] { mode: 'best'|'compat' }
   * @returns {{video: Array, audio: Array}}
   */
  function buildEpisodes(identifier, files, itemMeta, opts) {
    const mode = (opts && opts.mode) || 'best';
    const meta = itemMeta || {};
    const showTitle = firstString(meta.title) || identifier;
    const creator = firstString(meta.creator);
    const image = 'https://archive.org/services/img/' + encodeURIComponent(identifier);
    const byName = new Map();
    for (const f of files || []) if (f && f.name) byName.set(f.name, f);

    const rootOf = (f) => {
      let cur = f;
      for (let depth = 0; depth < 6; depth++) {
        if (cur.source !== 'derivative' || !cur.original) return cur.name;
        const up = byName.get(cur.original);
        if (!up) return cur.original;
        cur = up;
      }
      return cur.name;
    };

    // group every castable file under the original it was derived from
    const groups = new Map();
    for (const f of byName.values()) {
      if (f.source === 'metadata') continue;
      if (score(f, mode) < 0) continue;
      if (f.private === 'true' || f.private === true) continue;
      const key = rootOf(f);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }

    const out = { video: [], audio: [] };
    for (const [key, cands] of groups) {
      const rootFile = byName.get(key);
      const rootKind = kindOfExt(ext(key));
      const kinded = cands.filter((c) => !rootKind || kindOfExt(ext(c.name)) === rootKind);
      if (!kinded.length) continue;
      kinded.sort((a, b) => score(b, mode) - score(a, mode) || collator.compare(a.name, b.name));
      const pick = kinded[0];
      const kind = kindOfExt(ext(pick.name));
      const src = rootFile || pick;
      const title = (src.title && String(src.title).trim()) || cleanName(key);
      out[kind].push({
        key,
        id: identifier,
        file: pick.name,
        url: downloadUrl(identifier, pick.name),
        mime: CAST_MIME[ext(pick.name)],
        kind,
        title,
        folder: dirname(key),
        duration: parseDuration(src.length) || parseDuration(pick.length),
        track: parseInt(firstString(src.track), 10),
        format: pick.format || '',
        alts: kinded.map((c) => c.name),
        show: showTitle,
        creator,
        image,
      });
    }
    for (const kind of ['video', 'audio']) out[kind] = sortEpisodes(out[kind]);
    return out;
  }

  function sortEpisodes(list) {
    const tracks = list.map((e) => e.track);
    const useTrack = list.length > 1 && tracks.every((t) => Number.isFinite(t)) &&
      new Set(tracks).size === tracks.length && new Set(list.map((e) => e.folder)).size === 1;
    const norm = (k) => k.replace(/[_.]+/g, ' ');
    return list.slice().sort((a, b) => (useTrack ? a.track - b.track : 0) || collator.compare(norm(a.key), norm(b.key)));
  }

  // Which list to show by default for an item.
  function defaultKind(lists, mediatype) {
    const v = lists.video.length, a = lists.audio.length;
    if (!v) return a ? 'audio' : null;
    if (!a) return 'video';
    if (mediatype === 'audio' || mediatype === 'etree') return 'audio';
    if (mediatype === 'movies') return 'video';
    return v >= a ? 'video' : 'audio';
  }

  root.ArchiveCastEpisodes = { buildEpisodes, sortEpisodes, defaultKind, score, parseDuration, cleanName, downloadUrl, collator };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.ArchiveCastEpisodes;
})(typeof globalThis !== 'undefined' ? globalThis : this);
