import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
async function request(port, path, { host = `127.0.0.1:${port}`, origin, cookie, method = 'GET', data } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method,
      headers: { host, ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}), ...(data ? { 'content-type': 'application/json' } : {}) },
    }, (res) => {
      let body = '';
      res.on('data', (b) => { body += b; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.once('error', reject); req.end(data ? JSON.stringify(data) : undefined);
  });
}
async function ready(port) {
  for (let i = 0; i < 80; i++) { try { return await request(port, '/'); } catch { await new Promise((r) => setTimeout(r, 50)); } }
  throw new Error('server did not start');
}
function wsConnect(port, { host, origin, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/pty?name=fx-test-session`, {
      handshakeTimeout: 2000, headers: { ...(host ? { host } : {}), ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) },
    });
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, response) => { const code = response.statusCode; ws.terminate(); resolve(code); });
    ws.once('error', reject);
  });
}

test('remote port requires QR, Mac approval and cookie for all HTTP/WS; revoke closes socket', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fox-share-'));
  const dir = join(home, '.fx', 'sessions', 'test-session');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'session.json'), JSON.stringify({ title: 'Secret session', workspace_root: '/repo' }));
  const tmux = join(home, 'tmux.mjs');
  await writeFile(tmux, '#!/usr/bin/env node\nif (process.argv[2] === "attach-session") setInterval(() => {}, 1000);\n');
  await chmod(tmux, 0o755);
  const cloudflared = join(home, 'cloudflared.mjs');
  await writeFile(cloudflared, '#!/usr/bin/env node\nconsole.error("https://fox-demo.trycloudflare.com");\nconsole.error("Registered tunnel connection");\nsetInterval(() => {}, 1000);\n');
  await chmod(cloudflared, 0o755);
  const port = await freePort(), share = await freePort();
  const processChild = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, HOME: home, PORT: String(port), FOX_SHARE_PORT: String(share), TMUX_BIN: tmux, CLOUDFLARED_BIN: cloudflared }, stdio: 'pipe',
  });
  const host = 'fox-demo.trycloudflare.com', origin = `https://${host}`;
  const local = (path, data) => request(port, path, { method: data ? 'POST' : 'GET', origin: `http://127.0.0.1:${port}`, data });
  const remote = (path, options = {}) => request(share, path, { host, origin, ...options });
  try {
    assert.equal((await ready(port)).status, 200);
    assert.equal((await request(port, '/api/overview', { host, origin })).status, 403); // tunneling 4848 must fail closed
    assert.equal(await wsConnect(port, { host, origin }), 403);
    assert.equal((await remote('/')).status, 403); // no tunnel URL configured yet
    assert.equal((await local('/api/pair/tunnel/start', {})).status, 200);
    const offer = JSON.parse((await local('/api/pair/tunnel/start', {})).body);
    assert.equal(offer.url, origin);
    assert.match(offer.svg, /<svg/);
    const token = new URL(offer.link).hash.slice(6);
    assert.equal((await remote('/')).status, 200);
    assert.match((await remote('/')).body, /Pair your phone/);
    for (const path of ['/api/overview', '/app.js', '/vendor/font/latin-400.css', '/api/sessions', '/api/terminals', '/api/pair/state']) {
      assert.equal((await remote(path)).status, 401, path);
    }
    assert.equal(await wsConnect(share, { host, origin }), 403);
    assert.equal((await remote('/api/pair/request', { method: 'POST', data: { token: 'bad' } })).status, 403);
    const start = await remote('/api/pair/request', { method: 'POST', data: { token } });
    assert.equal(start.status, 200);
    const { id, claim, code } = JSON.parse(start.body);
    assert.equal((await remote('/api/pair/request', { method: 'POST', data: { token } })).status, 403);
    assert.equal(JSON.parse((await local('/api/pair/state')).body).pending[0].code, code);
    assert.equal((await remote('/api/pair/status', { method: 'POST', data: { id, claim } })).body, '{"status":"pending"}');
    assert.equal((await remote('/api/pair/status', { method: 'POST', data: { id, claim }, origin: 'https://evil.test' })).status, 403);
    assert.equal((await local('/api/pair/decision', { id, approve: true })).status, 200);
    const approval = await remote('/api/pair/status', { method: 'POST', data: { id, claim } });
    assert.equal(approval.status, 200);
    assert.match(approval.headers['set-cookie'][0], /HttpOnly; Secure; SameSite=Strict/);
    const cookie = approval.headers['set-cookie'][0].split(';')[0];
    assert.match((await remote('/api/overview', { cookie })).body, /Secret session/);
    const fontCss = await remote('/vendor/font/latin-400.css', { cookie });
    assert.equal(fontCss.status, 200);
    assert.match(fontCss.body, /Source Code Pro/);
    const font = await remote('/vendor/font/files/source-code-pro-latin-400-normal.woff2', { cookie });
    assert.equal(font.status, 200);
    assert.equal(font.headers['content-type'], 'font/woff2');
    assert.equal((await remote('/api/pair/state', { cookie })).status, 404);
    assert.equal((await remote('/api/overview', { cookie, host: 'evil.test' })).status, 403);
    const ws = await wsConnect(share, { host, origin, cookie });
    assert.ok(ws instanceof WebSocket);
    const revoked = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
    const device = JSON.parse((await local('/api/pair/state')).body).devices[0];
    assert.equal((await local('/api/pair/revoke', { id: device.id })).status, 200);
    assert.equal(await revoked, 4001);
    assert.equal((await remote('/api/overview', { cookie })).status, 401);
    assert.equal(await wsConnect(share, { host, origin, cookie }), 403);
    const again = JSON.parse((await local('/api/pair/tunnel/start', {})).body);
    const nextToken = new URL(again.link).hash.slice(6);
    const next = JSON.parse((await remote('/api/pair/request', { method: 'POST', data: { token: nextToken } })).body);
    assert.equal((await local('/api/pair/decision', { id: next.id, approve: true })).status, 200);
    const nextCookie = (await remote('/api/pair/status', { method: 'POST', data: { id: next.id, claim: next.claim } })).headers['set-cookie'][0].split(';')[0];
    const active = await wsConnect(share, { host, origin, cookie: nextCookie });
    assert.ok(active instanceof WebSocket);
    const closed = new Promise((resolve) => active.once('close', (code) => resolve(code)));
    assert.equal((await local('/api/pair/tunnel/stop', {})).status, 200);
    assert.equal(await closed, 4001);
    assert.equal((await remote('/')).status, 403);
    assert.equal(JSON.parse((await local('/api/pair/state')).body).tunnelUrl, null);
    assert.equal((await local('/api/pair/tunnel/start', {})).status, 200);
    assert.equal((await remote('/api/overview', { cookie: nextCookie })).status, 401);
  } finally {
    processChild.kill();
    await new Promise((resolve) => processChild.once('exit', resolve));
    await rm(home, { recursive: true, force: true });
  }
});
