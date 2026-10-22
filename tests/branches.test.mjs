import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createBranches, okBranchName, wipName } from '../branches.mjs';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

// A remote with main and a merged feature branch, and a workspace whose copy sits on that feature branch.
async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'fox-branches-'));
  const origin = join(base, 'origin.git'), seed = join(base, 'seed'), ws = join(base, 'workspaces', 'fox'), copy = join(ws, 'fox');
  sh(base, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(base, 'clone', '-q', origin, seed);
  await writeFile(join(seed, 'a.txt'), 'one\n'); sh(seed, 'add', '.'); sh(seed, 'commit', '-qm', 'one'); sh(seed, 'push', '-q', 'origin', 'HEAD:main');
  sh(seed, 'switch', '-qc', 'feature/old'); await writeFile(join(seed, 'b.txt'), 'feature\n'); sh(seed, 'add', '.'); sh(seed, 'commit', '-qm', 'feature');
  sh(seed, 'push', '-q', 'origin', 'feature/old');
  sh(seed, 'switch', '-q', 'main'); sh(seed, 'merge', '-q', '--no-ff', '-m', 'merge feature', 'feature/old'); sh(seed, 'push', '-q', 'origin', 'main');
  sh(seed, 'switch', '-qc', 'only-remote'); sh(seed, 'push', '-q', 'origin', 'only-remote'); sh(seed, 'switch', '-q', 'main');
  sh(base, 'clone', '-q', origin, copy);
  sh(copy, 'switch', '-q', 'feature/old');
  const workspace = { id: 'w1', name: 'fox', dir: ws, repos: [{ owner: 'o', name: 'fox', dir: 'fox' }] };
  let working = [];
  const branches = createBranches({ workspaces: { get: async (id) => (id === 'w1' ? workspace : null) }, busy: async () => working,
    git: (args, opts = {}) => new Promise((ok, no) => { try { ok(execFileSync('git', args, { env, encoding: 'utf8', ...opts, stdio: ['ignore', 'pipe', 'pipe'] }).trim()); } catch (err) { no(err); } }),
    now: () => new Date('2026-10-22T09:30:00Z') });
  return { base, origin, seed, copy, branches, setWorking: (w) => { working = w; } };
}

test('branch names and wip names are safe', () => {
  for (const ok of ['main', 'feature/old', 'agent/fox-54-x', 'v1.2']) assert.ok(okBranchName(ok), ok);
  for (const bad of ['-rf', '--force', 'a..b', 'a b', 'x/', 'x.lock', 'a@{1}', '', null]) assert.ok(!okBranchName(bad), String(bad));
  assert.equal(wipName('feature/old', new Date('2026-10-22T09:30:00Z')), 'wip/feature-old-20261022-0930');
});

test('the list says where the copy is, what the default is, and that the branch was merged', async () => {
  const { branches } = await setup();
  const l = await branches.list('w1', 'fox');
  assert.equal(l.current, 'feature/old');
  assert.equal(l.default, 'main');
  assert.equal(l.merged, true);
  assert.equal(l.dirty, 0);
  assert.deepEqual(l.branches.map((b) => b.name).sort(), ['feature/old', 'main', 'only-remote']);
  assert.equal(l.branches.find((b) => b.name === 'only-remote').local, false);
  await assert.rejects(branches.list('w1', 'nope'), /not found/);
});

test('uncommitted work is never dropped: refused, or kept in a pushed wip branch before switching', async () => {
  const { copy, origin, branches } = await setup();
  await writeFile(join(copy, 'b.txt'), 'half done\n');
  await assert.rejects(branches.switch('w1', 'fox', 'main'), (e) => e.status === 409 && e.dirty === 1);
  assert.equal(sh(copy, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/old', 'nothing moved');
  const r = await branches.switch('w1', 'fox', 'main', { keep: true });
  assert.deepEqual(r.kept, { name: 'wip/feature-old-20261022-0930', pushed: true });
  assert.equal(sh(copy, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(sh(copy, 'status', '--porcelain'), '', 'main is clean');
  assert.equal(sh(origin, 'show', 'wip/feature-old-20261022-0930:b.txt'), 'half done', 'the work is on GitHub');
});

test('a failed WIP push leaves the committed work on its branch and does not switch', async () => {
  const { copy, branches } = await setup();
  await writeFile(join(copy, 'b.txt'), 'draft\n');
  sh(copy, 'remote', 'set-url', '--push', 'origin', '/nonexistent/fox-origin.git');
  await assert.rejects(branches.switch('w1', 'fox', 'main', { keep: true }), (e) => e.status === 409 && /could not be pushed/.test(e.message));
  assert.equal(sh(copy, 'rev-parse', '--abbrev-ref', 'HEAD'), 'wip/feature-old-20261022-0930');
  assert.equal(sh(copy, 'show', 'HEAD:b.txt'), 'draft');
});

test('a linked repo cannot redirect branch actions outside the workspace', async () => {
  const { copy, seed, branches } = await setup();
  await rename(copy, `${copy}-old`);
  await symlink(seed, copy);
  await assert.rejects(branches.list('w1', 'fox'), (e) => e.status === 409 && /outside/.test(e.message));
  await assert.rejects(branches.switch('w1', 'fox', 'main'), (e) => e.status === 409);
});

test('update refuses uncommitted work', async () => {
  const { copy, branches } = await setup();
  await writeFile(join(copy, 'b.txt'), 'draft\n');
  await assert.rejects(branches.update('w1', 'fox'), (e) => e.status === 409 && /uncommitted/.test(e.message));
  assert.equal(sh(copy, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/old');
});

test('a working session in the workspace stops any change', async () => {
  const { copy, branches, setWorking } = await setup();
  setWorking(['fx-abc']);
  await assert.rejects(branches.switch('w1', 'fox', 'main'), (e) => e.status === 409 && /working/.test(e.message));
  await assert.rejects(branches.update('w1', 'fox'), /working/);
  await assert.rejects(branches.create('w1', 'fox', 'new'), /working/);
  assert.equal(sh(copy, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/old');
});

test('a branch only on the remote is tracked; updates only fast-forward', async () => {
  const { copy, seed, branches } = await setup();
  assert.equal((await branches.switch('w1', 'fox', 'only-remote')).branch, 'only-remote');
  assert.equal(sh(copy, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/only-remote');
  await branches.switch('w1', 'fox', 'main');
  await writeFile(join(seed, 'c.txt'), 'new on main\n'); sh(seed, 'add', '.'); sh(seed, 'commit', '-qm', 'more'); sh(seed, 'push', '-q', 'origin', 'main');
  assert.equal((await branches.update('w1', 'fox')).update, 'up to date');
  assert.equal(await readFile(join(copy, 'c.txt'), 'utf8'), 'new on main\n');
  await writeFile(join(copy, 'd.txt'), 'local\n'); sh(copy, 'add', '.'); sh(copy, 'commit', '-qm', 'local only');
  await writeFile(join(seed, 'e.txt'), 'remote\n'); sh(seed, 'add', '.'); sh(seed, 'commit', '-qm', 'remote only'); sh(seed, 'push', '-q', 'origin', 'main');
  assert.match((await branches.update('w1', 'fox')).update, /diverged/, 'never a merge commit');
  await assert.rejects(branches.switch('w1', 'fox', '--force'), /not a branch name/);
  await assert.rejects(branches.switch('w1', 'fox', 'nope'), /no branch/);
  assert.equal((await branches.create('w1', 'fox', 'try/idea')).branch, 'try/idea');
  assert.equal(sh(copy, 'rev-parse', '--abbrev-ref', 'HEAD'), 'try/idea');
});
