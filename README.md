# Archive Cast

**Cast whole shows to your Chromecast, in order and with autoplay, without casting your screen.**

Archive Cast is an extension for Chrome and Brave. It sends a show's episode files straight to your Chromecast as a queue. The TV fetches and plays them on its own, so your computer stays free and the next episode starts by itself. It works on the [Internet Archive](https://archive.org), on podcast sites, and on other sites with plain video or audio. It can also make a site's own Cast player continue to the next episode when it normally stops after one. On **YouTube** it replaces YouTube's queue with its own: videos play in order on your computer, or full-screen in a window your browser casts to the TV, without the TV's YouTube app.

<p align="center"><img src="docs/panel.png" width="380" alt="The Archive Cast panel: now playing, skip and seek controls, and the episode list"></p>

## What it does

- **archive.org shows, radio series and collections:** reads the item's file list and orders episodes naturally (S01E02 before S01E10, seasons grouped). It picks a file your Chromecast can play: the original MP4 when possible, otherwise archive.org's h.264/MP3 encodes. If an episode won't play, it switches to the compatible encode by itself.
- **Real autoplay:** the whole season goes to the Chromecast as one queue that plays itself. Close the tab or lock the computer and it keeps going.
- **Skip around:** previous/next, ±10/30 s, a seek bar, volume, jump to any episode, search the list, loop.
- **Remembers your place:** a Resume button and ✓ marks on episodes you've finished.
- **Other sites:** press the toolbar button on any page. Archive Cast offers what it can find:
  - **Podcast feed:** the site's RSS feed, played oldest first.
  - **On this page:** `<video>`/`<audio>` players and links to media files.
  - **Detected streams:** MP4, MP3, HLS and DASH that Chrome actually loads, which catches script-built players. The toolbar badge counts them.
  - **Find next episodes:** follows "Next episode" links to queue the following pages.
  - **Auto-advance:** for sites with their own Cast button that stop after each episode. When the episode ends, Archive Cast opens the next episode page and presses play on the site's player.
- **YouTube queue:** queue videos from any YouTube page with the + on each video in the panel, **Add all to queue**, or right-click any YouTube link → *Add to Archive Cast queue*. Then play the queue:
  - **This computer:** the videos play back to back, about half a second apart. Start from a video page and they play right in that tab; otherwise a player tab opens. YouTube's own "autoplay a suggestion" is switched off there, and you control it from the panel on any YouTube tab. If you click a different video in the player yourself, it's left alone, and your queue picks up again when it ends.
  - **On TV:** the player opens full-screen in its own window, with no YouTube interface, and your browser casts that tab (**Cast → Cast tab**, once). The TV's YouTube app is never used. The TV shows exactly what your browser plays, so Brave's Shields keep ads off the TV picture too.
- **Brave:** works the same as in Chrome. If Brave's Google Cast support ("Media Router") is off, which is Brave's default, the panel tells you and opens the right settings page.
- **Scriptable by AI agents:** the same commands are available as an in-page JS API (`window.ArchiveCast`), an accessible panel with stable `data-ac-action` hooks, an **MCP server** for Claude Code/Desktop, Cursor and other clients, and messaging from other extensions. See [AGENTS.md](AGENTS.md).

<details>
<summary>On YouTube</summary>
<p><img src="docs/youtube.png" width="380" alt="The panel on YouTube showing the YouTube queue, with + and ✓ buttons for adding and removing videos"></p>
</details>

<details>
<summary>On archive.org</summary>
<p><img src="docs/archive.png" width="560" alt="The panel on an archive.org TV series page, grouped by season (captured in a test browser with no Chromecast on its network)"></p>
</details>

## Install

Archive Cast isn't in the Chrome Web Store, so you load it as an unpacked extension (about a minute):

1. Download this repo: **Code → Download ZIP** and unzip it, or `git clone https://github.com/Arthurman70/archive-cast`.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `archive-cast` folder (the one with `manifest.json`).
4. Optional: pin **Archive Cast** from the puzzle-piece menu.

It works in Chrome 120+ on Windows, macOS, Linux and ChromeOS. Chromecast support is built into Chrome, so you only need a Chromecast or Google TV on the same network. To update, pull or re-download, then press the reload icon on the extension's card.

**Brave:** the same steps work at `brave://extensions`. Brave also ships with casting switched off. Open **Settings → Extensions**, turn on **Media Router**, and restart Brave. The panel reminds you if it's off.

## Use it

**archive.org:** open a show, e.g. [Get Smart](https://archive.org/details/get-smart), [Green Acres](https://archive.org/details/GreenAcresCompleteSeries) or the [Gunsmoke radio show](https://archive.org/details/OTRR_Gunsmoke_Singles). Click the round cast button at the bottom right, then click an episode. Chrome asks which Chromecast to use, and that episode plus everything after it goes to the TV.

**Other sites:** press the Archive Cast toolbar button on the page. The site is remembered, so the cast button shows up there by itself next time. Use the list menu to switch between *Podcast feed*, *On this page*, *Detected streams* and *Next pages*.

- **Nothing listed?** Start the site's player for a moment so Chrome loads the video, then press **Rescan**.
- **The site already has a Cast button that stops after every episode?** Cast with the site's button as usual and tick **Auto-advance** in the panel. Keep that tab open.
- **"This site's security policy blocks Google Cast"?** Click **Allow**. Archive Cast relaxes the policy for that one tab only, until it closes, and reloads the page.

**YouTube:** open the panel on any YouTube page.
- Click a video to play it and everything after it, or use **+** / **Add all to queue** to build your queue. You can also right-click any YouTube link → *Add to Archive Cast queue*.
- The pill at the top switches between **This computer** and **On TV**. With *On TV*, the player opens in its own full-screen window. From the browser's menu, choose **Cast… → Sources → Cast tab** and pick your TV. In Brave, the menu is ≡ → *Cast…*.
- Keep using the browser normally while the cast runs; the player window can sit behind your other windows.

The panel's controls work from any page of the site. **Disconnect, keep playing** leaves the Chromecast running, and the toolbar button takes you back to the show later.

### What can't be cast

- DRM-protected services (Netflix, Disney+, …), and sites whose Chromecast app only accepts their own content IDs.
- HLS/DASH streams on servers that don't send CORS headers: the Chromecast refuses them. Plain MP4/MP3 always works.
- Links that expire within minutes, or that need your cookies or a specific referrer.
- YouTube videos as a direct stream: YouTube only serves its videos to its own player. Archive Cast therefore casts YouTube as a tab, with the browser doing the rendering. Expect up to roughly 1080p at 30 fps, and your computer does a little work while it casts.

## Control it with AI

Everything in the panel is also a command. Full reference: **[AGENTS.md](AGENTS.md)**.

**In the page** (Claude in Chrome, Playwright, the DevTools console):

```js
await ArchiveCast.listEpisodes({ query: 'S02' });
await ArchiveCast.play(14);             // queue episode 15 and everything after it
await ArchiveCast.seekBy(-30);
```

**MCP** (Claude Code, Claude Desktop, Cursor, …). It needs Node 22+ and has no dependencies:

```bash
claude mcp add archive-cast -- node /path/to/archive-cast/mcp/server.mjs
```

Or add it to your client's config:

```json
{ "mcpServers": { "archive-cast": { "command": "node", "args": ["/path/to/archive-cast/mcp/server.mjs"] } } }
```

Then open Archive Cast's options (right-click the toolbar icon → **Options**) and turn on **Connect to the local MCP server**. You can now say things like *"put on Get Smart season 2 on the TV"* or *"skip back 30 seconds"*. For shell-only agents, the same file works as a CLI: `node mcp/server.mjs call play_episode '{"index":0}'`.

**Other extensions:** turn on *Allow other extensions* in options, then `chrome.runtime.sendMessage(ARCHIVE_CAST_ID, {cmd: 'play', args: {index: 0}})`.

One step stays human: Chrome only opens its Chromecast picker after a real click. Someone presses **Connect** once, and after that agents can do everything else.

## Privacy and permissions

Archive Cast has no servers, analytics or accounts. Media goes from the website straight to your Chromecast.

| Permission | Why |
|---|---|
| Read and change data on all websites | Show the panel on the sites you choose, read their feeds and next-episode pages, and notice media files Chrome loads (the badge count). Detected URLs stay in memory for that tab and are cleared when it navigates or closes. |
| `webRequest` | The stream detector: it reads response headers only and never blocks or changes anything. |
| `declarativeNetRequestWithHostAccess` | Only when you click **Allow** on a site that blocks Google Cast: removes that page's Content-Security-Policy header for that one tab, until it closes. |
| `scripting`, `storage`, `alarms` | Show the panel; remember settings, progress, your YouTube queue and sites; reconnect to the MCP server if you enabled it. |
| `contextMenus` | The right-click *Add to Archive Cast queue* item on YouTube links. |

Your progress, watched marks and settings live in `chrome.storage` in your browser. MCP and other-extension control are off until you turn them on. The MCP bridge only listens on `127.0.0.1` and refuses connections from web pages.

## How it works

- **The Cast SDK runs in the page.** It's injected with the page's own CSP nonce, so sites like archive.org that only allow nonce'd scripts still load it. Sites that ship their own Cast player get *shared mode*: Archive Cast leaves their Cast setup alone and runs its own session alongside, or reuses theirs.
- **The Chromecast does the autoplay.** Episodes are sent to Google's Default Media Receiver as one queue in batches under Cast's 64 KB message limit, so autoplay doesn't depend on the browser. Auto-advance for a site's own player is the exception: that runs in the tab.
- **YouTube runs in a player tab.** `ytbridge.js` drives YouTube's own player element in one dedicated tab: it loads the next video, seeks, sets the volume, and keeps YouTube's suggestion autoplay away. The service worker owns the queue and tells that tab what to play. TV mode is CSS that makes the player fill its window, so casting the tab sends just the video. youtube.com enforces Trusted Types, so nothing in the page world touches HTML.

```
lib/episodes.js   archive.org metadata → ordered, castable episodes
lib/generic.js    any page: media elements, links, JSON-LD/OpenGraph, feeds, next links, network responses
lib/commands.js   the command catalog shared by the JS API, extension messaging and MCP
lib/youtube.js    YouTube links → video IDs; the current video, playlist and other videos on a YouTube page
castbridge.js     page world: Google Cast SDK, sessions, the receiver queue, window.ArchiveCast
ytbridge.js       page world on youtube.com: drives YouTube's player in the player tab
content.js        the panel, site adapters, progress, and the command dispatcher
background.js     toolbar button, injection, stream detector, YouTube queue + player tab, routing, MCP bridge client
mcp/server.mjs    MCP server (stdio) + local WebSocket hub + CLI
```

## Development

```bash
npm test                            # unit tests: episode ordering on real archive.org metadata, stream rules, MCP server
cd test/e2e && npm install && npm test
```

The end-to-end suite loads the extension into a throwaway browser profile with Puppeteer.
- **Fake Cast site:** a local test site uses a fake Cast SDK, so queues, skipping, autoplay, the stream detector, next-page following, site-player auto-advance and the MCP bridge are all exercised without a TV.
- **Fake youtube.com:** served over local HTTPS, with a fake player. It covers the YouTube queue, the player tab, TV mode, and keeping YouTube's suggestions out. It needs `openssl` once, to make a throwaway certificate.
- **Live archive.org** is checked on every run.
- **Options:**
  - `CHROME=/path/to/brave` runs everything in Brave.
  - `LIVE_YOUTUBE=1` adds a smoke test against the real youtube.com.
  - `HEADFUL=1` lets you watch it run.

When you edit the extension, reload it from `chrome://extensions`, or call the `reload_extension` tool if the MCP bridge is on.

## License

[MIT](LICENSE)
