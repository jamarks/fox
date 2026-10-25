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
