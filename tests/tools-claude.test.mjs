import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = () => new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

test('turning a tool on for Claude Code gives it the command fx already uses on this machine', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'fox-tools-claude-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const stateDir = join(home, 'state'), mcpJson = join(home, 'fx-mcp.json'), calls = join(home, 'claude-calls');
  await mkdir(stateDir, { recursive: true });
  // fx's browser is tuned for a server: a local install, headless.
  await writeFile(mcpJson, JSON.stringify({ mcp: { playwright: { type: 'local', command: ['/usr/bin/node', '/opt/tools/@playwright/mcp/cli.js', '--headless'], enabled: true } } }));
  await writeFile(join(home, 'fx'), `#!/bin/sh\n[ "$1 $2" = "mcp path" ] && echo '${mcpJson}'\n`, { mode: 0o755 });
  // A fake claude: records its arguments; `mcp add` writes the server into ~/.claude.json the way Claude Code does.
  await writeFile(join(home, 'claude'), `#!/bin/sh
echo "$@" >> '${calls}'
[ "$1 $2" = "mcp add" ] && echo '{"mcpServers":{"playwright":{"type":"stdio","command":"/usr/bin/node","args":["/opt/tools/@playwright/mcp/cli.js","--headless"]}}}' > "$HOME/.claude.json"
[ "$1 $2" = "mcp remove" ] && echo '{"mcpServers":{}}' > "$HOME/.claude.json"
exit 0
`, { mode: 0o755 });
  const p = await port(), base = `http://127.0.0.1:${p}`;
  const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, HOME: home, FOX_STATE_DIR: stateDir, FX_BIN: join(home, 'fx'), CLAUDE_BIN: join(home, 'claude'), PORT: String(p), FOX_AUTH_DISABLED: '1', FOX_JOBS_RUNNER: 'external', FOX_MEMORY_HIGH_PCT: '0', FOX_IDLE_SLEEP_MIN: '0' }, stdio: 'pipe' });
  t.after(async () => { child.kill(); if (child.exitCode === null) await new Promise((r) => child.once('exit', r)); });
  let ready = false;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/config`)).ok) { ready = true; break; } } catch {} await new Promise((r) => setTimeout(r, 50)); }
  assert.ok(ready, 'server started');
  const toggle = (action) => fetch(`${base}/api/tools/browser/${action}?agent=claude`, { method: 'POST', headers: { origin: base } }).then(async (r) => [r.status, await r.json()]);

  let [status, tools] = await toggle('on');
  assert.equal(status, 200);
  assert.deepEqual(tools.find((x) => x.id === 'browser').claude, { enabled: true, oauth: false });
  [status, tools] = await toggle('off');
  assert.equal(status, 200);
  assert.equal(tools.find((x) => x.id === 'browser').claude.enabled, false);
  assert.deepEqual((await readFile(calls, 'utf8')).trim().split('\n').filter((l) => l.startsWith('mcp')), [
    'mcp add --scope user playwright -- /usr/bin/node /opt/tools/@playwright/mcp/cli.js --headless',
    'mcp remove --scope user playwright',
  ]);
});
