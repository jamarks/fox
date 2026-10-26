import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, createHash, sign, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createAuth } from '../auth.mjs';

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

test('a flood of anonymous options requests neither pushes out nor blocks a sign-in in progress', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'fox-pending-auth-'));
  const post = async (auth, path, data = {}) => {
    const req = { method: 'POST', url: path, headers: { host: 'localhost:3000', origin: 'http://localhost:3000' },
      socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(data)); } };
    let status, response;
    const res = { writeHead(code) { status = code; }, end(text) { response = JSON.parse(text); } };
    await auth.handle(req, res);
    return { status, ...response };
  };
  try {
    for (const setup of [true, false]) {
      if (!setup) await writeFile(join(stateDir, 'passkey.json'), JSON.stringify({ id: 'test-credential', publicKey: 'AA', counter: 0 }));
      const auth = await createAuth({ stateDir });
      const path = setup ? '/api/auth/register' : '/api/auth/login';
      const first = await post(auth, `${path}/options`);
      const flood = await Promise.all(Array.from({ length: 250 }, () => post(auth, `${path}/options`)));
      assert.ok([first, ...flood].every((result) => result.status === 200), 'nobody is turned away');
      // Reaching the passkey check means the first challenge survived the flood.
      const verify = await post(auth, `${path}/verify`, { id: first.id, response: {} });
      assert.equal(verify.error, 'passkey verification failed');
      const [text, tag] = first.id.split('.');
      const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(text, 'base64url')), expires: Date.now() + 1e9 })).toString('base64url');
      for (const id of [`${forged}.${tag}`, `${text}.${tag.slice(0, -2)}`, `${text}.${tag}.x`, 'nonsense', undefined]) {
        assert.equal((await post(auth, `${path}/verify`, { id, response: {} })).error, 'challenge expired', `rejects ${id}`);
      }
      const other = await createAuth({ stateDir });
      assert.equal((await post(other, `${path}/verify`, { id: first.id, response: {} })).error, 'challenge expired', 'ids are signed per process');
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('restored sessions close tracked terminal sockets at their original expiry', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'fox-auth-restored-'));
  const token = 'restored-session-token';
  const key = hash(token).toString('hex');
  const until = Date.now() + 600;
  const req = { headers: { host: 'localhost:3000', cookie: `fox_session=${token}` }, socket: { remoteAddress: '127.0.0.1' } };
  try {
    await writeFile(join(stateDir, 'passkey.json'), JSON.stringify({ id: 'passkey', publicKey: 'key', counter: 0 }));
    await writeFile(join(stateDir, 'sessions.json'), JSON.stringify({ credential: 'passkey', sessions: { [key]: until } }));
    const auth = await createAuth({ stateDir });
    assert.equal(auth.active(req), true);
    const closes = [];
    auth.track(req, { once() {}, close(...args) { closes.push(args); } });
    // No request touches this session between tracking the socket and the deadline.
    await sleep(850);
    assert.deepEqual(closes, [[4001, 'session expired']]);
    assert.equal(auth.active(req), false);
    let stored;
    for (let i = 0; i < 50; i++) {
      stored = JSON.parse(await readFile(join(stateDir, 'sessions.json'), 'utf8'));
      if (!stored.sessions[key]) break;
      await sleep(10);
    }
    assert.equal(stored.sessions[key], undefined);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

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
    // One unused registration challenge still occupies a slot after setup.
    for (let i = 0; i < 98; i++) assert.equal((await post('/api/auth/login/options', {})).status, 200);
    assert.equal((await post('/api/auth/login/options', {})).status, 429);
    const signedData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: login.options.challenge, origin: base }));
    const authData = Buffer.concat([hash('localhost'), Buffer.from([0x05, 0, 0, 0, 1])]);
    const assertion = { id: b64(credentialID), rawId: b64(credentialID), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64(signedData), authenticatorData: b64(authData), signature: b64(sign('sha256', Buffer.concat([authData, hash(signedData)]), privateKey)) } };
    const authenticated = await post('/api/auth/login/verify', { id: login.id, response: assertion });
    assert.equal(authenticated.status, 200, await authenticated.text());
    assert.equal((await post('/api/auth/login/options', {})).status, 200, 'successful verification frees capacity');
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
