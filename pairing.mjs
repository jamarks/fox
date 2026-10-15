import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';

const secret = () => randomBytes(32).toString('base64url');
const digest = (value) => createHash('sha256').update(value).digest();
const matches = (value, stored) => typeof value === 'string' && stored && timingSafeEqual(digest(value), stored);

// All grants are deliberately ephemeral: restarting fox or changing the tunnel URL requires re-pairing.
export function createPairing({ now = Date.now } = {}) {
  let offer = null;
  const requests = new Map(), devices = new Map();
  const ttl = 5 * 60 * 1000;
  return {
    offer(url) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Use an HTTPS tunnel URL');
      const token = secret();
      offer = { hash: digest(token), expires: now() + ttl };
      parsed.pathname = '/'; parsed.search = ''; parsed.hash = `pair=${token}`;
      return { link: parsed.toString(), expires: offer.expires };
    },
    request(token, name) {
      if (!offer || now() >= offer.expires || !matches(token, offer.hash)) return null;
      offer = null; // a one-time offer cannot be claimed twice
      const id = randomUUID(), claim = secret();
      const entry = { id, name: String(name || 'Phone').trim().slice(0, 60) || 'Phone',
        code: String(randomBytes(4).readUInt32BE(0) % 1000000).padStart(6, '0'),
        hash: digest(claim), expires: now() + ttl, status: 'pending' };
      requests.set(id, entry);
      return { id, claim, code: entry.code };
    },
    pending() {
      return [...requests.values()].filter((r) => r.status === 'pending' && now() < r.expires)
        .map(({ id, name, code, expires }) => ({ id, name, code, expires }));
    },
    approve(id, yes) {
      const entry = requests.get(id);
      if (!entry || entry.status !== 'pending' || now() >= entry.expires) return false;
      entry.status = yes ? 'approved' : 'rejected'; return true;
    },
    poll(id, claim) {
      const entry = requests.get(id);
      if (!entry || !matches(claim, entry.hash)) return null;
      if (now() >= entry.expires) { requests.delete(id); return { status: 'expired' }; }
      if (entry.status !== 'approved') return { status: entry.status };
      requests.delete(id);
      const token = secret(), deviceId = randomUUID();
      devices.set(deviceId, { id: deviceId, name: entry.name, hash: digest(token), at: now() });
      return { status: 'approved', token };
    },
    authorized(token) {
      for (const device of devices.values()) if (matches(token, device.hash)) return device.id;
      return null;
    },
    devices() { return [...devices.values()].map(({ id, name, at }) => ({ id, name, at })); },
    revoke(id) { return devices.delete(id); },
    reset() { offer = null; requests.clear(); devices.clear(); },
  };
}
