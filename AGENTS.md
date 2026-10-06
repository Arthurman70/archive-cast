# Archive Cast for AI agents

Archive Cast casts a whole show to a Chromecast as one queue that plays itself. It works for archive.org shows, podcasts, and video or audio on other sites. It does not cast the tab, and once queued, playback continues even if the tab closes. This file is for agents that control it. People should start with the [README](README.md).

## The one thing you can't automate

Chrome only opens its Chromecast picker after a real click. A person, or an agent that clicks real coordinates (CDP `Input.dispatchMouseEvent`, computer use), presses **Connect** in the panel, which has `data-ac-action="connect"`, and picks the device. After that, every command below works without clicks. This includes later page loads on the same site, because the session reconnects automatically.

If a command fails with `Not connected to a Chromecast…`, ask the user to press Connect, then retry. On sites that already have their own Cast session, such as one started with the site's Cast button, `play` reuses that session and no click is needed.

## Four ways in

| You are… | Use | Reach |
|---|---|---|
| An agent that can run JS in the page (Claude in Chrome, Playwright/Puppeteer `evaluate`) | `window.ArchiveCast` | That tab only |
| An agent that reads or clicks the DOM / accessibility tree | Panel buttons with `data-ac-action` and ARIA labels, plus state attributes on `<archive-cast-ui>` | That tab only |
| A desktop AI app (Claude Code/Desktop, Cursor, any MCP client) | `mcp/server.mjs` (MCP over stdio), or its CLI for shell-only agents | Whole browser |
| Another Chrome extension | `chrome.runtime.sendMessage(ARCHIVE_CAST_ID, {cmd, args})` | Whole browser |

All four use the same command set (table below). MCP and extension messaging are **off by default**. The user enables them in Archive Cast's options page.

### 1. In-page JavaScript: `window.ArchiveCast`

It's available on archive.org, and on any site where the toolbar button has been pressed. Every method returns a Promise that resolves to the new state, or rejects with a readable message.

```js
await ArchiveCast.getState();                       // what's on the page, connection, now playing
await ArchiveCast.listEpisodes({ query: 'pilot' }); // {total, source, items:[{index, title, duration, watched, current}]}
await ArchiveCast.play(0);                          // by index… (queues everything after it, autoplay on)
await ArchiveCast.play('Mr. Big', 600);             // …or by title text, starting 10 minutes in
await ArchiveCast.next(); await ArchiveCast.previous();
await ArchiveCast.seekBy(-10); await ArchiveCast.seek(95);
await ArchiveCast.pause(); await ArchiveCast.resume();
await ArchiveCast.setVolume(0.4);
await ArchiveCast.castMedia([{ url: 'https://example.com/a.mp4', title: 'Part 1' }, { url: 'https://example.com/b.mp4' }]);
await ArchiveCast.help();                           // command list
ArchiveCast.state;                                  // latest state, synchronous (null until the panel boots)
ArchiveCast.onStateChange((s) => console.log(s.nowPlaying));
await ArchiveCast.call('play', { index: 2 });       // generic form of any command below
```

Other methods: `toggle`, `setMuted`, `setLoop`, `setQuality`, `setSource`, `setAutoAdvance`, `findMoreEpisodes`, `rescan`, `openPanel`, `closePanel`, `connect`, `stop(keepPlaying)`.

The same state also fires as a `window` event, `archivecast:statechange`, with the state in `event.detail`.

### 2. DOM and accessibility tree

The panel lives in the open shadow root of `<archive-cast-ui>`. Every control has a stable `data-ac-action`:

`open-panel`, `close-panel`, `connect`, `toggle`, `previous`, `next`, `back-10`, `forward-30`, `seek` (range), `volume` (range), `mute`, `source` (select), `quality` (select), `loop` (checkbox), `auto-advance` (checkbox), `play-all`, `resume`, `find-more`, `filter` (search box), `rescan`, `disconnect`, `stop`.

Each episode is `li.ep[role=button]`, with `aria-label="Play episode N: <title>"` and `data-i` holding its 0-based index. The playing episode has `aria-current="true"`.

State is mirrored on the host element, so you can read it without running JS:

```html
<archive-cast-ui data-ac-state="playing" data-ac-device="Living Room TV" data-ac-episode-index="4"
  data-ac-episode-title="Get Smart S01E05" data-ac-episode-count="138" data-ac-source="video" data-ac-status="ready">
```

`data-ac-state` is one of `disconnected`, `connecting`, `connected`, `playing`, `paused`, `buffering` or `finished`. In Playwright/Puppeteer, `archive-cast-ui >>> [data-ac-action="connect"]` pierces the shadow root.

### 3. MCP server

```bash
claude mcp add archive-cast -- node /path/to/archive-cast/mcp/server.mjs
```

For other clients, add `{"command": "node", "args": ["/path/to/archive-cast/mcp/server.mjs"]}` to the client's `mcpServers` config. The user then turns on **Connect to the local MCP server** in Archive Cast's options. The extension dials `ws://127.0.0.1:47811`. To use another port, set `ARCHIVE_CAST_PORT` and the same port in options.

The server needs Node 22+ and has no dependencies. Several MCP clients can run at once: the first process owns the port, and the others relay through it. Shell-only agents can use the same file as a CLI:

```bash
node mcp/server.mjs tools
node mcp/server.mjs call open_page '{"url":"https://archive.org/details/get-smart"}'
node mcp/server.mjs call play_episode '{"index":0}'
```

A typical flow is `open_page` → `list_episodes` → `play_episode`, then `get_state` and transport tools as needed. Results are JSON. Tab-scoped tools accept an optional `tabId` from `list_tabs`. By default they target the tab that is casting, else the most recent Archive Cast tab.

### 4. From another extension

```js
chrome.runtime.sendMessage(ARCHIVE_CAST_ID, { cmd: 'play', args: { index: 0 } }, (r) => {
  // r = { ok: true, result } | { ok: false, error }
});
```

The extension ID is shown in Archive Cast's options page. It's derived from the folder path for unpacked installs.

## Commands

`?` marks an optional argument. Every `tab` command also takes `tabId?` when sent through MCP or extension messaging. `browser` commands are only available through MCP and extension messaging, never from web pages.

| Command (`ArchiveCast.call` / messaging) | MCP tool | Args | Scope | What it does |
|---|---|---|---|---|
| `state` | `get_state` |  | tab | Current status of the tab: the page, the episode sources, the Chromecast connection and what is playing (index, title, time, duration, state). |
| `episodes` | `list_episodes` | `offset?`, `limit?`, `query?` | tab | List the episodes Archive Cast found on the page, in play order. Each has a 0-based index used by `play`. |
| `play` | `play_episode` | `index?`, `query?`, `startTime?` | tab | Cast an episode and queue everything after it in order, with autoplay. If the episode is already in the Chromecast queue it jumps there. Requires a connected Chromecast. Resolves once the Chromecast reports the episode. |
| `resume` | `resume` |  | tab | Unpause. If nothing is playing, continue this show from the saved spot. |
| `pause` | `pause` |  | tab | Pause the Chromecast. |
| `toggle` | `toggle_play_pause` |  | tab | Play/pause toggle. |
| `next` | `next_episode` |  | tab | Skip to the next episode. |
| `previous` | `previous_episode` |  | tab | Go back to the previous episode. |
| `seek` | `seek` | `time?`, `delta?` | tab | Seek within the current episode: absolute `time` in seconds, or relative `delta` (e.g. -10 or 30). |
| `volume` | `set_volume` | `level` | tab | Set the Chromecast volume (0.0–1.0). |
| `mute` | `set_muted` | `muted` | tab | Mute or unmute the Chromecast. |
| `loop` | `set_loop` | `on` | tab | Loop the whole queue after the last episode. |
| `quality` | `set_quality` | `mode` | tab | archive.org only: `best` sends original files, `compat` sends archive.org's h.264/MP3 encodes (use if episodes fail to play). |
| `source` | `set_source` | `id` | tab | Switch lists when a page has several: `video`/`audio` on archive.org; `feed`, `page`, `streams`, `follow`, `custom` elsewhere. See `state.sources`. |
| `castMedia` | `cast_media` | `items`, `startIndex?` | tab | Cast your own list of direct media URLs (MP4, WebM, MP3, M4A, HLS `.m3u8`, DASH `.mpd`…) as an autoplaying queue. `items` is `[{url, title?, mime?, image?}]`. |
| `findMore` | `find_more_episodes` | `maxPages?` | tab | Other sites: follow "next episode" links from this page to queue the following episodes (works when pages link their video in HTML). |
| `autoAdvance` | `set_auto_advance` | `on` | tab | Other sites with their own Cast button: when the site's cast episode ends, open the next-episode page and press play on the site's player. |
| `rescan` | `rescan_page` |  | tab | Look for media on the page again (after the site's player has loaded). |
| `openPanel` | `open_panel` |  | tab | Show the Archive Cast panel. |
| `closePanel` | `close_panel` |  | tab | Hide the panel (casting continues). |
| `connect` | `connect_chromecast` |  | tab | Open Chrome's Chromecast picker. Needs a real click (see above). From a script it just returns the state with a note. |
| `stop` | `stop_casting` | `keepPlaying?` | tab | Stop casting. With `keepPlaying: true` only this browser disconnects and the Chromecast keeps going. |
| `tabs` | `list_tabs` |  | browser | Tabs where Archive Cast is active, with what each is doing. |
| `open` | `open_page` | `url`, `active?` | browser | Open a page in Chrome, show the panel, and return its state and first 25 episodes. |
| `help` | — |  | browser | The command catalog. |
| `reloadExtension` | `reload_extension` |  | browser | Developer: reload an unpacked Archive Cast from disk after editing its files. |

The authoritative list, with JSON Schemas, is [`lib/commands.js`](lib/commands.js). MCP `tools/list` is generated from it.

## State shape (abridged)

```jsonc
{
  "site": "archive.org", "url": "https://archive.org/details/get-smart",
  "page": { "id": "get-smart", "status": "ready" },          // loading | ready | empty | error | nopage
  "source": "video", "sources": [{ "id": "video", "label": "Video", "count": 138 }],
  "episodeCount": 138,
  "cast": { "sdk": "ready", "mode": "own", "state": "CONNECTED", "device": "Living Room TV", "volume": 0.4, "muted": false },
  "nowPlaying": { "index": 4, "title": "Get Smart S01E05 …", "state": "PLAYING", "time": 312, "duration": 1523 },
  "sitePlayer": null,                                          // other sites: the site's own Cast session, if any
  "settings": { "quality": "best", "loop": false, "autoAdvance": false },
  "resume": { "index": 4, "title": "…", "time": 307 },          // saved spot for this show
  "nextPageUrl": null, "panelOpen": true
}
```

`cast.state` is Google Cast's state: `NO_DEVICES_AVAILABLE`, `NOT_CONNECTED`, `CONNECTING` or `CONNECTED`. `nowPlaying.state` is the receiver's player state: `PLAYING`, `PAUSED`, `BUFFERING` or `IDLE` (see `idleReason`: `FINISHED`, `ERROR`…).

## Recipes

- **"Play Get Smart from season 2":** `open_page {url:"https://archive.org/details/get-smart"}` → `list_episodes {query:"S02E01"}` → `play_episode {index:<that index>}`.
- **"Continue where I left off":** `get_state` gives `resume` → `resume`.
- **A podcast site:** open it → `get_state` → if `sources` has `feed`, `set_source {id:"feed"}` (oldest first) → `play_episode`.
- **A site whose own Cast player stops after each episode:** the user casts with the site's Cast button as usual → `set_auto_advance {on:true}`. Archive Cast opens each next-episode page and presses the site's play button when an episode ends. Keep that tab open: unlike the queue, this runs in the browser.
- **A one-episode-per-page site with plain video links:** `find_more_episodes` → `set_source {id:"follow"}` → `play_episode {index:0}`.
- **Something not found on the page:** have the page's player start, then `rescan_page`. Streams Chrome actually loaded show up as source `streams`.

## Limits worth knowing

- DRM-protected streams (Netflix and similar) can't be cast this way, and neither can sites whose own receiver app needs their own IDs.
- HLS/DASH streams play on the Chromecast only if their server sends CORS headers. Progressive MP4/MP3 always works.
- URLs that expire quickly, or that check cookies or the referrer, may fail on the Chromecast even though they play in the browser.
