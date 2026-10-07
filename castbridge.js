// Runs in the page's MAIN world. Owns the Google Cast sender SDK and the receiver-side queue;
// the panel (content.js, isolated world) drives it via postMessage. The Chromecast plays the
// queue itself (Default Media Receiver), so autoplay continues even if the tab is closed.
//
// Two SDK modes:
//   own    – the page has no Cast SDK; we load it (seeded with the page's CSP nonce) and use CAF.
//   shared – the site already ships a Cast player; we leave its CastContext alone, drive our own
//            chrome.cast.Session through the base API, and watch the site's session so the
//            panel can auto-advance the site's own player ("autoAdvance").
//
// Also defines window.ArchiveCast — the scriptable API for people and AI agents. Calls are
// answered by content.js; see AGENTS.md.
(() => {
  'use strict';
  if (window.__archiveCastBridge) return;
  window.__archiveCastBridge = true;

  const CMD = 'archive-cast:cmd';
  const EVT = 'archive-cast:evt';
  const API = 'archive-cast:api';
  const API_RES = 'archive-cast:api-result';
  const PUB = 'archive-cast:public';
  const VERSION = '2.1.0';
  const SDK_URL = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
  const DMR = 'CC1AD845'; // Default Media Receiver
  const MAX_CHUNK_BYTES = 40000; // Cast messages are capped at 64KB

  let sdk = 'idle'; // idle | loading | ready | unavailable | blocked
  let sdkError = null;
  let mode = null; // own | shared
  let ctx = null; // our CastContext (own mode)
  let cafSession = null; // own mode CastSession
  let sess = null; // the chrome.cast.Session we drive
  let sessFromSite = false;
  let avoidSiteSession = false;
  let media = null;
  let queueUrls = []; // our belief of the receiver's queue order (for jumps)
  let loadToken = 0;
  let loading = false;

  const noop = () => {};
  const post = (type, data) => window.postMessage(Object.assign({ [EVT]: true, type }, data || {}), location.origin);
  const errMsg = (e) => (e && (e.description || e.message || e.code)) || String(e);
  const isCancel = (e) => e === 'cancel' || (e && e.code === 'cancel');
  const safe = (fn, fallback) => { try { return fn(); } catch (_) { return fallback; } };
  const call = (target, method, ...args) => new Promise((resolve, reject) => target[method](...args, resolve, reject));

  function emit() { post('state', { state: snapshot() }); }

  function snapshot() {
    const vol = receiverVolume();
    const st = {
      sdk, sdkError, mode, castState: castState(), device: sess ? deviceName() : null,
      volume: vol.level, muted: vol.muted, media: null, loading, site: siteSnapshot(), sessionFromSite: sessFromSite,
    };
    if (media) {
      const mi = media.media || {};
      const md = mi.metadata || {};
      st.media = {
        playerState: media.playerState,
        idleReason: media.idleReason,
        time: safe(() => media.getEstimatedTime(), media.currentTime),
        duration: mi.duration || null,
        url: mi.contentId || mi.contentUrl || null,
        custom: mi.customData || null,
        title: md.title || null,
        subtitle: md.subtitle || md.albumName || md.seriesTitle || null,
        itemId: media.currentItemId,
        repeat: media.repeatMode,
        queueLen: media.items ? media.items.length : null,
      };
    }
    return st;
  }

  function castState() {
    if (mode === 'own' && ctx) return safe(() => ctx.getCastState(), null);
    if (sdk !== 'ready') return null;
    return sess ? 'CONNECTED' : 'NOT_CONNECTED';
  }

  function deviceName() {
    if (cafSession) return safe(() => cafSession.getCastDevice().friendlyName, 'Chromecast');
    return safe(() => sess.receiver.friendlyName, 'Chromecast');
  }

  function receiverVolume() {
    if (cafSession) return { level: safe(() => cafSession.getVolume(), null), muted: safe(() => cafSession.isMute(), null) };
    const v = safe(() => sess.receiver.volume, null);
    return v ? { level: v.level, muted: v.muted } : { level: null, muted: null };
  }

  // The site's own Cast session (shared mode), read-only.
  function siteCastSession() {
    if (mode !== 'shared') return null;
    return safe(() => window.cast.framework.CastContext.getInstance().getCurrentSession(), null);
  }

  function siteSnapshot() {
    if (mode !== 'shared') return null;
    const s = siteCastSession();
    if (!s) return { connected: false };
    const m = safe(() => s.getMediaSession(), null);
    const mi = (m && m.media) || {};
    return {
      connected: true,
      device: safe(() => s.getCastDevice().friendlyName, null),
      appId: safe(() => s.getApplicationMetadata().applicationId, null),
      media: m ? {
        playerState: m.playerState, idleReason: m.idleReason, time: safe(() => m.getEstimatedTime(), null),
        duration: mi.duration || null, url: mi.contentId || null, title: (mi.metadata && mi.metadata.title) || null,
        ours: !!(mi.contentId && queueUrls.includes(mi.contentId)),
      } : null,
    };
  }

  // ---- SDK bootstrap -------------------------------------------------------
  // forceOwn: archive.org's own JW Player loads Cast lazily; there we always run our own CAF setup
  // (the arrangement proven on real devices) instead of depending on load order.
  function init(forceOwn) {
    if (sdk !== 'idle') return emit();
    const preexisting = !!(window.cast && window.cast.framework) || !!(window.chrome && window.chrome.cast && window.chrome.cast.media);
    if (preexisting && !forceOwn) return initShared();
    loadSdk();
  }

  // Sites with a strict CSP get the SDK through their own nonce: the Cast loader copies the
  // nonce of the first script[nonce] onto every script it adds.
  function loadSdk() {
    mode = 'own';
    sdk = 'loading';
    emit();
    const onViolation = (e) => {
      if (/gstatic\.com/.test(e.blockedURI || '')) {
        sdk = 'blocked';
        sdkError = 'This site’s security policy blocks the Google Cast library.';
        emit();
      }
    };
    document.addEventListener('securitypolicyviolation', onViolation);
    window.__onGCastApiAvailable = (ok, reason) => {
      document.removeEventListener('securitypolicyviolation', onViolation);
      if (ok && window.cast && cast.framework && window.chrome && chrome.cast && chrome.cast.media) initCaf();
      else fail(reason || 'Google Cast is not available in this browser.');
    };
    const s = document.createElement('script');
    const n = document.querySelector('script[nonce]');
    if (n && n.nonce) s.nonce = n.nonce;
    s.src = SDK_URL;
    s.onerror = () => fail('Could not load the Google Cast library.');
    (document.head || document.documentElement).appendChild(s);
    setTimeout(() => { if (sdk === 'loading') fail('Timed out loading the Google Cast library.'); }, 20000);
  }

  function fail(msg) {
    if (sdk === 'ready' || sdk === 'blocked') return emit();
    sdk = 'unavailable';
    sdkError = msg;
    emit();
  }

  function initCaf() {
    if (sdk === 'ready') return;
    ctx = cast.framework.CastContext.getInstance();
    ctx.setOptions({
      receiverApplicationId: DMR,
      autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
      resumeSavedSession: true,
    });
    const E = cast.framework.CastContextEventType;
    ctx.addEventListener(E.CAST_STATE_CHANGED, emit);
    ctx.addEventListener(E.SESSION_STATE_CHANGED, () => { attachCaf(ctx.getCurrentSession()); emit(); });
    sdk = 'ready';
    attachCaf(ctx.getCurrentSession());
    startTicker();
    emit();
  }

  // The site loaded Cast itself: wait until its SDK is usable, never touch its CastContext options.
  function initShared() {
    mode = 'shared';
    sdk = 'loading';
    emit();
    const started = Date.now();
    const wait = () => {
      if (window.chrome && chrome.cast && chrome.cast.isAvailable) {
        sdk = 'ready';
        startTicker();
        return emit();
      }
      if (Date.now() - started > 15000) return fail('The site’s Cast library never finished loading.');
      setTimeout(wait, 250);
    };
    wait();
  }

  let ticker = null;
  function startTicker() {
    if (ticker) return;
    ticker = setInterval(() => {
      if (sess || (mode === 'shared' && siteCastSession())) emit();
    }, 1000);
  }

  function attachCaf(cs) {
    if (cs === cafSession) return;
    cafSession = cs || null;
    sess = cafSession ? cafSession.getSessionObj() : null;
    if (!cafSession) { attachMedia(null); return; }
    const SE = cast.framework.SessionEventType;
    cafSession.addEventListener(SE.MEDIA_SESSION, (e) => { attachMedia(e.mediaSession); emit(); });
    cafSession.addEventListener(SE.VOLUME_CHANGED, emit);
    attachMedia(cafSession.getMediaSession());
  }

  function attachBase(s, fromSite) {
    if (s === sess) return;
    sess = s;
    sessFromSite = !!fromSite;
    s.addUpdateListener((alive) => {
      if (!alive && sess === s) { sess = null; sessFromSite = false; attachMedia(null); }
      emit();
    });
    s.addMediaListener((m) => { attachMedia(m); emit(); });
    attachMedia(s.media && s.media.length ? s.media[s.media.length - 1] : null);
  }

  function attachMedia(m) {
    if (m === media) return;
    media = m || null;
    if (media) media.addUpdateListener((alive) => { if (!alive && media === m) media = null; emit(); });
  }

  async function ensureSession() {
    if (sess) return sess;
    if (sdk !== 'ready') throw new Error(sdk === 'blocked' ? sdkError : 'Cast is still starting — try again in a moment.');
    if (mode === 'own') {
      await ctx.requestSession(); // rejects with 'cancel' if the picker is dismissed
      attachCaf(ctx.getCurrentSession());
    } else {
      // Reuse a session the site already started (any receiver that speaks the standard media
      // protocol); otherwise start our own Default Media Receiver session.
      const site = !avoidSiteSession && siteCastSession();
      if (site) attachBase(site.getSessionObj(), true);
      else attachBase(await requestBaseSession(), false);
    }
    if (!sess) throw new Error('No Chromecast connected.');
    return sess;
  }

  function requestBaseSession() {
    const req = new chrome.cast.SessionRequest(DMR);
    return new Promise((resolve, reject) => {
      chrome.cast.requestSession(resolve, async (e) => {
        if (e && e.code === 'api_not_initialized') {
          // the site loaded the SDK but never initialized it
          try {
            const cfg = new chrome.cast.ApiConfig(req, (s) => { attachBase(s, false); emit(); }, noop, chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED);
            await new Promise((res, rej) => chrome.cast.initialize(cfg, res, rej));
            chrome.cast.requestSession(resolve, reject, req);
          } catch (err) { reject(err); }
        } else reject(e);
      }, req);
    });
  }

  // ---- queue ---------------------------------------------------------------
  function toQueueItem(ep, startTime) {
    const info = new chrome.cast.media.MediaInfo(ep.url, ep.mime);
    info.contentUrl = ep.url;
    info.streamType = chrome.cast.media.StreamType.BUFFERED;
    info.customData = { id: ep.id, f: ep.file };
    let md;
    if (ep.kind === 'audio') {
      md = new chrome.cast.media.MusicTrackMediaMetadata();
      md.albumName = ep.show;
      if (ep.creator) md.artist = ep.creator;
    } else {
      md = new chrome.cast.media.GenericMediaMetadata();
      md.subtitle = ep.show;
    }
    md.title = ep.title;
    if (ep.image) md.images = [new chrome.cast.Image(ep.image)];
    info.metadata = md;
    if (ep.duration) info.duration = ep.duration;
    const item = new chrome.cast.media.QueueItem(info);
    item.autoplay = true;
    item.preloadTime = 20;
    if (startTime > 0) item.startTime = startTime;
    return item;
  }

  // Split episodes into messages that stay well under the Cast 64KB limit.
  function chunks(list, first) {
    const out = [];
    let cur = [], bytes = 0;
    list.forEach((ep, i) => {
      const size = JSON.stringify(ep).length + 400;
      if (cur.length && (bytes + size > MAX_CHUNK_BYTES || (first && out.length === 0 && cur.length >= 25))) {
        out.push(cur); cur = []; bytes = 0;
      }
      cur.push(ep); bytes += size;
    });
    if (cur.length) out.push(cur);
    return out;
  }

  // `after` = the chosen episode and everything following it; `before` = everything earlier.
  // The first chunk starts playing immediately; the rest is streamed into the queue behind it.
  async function loadQueue({ after, before, startTime, repeat }, retried) {
    const token = ++loadToken;
    loading = true;
    emit();
    try {
      const s = await ensureSession();
      const [first, ...rest] = chunks(after, true);
      const req = new chrome.cast.media.QueueLoadRequest(first.map((ep, i) => toQueueItem(ep, i === 0 ? startTime : 0)));
      req.startIndex = 0;
      req.repeatMode = repeat ? chrome.cast.media.RepeatMode.ALL : chrome.cast.media.RepeatMode.OFF;
      let m;
      try {
        m = await call(s, 'queueLoad', req);
      } catch (e) {
        if (sessFromSite && !retried) {
          // the site's receiver app refused our media; start our own receiver instead
          avoidSiteSession = true;
          sess = null; sessFromSite = false;
          return loadQueue({ after, before, startTime, repeat }, true);
        }
        throw e;
      }
      if (token !== loadToken) return;
      attachMedia(m);
      queueUrls = first.map((e) => e.url);
      const anchorId = m.items && m.items.length ? m.items[0].itemId : m.currentItemId;
      loading = false;
      emit();
      post('loaded', { url: after[0].url });

      for (const part of rest) {
        await call(m, 'queueInsertItems', new chrome.cast.media.QueueInsertItemsRequest(part.map((e) => toQueueItem(e, 0))));
        if (token !== loadToken) return;
        queueUrls = queueUrls.concat(part.map((e) => e.url));
      }
      if (anchorId != null) {
        let inserted = [];
        for (const part of chunks(before, false)) {
          const req2 = new chrome.cast.media.QueueInsertItemsRequest(part.map((e) => toQueueItem(e, 0)));
          req2.insertBefore = anchorId;
          await call(m, 'queueInsertItems', req2);
          if (token !== loadToken) return;
          inserted = inserted.concat(part.map((e) => e.url));
          queueUrls = inserted.concat(after.map((e) => e.url));
        }
      }
    } catch (e) {
      if (token !== loadToken) return;
      post('error', { message: isCancel(e) ? null : 'Cast failed: ' + errMsg(e), cancelled: isCancel(e) });
    } finally {
      if (token === loadToken) { loading = false; emit(); }
    }
  }

  // Jump within the loaded queue if we can find the item; otherwise tell the panel to reload.
  async function jump(url) {
    if (!media) return post('jumpMiss', { url });
    let itemId = null;
    const items = media.items || [];
    const hit = items.find((it) => it.media && (it.media.contentId === url || it.media.contentUrl === url));
    if (hit) itemId = hit.itemId;
    else if (items.length && items.length === queueUrls.length) {
      const idx = queueUrls.indexOf(url);
      if (idx >= 0) itemId = items[idx].itemId;
    }
    if (itemId == null) return post('jumpMiss', { url });
    try { await call(media, 'queueJumpToItem', itemId); } catch (_) { post('jumpMiss', { url }); }
  }

  // ---- site player assist ------------------------------------------------------
  // Start the site's own player on a freshly opened episode page. Players that are attached to a
  // Cast session send the new episode to the TV themselves when they start playing.
  function visible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4 && getComputedStyle(el).visibility !== 'hidden';
  }

  function sitePlay() {
    const tried = [];
    safe(() => { if (typeof window.jwplayer === 'function') { const p = window.jwplayer(); if (p && p.play) { p.play(); tried.push('jwplayer'); } } });
    safe(() => {
      if (window.videojs && videojs.getPlayers) {
        for (const p of Object.values(videojs.getPlayers())) if (p && p.play) { p.play(); tried.push('video.js'); }
      }
    });
    safe(() => { for (const el of document.querySelectorAll('.plyr')) if (el.plyr && el.plyr.play) { el.plyr.play(); tried.push('plyr'); } });
    if (!tried.length) {
      const selectors = [
        '.vjs-big-play-button', '.jw-icon-display', '.jw-display-icon-container', '.plyr__control--overlaid',
        '.ytp-large-play-button', 'button[aria-label="Play" i]', 'button[aria-label^="Play " i]', 'button[title="Play" i]',
        '[data-testid*="play" i]', '.play-button', '.btn-play', 'button.play',
      ];
      for (const sel of selectors) {
        const el = [...document.querySelectorAll(sel)].find(visible);
        if (el) { el.click(); tried.push(sel); break; }
      }
    }
    if (!tried.length) {
      const v = document.querySelector('video, audio');
      if (v) { v.play().catch(noop); tried.push('media.play()'); }
    }
    return tried;
  }

  // ---- commands --------------------------------------------------------------
  async function handle(msg) {
    const RM = window.chrome && chrome.cast && chrome.cast.media;
    switch (msg.cmd) {
      case 'init': return init(!!msg.own);
      case 'connect': // opens Chrome's cast picker; with a live session it offers switch/stop
        if (sdk !== 'ready') return emit();
        try {
          if (mode === 'own') { await ctx.requestSession(); attachCaf(ctx.getCurrentSession()); }
          else if (!sess) attachBase(await requestBaseSession(), false);
        } catch (e) { post('error', { message: isCancel(e) ? null : errMsg(e), cancelled: isCancel(e) }); }
        return emit();
      case 'disconnect':
        if (mode === 'own' && ctx) ctx.endCurrentSession(!!msg.stop);
        else if (sess) {
          const s = sess;
          sess = null; sessFromSite = false; attachMedia(null);
          (msg.stop ? s.stop : s.leave).call(s, noop, noop);
        }
        return emit();
      case 'load': return loadQueue(msg);
      case 'jump': return jump(msg.url);
      case 'next':
      case 'prev':
        if (!media) return post('navMiss', { dir: msg.cmd === 'next' ? 1 : -1 });
        return call(media, msg.cmd === 'next' ? 'queueNext' : 'queuePrev')
          .catch(() => post('navMiss', { dir: msg.cmd === 'next' ? 1 : -1 }));
      case 'toggle':
      case 'play':
      case 'pause': {
        if (!media) return;
        const paused = media.playerState === RM.PlayerState.PAUSED;
        const want = msg.cmd === 'toggle' ? (paused ? 'play' : 'pause') : msg.cmd;
        return call(media, want, null).then(emit, noop);
      }
      case 'seek': {
        if (!media) return;
        const r = new RM.SeekRequest();
        r.currentTime = Math.max(0, msg.delta != null ? media.getEstimatedTime() + msg.delta : msg.time);
        return call(media, 'seek', r).then(emit, noop);
      }
      case 'volume': {
        const level = Math.min(1, Math.max(0, msg.level));
        if (cafSession) cafSession.setVolume(level);
        else if (sess) sess.setReceiverVolumeLevel(level, emit, noop);
        return;
      }
      case 'mute':
        if (cafSession) cafSession.setMute(!!msg.muted);
        else if (sess) sess.setReceiverMuted(!!msg.muted, emit, noop);
        return;
      case 'repeat':
        if (media) return call(media, 'queueSetRepeatMode', msg.on ? RM.RepeatMode.ALL : RM.RepeatMode.OFF).then(emit, noop);
        return;
      case 'sitePlay': return post('sitePlayed', { tried: sitePlay() });
    }
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data) return;
    if (ev.data[CMD] === true) handle(ev.data).catch((e) => post('error', { message: errMsg(e) }));
  });

  // ---- public API: window.ArchiveCast --------------------------------------------
  const waiting = new Map();
  let seq = 0;
  let publicState = null;

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data) return;
    const d = ev.data;
    if (d[API_RES] === true && waiting.has(d.id)) {
      const w = waiting.get(d.id);
      waiting.delete(d.id);
      clearTimeout(w.timer);
      if (d.ok) w.resolve(d.result);
      else w.reject(new Error(d.error || 'Archive Cast command failed'));
    } else if (d[PUB] === true) {
      publicState = d.state;
      window.dispatchEvent(new CustomEvent('archivecast:statechange', { detail: publicState }));
    }
  });

  function request(cmd, args) {
    return new Promise((resolve, reject) => {
      const id = 'ac' + (++seq) + Math.random().toString(36).slice(2, 8);
      const timer = setTimeout(() => {
        if (waiting.delete(id)) reject(new Error('Archive Cast did not answer “' + cmd + '” in time.'));
      }, 45000);
      waiting.set(id, { resolve, reject, timer });
      window.postMessage({ [API]: true, id, cmd, args: args || {} }, location.origin);
    });
  }

  const target = (t, startTime) => {
    const o = typeof t === 'number' ? { index: t } : typeof t === 'string' ? { query: t } : Object.assign({}, t);
    if (startTime != null) o.startTime = startTime;
    return o;
  };

  const ArchiveCast = Object.freeze({
    version: VERSION,
    /** Latest state pushed by the panel (synchronous; may be null until the panel boots). */
    get state() { return publicState; },
    /** Generic entry point: ArchiveCast.call('play', {index: 3}). */
    call: request,
    help: () => request('help'),
    getState: () => request('state'),
    listEpisodes: (opts) => request('episodes', opts),
    play: (t, startTime) => request('play', target(t, startTime)),
    resume: () => request('resume'),
    pause: () => request('pause'),
    toggle: () => request('toggle'),
    next: () => request('next'),
    previous: () => request('previous'),
    seek: (seconds) => request('seek', { time: seconds }),
    seekBy: (delta) => request('seek', { delta }),
    setVolume: (level) => request('volume', { level }),
    setMuted: (muted) => request('mute', { muted }),
    setLoop: (on) => request('loop', { on }),
    setQuality: (mode) => request('quality', { mode }),
    setSource: (id) => request('source', { id }),
    setAutoAdvance: (on) => request('autoAdvance', { on }),
    castMedia: (items, startIndex) => request('castMedia', { items, startIndex }),
    findMoreEpisodes: (maxPages) => request('findMore', { maxPages }),
    rescan: () => request('rescan'),
    openPanel: () => request('openPanel'),
    closePanel: () => request('closePanel'),
    connect: () => request('connect'),
    stop: (keepPlaying) => request('stop', { keepPlaying: !!keepPlaying }),
    /** Subscribe to state changes; returns an unsubscribe function. */
    onStateChange(fn) {
      const h = (e) => fn(e.detail);
      window.addEventListener('archivecast:statechange', h);
      return () => window.removeEventListener('archivecast:statechange', h);
    },
  });
  Object.defineProperty(window, 'ArchiveCast', { value: ArchiveCast, configurable: true, enumerable: false });
})();
