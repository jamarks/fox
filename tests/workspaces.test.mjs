import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, readdir, symlink } from 'node:fs/promises';
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

test('companion access accepts only distinct cloned sibling repos, never symlinks or outside paths', async () => {
  const { base, ws } = await setup([['a', 'api'], ['b', 'web'], ['c', 'docs']]);
  const created = await ws.create({ name: 'team', repos: [{ owner: 'a', name: 'api' }, { owner: 'b', name: 'web' }, { owner: 'c', name: 'docs' }] });
  await settle(ws, created.id);
  const root = created.dir, api = join(root, 'api'), web = join(root, 'web'), docs = join(root, 'docs');
  assert.deepEqual((await ws.companions(api)).map((r) => r.dir), [web, docs]);
  assert.deepEqual(await ws.companions(root), [], 'the workspace root already includes every repo');
  await assert.rejects(ws.validateCompanions(root, [web]), (e) => e.status === 400);
  assert.deepEqual(await ws.validateCompanions(api, [web, docs]), [web, docs]);
  assert.deepEqual(await ws.validateCompanions(api, []), []);
  for (const dirs of [web, [web, web], [api], [join(root, '..', 'other')], [web + '/..'], [42], Array(33).fill(web)])
    await assert.rejects(ws.validateCompanions(api, dirs), (e) => e.status === 400);
  await assert.rejects(ws.validateCompanions(join(base, 'outside'), [web]), (e) => e.status === 400);
  await symlink(web, join(root, 'shortcut'));
  await assert.rejects(ws.validateCompanions(join(root, 'shortcut'), [web]), (e) => e.status === 400);
  // A configured repo turned into a link must disappear, even if it points back inside the workspace.
  await ws.update(created.id, { remove: [{ owner: 'b', name: 'web' }] });
  await ws.update(created.id, { add: [{ owner: 'b', name: 'linked' }] });
  await symlink(web, join(root, 'linked'));
  assert.deepEqual((await ws.companions(api)).map((r) => r.dir), [docs]);
  await assert.rejects(ws.validateCompanions(api, [join(root, 'linked')]), (e) => e.status === 400);
});

test('companion access accepts a linked workspace parent but not a linked repo folder', async () => {
  const { base } = await setup([['a', 'api'], ['b', 'web']]);
  await symlink(base, join(base, 'alias'));
  const ws = createWorkspaces({
    stateDir: join(base, 'linked-state'), rootDir: join(base, 'alias', 'workspaces'),
    remoteUrl: (r) => join(base, 'remotes', r.owner, `${r.name}.git`),
  });
  const created = await ws.create({ name: 'team', repos: [{ owner: 'a', name: 'api' }, { owner: 'b', name: 'web' }] });
  await settle(ws, created.id);
  const root = created.dir, api = join(root, 'api'), web = join(root, 'web');
  assert.deepEqual((await ws.companions(api)).map((r) => r.dir), [web]);
  assert.deepEqual(await ws.validateCompanions(api, [web]), [web]);
  assert.deepEqual(await ws.companions(root), []);
  await assert.rejects(ws.validateCompanions(join(base, 'remotes'), [web]), (e) => e.status === 400);
  await ws.update(created.id, { add: [{ owner: 'b', name: 'linked' }] });
  await symlink(web, join(root, 'linked'));
  assert.deepEqual((await ws.companions(api)).map((r) => r.dir), [web]);
  await assert.rejects(ws.validateCompanions(api, [join(root, 'linked')]), (e) => e.status === 400);
});

test('same repo name from two owners gets separate folders', async () => {
  const { ws } = await setup([['a', 'api'], ['b', 'api']]);
  const created = await ws.create({ name: 'two', repos: [{ owner: 'a', name: 'api' }, { owner: 'b', name: 'api' }] });
  const w = await settle(ws, created.id);
  assert.deepEqual(w.repos.map((r) => r.dir), ['api', 'api-b']);
});

test('adding another repo preserves a removed checkout and uses a free folder', async () => {
  const { ws } = await setup([['alpha', 'api'], ['beta', 'api']]);
  const created = await ws.create({ name: 'team', repos: [{ owner: 'alpha', name: 'api' }] });
  await settle(ws, created.id);
  const old = join(created.dir, 'api');
  await writeFile(join(old, 'identity.txt'), 'alpha');
  await ws.update(created.id, { remove: [{ owner: 'alpha', name: 'api' }] });
  await ws.update(created.id, { add: [{ owner: 'beta', name: 'api' }] });
  const listed = await settle(ws, created.id);
  assert.deepEqual(listed.repos.map((r) => [r.owner, r.dir, r.status]), [['beta', 'api-beta', 'ready']]);
  assert.equal(await readFile(join(old, 'identity.txt'), 'utf8'), 'alpha');
  assert.match(git(['remote', 'get-url', 'origin'], old), /alpha\/api\.git$/);
  assert.match(git(['remote', 'get-url', 'origin'], join(created.dir, 'api-beta')), /beta\/api\.git$/);
});

test('a checkout with a different origin is never ready or offered as a companion', async () => {
  const { base, ws } = await setup([['alpha', 'api'], ['beta', 'api'], ['beta', 'web']]);
  const created = await ws.create({ name: 'team', repos: [{ owner: 'beta', name: 'api' }, { owner: 'beta', name: 'web' }] });
  await settle(ws, created.id);
  const api = join(created.dir, 'api'), web = join(created.dir, 'web');
  git(['remote', 'set-url', 'origin', join(base, 'remotes', 'alpha', 'api.git')], api);
  assert.deepEqual((await ws.list())[0].repos.map((r) => r.status), ['error', 'ready']);
  assert.match((await ws.list())[0].repos[0].error, /origin does not match/);
  assert.deepEqual(await ws.companions(web), []);
  await assert.rejects(ws.validateCompanions(web, [api]), (e) => e.status === 400);
  await ws.retry(created.id);
  assert.equal((await ws.list())[0].repos[0].status, 'error');
  assert.match(git(['remote', 'get-url', 'origin'], api), /alpha\/api\.git$/);
  await assert.rejects(ws.remove(created.id, { deleteFolder: true }), /api: checkout origin does not match/);
  assert.ok(existsSync(api));
  assert.equal(await ws.originMatches(created, created.repos[0]), false);
});

test('origin identity uses the configured URL even with a global insteadOf rewrite', async () => {
  const { base, ws } = await setup([['beta', 'api']]);
  const created = await ws.create({ name: 'team', repos: [{ owner: 'beta', name: 'api' }] });
  await settle(ws, created.id);
  const config = join(base, 'gitconfig');
  await writeFile(config, `[url "ssh://example.invalid/"]\n\tinsteadOf = ${join(base, 'remotes')}/\n`);
  const previous = process.env.GIT_CONFIG_GLOBAL;
  try {
    process.env.GIT_CONFIG_GLOBAL = config;
    assert.equal(await ws.originMatches(created, created.repos[0]), true);
    assert.equal((await ws.list())[0].repos[0].status, 'ready');
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
  }
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

test('update adds repos; the name is the folder and does not change', async () => {
  const { base, ws } = await setup([['jamarks', 'notes'], ['jamarks', 'site']]);
  const created = await ws.create({ name: 'one', repos: [{ owner: 'jamarks', name: 'notes' }] });
  await settle(ws, created.id);
  await assert.rejects(ws.update(created.id, { name: 'renamed' }), /cannot change/);
  await ws.update(created.id, { name: 'one', add: [{ owner: 'jamarks', name: 'site' }] });
  const w = await settle(ws, created.id);
  assert.equal(w.name, 'one');
  assert.deepEqual(w.repos.map((r) => r.dir), ['notes', 'site']);
  assert.deepEqual((await readdir(join(base, 'workspaces'))).sort(), ['one']);
});

test('an empty workspace is a plain folder, and two workspaces never share one', async () => {
  const { base, ws } = await setup([]);
  const empty = await ws.create({ name: 'scratch' });
  assert.deepEqual(empty.repos, []);
  assert.ok(existsSync(join(base, 'workspaces', 'scratch')));
  await assert.rejects(ws.create({ name: 'scratch' }), /already exists/);
  await mkdir(join(base, 'workspaces', 'leftover', 'x'), { recursive: true });
  await assert.rejects(ws.create({ name: 'leftover' }), /not empty/);
  await ws.remove(empty.id, { deleteFolder: true });
  assert.ok(!existsSync(join(base, 'workspaces', 'scratch')));
});

test('the AGENTS.md fox writes is fox\'s own: it does not block deleting the folder unless you edited it', async () => {
  const base = await mkdtemp(join(tmpdir(), 'fox-ws-'));
  const ws = createWorkspaces({ stateDir: join(base, 'state'), rootDir: join(base, 'workspaces'), agentNotes: () => '# notes\n' });
  await mkdir(join(base, 'workspaces'), { recursive: true });
  const a = await ws.create({ name: 'a' });
  assert.equal(await readFile(join(base, 'workspaces', 'a', 'AGENTS.md'), 'utf8'), '# notes\n');
  assert.deepEqual(await ws.blockers(a.id), []);
  await writeFile(join(base, 'workspaces', 'a', 'AGENTS.md'), '# my own notes\n');
  assert.deepEqual(await ws.blockers(a.id), ['AGENTS.md: not one of the workspace repos']);
});

test('a workspace made before the notes gets them, they follow its repos, and fox stops at your edits', async () => {
  const base = await mkdtemp(join(tmpdir(), 'fox-ws-'));
  const stateDir = join(base, 'state'), dir = join(base, 'workspaces', 'old');
  await mkdir(dir, { recursive: true }); await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'workspaces.json'), JSON.stringify([{ id: 'w1', name: 'old', dir, repos: [{ owner: 'o', name: 'r', dir: 'r' }] }]));
  const notes = (w) => `# notes\n${w.repos.map((r) => `- ${r.dir}: ${r.owner}/${r.name}`).join('\n')}\n`;
  const ws = createWorkspaces({ stateDir, rootDir: join(base, 'workspaces'), agentNotes: notes, git: async () => '' });
  await ws.list();
  assert.equal(await readFile(join(dir, 'AGENTS.md'), 'utf8'), '# notes\n- r: o/r\n', 'written for a workspace that had none');
  await ws.update('w1', { add: [{ owner: 'o', name: 's' }] });
  assert.equal(await readFile(join(dir, 'AGENTS.md'), 'utf8'), '# notes\n- r: o/r\n- s: o/s\n', 'follows the repos while it is fox\'s text');
  await writeFile(join(dir, 'AGENTS.md'), '# mine\n');
  await ws.update('w1', { remove: [{ owner: 'o', name: 's' }] });
  assert.equal(await readFile(join(dir, 'AGENTS.md'), 'utf8'), '# mine\n', 'an edited file is yours');
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
