import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSkills, SOURCES, parseSkillSource } from '../skills.mjs';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'fox-skills-'));
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(home, { recursive: true, force: true }); });
  const ws = { id: 'one', name: 'project', dir: join(home, 'workspaces/project'), repos: [{ dir: 'repo' }] };
  await mkdir(join(ws.dir, 'repo'), { recursive: true });
  const files = { 'skills/example/SKILL.md': '---\nname: example\ndescription: Test the preview.\n---\n# Sample\nDo not run scripts.', 'skills/example/docs/notes.md': 'Notes' };
  const tree = Object.entries(files).map(([path, text], i) => ({ path, type: 'blob', mode: '100644', sha: String(i + 1).padStart(40, 'a'), size: Buffer.byteLength(text) }));
  const gh = async ([url]) => url.includes('/trees/') ? JSON.stringify({ tree }) : JSON.stringify({ encoding: 'base64', content: Buffer.from(files[tree.find((x) => url.endsWith(x.sha)).path]).toString('base64') });
  return { home, ws, tree, files, gh, api: (override = {}) => createSkills({ home, stateDir: join(home, 'state'), workspaces: { get: async (id) => id === ws.id ? ws : null, list: async () => [ws] }, gh, web: async () => { throw Object.assign(new Error('not found'), { status: 404 }); }, ...override }) };
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
  assert.equal(list.catalog, false);
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
  assert.equal(await readFile(join(f.ws.dir, '.claude/skills/example/docs/notes.md'), 'utf8'), 'Notes');
  await writeFile(join(f.ws.dir, '.claude/skills/example/SKILL.md'), 'changed');
  await assert.rejects(() => api.remove(id), /changed/);
  await writeFile(join(f.ws.dir, '.claude/skills/example/SKILL.md'), f.files['skills/example/SKILL.md']);
  await mkdir(join(f.ws.dir, '.claude/skills/example/extra'));
  await assert.rejects(() => api.remove(id), /changed/, 'even an added empty directory is user-owned');
  const { rm } = await import('node:fs/promises'); await rm(join(f.ws.dir, '.claude/skills/example/extra'), { recursive: true });
  await api.remove(id);
  assert.equal((await api.list()).items.some((s) => s.name === 'example'), false);
});
test('installs where Claude Code and fx both read; an earlier install in .fx/skills still blocks a duplicate and can be removed', async (t) => {
  const f = await fixture(t), api = f.api();
  await api.install((await api.preview({ source: 'x/y', scope: 'global', dirs: ['skills/example'] })).token);
  assert.match(await readFile(join(f.home, '.claude/skills/example/SKILL.md'), 'utf8'), /Do not run scripts/);
  const { rename } = await import('node:fs/promises');
  await mkdir(join(f.home, '.fx/skills'), { recursive: true });
  await rename(join(f.home, '.claude/skills/example'), join(f.home, '.fx/skills/example'));
  const records = JSON.parse(await readFile(join(f.home, 'state/skills.json'), 'utf8'));
  records['global|example'].path = join(f.home, '.fx/skills/example');
  await writeFile(join(f.home, 'state/skills.json'), JSON.stringify(records));
  const again = await api.preview({ source: 'x/y', scope: 'global', dirs: ['skills/example'] });
  await assert.rejects(() => api.install(again.token), /already exists/);
  const legacy = (await api.list()).items.find((s) => s.name === 'example');
  assert.equal(legacy.owned, true);
  await api.remove(legacy.id);
  assert.deepEqual(await readdir(join(f.home, '.fx/skills')), []);
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
  const peek = await api.peek({ source: 'x/y', dir: 'skills/example' });
  assert.match(peek.text, /Do not run scripts/);
  assert.deepEqual(peek.files.map((f) => f.name).sort(), ['SKILL.md', 'docs/internal/SKILL.md', 'docs/notes.md']);
  await assert.rejects(() => api.peek({ source: 'x/y', dir: 'skills/example/docs/internal' }), /not in this repository/);
  await assert.rejects(() => api.preview({ source: 'x/y', scope: 'global', dirs: ['skills/engineering/tdd'] }), /tdd: has a file over 1 MB/);
  await assert.rejects(() => api.preview({ source: 'x/y', scope: 'global', dirs: ['skills/example/docs/internal'] }), /not in this repository/);
  await assert.rejects(() => api.preview({ source: 'x/y', scope: 'global', dirs: [] }), /at least one/);
  assert.deepEqual((await api.preview({ source: 'x/y', scope: 'global', dirs: ['skills/example'] })).skills.map((s) => s.name), ['example']);
});
test('catalog needs a token file, re-reads rotated tokens, and only accepts GitHub skills', async (t) => {
  const f = await fixture(t), tokenFile = join(f.home, 'token.env'), calls = [];
  const web = async (url, headers) => { calls.push({ url, headers }); return JSON.stringify({ data: [
    { sourceType: 'github', source: 'x/y', slug: 'example', name: 'Example', installs: 5 },
    { sourceType: 'well-known', source: 'example.com', slug: 'other' },
    { sourceType: 'github', source: 'x/y', slug: '../bad' },
  ] }); };
  const api = f.api({ tokenFile, web });
  await assert.rejects(() => api.popular(), /server token/);
  assert.equal(calls.length, 0);
  await writeFile(tokenFile, 'VERCEL_OIDC_TOKEN="one"\n');
  assert.deepEqual((await api.popular()).skills.map((s) => s.skill), ['example']);
  assert.match(calls[0].url, /api\/v1\/skills\?view=trending/);
  assert.equal(calls[0].headers.Authorization, 'Bearer one');
  await writeFile(tokenFile, 'VERCEL_OIDC_TOKEN="two"\n');
  await api.search({ q: 'hello' });
  assert.equal(calls[1].headers.Authorization, 'Bearer two');
  assert.match(calls[1].url, /api\/v1\/skills\/search\?q=hello/);
  await assert.rejects(() => api.search({ q: 'h' }), /2 characters/);
  const curated = f.api({ tokenFile, web: async () => JSON.stringify({ data: [{ skills: [{ sourceType: 'github', source: 'x/y', slug: 'example' }] }] }) });
  assert.equal((await curated.curated()).skills[0].skill, 'example');
  f.files['.claude/skills/helper/SKILL.md'] = '---\nname: helper\ndescription: Helps.\n---\n# Helper';
  f.tree.push({ path: '.claude/skills/helper/SKILL.md', type: 'blob', mode: '100644', sha: 'f'.repeat(40), size: Buffer.byteLength(f.files['.claude/skills/helper/SKILL.md']) });
  assert.match((await api.peek({ source: 'x/y', dir: 'example' })).text, /Do not run scripts/);
  assert.deepEqual((await api.preview({ source: 'x/y', scope: 'global', dirs: ['example', 'helper'] })).skills.map((s) => s.name), ['example', 'helper']);
});
test('skills.sh links select exactly one skill; unsafe URLs are rejected', async (t) => {
  const f = await fixture(t), api = f.api();
  assert.deepEqual(parseSkillSource('https://skills.sh/x/y/example'), { source: 'x/y', skill: 'example' });
  assert.deepEqual(parseSkillSource('x/y'), { source: 'x/y', skill: null });
  assert.equal((await api.browse({ source: 'https://skills.sh/x/y/example' })).skills[0].dir, 'example');
  for (const url of ['https://evil.test/x/y/example', 'https://skills.sh/x/y/../bad', 'https://skills.sh/x/y/example?x=1', 'x/../y']) assert.throws(() => parseSkillSource(url));
});
test('audits are displayed and failed or high-risk audits require a second confirmation', async (t) => {
  const f = await fixture(t), urls = [];
  const api = f.api({ web: async (url) => { urls.push(url); return JSON.stringify({ audits: [
    { provider: 'Socket', status: 'pass', summary: 'OK', riskLevel: 'LOW' },
    { provider: 'Snyk', status: 'warn', summary: 'Danger', riskLevel: 'HIGH' },
  ] }); } });
  const p = await api.preview({ source: 'x/y', dirs: ['example'], scope: 'global' });
  assert.equal(p.skills[0].audit.status, 'fail');
  await assert.rejects(() => api.install(p.token), /explicitly confirm/);
  await api.install(p.token, true);
  const item = (await api.list()).items.find((s) => s.name === 'example');
  assert.equal(item.audit.entries[1].riskLevel, 'HIGH');
  assert.equal(urls.length, 1, 'installed audits use the cached result');
  const absent = f.api({ web: async () => { throw Object.assign(new Error('missing'), { status: 404 }); } });
  assert.equal((await absent.audit('x/y', 'example')).reason, 'Not audited yet');
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
  await mkdir(join(f.home, '.claude/skills/example'), { recursive: true });
  await assert.rejects(() => api.install(p.token), /already exists/);
  const p2 = await api.preview(one);
  const { rm } = await import('node:fs/promises'); await rm(join(f.home, '.claude/skills'), { recursive: true });
  await symlink(f.ws.dir, join(f.home, '.claude/skills'));
  await assert.rejects(() => api.install(p2.token), /symlink/);
});
