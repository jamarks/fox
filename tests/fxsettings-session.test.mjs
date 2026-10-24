import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createFxSettings, fxSettingsView, withFxSetting } from '../fxsettings.mjs';

const key = 'statusLine.session';
const entry = (rows) => rows.find((s) => s.key === key);

test('session footer is opt-in, preserves nested configuration and existing values', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'fox-session-footer-')), 'settings.json');
  const fx = createFxSettings(file);
  const initial = entry(await fx.list());
  assert.equal(initial.value, false);
  assert.equal(initial.applied, false);
  assert.equal(initial.introduced, '2026-10-24');
  assert.match(initial.documentation, /^https:\/\/fx.sh\//);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  const original = { unknown: { keep: [1] }, statusLine: { context: true, custom: 'keep' }, workspaces: { '/project': { statusLine: { session: true } } } };
  await writeFile(file, JSON.stringify(original));
  await chmod(file, 0o640);
  const before = await readFile(file, 'utf8');
  await fx.list();
  assert.equal(await readFile(file, 'utf8'), before);
  for (const value of [true, false]) {
    const row = entry(await fx.set(key, value));
    assert.equal(row.value, value);
    assert.equal(row.applied, true);
    assert.equal((await stat(file)).mode & 0o777, 0o640);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { ...original, statusLine: { ...original.statusLine, session: value } });
  }
  const saved = await readFile(file, 'utf8');
  for (const invalid of ['false', 0, 1, {}, []]) await assert.rejects(fx.set(key, invalid), { status: 400 });
  assert.equal(await readFile(file, 'utf8'), saved);
  await fx.set(key, null);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), original);
  for (const value of [true, false]) {
    await writeFile(file, JSON.stringify({ ...original, statusLine: { ...original.statusLine, session: value } }));
    assert.equal(entry(await fx.list()).value, value);
    assert.equal(entry(await fx.list()).applied, true);
  }
  for (const value of ['keep', null, [], false]) {
    assert.throws(() => withFxSetting({ statusLine: value }, key, true), /nested/);
    assert.deepEqual(withFxSetting({ statusLine: value }, key, null), { statusLine: value });
  }
  assert.throws(() => withFxSetting({}, 'statusLine.session.extra', true), /does not manage/);
});

test('session footer draft, activation and browser-local badge remain independent', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const source = app.slice(app.indexOf("// fx's own settings (see fxsettings.mjs)."), app.indexOf('// Tools (MCP'));
  const storage = new Map();
  let click, saved = {}, writes = [];
  const panel = { innerHTML: '', addEventListener: (_, fn) => { click = fn; } };
  const note = { textContent: '' };
  const context = { $: (s) => s === '#settings-fx' ? panel : note, esc: String,
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
  assert.match(html(), /Upstream default: off/);
  assert.match(html(), /New/);
  assert.doesNotMatch(runInNewContext(`fxSettingRow(${JSON.stringify(fxSettingsView({})[0])})`, context), /Mark as seen/);
  let applied = false;
  const input = { type: 'checkbox', checked: true };
  const row = { querySelector: (s) => s === '[data-fx-input]' ? input : { classList: { contains: () => applied } } };
  const button = { dataset: { fxKey: key, fxSave: '' }, classList: { contains: () => applied }, closest: () => row };
  const press = () => click({ target: { closest: (s) => s === '[data-fx-key]' ? button : null } });
  await press();
  assert.equal(writes.length, 0, 'saving a draft never opts in');
  button.dataset = { fxKey: key, fxApply: '' };
  await press();
  assert.deepEqual(writes, [true]);
  assert.match(html(), /type="checkbox" checked/);
  assert.match(html(), /Mark as seen/, 'activation does not dismiss badge');
  assert.match(note.textContent, /resumed/);
  applied = true; button.disabled = false;
  input.checked = false; button.dataset = { fxKey: key, fxSave: '' };
  await press();
  assert.deepEqual(writes, [true, false]);
  assert.match(html(), /aria-checked="true"/, 'false is still an applied override');
  const seen = { dataset: { fxSeen: `${key}:2026-10-24` }, closest: () => ({ remove() {} }) };
  await click({ target: { closest: (s) => s === '[data-fx-seen]' ? seen : null } });
  assert.equal(writes.length, 2);
  assert.equal(saved.statusLine.session, false);
  assert.doesNotMatch(html(), /Mark as seen/);
  button.disabled = false; button.dataset = { fxKey: key, fxApply: '' };
  await press();
  assert.deepEqual(writes, [true, false, null]);
  assert.deepEqual(saved, { statusLine: {} });
  const reloaded = { ...context };
  runInNewContext(source, reloaded);
  await runInNewContext('loadFxSettings()', reloaded);
  assert.doesNotMatch(panel.innerHTML, /data-fx-seen="statusLine.session:/);
  assert.match(html(), /aria-checked="false"/);
});
