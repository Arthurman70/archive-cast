// node --test test/  — keeps the agent docs and manifest in step with the code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../lib/commands.js');
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('AGENTS.md documents every command and MCP tool', () => {
  const doc = read('AGENTS.md');
  for (const c of C.COMMANDS) {
    assert.ok(doc.includes('`' + c.name + '`'), `command ${c.name}`);
    if (c.tool) assert.ok(doc.includes('`' + c.tool + '`'), `tool ${c.tool}`);
  }
});

test('every in-page action hook mentioned in AGENTS.md exists in the panel', () => {
  const doc = read('AGENTS.md');
  const ui = read('content.js');
  const hooks = doc.split('Every control has a stable')[1].split('Each episode')[0].match(/`([a-z0-9-]+)`/g).map((s) => s.slice(1, -1)).filter((h) => h !== 'data-ac-action');
  assert.ok(hooks.length > 15);
  for (const h of hooks) assert.ok(ui.includes(`'${h}'`) || ui.includes(`"${h}"`), `data-ac-action ${h}`);
});

test('versions agree', () => {
  const v = JSON.parse(read('manifest.json')).version;
  assert.equal(JSON.parse(read('package.json')).version, v);
  assert.match(read('castbridge.js'), new RegExp(`VERSION = '${v.replace(/\./g, '\\.')}'`));
  assert.match(read('mcp/server.mjs'), new RegExp(`VERSION = '${v.replace(/\./g, '\\.')}'`));
});

test('every file the manifest and service worker load exists', () => {
  const m = JSON.parse(read('manifest.json'));
  const files = [m.background.service_worker, m.options_ui.page, ...Object.values(m.icons), ...m.content_scripts.flatMap((c) => c.js)];
  for (const f of files) assert.doesNotThrow(() => read(f), f);
  const bg = read('background.js');
  for (const f of bg.match(/'(lib\/[a-z]+\.js|content\.js|castbridge\.js)'/g).map((s) => s.slice(1, -1))) assert.doesNotThrow(() => read(f), f);
});
