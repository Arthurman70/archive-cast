// YouTube helpers: video IDs from any YouTube URL, and the videos a YouTube page shows
// (the current video, its playlist, and every other video linked on the page).
// Loaded by content scripts (DOM scan), the service worker (URL parsing) and node tests.
(function (root) {
  'use strict';

  const ID = /^[A-Za-z0-9_-]{11}$/;

  /** The 11-character video ID in a YouTube URL (watch, shorts, youtu.be, embed, live), or null. */
  function videoId(url, base) {
    let u;
    try { u = new URL(url, base || 'https://www.youtube.com/'); } catch (_) { return null; }
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    let id = null;
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') id = u.searchParams.get('v');
      else {
        const m = /^\/(shorts|embed|live|v)\/([^/?#]+)/.exec(u.pathname);
        if (m) id = m[2];
      }
    }
    return id && ID.test(id) ? id : null;
  }

  function isId(s) { return ID.test(String(s || '')); }

  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  function clockSeconds(s) {
    const parts = clean(s).split(':').map(Number);
    if (!parts.length || parts.some((p) => !isFinite(p))) return null;
    const v = parts.reduce((acc, p) => acc * 60 + p, 0);
    return v > 0 ? v : null;
  }

  function isoSeconds(s) {
    const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(clean(s));
    if (!m) return null;
    const v = (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
    return v > 0 ? v : null;
  }

  // the card (renderer / lockup) a link belongs to
  function card(el) {
    return el.closest('ytd-playlist-panel-video-renderer, ytd-playlist-video-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-rich-item-renderer, ytd-reel-item-renderer, yt-lockup-view-model, ytm-shorts-lockup-view-model, ytd-rich-grid-media, li, article') || el.parentElement;
  }

  function titleFor(a) {
    const own = clean(a.getAttribute('title')) || clean(a.querySelector('#video-title, [id="video-title"]')?.textContent);
    if (own) return own;
    const c = card(a);
    const t = c && c.querySelector('#video-title, [id="video-title"], h3, .yt-lockup-metadata-view-model__title, [class*="title" i]');
    const text = t && clean(t.getAttribute('title') || t.textContent);
    if (text) return text;
    // aria-labels look like "Title by Channel 12 minutes" — keep the part before " by "
    const aria = clean(a.getAttribute('aria-label'));
    return aria ? aria.replace(/\s+by\s+.*$/i, '') : '';
  }

  function durationFor(a) {
    const c = card(a);
    const badge = c && c.querySelector('ytd-thumbnail-overlay-time-status-renderer #text, .ytd-thumbnail-overlay-time-status-renderer, badge-shape .yt-badge-shape__text, .badge-shape-wiz__text, [class*="time-status" i]');
    return badge ? clockSeconds(badge.textContent) : null;
  }

  function channelFor(a) {
    const c = card(a);
    const ch = c && c.querySelector('ytd-channel-name a, #channel-name a, #byline, a[href^="/@"], a[href^="/channel/"]');
    return ch ? clean(ch.textContent) : '';
  }

  const isAd = (el) => !!el.closest('ytd-ad-slot-renderer, ytd-promoted-video-renderer, ytd-in-feed-ad-layout-renderer, [is-ad], .ytd-display-ad-renderer');

  /**
   * Videos on a YouTube page.
   * @returns {{current: object|null, playlist: {id, title, items}|null, page: object[]}}
   *   each video is {id, title, channel, duration}
   */
  function scanDocument(doc, pageUrl) {
    const url = new URL(pageUrl || (doc.location && doc.location.href) || 'https://www.youtube.com/');
    const curId = videoId(url.href);
    let current = null;
    if (curId) {
      const h1 = doc.querySelector('h1.ytd-watch-metadata, ytd-watch-metadata h1, #title h1, h1.title');
      const metaTitle = doc.querySelector('meta[name="title"]');
      const title = clean(h1 && h1.textContent) || clean(metaTitle && metaTitle.content) || clean(doc.title).replace(/\s*-\s*YouTube$/, '');
      const ch = doc.querySelector('ytd-watch-metadata ytd-channel-name a, #owner ytd-channel-name a, #owner #channel-name a, span[itemprop="author"] link[itemprop="name"]');
      const dur = doc.querySelector('meta[itemprop="duration"]');
      current = {
        id: curId, title: title || curId,
        channel: clean(ch && (ch.textContent || ch.getAttribute('content'))),
        duration: isoSeconds(dur && dur.content),
      };
    }

    const listId = url.searchParams.get('list');
    let playlist = null;
    if (listId) {
      const rows = doc.querySelectorAll('ytd-playlist-panel-video-renderer a#wc-endpoint, ytd-playlist-panel-video-renderer a[href*="watch"], ytd-playlist-video-renderer a#video-title, ytd-playlist-video-renderer a[href*="watch"]');
      const items = [];
      const seen = new Set();
      for (const a of rows) {
        const id = videoId(a.getAttribute('href'), url.href);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        items.push({ id, title: titleFor(a) || id, channel: channelFor(a), duration: durationFor(a) });
      }
      const head = doc.querySelector('ytd-playlist-panel-renderer #header-description h3 a, ytd-playlist-panel-renderer .title, ytd-playlist-header-renderer .title, yt-dynamic-sizing-formatted-string.ytd-playlist-header-renderer, h1#title');
      if (items.length) playlist = { id: listId, title: clean(head && head.textContent) || 'This playlist', items };
    }

    const page = [];
    const seen = new Set([curId].concat(playlist ? playlist.items.map((i) => i.id) : []));
    const byId = new Map();
    for (const a of doc.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href');
      if (!/watch\?|\/shorts\/|youtu\.be\//.test(href)) continue;
      if (isAd(a)) continue;
      const id = videoId(href, url.href);
      if (!id || seen.has(id)) continue;
      const title = titleFor(a);
      const known = byId.get(id);
      if (known) { if (!known.title && title) known.title = title; continue; }
      const v = { id, title, channel: channelFor(a), duration: durationFor(a) };
      byId.set(id, v);
      page.push(v);
    }
    // a thumbnail-only link with no title anywhere is usually chrome (end screens, etc.)
    return { current, playlist, page: page.filter((v) => v.title) };
  }

  const watchUrl = (id) => 'https://www.youtube.com/watch?v=' + id;
  const thumbUrl = (id) => 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg';

  root.ArchiveCastYouTube = { videoId, isId, scanDocument, watchUrl, thumbUrl, clockSeconds, isoSeconds };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.ArchiveCastYouTube;
})(typeof globalThis !== 'undefined' ? globalThis : this);
