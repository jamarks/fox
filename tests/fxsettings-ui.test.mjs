// fx's newer options in Settings, one control each: Default (fox writes nothing) / On / Off for a switch, a number
// saved on change (empty gives it back to fx). Opening never writes; the "new" dot goes once the section was shown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { withFxSetting, fxSettingsView } from '../fxsettings.mjs';

async function panelWith({ shown = true } = {}) {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const source = app.slice(app.indexOf("// fx's own settings (see fxsettings.mjs)."), app.indexOf('// Tools (MCP'));
  const storage = new Map(), handlers = {}, writes = [];
  let saved = {};
  const panel = { innerHTML: '', addEventListener: (type, fn) => { handlers[type] = fn; } };
  const note = { textContent: '' };
  const context = { $: (s) => s === '#settings-fx' ? panel : note, esc: String, settingsSectionShown: () => shown,
    localStorage: { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    fetch: async (_, opts) => {
      if (opts) { const { key, value } = JSON.parse(opts.body); writes.push([key, value]); saved = withFxSetting(saved, key, value); }
      return { ok: true, json: async () => fxSettingsView(saved) };
    } };
  runInNewContext(source, context);
  const row = (key) => runInNewContext(`fxSettingRow(${JSON.stringify(fxSettingsView(saved).find((s) => s.key === key))})`, context);
  const press = (key, tri, on = false) => handlers.click({ target: { closest: (s) => s === '[data-fx-key]' ? { dataset: { fxKey: key, fxTri: tri }, classList: { contains: () => on } } : null } });
  const type = (key, value, valid = true) => handlers.change({ target: { closest: () => ({ dataset: { fxNum: key }, value, reportValidity: () => valid }) } });
  return { context, panel, note, storage, writes, row, press, type, load: () => runInNewContext('loadFxSettings()', context), source };
}

test('a new fx switch is one Default / On / Off choice, and only a press writes', async () => {
  const ui = await panelWith();
  await ui.load();
  assert.deepEqual(ui.writes, [], 'opening Settings writes nothing');
  assert.match(ui.row('session_titles'), /data-fx-tri="default" class|class="on" data-fx-key="session_titles" data-fx-tri="default"/);
  assert.match(ui.row('session_titles'), /fx default: on/);
  assert.match(ui.row('session_titles'), /href="https:\/\/fx\.sh\/docs/);
  assert.doesNotMatch(ui.row('session_titles'), /Mark as seen|Apply setting|Save/);
  await ui.press('session_titles', 'off');
  assert.deepEqual(ui.writes.at(-1), ['session_titles', false]);
  assert.match(ui.row('session_titles'), /class="on" data-fx-key="session_titles" data-fx-tri="off"/);
  await ui.press('session_titles', 'on');
  assert.deepEqual(ui.writes.at(-1), ['session_titles', true]);
  await ui.press('session_titles', 'on', true);
  assert.equal(ui.writes.length, 2, 'pressing the current choice writes nothing');
  await ui.press('session_titles', 'default');
  assert.deepEqual(ui.writes.at(-1), ['session_titles', null], 'Default removes fox\'s override');
  assert.match(ui.row('session_titles'), /class="on" data-fx-key="session_titles" data-fx-tri="default"/);
});

test('a number saves on change; an invalid one never writes; empty or Default gives it back to fx', async () => {
  const ui = await panelWith();
  await ui.load();
  assert.match(ui.row('auto_compact_percent'), /value="" placeholder="fx default"/);
  assert.match(ui.row('auto_compact_percent'), /fx default: 80%/);
  assert.doesNotMatch(ui.row('auto_compact_percent'), /data-fx-tri="default"/, 'nothing to reset yet');
  await ui.type('auto_compact_percent', '81', false);
  assert.deepEqual(ui.writes, []);
  await ui.type('auto_compact_percent', '60');
  assert.deepEqual(ui.writes, [['auto_compact_percent', 60]]);
  assert.match(ui.row('auto_compact_percent'), /value="60"/);
  assert.match(ui.row('auto_compact_percent'), /data-fx-tri="default"/);
  await ui.type('auto_compact_percent', ' ');
  assert.deepEqual(ui.writes.at(-1), ['auto_compact_percent', null]);
  await ui.type('max_tool_result_bytes', '4096');
  await ui.press('max_tool_result_bytes', 'default');
  assert.deepEqual(ui.writes.slice(-2), [['max_tool_result_bytes', 4096], ['max_tool_result_bytes', null]]);
});

test('the new dot shows until the fx section has been on screen, kept in this browser only', async () => {
  const hidden = await panelWith({ shown: false });
  await hidden.load();
  assert.match(hidden.panel.innerHTML, /set-new/);
  await hidden.load();
  assert.match(hidden.panel.innerHTML, /set-new/, 'not shown yet: still new');
  const ui = await panelWith();
  await ui.load();
  assert.match(ui.panel.innerHTML, /set-new/, 'shown this time');
  await ui.load();
  assert.doesNotMatch(ui.panel.innerHTML, /set-new/, 'gone the next time');
  assert.ok(JSON.parse(ui.storage.get('fox.fxSettingsSeen')).includes('session_titles:2026-10-23'));
  assert.deepEqual(ui.writes, [], 'seeing never writes a setting');
  await ui.press('session_titles', 'off');
  await ui.press('session_titles', 'default');
  assert.doesNotMatch(ui.panel.innerHTML, /set-new/, 'changing a setting does not bring the dot back');
});
