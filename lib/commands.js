// One catalog of every Archive Cast command, shared by the in-page API (window.ArchiveCast),
// the service worker (other extensions / MCP bridge) and mcp/server.mjs (MCP tool list).
// scope "tab": runs in a tab that has the panel; "browser": runs in the service worker and
// is only reachable from outside control (MCP / other extensions), never from web pages.
(function (root) {
  'use strict';

  const int = (description, extra) => Object.assign({ type: 'integer', description }, extra);
  const num = (description, extra) => Object.assign({ type: 'number', description }, extra);
  const str = (description, extra) => Object.assign({ type: 'string', description }, extra);
  const bool = (description) => ({ type: 'boolean', description });
  const tabId = int('Browser tab to act on (from "tabs"). Defaults to the tab that is casting, else the active tab.');

  const COMMANDS = [
    { name: 'state', tool: 'get_state', scope: 'tab', description: 'Current status of the tab: the page, the episode sources, the Chromecast connection and what is playing (index, title, time, duration, state).', args: {} },
    { name: 'episodes', tool: 'list_episodes', scope: 'tab', description: 'List the episodes Archive Cast found on the page, in play order. Each has a 0-based index used by "play".', args: {
      offset: int('First index to return (default 0).', { minimum: 0 }),
      limit: int('How many to return (default 50, max 500).', { minimum: 1, maximum: 500 }),
      query: str('Only episodes whose title or file name contains this text (case-insensitive).'),
    } },
    { name: 'play', tool: 'play_episode', scope: 'tab', description: 'Cast an episode and queue everything after it in order, with autoplay. If the episode is already in the Chromecast queue it jumps there. Requires a connected Chromecast (see "connect"). Resolves once the Chromecast reports the episode.', args: {
      index: int('0-based episode index from "episodes".', { minimum: 0 }),
      query: str('Play the first episode whose title contains this text.'),
      startTime: num('Start this many seconds into the episode.', { minimum: 0 }),
    } },
    { name: 'resume', tool: 'resume', scope: 'tab', description: 'Unpause. If nothing is playing, continue this show from the saved spot.', args: {} },
    { name: 'pause', tool: 'pause', scope: 'tab', description: 'Pause the Chromecast.', args: {} },
    { name: 'toggle', tool: 'toggle_play_pause', scope: 'tab', description: 'Play/pause toggle.', args: {} },
    { name: 'next', tool: 'next_episode', scope: 'tab', description: 'Skip to the next episode.', args: {} },
    { name: 'previous', tool: 'previous_episode', scope: 'tab', description: 'Go back to the previous episode.', args: {} },
    { name: 'seek', tool: 'seek', scope: 'tab', description: 'Seek within the current episode. Give "time" (absolute seconds) or "delta" (relative, e.g. -10 or 30).', args: {
      time: num('Absolute position in seconds.', { minimum: 0 }),
      delta: num('Relative jump in seconds (negative = back).'),
    } },
    { name: 'volume', tool: 'set_volume', scope: 'tab', description: 'Set the Chromecast volume.', args: { level: num('0.0 – 1.0', { minimum: 0, maximum: 1 }) }, required: ['level'] },
    { name: 'mute', tool: 'set_muted', scope: 'tab', description: 'Mute or unmute the Chromecast.', args: { muted: bool('true to mute') }, required: ['muted'] },
    { name: 'loop', tool: 'set_loop', scope: 'tab', description: 'Loop the whole queue after the last episode.', args: { on: bool('true to loop') }, required: ['on'] },
    { name: 'quality', tool: 'set_quality', scope: 'tab', description: 'archive.org only: "best" sends original files, "compat" sends archive.org\'s h.264/MP3 encodes (use if episodes fail to play).', args: { mode: str('best | compat', { enum: ['best', 'compat'] }) }, required: ['mode'] },
    { name: 'source', tool: 'set_source', scope: 'tab', description: 'Switch which list is shown/played when a page has several (e.g. "video"/"audio" on archive.org; "feed", "page", "streams", "follow" on other sites). See state.sources.', args: { id: str('Source id from state.sources') }, required: ['id'] },
    { name: 'castMedia', tool: 'cast_media', scope: 'tab', description: 'Cast your own list of direct media URLs (MP4, WebM, MP3, M4A, HLS .m3u8, DASH .mpd …) as an autoplaying queue.', args: {
      items: { type: 'array', description: 'Media to play in order.', items: { type: 'object', properties: {
        url: str('Direct media URL'), title: str('Title shown on the TV'), mime: str('Optional MIME type'), image: str('Optional artwork URL'),
      }, required: ['url'] } },
      startIndex: int('Which item to start with (default 0).', { minimum: 0 }),
    }, required: ['items'] },
    { name: 'findMore', tool: 'find_more_episodes', scope: 'tab', description: 'Other sites: follow "next episode" links from this page to build a queue of the following episodes (works when pages link their video files in HTML).', args: { maxPages: int('How many pages to follow (default 25).', { minimum: 1, maximum: 100 }) } },
    { name: 'autoAdvance', tool: 'set_auto_advance', scope: 'tab', description: 'Other sites with their own Cast button: when the site\'s cast episode ends, open the next-episode page and press play on the site\'s player.', args: { on: bool('true to enable') }, required: ['on'] },
    { name: 'rescan', tool: 'rescan_page', scope: 'tab', description: 'Look for media on the page again (use after the site\'s player has loaded).', args: {} },
    { name: 'openPanel', tool: 'open_panel', scope: 'tab', description: 'Show the Archive Cast panel.', args: {} },
    { name: 'closePanel', tool: 'close_panel', scope: 'tab', description: 'Hide the panel (casting continues).', args: {} },
    { name: 'connect', tool: 'connect_chromecast', scope: 'tab', description: 'Open Chrome\'s Chromecast picker. Chrome only opens it from a real click, so a scripted call just returns the state with a note. A person, or an agent that can click, presses "Connect" in the panel instead. After that, every other command works without clicks.', args: {} },
    { name: 'stop', tool: 'stop_casting', scope: 'tab', description: 'Stop casting. With keepPlaying=true only this browser disconnects and the Chromecast keeps going.', args: { keepPlaying: bool('Disconnect but let the Chromecast keep playing') } },
    { name: 'youtubeQueue', tool: 'youtube_get_queue', scope: 'browser', description: 'The YouTube queue and what the YouTube player is doing (current video, state, time, target computer/tv).', args: {} },
    { name: 'youtubeAdd', tool: 'youtube_add_to_queue', scope: 'browser', description: 'Add YouTube videos to the queue (IDs or any youtube.com / youtu.be URL). Titles are looked up automatically. Adding a video that is already queued moves it.', args: {
      videos: { type: 'array', items: { type: 'string' }, description: 'Video IDs or URLs, in order.' },
      next: bool('Insert right after the video that is playing instead of at the end.'),
    }, required: ['videos'] },
    { name: 'youtubeRemove', tool: 'youtube_remove_from_queue', scope: 'browser', description: 'Remove one video from the YouTube queue.', args: { index: int('0-based position in the queue.', { minimum: 0 }) }, required: ['index'] },
    { name: 'youtubeMove', tool: 'youtube_move_in_queue', scope: 'browser', description: 'Move a video within the YouTube queue.', args: { from: int('Current position.', { minimum: 0 }), to: int('New position.', { minimum: 0 }) }, required: ['from', 'to'] },
    { name: 'youtubeClear', tool: 'youtube_clear_queue', scope: 'browser', description: 'Empty the YouTube queue.', args: {} },
    { name: 'youtubePlay', tool: 'youtube_play', scope: 'browser', description: 'Play YouTube videos in order with autoplay in Archive Cast\'s player tab. Without "videos" it plays the queue from "index". target "computer" plays in a normal tab; "tv" opens the player full-bleed in its own window so the browser can cast that tab to a Chromecast (the user picks Cast → Cast tab once). The TV\'s YouTube app is not used.', args: {
      videos: { type: 'array', items: { type: 'string' }, description: 'Optional: play these (IDs or URLs) instead of the queue.' },
      index: int('Where to start (0-based, default 0).', { minimum: 0 }),
      startTime: num('Seconds into the first video.', { minimum: 0 }),
      target: str('computer | tv', { enum: ['computer', 'tv'] }),
    } },
    { name: 'youtubeControl', tool: 'youtube_control', scope: 'browser', description: 'Control the YouTube player: pause, resume, toggle, next, previous, jump {index}, seek {time|delta}, volume {level}, mute {muted}, target {target: computer|tv}, show (focus the player), stop (close the player).', args: {
      action: str('What to do.', { enum: ['pause', 'resume', 'toggle', 'next', 'previous', 'jump', 'seek', 'volume', 'mute', 'target', 'show', 'stop'] }),
      index: int('For jump: position in the playing list.', { minimum: 0 }),
      time: num('For seek: absolute seconds.', { minimum: 0 }),
      delta: num('For seek: relative seconds.'),
      level: num('For volume: 0.0 – 1.0.', { minimum: 0, maximum: 1 }),
      muted: bool('For mute.'),
      target: str('For target: computer | tv.', { enum: ['computer', 'tv'] }),
    }, required: ['action'] },
    { name: 'tabs', tool: 'list_tabs', scope: 'browser', description: 'List browser tabs where Archive Cast is active, with what each is doing.', args: {} },
    { name: 'open', tool: 'open_page', scope: 'browser', description: 'Open a page (e.g. an archive.org show like https://archive.org/details/get-smart) in Chrome, show the panel and return its state and first episodes.', args: {
      url: str('http(s) URL to open'), active: bool('Focus the tab (default true)'),
    }, required: ['url'] },
    { name: 'help', tool: null, scope: 'browser', description: 'This command catalog.', args: {} },
    { name: 'reloadExtension', tool: 'reload_extension', scope: 'browser', description: 'Developer: reload an unpacked Archive Cast from disk after editing its files.', args: {} },
  ];

  for (const c of COMMANDS) if (c.scope === 'tab') c.args.tabId = tabId;

  /** JSON Schema for a command's arguments (used for MCP tool definitions). */
  function schemaFor(cmd) {
    return { type: 'object', properties: cmd.args, required: cmd.required || [], additionalProperties: false };
  }

  root.ArchiveCastCommands = { COMMANDS, schemaFor, byName: Object.fromEntries(COMMANDS.map((c) => [c.name, c])),
    byTool: Object.fromEntries(COMMANDS.filter((c) => c.tool).map((c) => [c.tool, c])) };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.ArchiveCastCommands;
})(typeof globalThis !== 'undefined' ? globalThis : this);
