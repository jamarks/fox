import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFxSettings, withFxSetting, fxSettingsView, FX_SETTINGS } from '../fxsettings.mjs';
import { runInNewContext } from 'node:vm';

test('fox changes only the fx settings it shows, and keeps the rest of the file', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'fox-fxs-')), 'settings.json');
  await writeFile(file, JSON.stringify({ provider: 'codex', models: { codex: 'gpt-6.1-sol' }, statusLine: { session: true } }), { mode: 0o600 });
  const fx = createFxSettings(file);
  const view = await fx.list();
  assert.equal(view.find((s) => s.key === 'collapse_tool_calls').value, false, 'defaults when absent');
  assert.equal(view.find((s) => s.key === 'effort').value, 'auto');
  await fx.set('collapse_tool_calls', true);
  await fx.set('statusLine.context', true);
  await fx.set('effort', 'high');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved, { provider: 'codex', models: { codex: 'gpt-6.1-sol' }, statusLine: { session: true, context: true }, collapse_tool_calls: true, effort: 'high' });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.throws(() => withFxSetting({}, 'provider', 'grok'), /does not manage/);
  assert.throws(() => withFxSetting({}, 'fast_mode', 'yes'), /on or off/);
  assert.throws(() => withFxSetting({}, 'effort', 'max'), /one of/);
});

test('step limit is opt-in, read-only until applied, and preserves existing settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fox-fxs-'));
  const file = join(dir, 'settings.json');
  const fx = createFxSettings(file);
  const entry = (list) => list.find((s) => s.key === 'max_agent_steps');
  assert.equal(entry(await fx.list()).applied, false);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  const original = { unknown: { keep: true }, statusLine: { session: true }, workspaces: { '/project': { max_agent_steps: 8 } } };
  await writeFile(file, JSON.stringify(original), { mode: 0o640 });
  await chmod(file, 0o640);
  const before = await readFile(file, 'utf8');
  await fx.list();
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal(entry(await fx.set('max_agent_steps', 40)).value, 40);
  assert.equal(entry(await fx.list()).applied, true);
  assert.equal((await stat(file)).mode & 0o777, 0o640);
  for (const invalid of [-1, 1.5, '40', true, {}, [], NaN, Infinity, 2147483648]) {
    await assert.rejects(fx.set('max_agent_steps', invalid), { status: 400 });
  }
  assert.equal(entry(await fx.list()).value, 40);
  await fx.set('max_agent_steps', null);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), original);
  await fx.set('max_agent_steps', 0);
  assert.equal(entry(await fx.list()).applied, true, 'zero is an explicit unlimited override');
  assert.equal(entry(fxSettingsView({ max_agent_steps: 17 })).value, 17);
  assert.equal(entry(fxSettingsView({ max_agent_steps: 17 })).applied, true);
  assert.throws(() => withFxSetting({}, 'effort', null), /one of/);
  assert.throws(() => withFxSetting({}, 'max_agent_steps.other', 1), /does not manage/);
  assert.throws(() => withFxSetting({ statusLine: 'keep' }, 'statusLine.context', true), /nested/);
  assert.deepEqual(withFxSetting({ statusLine: { session: true } }, 'statusLine.context', false), { statusLine: { session: true, context: false } });
  assert.equal(FX_SETTINGS.filter((s) => s.introduced).length, 1);
  assert.equal(entry(await fx.list()).introduced, '2026-10-18');
  assert.match(entry(await fx.list()).documentation, /^https:\/\/fx.sh\//);
});

test('new badge is browser-local and independent of application', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const source = app.slice(app.indexOf('// fx\'s own settings (see fxsettings.mjs).'), app.indexOf('// Tools for fx (MCP'));
  const storage = new Map();
  let click, writes = 0;
  const panel = { innerHTML: '', addEventListener: (_, fn) => { click = fn; } };
  const note = { textContent: '' };
  const context = { $: (s) => s === '#settings-fx' ? panel : note, esc: String,
    localStorage: { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    fetch: async (_, opts) => { if (opts) writes++; return { ok: true, json: async () => fxSettingsView({}) }; } };
  runInNewContext(source, context);
  await runInNewContext('loadFxSettings()', context);
  assert.equal(writes, 0);
  assert.match(panel.innerHTML, /New/);
  assert.match(panel.innerHTML, /aria-checked="false" aria-label="Apply setting/);
  let removed = false;
  const seen = { dataset: { fxSeen: 'max_agent_steps:2026-10-18' }, closest: () => ({ remove: () => { removed = true; } }) };
  await click({ target: { closest: (s) => s === '[data-fx-seen]' ? seen : null } });
  assert.equal(removed, true);
  assert.equal(writes, 0);
  await runInNewContext('loadFxSettings()', context);
  assert.doesNotMatch(panel.innerHTML, /Mark as seen/);
  runInNewContext(source, { ...context });
  await runInNewContext('loadFxSettings()', context);
  assert.doesNotMatch(panel.innerHTML, /Mark as seen/);
  const applied = runInNewContext(`fxSettingRow(${JSON.stringify(fxSettingsView({ max_agent_steps: 17 }).at(-1))})`, context);
  assert.match(applied, /value="17"/);
  assert.match(applied, /aria-checked="true"/);
  assert.doesNotMatch(applied, /Mark as seen/);
  const input = { value: '22', reportValidity: () => true };
  const row = { querySelector: (s) => s === '[data-fx-input]' ? input : { classList: { contains: () => false } } };
  const button = { dataset: { fxKey: 'max_agent_steps', fxSave: '' }, classList: { contains: () => false }, closest: () => row };
  await click({ target: { closest: (s) => s === '[data-fx-key]' ? button : null } });
  assert.equal(writes, 0, 'saving an un-applied draft never writes');
});
