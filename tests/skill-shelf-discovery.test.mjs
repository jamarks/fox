// fx's shelf reads metadata only, within its documented project/personal discovery roots.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSkills } from '../skill-shelf.mjs';

const skill = (name, description = 'Review changes') => `---\nname: ${name}\ndescription: ${description}\n---\n# Instructions\nSECRET BODY\n`;
async function add(root, name, text) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), text);
}

test('scans repo, parents before home and personal roots, not sibling repos or other folders', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'fox-skills-')); t.after(() => rm(home, { recursive: true, force: true }));
  const repo = join(home, 'workspaces', 'team', 'repo'); await mkdir(repo, { recursive: true });
  await add(join(repo, '.fx/skills'), 'review', skill('review', 'Review changes'));
  await add(join(home, 'workspaces', 'team', 'skills'), 'parent', skill('parent'));
  await add(join(home, '.fx/skills'), 'personal', skill('personal'));
  await add(join(home, '.config/opencode/skills'), 'compat', skill('compat'));
  await add(join(home, 'skills'), 'not-a-project-root', skill('not-a-project-root'));
  await add(join(home, 'workspaces', 'team', 'other', 'skills'), 'sibling', skill('sibling'));
  const rows = await listSkills(repo, home);
  assert.deepEqual(rows.map((r) => r.name), ['review', 'parent', 'personal', 'compat']);
  assert.equal(rows[0].source, 'Project · .fx/skills');
  assert.equal(rows[2].source, 'Personal · .fx/skills');
  assert.doesNotMatch(JSON.stringify(rows), /SECRET BODY/);
});

test('outside-home sessions do not scan unrelated ancestors', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'fox-skills-')); t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home'), repo = join(base, 'repo');
  await mkdir(home); await mkdir(repo);
  await add(join(base, '.fx/skills'), 'ancestor', skill('ancestor'));
  await add(join(repo, '.fx/skills'), 'local', skill('local'));
  assert.deepEqual((await listSkills(repo, home)).map((s) => s.name), ['local']);
});

test('refuses symlinks and invalid headers, and bounds names, descriptions and bytes', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'fox-skills-')); t.after(() => rm(home, { recursive: true, force: true }));
  const repo = join(home, 'repo'), outside = join(home, 'elsewhere');
  await mkdir(repo); await mkdir(outside);
  await add(join(outside, 'skills'), 'secret', skill('secret'));
  await symlink(join(outside, 'skills'), join(repo, 'skills'));
  const root = join(repo, '.fx/skills');
  await add(root, 'good', skill('good'));
  await add(root, 'long-body', skill('long-body', 'a'.repeat(180)) + 'x'.repeat(9000));
  await add(root, 'folded', '---\r\nname: folded\r\ndescription: >\r\n  Review tests\r\n  before release\r\n---\r\n# Instructions\r\n');
  await add(root, 'no-header', '# Just instructions');
  await add(root, 'bad-name', skill('bad\nInjected'));
  await add(root, 'bad-desc', skill('bad-desc', 'Oops\u0007terminal'));
  await add(root, 'unclosed', '---\nname: unclosed\n');
  await add(root, 'huge', skill('huge') + 'x'.repeat(128 * 1024));
  await symlink(join(outside, 'skills', 'secret'), join(root, 'linked'));
  await mkdir(join(root, 'file-link'));
  await symlink(join(outside, 'skills', 'secret', 'SKILL.md'), join(root, 'file-link', 'SKILL.md'));
  const rows = await listSkills(repo, home);
  assert.deepEqual(rows.map((r) => r.name), ['folded', 'good', 'long-body', 'no-header']);
  assert.equal(rows[0].description, 'Review tests before release');
  assert.equal(rows[2].description.length, 160);
  await assert.rejects(() => listSkills(join(home, 'missing'), home), { status: 400 });
  await assert.rejects(() => listSkills('../'.repeat(2200), home), { status: 400 });
});
