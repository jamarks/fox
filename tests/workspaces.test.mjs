import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorkspaces, createRepoCatalog, WORKSPACE_NAME, validRepo } from '../workspaces.mjs';

const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString().trim();

// Bare "GitHub" remotes on disk: <remotes>/<owner>/<name>.git, each with one commit.
async function setup(repos) {
  const base = await mkdtemp(join(tmpdir(), 'fox-ws-'));
  const remotes = join(base, 'remotes');
  for (const [owner, name] of repos) {
    const bare = join(remotes, owner, `${name}.git`);
    await mkdir(bare, { recursive: true });
    git(['init', '--bare', '-q', '-b', 'main', bare]);
    const work = join(base, 'seed', owner, name);
    await mkdir(work, { recursive: true });
    git(['init', '-q', '-b', 'main'], work);
    await writeFile(join(work, 'README.md'), `# ${name}\n`);
    git(['add', '.'], work); git(['commit', '-q', '-m', 'init'], work);
    git(['remote', 'add', 'origin', bare], work); git(['push', '-q', 'origin', 'main'], work);
  }
  const ws = createWorkspaces({
    stateDir: join(base, 'state'), rootDir: join(base, 'workspaces'),
    remoteUrl: (r) => join(remotes, r.owner, `${r.name}.git`),
  });
  await mkdir(join(base, 'workspaces'), { recursive: true });
  return { base, ws };
}
const settle = async (ws, id) => {
  for (let i = 0; i < 100; i++) {
    const w = (await ws.list()).find((x) => x.id === id);
    if (w.repos.every((r) => r.status === 'ready' || r.status === 'error')) return w;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('clones did not finish');
};

test('names and repos are validated', () => {
  for (const ok of ['orchestra', 'a', 'my-ws_2.x']) assert.ok(WORKSPACE_NAME.test(ok), ok);
  for (const bad of ['', 'Orchestra', '../x', 'a/b', '.hidden', 'x'.repeat(64)]) assert.ok(!WORKSPACE_NAME.test(bad), bad);
  assert.ok(validRepo({ owner: 'hiOrchestra', name: 'orchestra-ops' }));
  for (const bad of [{ owner: '..', name: 'x' }, { owner: 'a', name: '../etc' }, { owner: 'a', name: 'x.git' }, { owner: 'a b', name: 'x' }, null]) assert.ok(!validRepo(bad), JSON.stringify(bad));
});

test('a workspace clones every repo into its folder and is saved', async () => {
  const { base, ws } = await setup([['hiOrchestra', 'backend'], ['hiOrchestra', 'portal'], ['jamarks', 'notes']]);
  const created = await ws.create({ name: 'orchestra', repos: [{ owner: 'hiOrchestra', name: 'backend' }, { owner: 'hiOrchestra', name: 'portal' }, { owner: 'jamarks', name: 'notes' }] });
  const w = await settle(ws, created.id);
  assert.deepEqual(w.repos.map((r) => [r.dir, r.status, r.branch, r.changed]), [['backend', 'ready', 'main', 0], ['portal', 'ready', 'main', 0], ['notes', 'ready', 'main', 0]]);
  assert.ok(existsSync(join(base, 'workspaces', 'orchestra', 'portal', 'README.md')));
  const saved = JSON.parse(await readFile(join(base, 'state', 'workspaces.json'), 'utf8'));
  assert.equal(saved[0].name, 'orchestra');
  assert.equal((await ws.forPath(join(base, 'workspaces', 'orchestra', 'portal', 'src'))).id, created.id);
  assert.equal(await ws.forPath(join(base, 'elsewhere')), null);
  await assert.rejects(ws.create({ name: 'orchestra', repos: [{ owner: 'jamarks', name: 'notes' }] }), /already exists/);
  await assert.rejects(ws.create({ name: '../escape', repos: [{ owner: 'jamarks', name: 'notes' }] }), /lowercase/);
});

test('same repo name from two owners gets separate folders', async () => {
  const { ws } = await setup([['a', 'api'], ['b', 'api']]);
  const created = await ws.create({ name: 'two', repos: [{ owner: 'a', name: 'api' }, { owner: 'b', name: 'api' }] });
  const w = await settle(ws, created.id);
  assert.deepEqual(w.repos.map((r) => r.dir), ['api', 'api-b']);
});

test('a repo that fails to clone leaves the workspace and the others in place', async () => {
  const { ws } = await setup([['jamarks', 'notes']]);
  const created = await ws.create({ name: 'partial', repos: [{ owner: 'jamarks', name: 'notes' }, { owner: 'jamarks', name: 'missing' }] });
  const w = await settle(ws, created.id);
  assert.equal(w.repos[0].status, 'ready');
  assert.equal(w.repos[1].status, 'error');
  assert.ok(w.repos[1].error);
});

test('the folder is only deleted when nothing would be lost', async () => {
  const { base, ws } = await setup([['jamarks', 'notes']]);
  const created = await ws.create({ name: 'keep', repos: [{ owner: 'jamarks', name: 'notes' }] });
  await settle(ws, created.id);
  const dir = join(base, 'workspaces', 'keep');
  await writeFile(join(dir, 'notes', 'draft.md'), 'wip');
  await writeFile(join(dir, 'todo.txt'), 'mine');
  await assert.rejects(ws.remove(created.id, { deleteFolder: true }), (e) => e.status === 409 && /uncommitted/.test(e.message) && /todo\.txt/.test(e.message));
  assert.ok(existsSync(dir));
  git(['add', '.'], join(dir, 'notes')); git(['commit', '-q', '-m', 'wip'], join(dir, 'notes'));
  await assert.rejects(ws.remove(created.id, { deleteFolder: true }), /not pushed/);
  git(['push', '-q', 'origin', 'main'], join(dir, 'notes'));
  await assert.rejects(ws.remove(created.id, { deleteFolder: true }), /todo\.txt/);
  await ws.update(created.id, { remove: [{ owner: 'jamarks', name: 'notes' }] });
  assert.ok(existsSync(join(dir, 'notes')), 'removing a repo from the list keeps its folder');
  await ws.remove(created.id); // entry only
  assert.ok(existsSync(dir));
  assert.deepEqual(await ws.list(), []);
});

test('a clean workspace folder can be deleted', async () => {
  const { base, ws } = await setup([['jamarks', 'notes']]);
  const created = await ws.create({ name: 'gone', repos: [{ owner: 'jamarks', name: 'notes' }] });
  await settle(ws, created.id);
  await ws.remove(created.id, { deleteFolder: true });
  assert.ok(!existsSync(join(base, 'workspaces', 'gone')));
});

test('update renames the entry and adds repos without moving the folder', async () => {
  const { base, ws } = await setup([['jamarks', 'notes'], ['jamarks', 'site']]);
  const created = await ws.create({ name: 'one', repos: [{ owner: 'jamarks', name: 'notes' }] });
  await settle(ws, created.id);
  await ws.update(created.id, { name: 'renamed', add: [{ owner: 'jamarks', name: 'site' }] });
  const w = await settle(ws, created.id);
  assert.equal(w.name, 'renamed');
  assert.equal(w.dir, join(base, 'workspaces', 'one'));
  assert.deepEqual(w.repos.map((r) => r.dir), ['notes', 'site']);
  assert.deepEqual((await readdir(join(base, 'workspaces'))).sort(), ['one']);
});

test('the repo catalog uses the token of each owner and caches', async () => {
  const base = await mkdtemp(join(tmpdir(), 'fox-gh-'));
  const tokens = join(base, 'tokens');
  await mkdir(tokens);
  await writeFile(join(tokens, 'hiorchestra'), 'tok-org\n');
  const log = join(base, 'calls.log');
  const fake = join(base, 'gh');
  await writeFile(fake, `#!/bin/sh
echo "$GH_TOKEN|$*" >> ${log}
case "$*" in
  "api user --jq .login") echo jamarks ;;
  "api user/orgs --jq .[].login") ;;
  "repo list jamarks"*) echo '[{"name":"notes","owner":{"login":"jamarks"},"isPrivate":true,"updatedAt":"2026-10-01T00:00:00Z","description":""}]' ;;
  "repo list hiorchestra"*) echo '[{"name":"orchestra-ops","owner":{"login":"hiOrchestra"},"isPrivate":true,"updatedAt":"2026-10-02T00:00:00Z","description":"ops"}]' ;;
esac
`, { mode: 0o755 });
  let clock = 0;
  const cat = createRepoCatalog({ tokensDir: tokens, gh: fake, now: () => clock });
  const groups = await cat.list();
  assert.deepEqual(groups.map((g) => [g.owner, g.repos.map((r) => r.name)]), [['jamarks', ['notes']], ['hiOrchestra', ['orchestra-ops']]]);
  const calls = (await readFile(log, 'utf8')).trim().split('\n');
  assert.ok(calls.some((c) => c.startsWith('tok-org|repo list hiorchestra')), 'org listed with its own token');
  assert.ok(calls.some((c) => c.startsWith('|repo list jamarks')), 'user listed with the default gh login');
  await cat.list();
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, calls.length, 'second call served from cache');
  clock = 10 * 60 * 1000;
  await cat.list();
  assert.ok((await readFile(log, 'utf8')).trim().split('\n').length > calls.length, 'cache expires');
});
