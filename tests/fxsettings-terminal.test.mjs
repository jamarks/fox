// Terminal preferences use the existing personal override and browser-only badge paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { createFxSettings, fxSettingsView, withFxSetting } from '../fxsettings.mjs';

for (const key of ['slash_menu_categories', 'startup_scrollback']) {
  const entry = (list) => list.find((s) => s.key === key);
  test(`${key}: opt-in, validated round trips preserve all other configuration`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fox-terminal-'));
    try {
      const file = join(dir, 'settings.json'), fx = createFxSettings(file);
      const initial = entry(await fx.list());
      assert.equal(initial.applied, false);
      assert.equal(initial.value, false);
      assert.equal(initial.introduced, '2026-10-30');
      assert.match(initial.documentation, /^https:\/\/fx.sh\//);
      await assert.rejects(readFile(file), { code: 'ENOENT' });
      const original = { unknown: { nested: [1] }, notifications: { turn_end: true }, workspaces: { '/a': { [key]: true } } };
      await writeFile(file, JSON.stringify(original));
      await chmod(file, 0o640);
      const before = await readFile(file, 'utf8');
      await fx.list();
      assert.equal(await readFile(file, 'utf8'), before);
      for (const value of [true, false]) {
        await fx.set(key, value);
        assert.equal(entry(await fx.list()).value, value);
        assert.equal(entry(await fx.list()).applied, true);
        assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { ...original, [key]: value });
        assert.equal((await stat(file)).mode & 0o777, 0o640);
      }
      const saved = await readFile(file, 'utf8');
      for (const value of ['true', 1, {}, []]) await assert.rejects(fx.set(key, value), { status: 400 });
      assert.equal(await readFile(file, 'utf8'), saved);
      await fx.set(key, null);
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), original);
      for (const value of [true, false]) {
        await writeFile(file, JSON.stringify({ ...original, [key]: value }));
        assert.equal(entry(await fx.list()).value, value);
        assert.equal(entry(await fx.list()).applied, true);
      }
      assert.throws(() => withFxSetting({}, `${key}.other`, true), /does not manage/);
      assert.throws(() => withFxSetting({ prompt_history: 'keep' }, 'prompt_history.enabled', true), /nested/);
    } finally { await rm(dir, { recursive: true }); }
  });

  test(`${key}: badge dismissal and activation are independent across browser reloads`, async () => {
    const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
    const source = app.slice(app.indexOf("// fx's own settings (see fxsettings.mjs)."), app.indexOf('// Tools (MCP'));
    const storage = new Map(), writes = [];
    let saved = {}, handlers, context;
    const panel = { innerHTML: '', addEventListener: (type, fn) => { handlers[type] = fn; } };
    const mount = () => {
      handlers = {};
      context = { $: (s) => s === '#settings-fx' ? panel : { textContent: '' }, esc: String, settingsSectionShown: () => true,
        localStorage: { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v) },
        fetch: async (_, opts) => {
          if (opts) { const { key, value } = JSON.parse(opts.body); writes.push([key, value]); saved = withFxSetting(saved, key, value); }
          return { ok: true, json: async () => fxSettingsView(saved) };
        } };
      runInNewContext(source, context);
    };
    const load = () => runInNewContext('loadFxSettings()', context);
    const row = () => runInNewContext(`fxSettingRow(${JSON.stringify(entry(fxSettingsView(saved)))})`, context);
    const click = async (dataset, on = false) => {
      handlers.click({ target: { closest: (selector) => selector === ('fxSeen' in dataset ? '[data-fx-seen]' : '[data-fx-key]') ? { dataset, classList: { contains: () => on } } : null } });
      await new Promise((r) => setImmediate(r));
    };
    mount(); await load(); await load();
    assert.deepEqual(writes, []);
    assert.match(row(), />New<\/span>.*Mark as seen/);
    assert.match(row(), /data-fx-apply="false" role="switch" aria-checked="false"/);
    assert.match(row(), /No fox override; fx defaults to on/);
    assert.match(row(), /Changes apply to new or resumed sessions/);
    assert.doesNotMatch(row(), /Save prompts/);
    await click({ fxKey: key, fxApply: 'false' });
    assert.deepEqual(writes.at(-1), [key, false]);
    await click({ fxKey: key });
    assert.deepEqual(writes.at(-1), [key, true]);
    assert.match(row(), /Mark as seen/);
    await click({ fxSeen: `${key}:2026-10-30` });
    assert.equal(writes.length, 2);
    assert.equal(saved[key], true);
    assert.doesNotMatch(row(), /Mark as seen/);
    await click({ fxKey: key, fxApply: 'true' }, true);
    assert.deepEqual(writes.at(-1), [key, null]);
    mount(); await load();
    assert.doesNotMatch(row(), /Mark as seen/);
    assert.equal(entry(fxSettingsView(saved)).applied, false);
    assert.ok(JSON.parse(storage.get('fox.fxSettingsSeen')).includes(`${key}:2026-10-30`));
  });
}
