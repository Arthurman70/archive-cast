// A fake Google Cast sender SDK for the end-to-end tests. Pages that load it look like a site that
// ships its own Cast player, so Archive Cast runs in "shared" mode. Playback is simulated with a
// fast clock (?speed=N, default 30x) so autoplay across episodes can be observed in seconds.
(() => {
  const SPEED = +(new URLSearchParams(location.search).get('speed') || 30);
  const DEFAULT_DURATION = 60;
  let nextItemId = 1;
  const F = window.__fake = { sessions: [], siteSession: null, rejectSiteLoads: false, log: [] };

  class MediaInfo {
    constructor(contentId, contentType) { this.contentId = contentId; this.contentType = contentType; this.metadata = null; this.customData = null; this.duration = null; }
  }

  class Media {
    constructor(session, items, startIndex, repeat) {
      this.session = session;
      this.items = items.map((it) => ({ itemId: nextItemId++, media: it.media, startTime: it.startTime || 0 }));
      this.repeatMode = repeat || 'REPEAT_OFF';
      this._u = [];
      this.idleReason = null;
      this.go(startIndex || 0, this.items[startIndex || 0].startTime);
      this.timer = setInterval(() => this.tick(), 50);
    }
    duration() { return (this.media && this.media.duration) || DEFAULT_DURATION; }
    go(i, t) {
      const it = this.items[i];
      Object.assign(this, { index: i, currentItemId: it.itemId, media: it.media, currentTime: t || 0, playerState: 'PLAYING', idleReason: null });
      this.t0 = performance.now() - this.currentTime * 1000 / SPEED;
      this.notify();
    }
    getEstimatedTime() {
      return this.playerState === 'PLAYING' ? Math.min(this.duration(), (performance.now() - this.t0) * SPEED / 1000) : this.currentTime;
    }
    tick() {
      if (this.playerState !== 'PLAYING' || this.getEstimatedTime() < this.duration()) return;
      if (this.index + 1 < this.items.length) this.go(this.index + 1, 0);
      else if (this.repeatMode === 'REPEAT_ALL') this.go(0, 0);
      else { this.currentTime = this.duration(); this.playerState = 'IDLE'; this.idleReason = 'FINISHED'; this.notify(); }
    }
    notify() { for (const f of this._u) f(true); }
    addUpdateListener(f) { this._u.push(f); }
    play(_r, ok) { this.t0 = performance.now() - this.currentTime * 1000 / SPEED; this.playerState = 'PLAYING'; this.notify(); ok && ok(); }
    pause(_r, ok) { this.currentTime = this.getEstimatedTime(); this.playerState = 'PAUSED'; this.notify(); ok && ok(); }
    seek(req, ok) { this.currentTime = req.currentTime; this.t0 = performance.now() - this.currentTime * 1000 / SPEED; this.notify(); ok && ok(); }
    queueNext(ok, err) { if (this.index + 1 < this.items.length) { this.go(this.index + 1, 0); ok && ok(); } else if (err) err({ code: 'invalid_parameter' }); }
    queuePrev(ok, err) { if (this.index > 0) { this.go(this.index - 1, 0); ok && ok(); } else if (err) err({ code: 'invalid_parameter' }); }
    queueJumpToItem(id, ok, err) {
      const i = this.items.findIndex((x) => x.itemId === id);
      if (i < 0) return err && err({ code: 'invalid_parameter' });
      F.log.push(['jump', i]);
      this.go(i, 0);
      ok && ok();
    }
    queueInsertItems(req, ok) {
      const add = req.items.map((it) => ({ itemId: nextItemId++, media: it.media }));
      if (req.insertBefore != null) {
        const at = this.items.findIndex((x) => x.itemId === req.insertBefore);
        this.items.splice(at, 0, ...add);
        if (at <= this.index) this.index += add.length;
      } else this.items.push(...add);
      F.log.push(['insert', add.length, req.insertBefore != null]);
      this.notify();
      ok && ok();
    }
    queueSetRepeatMode(m, ok) { this.repeatMode = m; this.notify(); ok && ok(); }
    stopTimer() { clearInterval(this.timer); }
  }

  class Session {
    constructor(appId) {
      this.appId = appId;
      this.receiver = { friendlyName: 'Living Room TV', volume: { level: 0.5, muted: false } };
      this.media = [];
      this._u = [];
      this._m = [];
    }
    addUpdateListener(f) { this._u.push(f); }
    addMediaListener(f) { this._m.push(f); }
    queueLoad(req, ok, err) {
      F.log.push(['queueLoad', this.appId, req.items.length]);
      if (this.appId !== 'CC1AD845' && F.rejectSiteLoads) return setTimeout(() => err({ code: 'session_error', description: 'LOAD_FAILED' }), 20);
      this.media.forEach((m) => m.stopTimer());
      const m = new Media(this, req.items, req.startIndex, req.repeatMode);
      this.media = [m];
      setTimeout(() => ok(m), 20);
    }
    // what the site's own player does when you press play while connected
    siteLoad(url, title, duration) {
      this.media.forEach((m) => m.stopTimer());
      const info = new MediaInfo(url, 'video/mp4');
      info.metadata = { title };
      info.duration = duration;
      const m = new Media(this, [{ media: info }], 0, 'REPEAT_OFF');
      this.media = [m];
      this._m.forEach((f) => f(m));
      F.log.push(['siteLoad', url]);
      return m;
    }
    setReceiverVolumeLevel(l, ok) { this.receiver.volume.level = l; this._u.forEach((f) => f(true)); ok && ok(); }
    setReceiverMuted(m, ok) { this.receiver.volume.muted = m; this._u.forEach((f) => f(true)); ok && ok(); }
    stop(ok) {
      this.media.forEach((m) => m.stopTimer());
      this.media = [];
      this._u.forEach((f) => f(false));
      if (F.siteSession === this) { F.siteSession = null; sessionStorage.removeItem('fakeSite'); }
      ok && ok();
    }
    leave(ok) { ok && ok(); }
  }

  window.chrome = window.chrome || {};
  window.chrome.cast = {
    isAvailable: true,
    Image: class { constructor(url) { this.url = url; } },
    AutoJoinPolicy: { ORIGIN_SCOPED: 'origin_scoped', TAB_AND_ORIGIN_SCOPED: 'tab_and_origin_scoped', PAGE_SCOPED: 'page_scoped' },
    SessionRequest: class { constructor(appId) { this.appId = appId; } },
    ApiConfig: class { constructor(req, sl, rl, policy) { Object.assign(this, { req, sl, rl, policy }); } },
    initialize(_cfg, ok) { ok && ok(); },
    requestSession(ok, _err, req) {
      const s = new Session(req ? req.appId : 'SITEAPP');
      F.sessions.push(s);
      F.log.push(['requestSession', s.appId]);
      setTimeout(() => ok(s), 30);
    },
    media: {
      MediaInfo,
      GenericMediaMetadata: class { constructor() { this.metadataType = 0; } },
      MusicTrackMediaMetadata: class { constructor() { this.metadataType = 3; } },
      QueueItem: class { constructor(m) { this.media = m; this.autoplay = true; } },
      QueueLoadRequest: class { constructor(items) { this.items = items; this.startIndex = 0; } },
      QueueInsertItemsRequest: class { constructor(items) { this.items = items; } },
      SeekRequest: class {},
      StreamType: { BUFFERED: 'BUFFERED' },
      RepeatMode: { OFF: 'REPEAT_OFF', ALL: 'REPEAT_ALL', SINGLE: 'REPEAT_SINGLE' },
      PlayerState: { IDLE: 'IDLE', PLAYING: 'PLAYING', PAUSED: 'PAUSED', BUFFERING: 'BUFFERING' },
      DEFAULT_MEDIA_RECEIVER_APP_ID: 'CC1AD845',
    },
  };

  // the site's own CAF context (its Cast button / player)
  const wrap = (s) => ({
    getSessionObj: () => s,
    getMediaSession: () => s.media[0] || null,
    getCastDevice: () => ({ friendlyName: s.receiver.friendlyName }),
    getApplicationMetadata: () => ({ applicationId: s.appId }),
  });
  window.cast = {
    framework: {
      CastContext: {
        getInstance: () => ({
          getCurrentSession: () => (F.siteSession ? wrap(F.siteSession) : null),
          getCastState: () => (F.siteSession ? 'CONNECTED' : 'NOT_CONNECTED'),
          setOptions() {}, addEventListener() {},
        }),
      },
      CastContextEventType: {}, SessionEventType: {},
    },
  };

  F.connectSite = () => { F.siteSession = new Session('SITEAPP'); sessionStorage.setItem('fakeSite', '1'); return F.siteSession; };
  // like CAF's auto-join: the site's session survives navigation within the origin
  if (sessionStorage.getItem('fakeSite')) F.connectSite();
})();
