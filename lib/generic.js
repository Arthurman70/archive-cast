// Finds castable media on arbitrary websites: <video>/<audio> elements, links to media files,
// Open Graph / JSON-LD media, podcast feeds, "next episode" links, and network responses.
// Loaded by content scripts (DOM helpers), the service worker (classifyResponse) and node tests.
(function (root) {
  'use strict';

  const MIME_BY_EXT = {
    mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
    m3u8: 'application/x-mpegurl', mpd: 'application/dash+xml',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg',
    opus: 'audio/ogg', flac: 'audio/flac', wav: 'audio/wav',
  };
  // HLS/DASH segments and other pieces that are never a whole episode
  const SEGMENT_EXT = new Set(['ts', 'm4s', 'm4f', 'cmfv', 'cmfa', 'cmft', 'vtt', 'webvtt', 'key', 'init']);
  const MIN_PROGRESSIVE_BYTES = 300 * 1024; // skip UI sounds and tiny previews

  function extOf(url) {
    try {
      const m = /\.([a-z0-9]{2,5})$/i.exec(new URL(url, 'https://x.invalid/').pathname);
      return m ? m[1].toLowerCase() : '';
    } catch (_) { return ''; }
  }

  function isHttp(url) { return /^https?:\/\//i.test(url || ''); }

  function hostOf(url) { try { return new URL(url).hostname; } catch (_) { return ''; } }

  function absolute(url, base) {
    try { return new URL(url, base).href; } catch (_) { return null; }
  }

  // Normalize a declared type (e.g. "video/mp4; codecs=…") or fall back to the file extension.
  function mimeFor(url, type) {
    const t = String(type || '').split(';')[0].trim().toLowerCase();
    if (/mpegurl/.test(t)) return 'application/x-mpegurl';
    if (/dash\+xml/.test(t)) return 'application/dash+xml';
    if (/^(video|audio)\//.test(t) && !/mp2t|iso\.segment/.test(t)) return t === 'video/quicktime' ? 'video/mp4' : t;
    return MIME_BY_EXT[extOf(url)] || null;
  }

  function kindFor(mime) { return /^audio\//.test(mime || '') ? 'audio' : 'video'; }

  const FORMAT_NAMES = {
    'audio/mpeg': 'MP3', 'audio/mp4': 'M4A', 'audio/aac': 'AAC', 'audio/ogg': 'Ogg', 'audio/flac': 'FLAC', 'audio/wav': 'WAV',
    'video/mp4': 'MP4', 'video/webm': 'WebM', 'video/x-matroska': 'MKV',
  };
  function formatLabel(mime) {
    if (!mime) return '';
    if (/mpegurl/.test(mime)) return 'HLS stream';
    if (/dash/.test(mime)) return 'DASH stream';
    return FORMAT_NAMES[mime] || mime.split('/')[1].replace(/^x-/, '').toUpperCase();
  }

  /**
   * Decide whether a network response is a whole, castable media resource.
   * @param {{url:string, contentType?:string, contentLength?:string|number, contentRange?:string, status?:number}} r
   * @returns {null | {url, mime, kind, size}}
   */
  function classifyResponse(r) {
    if (!r || !isHttp(r.url)) return null;
    if (r.status && (r.status < 200 || r.status >= 300)) return null;
    // YouTube's media only plays inside YouTube's own player (signed, origin-bound requests)
    if (/(^|\.)googlevideo\.com$/.test(hostOf(r.url))) return null;
    const ext = extOf(r.url);
    if (SEGMENT_EXT.has(ext)) return null;
    const ct = String(r.contentType || '').toLowerCase();
    if (/mp2t|iso\.segment|vtt|text\/|image\/|json|javascript/.test(ct) && !/mpegurl|dash/.test(ct)) return null;
    const mime = mimeFor(r.url, ct) || (ct === 'application/octet-stream' ? MIME_BY_EXT[ext] : null);
    if (!mime) return null;
    let size = null;
    const range = /\/(\d+)\s*$/.exec(r.contentRange || '');
    if (range) size = +range[1];
    else if (r.contentLength != null && r.contentLength !== '') size = +r.contentLength;
    const playlist = /mpegurl|dash/.test(mime);
    if (!playlist && size != null && isFinite(size) && size < MIN_PROGRESSIVE_BYTES) return null;
    return { url: r.url, mime, kind: kindFor(mime), size: isFinite(size) ? size : null };
  }

  function isoDuration(s) {
    const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/i.exec(String(s || '').trim());
    if (!m) return null;
    const v = (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
    return v > 0 ? v : null;
  }

  function clockDuration(s) {
    const str = String(s == null ? '' : s).trim();
    if (!str) return null;
    if (/^P/i.test(str)) return isoDuration(str);
    const parts = str.split(':').map(Number);
    if (parts.some((p) => !isFinite(p))) return null;
    const v = parts.reduce((acc, p) => acc * 60 + p, 0);
    return v > 0 ? v : null;
  }

  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const GENERIC_LINK_TEXT = /^(download|play|listen|watch|mp3|mp4|video|audio|link|here|file|stream|direct link|\.\w+|\d+(\.\d+)?\s*(mb|kb|gb))$/i;

  function fileTitle(url) {
    try {
      const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
      return clean(name.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_+]/g, ' ')) || url;
    } catch (_) { return url; }
  }

  function nearbyHeading(el) {
    const box = el.closest && el.closest('article, li, tr, section, figure, [class*="episode" i], [class*="item" i], [class*="card" i]');
    const h = box && box.querySelector('h1, h2, h3, h4, h5, [class*="title" i]');
    return h ? clean(h.textContent).slice(0, 200) : '';
  }

  function meta(doc, names) {
    for (const n of names) {
      const el = doc.querySelector(`meta[property="${n}"], meta[name="${n}"]`);
      if (el && el.getAttribute('content')) return el.getAttribute('content');
    }
    return '';
  }

  function pageTitle(doc) {
    return clean(meta(doc, ['og:title', 'twitter:title']) || (doc.querySelector('h1') || {}).textContent || doc.title || '');
  }

  function jsonLdNodes(doc) {
    const out = [];
    const walk = (v) => {
      if (!v || typeof v !== 'object') return;
      if (Array.isArray(v)) return v.forEach(walk);
      out.push(v);
      for (const k of Object.keys(v)) if (typeof v[k] === 'object') walk(v[k]);
    };
    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try { walk(JSON.parse(s.textContent)); } catch (_) { /* malformed JSON-LD is common */ }
    }
    return out;
  }

  /**
   * Scan a document (live page or one fetched with DOMParser) for castable media.
   * Items keep document order; `src` says where each one came from.
   */
  function scanDocument(doc, baseUrl) {
    const base = baseUrl || (doc.location && doc.location.href) || '';
    const title = pageTitle(doc);
    const image = absolute(meta(doc, ['og:image', 'twitter:image']), base);
    const items = [];
    const seen = new Set();
    const add = (url, extra) => {
      const abs = absolute(url, base);
      if (!abs || !isHttp(abs) || seen.has(abs)) return;
      const mime = mimeFor(abs, extra.type);
      if (!mime) return;
      seen.add(abs);
      items.push({
        url: abs, mime, kind: kindFor(mime), title: clean(extra.title) || fileTitle(abs),
        image: extra.image ? absolute(extra.image, base) : null, duration: extra.duration || null, src: extra.src,
      });
    };

    for (const el of doc.querySelectorAll('video, audio, source, a[href]')) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'a') {
        const href = el.getAttribute('href');
        if (!href || !MIME_BY_EXT[extOf(absolute(href, base) || '')]) continue;
        let t = clean(el.textContent || el.getAttribute('title') || el.getAttribute('aria-label'));
        if (!t || GENERIC_LINK_TEXT.test(t)) t = nearbyHeading(el) || '';
        add(href, { title: t, type: el.getAttribute('type'), src: 'link' });
      } else if (tag === 'source') {
        const media = el.closest('video, audio');
        add(el.getAttribute('src'), {
          type: el.getAttribute('type'), src: 'element',
          title: (media && (media.getAttribute('title') || media.getAttribute('aria-label'))) || nearbyHeading(el) || title,
          image: media && media.getAttribute('poster'),
        });
      } else {
        const src = el.currentSrc || el.getAttribute('src');
        if (!src) continue;
        add(src, {
          src: 'element', title: el.getAttribute('title') || el.getAttribute('aria-label') || nearbyHeading(el) || title,
          image: el.getAttribute('poster'), duration: isFinite(el.duration) && el.duration > 0 ? el.duration : null,
        });
      }
    }

    for (const n of jsonLdNodes(doc)) {
      const types = [].concat(n['@type'] || []).join(' ');
      if (!/VideoObject|AudioObject|MediaObject|Episode|Clip|Movie/i.test(types)) continue;
      const media = [n].concat(n.associatedMedia || [], n.audio || [], n.video || []);
      for (const mo of media) {
        if (!mo || typeof mo !== 'object' || !mo.contentUrl) continue;
        const thumb = [].concat(mo.thumbnailUrl || n.thumbnailUrl || n.image || [])[0];
        add(mo.contentUrl, {
          src: 'jsonld', type: mo.encodingFormat, title: n.name || mo.name || title,
          image: typeof thumb === 'object' ? thumb && thumb.url : thumb, duration: isoDuration(mo.duration || n.duration),
        });
      }
    }

    for (const prop of ['og:video:secure_url', 'og:video:url', 'og:video', 'og:audio:secure_url', 'og:audio', 'twitter:player:stream']) {
      const v = meta(doc, [prop]);
      if (v) add(v, { src: 'meta', title, image, type: meta(doc, [prop.replace(/(:secure_url|:url)?$/, ':type')]) });
    }

    const feeds = [];
    for (const l of doc.querySelectorAll('link[rel~="alternate"][type]')) {
      const type = (l.getAttribute('type') || '').toLowerCase();
      if (!/rss|atom/.test(type)) continue;
      const url = absolute(l.getAttribute('href'), base);
      if (url && isHttp(url) && !feeds.some((f) => f.url === url)) feeds.push({ url, title: clean(l.getAttribute('title')) });
    }

    return { title, image, items, feeds, next: findNextLink(doc, base) };
  }

  // The single item that best represents "this page's episode".
  function primaryItem(scan) {
    const rank = { element: 0, jsonld: 1, meta: 2, stream: 3, link: 4 };
    return scan.items.slice().sort((a, b) => (rank[a.src] ?? 9) - (rank[b.src] ?? 9))[0] || null;
  }

  const NEXT_STRONG = /\bnext\s*(episode|ep\b|ep\.|part|chapter|video|lesson|track)\b|\bnext\s*›|\bnext\s*»|^\s*next\s*$/i;
  const NEXT_WEAK = /^\s*(›|»|→|>|>>|next\s*page)\s*$/i;

  /** Best guess at the "next episode" URL on a page, or null. */
  function findNextLink(doc, baseUrl) {
    const base = baseUrl || (doc.location && doc.location.href) || '';
    const here = stripHash(base);
    let best = null;
    const consider = (href, score) => {
      const abs = absolute(href, base);
      if (!abs || !isHttp(abs) || stripHash(abs) === here) return;
      if (!best || score > best.score) best = { url: abs, score };
    };
    const rel = doc.querySelector('link[rel~="next"][href]');
    if (rel) consider(rel.getAttribute('href'), 100);
    for (const a of doc.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href');
      if (!href || href.startsWith('#') || /^javascript:/i.test(href)) continue;
      const rels = (a.getAttribute('rel') || '').toLowerCase().split(/\s+/);
      const label = clean([a.textContent, a.getAttribute('aria-label'), a.getAttribute('title')].join(' '));
      const cls = ((a.className && a.className.baseVal != null ? a.className.baseVal : a.className) || '') + ' ' + (a.id || '');
      let score = 0;
      if (rels.includes('next')) score = 90;
      else if (NEXT_STRONG.test(label) && /episode|ep|part|chapter|video|lesson|track/i.test(label)) score = 85;
      else if (NEXT_STRONG.test(label)) score = 70;
      else if (NEXT_WEAK.test(label)) score = 45;
      else if (/(^|[\s_-])next([\s_-]|$)/i.test(cls)) score = 30;
      if (/prev|previous|back/i.test(label)) score = 0;
      if (score) consider(href, score);
    }
    return best ? best.url : null;
  }

  function stripHash(u) { return String(u || '').split('#')[0]; }

  /** Parse an RSS/Atom podcast feed (needs DOMParser). Items come back oldest first. */
  function parseFeed(xmlText, feedUrl, DOMParserImpl) {
    const P = DOMParserImpl || (typeof DOMParser !== 'undefined' ? DOMParser : null);
    if (!P) throw new Error('DOMParser unavailable');
    const doc = new P().parseFromString(xmlText, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('not a valid feed');
    const text = (el, names) => {
      for (const n of names) {
        const c = el.getElementsByTagName(n)[0];
        if (c && c.textContent.trim()) return c.textContent.trim();
      }
      return '';
    };
    const attr = (el, names, a) => {
      for (const n of names) {
        const c = el.getElementsByTagName(n)[0];
        if (c && c.getAttribute(a)) return c.getAttribute(a);
      }
      return '';
    };
    const channel = doc.getElementsByTagName('channel')[0] || doc.documentElement;
    const feedTitle = text(channel, ['title']);
    const feedImage = attr(channel, ['itunes:image'], 'href') || text(channel.getElementsByTagName('image')[0] || channel, ['url']);
    const nodes = [...doc.getElementsByTagName('item'), ...doc.getElementsByTagName('entry')];
    const items = [];
    nodes.forEach((n, order) => {
      let url = attr(n, ['enclosure'], 'url');
      let type = attr(n, ['enclosure'], 'type');
      if (!url) {
        const link = [...n.getElementsByTagName('link')].find((l) => l.getAttribute('rel') === 'enclosure');
        if (link) { url = link.getAttribute('href'); type = link.getAttribute('type'); }
      }
      if (!url) { url = attr(n, ['media:content'], 'url'); type = attr(n, ['media:content'], 'type'); }
      const abs = absolute(url, feedUrl);
      const mime = abs && mimeFor(abs, type);
      if (!mime) return;
      const date = Date.parse(text(n, ['pubDate', 'published', 'updated', 'dc:date']));
      const season = parseInt(text(n, ['itunes:season']), 10);
      items.push({
        url: abs, mime, kind: kindFor(mime), title: text(n, ['itunes:title', 'title']) || fileTitle(abs),
        date: isFinite(date) ? date : null, order,
        duration: clockDuration(text(n, ['itunes:duration'])),
        season: isFinite(season) ? season : null,
        episode: parseInt(text(n, ['itunes:episode']), 10) || null,
        image: attr(n, ['itunes:image'], 'href') || feedImage || null,
      });
    });
    const dated = items.every((i) => i.date != null);
    // feeds are conventionally newest-first; play them oldest-first
    items.sort((a, b) => (dated ? a.date - b.date : b.order - a.order));
    return { title: feedTitle, image: feedImage || null, items };
  }

  root.ArchiveCastGeneric = {
    MIME_BY_EXT, extOf, mimeFor, kindFor, formatLabel, classifyResponse, isoDuration, clockDuration,
    scanDocument, primaryItem, findNextLink, parseFeed, pageTitle, fileTitle, stripHash,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.ArchiveCastGeneric;
})(typeof globalThis !== 'undefined' ? globalThis : this);
