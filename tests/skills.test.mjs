import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSkills, SOURCES } from '../skills.mjs';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'fox-skills-'));
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(home, { recursive: true, force: true }); });
  const ws = { id: 'one', name: 'project', dir: join(home, 'workspaces/project'), repos: [{ dir: 'repo' }] };
  await mkdir(join(ws.dir, 'repo'), { recursive: true });
  const files = { 'skills/example/SKILL.md': '---\nname: example\ndescription: Test the preview.\n---\n# Sample\nDo not run scripts.', 'skills/example/docs/notes.md': 'Notes' };
  const tree = Object.entries(files).map(([path, text], i) => ({ path, type: 'blob', mode: '100644', sha: String(i + 1).padStart(40, 'a'), size: Buffer.byteLength(text) }));
  const gh = async ([url]) => url.includes('/trees/') ? JSON.stringify({ tree }) : JSON.stringify({ encoding: 'base64', content: Buffer.from(files[tree.find((x) => url.endsWith(x.sha)).path]).toString('base64') });
  return { home, ws, tree, files, gh, api: (override = {}) => createSkills({ home, stateDir: join(home, 'state'), workspaces: { get: async (id) => id === ws.id ? ws : null, list: async () => [ws] }, gh, ...override }) };
}

test('catalog sources are shipped as data', () => assert.deepEqual(SOURCES, ['vercel-labs/skills', 'anthropics/skills', 'mattpocock/skills', 'vercel-labs/agent-browser']));
test('discovers user and workspace skills, not the repos\' own, without following linked folders', async (t) => {
  const f = await fixture(t);
  for (const dir of [join(f.home, '.claude/skills/borrowed'), join(f.ws.dir, '.fx/skills/local'), join(f.ws.dir, 'repo/skills/inside')]) {
    await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'SKILL.md'), '---\nname: custom\ndescription: Shared.\n---\n# Instructions');
  }
  await symlink(join(f.home, '.claude/skills/borrowed'), join(f.home, '.claude/skills/linked'));
  await mkdir(join(f.home, 'private/skills/secret'), { recursive: true });
  await writeFile(join(f.home, 'private/skills/secret/SKILL.md'), '---\nname: secret\n---\nPrivate data');
  await symlink(join(f.home, 'private'), join(f.home, '.agents'));
  await symlink(join(f.home, 'private'), join(f.ws.dir, 'repo/.claude'));
  const api = f.api(); const list = await api.list();
  assert.equal(list.items.length, 2);
  assert.deepEqual(list.items.map((s) => s.group), ['Claude Code', 'project · workspace']);
  assert.equal(list.items[0].owned, false);
  assert.match((await api.read(list.items[0].id)).text, /Instructions/);
  await assert.rejects(() => api.remove(list.items[0].id), /Only skills installed by fox/);
});
test('preview shows files and markdown before writing; install is confirmed and removal refuses edits', async (t) => {
  const f = await fixture(t), api = f.api();
  const p = await api.preview({ source: 'vercel-labs/skills', scope: 'workspace:one', dirs: ['skills/example'] });
  assert.equal(p.skills[0].files.length, 2);
  assert.match(p.skills[0].text, /Do not run scripts/);
  assert.deepEqual(await readdir(f.ws.dir), ['repo']);
  await api.install(p.token);
  await assert.rejects(() => api.install(p.token), /expired/);
  const id = (await api.list()).items.find((s) => s.name === 'example').id;
  assert.equal((await api.list()).items.find((s) => s.id === id).owned, true);
  assert.equal((await api.read(id)).source, 'vercel-labs/skills');
  assert.equal(await readFile(join(f.ws.dir, '.fx/skills/example/docs/notes.md'), 'utf8'), 'Notes');
  await writeFile(join(f.ws.dir, '.fx/skills/example/SKILL.md'), 'changed');
  await assert.rejects(() => api.remove(id), /changed/);
  await writeFile(join(f.ws.dir, '.fx/skills/example/SKILL.md'), f.files['skills/example/SKILL.md']);
  await mkdir(join(f.ws.dir, '.fx/skills/example/extra'));
  await assert.rejects(() => api.remove(id), /changed/, 'even an added empty directory is user-owned');
  const { rm } = await import('node:fs/promises'); await rm(join(f.ws.dir, '.fx/skills/example/extra'), { recursive: true });
  await api.remove(id);
  assert.equal((await api.list()).items.some((s) => s.name === 'example'), false);
});
test('browse lists skills under skills/, grouped folders too, not a skill\'s own material or other folders', async (t) => {
  const f = await fixture(t);
  f.tree.push({ path: 'skill-data/internal/SKILL.md', type: 'blob', mode: '100644', sha: 'b'.repeat(40), size: 50 });
  f.files['skills/example/docs/internal/SKILL.md'] = 'nested resource';
  f.tree.push({ path: 'skills/example/docs/internal/SKILL.md', type: 'blob', mode: '100644', sha: 'c'.repeat(40), size: 15 });
  f.files['skills/engineering/tdd/SKILL.md'] = '---\nname: tdd\ndescription: Small steps.\n---\n# TDD';
  f.tree.push({ path: 'skills/engineering/tdd/SKILL.md', type: 'blob', mode: '100644', sha: 'd'.repeat(40), size: Buffer.byteLength(f.files['skills/engineering/tdd/SKILL.md']) });
  f.tree.push({ path: 'skills/engineering/tdd/big.txt', type: 'blob', mode: '100644', sha: 'e'.repeat(40), size: 2_000_000 });
  const api = f.api(), b = await api.browse({ source: 'x/y' });
  assert.deepEqual(b.skills.map((s) => [s.dir, s.name, s.description, s.problem]), [
    ['skills/engineering/tdd', 'tdd', 'Small steps.', 'has a file over 1 MB'],
    ['skills/example', 'example', 'Test the preview.', null],
  ]);
  assert.deepEqual(await api.catalog().then((c) => c.repos.map((r) => r.count)), [2, 2, 2, 2]);
  await assert.rejects(() => api.preview({ source: 'x/y', scope: 'global', dirs: ['skills/engineering/tdd'] }), /tdd: has a file over 1 MB/);
  await assert.rejects(() => api.preview({ source: 'x/y', scope: 'global', dirs: ['skills/example/docs/internal'] }), /not in this repository/);
  await assert.rejects(() => api.preview({ source: 'x/y', scope: 'global', dirs: [] }), /at least one/);
  assert.deepEqual((await api.preview({ source: 'x/y', scope: 'global', dirs: ['skills/example'] })).skills.map((s) => s.name), ['example']);
});
test('accepts folded YAML descriptions and rejects empty descriptions', async (t) => {
  const f = await fixture(t);
  f.files['skills/example/SKILL.md'] = '---\nname: example\ndescription: >\n  Useful for tests\n  and safety.\n---\n# Sample';
  f.tree[0].size = Buffer.byteLength(f.files['skills/example/SKILL.md']);
  const p = await f.api().preview({ source: 'x/y', scope: 'global', dirs: ['skills/example'] });
  assert.equal(p.skills[0].description, 'Useful for tests and safety.');
  f.files['skills/example/SKILL.md'] = '---\nname: example\ndescription: >\n---\n# Sample';
  f.tree[0].size = Buffer.byteLength(f.files['skills/example/SKILL.md']);
  await assert.rejects(() => f.api().preview({ source: 'x/y', scope: 'global', dirs: ['skills/example'] }), /name and description/);
});
test('rejects unsafe paths, symlinks, oversized files, collisions and unsafe destinations', async (t) => {
  const f = await fixture(t), api = f.api();
  await assert.rejects(() => api.preview({ source: '../../etc', scope: 'global' }), /owner\/repo/);
  const one = { source: 'x/y', scope: 'global', dirs: ['skills/example'] };
  f.tree[1].mode = '120000';
  await assert.rejects(() => api.preview(one), /links/);
  f.tree[1].mode = '100644'; f.tree[1].size = 2_000_000;
  await assert.rejects(() => api.preview(one), /over 1 MB/);
  f.tree[1].size = Buffer.byteLength(f.files['skills/example/docs/notes.md']);
  const p = await api.preview(one);
  await mkdir(join(f.home, '.fx/skills/example'), { recursive: true });
  await assert.rejects(() => api.install(p.token), /already exists/);
  const p2 = await api.preview(one);
  const { rm } = await import('node:fs/promises'); await rm(join(f.home, '.fx/skills'), { recursive: true });
  await symlink(f.ws.dir, join(f.home, '.fx/skills'));
  await assert.rejects(() => api.install(p2.token), /symlink/);
});
