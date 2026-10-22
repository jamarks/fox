// Claude Code as a harness. fox picks the session id itself (`claude --session-id`), so a new terminal knows its
// session from the first second, and keeps a small list of the sessions it launched: only those show in fox
// (a Mac's ~/.claude/projects also holds every desktop-app and terminal session, which is not fox's business).
// Claude Code writes one transcript per session, ~/.claude/projects/<cwd with every non-alphanumeric as ->/<id>.jsonl,
// a line per record as it goes; this file turns it into fox's events. Its format is not a public API: unknown
// records are skipped, so a change upstream costs Read some detail, never the session.
import { readFile, readdir, stat, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// A subagent is shown as its own session: <parent id>-<agent id>.
const CHILD = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(a[0-9a-f]{6,24})$/;
const EFFECTS = { Write: 'write', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Read: 'read', Bash: 'shell' };
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);
export const CLAUDE_MODELS = [
  { id: 'opus', name: 'Opus' },
  { id: 'sonnet', name: 'Sonnet' },
  { id: 'haiku', name: 'Haiku' },
];
const slug = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');
const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const ms = (t) => { const n = Date.parse(t ?? ''); return Number.isFinite(n) ? n : null; };

// Text a person typed, without the wrappers Claude Code puts around slash commands and shell escapes.
function promptText(content) {
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '';
  if (/^\s*<(local-command-stdout|local-command-caveat|system-reminder)>/.test(text)) return null;
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (cmd) return `${cmd[1]} ${/<command-args>([^<]*)<\/command-args>/.exec(text)?.[1] ?? ''}`.trim();
  const bash = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(text);
  if (bash) return `! ${bash[1]}`;
  return text;
}
const resultText = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : '')).join('\n') : '';

// One transcript → fox events plus what the sidebar needs. Pure, so tests feed it real lines.
// A subagent's own transcript is all "sidechain" records; in a parent's they are not the parent's conversation.
export function parseTranscript(raw, { sidechain = false } = {}) {
  const events = [], calls = new Map(), seenUsage = new Set();
  const info = { title: null, firstPrompt: '', turns: 0, model: null, cwd: null, firstAt: null, lastAt: null, latestReply: null, lastKind: null,
    usage: { input: 0, output: 0, cacheRead: 0, cost: 0, wallMs: 0 }, subagentCalls: [], handback: null };
  let open = null, messageIndex = 0, completed = 0, answer = null; // open: the assistant message that may end the turn
  // A turn ends with the message that stopped it, stamped with that message's time.
  const endTurn = () => {
    if (!open) return;
    events.push({ kind: 'turn_completed', ts: open.ts });
    completed++;
    if (answer) info.latestReply = { ...answer, turn: completed, at: open.ts };
    answer = null; open = null;
  };
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; } // a half-written last line
    if (rec.type === 'custom-title' && rec.customTitle) { info.title = String(rec.customTitle).slice(0, 200); continue; }
    if (rec.type === 'summary' && rec.summary && !info.title) { info.title = String(rec.summary).slice(0, 200); continue; }
    if ((rec.type !== 'user' && rec.type !== 'assistant') || (rec.isSidechain && !sidechain)) continue;
    const ts = ms(rec.timestamp);
    info.firstAt ??= ts; if (ts) info.lastAt = ts;
    info.cwd ??= rec.cwd ?? null;
    const content = rec.message?.content;
    if (rec.type === 'user') {
      if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) {
        for (const b of content) {
          if (b?.type !== 'tool_result') continue;
          const text = resultText(b.content);
          const call = calls.get(b.tool_use_id);
          const result = { status: b.is_error ? 'error' : 'ok', preview: text.slice(0, 4000), bytes: text.length, artifact: null };
          if (call) { call.result = result; if (call.subagent) call.subagent.done = { ok: !b.is_error, text: text.slice(0, 400) }; }
        }
        continue;
      }
      // Only what a person typed is a prompt: a subagent's hand-back or a task notification arrives as a user
      // record too, marked as coming from the system.
      if (rec.isMeta || rec.promptSource === 'system') continue;
      const text = promptText(content);
      if (text === null) continue;
      if (/^\[Request interrupted by user/.test(text)) {
        events.push({ kind: 'interrupted', ts, reason: 'cancelled', partial: null });
        open = null; answer = null;
        continue;
      }
      endTurn();
      events.push({ kind: 'user', ts, text });
      messageIndex++; info.turns++;
      if (!info.firstPrompt) info.firstPrompt = text;
      continue;
    }
    // assistant: one record per content block, all sharing the message id and usage.
    const m = rec.message ?? {};
    // Claude Code writes "No response requested." itself when a session resumes mid-turn: not an answer, not a turn.
    if (m.model === '<synthetic>' && Array.isArray(content) && content.every((b) => b?.type === 'text' && b.text.trim() === 'No response requested.')) continue;
    if (open && open.id !== m.id) endTurn();
    if (m.model && m.model !== '<synthetic>') info.model = m.model;
    if (m.usage && m.id && !seenUsage.has(m.id)) {
      seenUsage.add(m.id);
      info.usage.input += (m.usage.input_tokens ?? 0) + (m.usage.cache_creation_input_tokens ?? 0);
      info.usage.output += m.usage.output_tokens ?? 0;
      info.usage.cacheRead += m.usage.cache_read_input_tokens ?? 0;
    }
    for (const b of Array.isArray(content) ? content : []) {
      if (b?.type === 'text' && b.text?.trim()) {
        events.push({ kind: 'assistant', ts, text: b.text });
        answer = { text: b.text.replace(/\s+/g, ' ').trim().slice(0, 180), messageIndex };
        messageIndex++;
      } else if (b?.type === 'tool_use' && b.name === 'SubagentHandback') {
        info.handback = String(b.input?.message ?? ''); // a subagent's final report to its parent
      } else if (b?.type === 'tool_use') {
        const effect = EFFECTS[b.name] ?? 'other';
        const item = { kind: 'tool_call', ts, callId: b.id, name: b.name, args: b.input ?? {}, result: null, effect,
          path: ['write', 'edit', 'read'].includes(effect) ? b.input?.file_path ?? b.input?.notebook_path ?? null : null };
        if (SUBAGENT_TOOLS.has(b.name)) {
          item.subagent = { prompt: String(b.input?.prompt ?? ''), description: b.input?.description ?? null, type: b.input?.subagent_type ?? null, at: ts, done: null };
          info.subagentCalls.push(item.subagent);
        }
        calls.set(b.id, item);
        events.push(item);
      }
    }
    // A message that stopped for any reason but a tool call ends the turn, once its last block is written.
    open = m.stop_reason && m.stop_reason !== 'tool_use' ? { id: m.id, ts } : null;
  }
  endTurn();
  const last = events.at(-1);
  info.lastKind = last?.kind ?? null;
  return { events, info };
}

// A fox started from inside a Claude Code session (an agent testing fox) inherits that session's variables, and a
// claude launched with them talks to the parent's proxy instead of signing in as itself. Only then are they dropped.
function inherited(env) {
  const inside = (k) => k === 'CLAUDECODE' || /^CLAUDE_(CODE|AGENT_SDK)_/.test(k);
  if (!Object.keys(env).some(inside)) return [];
  return Object.keys(env).filter((k) => inside(k) || ['CLAUDE_PID', 'CLAUDE_EFFORT', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL'].includes(k));
}
function cleanEnv(env, argv) {
  const drop = inherited(env);
  return drop.length ? ['env', ...drop.flatMap((k) => ['-u', k]), ...argv] : argv;
}

export function createClaude({ bin, stateDir, projectsDir = join(homedir(), '.claude', 'projects'), liveDir = join(homedir(), '.claude', 'sessions'), configFile = join(homedir(), '.claude.json'), env = process.env }) {
  const registryFile = join(stateDir, 'claude-sessions.json');
  let registry = null;
  const loadRegistry = async () => registry ??= await readFile(registryFile, 'utf8').then(JSON.parse).catch(() => ({}));
  async function remember(id, entry) {
    const all = await loadRegistry();
    all[id] = { ...all[id], ...entry };
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${registryFile}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    await rename(tmp, registryFile);
  }

  // Where a session's transcript is: under its folder's project dir (as typed, or with symlinks resolved).
  const paths = new Map();
  async function transcriptPath(id, cwd) {
    const hit = paths.get(id);
    if (hit && existsSync(hit)) return hit;
    for (const dir of new Set([cwd, real(cwd)].filter(Boolean).map(slug))) {
      const p = join(projectsDir, dir, `${id}.jsonl`);
      if (existsSync(p)) { paths.set(id, p); return p; }
    }
    return null;
  }

  // Parsed transcripts, kept while the file is unchanged: the sidebar asks every few seconds.
  const parsed = new Map();
  async function load(file) {
    const st = await stat(file).catch(() => null);
    if (!st) return null;
    const key = `${st.mtimeMs}:${st.size}`;
    const hit = parsed.get(file);
    if (hit?.key === key) return hit;
    const entry = { key, mtime: st.mtimeMs, ...parseTranscript(await readFile(file, 'utf8'), { sidechain: file.includes(`${sep}subagents${sep}`) }) };
    parsed.set(file, entry);
    return entry;
  }

  // Open sessions announce themselves in ~/.claude/sessions/<pid>.json; a dead pid means closed.
  let liveCache = { at: 0, ids: new Set() };
  async function liveIds() {
    if (Date.now() - liveCache.at < 2000) return liveCache.ids;
    const ids = new Set();
    for (const f of await readdir(liveDir).catch(() => [])) {
      if (!/^\d+\.json$/.test(f)) continue;
      try {
        const s = JSON.parse(await readFile(join(liveDir, f), 'utf8'));
        process.kill(Number(s.pid), 0);
        if (UUID.test(s.sessionId ?? '')) ids.add(s.sessionId);
      } catch {}
    }
    liveCache = { at: Date.now(), ids };
    return ids;
  }

  // A parent's subagents: one transcript each under <id>/subagents/, matched to the call that started it.
  async function children(id, file, calls) {
    const dir = join(file.slice(0, -'.jsonl'.length), 'subagents');
    const out = [];
    for (const f of (await readdir(dir).catch(() => [])).sort()) {
      const agent = /^agent-(a[0-9a-f]{6,24})\.jsonl$/.exec(f)?.[1];
      if (!agent) continue;
      const child = await load(join(dir, f));
      if (!child) continue;
      // Next to each transcript Claude Code keeps what it was asked and whether it finished.
      const meta = await readFile(join(dir, `agent-${agent}.meta.json`), 'utf8').then(JSON.parse).catch(() => null);
      const prompt = child.events.find((e) => e.kind === 'user')?.text ?? '';
      const call = calls.find((c) => c.prompt && c.prompt.trim() === prompt.trim()) ?? null;
      // Its own transcript says when it is done: a background agent answers the parent's call at once, long
      // before it finishes. One that stopped writing minutes ago without finishing is not running any more.
      const ended = typeof meta?.finished === 'boolean' ? meta.finished : child.info.lastKind === 'turn_completed' || child.info.handback !== null;
      const running = !ended && Date.now() - child.mtime < 5 * 60_000;
      const answer = child.info.handback || ([...child.events].reverse().find((e) => e.kind === 'assistant')?.text ?? null);
      out.push({ id: `${id}-${agent}`, file: join(dir, f), parsed: child, call,
        // No name: Claude Code's agent types are not persistent agents you can talk to again (fx's "Tell <name>:").
        row: { id: `${id}-${agent}`, kind: meta?.agentType ?? call?.type ?? 'task', name: null, phase: running ? 'running' : 'finished',
          task: meta?.description ?? call?.description ?? prompt.slice(0, 200), startedAt: call?.at ?? child.info.firstAt,
          outcome: ended ? 'completed' : running ? null : 'cancelled', failure: call?.done && !call.done.ok ? call.done.text : null,
          answer: ended && answer ? answer.slice(0, 8000) : null } });
    }
    return out;
  }

  const sessionRow = (id, entry, t, extra) => ({
    id,
    lastKind: t?.info.lastKind ?? null,
    partial: null,
    parentId: null,
    children: [],
    // Claude Code in a terminal names a session only when you ask (/rename); until then its first message does.
    title: t?.info.title ?? (t?.info.firstPrompt ? t.info.firstPrompt.replace(/\s+/g, ' ').slice(0, 80) : '(untitled)'),
    firstPrompt: (t?.info.firstPrompt ?? '').replace(/\s+/g, ' ').slice(0, 160),
    latestReply: t?.info.latestReply ?? null,
    workspace: entry.cwd ?? t?.info.cwd ?? '?',
    provider: 'claude',
    model: t?.info.model ?? entry.model ?? null,
    createdAt: entry.createdAt ?? t?.info.firstAt ?? null,
    updatedAt: Math.max(entry.createdAt ?? 0, t?.mtime ?? 0) || null,
    subagentChild: false,
    live: false,
    turns: t?.info.turns ?? 0,
    usage: t?.info.usage ?? { input: 0, output: 0, cacheRead: 0, cost: 0, wallMs: 0 },
    ...extra,
  });

  async function listSessions() {
    const all = await loadRegistry(), live = await liveIds(), out = [];
    for (const [id, entry] of Object.entries(all)) {
      if (!UUID.test(id)) continue;
      const file = await transcriptPath(id, entry.cwd);
      const t = file ? await load(file) : null;
      const row = sessionRow(id, entry, t, { live: live.has(id) });
      if (file && t) {
        for (const c of await children(id, file, t.info.subagentCalls)) {
          row.children.push(c.row);
          out.push(sessionRow(c.id, { cwd: row.workspace, createdAt: c.row.startedAt }, c.parsed, { parentId: id, subagentChild: true, title: c.row.task || '(subagent)' }));
        }
      }
      out.push(row);
    }
    return out;
  }

  async function fileOf(id) {
    const all = await loadRegistry();
    const child = CHILD.exec(id);
    const parentId = child ? child[1] : id;
    const entry = all[parentId];
    if (!entry) return null;
    const file = await transcriptPath(parentId, entry.cwd);
    if (!file || !child) return file;
    const sub = join(file.slice(0, -'.jsonl'.length), 'subagents', `agent-${child[2]}.jsonl`);
    return existsSync(sub) ? sub : null;
  }

  // `claude` itself, without the variables of a Claude Code session fox may run inside.
  const run = (args) => {
    const drop = new Set(inherited(env));
    const clean = Object.fromEntries(Object.entries(env).filter(([k]) => !drop.has(k)));
    return new Promise((done, fail) => execFile(bin, args, { timeout: 30_000, env: clean }, (err, stdout, stderr) => err ? fail(new Error(String(stderr || err.message).trim())) : done(stdout)));
  };

  // MCP servers for every session: Claude Code's user scope, kept in ~/.claude.json ("mcpServers"). It has no
  // off switch for them, so off removes the server and on adds it again.
  const mcp = {
    async servers() {
      try { return JSON.parse(await readFile(configFile, 'utf8')).mcpServers ?? {}; } catch { return {}; }
    },
    add: (tool) => run(['mcp', 'add', '--scope', 'user', ...(tool.url ? ['--transport', 'http', tool.name, tool.url] : [tool.name, '--', ...tool.command])]),
    remove: (name) => run(['mcp', 'remove', '--scope', 'user', name]),
  };

  // Signed in to a Claude account (or a key)? `claude auth status` answers in JSON; asked again every 30 s.
  let auth = { at: 0, ok: null };
  const signedIn = () => {
    if (Date.now() - auth.at < 30_000 && auth.ok !== null) return auth.ok;
    const drop = new Set(inherited(env));
    const clean = Object.fromEntries(Object.entries(env).filter(([k]) => !drop.has(k)));
    return new Promise((done) => execFile(bin, ['auth', 'status'], { timeout: 10_000, env: clean }, (err, stdout) => {
      let ok = false;
      try { ok = JSON.parse(stdout).loggedIn === true; } catch {}
      auth = { at: Date.now(), ok };
      done(ok);
    }));
  };

  return {
    id: 'claude',
    label: 'Claude Code',
    bin,
    models: CLAUDE_MODELS,
    available: () => existsSync(bin),
    signedIn,
    mcp,
    has(id) {
      if (!registry) return false;
      const child = CHILD.exec(id);
      return Object.hasOwn(registry, child ? child[1] : id);
    },
    loadRegistry,
    listSessions,
    async events(id) {
      const file = await fileOf(id);
      return file ? (await load(file))?.events ?? [] : [];
    },
    timing: async () => [],
    artifact: async () => null,
    // New: fox chooses the id. Resume: --resume needs a transcript, which only exists after the first message.
    async launch({ cwd, resume, model = null, addDirs = [] }) {
      if (resume) {
        const entry = (await loadRegistry())[resume];
        const file = entry ? await transcriptPath(resume, entry.cwd) : null;
        return { argv: cleanEnv(env, [bin, ...(file ? ['--resume', resume] : ['--session-id', resume])]), id: resume };
      }
      if (model && !CLAUDE_MODELS.some((m) => m.id === model)) throw new Error('Unknown model');
      const id = randomUUID();
      await remember(id, { cwd, createdAt: Date.now(), model });
      return { argv: cleanEnv(env, [bin, '--session-id', id, ...(model ? ['--model', model] : []), ...addDirs.flatMap((d) => ['--add-dir', d])]), id };
    },
    // Reading the screen: "esc to interrupt" shows while it works; a choice list ("Enter to confirm", "Do you want…")
    // waits for you; otherwise its "❯" prompt waits for a message.
    activity(screen) {
      const lines = screen.split('\n').filter((l) => l.trim()).slice(-14);
      if (lines.some((l) => /Enter to confirm|Do you want to |Would you like to /.test(l))) return 'needs_input';
      if (lines.some((l) => /esc to interrupt/i.test(l))) return 'working';
      return 'ready';
    },
    ready: (screen) => /^\s*│?\s*❯ /m.test(screen) && !/Enter to confirm/.test(screen),
    screenModel: (screen) => /^\s*\S+\s+(Opus|Sonnet|Haiku)\s+[\d.]+/m.exec(screen)?.[0].trim().split(/\s+/).slice(-2).join(' ') ?? null,
  };
}

export const claudeBin = () => process.env.CLAUDE_BIN ?? [join(homedir(), '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'].find(existsSync) ?? join(homedir(), '.local', 'bin', 'claude');
