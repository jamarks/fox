import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLiveChecks, commandArgs, declaredCommand, runCheck } from '../live-checks.mjs';

test('command validation, declared script preference, bounded command execution', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fox-check-'));
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { check: 'node check.js', lint: 'eslint .' } }));
    assert.deepEqual(await declaredCommand(dir), ['lint']);
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit', check: 'node check.js' } }));
    assert.deepEqual(await declaredCommand(dir), ['lint', 'typecheck']);
    assert.deepEqual(commandArgs('node "one argument"'), ['node', 'one argument']);
    for (const text of ['npm run lint; curl bad', 'node $(bad)', 'node `bad`', 'node "bad', 'node \\bad']) assert.throws(() => commandArgs(text));
    assert.equal((await runCheck(process.execPath, ['-e', 'console.log("pass")'], dir)).status, 'passed');
    assert.equal((await runCheck(process.execPath, ['-e', 'process.exit(2)'], dir)).status, 'failed');
    assert.equal((await runCheck(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], dir, { timeout: 80 })).status, 'timeout');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('subagent writes within the completed parent turn are included', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fox-check-'));
  const dir = join(root, 'repo'), path = join(dir, 'child.js');
  try {
    await mkdir(dir);
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .' } }));
    await writeFile(path, 'bad');
    const calls = [];
    const checks = createLiveChecks({
      workspaces: { forPath: async () => ({ id: 'w', dir: root, repos: [{ dir: 'repo' }], liveCheck: { enabled: true, command: '' } }) },
      filesFor: async () => [{ path, action: 'write', exists: true, by: [1], mtime: 30 }],
      eventsFor: async (id) => id === 'child' ? [{ kind: 'tool_call', effect: 'write', path, ts: 15 }] : [{ kind: 'user', ts: 10 }, { kind: 'turn_completed', ts: 20 }],
      run: async (...args) => { calls.push(args); return { status: 'passed', output: '' }; },
    });
    assert.equal((await checks.status({ id: 'parent', workspace: dir, harness: 'fx', children: [{ id: 'child', workspace: dir }] })).count, 0);
    assert.deepEqual(calls[0][1], ['run', 'lint']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('completed turn checks only configured changed repo files, caches results and does not run when off', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fox-check-'));
  const dir = join(root, 'repo'), path = join(dir, 'src', 'a.js');
  try {
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit' } }));
    await writeFile(path, 'bad');
    const ws = { id: 'w', dir: root, repos: [{ dir: 'repo' }], liveCheck: { enabled: false, command: '' } };
    const session = { id: 'session-1', workspace: dir, harness: 'fx' };
    const events = [{ kind: 'user', ts: 10 }, { kind: 'tool_call', effect: 'write', path: 'src/a.js', ts: 15, result: { status: 'ok' } }, { kind: 'turn_completed', ts: 20 }];
    const calls = [];
    const checks = createLiveChecks({ workspaces: { forPath: async () => ws }, filesFor: async () => [{ path, action: 'write', exists: true }], eventsFor: async () => events,
      run: async (...args) => { calls.push(args); return { status: 'failed', output: args[1][1] === 'lint' ? `${path}\n  1:2  error  bad rule` : 'src/a.js:2:3 type error' }; } });
    assert.equal(await checks.status(session), null);
    ws.liveCheck = { enabled: true, command: '', enabledAt: 21 };
    assert.equal(await checks.status(session), null, 'enabling checks does not run the last historical turn');
    ws.liveCheck.enabledAt = 0;
    const [first, concurrent] = await Promise.all([checks.status(session), checks.status(session)]);
    assert.deepEqual(first.problems, [{ path, lines: [path, '1:2  error  bad rule', 'src/a.js:2:3 type error'] }]);
    assert.deepEqual(concurrent, first);
    assert.deepEqual(calls[0], ['npm', ['run', 'lint'], dir]);
    assert.deepEqual(calls[1], ['npm', ['run', 'typecheck'], dir]);
    await checks.status(session);
    assert.equal(calls.length, 2);
    events.push({ kind: 'user', ts: 10 }, { kind: 'turn_completed', ts: 20 });
    assert.equal(await checks.status(session), null);
    assert.equal(calls.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
