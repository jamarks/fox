import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import http from 'node:http';
import { promisify } from 'node:util';
import { generateKeyPairSync, randomBytes, createHash, sign } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { parsePublicOrigin } from '../enrollment.mjs';

const execFileP = promisify(execFile);
const b64 = (buffer) => Buffer.from(buffer).toString('base64url');
const hash = (value) => createHash('sha256').update(value).digest();
const cbor = (value) => {
  const prefix = (major, size) => size < 24 ? Buffer.from([major << 5 | size]) : Buffer.from([major << 5 | 24, size]);
  if (typeof value === 'number') return prefix(value < 0 ? 1 : 0, value < 0 ? -1 - value : value);
  if (typeof value === 'string') { const bytes = Buffer.from(value); return Buffer.concat([prefix(3, bytes.length), bytes]); }
  if (Buffer.isBuffer(value)) return Buffer.concat([prefix(2, value.length), value]);
  const entries = Object.entries(value);
  return Buffer.concat([prefix(5, entries.length), ...entries.flatMap(([key, val]) => [cbor(Number.isNaN(Number(key)) ? key : Number(key)), cbor(val)])]);
};
const freePort = () => new Promise((resolve) => {
  const server = createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});

test('remote origin configuration refuses insecure or malformed origins', () => {
  for (const value of ['http://fox.example.test', 'https://fox.example.test/', 'https://localhost', 'https://127.0.0.1', 'https://fox.example.test/a']) {
    assert.throws(() => parsePublicOrigin(value), value);
  }
  assert.equal(parsePublicOrigin('https://fox.example.test').hostname, 'fox.example.test');
});

test('HTTPS passkey enrollment needs SSH code and exact origin; session has Secure cookie', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fox-remote-passkey-'));
  const port = await freePort(), base = `http://127.0.0.1:${port}`, origin = 'https://fox.example.test';
  const fakeTmux = join(home, 'tmux.mjs');
  await writeFile(fakeTmux, '#!/usr/bin/env node\nif (process.argv[2] === "attach-session") setInterval(() => {}, 1000);\n');
  await chmod(fakeTmux, 0o755);
  await mkdir(join(home, '.fx', 'sessions', 'sample'), { recursive: true });
  await writeFile(join(home, '.fx', 'sessions', 'sample', 'session.json'), JSON.stringify({ title: 'Secret', workspace_root: '/repo' }));
  // Settings → Deploy only shows where fox-update is installed: a stand-in file says it is.
  const fakeUpdate = join(home, 'fox-update');
  await writeFile(fakeUpdate, '');
  const env = { ...process.env, HOME: home, PORT: String(port), FOX_PUBLIC_ORIGIN: origin, TMUX_BIN: fakeTmux, FOX_UPDATE_BIN: fakeUpdate };
  let child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env, stdio: 'pipe' });
  const request = (path, { method = 'GET', data, cookie, host = 'fox.example.test', browserOrigin = origin } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path, method,
        headers: { host, ...(data ? { origin: browserOrigin, 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) } }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
      });
      req.once('error', reject);
      req.end(data ? JSON.stringify(data) : undefined);
    });
  const post = (path, data, options) => request(path, { method: 'POST', data, ...options });
  const ready = async () => {
    for (let i = 0; i < 80; i++) { try { return await request('/'); } catch { await new Promise((r) => setTimeout(r, 50)); } }
    throw new Error('fox did not start');
  };
  try {
    assert.match(await (await ready()).text(), /One-time enrollment code/);
    assert.equal((await request('/api/overview')).status, 401);
    assert.equal((await request('/', { host: 'attacker.example.test' })).status, 403);
    assert.equal((await request('/api/auth/status', { host: 'localhost:4848' })).status, 403);
    assert.equal((await post('/api/auth/register/options', { code: 'bad' })).status, 403);
    const { stdout } = await execFileP(process.execPath, ['bin/fox-enroll.mjs'], { cwd: new URL('..', import.meta.url), env });
    const code = stdout.match(/^([A-Za-z0-9_-]{43})$/m)[1]; // its own line; it may start or end with - or _
    assert.equal((await post('/api/auth/register/options', { code }, { browserOrigin: 'http://fox.example.test' })).status, 403);
    const { id, options } = await (await post('/api/auth/register/options', { code })).json();
    assert.equal(options.rp.id, 'fox.example.test');
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' }), credentialID = randomBytes(16);
    const cose = cbor({ 1: 2, 3: -7, '-1': 1, '-2': Buffer.from(jwk.x, 'base64url'), '-3': Buffer.from(jwk.y, 'base64url') });
    const authData = Buffer.concat([hash('fox.example.test'), Buffer.from([0x45, 0, 0, 0, 0]), Buffer.alloc(16), Buffer.from([0, credentialID.length]), credentialID, cose]);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin }));
    const response = { id: b64(credentialID), rawId: b64(credentialID), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64(clientData), attestationObject: b64(cbor({ fmt: 'none', authData, attStmt: {} })) } };
    assert.equal((await post('/api/auth/register/verify', { id, code: 'wrong', response })).status, 403);
    const next = await (await post('/api/auth/register/options', { code })).json();
    const signedClient = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: next.options.challenge, origin }));
    response.response.clientDataJSON = b64(signedClient);
    const registered = await post('/api/auth/register/verify', { id: next.id, code, response });
    assert.equal(registered.status, 200, await registered.text());
    assert.match(registered.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Strict/);
    const cookie = registered.headers.get('set-cookie').split(';')[0];
    assert.match(await (await request('/api/overview', { cookie })).text(), /Secret/);
    assert.equal((await request('/api/overview', { cookie, host: 'evil.example.test' })).status, 403);
    assert.equal((await post('/api/auth/register/options', { code })).status, 403);
    const ws = await new Promise((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/pty?name=invalid`, { origin, headers: { host: 'fox.example.test', cookie } });
      socket.once('open', () => { socket.close(); resolve('open'); });
      socket.once('unexpected-response', (_request, res) => { const status = res.statusCode; socket.terminate(); resolve(status); });
      socket.once('error', () => resolve('error'));
    });
    assert.equal(ws, 'open');
    // A cookie another subdomain set (an app, a preview) does not hide the real one.
    assert.equal((await request('/api/overview', { cookie: `fox_session=junk; ${cookie}` })).status, 200);
    // The branch the server deploys: what fox-update reads, and only release or main.
    assert.deepEqual(await (await request('/api/deploy', { cookie })).json(), { available: true, branch: 'release' });
    assert.equal((await post('/api/deploy', { branch: 'evil; rm -rf /' }, { cookie })).status, 400);
    assert.deepEqual(await (await post('/api/deploy', { branch: 'main' }, { cookie })).json(), { available: true, branch: 'main' });
    assert.equal(await readFile(join(home, '.config', 'fox', 'deploy-branch'), 'utf8'), 'main\n');
    assert.equal((await post('/api/deploy', { branch: 'main' })).status, 401, 'needs the passkey');
    const login = await (await post('/api/auth/login/options', {})).json();
    const getClient = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: login.options.challenge, origin }));
    const signedAuth = Buffer.concat([hash('fox.example.test'), Buffer.from([0x05, 0, 0, 0, 1])]);
    const assertion = { id: b64(credentialID), rawId: b64(credentialID), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64(getClient), authenticatorData: b64(signedAuth), signature: b64(sign('sha256', Buffer.concat([signedAuth, hash(getClient)]), privateKey)) } };
    const signedIn = await post('/api/auth/login/verify', { id: login.id, response: assertion });
    assert.equal(signedIn.status, 200, await signedIn.text());
    assert.match(signedIn.headers.get('set-cookie'), /Secure/);
    assert.equal((await post('/api/auth/logout', {}, { cookie })).status, 200);
    assert.equal((await request('/api/overview', { cookie })).status, 401);
    const saved = JSON.parse(await readFile(join(home, '.config', 'fox', 'passkey.json'), 'utf8'));
    assert.equal(saved.rpID, 'fox.example.test');
    assert.equal(saved.counter, 1);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    await rm(home, { recursive: true, force: true });
  }
});
