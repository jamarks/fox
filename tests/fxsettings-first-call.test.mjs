// First request tool choice is a personal opt-in override; opening or dismissing its badge never writes fx settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createFxSettings, fxSettingsView, withFxSetting } from '../fxsettings.mjs';

const entry = (rows) => rows.find((s) => s.key === 'first_call_tool_choice');
test('first_call_tool_choice: default OFF without writes, validated round trips and existing values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fox-first_call_tool_choice-'));
  try {
    const file = join(dir, 'settings.json'), fx = createFxSettings(file);
    const initial = entry(await fx.list());
    assert.equal(initial.applied, false);
    assert.equal(initial.value, '');
    assert.equal(initial.introduced, '2026-11-03');
    assert.match(initial.documentation, /^https:\/\/fx.sh\//);
    await assert.rejects(readFile(file), { code: 'ENOENT' });
    const original = { unknown: { nested: [1] }, statusLine: { session: true }, workspaces: { '/a': { first_call_tool_choice: 'auto' } } };
    await writeFile(file, JSON.stringify(original));
    await chmod(file, 0o640);
    const before = await readFile(file, 'utf8');
    await fx.list();
    assert.equal(await readFile(file, 'utf8'), before);
    for (const value of ['auto', 'none']) {
      const view = entry(await fx.set('first_call_tool_choice', value));
      assert.equal(view.value, value);
      assert.equal(view.applied, true);
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { ...original, first_call_tool_choice: value });
      assert.equal((await stat(file)).mode & 0o777, 0o640);
    }
    const saved = await readFile(file, 'utf8');
    for (const value of [true, 1, '', 'AUTO', 'custom', {}, [], 'none\n']) await assert.rejects(fx.set('first_call_tool_choice', value), { status: 400 });
    assert.equal(await readFile(file, 'utf8'), saved);
    await fx.set('first_call_tool_choice', null);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), original);
    for (const value of ['auto', 'none']) {
      await writeFile(file, JSON.stringify({ ...original, first_call_tool_choice: value }));
      const before = await readFile(file, 'utf8');
      assert.equal(entry(await fx.list()).value, value);
      assert.equal(entry(await fx.list()).applied, true);
      assert.equal(await readFile(file, 'utf8'), before);
    }
    assert.throws(() => withFxSetting({}, 'first_call_tool_choice.other', true), /does not manage/);
    assert.throws(() => withFxSetting({ prompt_history: 'keep' }, 'prompt_history.enabled', true), /nested/);
  } finally { await rm(dir, { recursive: true }); }
});

test('first_call_tool_choice: typed validation, explicit Apply and badge dismissal stay independent across reloads', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const source = app.slice(app.indexOf("// fx's own settings (see fxsettings.mjs)."), app.indexOf('// Tools (MCP'));
  const storage = new Map(), writes = [];
  let saved = {}, handlers, context;
  const panel = { innerHTML: '', addEventListener: (type, fn) => { (handlers[type] ??= []).push(fn); } };
  const note = { textContent: '' };
  const mount = () => {
    handlers = {};
    context = { $: (s) => s === '#settings-fx' ? panel : note, esc: String, settingsSectionShown: () => true,
      localStorage: { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v) },
      fetch: async (_, opts) => {
        if (opts) { const { key, value } = JSON.parse(opts.body); writes.push([key, value]); saved = withFxSetting(saved, key, value); }
        return { ok: true, json: async () => fxSettingsView(saved) };
      } };
    runInNewContext(source, context);
  };
  const load = () => runInNewContext('loadFxSettings()', context);
  const row = () => runInNewContext(`fxSettingRow(${JSON.stringify(entry(fxSettingsView(saved)))})`, context);
  const fire = async (type, target) => {
    for (const fn of handlers[type]) fn({ target });
    await new Promise((r) => setImmediate(r));
  };
  const input = (value) => ({ value, dataset: { fxText: 'first_call_tool_choice', fxError: 'Enter auto or none.' }, reportValidity: () => ['auto', 'none'].includes(value),
    closest: () => ({ querySelector: () => ({ dataset: { fxApply: String('first_call_tool_choice' in saved) } }) }) });
  const apply = (value) => fire('click', { closest: (selector) => selector === '[data-fx-key]' ? {
    dataset: { fxKey: 'first_call_tool_choice', fxApply: String('first_call_tool_choice' in saved), fxTyped: 'true' },
    classList: { contains: () => false }, closest: () => ({ querySelector: () => input(value) }),
  } : null });
  mount(); await load(); await load();
  assert.deepEqual(writes, []);
  assert.match(row(), /data-fx-apply="false"[^>]*role="switch" aria-checked="false"/);
  assert.match(row(), /No fox override; fx defaults to auto/);
  assert.match(row(), />New<\/span>.*Mark as seen/);
  await fire('change', { closest: (s) => s === '[data-fx-text]' ? input('none') : null });
  assert.deepEqual(writes, [], 'unapplied drafts never write');
  await apply('invalid');
  assert.deepEqual(writes, []);
  assert.equal(note.textContent, 'Enter auto or none.');
  await apply('none');
  assert.deepEqual(writes.at(-1), ['first_call_tool_choice', 'none']);
  assert.match(row(), /Mark as seen/);
  await fire('change', { closest: (s) => s === '[data-fx-text]' ? input('invalid') : null });
  assert.equal(writes.length, 1);
  await fire('change', { closest: (s) => s === '[data-fx-text]' ? input('auto') : null });
  assert.deepEqual(writes.at(-1), ['first_call_tool_choice', 'auto']);
  await fire('click', { closest: (s) => s === '[data-fx-seen]' ? { dataset: { fxSeen: 'first_call_tool_choice:2026-11-03' } } : null });
  assert.equal(writes.length, 2);
  assert.equal(saved.first_call_tool_choice, 'auto');
  assert.doesNotMatch(row(), /Mark as seen/);
  await apply('');
  assert.deepEqual(writes.at(-1), ['first_call_tool_choice', null]);
  mount(); await load();
  assert.doesNotMatch(row(), /Mark as seen/);
  assert.equal(entry(fxSettingsView(saved)).applied, false);
  assert.ok(JSON.parse(storage.get('fox.fxSettingsSeen')).includes('first_call_tool_choice:2026-11-03'));
  saved = { first_call_tool_choice: 'none' };
  mount(); await load();
  assert.match(row(), /value="none"/);
  assert.match(row(), /data-fx-apply="true"/);
  assert.equal(writes.length, 3, 'loading an existing value never resets it');
});
