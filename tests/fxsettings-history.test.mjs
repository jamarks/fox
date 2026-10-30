// Prompt history is an optional personal override; looking and dismissing New never write it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createFxSettings, fxSettingsView, withFxSetting } from '../fxsettings.mjs';
const key = 'prompt_history.enabled';
const entry = (list) => list.find((s) => s.key === key);

test('history starts unapplied without writes and round trips only its nested key', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'fox-history-')), 'settings.json');
  const fx = createFxSettings(file);
  assert.equal(entry(await fx.list()).applied, false);
  assert.equal(entry(await fx.list()).value, false);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  const original = { unknown: [1], prompt_history: { other: 'keep' }, workspaces: { '/a': { prompt_history: { enabled: true } } } };
  await writeFile(file, JSON.stringify(original));
  await chmod(file, 0o640);
  const before = await readFile(file, 'utf8');
  await fx.list();
  assert.equal(await readFile(file, 'utf8'), before);
  for (const value of [true, false]) {
    await fx.set(key, value);
    assert.equal(entry(await fx.list()).value, value);
    assert.equal(entry(await fx.list()).applied, true);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { ...original, prompt_history: { other: 'keep', enabled: value } });
    assert.equal((await stat(file)).mode & 0o777, 0o640);
  }
  for (const value of ['true', 1, {}, []]) await assert.rejects(fx.set(key, value), { status: 400 });
  await fx.set(key, null);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), original);
  for (const value of [true, false]) assert.equal(entry(fxSettingsView({ prompt_history: { enabled: value } })).value, value);
  assert.throws(() => withFxSetting({ prompt_history: 'keep' }, key, true), /nested/);
  assert.throws(() => withFxSetting({}, 'prompt_history.other', true), /does not manage/);
  assert.equal(entry(await fx.list()).introduced, '2026-10-27');
  assert.match(entry(await fx.list()).documentation, /^https:\/\/fx.sh\//);
});

test('history badge persists until explicitly seen, independent of override activation', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const source = app.slice(app.indexOf("// fx's own settings (see fxsettings.mjs)."), app.indexOf('// Tools (MCP'));
  const storage = new Map(), handlers = {}, writes = [];
  let saved = {};
  const panel = { innerHTML: '', addEventListener: (type, fn) => { handlers[type] = fn; } };
  const context = { $: (s) => s === '#settings-fx' ? panel : { textContent: '' }, esc: String, settingsSectionShown: () => true,
    localStorage: { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    fetch: async (_, opts) => {
      if (opts) { const { key, value } = JSON.parse(opts.body); writes.push([key, value]); saved = withFxSetting(saved, key, value); }
      return { ok: true, json: async () => fxSettingsView(saved) };
    } };
  const row = () => runInNewContext(`fxSettingRow(${JSON.stringify(entry(fxSettingsView({})))})`, context);
  const load = () => runInNewContext('loadFxSettings()', context);
  runInNewContext(source, context);
  await load(); await load();
  assert.deepEqual(writes, []);
  assert.match(panel.innerHTML, />New<\/span>.*Mark as seen/);
  assert.match(panel.innerHTML, /No fox override; fx defaults to on/);
  const click = async (dataset, on = false) => {
    await handlers.click({ target: { closest: (selector) => selector === ('fxSeen' in dataset ? '[data-fx-seen]' : '[data-fx-key]') ? { dataset, classList: { contains: () => on } } : null } });
    await new Promise((r) => setImmediate(r));
  };
  await click({ fxKey: key, fxApply: 'false' });
  assert.deepEqual(writes.at(-1), [key, false]);
  assert.match(panel.innerHTML, /Mark as seen/);
  await click({ fxKey: key }, false);
  assert.deepEqual(writes.at(-1), [key, true]);
  await click({ fxSeen: `${key}:2026-10-27` });
  assert.equal(writes.length, 2);
  assert.doesNotMatch(row(), /Mark as seen/);
  await click({ fxKey: key, fxApply: 'true' }, true);
  assert.deepEqual(writes.at(-1), [key, null]);
  assert.doesNotMatch(row(), /Mark as seen/);
  assert.ok(JSON.parse(storage.get('fox.fxSettingsSeen')).includes(`${key}:2026-10-27`));
  runInNewContext(source, { ...context });
  await load();
  assert.doesNotMatch(row(), /Mark as seen/);
});
