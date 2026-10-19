import test from 'node:test';
import assert from 'node:assert/strict';
import { createMission, setMember, missionsOf, missionFor, decorateSessions, prLink } from '../missions.mjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('membership is manual, exclusive, reversible and remains for missing members', () => {
  const missions = [];
  const a = createMission(missions, ' Launch '), b = createMission(missions, 'Follow-up');
  setMember(missions, { type: 'job', id: 'j1', missionId: a.id }, () => true);
  assert.equal(missionFor(missions, 'job', 'j1'), a.id);
  setMember(missions, { type: 'job', id: 'j1', missionId: b.id }, () => false);
  assert.equal(missionFor(missions, 'job', 'j1'), b.id);
  assert.deepEqual(a.members, []);
  assert.deepEqual(missionsOf(JSON.parse(JSON.stringify(missions)))[1].members, [{ type: 'job', id: 'j1' }]);
  setMember(missions, { type: 'job', id: 'j1', missionId: null }, () => false);
  assert.equal(missionFor(missions, 'job', 'j1'), null);
  assert.throws(() => setMember(missions, { type: 'session', id: 'missing', missionId: a.id }, () => false), { status: 404 });
});

test('children inherit without duplicating membership, even through nested parents', () => {
  const missions = []; const m = createMission(missions, 'Work');
  setMember(missions, { type: 'session', id: 'parent', missionId: m.id }, () => true);
  const sessions = decorateSessions([{ id: 'parent' }, { id: 'child', parentId: 'parent' }, { id: 'grandchild', parentId: 'child' }, { id: 'orphan', parentId: 'gone' }], missions);
  assert.deepEqual(sessions.map((s) => s.missionId), [m.id, m.id, m.id, null]);
  assert.equal(m.members.length, 1);
});

test('rejects malformed missions, unknown targets and unsafe PR links', () => {
  const missions = []; const m = createMission(missions, 'One');
  assert.throws(() => createMission(missions, ' '.repeat(8)), { status: 400 });
  assert.throws(() => setMember(missions, { type: 'job', id: 'a', missionId: 'missing' }, () => true), { status: 404 });
  for (const url of ['https://evil.test/repo/pull/1', 'https://github.com/a/b/pull/1?x=1', 'javascript:alert(1)']) {
    assert.equal(prLink(url), false);
    assert.throws(() => setMember(missions, { type: 'pr', id: url, missionId: m.id }, () => true), { status: 400 });
  }
  assert.equal(prLink('https://github.com/acme/project/pull/12'), true);
  assert.deepEqual(missionsOf({}), []);
});

test('mission API validates existing roots and preserves orphaned links', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fox-missions-'));
  const sessionDir = join(home, '.fx', 'sessions');
  for (const id of ['parent', 'child']) {
    await mkdir(join(sessionDir, id), { recursive: true });
    await writeFile(join(sessionDir, id, 'session.json'), JSON.stringify({ title: id, workspace_root: '/repo' }));
  }
  await mkdir(join(sessionDir, 'child', 'subagent'));
  await writeFile(join(sessionDir, 'child', 'subagent', 'owner.json'), JSON.stringify({ parent_id: 'parent' }));
  const port = await new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => resolve(n)); }); });
  const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, HOME: home, PORT: String(port), FOX_JOBS_RUNNER: 'external', FOX_FX_NOTES: '0', FOX_AUTH_DISABLED: '1', TMUX_BIN: '/bin/true' }, stdio: 'pipe' });
  const base = `http://127.0.0.1:${port}`;
  const request = async (path, body) => fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try { ready = (await request('/api/missions')).ok; if (ready) break; } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(ready, 'isolated fox started');
    const created = await request('/api/missions', { name: 'Launch' });
    assert.equal(created.status, 200);
    const mission = await created.json();
    const assign = (type, id) => request('/api/missions/member', { type, id, missionId: mission.id });
    assert.equal((await assign('session', 'missing')).status, 404);
    assert.equal((await assign('session', 'child')).status, 400);
    assert.equal((await assign('pr', 'https://github.com/a/b/pull/1')).status, 404);
    assert.equal((await assign('session', 'parent')).status, 200);
    const overview = await (await request('/api/overview')).json();
    assert.deepEqual(overview.sessions.map((s) => s.missionId), [mission.id, mission.id]);
    await rm(join(sessionDir, 'parent'), { recursive: true });
    const saved = await (await request('/api/missions')).json();
    assert.deepEqual(saved[0].members, [{ type: 'session', id: 'parent' }]);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    await rm(home, { recursive: true, force: true });
  }
});
