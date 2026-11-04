// Request targets reach HTTP and upgrade routing before a session can be checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { connect, createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const freePort = () => new Promise((resolve) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const get = (port, host, path = '/api/auth/status') => new Promise((resolve, reject) => {
  http.get({ hostname: '127.0.0.1', port, path, headers: { host } }, (res) => {
    res.resume(); res.on('end', () => resolve(res.statusCode));
  }).once('error', reject);
});
const raw = (port, host, upgrade = false, target = 'http://\\[') => new Promise((resolve, reject) => {
  const socket = connect(port, '127.0.0.1');
  let response = '';
  socket.setTimeout(5000, () => socket.destroy(new Error('request timed out')));
  socket.once('connect', () => socket.end(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\n${upgrade ? 'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nOrigin: http://localhost\r\n' : 'Connection: close\r\n'}\r\n`));
  socket.on('data', (chunk) => { response += chunk; });
  socket.once('end', () => resolve(response));
  socket.once('error', reject);
});

for (const mode of ['passkey', 'auth disabled']) {
  test(`malformed HTTP and WebSocket targets return 400 without stopping fox (${mode})`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'fox-target-'));
    const port = await freePort();
    const mobilePort = mode === 'auth disabled' ? await freePort() : undefined;
    const sharePort = mode === 'auth disabled' ? await freePort() : undefined;
    const host = mode === 'passkey' ? 'fox.probe.test' : `localhost:${port}`;
    const status = mode === 'passkey' ? 200 : 404; // The disabled mode does not expose auth endpoints.
    const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), stdio: 'pipe',
      env: { ...process.env, HOME: home, FOX_STATE_DIR: join(home, 'state'), PORT: String(port),
        FOX_AUTH_DISABLED: mode === 'auth disabled' ? '1' : undefined,
        FOX_PUBLIC_ORIGIN: mode === 'passkey' ? 'https://fox.probe.test' : undefined,
        FOX_MOBILE_PORT: mobilePort?.toString(), FOX_SHARE_PORT: sharePort?.toString() } });
    try {
      let ready = false;
      for (let i = 0; i < 200; i++) {
        try { ready = (await get(port, host)) === status; if (ready) break; } catch {}
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(ready, 'fox started');
      if (mobilePort && sharePort) {
        assert.match(await raw(mobilePort, host), /^HTTP\/1\.1 400 Bad Request\r\n/);
        assert.match(await raw(sharePort, host), /^HTTP\/1\.1 400 Bad Request\r\n/);
        assert.equal(await get(mobilePort, host, '/api/overview'), 200);
        assert.equal(await get(sharePort, host), 403);
      }
      assert.match(await raw(port, host, true, '/pty'), /^HTTP\/1\.1 403 Forbidden\r\n/, 'valid upgrade reaches WebSocket routing');
      for (const upgrade of [false, true]) {
        assert.match(await raw(port, host, upgrade), /^HTTP\/1\.1 400 Bad Request\r\n/);
        assert.equal(await get(port, host), status, 'auth status still responds');
        if (mode === 'auth disabled') assert.equal(await get(port, host, '/api/sessions'), 200);
        assert.equal(child.exitCode, null);
      }
    } finally {
      child.kill();
      if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
      await rm(home, { recursive: true, force: true });
    }
  });
}
