import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toResume, splitOnce, nextWorking, RESUME_ONCE_MS } from '../restart.mjs';

test('a new tmux server means the sessions that were working there were cut off', () => {
  const saved = { tmuxStart: '100', working: ['a', 'b', 'a'] };
  assert.deepEqual(toResume(saved, '200', new Set()), ['a', 'b']);
  assert.deepEqual(toResume(saved, '200', new Set(['b'])), ['a'], 'one already back is left alone');
});

test('the same tmux server (a deploy, a session you stopped) or nothing remembered resumes nothing', () => {
  assert.deepEqual(toResume({ tmuxStart: '100', working: ['a'] }, '100', new Set()), []);
  assert.deepEqual(toResume(null, '200', new Set()), []);
  assert.deepEqual(toResume({ working: ['a'] }, '200', new Set()), []);
  assert.deepEqual(toResume({ tmuxStart: '100', working: ['a'] }, '', new Set()), [], 'no tmux running yet: wait');
  assert.deepEqual(toResume({ tmuxStart: '100', working: [7, null, 'a'] }, '200', new Set()), ['a']);
});

test('a session is resumed once; cut off again within the hour, it stays as it is', () => {
  const now = 10 * RESUME_ONCE_MS;
  assert.deepEqual(splitOnce(['a', 'b', 'c'], { b: now - 1000, c: now - RESUME_ONCE_MS - 1 }, now), { resume: ['a', 'c'], skip: ['b'] });
  assert.deepEqual(splitOnce(['a'], undefined, now), { resume: ['a'], skip: [] });
});

test('remembers the working sessions of this tmux server and the ones being resumed', () => {
  const terminals = [
    { resume: 'w', activity: 'working' }, { resume: 'r', activity: 'ready' },
    { resume: 'n', activity: 'needs_input' }, { resume: null, activity: 'working' },
  ];
  assert.deepEqual(nextWorking('300', terminals, ['x', 'w']), { tmuxStart: '300', working: ['w', 'x'] });
  assert.deepEqual(nextWorking('300', []), { tmuxStart: '300', working: [] });
});

// The whole path with fox running: it remembered a session working under tmux server "100"; tmux now reports
// "200" (a reboot) and no such session, so fox starts it again in tmux and tells it to continue, once.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTINUE_TEXT } from '../restart.mjs';

const freePort = () => new Promise((resolve, reject) => {
  const server = createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});

test('after a reboot fox resumes the session that was working and tells it to continue', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fox-restart-'));
  const id = 'cut-off-session', idle = 'waiting-session';
  for (const [sid, title] of [[id, 'Working'], [idle, 'Waiting']]) {
    await mkdir(join(home, '.fx', 'sessions', sid), { recursive: true });
    await writeFile(join(home, '.fx', 'sessions', sid, 'session.json'), JSON.stringify({ title, workspace_root: home, updated_at_ms: 10 }));
    await writeFile(join(home, '.fx', 'sessions', sid, 'events.jsonl'), JSON.stringify({ event: { user: { text: 'go' } } }));
  }
  const stateDir = join(home, 'state');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'working.json'), JSON.stringify({ tmuxStart: '100', working: [id] }));
  // A fake tmux that keeps its sessions and options in a file, answers with a ready fx screen and logs the rest.
  const fake = join(home, 'tmux.mjs'), db = join(home, 'tmux.json'), log = join(home, 'tmux.log');
  await writeFile(db, JSON.stringify({ sessions: {} }));
  await writeFile(fake, `#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const db = JSON.parse(readFileSync(${JSON.stringify(db)}, 'utf8'));
const [command, ...args] = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)} + '.all', JSON.stringify([command, ...args]) + '\\n');
const after = (flag) => args[args.indexOf(flag) + 1];
const target = () => String(after('-t') ?? '').replace(/^=/, '');
if (command === 'list-sessions') {
  const fmt = after('-F');
  if (fmt.includes('start_time')) console.log('200');
  else for (const name of Object.keys(db.sessions)) console.log(name + '|1|0');
} else if (command === 'show-options') { const v = db.sessions[target()]?.[args.at(-1)]; if (v) console.log(v); }
else if (command === 'new-session') { db.sessions[after('-s')] = {}; writeFileSync(${JSON.stringify(db)}, JSON.stringify(db)); appendFileSync(${JSON.stringify(log)}, JSON.stringify([command, after('-s')]) + '\\n'); }
else if (command === 'set-option' && db.sessions[target()] && args.at(-2)?.startsWith('@')) { db.sessions[target()][args.at(-2)] = args.at(-1); writeFileSync(${JSON.stringify(db)}, JSON.stringify(db)); }
else if (command === 'capture-pane') console.log('┃');
else if (['set-buffer', 'paste-buffer', 'send-keys'].includes(command)) appendFileSync(${JSON.stringify(log)}, JSON.stringify([command, ...args]) + '\\n');
`);
  await chmod(fake, 0o755);
  const port = await freePort();
  const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, HOME: home, PORT: String(port), FOX_STATE_DIR: stateDir, TMUX_BIN: fake, FOX_AUTH_DISABLED: '1', FOX_IDLE_SLEEP_MIN: '0' }, stdio: 'pipe' });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  try {
    let lines = [];
    for (let i = 0; i < 400 && !lines.some((l) => l[0] === 'send-keys'); i++) {
      await new Promise((r) => setTimeout(r, 100));
      lines = (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    }
    assert.deepEqual(lines.map((l) => l[0]), ['new-session', 'set-buffer', 'paste-buffer', 'send-keys'], out + await readFile(log + '.all', 'utf8').catch(() => 'no tmux calls'));
    assert.equal(lines[0][1], `fx-${id}`, 'only the session that was working, not the one waiting for you');
    assert.equal(lines[1].at(-1), CONTINUE_TEXT);
    assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'working.json'), 'utf8')).tmuxStart, '200');
    const state = JSON.parse(await readFile(join(stateDir, 'state.json'), 'utf8'));
    assert.ok(state.resumed[id] > 0, 'marked for the sidebar and for "once"');
    await new Promise((r) => setTimeout(r, 11_000)); // the next round sees the same tmux server: nothing more
    assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 4);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    await rm(home, { recursive: true, force: true });
  }
});
