import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const freePort = () => new Promise((resolve) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});

test('mosaic snapshot is bounded, plain text and only for a live fox session', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fox-mosaic-'));
  const dir = join(home, '.fx', 'sessions', 'session-one');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'session.json'), JSON.stringify({ title: 'One', workspace_root: home, model: 'openai/gpt-5', updated_at_ms: 10 }));
  await writeFile(join(dir, 'events.jsonl'), [
    { event: { assistant: { text: 'Last answer' } } }, { event: { turn_completed: {} } },
  ].map(JSON.stringify).join('\n'));
  const script = join(home, 'tmux.mjs'), log = join(home, 'captures.log');
  await writeFile(script, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'list-sessions') console.log('fx-session-one|1|0');
else if (cmd === 'show-options') { if (!args.includes('fx-session-one')) process.exit(1); console.log(args.at(-1) === '@fx_resume' ? 'session-one' : ${JSON.stringify(home)}); }
else if (cmd === 'capture-pane') {
  appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
  console.log(Array.from({length: 40}, (_, i) => i === 39 ? '\\x1b[31mLAST\\x1b[0m\\x00' : 'line-' + i).join('\\n'));
}
`);
  await chmod(script, 0o755);
  const port = await freePort();
  const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, HOME: home, FOX_STATE_DIR: join(home, 'state'), TMUX_BIN: script, PORT: String(port), FOX_AUTH_DISABLED: '1', FOX_JOBS_RUNNER: 'external' }, stdio: 'pipe' });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 200; i++) {
      try { ready = (await fetch(`${base}/api/overview`)).ok; if (ready) break; } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(ready, 'server started');
    const overview = await (await fetch(`${base}/api/overview`)).json();
    assert.equal(overview.sessions[0].terminal, 'fx-session-one');
    assert.equal(overview.sessions[0].latestReply.text, 'Last answer');
    const response = await fetch(`${base}/api/terminals/fx-session-one/snapshot`);
    assert.equal(response.status, 200);
    const { text } = await response.json();
    assert.equal(text.split('\n').length, 32);
    assert.match(text, /LAST$/);
    assert.doesNotMatch(text, /\x1b|\x00|line-0\n/);
    assert.equal((await fetch(`${base}/api/terminals/fx-missing/snapshot`)).status, 404);
    assert.equal((await fetch(`${base}/api/terminals/other/snapshot`)).status, 404);
    const captures = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(captures.find((args) => args.includes('-S')), ['-p', '-S', '-32', '-E', '-1', '-t', 'fx-session-one']);
    assert.equal(captures.filter((args) => args.includes('-S')).length, 1); // invalid names never get a snapshot
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    await rm(home, { recursive: true, force: true });
  }
});
