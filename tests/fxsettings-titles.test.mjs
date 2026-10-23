import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createFxSettings, fxSettingsView, withFxSetting } from '../fxsettings.mjs';

const entry = (rows) => rows.find((s) => s.key === 'session_titles');
test('automatic titles are opt-in without changing upstream defaults or existing values', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'fox-titles-')), 'settings.json');
  const fx = createFxSettings(file);
  assert.equal(entry(await fx.list()).value, false);
  assert.equal(entry(await fx.list()).applied, false);
  assert.equal(entry(await fx.list()).introduced, '2026-10-23');
  assert.match(entry(await fx.list()).documentation, /^https:\/\/fx.sh\//);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  const original = { unknown: { keep: [1] }, prompt_history: { enabled: true }, workspaces: { '/project': { session_titles: true } } };
  await writeFile(file, JSON.stringify(original));
  await chmod(file, 0o640);
  const before = await readFile(file, 'utf8');
  await fx.list();
  assert.equal(await readFile(file, 'utf8'), before);
  for (const value of [true, false]) {
    const row = entry(await fx.set('session_titles', value));
    assert.equal(row.value, value);
    assert.equal(row.applied, true);
    assert.equal((await stat(file)).mode & 0o777, 0o640);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { ...original, session_titles: value });
  }
  const saved = await readFile(file, 'utf8');
  for (const invalid of ['false', 0, 1, {}, []]) await assert.rejects(fx.set('session_titles', invalid), { status: 400 });
  assert.equal(await readFile(file, 'utf8'), saved);
  await fx.set('session_titles', null);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), original);
  for (const value of [true, false]) {
    await writeFile(file, JSON.stringify({ ...original, session_titles: value }));
    assert.equal(entry(await fx.list()).value, value);
    assert.equal(entry(await fx.list()).applied, true);
  }
  assert.throws(() => withFxSetting({}, 'session_titles.nested', true), /does not manage/);
});

test('title draft, application and browser-local badge are independent', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const source = app.slice(app.indexOf("// fx's own settings (see fxsettings.mjs)."), app.indexOf('// Tools (MCP'));
  const storage = new Map();
  let click, saved = {}, writes = [];
  const panel = { innerHTML: '', addEventListener: (_, fn) => { click = fn; } };
  const context = { $: (s) => s === '#settings-fx' ? panel : { textContent: '' }, esc: String,
    localStorage: { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    fetch: async (_, opts) => {
      if (opts) { const { key, value } = JSON.parse(opts.body); writes.push(value); saved = withFxSetting(saved, key, value); }
      return { ok: true, json: async () => fxSettingsView(saved) };
    } };
  runInNewContext(source, context);
  const html = () => runInNewContext(`fxSettingRow(${JSON.stringify(entry(fxSettingsView(saved)))})`, context);
  await runInNewContext('loadFxSettings()', context);
  assert.equal(writes.length, 0);
  assert.match(html(), /aria-checked="false"/);
  assert.doesNotMatch(html(), /type="checkbox" checked/);
  assert.match(html(), /No fox override/);
  assert.match(html(), /Upstream default: on/);
  let applied = false;
  const input = { type: 'checkbox', checked: true };
  const row = { querySelector: (s) => s === '[data-fx-input]' ? input : { classList: { contains: () => applied } } };
  const button = { dataset: { fxKey: 'session_titles', fxSave: '' }, classList: { contains: () => applied }, closest: () => row };
  const press = () => click({ target: { closest: (s) => s === '[data-fx-key]' ? button : null } });
  await press();
  assert.equal(writes.length, 0, 'editing or saving a draft never opts in');
  button.dataset = { fxKey: 'session_titles', fxApply: '' };
  await press();
  assert.deepEqual(writes, [true]);
  assert.match(html(), /type="checkbox" checked/);
  assert.match(html(), /Mark as seen/, 'activation does not dismiss badge');
  applied = true; button.disabled = false;
  input.checked = false; button.dataset = { fxKey: 'session_titles', fxSave: '' };
  await press();
  assert.deepEqual(writes, [true, false]);
  assert.match(html(), /aria-checked="true"/, 'false is still an applied override');
  const seen = { dataset: { fxSeen: 'session_titles:2026-10-23' }, closest: () => ({ remove() {} }) };
  await click({ target: { closest: (s) => s === '[data-fx-seen]' ? seen : null } });
  assert.deepEqual(saved, { session_titles: false });
  assert.equal(writes.length, 2);
  assert.doesNotMatch(html(), /Mark as seen/);
  button.disabled = false; button.dataset = { fxKey: 'session_titles', fxApply: '' };
  await press();
  assert.deepEqual(writes, [true, false, null]);
  assert.deepEqual(saved, {});
  const reloaded = { ...context };
  runInNewContext(source, reloaded);
  await runInNewContext('loadFxSettings()', reloaded);
  assert.doesNotMatch(panel.innerHTML, /data-fx-seen="session_titles:/);
  assert.match(html(), /aria-checked="false"/);
});
