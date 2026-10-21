import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = () => new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

test('companion args reach only a fresh fx launch and persist on its session, not a resume', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'fox-companion-'));
  const root = join(home, 'workspaces', 'team'), api = join(root, 'api'), web = join(root, 'web');
  const stateDir = join(home, 'state'), sessionDir = join(home, '.fx', 'sessions', 'session-one');
  t.after(async () => rm(home, { recursive: true, force: true }));
  for (const dir of [api, web, stateDir, sessionDir, join(api, '.git'), join(web, '.git')]) await mkdir(dir, { recursive: true });
  await writeFile(join(stateDir, 'workspaces.json'), JSON.stringify([{ id: 'team', name: 'team', dir: root, repos: [{ owner: 'a', name: 'api', dir: 'api' }, { owner: 'b', name: 'web', dir: 'web' }] }]));
  const tmuxState = join(home, 'tmux.json'), tmux = join(home, 'tmux.mjs'), fx = join(home, 'fx');
  await writeFile(tmux, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const file = ${JSON.stringify(tmuxState)}, args = process.argv.slice(2), [cmd] = args;
const s = JSON.parse(readFileSync(file, 'utf8'));
if (cmd === 'list-sessions') { for (const n of Object.keys(s.sessions)) console.log(n + '|1|0'); }
if (cmd === 'new-session') { s.sessions[args[args.indexOf('-s')+1]] = { cmd: args.at(-1), opts: {} }; }
if (cmd === 'set-option' && args.includes('-t')) { const x = s.sessions[args[args.indexOf('-t')+1]]; if (x) x.opts[args.at(-2)] = args.at(-1); }
if (cmd === 'show-options' && args.includes('-t')) console.log(s.sessions[args[args.indexOf('-t')+1]]?.opts[args.at(-1)] ?? '');
if (cmd === 'capture-pane') console.log('┃');
writeFileSync(file, JSON.stringify(s));
`);
  await chmod(tmux, 0o755);
  await writeFile(tmuxState, JSON.stringify({ sessions: {} }));
  await writeFile(fx, '#!/bin/sh\necho \'{"connected_providers":[]}\'\n', { mode: 0o755 });
  const p = await port(), base = `http://127.0.0.1:${p}`;
  const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, HOME: home, FOX_STATE_DIR: stateDir, FX_BIN: fx, TMUX_BIN: tmux, PORT: String(p), FOX_AUTH_DISABLED: '1', FOX_JOBS_RUNNER: 'external', FOX_MEMORY_HIGH_PCT: '0', FOX_IDLE_SLEEP_MIN: '0' }, stdio: 'pipe' });
  t.after(async () => { child.kill(); if (child.exitCode === null) await new Promise((r) => child.once('exit', r)); });
  let ready = false;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/config`)).ok) { ready = true; break; } } catch {} await new Promise((r) => setTimeout(r, 50)); }
  assert.ok(ready, 'server started');
  const get = (path) => fetch(base + path).then((r) => r.json());
  const post = async (body) => { const r = await fetch(base + '/api/terminals', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) }); return [r.status, await r.json()]; };
  assert.deepEqual((await get('/api/companion-repos?cwd=' + encodeURIComponent(api))).map((r) => r.dir), [web]);
  for (const addDirs of [[api], [web, web], [home], web, [web + '/..']]) assert.equal((await post({ cwd: api, addDirs }))[0], 400);
  assert.equal((await post({ cwd: api, resume: 'session-one', addDirs: [web] }))[0], 400);
  assert.deepEqual(JSON.parse(await readFile(tmuxState, 'utf8')).sessions, {});
  const [status, launched] = await post({ cwd: api, addDirs: [web] });
  assert.equal(status, 200);
  const command = JSON.parse(await readFile(tmuxState, 'utf8')).sessions[launched.name].cmd;
  assert.equal(command, `'${fx}' '--no-additional-dirs' '--add-dir' '${web}'`);
  assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'state.json'), 'utf8')).pendingDirs[launched.name], [web]);
  const renamed = await fetch(base + '/api/sessions/session-one/rename', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Named' }) });
  assert.equal(renamed.status, 200);
  assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'state.json'), 'utf8')).pendingDirs[launched.name], [web]);
  const [secondStatus, second] = await post({ cwd: api, addDirs: [web] });
  assert.equal(secondStatus, 200);
  assert.notEqual(second.name, launched.name);
  await writeFile(join(sessionDir, 'session.json'), JSON.stringify({ title: 'One', workspace_root: api, created_at_ms: 1000, updated_at_ms: 1000 }));
  const secondDir = join(home, '.fx', 'sessions', 'session-two');
  await mkdir(secondDir);
  await writeFile(join(secondDir, 'session.json'), JSON.stringify({ title: 'Two', workspace_root: api, created_at_ms: 2000, updated_at_ms: 2000 }));
  const terminals = await get('/api/terminals');
  assert.deepEqual(new Set(terminals.map((t) => t.resume)), new Set(['session-one', 'session-two']));
  assert.deepEqual((await get('/api/sessions')).map((s) => s.addDirs), [[web], [web]]);
  const stored = JSON.parse(await readFile(join(stateDir, 'state.json'), 'utf8'));
  assert.deepEqual(stored.launchDirs['session-one'], [web]);
  assert.deepEqual(stored.launchDirs['session-two'], [web]);
  assert.equal(Object.hasOwn(stored.pendingDirs, launched.name), false);
  assert.equal(Object.hasOwn(stored.pendingDirs, second.name), false);
  assert.equal((await post({ cwd: api, resume: 'session-one' }))[0], 200);
  const sessions = Object.values(JSON.parse(await readFile(tmuxState, 'utf8')).sessions);
  assert.ok(sessions.some((s) => s.cmd === `'${fx}' 'session' 'resume' 'session-one'`));
  assert.deepEqual((await get('/api/sessions'))[0].addDirs, [web]);
  const [plainStatus, plain] = await post({ cwd: root });
  assert.equal(plainStatus, 200);
  assert.equal(JSON.parse(await readFile(tmuxState, 'utf8')).sessions[plain.name].cmd, `'${fx}' '--no-additional-dirs'`);
  const [outsideStatus, outside] = await post({ cwd: home });
  assert.equal(outsideStatus, 200);
  assert.equal(JSON.parse(await readFile(tmuxState, 'utf8')).sessions[outside.name].cmd, `'${fx}'`);
});
