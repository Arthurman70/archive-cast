// Runs in the MAIN world on youtube.com. In the Archive Cast player tab it drives YouTube's own
// player element (#movie_player) for the panel's queue: load the next video, play/pause, seek,
// volume, and report state. youtube.com enforces Trusted Types, so this never touches HTML or
// script sinks — it only calls the player's methods and clicks its buttons.
(() => {
  'use strict';
  if (window.__archiveCastYt) return;
  window.__archiveCastYt = true;

  const CMD = 'archive-cast:yt-cmd';
  const EVT = 'archive-cast:yt-evt';
  // YouTube player states → the names the panel already uses for Cast media
  const STATE = { '-1': 'BUFFERING', 0: 'ENDED', 1: 'PLAYING', 2: 'PAUSED', 3: 'BUFFERING', 5: 'PAUSED' };

  const post = (type, data) => window.postMessage(Object.assign({ [EVT]: true, type }, data || {}), location.origin);
  const safe = (fn, fallback) => { try { return fn(); } catch (_) { return fallback; } };
  const player = () => {
    const p = document.getElementById('movie_player');
    return p && typeof p.getPlayerState === 'function' ? p : null;
  };

  let hooked = null;
  let ticker = null;
  let lastError = null;

  function snapshot() {
    const p = player();
    if (!p) return { ready: false };
    const data = safe(() => p.getVideoData(), {}) || {};
    const raw = safe(() => p.getPlayerState(), -1);
    return {
      ready: true,
      videoId: data.video_id || null,
      title: data.title || null,
      author: data.author || null,
      state: STATE[raw] || 'BUFFERING',
      time: safe(() => p.getCurrentTime(), 0),
      duration: safe(() => p.getDuration(), 0) || null,
      volume: safe(() => p.getVolume() / 100, null),
      muted: safe(() => p.isMuted(), null),
      ad: p.classList.contains('ad-showing'),
      error: lastError,
    };
  }

  function emit() { post('state', { state: snapshot() }); }

  function hook() {
    const p = player();
    if (!p || hooked === p) return;
    hooked = p;
    // YouTube's player API takes plain functions here
    safe(() => p.addEventListener('onStateChange', (code) => {
      if (code === 1) lastError = null;
      emit();
      if (code === 0) post('ended', { videoId: safe(() => p.getVideoData().video_id, null) });
    }));
    safe(() => p.addEventListener('onError', (code) => { lastError = code; post('error', { code, videoId: safe(() => p.getVideoData().video_id, null) }); }));
  }

  // YouTube's own "autoplay next suggestion" would fight our queue.
  function autonavOff() {
    const t = document.querySelector('.ytp-autonav-toggle-button[aria-checked="true"]');
    if (t) { t.click(); return true; }
    return false;
  }

  function whenReady(fn, tries = 80) {
    const p = player();
    if (p && typeof p.loadVideoById === 'function') return fn(p);
    if (tries > 0) setTimeout(() => whenReady(fn, tries - 1), 250);
    else post('error', { code: 'no-player', message: 'YouTube’s player did not load on this page.' });
  }

  function handle(msg) {
    switch (msg.cmd) {
      case 'activate':
        whenReady(() => {
          hook();
          autonavOff();
          if (!ticker) ticker = setInterval(() => { hook(); emit(); }, 1000);
          emit();
        });
        return;
      case 'load':
        return whenReady((p) => {
          hook();
          lastError = null;
          const cur = safe(() => p.getVideoData().video_id, null);
          if (cur === msg.id && !msg.force) {
            if (msg.start) p.seekTo(msg.start, true);
            p.playVideo();
          } else {
            p.loadVideoById({ videoId: msg.id, startSeconds: msg.start || 0 });
          }
          setTimeout(autonavOff, 1500);
          emit();
        });
      case 'play': return whenReady((p) => { p.playVideo(); emit(); });
      case 'pause': return whenReady((p) => { p.pauseVideo(); emit(); });
      case 'toggle': return whenReady((p) => { if (p.getPlayerState() === 1) p.pauseVideo(); else p.playVideo(); emit(); });
      case 'seek': return whenReady((p) => {
        const t = msg.delta != null ? p.getCurrentTime() + msg.delta : msg.time;
        p.seekTo(Math.max(0, t), true);
        emit();
      });
      case 'volume': return whenReady((p) => { p.unMute(); p.setVolume(Math.round(Math.max(0, Math.min(1, msg.level)) * 100)); emit(); });
      case 'mute': return whenReady((p) => { if (msg.muted) p.mute(); else p.unMute(); emit(); });
      case 'resize': window.dispatchEvent(new Event('resize')); return;
      case 'state': return emit();
    }
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data[CMD] !== true) return;
    safe(() => handle(ev.data));
  });
})();
