import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fastForward } from '../gitsync.mjs';

const exec = promisify(execFile);
const git = (cwd, ...args) => exec('git', ['-C', cwd, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).then((r) => r.stdout.trim());
async function commit(dir, file, text) { await writeFile(join(dir, file), text); await git(dir, 'add', file); await git(dir, 'commit', '-qm', file); }

test('a clean checkout on its default branch is fast-forwarded; work in progress is left alone', async () => {
  const base = await mkdtemp(join(tmpdir(), 'fox-sync-'));
  const origin = join(base, 'origin.git'), mine = join(base, 'mine'), other = join(base, 'other');
  await exec('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  await exec('git', ['clone', '-q', origin, other]);
  await git(other, 'checkout', '-q', '-b', 'main');
  await commit(other, 'a.txt', 'one');
  await git(other, 'push', '-q', 'origin', 'main');
  await exec('git', ['clone', '-q', origin, mine]);

  assert.equal((await fastForward(mine)).status, 'current');
  await commit(other, 'b.txt', 'two');
  await git(other, 'push', '-q', 'origin', 'main');
  const up = await fastForward(mine);
  assert.equal(up.status, 'updated');
  assert.equal(await git(mine, 'rev-parse', 'HEAD'), await git(other, 'rev-parse', 'HEAD'));

  await commit(other, 'c.txt', 'three');
  await git(other, 'push', '-q', 'origin', 'main');
  await writeFile(join(mine, 'a.txt'), 'edited, not committed');
  assert.deepEqual(await fastForward(mine), { status: 'skipped', reason: 'uncommitted changes' });
  await git(mine, 'checkout', '-q', '--', 'a.txt');

  await commit(mine, 'mine.txt', 'local');
  assert.deepEqual(await fastForward(mine), { status: 'skipped', reason: 'local commits not pushed' });
  await git(mine, 'reset', '-q', '--hard', 'HEAD~1');

  await git(mine, 'checkout', '-q', '-b', 'feature');
  assert.deepEqual(await fastForward(mine), { status: 'skipped', reason: 'on branch feature' });

  assert.deepEqual(await fastForward(base), { status: 'skipped', reason: 'not a git repo' });
});
