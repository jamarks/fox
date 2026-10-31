// fx-panel: panel web local sobre la fx CLI.
// Lee ~/.fx/sessions (solo lectura) y abre `fx` en pseudo-terminales vía WebSocket.

import http from 'node:http';
import net from 'node:net';
import { readFile, readdir, stat, mkdir, writeFile, rename } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { join, resolve, extname, basename, dirname, sep, relative } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createShareBridge } from './share.mjs';
import { createAuth } from './auth.mjs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as pty from 'node-pty';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createSearchIndex } from './search.mjs';
import { readMetrics } from './metrics.mjs';
import { TOOLS, isInstalled, isEnabled, withEnabled, addArgs, findServer } from './tools.mjs';
import { createSkills } from './skills.mjs';
import { createViewTokens, rewriteRootLinks, VIEW_TYPES } from './view.mjs';
import { createWorkspaces, createRepoCatalog } from './workspaces.mjs';
import { createAppRegistry, createAppRouter, reconcileApps, appKind, appUrl, APP_SESSION } from './apps.mjs';
import { createFxSettings } from './fxsettings.mjs';
import { listSkills } from './skill-shelf.mjs';
import { fastForward, SAFE_GIT } from './gitsync.mjs';
import { sleepCandidates, idleSleepMs, memoryFromMeminfo } from './idle.mjs';
import { createJobStore, createRunner, updateJobRepo } from './jobs.mjs';
import { createPrStates } from './prstate.mjs';
import { createPrs } from './prs.mjs';
import { createBranches } from './branches.mjs';
import { nextRuns, scheduleError, describeSchedule } from './schedule.mjs';
import { ensureFoxNotes, foxNotes } from './notes.mjs';
import { createModels, launchArgs } from './models.mjs';
import { createUsage } from './usage.mjs';
import { turnTimeline } from './timeline.mjs';
import { familyUsage } from './family-usage.mjs';
import { childCompletion } from './inbox.mjs';
import { createFx } from './harnesses/fx.mjs';
import { createClaude, claudeBin } from './harnesses/claude.mjs';
import { toResume, splitOnce, nextWorking, CONTINUE_TEXT } from './restart.mjs';
const execFileP = promisify(execFile);

const __dirname = fileURLToPath(new URL('.', import.meta.url));
// Which fox is running: the release fox-update deployed (it writes VERSION.json, since a release folder has
// no .git), else the checkout this runs from.
const STARTED_AT = Date.now();
async function readVersion() {
  try { return JSON.parse(await readFile(join(__dirname, 'VERSION.json'), 'utf8')); } catch {}
  try {
    const { stdout } = await execFileP('git', ['-C', __dirname, 'log', '-1', '--format=%H%n%cI%n%s'], { timeout: 3000 });
    const [commit, date, subject] = stdout.trim().split('\n');
    const remote = await execFileP('git', ['-C', __dirname, 'remote', 'get-url', 'origin'], { timeout: 3000 }).then((r) => r.stdout.trim()).catch(() => '');
    const repo = remote.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1] ?? null;
    return { commit, date, subject, repo, branch: null };
  } catch { return null; }
}
const VERSION = readVersion();
const PUBLIC = join(__dirname, 'public');
const SESSIONS_DIR = join(homedir(), '.fx', 'sessions');
const PORT = Number(process.env.PORT ?? 4848);
const FX_BIN = process.env.FX_BIN ?? join(homedir(), '.local', 'bin', 'fx');
// FOX_STATE_DIR lets a second fox (a test instance on the same machine) keep its own passkey, sessions and settings.
const STATE_DIR = process.env.FOX_STATE_DIR || join(homedir(), '.config', 'fox');
const DROP_DIR = join(STATE_DIR, 'drops');
const DROP_LIMIT = 25 * 1024 * 1024;
const STATE_FILE = join(STATE_DIR, 'state.json');
const DEPLOY_FILE = join(STATE_DIR, 'deploy-branch');
// The coding agents fox can run (see docs/harnesses.md). fx first: it is the default and owns any id nobody claims.
const HARNESSES = [createFx({ sessionsDir: SESSIONS_DIR, bin: FX_BIN }), createClaude({ bin: claudeBin(), stateDir: STATE_DIR })];
const harnessById = (id) => HARNESSES.find((h) => h.id === id) ?? null;
async function harnessFor(sessionId) {
  for (const h of HARNESSES) { await h.loadRegistry?.(); if (h.id !== 'fx' && h.has(sessionId)) return h; }
  return HARNESSES[0];
}
const FOX_UPDATE = process.env.FOX_UPDATE_BIN || '/usr/local/sbin/fox-update';
const DEPLOY_BRANCHES = ['release', 'main'];
const deployBranch = async () => (await readFile(DEPLOY_FILE, 'utf8').catch(() => '')).trim() === 'main' ? 'main' : 'release';
if (process.env.FOX_PUBLIC_ORIGIN && (process.env.FOX_SHARE_PORT || process.env.FOX_MOBILE_PORT)) {
  throw new Error('FOX_PUBLIC_ORIGIN cannot be combined with the legacy share or mobile listener');
}
const auth = await createAuth({ stateDir: STATE_DIR, disabled: process.env.FOX_AUTH_DISABLED === '1', publicOrigin: process.env.FOX_PUBLIC_ORIGIN });
if (process.env.FOX_AUTH_DISABLED === '1') console.warn('WARNING: Fox passkey authentication disabled; do not expose this server.');

// Estado del panel: qué sesiones están archivadas y nombres propios. Nunca se escribe en ~/.fx.
async function loadState() {
  const st = await readJson(STATE_FILE, {});
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  return { archived: Array.isArray(st.archived) ? st.archived : [], names: obj(st.names), toolsSignedIn: obj(st.toolsSignedIn), launchDirs: obj(st.launchDirs), pendingDirs: obj(st.pendingDirs), resumed: obj(st.resumed) };
}
async function saveState(st) {
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  await writeFile(STATE_FILE, JSON.stringify(st, null, 2), { mode: 0o600 });
}
// Parallel overview polls and launches must not lose one another's pending session access roots.
let launchStateWrite = Promise.resolve();
function updateLaunchState(change) {
  const next = launchStateWrite.then(async () => { const st = await loadState(); change(st); await saveState(st); });
  launchStateWrite = next.catch(() => {});
  return next;
}
// fx's sessions are indexed from its files; the other harnesses' from their events, which they cache.
const searchSessions = createSearchIndex(SESSIONS_DIR, loadState, async () => {
  const st = await loadState();
  const rows = (await listSessions()).filter((s) => s.harness !== 'fx');
  return Promise.all(rows.map(async (s) => {
    let index = 0;
    const messages = (await readEvents(s.id)).filter((e) => e.kind === 'user' || e.kind === 'assistant').map((e) => ({ index: index++, kind: e.kind, text: e.text ?? '' }));
    return { id: s.id, name: Object.hasOwn(st.names, s.id) ? String(st.names[s.id]) : '', title: s.title, updatedAt: s.updatedAt ?? 0, messages };
  }));
});
// Dev-server previews on a server: FOX_PREVIEW_URL=https://fox-{port}.example.com and FOX_PREVIEW_PORTS=3000,5173.
// Each hostname is routed to 127.0.0.1:<port> by the tunnel and protected by Access (see docs/plans).
// Named apps (see apps.mjs): FOX_APPS_URL=https://{name}.example.com and FOX_APPS_PORT, the port the tunnel's
// wildcard rule points at. Off unless both are set.
const APPS = (() => {
  const url = process.env.FOX_APPS_URL, port = Number(process.env.FOX_APPS_PORT);
  const m = url && /^https:\/\/\{name\}\.([a-z0-9.-]+\.[a-z]+)$/i.exec(url);
  return m && Number.isInteger(port) && port > 0 ? { url, port, domain: m[1].toLowerCase() } : null;
})();
const PREVIEW = (() => {
  const url = process.env.FOX_PREVIEW_URL, ports = String(process.env.FOX_PREVIEW_PORTS ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
  return url && /^https:\/\/[^/]*\{port\}[^/]*$/.test(url) && ports.length ? { url, ports } : null;
})();
// AGENTS.md at the root of every new workspace: how the folder is laid out. How to run dev servers and jobs
// lives in fx's personal instructions (see notes.mjs), so every session knows it, in any folder.
function workspaceAgentNotes(ws) {
  const repos = (ws?.repos ?? []).map((r) => `- \`${r.dir}/\`: ${r.owner}/${r.name}`).join('\n');
  return `# Workspace notes (written by fox)

This folder is a fox workspace, not a git repo. Each repo is its own subfolder: run git (status, commit, push, pull requests) and search inside it, and read its AGENTS.md before changing it.
${repos ? `\n${repos}\n` : ''}
Other files here are notes, scratch work and job scripts.
`;
}
const workspaces = createWorkspaces({ stateDir: STATE_DIR, rootDir: join(homedir(), 'workspaces'), agentNotes: workspaceAgentNotes });
const skills = createSkills({ home: homedir(), stateDir: STATE_DIR, workspaces });
// A workspace repo's branch, changed from the sidebar (branches.mjs); refused while a session there is working.
const branches = createBranches({
  workspaces,
  busy: async (dir) => (await listTerminals()).filter((t) => t.activity === 'working' && t.cwd && (t.cwd === dir || t.cwd.startsWith(dir + '/'))).map((t) => t.name),
});
// Jobs (see jobs.mjs). On a server the runner is its own service (FOX_JOBS_RUNNER=external), so deploying fox
// never kills a job mid-run; on a laptop it runs inside fox.
const jobStore = createJobStore({ stateDir: STATE_DIR });
const fxSettings = createFxSettings(join(homedir(), '.fx', 'settings.json'));
const appRegistry = APPS ? createAppRegistry({ stateDir: STATE_DIR, denyPorts: [PORT, APPS.port, 4849] }) : null;
const APP_LOGS = join(STATE_DIR, 'apps');
if (APPS) {
  createAppRouter({ registry: appRegistry, domain: APPS.domain, denyPorts: [PORT, APPS.port, 4849] }).listen(APPS.port, '127.0.0.1', () => console.log(`fox: named apps at ${APPS.url} (router on 127.0.0.1:${APPS.port})`));
}
// On a server, fx learns about previews and jobs (the fox-job command) from a block fox keeps in ~/.fx/AGENTS.md.
// On a laptop fox leaves your fx instructions alone; FOX_FX_NOTES=1 or 0 overrides either way.
if ((process.env.FOX_FX_NOTES ?? (process.env.FOX_PUBLIC_ORIGIN ? '1' : '0')) === '1') {
  ensureFoxNotes(join(homedir(), '.fx', 'AGENTS.md'), foxNotes({ preview: PREVIEW, apps: APPS })).catch((err) => console.error(`fox: could not update fx instructions: ${err.message}`));
  // The same block for Claude Code, in its personal instructions, once it is installed.
  if (harnessById('claude')?.available()) ensureFoxNotes(join(homedir(), '.claude', 'CLAUDE.md'), foxNotes({ preview: PREVIEW, apps: APPS })).catch((err) => console.error(`fox: could not update Claude Code instructions: ${err.message}`));
}
const inlineRunner = process.env.FOX_JOBS_RUNNER === 'external' ? null : createRunner({ store: jobStore, beforeRun: updateJobRepo });
inlineRunner?.start().catch((err) => console.error(`fox: jobs runner failed: ${err.message}`));
// Apps that run a command (see apps.mjs): tmux keeps them up across fox deploys; this check starts them after a
// reboot, restarts what changed and stops what is paused, every few seconds.
const syncApps = () => reconcileApps({ registry: appRegistry, tmux, logDir: APP_LOGS }).catch((err) => console.error(`fox: apps: ${err.message}`));
if (APPS) { syncApps(); setInterval(syncApps, 10000).unref(); }
// Is something answering on a port? For the Apps page; half a second at most.
const portAnswers = (port) => new Promise((ok) => {
  const sock = net.connect(port, '127.0.0.1');
  const done = (v) => { sock.destroy(); ok(v); };
  sock.setTimeout(500, () => done(false)); sock.once('connect', () => done(true)); sock.once('error', () => done(false));
});
async function appsOverview() {
  if (!APPS) return { enabled: false, apps: [] };
  const apps = await appRegistry.list();
  return {
    enabled: true,
    apps: await Promise.all(apps.map(async (a) => {
      const kind = appKind(a);
      const log = kind === 'cmd' ? await readFile(join(APP_LOGS, `${a.name}.log`), 'utf8').catch(() => '') : '';
      const restarts = (log.match(/^\[fox\] exited/gm) ?? []).length;
      const up = a.paused ? false : kind === 'dir' ? Boolean((await stat(a.dir).catch(() => null))?.isDirectory()) : await portAnswers(a.port);
      return { name: a.name, url: appUrl(APPS.url, a.name), kind, port: a.port ?? null, dir: a.dir ?? null, cmd: a.cmd ?? null, cwd: a.cwd ?? null,
        paused: Boolean(a.paused), status: a.paused ? 'paused' : up ? 'up' : 'down', restarts, createdAt: a.createdAt ?? null };
    })),
  };
}
// Scripts a job can run in a folder: .py, .mjs, .js, .sh up to three levels deep, skipping dependencies and dot folders.
async function jobScripts(cwd) {
  const out = [];
  async function walk(dir, rel, depth) {
    if (depth > 3 || out.length >= 200) return;
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__' || e.name === 'venv') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(dir, e.name), r, depth + 1);
      else if (/\.(py|mjs|js|sh)$/.test(e.name)) out.push(r);
    }
  }
  await walk(cwd, '', 0);
  return out.sort();
}
const repoCatalog = createRepoCatalog({ tokensDir: join(homedir(), '.config', 'fox-git', 'tokens') });
const prStates = createPrStates({ tokensDir: join(homedir(), '.config', 'fox-git', 'tokens') });
// Which job run opened a pull request, and the screenshots fx saved there, for the Pull requests page. The run is the
// one the PR names ("Made by a fox job (<run id>)", written by foxjob): later runs link every PR still waiting, so a
// link alone does not say who made it.
let prRunsCache = { at: 0, map: new Map() };
async function prRuns() {
  if (Date.now() - prRunsCache.at < 30_000) return prRunsCache.map;
  const map = new Map(); // run id -> { job, run, shots }
  for (const job of await jobStore.list().catch(() => [])) {
    for (const run of await jobStore.runs(job.id).catch(() => [])) {
      map.set(run.id, { job: job.id, run: run.id, shots: (run.outputs ?? []).map((o) => o.name).filter((n) => /^screenshot[\w.-]*\.(png|jpe?g|webp)$/i.test(n)).sort() });
    }
  }
  prRunsCache = { at: Date.now(), map };
  return map;
}
// Pull requests of the workspaces' repos (prs.mjs): open work and merged history.
const prs = createPrs({
  tokensDir: join(homedir(), '.config', 'fox-git', 'tokens'),
  repos: async () => [...new Set((await listWorkspaces()).flatMap((w) => (w.repos ?? []).map((r) => `${r.owner}/${r.name}`)))],
});
// The sidebar polls the overview every few seconds; workspace git state is cheap but not free.
let workspacesCache = { at: 0, list: [] };
async function listWorkspaces(force = false) {
  if (!force && Date.now() - workspacesCache.at < 4000) return workspacesCache.list;
  workspacesCache = { at: Date.now(), list: await workspaces.list() };
  return workspacesCache.list;
}

// ---------- sesiones ----------
async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}

// Every harness's sessions in one list, with what fox itself keeps (names, archive, extra folders) on top.
async function listSessions() {
  const st = await loadState();
  const sessions = [];
  for (const h of HARNESSES) {
    let rows = [];
    try { rows = await h.listSessions(); } catch (err) { console.error(`fox: listing ${h.label} sessions failed: ${err.message}`); }
    for (const s of rows) sessions.push({ ...s, harness: h.id, harnessLabel: h.label,
      customName: Object.hasOwn(st.names, s.id) ? st.names[s.id] : null,
      archived: st.archived.includes(s.id),
      resumedAfterRestart: Number(st.resumed[s.id]) || null,
      addDirs: Array.isArray(st.launchDirs[s.id]) ? st.launchDirs[s.id] : [] });
  }
  sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return sessions;
}

function safeSessionId(id) {
  return /^[A-Za-z0-9_-]{4,64}$/.test(id) ? id : null;
}

// File tabs ask about their file every few seconds (live reload); one list of sessions serves them for a moment.
let recent = { at: 0, list: null };
async function recentSessions() {
  if (!recent.list || Date.now() - recent.at > 2000) recent = { at: Date.now(), list: listSessions() };
  return recent.list;
}

// Files a session touched: what fx wrote, edited or read (its own tool calls and its subagents'), plus
// paths it names in its answers that exist on disk (a file made by a shell command shows up that way).
const FILE_RANK = { write: 3, edit: 2, mention: 1, read: 0 };
const PREVIEW_TYPES = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
// Files macOS runs instead of showing when opened. Scripts and link files open as text in your editor; apps,
// installers and other bundles are shown in Finder.
const OPEN_AS_TEXT = new Set(['.command', '.tool', '.terminal', '.sh', '.zsh', '.bash', '.csh', '.py', '.rb', '.pl', '.js', '.mjs', '.cjs', '.applescript', '.webloc', '.inetloc', '.fileloc', '.url', '.desktop', '.mobileconfig', '.itermcolors']);
const OPEN_IN_FINDER = new Set(['.app', '.pkg', '.mpkg', '.dmg', '.jar', '.scpt', '.scptd', '.workflow', '.action', '.prefpane', '.saver', '.osax', '.kext', '.plugin', '.bundle', '.dylib']);
const realPath = (p) => { try { return realpathSync(p); } catch { return p; } };
async function sessionFiles(id) {
  const sessions = await recentSessions();
  const session = sessions.find((s) => s.id === id);
  const root = realPath(session?.workspace ?? '');
  if (!session || !root || root === '?') return [];
  const files = new Map();
  const add = (ws, path, action, by) => {
    if (!path || typeof path !== 'string' || path.length > 400) return;
    const abs = realPath(resolve(ws, path.replace(/^~(?=\/)/, homedir()))); // one entry per file, even through symlinks
    const f = files.get(abs) ?? { path: abs, action, by: new Set() };
    if (FILE_RANK[action] > FILE_RANK[f.action]) f.action = action;
    f.by.add(by);
    files.set(abs, f);
  };
  // Each harness says what its tools did (effect + path); the answers' file mentions work the same for all.
  const scan = async (sid, by) => {
    const ws = sessions.find((s) => s.id === sid)?.workspace ?? root;
    for (const ev of await readEvents(sid)) {
      if (ev.kind === 'tool_call' && ['write', 'edit', 'read'].includes(ev.effect) && !/error|fail/i.test(ev.result?.status ?? '')) add(ws, ev.path, ev.effect, by);
      if (ev.kind === 'assistant' && ev.text) for (const m of ev.text.matchAll(/`([^`\s]{1,400}\.[A-Za-z0-9]{1,10})`|\]\(([^)\s]{1,400}\.[A-Za-z0-9]{1,10})\)/g)) add(ws, m[1] ?? m[2], 'mention', by);
    }
  };
  await scan(id, 0);
  for (const [i, c] of (session.children ?? []).entries()) if (safeSessionId(c.id)) await scan(c.id, i + 1);
  const out = [];
  for (const f of files.values()) {
    let st = null;
    try { st = await stat(f.path); } catch {}
    if (f.action === 'mention' && !st?.isFile()) continue; // only real files count as mentions
    out.push({ path: f.path, rel: f.path.startsWith(root + '/') ? f.path.slice(root.length + 1) : f.path.replace(homedir(), '~'), action: f.action, by: [...f.by].sort((a, b) => a - b), exists: Boolean(st?.isFile()), size: st?.size ?? 0, mtime: st?.mtimeMs ?? 0 });
  }
  return out.sort((a, b) => FILE_RANK[b.action] - FILE_RANK[a.action] || a.rel.localeCompare(b.rel));
}

const timingEvents = async (id) => (await harnessFor(id)).timing(id);
const readEvents = async (id) => (await harnessFor(id)).events(id);
const readArtifact = async (id, name) => (await harnessFor(id)).artifact(id, name);

// ---------- git info por workspace (cacheado) ----------
const gitCache = new Map(); // ws -> { at, info }
// fox runs git on its own in folders it did not make: never run a program the repo's config names.
async function gitInfo(ws) {
  const hit = gitCache.get(ws);
  if (hit && Date.now() - hit.at < 20000) return hit.info;
  let info = null;
  try {
    const run = (args) => execFileP('git', ['-C', ws, ...SAFE_GIT, ...args], { timeout: 4000 }).then((r) => r.stdout.trim());
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
async function fxJson(args, env = {}) {
  const { stdout } = await execFileP(FX_BIN, args, { timeout: 20000, env: { ...process.env, ...env } });
  return stdout;
}
async function readFxSettings() { return (await readJson(join(homedir(), '.fx', 'settings.json'))) ?? {}; }
const models = createModels({ fx: fxJson, file: join(STATE_DIR, 'models.json'), readSettings: readFxSettings });
const usage = createUsage({ fx: fxJson });

// ---------- optional tools for fx (MCP servers) ----------
let mcpPath = null;
async function fxMcpConfig() {
  mcpPath ??= (await execFileP(FX_BIN, ['mcp', 'path'], { timeout: 10000 })).stdout.trim();
  return readJson(mcpPath, {});
}
// Turns a tool on or off in fx's MCP config, changing only its `enabled` flag. Written whole and renamed into
// place, with the file's own permissions, so fx never reads half a file. Sessions already running keep theirs.
async function setToolEnabled(tool, enabled) {
  const config = await fxMcpConfig();
  const next = withEnabled(config, tool, enabled);
  const mode = (await stat(mcpPath)).mode & 0o777;
  const tmp = `${mcpPath}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', { mode });
  await rename(tmp, mcpPath);
}
// Sign-in for a remote tool: `fx mcp auth NAME` prints the provider's authorize URL and waits for the
// browser callback. fox hands the URL to the page, which opens it, and polls until fx exits.
const signins = new Map(); // tool id -> { status: 'waiting' | 'done' | 'failed', url, error, proc }
function startSignIn(tool) {
  const prev = signins.get(tool.id);
  if (prev?.status === 'waiting') prev.proc.kill();
  const proc = spawn(FX_BIN, ['mcp', 'auth', tool.name], { stdio: ['ignore', 'pipe', 'pipe'] });
  const entry = { status: 'waiting', url: null, error: '', proc };
  signins.set(tool.id, entry);
  let out = '';
  const timer = setTimeout(() => proc.kill(), 5 * 60000);
  return new Promise((resolveUrl) => {
    const onData = (d) => {
      out += d;
      const m = out.match(/https:\/\/\S+/);
      if (m && !entry.url) { entry.url = m[0]; resolveUrl(entry); }
    };
    proc.stdout.on('data', onData); proc.stderr.on('data', onData);
    proc.on('exit', async (code) => {
      clearTimeout(timer);
      entry.status = code === 0 ? 'done' : 'failed';
      entry.error = code === 0 ? '' : code === null ? 'The sign-in was cancelled or took longer than 5 minutes.' : out.trim().split('\n').pop() || 'The sign-in did not finish.';
      if (code === 0) await updateLaunchState((st) => { st.toolsSignedIn[tool.id] = true; });
      resolveUrl(entry);
    });
  });
}

async function listTools() {
  const config = await fxMcpConfig().catch(() => ({}));
  const st = await loadState();
  // Claude Code, when installed, gets the same catalog in its own config; it signs in to a tool itself (/mcp).
  const claude = harnessById('claude');
  const claudeServers = claude?.available() ? await claude.mcp.servers() : null;
  return TOOLS.map((t) => {
    const installed = isInstalled(t, config);
    // fx keeps OAuth tokens to itself; fox only remembers that a sign-in it started went through.
    return { id: t.id, label: t.label, description: t.description, cost: t.cost ?? null, installed, enabled: installed && isEnabled(t, config),
      needsSignIn: installed && t.auth === 'oauth' && !st.toolsSignedIn[t.id],
      claude: claudeServers ? { enabled: Boolean(findServer(t, { mcp: claudeServers })), oauth: t.auth === 'oauth' } : null };
  });
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };

const BODY_LIMIT = 1024 * 1024;
async function readBody(req) {
  let b = '';
  for await (const c of req) {
    b += c;
    if (b.length > BODY_LIMIT) throw Object.assign(new Error('request too large'), { status: 413 });
  }
  return b;
}

// Every answer of fox's own: no type sniffing, no framing by other sites, no address sent along with links.
const BASE_HEADERS = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'SAMEORIGIN', 'referrer-policy': 'no-referrer' };
// fox's own pages run only fox's own scripts. Inline styles stay (the page sets style= attributes); images may be
// remote (a README's badges, shown in the Markdown frame). The terminal's WebSocket is named: Safari does not
// count ws:// as 'self'.
const pageCsp = (host) => {
  const ws = /^[A-Za-z0-9.:[\]-]+$/.test(host ?? '') ? ` ws://${host} wss://${host}` : '';
  return `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'${ws}; frame-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'`;
};
function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function serveStatic(res, root, rel) {
  const path = resolve(root, '.' + rel);
  if (!path.startsWith(root + sep)) return send(res, 403, 'forbidden', 'text/plain');
  try {
    const s = await stat(path);
    if (!s.isFile()) throw new Error('not file');
  } catch { return send(res, 404, 'not found', 'text/plain'); }
  // No browser caching: the panel changes often and a stale app.js is confusing.
  const type = MIME[extname(path)] ?? 'application/octet-stream';
  const csp = type.startsWith('text/html') && !res.hasHeader('content-security-policy') ? { 'content-security-policy': pageCsp(res.req?.headers.host) } : {};
  res.writeHead(200, { ...BASE_HEADERS, ...csp, 'content-type': type, 'cache-control': 'no-store' });
  createReadStream(path).pipe(res);
}

// Tailscale Serve terminates HTTPS and forwards to this loopback HTTP listener.
// Browsers send the public Origin, so compare it with Host rather than the internal protocol.
function sameOrigin(req) {
  if (!req.headers.origin || !req.headers.host) return false;
  try {
    const origin = new URL(req.headers.origin);
    return origin.host === req.headers.host && (origin.protocol === 'http:' || origin.protocol === 'https:') && origin.origin === req.headers.origin && auth.validOrigin(req);
  } catch { return false; }
}

async function handlePanelRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sameOrigin(req)) return send(res, 403, { error: 'same-origin request required' });
    if (p === '/api/metrics') {
      const days = Number(url.searchParams.get('days') ?? 7);
      if (days !== 7 && days !== 30) return send(res, 400, { error: 'days must be 7 or 30' });
      // fx's sessions are counted from its files; the other agents' from their events.
      const others = await Promise.all((await listSessions()).filter((s) => s.harness !== 'fx').map(async (s) => ({ agent: s.harnessLabel, createdAt: s.createdAt, events: await readEvents(s.id) })));
      return send(res, 200, await readMetrics(SESSIONS_DIR, days, Date.now(), others));
    }
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
        // Children have no parent-pane model: their saved answer or metadata remains their only evidence.
        s.activeModel = t && !s.parentId && !s.subagentChild ? t.activeModel : null;
      }
      // Los hijos no tienen terminal propia: su estado sale de children.json del padre.
      for (const s of sessions) {
        for (const c of s.children) {
          const child = byId.get(c.id);
          if (!child) continue;
          child.subagent = { ...c, parentId: s.id };
          child.childCompletion = childCompletion(child, c);
          child.state = c.phase === 'running' ? 'working' : c.phase === 'idle' ? 'ready' : 'done';
          if (!child.firstPrompt && c.task) child.firstPrompt = c.task;
        }
      }
      for (const s of sessions) {
        if (s.children?.length) s.familyUsage = familyUsage(s, byId);
      }
      return send(res, 200, { sessions, terminals, repos, workspaces: await listWorkspaces() });
    }
    let m;
    if ((m = p.match(/^\/api\/terminals\/([^/]+)\/snapshot$/))) {
      const name = m[1];
      // Only fox-owned terminals currently listed by tmux may be captured; never accept a raw tmux target.
      if (!/^fx-[A-Za-z0-9_-]{1,100}$/.test(name)) return send(res, 404, { error: 'terminal not found' });
      const resume = await tmuxOption(name, '@fx_resume').catch(() => null);
      const h = safeSessionId(resume) ? await harnessFor(resume) : null;
      if (!h?.has(resume)) return send(res, 404, { error: 'terminal not found' });
      // No -E: tmux's -1 endpoint is history, not the visible pane where fx is answering.
      const screen = await tmux('capture-pane', '-p', '-J', '-S', '-32', '-t', name);
      const lines = screen.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))|[\x00-\x08\x0b-\x1f\x7f]/g, '').split('\n');
      while (lines.length && !lines.at(-1).trim()) lines.pop();
      const text = lines.slice(-32).join('\n').slice(-6000);
      return send(res, 200, { text, model: h.screenModel?.(text) ?? null });
    }
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/timeline$/))) {
      const id = safeSessionId(m[1]);
      if (!id) return send(res, 400, { error: 'bad id' });
      const sessions = await listSessions();
      const selected = sessions.find((s) => s.id === id);
      if (!selected) return send(res, 404, { error: 'session not found' });
      const parent = selected.parentId ? sessions.find((s) => s.id === selected.parentId) : selected;
      if (!parent) return send(res, 404, { error: 'parent not found' });
      const children = await Promise.all(parent.children.map(async (c) => ({ ...c,
        events: await timingEvents(c.id), label: sessions.find((s) => s.id === c.id)?.title === '(untitled)' ? null : sessions.find((s) => s.id === c.id)?.title,
        createdAt: sessions.find((s) => s.id === c.id)?.createdAt,
      })));
      const terminal = (await listTerminals()).find((t) => t.resume === parent.id);
      const working = terminal?.activity === 'working' || children.some((c) => c.phase === 'running');
      return send(res, 200, turnTimeline(await timingEvents(parent.id), children, Date.now(), working));
    }
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/events$/))) {
      const id = safeSessionId(m[1]);
      if (!id) return send(res, 400, { error: 'bad id' });
      return send(res, 200, await readEvents(id));
    }
    // Files the session touched; content, preview and "open" only for paths in that list.
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/(files|file|open-file|preview|view-url)$/))) {
      const id = safeSessionId(m[1]);
      if (!id) return send(res, 400, { error: 'bad id' });
      const files = await sessionFiles(id);
      if (m[2] === 'files') return send(res, 200, files);
      const path = m[2] === 'open-file' ? JSON.parse(await readBody(req) || '{}').path : url.searchParams.get('path');
      const f = files.find((x) => x.path === path && x.exists);
      if (!f) return send(res, 404, { error: 'not a file of this session' });
      if (m[2] === 'open-file') {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST' });
        if (process.platform !== 'darwin') return send(res, 501, { error: 'only on macOS' });
        // Opening a script or an app would run it (a repo can ship one for fx to mention): never that.
        const ext = extname(f.path).toLowerCase();
        const how = OPEN_AS_TEXT.has(ext) ? '-t' : OPEN_IN_FINDER.has(ext) || ((await stat(f.path)).mode & 0o111) ? '-R' : null;
        await execFileP('open', how ? [how, f.path] : [f.path]);
        return send(res, 200, { ok: true });
      }
      // The file itself, to render in a preview tab. An agent wrote it, so it runs sandboxed (CSP sandbox
      // without allow-same-origin: an opaque origin that cannot read fox's API or reach its terminals),
      // even when opened full screen in its own browser tab. HEAD answers the ETag for live reload.
      // A page with its CSS and JS: a short-lived /view/ link bound to this session's project folder.
      if (m[2] === 'view-url') {
        const root = realPath((await recentSessions()).find((s) => s.id === id)?.workspace ?? '');
        if (!root || !(f.path === root || f.path.startsWith(root + '/'))) return send(res, 400, { error: 'page is outside the project' });
        // A session that runs in your home folder (or /) is not a project: the link then covers the page's folder only.
        const scope = root === realPath(homedir()) || root === '/' ? dirname(f.path) : root;
        return send(res, 200, { url: viewTokens.issue(scope, f.path) });
      }
      if (m[2] === 'preview') {
        const etag = `"${Math.round(f.mtime)}-${f.size}"`;
        // HEAD works for any file: source tabs use it to know when fx changed the file.
        if (req.method === 'HEAD') { res.writeHead(200, { etag, 'cache-control': 'no-store' }); return res.end(); }
        const type = PREVIEW_TYPES[extname(f.path).toLowerCase()];
        if (!type) return send(res, 415, { error: 'no preview for this file type' });
        if (f.size > 20 * 1024 * 1024) return send(res, 413, { error: 'file too large to preview' });
        res.writeHead(200, {
          'content-type': type, 'cache-control': 'no-store', etag,
          'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox allow-scripts allow-forms allow-popups allow-modals',
        });
        return res.end(await readFile(f.path));
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
      const name = m[2] === 'rename' ? String(JSON.parse(await readBody(req) || '{}').name ?? '').trim().slice(0, 120) : null;
      await updateLaunchState((st) => {
        if (m[2] === 'archive' && !st.archived.includes(id)) st.archived.push(id);
        if (m[2] === 'unarchive') st.archived = st.archived.filter((x) => x !== id);
        if (m[2] === 'rename') { if (name) st.names[id] = name; else delete st.names[id]; }
      });
      return send(res, 200, { ok: true });
    }
    // A file dropped on a terminal: saved under ~/.config/fox/drops so fx can read or attach it by path.
    if (p === '/api/drop' && req.method === 'POST') {
      const raw = basename(String(url.searchParams.get('name') ?? 'file'));
      const safe = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(-80) || 'file';
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > DROP_LIMIT) return send(res, 413, { error: 'file too large (max 25 MB)' }); chunks.push(c); }
      await mkdir(DROP_DIR, { recursive: true, mode: 0o700 });
      const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').slice(0, 18);
      const path = join(DROP_DIR, `${stamp}-${safe}`);
      await writeFile(path, Buffer.concat(chunks), { mode: 0o600 });
      return send(res, 200, { path });
    }
    // A few of fx's own settings (see fxsettings.mjs). New and resumed sessions pick them up.
    if (p === '/api/fx-settings' && req.method === 'GET') return send(res, 200, await fxSettings.list());
    if (p === '/api/fx-settings' && req.method === 'POST') {
      try { const { key, value } = JSON.parse(await readBody(req) || '{}'); return send(res, 200, await fxSettings.set(key, value)); }
      catch (err) { return send(res, err.status ?? 500, { error: err.message }); }
    }
    if (p === '/api/skills' || p.startsWith('/api/skills/')) {
      try {
        if (p === '/api/skills' && req.method === 'GET') return send(res, 200, await skills.list());
        if (p === '/api/skills/popular' && req.method === 'GET') return send(res, 200, await skills.popular());
        if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
        const body = JSON.parse(await readBody(req) || '{}');
        const result = p === '/api/skills/browse' ? await skills.browse(body)
          : p === '/api/skills/peek' ? await skills.peek(body)
          : p === '/api/skills/search' ? await skills.search(body)
          : p === '/api/skills/preview' ? await skills.preview(body)
          : p === '/api/skills/install' ? await skills.install(body.token, body.scope, body.confirmRisk === true)
          : p === '/api/skills/read' ? await skills.read(body.id)
          : p === '/api/skills/remove' ? await skills.remove(body.id) : null;
        return result ? send(res, 200, result) : send(res, 404, { error: 'not found' });
      } catch (err) { return send(res, err.status ?? 500, { error: err.message }); }
    }
    if (p === '/api/tools' && req.method === 'GET') return send(res, 200, await listTools());
    // Sign-in progress for a remote tool (see startSignIn).
    if (req.method === 'GET' && (m = p.match(/^\/api\/tools\/([a-z0-9-]+)\/signin$/))) {
      const e = signins.get(m[1]);
      return send(res, 200, e ? { status: e.status, error: e.error } : { status: 'none' });
    }
    // Adds one catalog tool to fx's MCP config, the same as running `fx mcp add` by hand; 'signin' starts
    // `fx mcp auth NAME` and answers with the authorize URL to open.
    if (req.method === 'POST' && (m = p.match(/^\/api\/tools\/([a-z0-9-]+)\/(add|signin|on|off)$/))) {
      const tool = TOOLS.find((t) => t.id === m[1]);
      if (!tool) return send(res, 404, { error: 'unknown tool' });
      // Claude Code: on adds the server to its user config, off removes it (whatever name it was added under).
      if (url.searchParams.get('agent') === 'claude') {
        const claude = harnessById('claude');
        if (!claude?.available() || (m[2] !== 'on' && m[2] !== 'off')) return send(res, 400, { error: 'Claude Code cannot do that' });
        try {
          const found = findServer(tool, { mcp: await claude.mcp.servers() });
          // fx's own entry for the tool is already tuned for this machine (on a server: installed locally, headless,
          // no npx); Claude Code gets the same command. Otherwise the catalog's.
          const fxEntry = findServer(tool, await fxMcpConfig().catch(() => ({})))?.[1];
          const command = !tool.url && Array.isArray(fxEntry?.command) && fxEntry.command.length ? fxEntry.command : tool.command;
          if (m[2] === 'on' && !found) await claude.mcp.add({ ...tool, command });
          if (m[2] === 'off' && found) await claude.mcp.remove(found[0]);
        } catch (err) { return send(res, 500, { error: err.message }); }
        return send(res, 200, await listTools());
      }
      if (m[2] === 'on' || m[2] === 'off') {
        try { await setToolEnabled(tool, m[2] === 'on'); }
        catch (err) { return send(res, 500, { error: err.message }); }
        return send(res, 200, await listTools());
      }
      if (m[2] === 'signin') {
        const e = await startSignIn(tool);
        return e.url ? send(res, 200, { url: e.url }) : send(res, 500, { error: e.error || 'fx did not give a sign-in URL' });
      }
      try { await execFileP(FX_BIN, addArgs(tool), { timeout: 30000 }); }
      catch (err) { return send(res, 500, { error: String(err.stderr || err.message).trim() }); }
      return send(res, 200, await listTools());
    }
    if (p === '/api/memory' && req.method === 'GET') return send(res, 200, { memory: await memory(), highPct: MEMORY_HIGH_PCT });
    // "Free memory": sleep now every session idle for a few minutes that waits for you and nobody has open.
    if (p === '/api/memory/free' && req.method === 'POST') {
      const before = await memory();
      const slept = await sleepIdleSessions(3 * 60 * 1000);
      if (slept.length) await new Promise((r) => setTimeout(r, 1500)); // let the processes exit
      const after = await memory();
      return send(res, 200, { slept: slept.length, freedMb: before && after ? Math.max(0, before.usedMb - after.usedMb) : null, memory: after });
    }
    // ---------- pull requests ----------
    if (p === '/api/prs' && req.method === 'GET') {
      try {
        const out = await prs.list({ force: url.searchParams.has('fresh'), state: url.searchParams.get('state') ?? 'open', limit: url.searchParams.get('limit') ?? 50 });
        const runs = await prRuns();
        return send(res, 200, { ...out, prs: out.prs.map((pr) => ({ ...pr, run: runs.get(pr.madeBy) ?? null })) });
      }
      catch (err) { return send(res, err.status ?? 500, { error: err.message }); }
    }
    if ((m = p.match(/^\/api\/prs\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/(\d+)(?:\/(files|detail|merge|close|pause|resume))$/))) {
      const [, owner, name, num, action] = m;
      try {
        if (action === 'files' && req.method === 'GET') return send(res, 200, await prs.files(`${owner}/${name}`, num));
        if (action === 'detail' && req.method === 'GET') return send(res, 200, await prs.detail(`${owner}/${name}`, num, { force: url.searchParams.has('fresh') }));
        if (action === 'merge' && req.method === 'POST') return send(res, 200, await prs.merge(`${owner}/${name}`, num));
        if ((action === 'pause' || action === 'resume') && req.method === 'POST') return send(res, 200, await prs[action](`${owner}/${name}`, num));
        if (action === 'close' && req.method === 'POST') return send(res, 200, await prs.close(`${owner}/${name}`, num, JSON.parse(await readBody(req) || '{}').reason));
        return send(res, 405, { error: 'method not allowed' });
      } catch (err) { return send(res, err.status ?? 500, { error: String(err.stderr || err.message).trim().split('\n')[0] }); }
    }
    // ---------- apps (see apps.mjs) ----------
    if (p === '/api/apps' && req.method === 'GET') return send(res, 200, await appsOverview());
    if (APPS && (m = p.match(/^\/api\/apps\/([a-z0-9-]{1,40})(?:\/(pause|resume|restart|log))?$/))) {
      const app = await appRegistry.get(m[1]);
      if (!app) return send(res, 404, { error: 'No app with that name' });
      if (m[2] === 'log' && req.method === 'GET') {
        const text = await readFile(join(APP_LOGS, `${m[1]}.log`), 'utf8').catch(() => '');
        return send(res, 200, { text: text.split('\n').slice(-200).join('\n') });
      }
      if (req.method === 'DELETE' && !m[2]) await appRegistry.remove(m[1]);
      else if (req.method === 'POST' && (m[2] === 'pause' || m[2] === 'resume')) await appRegistry.setPaused(m[1], m[2] === 'pause');
      else if (req.method === 'POST' && m[2] === 'restart' && app.cmd) await tmux('kill-session', '-t', APP_SESSION + m[1]).catch(() => {});
      else return send(res, 405, { error: 'not allowed' });
      await syncApps();
      return send(res, 200, await appsOverview());
    }
    // ---------- jobs ----------
    if (p === '/api/jobs' && req.method === 'GET') return send(res, 200, await jobStore.overview());
    if (p === '/api/jobs' && req.method === 'POST') {
      try { return send(res, 200, await jobStore.create(JSON.parse(await readBody(req) || '{}'))); }
      catch (err) { return send(res, err.status ?? 500, { error: err.message }); }
    }
    if (p === '/api/jobs/preview' && req.method === 'POST') {
      const { schedule, tz } = JSON.parse(await readBody(req) || '{}');
      const error = scheduleError(schedule, tz);
      return send(res, 200, { error, text: error ? '' : describeSchedule(schedule), next: error ? [] : nextRuns(schedule, tz, Date.now(), 5) });
    }
    if (p === '/api/jobs/scripts' && req.method === 'GET') {
      const cwd = resolve(String(url.searchParams.get('cwd') ?? '').replace(/^~/, homedir()));
      return send(res, 200, (await stat(cwd).catch(() => null))?.isDirectory() ? await jobScripts(cwd) : []);
    }
    if ((m = p.match(/^\/api\/jobs\/([0-9a-f-]{36})(?:\/(run|runs)(?:\/([0-9A-Za-z_-]+)(?:\/(log|files)(?:\/([^/]+))?)?)?)?$/))) {
      const [, id, sub, runId, part, file] = m;
      try {
        if (!sub && req.method === 'PATCH') return send(res, 200, await jobStore.update(id, JSON.parse(await readBody(req) || '{}')));
        if (!sub && req.method === 'DELETE') { await jobStore.remove(id); return send(res, 200, { ok: true }); }
        if (sub === 'run' && !runId && req.method === 'POST') { await jobStore.trigger(id); inlineRunner?.tick().catch(() => {}); return send(res, 200, { ok: true }); }
        if (sub === 'runs' && !runId && req.method === 'GET') return send(res, 200, prStates.decorate(await jobStore.runs(id)));
        if (sub === 'runs' && runId && !part && req.method === 'GET') return send(res, 200, await jobStore.provenance(id, runId));
        if (sub === 'runs' && part === 'log' && req.method === 'GET') return send(res, 200, await jobStore.readLog(id, runId), 'text/plain; charset=utf-8');
        if (sub === 'runs' && part === 'files' && file && req.method === 'GET') {
          const path = await jobStore.outputPath(id, runId, decodeURIComponent(file));
          if (!path) return send(res, 404, { error: 'not a file of this run' });
          const ext = extname(path).toLowerCase();
          const type = PREVIEW_TYPES[ext] ?? (['.md', '.txt', '.csv', '.json', '.log'].includes(ext) ? 'text/plain; charset=utf-8' : 'application/octet-stream');
          // A job wrote it: shown sandboxed, like files of a session (opaque origin, no access to fox).
          res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox allow-scripts allow-forms allow-popups allow-modals' });
          return res.end(await readFile(path));
        }
        return send(res, 405, { error: 'method not allowed' });
      } catch (err) { return send(res, err.status ?? 500, { error: err.message }); }
    }
    // On a server, which branch fox-update deploys (/usr/local/sbin/fox-update reads this file every minute):
    // release (merged pull requests) or main (every push). Only where fox-update is installed (setup-server.sh):
    // anywhere else the choice would change nothing.
    const deployable = Boolean(process.env.FOX_PUBLIC_ORIGIN) && existsSync(FOX_UPDATE);
    if (p === '/api/deploy' && req.method === 'GET') return send(res, 200, { available: deployable, branch: await deployBranch() });
    if (p === '/api/deploy' && req.method === 'POST') {
      if (!deployable) return send(res, 404, { error: 'only on a server updated by fox-update' });
      const { branch } = JSON.parse(await readBody(req) || '{}');
      if (!DEPLOY_BRANCHES.includes(branch)) return send(res, 400, { error: 'release or main' });
      await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
      await writeFile(DEPLOY_FILE, branch + '\n', { mode: 0o644 });
      return send(res, 200, { available: true, branch });
    }
    // What the page needs to know about where fox runs: remote or local, and the dev-server preview hostnames.
    if (p === '/api/config' && req.method === 'GET') return send(res, 200, { remote: Boolean(process.env.FOX_PUBLIC_ORIGIN), preview: PREVIEW, version: await VERSION, startedAt: STARTED_AT });
    // Workspaces: folders made of GitHub repos (see workspaces.mjs).
    if (p === '/api/repos' && req.method === 'GET') {
      try { return send(res, 200, await repoCatalog.list({ refresh: url.searchParams.get('refresh') === '1' })); }
      catch (err) { return send(res, 502, { error: err.message }); }
    }
    if (p === '/api/workspaces' && req.method === 'GET') return send(res, 200, await listWorkspaces(true));
    if (p === '/api/companion-repos' && req.method === 'GET') return send(res, 200, await workspaces.companions(url.searchParams.get('cwd') ?? ''));
    if (p === '/api/skill-shelf' && req.method === 'GET') {
      try { return send(res, 200, await listSkills(url.searchParams.get('cwd'), homedir())); }
      catch (err) { return send(res, err.status ?? 500, { error: err.message }); }
    }
    if (p === '/api/workspaces' && req.method === 'POST') {
      try { const ws = await workspaces.create(JSON.parse(await readBody(req) || '{}')); return send(res, 200, ws); }
      catch (err) { return send(res, err.status ?? 500, { error: err.message }); }
    }
    if ((m = p.match(/^\/api\/workspaces\/([0-9a-f-]{36})\/repos\/([A-Za-z0-9._-]+)\/(branches|switch|update|branch)$/))) {
      const [, id, dir, action] = m;
      try {
        if (action === 'branches' && req.method === 'GET') return send(res, 200, await branches.list(id, dir));
        if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
        const body = JSON.parse(await readBody(req) || '{}');
        const out = action === 'switch' ? await branches.switch(id, dir, body.branch, { keep: body.keep === true })
          : action === 'update' ? await branches.update(id, dir) : await branches.create(id, dir, body.name);
        await listWorkspaces(true);
        return send(res, 200, out);
      } catch (err) { return send(res, err.status ?? 500, { error: err.status ? err.message : 'Git operation failed. Check the repo on this machine.', dirty: err.dirty, busy: err.busy }); }
    }
    if ((m = p.match(/^\/api\/workspaces\/([0-9a-f-]{36})(?:\/(fetch|retry))?$/))) {
      const [, id, action] = m;
      try {
        if (action && req.method === 'POST') { const ok = action === 'fetch' ? await workspaces.fetch(id) : await workspaces.retry(id); return send(res, ok ? 200 : 404, ok ? { ok } : { error: 'Workspace not found.' }); }
        if (!action && req.method === 'PATCH') return send(res, 200, await workspaces.update(id, JSON.parse(await readBody(req) || '{}')));
        if (!action && req.method === 'DELETE') { await workspaces.remove(id, { deleteFolder: url.searchParams.get('folder') === '1' }); return send(res, 200, { ok: true }); }
        return send(res, 405, { error: 'method not allowed' });
      } catch (err) { return send(res, err.status ?? 500, { error: err.message, blockers: err.blockers }); }
    }
    if (p === '/api/models' && req.method === 'GET') return send(res, 200, await models.get());
    // Agents to start a session with: only the installed ones.
    if (p === '/api/harnesses' && req.method === 'GET') return send(res, 200, await Promise.all(HARNESSES.filter((h) => h.available()).map(async (h) => ({ id: h.id, label: h.label, models: h.models ?? null, signedIn: h.signedIn ? await h.signedIn() : null }))));
    if (p === '/api/models/refresh' && req.method === 'POST') { try { return send(res, 200, await models.refresh()); } catch (err) { return send(res, 500, { error: String(err.stderr || err.message) }); } }
    if (p === '/api/usage/refresh' && req.method === 'POST') {
      try {
        const provider = JSON.parse(await readBody(req) || '{}').provider;
        if (typeof provider !== 'string' || !(await models.get()).providers.some((x) => x.id === provider)) return send(res, 400, { error: 'Unknown provider' });
        return send(res, 200, await usage.refresh(provider));
      } catch { return send(res, 503, { status: 'unavailable' }); }
    }
    if (p === '/api/terminals' && req.method === 'GET') return send(res, 200, await listTerminals());
    if (p === '/api/terminals' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const cwd = resolve(String(body.cwd ?? homedir()).replace(/^~/, homedir()));
      const resume = body.resume ? safeSessionId(String(body.resume)) : null;
      if (body.resume && !resume) return send(res, 400, { error: 'bad id' });
      try {
        if (resume && (body.addDirs !== undefined || [body.provider, body.model, body.effort, body.speed, body.harness].some((v) => v != null && v !== ''))) return send(res, 400, { error: 'Resume cannot change launch options' });
        const harness = resume ? await harnessFor(resume) : harnessById(body.harness ?? 'fx');
        if (!harness?.available()) return send(res, 400, { error: 'Unknown or missing agent' });
        const addDirs = resume ? [] : await workspaces.validateCompanions(cwd, body.addDirs ?? []);
        // fx's flags come from its model catalog; other harnesses get the model and folders as they are.
        const flags = resume || harness.id !== 'fx' ? [] : [...launchArgs(await models.get(), body), ...(await workspaces.forPath(cwd) ? ['--no-additional-dirs'] : []), ...addDirs.flatMap((dir) => ['--add-dir', dir])];
        return send(res, 200, await createTerminal({ harness, cwd, resume, flags, addDirs, model: harness.id === 'fx' ? null : body.model || null }));
      } catch (err) { return send(res, err.status ?? (err.message?.match(/Unknown provider|Unsupported|Resume cannot/) ? 400 : 500), { error: String(err.stderr || err.message) }); }
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
    if (p.startsWith('/vendor/marked/')) return serveStatic(res, join(__dirname, 'node_modules/marked/lib'), p.slice('/vendor/marked'.length));
    if (p.startsWith('/vendor/hljs/')) return serveStatic(res, join(__dirname, 'node_modules/@highlightjs/cdn-assets'), p.slice('/vendor/hljs'.length));
    if (p.startsWith('/vendor/font/')) return serveStatic(res, join(__dirname, 'node_modules/@fontsource/source-code-pro'), p.slice('/vendor/font'.length));
    return serveStatic(res, PUBLIC, p === '/' ? '/index.html' : p);
  } catch (err) {
    send(res, err.status ?? 500, { error: err.status ? err.message : String(err) });
  }
}

const localHost = (host) => host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}` || host === `[::1]:${PORT}`;
// With FOX_AUTH_DISABLED (the older Tailscale Serve setup): loopback, or a tailnet name, which no other site can
// point at this machine.
const unlockedHost = (host) => localHost(host) || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/i.test(host ?? '');
// /view/<token>/...: a page fx made, with the files it loads. The token is the key (see view.mjs).
const viewTokens = createViewTokens();
async function handleView(req, res, path) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'GET only' });
  const [, , token = '', ...rest] = path.split('/');
  const candidates = viewTokens.candidates(token, rest.join('/'));
  if (candidates === null) return send(res, 410, 'This preview link expired. Open the file again from fox.', 'text/plain; charset=utf-8');
  const root = viewTokens.root(token);
  for (const file of candidates) {
    // A symlink must not lead out of the project or onto a hidden file (a repo can ship one to ~/.ssh).
    const real = realPath(file);
    const rel = relative(root, real);
    if (real !== file && (!rel || rel.startsWith('..') || resolve(root, rel) !== real || rel.split(sep).some((s) => s.startsWith('.')))) continue;
    let st = null;
    try { st = await stat(real); } catch {}
    if (!st?.isFile() || st.size > 20 * 1024 * 1024) continue;
    const type = VIEW_TYPES[extname(file).toLowerCase()];
    let body = await readFile(real);
    if (/^text\/(html|css)/.test(type)) body = rewriteRootLinks(body.toString('utf8'), token, type);
    res.writeHead(200, {
      'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'content-security-policy': 'sandbox allow-scripts allow-forms allow-popups allow-modals',
    });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  return send(res, 404, 'not found', 'text/plain; charset=utf-8');
}

// The icon and app manifest, served before sign-in too: a phone adding fox to its home screen fetches them on its own.
const OPEN_ASSETS = new Set(['/fox.svg', '/icon-180.png', '/icon-512.png', '/manifest.webmanifest']);
const server = http.createServer(async (req, res) => {
  if (process.env.FOX_SHARE_PORT !== undefined && !localHost(req.headers.host)) return send(res, 403, { error: 'use the paired gateway for remote access' });
  const path = new URL(req.url, 'http://localhost').pathname;
  // Without a passkey only fox's own names reach it: another name pointing here (DNS rebinding) is a foreign site.
  if (process.env.FOX_AUTH_DISABLED === '1' && !unlockedHost(req.headers.host)) return send(res, 403, { error: 'host not allowed' });
  if (!auth.accepts(req) && process.env.FOX_AUTH_DISABLED !== '1') {
    if (!process.env.FOX_PUBLIC_ORIGIN && localHost(req.headers.host) && req.method === 'GET' &&
        (path === '/' || path === '/login.html' || path === '/login.css' || path === '/login.js' || OPEN_ASSETS.has(path))) {
      return serveStatic(res, PUBLIC, path === '/' ? '/login.html' : path);
    }
    return send(res, 403, { error: 'host not allowed' });
  }
  // Preview links carry their own key (a short-lived token), so they skip the passkey check: the sandboxed
  // page that loads them has an opaque origin and sends no session cookie.
  if (path.startsWith('/view/')) return handleView(req, res, path);
  if (!auth.active(req)) {
    if (path.startsWith('/api/auth/')) return auth.handle(req, res);
    const enrollment = Boolean(process.env.FOX_PUBLIC_ORIGIN && !auth.registered);
    if (req.method === 'GET' && enrollment &&
        (path === '/' || path === '/enroll.html' || path === '/enroll.css' || path === '/enroll.js' || OPEN_ASSETS.has(path))) {
      return serveStatic(res, PUBLIC, path === '/' ? '/enroll.html' : path);
    }
    if (req.method === 'GET' && !enrollment &&
        (path === '/' || path === '/login.html' || path === '/login.css' || path === '/login.js' || OPEN_ASSETS.has(path))) {
      return serveStatic(res, PUBLIC, path === '/' ? '/login.html' : path);
    }
    return send(res, 401, { error: 'passkey required' });
  }
  if (path.startsWith('/api/auth/')) return auth.handle(req, res);
  if (path.startsWith('/api/pair/')) return bridge.handleLocalPairing(req, res);
  return handlePanelRequest(req, res);
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

// Which harness runs in a terminal: set when fox starts it; terminals from before harnesses run fx.
const terminalHarness = async (name) => harnessById(await tmuxOption(name, '@fox_harness').catch(() => null)) ?? HARNESSES[0];
// Activity and the live model share one bounded visible-pane capture; fx saves replies only after a turn ends.
async function terminalActivity(name, harness = null) {
  let screen = '';
  try { screen = await tmux('capture-pane', '-p', '-t', name); } catch { return { activity: 'unknown', activeModel: null }; }
  const agent = harness ?? await terminalHarness(name);
  const activity = agent.activity(screen);
  return { activity, activeModel: activity === 'working' ? agent.screenModel?.(screen) ?? null : null };
}

async function listTerminals() {
  const raw = await tmux('list-sessions', '-F', '#{session_name}|#{session_created}|#{session_attached}');
  const pending = (await loadState()).pendingDirs;
  const matched = [];
  const out = [];
  const entries = raw.split('\n').map((line) => line.split('|')).filter(([name]) => name?.startsWith(TMUX_PREFIX));
  const known = new Map(await Promise.all(entries.map(async ([name]) => [name, await tmuxOption(name, '@fx_resume')])));
  const assigned = new Set([...known.values()].filter(Boolean));
  for (const [name, created, attached] of entries) {
    let resume = known.get(name);
    const cwd = await tmuxOption(name, '@fx_cwd');
    const harness = await terminalHarness(name);
    // Una terminal nueva todavía no sabe qué sesión de fx creó: la buscamos por workspace y fecha.
    if (!resume && cwd && harness.id === 'fx') {
      const createdMs = Number(created) * 1000;
      const candidates = (await listSessions()).filter((s) => s.workspace === cwd && s.createdAt >= createdMs - 5000 && !assigned.has(s.id));
      if (candidates.length) {
        resume = candidates[candidates.length - 1].id;
        assigned.add(resume);
        await tmux('set-option', '-t', name, '@fx_resume', resume);
      }
    }
    if (resume && pending[name]) matched.push([name, resume]);
    out.push({ name, cwd, resume, harness: harness.id, attached: Number(attached) > 0, createdAt: Number(created) * 1000, ...await terminalActivity(name, harness) });
  }
  if (matched.length) await updateLaunchState((st) => {
    for (const [name, id] of matched) {
      if (!st.pendingDirs[name]) continue;
      st.launchDirs[id] = st.pendingDirs[name];
      delete st.pendingDirs[name];
    }
  });
  return out;
}

// Idle sessions sleep (see idle.mjs). FOX_IDLE_SLEEP_MIN=30 on a server; off by default. Only a terminal that
// waits for you, that nobody has open, idle that long, and whose fx session fox knows (so it can resume it).
const IDLE_SLEEP_MS = idleSleepMs(process.env.FOX_IDLE_SLEEP_MIN);
// `enough` (optional) is checked after each one: freeing memory stops as soon as there is room again.
async function sleepIdleSessions(idleMs = IDLE_SLEEP_MS, enough = null) {
  const raw = await tmux('list-sessions', '-F', '#{session_name}|#{session_attached}|#{session_activity}');
  const candidates = sleepCandidates(raw, { idleMs, prefix: TMUX_PREFIX }); // least recently used first
  const slept = [];
  if (!candidates.length) return slept;
  const terminals = await listTerminals(); // also records which fx session each terminal holds
  for (const name of candidates) {
    if (enough && slept.length && await enough()) break;
    const t = terminals.find((x) => x.name === name);
    if (!t?.resume || t.attached || t.activity !== 'ready') continue;
    await tmux('kill-session', '-t', name).catch(() => {});
    slept.push(t.resume);
    console.log(`fox: ${name} is asleep after ${idleMs >= 60000 ? `${Math.round(idleMs / 60000)} min` : `${Math.round(idleMs / 1000)} s`} idle; opening session ${t.resume} resumes it`);
  }
  return slept;
}
if (IDLE_SLEEP_MS) setInterval(() => sleepIdleSessions().catch((err) => console.error(`fox: idle sleep failed: ${err.message}`)), Math.min(60_000, Math.max(5_000, IDLE_SLEEP_MS / 2))).unref();
// When memory runs high, fox frees it on its own: at FOX_MEMORY_HIGH_PCT (85% by default) it sleeps sessions idle
// for 3 minutes (1 minute from 7 points above), the one you used longest ago first, until there is room again. Same rules as always: only sessions that wait for you and
// nobody has open. FOX_MEMORY_HIGH_PCT=0 turns it off.
const MEMORY_HIGH_PCT = Number(process.env.FOX_MEMORY_HIGH_PCT ?? 85);
async function freeMemoryWhenHigh() {
  const m = await memory();
  if (!m || !(MEMORY_HIGH_PCT > 0) || m.pct < MEMORY_HIGH_PCT) return;
  // Least recently used first, one at a time, until memory is back under the line (5 points of margin).
  const roomAgain = async () => { await new Promise((r) => setTimeout(r, 1500)); const now = await memory(); return !now || now.pct < MEMORY_HIGH_PCT - 5; };
  const slept = await sleepIdleSessions((m.pct >= MEMORY_HIGH_PCT + 7 ? 1 : 3) * 60 * 1000, roomAgain);
  if (slept.length) console.log(`fox: memory at ${m.pct}%, put ${slept.length} idle session${slept.length === 1 ? '' : 's'} to sleep`);
}
if (process.platform === 'linux') setInterval(() => freeMemoryWhenHigh().catch((err) => console.error(`fox: freeing memory failed: ${err.message}`)), 30_000).unref();
// Memory for the sidebar footer: Linux only (on a Mac, free memory is not a useful number). Null elsewhere.
async function memory() {
  if (process.platform !== 'linux') return null;
  return memoryFromMeminfo(await readFile('/proc/meminfo', 'utf8').catch(() => ''));
}

// fx writes links as terminal hyperlinks (OSC 8: the text shows, the address travels with it). tmux keeps them,
// but only passes them on to terminals it knows support them; xterm.js does. Once per tmux server.
let hyperlinksOn = null;
function passHyperlinks() {
  hyperlinksOn ??= tmux('show-options', '-s', 'terminal-features')
    .then((out) => {
      if (!out) { hyperlinksOn = null; return; } // no tmux server yet: try again with the next session
      if (!out.includes('hyperlinks')) return tmux('set-option', '-as', 'terminal-features', ',xterm*:hyperlinks');
    })
    .catch(() => { hyperlinksOn = null; });
  return hyperlinksOn;
}
passHyperlinks(); // for sessions that already run (a browser attaching later picks it up)

// fx starts on current code: the workspace's clean repos on their default branch are fast-forwarded first (see
// gitsync.mjs). Never more than a few seconds; a repo with work in progress is left alone.
async function updateWorkspaceRepos(cwd) {
  const ws = await workspaces.forPath(cwd).catch(() => null);
  if (!ws?.repos?.length) return;
  const all = Promise.all(ws.repos.map(async (r) => {
    if (!(await workspaces.originMatches(ws, r))) return;
    const x = await fastForward(join(ws.dir, r.dir));
    if (x.status === 'updated') console.log(`fox: ${ws.name}/${r.dir} updated ${x.from}..${x.to}`);
  }));
  await Promise.race([all, new Promise((r) => setTimeout(r, 8000))]);
}

// Terminal names keep the "fx-" prefix for every harness: it is fox's namespace in tmux, and sessions that
// were already running when harnesses arrived keep working.
async function createTerminal({ harness = HARNESSES[0], cwd, resume, flags = [], addDirs = [], model = null }) {
  if (resume) {
    const existing = (await listTerminals()).find((t) => t.name === `${TMUX_PREFIX}${resume}`);
    if (existing) return existing;
  }
  await updateWorkspaceRepos(cwd);
  // New sessions can start on a chosen provider/model; resumed ones keep what the session already has.
  const launch = await harness.launch({ cwd, resume, flags, model, addDirs });
  // A harness that knows its id up front (Claude Code) names the terminal after it at once; fx's id comes later.
  const id = launch.id ?? resume ?? null;
  const name = id ? `${TMUX_PREFIX}${id}` : `${TMUX_PREFIX}new-${Date.now().toString(36)}`;
  // tmux runs its command through a shell; every catalog value is a separate, quoted argument.
  const quote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
  const cmd = launch.argv.map(quote).join(' ');
  await tmux('new-session', '-d', '-s', name, '-x', '140', '-y', '40', '-c', cwd, cmd);
  await tmux('set-option', '-t', name, '@fox_harness', harness.id);
  // Focus events let a TUI know when you come back to it (Claude Code asks for them); harmless for the rest.
  await tmux('set-option', '-s', 'focus-events', 'on').catch(() => {});
  await passHyperlinks();
  await tmux('set-option', '-t', name, 'status', 'off');
  await tmux('set-option', '-t', name, 'mouse', 'on');
  await tmux('set-option', '-t', name, 'history-limit', '20000');
  // Si hay varios clientes conectados, el tamaño lo define el último que escribió, no el más chico.
  await tmux('set-option', '-w', '-t', name, 'window-size', 'latest');
  await tmux('set-option', '-w', '-t', name, 'aggressive-resize', 'on');
  await tmux('set-option', '-t', name, '@fx_cwd', cwd);
  if (id) await tmux('set-option', '-t', name, '@fx_resume', id);
  // The fx ID appears after launch. Keep the chosen access roots by tmux name until it can be matched.
  if (!resume && addDirs.length) {
    if (id) await updateLaunchState((st) => { st.launchDirs[id] = addDirs; });
    else await updateLaunchState((st) => { st.pendingDirs[name] = addDirs; });
  }
  return { name, cwd, resume: id, harness: harness.id, attached: false, createdAt: Date.now(), activity: 'working' };
}

async function killTerminal(name) {
  if (!name.startsWith(TMUX_PREFIX)) return false;
  const id = await tmuxOption(name, '@fx_resume').catch(() => null);
  await tmux('kill-session', '-t', `=${name}`); // "=": exactly this session, never one whose name starts the same
  if (id) await forgetWorking(id); // stopped on purpose: never "resume after a restart"
  return true;
}

// ---------- resuming after a restart (see restart.mjs) ----------
const WORKING_FILE = join(STATE_DIR, 'working.json');
let workingWrite = Promise.resolve();
function writeWorking(change) {
  const next = workingWrite.then(async () => {
    const value = change(await readJson(WORKING_FILE, null));
    if (!value) return;
    await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${WORKING_FILE}.${process.pid}`;
    await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
    await rename(tmp, WORKING_FILE);
  });
  workingWrite = next.catch(() => {});
  return next;
}
const forgetWorking = (id) => writeWorking((saved) => saved && Array.isArray(saved.working) && saved.working.includes(id) ? { ...saved, working: saved.working.filter((x) => x !== id) } : null);
// tmux's own start time tells a new tmux server (a reboot, a crash) from the one fox saw before.
const tmuxStartTime = async () => (await tmux('list-sessions', '-F', '#{start_time}').catch(() => '')).split('\n')[0].trim();
let watching = false;
async function watchForRestart() {
  if (watching) return;
  watching = true;
  try {
    const tmuxStart = await tmuxStartTime();
    if (!tmuxStart) return; // tmux not up yet after a boot: try again on the next round
    const terminals = await listTerminals();
    const ids = toResume(await readJson(WORKING_FILE, null), tmuxStart, new Set(terminals.map((t) => t.resume).filter(Boolean)));
    const { resume, skip } = splitOnce(ids, (await loadState()).resumed);
    await writeWorking(() => nextWorking(tmuxStart, terminals, resume));
    for (const id of skip) console.warn(`fox: ${id} was cut off again within the hour after being resumed; left as it is`);
    for (const id of resume) {
      await updateLaunchState((st) => { st.resumed[id] = Date.now(); });
      // One at a time, with time to start: several agents waking at once on a small server start slowly.
      const result = await sendMobileMessage(id, CONTINUE_TEXT, { waitMs: 90_000 }).catch((err) => ({ status: 500, body: { error: err.message } }));
      console.log(`fox: resumed ${id} after a restart: ${result.status === 202 ? 'told it to continue' : result.body?.error}`);
    }
  } catch (err) {
    console.error(`fox: restart watch failed: ${err.message}`);
  } finally { watching = false; }
}
setInterval(() => watchForRestart(), 10_000).unref();
setTimeout(() => watchForRestart(), 3_000).unref();

const wss = new WebSocketServer({ noServer: true });
function upgrade(req, socket, head, deviceId = null, remoteSockets = null) {
  if (!auth.active(req) || new URL(req.url, 'http://localhost').pathname !== '/pty' || !sameOrigin(req)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    auth.track(req, ws);
    if (deviceId) {
      if (!remoteSockets.has(deviceId)) remoteSockets.set(deviceId, new Set());
      remoteSockets.get(deviceId).add(ws);
      ws.once('close', () => remoteSockets.get(deviceId)?.delete(ws));
    }
    wss.emit('connection', ws, req);
  });
}
server.on('upgrade', (req, socket, head) => {
  if ((process.env.FOX_SHARE_PORT !== undefined && !localHost(req.headers.host)) || (process.env.FOX_AUTH_DISABLED === '1' && !unlockedHost(req.headers.host))) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
  }
  upgrade(req, socket, head);
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const name = url.searchParams.get('name') ?? '';
  if (!name.startsWith(TMUX_PREFIX)) { ws.close(); return; }
  // The browser measures its terminal before connecting, so the first tmux draw is already the right size.
  const cols = Math.min(500, Math.max(20, Number(url.searchParams.get('cols')) || 140));
  const rows = Math.min(200, Math.max(5, Number(url.searchParams.get('rows')) || 40));

  let proc;
  try {
    proc = pty.spawn(TMUX, ['attach-session', '-t', `=${name}`], {
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
    // A throw here would stop fox: only text is typed, and sizes are whole numbers in range.
    try {
      if (msg?.type === 'input' && typeof msg.data === 'string') proc.write(msg.data);
      else if (msg?.type === 'resize' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) proc.resize(Math.min(1000, Math.max(2, msg.cols)), Math.min(500, Math.max(2, msg.rows)));
    } catch {}
  });
  // Cerrar la pestaña solo desconecta al cliente; la sesión de tmux y fx siguen vivos.
  ws.on('close', () => { try { proc.kill(); } catch {} });
});

// Paste a mobile message into exactly one fx tmux session. No shell or terminal socket is exposed.
async function sendMobileMessage(id, text, { waitMs = 10_000 } = {}) {
  const session = (await listSessions()).find((s) => s.id === id && !s.subagentChild);
  if (!session) return { status: 404, body: { error: 'Session not found' } };
  const harness = harnessById(session.harness) ?? HARNESSES[0];
  let terminal = (await listTerminals()).find((t) => t.resume === id);
  if (!terminal) {
    if (session.live) return { status: 409, body: { error: 'Session is open outside fox; use that terminal to reply.' } };
    try {
      terminal = await createTerminal({ harness, cwd: session.workspace, resume: id });
      let prompt = false;
      for (let attempt = 0; attempt < waitMs / 200; attempt++) {
        const screen = await tmux('capture-pane', '-p', '-t', terminal.name);
        if (harness.ready(screen)) { prompt = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!prompt) return { status: 409, body: { error: `${harness.label} did not become ready. Open the desktop terminal and check the session.` } };
    } catch (error) { return { status: 409, body: { error: `Could not resume session: ${error.message}` } }; }
  }
  const { activity } = await terminalActivity(terminal.name);
  if (activity === 'working' || activity === 'needs_input') {
    return { status: 409, body: { error: activity === 'working' ? `${harness.label} is still working. Wait for its reply.` : `${harness.label} needs terminal input; use the desktop panel for this prompt.` } };
  }
  // A named, unique tmux buffer and bracketed paste preserve newlines and prevent key-name interpretation.
  const buffer = `fox-mobile-${randomUUID()}`;
  try {
    await tmux('set-buffer', '-b', buffer, '--', text);
    await tmux('paste-buffer', '-p', '-d', '-b', buffer, '-t', terminal.name);
    await tmux('send-keys', '-t', terminal.name, 'Enter');
  } catch (error) {
    await tmux('delete-buffer', '-b', buffer).catch(() => {});
    return { status: 500, body: { error: `Could not send message: ${error.message}` } };
  }
  return { status: 202, body: { ok: true } };
}

// The local mobile page and the isolated tailnet listener use the same scoped reply path.
async function handleMobileReply(req, res, rawId) {
  let source;
  try { source = new URL(req.headers.origin); } catch { return send(res, 403, { error: 'Same-origin request required' }); }
  if (source.host !== req.headers.host || (source.protocol !== 'https:' && !(source.protocol === 'http:' && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(source.host)))) {
    return send(res, 403, { error: 'Same-origin request required' });
  }
  const id = safeSessionId(rawId);
  if (!id) return send(res, 400, { error: 'Invalid session' });
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 12000) return send(res, 413, { error: 'Message too long' });
  }
  let text;
  try { text = JSON.parse(raw).text; } catch { return send(res, 400, { error: 'Invalid message' }); }
  if (typeof text !== 'string' || !text.trim() || text.length > 8000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(text)) {
    return send(res, 400, { error: 'Enter a message of up to 8000 characters' });
  }
  const result = await sendMobileMessage(id, text.replace(/\r\n?/g, '\n'));
  return send(res, result.status, result.body);
}

// Separate, opt-in mobile surface for Tailscale Serve. Never proxy the full panel.
const mobilePort = process.env.FOX_MOBILE_PORT;
if (mobilePort !== undefined) {
  const port = Number(mobilePort);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === PORT) throw new Error('FOX_MOBILE_PORT must be a distinct port from 1 to 65535');
  const mobile = http.createServer(async (req, res) => {
    if (!auth.active(req)) return send(res, 401, { error: 'passkey required' });
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      const reply = p.match(/^\/api\/sessions\/([^/]+)\/reply$/);
      if (req.method === 'POST' && reply) return handleMobileReply(req, res, reply[1]);
      if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
      if (p === '/api/overview') {
        const sessions = (await listSessions()).map(({ id, title, customName, workspace, updatedAt, archived, parentId, latestReply }) =>
          ({ id, title, customName, workspace, updatedAt, archived, parentId, latestReply }));
        return send(res, 200, { sessions });
      }
      if (p === '/api/search') return send(res, 200, await searchSessions(url.searchParams.get('q')));
      const m = p.match(/^\/api\/sessions\/([^/]+)\/events$/);
      if (m) {
        const id = safeSessionId(m[1]);
        if (!id) return send(res, 400, { error: 'bad id' });
        const events = (await readEvents(id)).filter((ev) => (ev.kind === 'user' || ev.kind === 'assistant') && typeof ev.text === 'string')
          .map(({ kind, ts, text }) => ({ kind, ts, text }));
        return send(res, 200, events);
      }
      if (p === '/' || p === '/mobile.css' || p === '/mobile.js') {
        return serveStatic(res, PUBLIC, p === '/' ? '/mobile.html' : p);
      }
      return send(res, 404, { error: 'not available in mobile view' });
    } catch (error) { return send(res, 500, { error: String(error) }); }
  });
  mobile.listen(port, '127.0.0.1', () => console.log(`fox mobile → http://127.0.0.1:${port}`));
}

const bridge = createShareBridge({
  port: process.env.FOX_SHARE_PORT, panelPort: PORT, mobilePort,
  handlePanelRequest: (req, res) => auth.active(req) ? handlePanelRequest(req, res) : send(res, 401, { error: 'passkey required' }),
  upgrade, serveStatic, publicDir: PUBLIC, sameOrigin,
});
bridge.listen();

server.listen(PORT, '127.0.0.1', () => {
  console.log(`fox → http://127.0.0.1:${PORT}`);
  console.log(`sessions: ${SESSIONS_DIR}`);
  console.log(`fx: ${FX_BIN}${existsSync(FX_BIN) ? '' : '  (NOT FOUND)'}`);
  console.log(`tmux: ${TMUX}`);
});
