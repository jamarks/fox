import http from 'node:http';
import QRCode from 'qrcode';
import { createPairing } from './pairing.mjs';
import { createTunnel } from './tunnel.mjs';

const cookie = (req) => (req.headers.cookie ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith('fox_device='))?.slice(11) ?? '';
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(JSON.stringify(body));
}
async function body(req) {
  let text = '';
  for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 2048) throw new Error('too large'); }
  return JSON.parse(text || '{}');
}

export function createShareBridge({ port, panelPort, mobilePort, handlePanelRequest, upgrade, serveStatic, publicDir, sameOrigin }) {
  const pairing = createPairing();
  let host = null;
  const remoteRequests = [];
  const remoteSockets = new Map();
  const enabled = port !== undefined;
  const disconnect = () => {
    host = null;
    pairing.reset();
    for (const sockets of remoteSockets.values()) for (const ws of sockets) ws.close(4001, 'tunnel closed');
  };
  const tunnel = enabled ? createTunnel({ port, onDisconnect: disconnect }) : null;
  if (enabled && (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535 || Number(port) === Number(panelPort) || Number(port) === Number(mobilePort))) {
    throw new Error('FOX_SHARE_PORT must be a distinct port from 1 to 65535');
  }
  async function handleLocalPairing(req, res) {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/api/pair/state' && req.method === 'GET') return send(res, 200, { enabled, tunnelUrl: tunnel?.url ?? null, pending: pairing.pending(), devices: pairing.devices() });
    if (req.method !== 'POST' || !sameOrigin(req)) return send(res, 403, { error: 'same-origin POST required' });
    try {
      if (path === '/api/pair/tunnel/start') {
        if (!enabled) return send(res, 409, { error: 'Restart fox with FOX_SHARE_PORT=4851 to enable pairing' });
        const url = await tunnel.start();
        if (!tunnel.running) throw new Error('The tunnel disconnected. Try again.');
        const offer = pairing.offer(url);
        host = new URL(offer.link).host;
        const svg = await QRCode.toString(offer.link, { type: 'svg', width: 220, margin: 1 });
        return send(res, 200, { ...offer, svg, url });
      }
      if (path === '/api/pair/tunnel/stop') { tunnel?.stop(); return send(res, 200, { ok: true }); }
      const data = await body(req);
      if (path === '/api/pair/decision') return send(res, pairing.approve(data.id, data.approve === true) ? 200 : 404, { ok: true });
      if (path === '/api/pair/revoke') {
        const revoked = pairing.revoke(data.id);
        if (revoked) for (const ws of remoteSockets.get(data.id) ?? []) ws.close(4001, 'device revoked');
        return send(res, revoked ? 200 : 404, { ok: revoked });
      }
      return send(res, 404, { error: 'not found' });
    } catch (error) { return send(res, 400, { error: error.code === 'ENOENT' ? 'cloudflared is not installed (brew install cloudflared)' : error.message }); }
  }
  // Tie connected WebSockets to the same grant so local revocation closes live terminal access.
  function remoteUpgrade(req, socket, head) {
    const deviceId = pairing.authorized(cookie(req));
    if (!host || req.headers.host !== host || !deviceId || !sameOrigin(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    upgrade(req, socket, head, deviceId, remoteSockets);
  }
  const remote = enabled ? http.createServer(async (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', `default-src 'self'; connect-src 'self' wss://${host ?? 'localhost'}; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'`);
    const path = new URL(req.url, 'http://localhost').pathname;
    if (!host || req.headers.host !== host) return send(res, 403, { error: 'tunnel URL not configured on the Mac' });
    const now = Date.now();
    while (remoteRequests.length && remoteRequests[0] < now - 60000) remoteRequests.shift();
    if (remoteRequests.length > 120) return send(res, 429, { error: 'too many requests' });
    remoteRequests.push(now);
    if (path === '/api/pair/request' || path === '/api/pair/status') {
      if (req.method !== 'POST' || !sameOrigin(req)) return send(res, 403, { error: 'same-origin POST required' });
      try {
        const data = await body(req);
        if (path === '/api/pair/request') {
          const result = pairing.request(data.token, data.name);
          return send(res, result ? 200 : 403, result ?? { error: 'link invalid or expired' });
        }
        const result = pairing.poll(data.id, data.claim);
        if (!result) return send(res, 403, { error: 'invalid request' });
        if (result.status !== 'approved') return send(res, 200, result);
        return send(res, 200, { status: 'approved' }, { 'set-cookie': `fox_device=${result.token}; HttpOnly; Secure; SameSite=Strict; Path=/` });
      } catch { return send(res, 400, { error: 'invalid pairing request' }); }
    }
    if (!pairing.authorized(cookie(req))) {
      if (req.method === 'GET' && (path === '/' || path === '/pair.js' || path === '/pair.css')) {
        return serveStatic(res, publicDir, path === '/' ? '/pair.html' : path);
      }
      return send(res, 401, { error: 'pairing required' });
    }
    if (path.startsWith('/api/pair/')) return send(res, 404, { error: 'local only' });
    return handlePanelRequest(req, res);
  }) : null;
  remote?.on('upgrade', remoteUpgrade);
  if (enabled) {
    process.once('exit', () => tunnel.stop());
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { tunnel.stop(); process.exit(signal === 'SIGINT' ? 130 : 143); });
  }
  return {
    handleLocalPairing,
    listen() { if (remote) remote.listen(Number(port), '127.0.0.1', () => console.log(`fox pairing gateway → http://127.0.0.1:${port}`)); },
    close() { tunnel?.stop(); remote?.close(); },
  };
}
