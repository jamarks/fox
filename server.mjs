// fx-panel: panel web local sobre la fx CLI.
// Lee ~/.fx/sessions (solo lectura) y abre `fx` en pseudo-terminales vía WebSocket.

import http from 'node:http';
import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { join, resolve, extname, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as pty from 'node-pty';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createSearchIndex } from './search.mjs';
import { latestCompletedReply } from './inbox.mjs';
import { TOOLS, isInstalled, addArgs } from './tools.mjs';
const execFileP = promisify(execFile);

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(__dirname, 'public');
const SESSIONS_DIR = join(homedir(), '.fx', 'sessions');
const PORT = Number(process.env.PORT ?? 4848);
const FX_BIN = process.env.FX_BIN ?? join(homedir(), '.local', 'bin', 'fx');
const STATE_DIR = join(homedir(), '.config', 'fox');
const DROP_DIR = join(STATE_DIR, 'drops');
const DROP_LIMIT = 25 * 1024 * 1024;
const STATE_FILE = join(STATE_DIR, 'state.json');

// Estado del panel: qué sesiones están archivadas y nombres propios. Nunca se escribe en ~/.fx.
async function loadState() {
  const st = await readJson(STATE_FILE, {});
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  return { archived: Array.isArray(st.archived) ? st.archived : [], names: obj(st.names), toolsSignedIn: obj(st.toolsSignedIn) };
}
async function saveState(st) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(st, null, 2));
}
const searchSessions = createSearchIndex(SESSIONS_DIR, loadState);

// ---------- sesiones ----------
async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}

async function listSessions() {
  if (!existsSync(SESSIONS_DIR)) return [];
  const st = await loadState();
  const stateBySession = new Map(); // reservado para enriquecer desde /api/overview
  const ids = await readdir(SESSIONS_DIR);
  const sessions = [];
  for (const id of ids) {
    const dir = join(SESSIONS_DIR, id);
    const meta = await readJson(join(dir, 'session.json'));
    if (!meta) continue;
    const usage = await readJson(join(dir, 'usage-v2.json'));
    const snap = usage?.snapshot ?? {};
    let turns = 0;
    let firstPrompt = '';
    let latestReply = null;
    try {
      const raw = await readFile(join(dir, 'events.jsonl'), 'utf8');
      latestReply = latestCompletedReply(raw);
      for (const l of raw.split('\n')) {
        if (!l.includes('"user"')) continue;
        turns += 1;
        if (!firstPrompt) { try { firstPrompt = JSON.parse(l).event?.user?.text ?? ''; } catch {} }
      }
    } catch {}
    // Subagentes: el padre lista hijos en subagent/children.json; el hijo apunta al padre en subagent/owner.json.
    const owner = await readJson(join(dir, 'subagent', 'owner.json'));
    const childrenFile = await readJson(join(dir, 'subagent', 'children.json'));
    const children = (childrenFile?.children ?? []).map((c) => ({
      id: c.id,
      kind: c.kind,
      name: c.persistent?.agent ?? null,
      phase: c.phase, // running | idle | finished
      task: c.active?.message ?? null,
      startedAt: c.active?.created_at_ms ?? null,
      outcome: c.last_outcome ?? null,
      failure: c.last_failure ?? null,
    }));
    let lastKind = null, partial = null;
    try {
      const raw = await readFile(join(dir, 'events.jsonl'), 'utf8');
      const lines = raw.trim().split('\n');
      for (let i = lines.length - 1; i >= 0 && !lastKind; i--) {
        try {
          const ev = JSON.parse(lines[i]).event;
          lastKind = Object.keys(ev)[0];
          // A cancelled turn keeps what the model had started to write (a subagent's unfinished answer).
          if (lastKind === 'interrupted') partial = ev.interrupted?.partial_text || null;
        } catch {}
      }
    } catch {}
    sessions.push({
      id,
      lastKind,
      partial,
      parentId: owner?.parent_id ?? null,
      children,
      title: meta.title ?? '(untitled)',
      customName: st.names[id] ?? null,
      archived: st.archived.includes(id),
      firstPrompt: firstPrompt.replace(/\s+/g, ' ').slice(0, 160),
      latestReply,
      workspace: meta.workspace_root ?? meta.origin_workspace_root ?? '?',
      provider: meta.provider,
      model: meta.model,
      createdAt: meta.created_at_ms,
      updatedAt: meta.updated_at_ms,
      subagentChild: Boolean(meta.subagent_child),
      live: await ownerAlive(dir),
      turns,
      usage: {
        input: snap.input_tokens ?? 0,
        output: snap.output_tokens ?? 0,
        cacheRead: snap.cache_read_tokens ?? 0,
        cost: snap.total_cost ?? 0,
        wallMs: snap.wall_duration_ms ?? 0,
      },
    });
  }
  sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return sessions;
}

// fx deja owner.live con el pid del proceso dueño; si ese pid ya no existe, el candado es huérfano.
async function ownerAlive(dir) {
  const owner = await readJson(join(dir, 'owner.live'));
  if (!owner?.pid) return false;
  try { process.kill(owner.pid, 0); return true; } catch { return false; }
}

function safeSessionId(id) {
  return /^[A-Za-z0-9_-]{4,64}$/.test(id) ? id : null;
}

// Files a session touched: what fx wrote, edited or read (its own tool calls and its subagents'), plus
// paths it names in its answers that exist on disk (a file made by a shell command shows up that way).
const FILE_RANK = { write: 3, edit: 2, mention: 1, read: 0 };
const realPath = (p) => { try { return realpathSync(p); } catch { return p; } };
async function sessionFiles(id) {
  const meta = await readJson(join(SESSIONS_DIR, id, 'session.json'));
  const root = realPath(meta?.workspace_root ?? meta?.origin_workspace_root ?? '');
  if (!root) return [];
  const kids = (await readJson(join(SESSIONS_DIR, id, 'subagent', 'children.json')))?.children ?? [];
  const files = new Map();
  const add = (ws, path, action, by) => {
    if (!path || typeof path !== 'string' || path.length > 400) return;
    const abs = realPath(resolve(ws, path.replace(/^~(?=\/)/, homedir()))); // one entry per file, even through symlinks
    const f = files.get(abs) ?? { path: abs, action, by: new Set() };
    if (FILE_RANK[action] > FILE_RANK[f.action]) f.action = action;
    f.by.add(by);
    files.set(abs, f);
  };
  const scan = async (sid, by) => {
    const ws = (await readJson(join(SESSIONS_DIR, sid, 'session.json')))?.workspace_root ?? root;
    for (const ev of await readEvents(sid)) {
      if (ev.kind === 'tool_call' && /^(write|edit|read)_file$/.test(ev.name) && !/error|fail/i.test(ev.result?.status ?? '')) add(ws, ev.args?.path, ev.name.split('_')[0], by);
      if (ev.kind === 'assistant' && ev.text) for (const m of ev.text.matchAll(/`([^`\s]+\.[A-Za-z0-9]{1,10})`|\]\(([^)\s]+\.[A-Za-z0-9]{1,10})\)/g)) add(ws, m[1] ?? m[2], 'mention', by);
    }
  };
  await scan(id, 0);
  for (const [i, c] of kids.entries()) if (safeSessionId(c.id)) await scan(c.id, i + 1);
  const out = [];
  for (const f of files.values()) {
    let st = null;
    try { st = await stat(f.path); } catch {}
    if (f.action === 'mention' && !st?.isFile()) continue; // only real files count as mentions
    out.push({ path: f.path, rel: f.path.startsWith(root + '/') ? f.path.slice(root.length + 1) : f.path.replace(homedir(), '~'), action: f.action, by: [...f.by].sort((a, b) => a - b), exists: Boolean(st?.isFile()), size: st?.size ?? 0 });
  }
  return out.sort((a, b) => FILE_RANK[b.action] - FILE_RANK[a.action] || a.rel.localeCompare(b.rel));
}

async function readEvents(id) {
  const dir = join(SESSIONS_DIR, id);
  let raw;
  try { raw = await readFile(join(dir, 'events.jsonl'), 'utf8'); } catch { return []; }
  const out = [];
  const callsById = new Map();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { out.push({ kind: 'raw', text: line }); continue; }
    const ev = rec.event ?? {};
    const kind = Object.keys(ev)[0];
    const body = ev[kind] ?? {};
    const ts = rec.timestamp_ms;
    switch (kind) {
      case 'user':
        out.push({ kind, ts, text: body.text ?? '' });
        break;
      case 'assistant':
        out.push({ kind, ts, text: body.text ?? '' });
        break;
      case 'tool_call': {
        let args = body.arguments_json;
        try { args = JSON.parse(args); } catch {}
        const item = { kind, ts, callId: body.call_id, name: body.tool_name, args, result: null };
        callsById.set(body.call_id, item);
        out.push(item);
        break;
      }
      case 'tool_result': {
        const call = callsById.get(body.call_id);
        const result = { status: body.status, preview: body.preview ?? '', bytes: body.output_bytes ?? 0, artifact: body.artifact_ref ?? null };
        if (call) call.result = result; else out.push({ kind, ts, name: body.tool_name, result });
        break;
      }
      case 'turn_completed':
        out.push({ kind, ts });
        break;
      case 'interrupted':
        out.push({ kind, ts, reason: body.reason ?? 'cancelled', partial: body.partial_text || null });
        break;
      default:
        out.push({ kind: 'raw', ts, text: JSON.stringify(ev).slice(0, 2000) });
    }
  }
  return out;
}

async function readArtifact(id, name) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  try { return await readFile(join(SESSIONS_DIR, id, 'tool-results', name), 'utf8'); } catch { return null; }
}

// ---------- git info por workspace (cacheado) ----------
const gitCache = new Map(); // ws -> { at, info }
async function gitInfo(ws) {
  const hit = gitCache.get(ws);
  if (hit && Date.now() - hit.at < 20000) return hit.info;
  let info = null;
  try {
    const run = (args) => execFileP('git', ['-C', ws, ...args], { timeout: 4000 }).then((r) => r.stdout.trim());
    const top = await run(['rev-parse', '--show-toplevel']).catch(() => null);
    if (top) {
      const [branch, remote, status] = await Promise.all([
        run(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ''),
        run(['remote', 'get-url', 'origin']).catch(() => ''),
        run(['status', '--porcelain']).catch(() => ''),
      ]);
      let url = null, repo = null;
      const m = remote.match(/github\.com[:/]([^/]+\/[^/.]+)(\.git)?$/);
      if (m) { repo = m[1]; url = `https://github.com/${m[1]}`; }
      else if (/^https?:\/\//.test(remote)) { url = remote.replace(/\.git$/, ''); repo = url.replace(/^https?:\/\//, ''); }
      info = { root: top, branch, remote, repo, url, changed: status ? status.split('\n').filter(Boolean).length : 0 };
    }
  } catch {}
  gitCache.set(ws, { at: Date.now(), info });
  return info;
}

// ---------- catálogo de modelos ----------
// `fx models` only lists the active provider, so we switch provider, list, and switch back. Cached on disk.
const MODELS_FILE = join(STATE_DIR, 'models.json');
let modelsCache = null;
async function fxJson(args, env = {}) {
  const { stdout } = await execFileP(FX_BIN, args, { timeout: 20000, env: { ...process.env, ...env } });
  return stdout;
}
async function readFxSettings() { return (await readJson(join(homedir(), '.fx', 'settings.json'))) ?? {}; }
async function fetchModels() {
  const settings = await readFxSettings();
  const original = settings.provider ?? 'codex';
  const status = await fxJson(['status']).catch(() => '');
  const connected = (status.match(/connected_providers=(.*)/)?.[1] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const providers = [];
  if (connected.some((c) => /codex/i.test(c))) providers.push({ id: 'codex', label: 'ChatGPT subscription' });
  if (connected.some((c) => /gateway/i.test(c))) providers.push({ id: 'gateway', label: 'Vercel AI Gateway' });
  const out = { fetchedAt: Date.now(), default: { provider: original, model: settings.models?.[original] ?? null }, providers: [] };
  try {
    for (const p of providers) {
      await fxJson(['provider', p.id]).catch(() => {});
      let ids = [];
      try { ids = JSON.parse(await fxJson(['models', '--json'])).ids ?? []; } catch {}
      out.providers.push({ ...p, models: ids, default: settings.models?.[p.id] ?? null });
    }
  } finally {
    await fxJson(['provider', original]).catch(() => {});
  }
  modelsCache = out;
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(MODELS_FILE, JSON.stringify(out, null, 2));
  return out;
}
async function getModels() {
  if (modelsCache) return modelsCache;
  const cached = await readJson(MODELS_FILE);
  if (cached) { modelsCache = cached; return cached; }
  return fetchModels();
}

// ---------- optional tools for fx (MCP servers) ----------
let mcpPath = null;
async function fxMcpConfig() {
  mcpPath ??= (await execFileP(FX_BIN, ['mcp', 'path'], { timeout: 10000 })).stdout.trim();
  return readJson(mcpPath, {});
}
async function listTools() {
  const config = await fxMcpConfig().catch(() => ({}));
  const st = await loadState();
  return TOOLS.map((t) => {
    const installed = isInstalled(t, config);
    // fx keeps OAuth tokens to itself; fox only remembers that a sign-in it started went through.
    return { id: t.id, label: t.label, description: t.description, installed, needsSignIn: installed && t.auth === 'oauth' && !st.toolsSignedIn[t.id] };
  });
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.svg': 'image/svg+xml' };

function readBody(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b)); });
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function serveStatic(res, root, rel) {
  const path = resolve(root, '.' + rel);
  if (!path.startsWith(root)) return send(res, 403, 'forbidden', 'text/plain');
  try {
    const s = await stat(path);
    if (!s.isFile()) throw new Error('not file');
  } catch { return send(res, 404, 'not found', 'text/plain'); }
  // No browser caching: the panel changes often and a stale app.js is confusing.
  res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(path).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/api/sessions') return send(res, 200, await listSessions());
    if (p === '/api/search') return send(res, 200, await searchSessions(url.searchParams.get('q')));
    if (p === '/api/overview') {
      const [sessions, terminals] = await Promise.all([listSessions(), listTerminals()]);
      const repos = {};
      await Promise.all([...new Set(sessions.map((s) => s.workspace))].map(async (ws) => { repos[ws] = await gitInfo(ws); }));
      const byResume = new Map(terminals.filter((t) => t.resume).map((t) => [t.resume, t]));
      const byId = new Map(sessions.map((s) => [s.id, s]));
      for (const s of sessions) {
        const t = byResume.get(s.id);
        s.terminal = t ? t.name : null;
        s.state = t ? t.activity : (s.live ? 'external' : 'idle');
      }
      // Los hijos no tienen terminal propia: su estado sale de children.json del padre.
      for (const s of sessions) {
        for (const c of s.children) {
          const child = byId.get(c.id);
          if (!child) continue;
          child.subagent = { ...c, parentId: s.id };
          child.state = c.phase === 'running' ? 'working' : c.phase === 'idle' ? 'ready' : 'done';
          if (!child.firstPrompt && c.task) child.firstPrompt = c.task;
        }
      }
      return send(res, 200, { sessions, terminals, repos });
    }
    let m;
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/events$/))) {
      const id = safeSessionId(m[1]);
      if (!id) return send(res, 400, { error: 'bad id' });
      return send(res, 200, await readEvents(id));
    }
    // Files the session touched; content and "open" only for paths in that list.
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/(files|file|open-file)$/))) {
      const id = safeSessionId(m[1]);
      if (!id) return send(res, 400, { error: 'bad id' });
      const files = await sessionFiles(id);
      if (m[2] === 'files') return send(res, 200, files);
      const path = m[2] === 'file' ? url.searchParams.get('path') : JSON.parse(await readBody(req) || '{}').path;
      const f = files.find((x) => x.path === path && x.exists);
      if (!f) return send(res, 404, { error: 'not a file of this session' });
      if (m[2] === 'open-file') {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST' });
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return send(res, 403, { error: 'cross-origin' });
        if (process.platform !== 'darwin') return send(res, 501, { error: 'only on macOS' });
        await execFileP('open', [f.path]);
        return send(res, 200, { ok: true });
      }
      if (f.size > 512 * 1024) return send(res, 200, { tooLarge: true, size: f.size });
      const buf = await readFile(f.path);
      if (buf.includes(0)) return send(res, 200, { binary: true, size: f.size });
      return send(res, 200, { text: buf.toString('utf8'), size: f.size });
    }
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/artifact\/([^/]+)$/))) {
      const id = safeSessionId(m[1]);
      if (!id) return send(res, 400, { error: 'bad id' });
      const text = await readArtifact(id, m[2]);
      return text === null ? send(res, 404, { error: 'not found' }) : send(res, 200, text, 'text/plain; charset=utf-8');
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/sessions\/([^/]+)\/(archive|unarchive|rename)$/))) {
      const id = safeSessionId(m[1]);
      if (!id) return send(res, 400, { error: 'bad id' });
      const st = await loadState();
      if (m[2] === 'archive' && !st.archived.includes(id)) st.archived.push(id);
      if (m[2] === 'unarchive') st.archived = st.archived.filter((x) => x !== id);
      if (m[2] === 'rename') {
        const body = JSON.parse(await readBody(req) || '{}');
        const name = String(body.name ?? '').trim().slice(0, 120);
        if (name) st.names[id] = name; else delete st.names[id];
      }
      await saveState(st);
      return send(res, 200, { ok: true });
    }
    // A file dropped on a terminal: saved under ~/.config/fox/drops so fx can read or attach it by path.
    if (p === '/api/drop' && req.method === 'POST') {
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return send(res, 403, { error: 'cross-origin upload' });
      const raw = basename(String(url.searchParams.get('name') ?? 'file'));
      const safe = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(-80) || 'file';
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > DROP_LIMIT) return send(res, 413, { error: 'file too large (max 25 MB)' }); chunks.push(c); }
      await mkdir(DROP_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').slice(0, 18);
      const path = join(DROP_DIR, `${stamp}-${safe}`);
      await writeFile(path, Buffer.concat(chunks));
      return send(res, 200, { path });
    }
    if (p === '/api/tools' && req.method === 'GET') return send(res, 200, await listTools());
    // Adds one catalog tool to fx's MCP config, the same as running `fx mcp add` by hand; 'signin' runs
    // `fx mcp auth NAME --open`, which opens the provider's sign-in page and waits for it.
    if (req.method === 'POST' && (m = p.match(/^\/api\/tools\/([a-z0-9-]+)\/(add|signin)$/))) {
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return send(res, 403, { error: 'cross-origin' });
      const tool = TOOLS.find((t) => t.id === m[1]);
      if (!tool) return send(res, 404, { error: 'unknown tool' });
      try {
        if (m[2] === 'add') await execFileP(FX_BIN, addArgs(tool), { timeout: 30000 });
        else {
          await execFileP(FX_BIN, ['mcp', 'auth', tool.name, '--open'], { timeout: 5 * 60000 });
          const st = await loadState(); st.toolsSignedIn[tool.id] = true; await saveState(st);
        }
      } catch (err) { return send(res, 500, { error: String(err.stderr || err.message).trim() }); }
      return send(res, 200, await listTools());
    }
    if (p === '/api/models' && req.method === 'GET') return send(res, 200, await getModels());
    if (p === '/api/models/refresh' && req.method === 'POST') { try { return send(res, 200, await fetchModels()); } catch (err) { return send(res, 500, { error: String(err.stderr || err.message) }); } }
    if (p === '/api/terminals' && req.method === 'GET') return send(res, 200, await listTerminals());
    if (p === '/api/terminals' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const cwd = resolve(String(body.cwd ?? homedir()).replace(/^~/, homedir()));
      const resume = body.resume ? safeSessionId(String(body.resume)) : null;
      if (body.resume && !resume) return send(res, 400, { error: 'bad id' });
      const provider = /^[a-z0-9_-]{1,32}$/i.test(String(body.provider ?? '')) ? String(body.provider) : null;
      const model = /^[a-z0-9._\/-]{1,80}$/i.test(String(body.model ?? '')) ? String(body.model) : null;
      try { return send(res, 200, await createTerminal({ cwd, resume, provider, model })); }
      catch (err) { return send(res, 500, { error: String(err.stderr || err.message) }); }
    }
    if (req.method === 'DELETE' && (m = p.match(/^\/api\/terminals\/([^/]+)$/))) {
      return send(res, 200, { ok: await killTerminal(decodeURIComponent(m[1])) });
    }
    // Native folder picker (macOS Finder via AppleScript). Returns { path } or { cancelled: true }.
    if (p === '/api/pick-folder' && req.method === 'POST') {
      if (process.platform !== 'darwin') return send(res, 501, { error: 'native picker only on macOS; type a path instead' });
      try {
        const { stdout } = await execFileP('osascript', ['-e', 'tell application "System Events" to activate', '-e', 'POSIX path of (choose folder with prompt "Open fx in…")'], { timeout: 120000 });
        return send(res, 200, { path: stdout.trim().replace(/\/$/, '') });
      } catch (err) {
        if (/canceled|cancelled|-128/i.test(String(err.stderr || err.message))) return send(res, 200, { cancelled: true });
        return send(res, 500, { error: String(err.stderr || err.message) });
      }
    }
    if (p === '/api/check-dir') {
      const dir = url.searchParams.get('path') ?? '';
      const abs = resolve(dir.replace(/^~/, homedir()));
      let ok = false;
      try { ok = (await stat(abs)).isDirectory(); } catch {}
      return send(res, 200, { ok, path: abs, name: basename(abs) });
    }
    if (p.startsWith('/vendor/xterm/')) return serveStatic(res, join(__dirname, 'node_modules/@xterm/xterm'), p.slice('/vendor/xterm'.length));
    if (p.startsWith('/vendor/addon-fit/')) return serveStatic(res, join(__dirname, 'node_modules/@xterm/addon-fit'), p.slice('/vendor/addon-fit'.length));
    return serveStatic(res, PUBLIC, p === '/' ? '/index.html' : p);
  } catch (err) {
    send(res, 500, { error: String(err) });
  }
});

// ---------- terminales persistentes con tmux ----------
// Cada terminal es una sesión de tmux llamada fx-<...>. fx corre adentro y sobrevive a la página,
// al navegador y a reinicios de este servidor. El navegador solo hace attach/detach.
const TMUX = process.env.TMUX_BIN ?? (existsSync('/opt/homebrew/bin/tmux') ? '/opt/homebrew/bin/tmux' : 'tmux');
const TMUX_PREFIX = 'fx-';

async function tmux(...args) {
  try {
    const { stdout } = await execFileP(TMUX, args, { env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` } });
    return stdout;
  } catch (err) {
    if (/no server running|no sessions|error connecting to/.test(err.stderr ?? '')) return '';
    throw err;
  }
}

async function tmuxOption(name, key) {
  return (await tmux('show-options', '-t', name, '-qv', key)).trim() || null;
}

// Heurística de estado leyendo la pantalla: fx muestra "• Thinking (4s)" o similar mientras trabaja,
// y vuelve al prompt "┃" con el pie "auto · modelo" cuando espera.
async function terminalActivity(name) {
  let screen = '';
  try { screen = await tmux('capture-pane', '-p', '-t', name); } catch { return 'unknown'; }
  const lines = screen.split('\n').filter((l) => l.trim()).slice(-8);
  if (lines.some((l) => /\[y\/n\]|\(y\/n\)|allow|approve|permission|confirm/i.test(l) && /\?/.test(l))) return 'needs_input';
  if (lines.some((l) => /^\s*[•●◐◓◑◒◴◵◶◷⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s.*\(\d+s\)/.test(l) || /^\s*•\s+(Thinking|Working|Running)/i.test(l))) return 'working';
  return 'ready';
}

async function listTerminals() {
  const raw = await tmux('list-sessions', '-F', '#{session_name}|#{session_created}|#{session_attached}');
  const out = [];
  for (const line of raw.split('\n')) {
    const [name, created, attached] = line.split('|');
    if (!name?.startsWith(TMUX_PREFIX)) continue;
    let resume = await tmuxOption(name, '@fx_resume');
    const cwd = await tmuxOption(name, '@fx_cwd');
    // Una terminal nueva todavía no sabe qué sesión de fx creó: la buscamos por workspace y fecha.
    if (!resume && cwd) {
      const createdMs = Number(created) * 1000;
      const candidates = (await listSessions()).filter((s) => s.workspace === cwd && s.createdAt >= createdMs - 5000);
      if (candidates.length) {
        resume = candidates[candidates.length - 1].id;
        await tmux('set-option', '-t', name, '@fx_resume', resume);
      }
    }
    out.push({ name, cwd, resume, attached: Number(attached) > 0, createdAt: Number(created) * 1000, activity: await terminalActivity(name) });
  }
  return out;
}

async function createTerminal({ cwd, resume, provider = null, model = null }) {
  const name = resume ? `${TMUX_PREFIX}${resume}` : `${TMUX_PREFIX}new-${Date.now().toString(36)}`;
  const existing = (await listTerminals()).find((t) => t.name === name);
  if (existing) return existing;
  // New sessions can start on a chosen provider/model; resumed ones keep what the session already has.
  const flags = resume ? '' : `${provider ? ` --provider ${provider}` : ''}${model ? ` --model ${model}` : ''}`;
  const cmd = resume ? `${FX_BIN} session resume ${resume}` : `${FX_BIN}${flags}`;
  await tmux('new-session', '-d', '-s', name, '-x', '140', '-y', '40', '-c', cwd, cmd);
  await tmux('set-option', '-t', name, 'status', 'off');
  await tmux('set-option', '-t', name, 'mouse', 'on');
  await tmux('set-option', '-t', name, 'history-limit', '20000');
  // Si hay varios clientes conectados, el tamaño lo define el último que escribió, no el más chico.
  await tmux('set-option', '-w', '-t', name, 'window-size', 'latest');
  await tmux('set-option', '-w', '-t', name, 'aggressive-resize', 'on');
  await tmux('set-option', '-t', name, '@fx_cwd', cwd);
  if (resume) await tmux('set-option', '-t', name, '@fx_resume', resume);
  return { name, cwd, resume: resume ?? null, attached: false, createdAt: Date.now(), activity: 'working' };
}

async function killTerminal(name) {
  if (!name.startsWith(TMUX_PREFIX)) return false;
  await tmux('kill-session', '-t', name);
  return true;
}

const wss = new WebSocketServer({ server, path: '/pty' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const name = url.searchParams.get('name') ?? '';
  if (!name.startsWith(TMUX_PREFIX)) { ws.close(); return; }
  // The browser measures its terminal before connecting, so the first tmux draw is already the right size.
  const cols = Math.min(500, Math.max(20, Number(url.searchParams.get('cols')) || 140));
  const rows = Math.min(200, Math.max(5, Number(url.searchParams.get('rows')) || 40));

  let proc;
  try {
    proc = pty.spawn(TMUX, ['attach-session', '-t', name], {
      name: 'xterm-256color', cols, rows, cwd: homedir(),
      env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}`, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG ?? 'en_US.UTF-8' },
    });
  } catch (err) {
    ws.send(`\r\n\x1b[31mCould not attach to ${name}: ${err.message}\x1b[0m\r\n`);
    ws.close();
    return;
  }

  proc.onData((data) => { if (ws.readyState === ws.OPEN) ws.send(data); });
  proc.onExit(() => {
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\n\x1b[2m[fx-panel] detached from ${name}\x1b[0m\r\n`);
      ws.close();
    }
  });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'input') proc.write(msg.data);
    else if (msg.type === 'resize' && msg.cols > 0 && msg.rows > 0) proc.resize(msg.cols, msg.rows);
  });
  // Cerrar la pestaña solo desconecta al cliente; la sesión de tmux y fx siguen vivos.
  ws.on('close', () => { try { proc.kill(); } catch {} });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`fox → http://127.0.0.1:${PORT}`);
  console.log(`sessions: ${SESSIONS_DIR}`);
  console.log(`fx: ${FX_BIN}${existsSync(FX_BIN) ? '' : '  (NOT FOUND)'}`);
  console.log(`tmux: ${TMUX}`);
});
