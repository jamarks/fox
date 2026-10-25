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
