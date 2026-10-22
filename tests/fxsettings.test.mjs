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
  assert.equal(FX_SETTINGS.filter((s) => s.introduced === '2026-10-21').length, 1);
  assert.equal(entry(await fx.list()).introduced, '2026-10-18');
  assert.match(entry(await fx.list()).documentation, /^https:\/\/fx.sh\//);
});

test('new badge is browser-local and independent of application', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const source = app.slice(app.indexOf('// fx\'s own settings (see fxsettings.mjs).'), app.indexOf('// Tools (MCP'));
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
  assert.doesNotMatch(panel.innerHTML, /data-fx-seen="max_agent_steps:/);
  assert.match(panel.innerHTML, /data-fx-seen="auto_compact_percent:2026-10-21"/);
  const reloaded = { ...context };
  runInNewContext(source, reloaded);
  await runInNewContext('loadFxSettings()', reloaded);
  assert.doesNotMatch(panel.innerHTML, /data-fx-seen="max_agent_steps:/);
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

test('compaction override is opt-in and validates the installed fx range', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'fox-fxs-')), 'settings.json');
  const fx = createFxSettings(file);
  const entry = (list) => list.find((s) => s.key === 'auto_compact_percent');
  assert.equal(entry(await fx.list()).applied, false);
  assert.equal(entry(await fx.list()).value, 80);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  const original = { unknown: { nested: [1, 2] }, statusLine: { session: true }, workspaces: { '/project': { auto_compact_percent: 30 } } };
  await writeFile(file, JSON.stringify(original), { mode: 0o640 });
  await chmod(file, 0o640);
  const before = await readFile(file, 'utf8');
  await fx.list();
  assert.equal(await readFile(file, 'utf8'), before);
  for (const value of [10, 60, 80]) {
    const saved = entry(await fx.set('auto_compact_percent', value));
    assert.equal(saved.value, value);
    assert.equal(saved.applied, true);
    assert.equal((await stat(file)).mode & 0o777, 0o640);
  }
  for (const value of [9, 81, 10.5, '60', false, {}, [], NaN, Infinity]) {
    await assert.rejects(fx.set('auto_compact_percent', value), { status: 400 });
  }
  assert.equal(entry(await fx.list()).value, 80);
  await fx.set('auto_compact_percent', null);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), original);
  await writeFile(file, JSON.stringify({ ...original, auto_compact_percent: 37 }));
  assert.equal(entry(await fx.list()).value, 37);
  assert.equal(entry(await fx.list()).applied, true);
  assert.equal(entry(await fx.list()).introduced, '2026-10-21');
  assert.match(entry(await fx.list()).documentation, /^https:\/\/fx.sh\//);
});

test('compaction UI validates drafts and keeps badge state independent of activation', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const source = app.slice(app.indexOf('// fx\'s own settings (see fxsettings.mjs).'), app.indexOf('// Tools (MCP'));
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
  await runInNewContext('loadFxSettings()', context);
  assert.equal(writes.length, 0);
  const rowHtml = () => runInNewContext(`fxSettingRow(${JSON.stringify(fxSettingsView(saved).find((s) => s.key === 'auto_compact_percent'))})`, context);
  assert.match(rowHtml(), /aria-checked="false"/);
  assert.match(rowHtml(), /No fox override/);
  assert.match(rowHtml(), /Upstream default: 80%/);
  assert.match(rowHtml(), /Mark as seen/);
  const input = { value: '', reportValidity: () => false };
  let applied = false;
  const row = { querySelector: (s) => s === '[data-fx-input]' ? input : { classList: { contains: () => applied } } };
  const button = { dataset: { fxKey: 'auto_compact_percent', fxApply: '' }, classList: { contains: () => applied }, closest: () => row };
  const press = () => click({ target: { closest: (s) => s === '[data-fx-key]' ? button : null } });
  await press();
  input.value = '81';
  await press();
  assert.equal(writes.length, 0, 'invalid drafts never write');
  input.value = '60'; input.reportValidity = () => true;
  await press();
  assert.deepEqual(writes, [60]);
  assert.match(rowHtml(), /value="60"/);
  assert.match(rowHtml(), /aria-checked="true"/);
  assert.match(rowHtml(), /Mark as seen/, 'activation does not mark seen');
  const seen = { dataset: { fxSeen: 'auto_compact_percent:2026-10-21' }, closest: () => ({ remove() {} }) };
  await click({ target: { closest: (s) => s === '[data-fx-seen]' ? seen : null } });
  assert.equal(writes.length, 1);
  assert.doesNotMatch(rowHtml(), /Mark as seen/);
  assert.match(rowHtml(), /aria-checked="true"/, 'dismissal does not deactivate');
  applied = true; button.disabled = false;
  await press();
  assert.deepEqual(writes, [60, null]);
  assert.deepEqual(saved, {});
  assert.doesNotMatch(rowHtml(), /Mark as seen/, 'removing an override does not reset seen');
  const reloaded = { ...context };
  runInNewContext(source, reloaded);
  const html = runInNewContext(`fxSettingRow(${JSON.stringify(fxSettingsView(saved).find((s) => s.key === 'auto_compact_percent'))})`, reloaded);
  assert.doesNotMatch(html, /Mark as seen/);
  assert.match(html, /aria-checked="false"/);
});

test('tool output budget is opt-in, preserves config and validates bytes', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'fox-fxs-')), 'settings.json');
  const fx = createFxSettings(file);
  const entry = (list) => list.find((s) => s.key === 'max_tool_result_bytes');
  assert.equal(entry(await fx.list()).applied, false);
  assert.equal(entry(await fx.list()).value, 65536);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  const original = { unknown: { keep: [1] }, notifications: { turn_end: true }, workspaces: { '/project': { max_tool_result_bytes: 2048 } } };
  await writeFile(file, JSON.stringify(original), { mode: 0o640 });
  await chmod(file, 0o640);
  const before = await readFile(file, 'utf8');
  await fx.list();
  assert.equal(await readFile(file, 'utf8'), before);
  for (const value of [1024, 131072, 2147483647]) {
    assert.equal(entry(await fx.set('max_tool_result_bytes', value)).value, value);
    assert.equal(entry(await fx.list()).applied, true);
    assert.equal((await stat(file)).mode & 0o777, 0o640);
  }
  const last = await readFile(file, 'utf8');
  for (const value of [1023, -1, 1024.5, '65536', true, {}, [], NaN, Infinity, 2147483648]) {
    await assert.rejects(fx.set('max_tool_result_bytes', value), { status: 400 });
  }
  assert.equal(await readFile(file, 'utf8'), last);
  await fx.set('max_tool_result_bytes', null);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), original);
  await writeFile(file, JSON.stringify({ ...original, max_tool_result_bytes: 4096 }));
  assert.equal(entry(await fx.list()).value, 4096);
  assert.equal(entry(await fx.list()).applied, true);
  assert.equal(entry(await fx.list()).introduced, '2026-10-22');
  assert.match(entry(await fx.list()).documentation, /^https:\/\/fx.sh\//);
  assert.throws(() => withFxSetting({}, 'max_tool_result_bytes.nested', 2048), /does not manage/);
});

test('tool output budget UI validates drafts and keeps badge state independent of activation', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const source = app.slice(app.indexOf('// fx\'s own settings (see fxsettings.mjs).'), app.indexOf('// Tools (MCP servers'));
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
  await runInNewContext('loadFxSettings()', context);
  assert.equal(writes.length, 0);
  const rowHtml = () => runInNewContext(`fxSettingRow(${JSON.stringify(fxSettingsView(saved).find((s) => s.key === 'max_tool_result_bytes'))})`, context);
  assert.match(rowHtml(), /aria-checked="false"/);
  assert.match(rowHtml(), /No fox override/);
  assert.match(rowHtml(), /Upstream default: 65536 bytes/);
  assert.match(rowHtml(), /Mark as seen/);
  const input = { value: '', reportValidity: () => false };
  let applied = false;
  const row = { querySelector: (s) => s === '[data-fx-input]' ? input : { classList: { contains: () => applied } } };
  const button = { dataset: { fxKey: 'max_tool_result_bytes', fxApply: '' }, classList: { contains: () => applied }, closest: () => row };
  const press = () => click({ target: { closest: (s) => s === '[data-fx-key]' ? button : null } });
  await press();
  input.value = '1023';
  await press();
  assert.equal(writes.length, 0, 'invalid drafts never write');
  input.value = '131072'; input.reportValidity = () => true;
  await press();
  assert.deepEqual(writes, [131072]);
  assert.match(rowHtml(), /value="131072"/);
  assert.match(rowHtml(), /aria-checked="true"/);
  assert.match(rowHtml(), /Mark as seen/, 'activation does not mark seen');
  const seen = { dataset: { fxSeen: 'max_tool_result_bytes:2026-10-22' }, closest: () => ({ remove() {} }) };
  await click({ target: { closest: (s) => s === '[data-fx-seen]' ? seen : null } });
  assert.equal(writes.length, 1);
  assert.doesNotMatch(rowHtml(), /Mark as seen/);
  assert.match(rowHtml(), /aria-checked="true"/, 'dismissal does not deactivate');
  applied = true; button.disabled = false;
  await press();
  assert.deepEqual(writes, [131072, null]);
  assert.deepEqual(saved, {});
  assert.doesNotMatch(rowHtml(), /Mark as seen/, 'removing an override does not reset seen');
  const reloaded = { ...context };
  runInNewContext(source, reloaded);
  const html = runInNewContext(`fxSettingRow(${JSON.stringify(fxSettingsView(saved).find((s) => s.key === 'max_tool_result_bytes'))})`, reloaded);
  assert.doesNotMatch(html, /Mark as seen/);
  assert.match(html, /aria-checked="false"/);
});
