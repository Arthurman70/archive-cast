// Options page: outside-control toggles and the list of sites with the launcher.
const DEFAULTS = { enabled: false, port: 47811, allowExtensions: false };
const $ = (id) => document.getElementById(id);

async function config() {
  const { 'ac:bridge': b } = await chrome.storage.local.get('ac:bridge');
  return Object.assign({}, DEFAULTS, b);
}

async function save(patch) {
  const next = Object.assign(await config(), patch);
  await chrome.storage.local.set({ 'ac:bridge': next });
  render();
}

async function render() {
  const cfg = await config();
  $('version').textContent = chrome.runtime.getManifest().version;
  $('bridge').checked = cfg.enabled;
  $('port').value = cfg.port;
  $('ext').checked = cfg.allowExtensions;
  $('extId').textContent = chrome.runtime.id;
  const env = cfg.port === DEFAULTS.port ? '' : `,\n      "env": { "ARCHIVE_CAST_PORT": "${cfg.port}" }`;
  $('mcpConfig').textContent = `{
  "mcpServers": {
    "archive-cast": {
      "command": "node",
      "args": ["/path/to/archive-cast/mcp/server.mjs"]${env}
    }
  }
}`;
  const { 'ac:sites': sites = [] } = await chrome.storage.local.get('ac:sites');
  const ul = $('sites');
  ul.textContent = '';
  for (const origin of sites) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = origin;
    const rm = document.createElement('button');
    rm.textContent = 'Remove';
    rm.setAttribute('aria-label', 'Remove ' + origin);
    rm.addEventListener('click', async () => {
      await chrome.storage.local.set({ 'ac:sites': sites.filter((s) => s !== origin) });
      render();
    });
    li.append(name, rm);
    ul.append(li);
  }
  $('noSites').hidden = sites.length > 0;
  renderStatus();
}

async function renderStatus() {
  const cfg = await config();
  const { 'ac:bridgeStatus': st } = await chrome.storage.session.get('ac:bridgeStatus');
  const pill = $('bridgeStatus');
  const state = cfg.enabled ? (st && st.state) || 'connecting' : 'off';
  pill.className = 'pill ' + state;
  pill.textContent = {
    off: 'Off', connecting: 'Connecting…', connected: 'Connected to MCP server',
    waiting: 'Waiting for the MCP server to start',
  }[state] || state;
}

$('bridge').addEventListener('change', (e) => save({ enabled: e.target.checked }));
$('ext').addEventListener('change', (e) => save({ allowExtensions: e.target.checked }));
$('port').addEventListener('change', (e) => {
  const port = Math.round(+e.target.value);
  if (port >= 1024 && port <= 65535) save({ port }); else render();
});
$('copyId').addEventListener('click', () => navigator.clipboard.writeText(chrome.runtime.id));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes['ac:bridgeStatus']) renderStatus();
  if (area === 'local' && changes['ac:sites']) render();
});
render();
