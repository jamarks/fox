// Named apps: https://<name>.<your domain> -> a dev server on this machine. One wildcard DNS record, one tunnel
// rule and one Access app cover every name, so naming an app is only a line in fox's own list (apps.json);
// nothing in Cloudflare changes. The router (createAppRouter) answers on FOX_APPS_PORT and forwards by Host.
import http from 'node:http';
import net from 'node:net';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const APP_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
// Names the tunnel routes elsewhere (fox itself, its dev copy, the per-port previews).
const RESERVED = /^(fox|fox-dev|fox-\d+|www|mail|api)$/;

export function createAppRegistry({ stateDir, denyPorts = [] }) {
  const file = join(stateDir, 'apps.json');
  const read = async () => { try { const v = JSON.parse(await readFile(file, 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } };
  async function write(apps) {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(apps, null, 2) + '\n', { mode: 0o600 });
    await rename(tmp, file);
  }
  const fail = (message) => Object.assign(new Error(message), { status: 400 });
  return {
    file,
    async list() { return Object.entries(await read()).map(([name, a]) => ({ name, ...a })).sort((x, y) => x.name.localeCompare(y.name)); },
    async get(name) { return (await read())[name] ?? null; },
    async set(name, port) {
      name = String(name ?? '').toLowerCase();
      port = Number(port);
      if (!APP_NAME.test(name)) throw fail('Name it with lowercase letters, numbers and dashes (up to 40).');
      if (RESERVED.test(name)) throw fail(`${name} is taken by fox; choose another name.`);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw fail('The port must be a number from 1024 to 65535.');
      if (denyPorts.includes(port)) throw fail(`Port ${port} is fox itself; it cannot be published.`);
      const apps = await read();
      apps[name] = { port, createdAt: apps[name]?.createdAt ?? Date.now() };
      await write(apps);
      return { name, ...apps[name] };
    },
    async remove(name) {
      const apps = await read();
      if (!apps[name]) return false;
      delete apps[name];
      await write(apps);
      return true;
    },
  };
}

// The URL of an app from a template like https://{name}.example.com.
export const appUrl = (template, name) => template.replace('{name}', name);

// Forwards each request (and WebSocket, for dev-server reload) to its app's port, as `localhost` the way the
// per-port previews do, so dev servers that only accept localhost (Vite) answer. Unknown names get a short page.
export function createAppRouter({ registry, domain, log = console }) {
  const suffix = `.${domain}`;
  const nameOf = (host) => {
    const h = String(host ?? '').toLowerCase().replace(/:\d+$/, '');
    return h.endsWith(suffix) ? h.slice(0, -suffix.length) : null;
  };
  async function target(req) {
    const name = nameOf(req.headers.host);
    const app = name && APP_NAME.test(name) ? await registry.get(name) : null;
    return app ? { name, port: app.port } : { name };
  }
  const headersFor = (req) => ({ ...req.headers, host: 'localhost', 'x-forwarded-host': req.headers.host, 'x-forwarded-proto': 'https' });
  const server = http.createServer(async (req, res) => {
    const t = await target(req);
    if (!t.port) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(t.name ? `No app named ${t.name}. On the server, fox-expose ${t.name} <port> publishes one.\n` : 'Not found\n');
    }
    const up = http.request({ host: '127.0.0.1', port: t.port, method: req.method, path: req.url, headers: headersFor(req) }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`${t.name} is not running: nothing answers on port ${t.port}.\n`);
    });
    req.pipe(up);
  });
  server.on('upgrade', async (req, socket, head) => {
    const t = await target(req);
    if (!t.port) return socket.destroy();
    const up = net.connect(t.port, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(headersFor(req)).map(([k, v]) => `${k}: ${v}`)];
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(socket); socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  server.on('clientError', (err, socket) => socket.destroy());
  return server;
}
