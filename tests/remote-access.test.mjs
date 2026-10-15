import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
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
function websocket(url, options) {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { handshakeTimeout: 2000, ...options });
    socket.once('open', () => { socket.close(); resolve('open'); });
    socket.once('unexpected-response', (_req, res) => { const code = res.statusCode; socket.terminate(); resolve(code); });
    socket.once('error', () => resolve('error'));
  });
}

test('full panel keeps loopback, accepts same-origin HTTPS proxy and rejects foreign origins', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fox-remote-'));
  const dir = join(home, '.fx', 'sessions', 'test-session');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'session.json'), JSON.stringify({ title: 'Test', workspace_root: '/repo' }));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, HOME: home, PORT: String(port), TMUX_BIN: '/bin/true' }, stdio: 'pipe',
  });
  const base = `http://127.0.0.1:${port}`;
  const remote = 'fox-device.tailnet.ts.net';
  const path = '/api/sessions/test-session/rename';
  try {
    assert.equal((await connected(base)).status, 200);
    const post = (origin, host) => new Promise((resolve, reject) => {
      const request = http.request(base + path, {
        method: 'POST', headers: { ...(origin ? { origin } : {}), ...(host ? { host } : {}), 'content-type': 'application/json' },
      }, (response) => { response.resume(); resolve({ status: response.statusCode }); });
      request.once('error', reject);
      request.end(JSON.stringify({ name: 'remote name' }));
    });
    assert.equal((await post()).status, 403);
    assert.equal((await post('https://evil.example', remote)).status, 403);
    assert.equal((await post(`http://127.0.0.1:${port}`)).status, 200);
    assert.equal((await post(`https://${remote}`, remote)).status, 200);
    const state = JSON.parse(await readFile(join(home, '.config', 'fox', 'state.json'), 'utf8'));
    assert.equal(state.names['test-session'], 'remote name');
    const ws = `ws://127.0.0.1:${port}/pty?name=invalid`;
    assert.equal(await websocket(ws, { origin: 'https://evil.example', headers: { host: remote } }), 403);
    assert.equal(await websocket(ws), 403);
    assert.equal(await websocket(ws, { origin: `https://${remote}`, headers: { host: remote } }), 'open');
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    await rm(home, { recursive: true, force: true });
  }
});
