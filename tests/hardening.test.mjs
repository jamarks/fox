// What fox refuses even when it is reachable: foreign names, previews that leave their project, bad terminal input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const freePort = () => new Promise((resolve) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
async function connected(url) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try { return await fetch(url); } catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  throw new Error('fox did not start');
}
const get = (port, path, host) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path, headers: { host: host ?? `127.0.0.1:${port}` } }, (res) => {
    let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  }).on('error', reject);
});

test('without a passkey fox still refuses foreign names, keeps previews in their project and survives bad input', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'fox-hard-')));
  const project = join(home, 'proj'), outside = join(home, 'outside');
  await mkdir(project, { recursive: true }); await mkdir(outside);
  await writeFile(join(project, 'index.html'), '<p>hi</p>');
  await writeFile(join(project, 'ok.txt'), 'ok');
  await writeFile(join(project, '.env'), 'API_KEY=x');
  await writeFile(join(outside, 'secret.txt'), 'SECRET');
  await symlink(join(outside, 'secret.txt'), join(project, 'leak.txt'));
  await symlink(join(project, '.env'), join(project, 'env.txt'));
  await symlink(outside, join(project, 'dir'));
  const dir = join(home, '.fx', 'sessions', 'hard-session');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'session.json'), JSON.stringify({ title: 'Test', workspace_root: project }));
  await writeFile(join(dir, 'events.jsonl'), JSON.stringify({ event: { assistant: { text: 'Made `index.html`' } } }) + '\n');
  await mkdir(join(home, '.fx', 'sessions', 'constructor'));
  await writeFile(join(home, '.fx', 'sessions', 'constructor', 'session.json'), JSON.stringify({ title: 'odd' }));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, HOME: home, PORT: String(port), TMUX_BIN: '/bin/cat', FOX_AUTH_DISABLED: '1' }, stdio: 'pipe',
  });
  try {
    assert.equal((await connected(`http://127.0.0.1:${port}/api/sessions`)).status, 200);
    // DNS rebinding: a site whose name now points at 127.0.0.1 is not fox.
    assert.equal((await get(port, '/api/sessions', `evil.example:${port}`)).status, 403);
    assert.equal((await get(port, '/api/sessions', 'fox-mac.tailnet.ts.net')).status, 200);
    // fox's pages come with their own rules.
    const page = await get(port, '/');
    assert.match(page.headers['content-security-policy'], /script-src 'self'/);
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    // A preview reaches its project, never through a symlink out of it or onto a hidden file.
    const { url } = JSON.parse((await get(port, `/api/sessions/hard-session/view-url?path=${encodeURIComponent(join(project, 'index.html'))}`)).body);
    const base = url.split('/').slice(0, 3).join('/');
    assert.equal((await get(port, `${base}/ok.txt`)).body, 'ok');
    assert.equal((await get(port, `${base}/leak.txt`)).status, 404);
    assert.equal((await get(port, `${base}/env.txt`)).status, 404);
    assert.equal((await get(port, `${base}/dir/secret.txt`)).status, 404);
    // Choosing the deploy branch is for a server only.
    assert.deepEqual(JSON.parse((await get(port, '/api/deploy')).body), { available: false, branch: 'release' });
    // Search with a session folder named like an Object method.
    assert.equal((await get(port, '/api/search?q=odd')).status, 200);
    // A terminal message that is not text is ignored, not a crash.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/pty?name=fx-x`, { origin: `http://127.0.0.1:${port}` });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ type: 'input', data: {} }));
    ws.send(JSON.stringify({ type: 'resize', cols: 1e12, rows: 0.5 }));
    await new Promise((r) => setTimeout(r, 300));
    ws.close();
    assert.equal((await get(port, '/api/sessions')).status, 200, 'fox is still up');
    assert.equal(child.exitCode, null);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    await rm(home, { recursive: true, force: true });
  }
});
