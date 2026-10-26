import { readFile, mkdir, writeFile, rename, chmod } from 'node:fs/promises';
import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { parsePublicOrigin, validEnrollment, consumeEnrollment } from './enrollment.mjs';

const ttl = 12 * 60 * 60 * 1000;
const nonce = () => randomBytes(32).toString('base64url');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const json = (res, status, data, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(JSON.stringify(data));
};
const local = (req) => {
  const host = req.headers.host ?? '';
  return /^localhost:[0-9]+$/.test(host) &&
    ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
};
const origin = (req) => `http://${req.headers.host}`;
// Every fox_session the browser sends: another site on the same domain (an app, a preview) can add its own, and
// one bad value must not hide the good one.
const cookieTokens = (req) => (req.headers.cookie ?? '').split(';').map((s) => s.trim()).filter((s) => s.startsWith('fox_session=')).map((s) => s.slice(12));
async function body(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > 16000) throw new Error('request too large');
  }
  return JSON.parse(text || '{}');
}

export async function createAuth({ stateDir, disabled = false, publicOrigin = null }) {
  const remote = parsePublicOrigin(publicOrigin);
  if (disabled && remote) throw new Error('FOX_AUTH_DISABLED must never be used with FOX_PUBLIC_ORIGIN');
  const file = join(stateDir, 'passkey.json');
  const accepts = (req) => remote
    ? req.headers.host === remote.host && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
    : local(req);
  const expectedOrigin = (req) => remote?.origin ?? origin(req);
  const validOrigin = (req) => disabled || (accepts(req) && req.headers.origin === expectedOrigin(req));
  let credential = null;
  if (!disabled) {
    try {
      const saved = JSON.parse(await readFile(file, 'utf8'));
      if (typeof saved.id !== 'string' || typeof saved.publicKey !== 'string' || !Number.isSafeInteger(saved.counter)) throw new Error('invalid credential');
      if ((saved.rpID ?? 'localhost') !== (remote?.hostname ?? 'localhost')) {
        throw new Error('passkey belongs to another domain; use a separate Fox HOME for remote deployment');
      }
      credential = saved;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Cannot load Fox passkey: ${error.message}`);
  }}
  const sessions = new Map(), sockets = new Map();
  // Challenges travel signed in their id instead of waiting in a server-side list, so no number of anonymous
  // options requests can push out someone's sign-in or fill a limit that keeps them from starting one. Only
  // challenges being verified, or verified once, are remembered (until they expire), so each works only once.
  const secret = randomBytes(32), used = new Map();
  const mac = (text) => createHmac('sha256', secret).update(text).digest();
  const sealChallenge = (item) => { const text = Buffer.from(JSON.stringify(item)).toString('base64url'); return `${text}.${mac(text).toString('base64url')}`; };
  const openChallenge = (id) => {
    const [text, tag, extra] = typeof id === 'string' ? id.split('.') : [];
    const given = Buffer.from(tag ?? '', 'base64url'), expected = mac(text ?? '');
    if (extra !== undefined || given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try { return JSON.parse(Buffer.from(text, 'base64url').toString()); } catch { return null; }
  };
  // Signed-in sessions survive a restart (a deploy must not sign you out). Only SHA-256 hashes of the cookie
  // tokens are stored, with their expiry, bound to the passkey that created them: replacing the passkey
  // (recovery) drops every old session.
  const sessionsFile = join(stateDir, 'sessions.json');
  if (!disabled && credential) {
    try {
      const saved = JSON.parse(await readFile(sessionsFile, 'utf8'));
      if (saved.credential === credential.id) for (const [key, until] of Object.entries(saved.sessions ?? {})) if (/^[0-9a-f]{64}$/.test(key) && Number.isSafeInteger(until) && until > Date.now()) sessions.set(key, until);
    } catch {}
  }
  let persisting = Promise.resolve();
  const persistSessions = () => {
    if (disabled) return persisting;
    const snapshot = JSON.stringify({ credential: credential?.id ?? null, sessions: Object.fromEntries([...sessions].filter(([, until]) => until > Date.now())) });
    persisting = persisting.then(async () => {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      const tmp = `${sessionsFile}.${nonce()}.tmp`;
      await writeFile(tmp, snapshot, { mode: 0o600, flag: 'wx' });
      await rename(tmp, sessionsFile);
    }).catch((error) => console.error(`Cannot save fox sessions: ${error.message}`));
    return persisting;
  };
  const expire = (key) => {
    if (!sessions.delete(key)) return;
    persistSessions();
    for (const ws of sockets.get(key) ?? []) ws.close(4001, 'session expired');
    sockets.delete(key);
  };
  // Restored sessions must keep their original deadline even when no new request arrives.
  const scheduleExpiry = (key, until) => setTimeout(() => expire(key), Math.max(0, until - Date.now())).unref();
  for (const [key, until] of sessions) scheduleExpiry(key, until);
  // The signed-in session a request carries (its hash), or the first one it names.
  const sessionKey = (req) => { const keys = cookieTokens(req).slice(0, 10).map(digest); return keys.find((k) => sessions.has(k)) ?? keys[0] ?? digest(''); };
  const active = (req) => {
    if (disabled) return true;
    if (!accepts(req)) return false;
    const key = sessionKey(req);
    const session = sessions.get(key);
    if (!session) return false;
    if (session <= Date.now()) { expire(key); return false; }
    return true;
  };
  const track = (req, ws) => {
    if (disabled) return;
    const key = sessionKey(req);
    if (!sockets.has(key)) sockets.set(key, new Set());
    sockets.get(key).add(ws);
    ws.once('close', () => sockets.get(key)?.delete(ws));
  };
  const save = async (value) => {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${nonce()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
      await rename(tmp, file);
      await chmod(file, 0o600);
    } catch (error) { throw error; }
  };
  function issue(res) {
    const token = nonce();
    const key = digest(token);
    const until = Date.now() + ttl;
    sessions.set(key, until);
    persistSessions();
    scheduleExpiry(key, until);
    json(res, 200, { ok: true }, { 'set-cookie': `fox_session=${token}; HttpOnly; ${remote ? 'Secure; ' : ''}SameSite=Strict; Path=/; Max-Age=${ttl / 1000}` });
  }
  async function handle(req, res) {
    if (disabled) return json(res, 404, { error: 'not found' });
    if (!accepts(req)) return json(res, 403, { error: 'host not allowed' });
    const path = new URL(req.url, expectedOrigin(req)).pathname;
    if (req.method === 'GET' && path === '/api/auth/status') return json(res, 200, { registered: Boolean(credential), authenticated: active(req), enrollmentRequired: Boolean(remote && !credential) });
    if (req.method !== 'POST' || !validOrigin(req)) return json(res, 403, { error: 'same-origin POST required' });
    if (path === '/api/auth/logout') {
      const key = sessionKey(req);
      sessions.delete(key);
      await persistSessions();
      for (const ws of sockets.get(key) ?? []) ws.close(4001, 'signed out');
      sockets.delete(key);
      return json(res, 200, { ok: true }, { 'set-cookie': `fox_session=; HttpOnly; ${remote ? 'Secure; ' : ''}SameSite=Strict; Path=/; Max-Age=0` });
    }
    const setup = path.startsWith('/api/auth/register/');
    if (setup ? credential : !credential) return json(res, 403, { error: 'not available' });
    if (path.endsWith('/options')) {
      let data = {};
      if (setup && remote) {
        try { data = await body(req); } catch { return json(res, 400, { error: 'invalid enrollment request' }); }
        if (!await validEnrollment(stateDir, data.code, remote.origin)) return json(res, 403, { error: 'valid enrollment code required' });
      }
      const rpID = remote?.hostname ?? 'localhost';
      const options = setup
        ? await generateRegistrationOptions({ rpName: 'fox', rpID, userName: 'owner', authenticatorSelection: { residentKey: 'required', userVerification: 'required' } })
        : await generateAuthenticationOptions({ rpID, allowCredentials: [{ id: credential.id }], userVerification: 'required' });
      const id = sealChallenge({ challenge: options.challenge, rpID, expires: Date.now() + 120000, setup, enrollment: setup && remote ? digest(String(data.code)) : null });
      return json(res, 200, { id, options });
    }
    if (!path.endsWith('/verify')) return json(res, 404, { error: 'not found' });
    let data;
    try { data = await body(req); } catch { return json(res, 400, { error: 'invalid response' }); }
    for (const [key, until] of used) if (until < Date.now()) used.delete(key);
    const item = openChallenge(data.id);
    if (!item || used.has(item.challenge) || item.setup !== setup || !(item.expires >= Date.now()) || item.rpID !== (remote?.hostname ?? 'localhost')) {
      return json(res, 403, { error: 'challenge expired' });
    }
    // Held before anything is awaited, so two copies of one response cannot both sign in; a failed attempt gives it back.
    used.set(item.challenge, item.expires);
    if (setup && remote && (item.enrollment !== digest(String(data.code)) || !await validEnrollment(stateDir, data.code, remote.origin))) {
      used.delete(item.challenge);
      return json(res, 403, { error: 'challenge expired' });
    }
    try {
      if (setup) {
        if (credential) return json(res, 403, { error: 'already registered' });
        const result = await verifyRegistrationResponse({ response: data.response, expectedChallenge: item.challenge, expectedOrigin: expectedOrigin(req), expectedRPID: item.rpID, requireUserVerification: true });
        if (!result.verified) throw new Error('not verified');
        if (remote && !await consumeEnrollment(stateDir, data.code, remote.origin)) throw new Error('enrollment already consumed');
        const saved = result.registrationInfo.credential;
        const record = { id: saved.id, publicKey: Buffer.from(saved.publicKey).toString('base64url'), counter: saved.counter, rpID: item.rpID };
        await save(record);
        credential = record;
      } else {
        if (data.response?.id !== credential.id) throw new Error('unknown credential');
        const result = await verifyAuthenticationResponse({ response: data.response, expectedChallenge: item.challenge, expectedOrigin: expectedOrigin(req), expectedRPID: item.rpID,
          credential: { id: credential.id, publicKey: Buffer.from(credential.publicKey, 'base64url'), counter: credential.counter }, requireUserVerification: true });
        if (!result.verified) throw new Error('not verified');
        const updated = { ...credential, counter: result.authenticationInfo.newCounter };
        await save(updated);
        credential = updated;
      }
      return issue(res);
    } catch {
      used.delete(item.challenge);
      return json(res, 403, { error: 'passkey verification failed' });
    }
  }
  return { active, track, handle, accepts, validOrigin, get registered() { return Boolean(credential); } };
}
