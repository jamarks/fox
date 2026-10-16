import { readFile, mkdir, writeFile, rename, chmod, unlink } from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';

export const enrollmentPath = (stateDir) => join(stateDir, 'enrollment.json');
export const codeHash = (code) => createHash('sha256').update(code).digest('hex');

export function parsePublicOrigin(value) {
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { throw new Error('FOX_PUBLIC_ORIGIN must be a complete HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      url.origin !== value || url.hostname === 'localhost' || /^[\d.]+$/.test(url.hostname)) {
    throw new Error('FOX_PUBLIC_ORIGIN must be an exact HTTPS origin on a DNS hostname, without a path or trailing slash');
  }
  return url;
}

export async function createEnrollment(stateDir, publicOrigin, now = Date.now()) {
  const url = parsePublicOrigin(publicOrigin);
  if (!url) throw new Error('Set FOX_PUBLIC_ORIGIN before creating a remote passkey enrollment code');
  const file = enrollmentPath(stateDir);
  const code = randomBytes(32).toString('base64url');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temp, JSON.stringify({ hash: codeHash(code), expires: now + 10 * 60 * 1000, origin: url.origin }), { mode: 0o600, flag: 'wx' });
  await rename(temp, file);
  await chmod(file, 0o600);
  return code;
}

export async function validEnrollment(stateDir, code, origin) {
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code)) return false;
  let entry;
  try { entry = JSON.parse(await readFile(enrollmentPath(stateDir), 'utf8')); } catch { return false; }
  if (entry.origin !== origin || !Number.isSafeInteger(entry.expires) || entry.expires < Date.now() || !/^[0-9a-f]{64}$/.test(entry.hash)) return false;
  return timingSafeEqual(Buffer.from(entry.hash, 'hex'), Buffer.from(codeHash(code), 'hex'));
}

export async function consumeEnrollment(stateDir, code, origin) {
  if (!await validEnrollment(stateDir, code, origin)) return false;
  await unlink(enrollmentPath(stateDir));
  return true;
}
