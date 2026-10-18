import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFxSettings, withFxSetting } from '../fxsettings.mjs';

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
