// Named apps: https://<name>.<your domain>, private to you (Cloudflare Access). One wildcard DNS record, one
// tunnel rule and one Access app cover every name, so naming an app is only a line in fox's own list
// (apps.json); nothing in Cloudflare changes. The router (createAppRouter) answers on FOX_APPS_PORT by Host.
// An app is one of three kinds, so it can outlive the session that made it:
//   port  a server something else keeps running (fox only forwards to it)
//   dir   a folder of static files fox serves itself (nothing else has to run)
//   cmd   a command fox keeps running in tmux (it lives with the sessions, so a fox deploy does not stop it),
//         started again if it exits and after the machine restarts (reconcileApps)
// A paused app keeps its entry but stops answering (and its command stops).
import http from 'node:http';
import net from 'node:net';
import { constants } from 'node:fs';
import { readFile, writeFile, mkdir, rename, stat, realpath, open } from 'node:fs/promises';
import { join, resolve, extname, sep, relative } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';

export const APP_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
// Names the tunnel routes elsewhere (fox itself, its dev copy, the per-port previews).
const RESERVED = /^(fox|fox-dev|fox-\d+|www|mail|api)$/;

export function createAppRegistry({ stateDir, denyPorts = [], home = homedir() }) {
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
    // spec: a port number, or { port } | { dir } | { cmd, cwd, port }.
    async set(name, spec) {
      name = String(name ?? '').toLowerCase();
      if (typeof spec !== 'object' || spec === null) spec = { port: spec };
      if (!APP_NAME.test(name)) throw fail('Name it with lowercase letters, numbers and dashes (up to 40).');
      if (RESERVED.test(name)) throw fail(`${name} is taken by fox; choose another name.`);
      const checkPort = (value) => {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw fail('The port must be a number from 1024 to 65535.');
        if (denyPorts.includes(port)) throw fail(`Port ${port} is fox itself; it cannot be published.`);
        return port;
      };
      let entry;
      if (spec.dir !== undefined) entry = { dir: await checkDir(spec.dir, home) };
      else if (spec.cmd !== undefined) {
        const cmd = String(spec.cmd).trim();
        if (!cmd || cmd.length > 2000 || /[\r\n\0]/.test(cmd)) throw fail('Give the command on one line.');
        entry = { cmd, cwd: await checkDir(spec.cwd ?? home, home), port: checkPort(spec.port) };
      } else entry = { port: checkPort(spec.port) };
      const apps = await read();
      apps[name] = { ...entry, createdAt: apps[name]?.createdAt ?? Date.now() };
      await write(apps);
      return { name, ...apps[name] };
    },
    async setPaused(name, paused) {
      const apps = await read();
      if (!apps[name]) return null;
      if (paused) apps[name].paused = true; else delete apps[name].paused;
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

// A folder an app may serve or run in: an existing directory inside your home, with no hidden folder on the
// way (~/.ssh, ~/.config with fox's own state), never the home itself.
async function checkDir(value, home) {
  const fail = (message) => Object.assign(new Error(message), { status: 400 });
  const dir = resolve(String(value ?? '').replace(/^~(?=\/|$)/, home));
  if (!(dir.startsWith(home + sep)) || dir.slice(home.length + 1).split(sep).some((p) => p.startsWith('.'))) throw fail('The folder must be inside your home, and not a hidden one.');
  const st = await stat(dir).catch(() => null);
  if (!st?.isDirectory()) throw fail(`${value} is not a folder.`);
  // Store the real folder so a linked directory cannot bypass the home/hidden check or be retargeted later.
  const actual = await realpath(dir);
  if (!actual.startsWith(home + sep) || actual.slice(home.length + 1).split(sep).some((p) => p.startsWith('.'))) throw fail('The folder must be inside your home, and not a hidden one.');
  return actual;
}
export const appKind = (a) => (a.dir ? 'dir' : a.cmd ? 'cmd' : 'port');

// Files a static app serves: what a site loads, never hidden files, never outside its folder.
export const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.pdf': 'application/pdf', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json',
};
export async function staticFile(dir, urlPath) {
  let rel;
  try { rel = decodeURIComponent(String(urlPath).split('?')[0]); } catch { return null; }
  const parts = rel.split('/').filter(Boolean);
  if (parts.some((p) => p.startsWith('.') || p.includes('\\') || p.includes('\0'))) return null;
  let handle;
  try {
    const root = await realpath(dir);
    const inside = (path) => {
      const sub = relative(root, path);
      return sub !== '..' && !sub.startsWith('..' + sep) && !sub.split(sep).some((p) => p.startsWith('.'));
    };
    // Inspect the opened inode, not a path that may be replaced before the response is streamed.
    const actual = (fd) => realpath(`/proc/self/fd/${fd}`);
    // A named pipe in the published folder must not hold a request open waiting for a writer.
    handle = await open(resolve(dir, ...parts), constants.O_RDONLY | constants.O_NONBLOCK);
    let path = await actual(handle.fd);
    if (!inside(path)) return null;
    let st = await handle.stat();
    if (st.isDirectory()) {
      // The index is opened relative to the validated directory descriptor, not its mutable name.
      const folder = handle;
      handle = null;
      try { handle = await open(`/proc/self/fd/${folder.fd}/index.html`, constants.O_RDONLY | constants.O_NONBLOCK); }
      finally { await folder.close(); }
      path = await actual(handle.fd);
      if (!inside(path)) return null;
      st = await handle.stat();
    }
    const type = STATIC_TYPES[extname(path).toLowerCase()];
    if (!st.isFile() || !type) return null;
    const result = { handle, type, size: st.size };
    handle = null;
    return result;
  } catch { return null; }
  finally { await handle?.close(); }
}

// The URL of an app from a template like https://{name}.example.com.
export const appUrl = (template, name) => template.replace('{name}', name);

// Forwards each request (and WebSocket, for dev-server reload) to its app's port, as `localhost` the way the
// per-port previews do, so dev servers that only accept localhost (Vite) answer. Unknown names get a short page.
export function createAppRouter({ registry, domain, denyPorts = [], log = console }) {
  const suffix = `.${domain}`;
  const nameOf = (host) => {
    const h = String(host ?? '').toLowerCase().replace(/:\d+$/, '');
    return h.endsWith(suffix) ? h.slice(0, -suffix.length) : null;
  };
  async function target(req) {
    const name = nameOf(req.headers.host);
    const app = name && APP_NAME.test(name) ? await registry.get(name) : null;
    if (!app) return { name };
    if (app.paused) return { name, paused: true };
    if (app.dir) return { name, dir: app.dir };
    return app.port && !denyPorts.includes(app.port) ? { name, port: app.port } : { name }; // apps.json edited by hand
  }
  async function serveStaticApp(req, res, t) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('This app is a folder of files: it only answers GET.\n'); }
    const f = await staticFile(t.dir, new URL(req.url, 'http://x').pathname);
    if (!f) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Not found\n'); }
    if (req.method === 'HEAD') {
      await f.handle.close();
      res.writeHead(200, { 'content-type': f.type, 'content-length': f.size, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
      return res.end();
    }
    const stream = f.handle.createReadStream();
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    res.writeHead(200, { 'content-type': f.type, 'content-length': f.size, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
    stream.pipe(res);
  }
  // Cloudflare Access proves who you are to the tunnel; the dev server gets no copy of that proof.
  const headersFor = (req) => {
    const h = { ...req.headers, host: 'localhost', 'x-forwarded-host': req.headers.host, 'x-forwarded-proto': 'https' };
    for (const k of Object.keys(h)) if (k.startsWith('cf-access-')) delete h[k];
    if (h.cookie) { h.cookie = h.cookie.split(';').map((c) => c.trim()).filter((c) => c && !/^CF_Authorization=/i.test(c)).join('; '); if (!h.cookie) delete h.cookie; }
    return h;
  };
  const server = http.createServer(async (req, res) => {
    const t = await target(req);
    if (t.paused) { res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }); return res.end(`${t.name} is paused. Resume it on fox's Apps page.\n`); }
    if (t.dir) return serveStaticApp(req, res, t);
    if (!t.port) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(t.name ? `No app named ${t.name}. On the server, fox-expose ${t.name} publishes one (a port, --dir or --cmd).\n` : 'Not found\n');
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

// ---------- commands kept running ----------
// Each cmd app is a tmux session app-<name> running a small loop (run, log, wait, run again), so it survives fox
// deploys like the fx sessions do. reconcileApps makes tmux match apps.json: it starts what is missing (after a
// reboot too), restarts what changed, and stops what is paused or removed. `tmux` is fox's tmux helper.
export const APP_SESSION = 'app-';
const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export const appSpecHash = (a) => createHash('sha256').update(JSON.stringify([a.cmd, a.cwd, a.port])).digest('hex').slice(0, 16);
export function appLoop(app, logFile) {
  return [
    `cd ${quote(app.cwd)} || exit 1`,
    `export PORT=${app.port}`,
    `while :; do`,
    `  echo "[fox] start $(date '+%F %T')" >> ${quote(logFile)}`,
    `  bash -lc ${quote(app.cmd)} >> ${quote(logFile)} 2>&1`,
    `  echo "[fox] exited with $? at $(date '+%F %T'); starting again in 3s" >> ${quote(logFile)}`,
    `  sleep 3`,
    `done`,
  ].join('\n');
}
export async function reconcileApps({ registry, tmux, logDir }) {
  const apps = await registry.list();
  const live = new Set((await tmux('list-sessions', '-F', '#{session_name}')).split('\n').filter((n) => n.startsWith(APP_SESSION)));
  const wanted = new Map(apps.filter((a) => a.cmd && !a.paused).map((a) => [APP_SESSION + a.name, a]));
  for (const name of live) {
    const app = wanted.get(name);
    const spec = app ? (await tmux('show-options', '-t', name, '-qv', '@fox_app_spec')).trim() : null;
    if (!app || spec !== appSpecHash(app)) { await tmux('kill-session', '-t', name).catch(() => {}); live.delete(name); }
  }
  await mkdir(logDir, { recursive: true, mode: 0o700 });
  for (const [session, app] of wanted) {
    if (live.has(session)) continue;
    const log = join(logDir, `${app.name}.log`);
    // Keep the log readable: start over when it passes 1 MB.
    if (((await stat(log).catch(() => null))?.size ?? 0) > 1024 * 1024) await writeFile(log, '', { mode: 0o600 });
    const script = join(logDir, `${app.name}.sh`);
    await writeFile(script, appLoop(app, log) + '\n', { mode: 0o700 });
    await tmux('new-session', '-d', '-s', session, '-c', app.cwd, `bash ${quote(script)}`);
    await tmux('set-option', '-t', session, '@fox_app_spec', appSpecHash(app));
    await tmux('set-option', '-t', session, 'status', 'off');
  }
}
