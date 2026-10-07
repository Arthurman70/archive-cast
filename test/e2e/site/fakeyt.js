// A fake YouTube player for the end-to-end tests: implements the parts of #movie_player's API
// that ytbridge.js uses, with a real-time clock. Like the real site, it starts playing on load
// and, if its "Autoplay" (autonav) toggle is still on when a video ends, wanders off to a
// suggested video — which Archive Cast's player must prevent.
(() => {
  const CATALOG = {
    TestVideo01: { title: 'Test Video 1', author: 'Channel A', duration: 3 },
    TestVideo02: { title: 'Test Video 2', author: 'Channel B', duration: 3 },
    TestVideo03: { title: 'Test Video 3', author: 'Channel C', duration: 3 },
    TestVideo04: { title: 'Test Video 4', author: 'Channel D', duration: 3 },
    TestVideo05: { title: 'Suggested Video', author: 'Channel E', duration: 60 },
  };
  const p = document.getElementById('movie_player');
  if (!p) return;
  const listeners = { onStateChange: [], onError: [] };
  let vid = new URLSearchParams(location.search).get('v');
  let state = -1, cur = 0, t0 = 0, vol = 100, muted = false;
  const F = window.__fakeyt = { loads: [], wandered: false };

  const dur = () => (CATALOG[vid] || { duration: 3 }).duration;
  const time = () => (state === 1 ? Math.min(dur(), cur + (performance.now() - t0) / 1000) : cur);
  const setState = (s) => { state = s; listeners.onStateChange.forEach((f) => f(s)); };
  const start = () => { t0 = performance.now(); setState(1); };

  p.getPlayerState = () => state;
  p.getCurrentTime = time;
  p.getDuration = dur;
  p.getVideoData = () => ({ video_id: vid, title: (CATALOG[vid] || {}).title, author: (CATALOG[vid] || {}).author });
  p.playVideo = () => { if (state !== 1) start(); };
  p.pauseVideo = () => { cur = time(); setState(2); };
  p.seekTo = (s) => { cur = s; t0 = performance.now(); };
  p.loadVideoById = (o) => {
    vid = typeof o === 'string' ? o : o.videoId;
    cur = (o && o.startSeconds) || 0;
    F.loads.push(vid);
    setState(-1);
    setTimeout(start, 120);
  };
  p.getVolume = () => vol;
  p.setVolume = (v) => { vol = v; };
  p.isMuted = () => muted;
  p.mute = () => { muted = true; };
  p.unMute = () => { muted = false; };
  // like the real player element, its addEventListener is the player API's
  p.addEventListener = (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); };

  const autonav = document.querySelector('.ytp-autonav-toggle-button');
  autonav.addEventListener('click', () => autonav.setAttribute('aria-checked', autonav.getAttribute('aria-checked') === 'true' ? 'false' : 'true'));

  setInterval(() => {
    if (state !== 1 || time() < dur()) return;
    cur = dur();
    setState(0);
    if (autonav.getAttribute('aria-checked') === 'true') {
      setTimeout(() => { if (state === 0) { F.wandered = true; location.href = '/watch?v=TestVideo05'; } }, 1500);
    }
  }, 100);

  setTimeout(start, 300); // YouTube autoplays the video in the URL
})();
