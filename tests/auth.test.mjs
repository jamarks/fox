import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, createHash, sign, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const b64 = (buffer) => Buffer.from(buffer).toString('base64url');
const hash = (buffer) => createHash('sha256').update(buffer).digest();
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('local passkey gates HTTP and WebSocket, verifies signatures, keeps sessions across restarts and revokes on logout', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fox-auth-'));
  const sessionDir = join(home, '.fx', 'sessions', 'sample');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, 'session.json'), JSON.stringify({ title: 'Private session', workspace_root: '/repo' }));
  const fakeTmux = join(home, 'tmux.mjs');
  await writeFile(fakeTmux, '#!/usr/bin/env node\nif (process.argv[2] === "attach-session") setInterval(() => {}, 1000);\n');
  await chmod(fakeTmux, 0o755);
  const port = await freePort(), base = `http://localhost:${port}`, remote = `http://127.0.0.1:${port}`;
  let child;
  const launch = async () => {
    child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url),
      env: { ...process.env, HOME: home, PORT: String(port), TMUX_BIN: fakeTmux }, stdio: 'pipe' });
    for (let i = 0; i < 200; i++) { try { return await fetch(base); } catch { await sleep(50); } } // slow under a parallel test run
    throw new Error('fox did not start');
  };
  const stop = async () => { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); };
  const post = (path, data, cookie) => fetch(base + path, { method: 'POST', headers: { origin: base, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(data) });
  const ws = (cookie) => new Promise((resolve) => {
    const socket = new WebSocket(`ws://localhost:${port}/pty?name=invalid`, { origin: base, headers: cookie ? { cookie } : {} });
    socket.once('open', () => { socket.close(); resolve('open'); });
    socket.once('unexpected-response', (_request, res) => { const code = res.statusCode; socket.terminate(); resolve(code); });
    socket.once('error', () => resolve('error'));
  });
  try {
    assert.match(await (await launch()).text(), /id="enter"/);
    assert.equal((await fetch(base + '/api/overview')).status, 401);
    assert.equal((await fetch(base + '/app.js')).status, 401);
    assert.equal((await fetch(base + '/api/sessions/sample/file?path=/repo/file')).status, 401);
    assert.equal((await fetch(remote + '/api/overview')).status, 403);
    assert.equal(await ws(), 403);
    assert.equal((await post('/api/auth/register/options', {}, '')).status, 200);
    assert.equal((await fetch(base + '/api/auth/status')).status, 200);
    assert.equal((await fetch(remote + '/api/auth/status')).status, 403);
    assert.equal((await fetch(base + '/api/auth/register/options', { method: 'POST' })).status, 403);
    const { id, options } = await (await post('/api/auth/register/options', {})).json();
    assert.equal(options.rp.id, 'localhost');
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    const credentialID = randomBytes(16);
    const key = cbor({ 1: 2, 3: -7, '-1': 1, '-2': Buffer.from(jwk.x, 'base64url'), '-3': Buffer.from(jwk.y, 'base64url') });
    const authenticator = Buffer.concat([hash('localhost'), Buffer.from([0x45, 0, 0, 0, 0]), Buffer.alloc(16), Buffer.from([0, credentialID.length]), credentialID, key]);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: base }));
    const attestation = cbor({ fmt: 'none', authData: authenticator, attStmt: {} });
    const response = { id: b64(credentialID), rawId: b64(credentialID), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64(clientData), attestationObject: b64(attestation), transports: ['internal'] } };
    const registered = await post('/api/auth/register/verify', { id, response });
    assert.equal(registered.status, 200, await registered.text());
    const cookie = registered.headers.get('set-cookie').split(';')[0];
    assert.match(cookie, /^fox_session=/);
    assert.match(await (await fetch(base + '/api/overview', { headers: { cookie } })).text(), /Private session/);
    assert.equal(await ws(cookie), 'open');
    assert.equal((await post('/api/auth/register/options', {}, cookie)).status, 403);
    const login = await (await post('/api/auth/login/options', {})).json();
    const signedData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: login.options.challenge, origin: base }));
    const authData = Buffer.concat([hash('localhost'), Buffer.from([0x05, 0, 0, 0, 1])]);
    const assertion = { id: b64(credentialID), rawId: b64(credentialID), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64(signedData), authenticatorData: b64(authData), signature: b64(sign('sha256', Buffer.concat([authData, hash(signedData)]), privateKey)) } };
    const authenticated = await post('/api/auth/login/verify', { id: login.id, response: assertion });
    assert.equal(authenticated.status, 200, await authenticated.text());
    const cookie2 = authenticated.headers.get('set-cookie').split(';')[0];
    assert.equal((await post('/api/auth/login/verify', { id: login.id, response: assertion })).status, 403);
    assert.equal((await post('/api/auth/logout', {}, cookie2)).status, 200);
    assert.equal((await fetch(base + '/api/overview', { headers: { cookie: cookie2 } })).status, 401);
    assert.equal(await ws(cookie2), 403);
    await stop();
    const saved = JSON.parse(await readFile(join(home, '.config', 'fox', 'passkey.json'), 'utf8'));
    assert.equal(saved.id, b64(credentialID));
    assert.equal(saved.counter, 1);
    await launch();
    assert.equal((await (await fetch(base + '/api/auth/status')).json()).registered, true);
    assert.equal((await post('/api/auth/register/options', {})).status, 403);
    // A restart (a deploy) keeps you signed in; signing out is still final.
    assert.equal((await fetch(base + '/api/overview', { headers: { cookie } })).status, 200);
    assert.equal(await ws(cookie), 'open');
    assert.equal((await fetch(base + '/api/overview', { headers: { cookie: cookie2 } })).status, 401);
    const stored = await readFile(join(home, '.config', 'fox', 'sessions.json'), 'utf8');
    assert.ok(!stored.includes(cookie.split('=')[1]), 'only hashes of the tokens are stored');
    // A new passkey (recovery) drops every session made with the old one.
    await stop();
    const swapped = JSON.parse(await readFile(join(home, '.config', 'fox', 'passkey.json'), 'utf8'));
    await writeFile(join(home, '.config', 'fox', 'passkey.json'), JSON.stringify({ ...swapped, id: b64(randomBytes(16)) }));
    await launch();
    assert.equal((await fetch(base + '/api/overview', { headers: { cookie } })).status, 401);
  } finally {
    if (child && child.exitCode === null) await stop();
    await rm(home, { recursive: true, force: true });
  }
});
