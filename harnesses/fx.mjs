// fx as a harness: everything fox knows about fx's files on disk (~/.fx/sessions) and its screen lives here.
// The rest of fox sees sessions and events in fox's own shape (see docs/harnesses.md); nothing outside this
// file reads session.json, events.jsonl or children.json.
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { latestCompletedReply, lastAnswerModel, screenModel } from '../inbox.mjs';
import { parseTimeline } from '../timeline.mjs';

const readJson = async (path) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };
const safeId = (id) => /^[A-Za-z0-9_-]{4,64}$/.test(id ?? '');
// What a tool did to a file, so the files panel works the same for every harness.
const EFFECTS = { write_file: 'write', edit_file: 'edit', read_file: 'read', shell: 'shell', bash: 'shell' };

export function createFx({ sessionsDir, bin }) {
  async function listSessions() {
    if (!existsSync(sessionsDir)) return [];
    const sessions = [];
    for (const id of await readdir(sessionsDir)) {
      if (!safeId(id)) continue; // a folder named like markup is not a session (ids end up in the page)
      const dir = join(sessionsDir, id);
      const meta = await readJson(join(dir, 'session.json'));
      if (!meta) continue;
      const snap = (await readJson(join(dir, 'usage-v2.json')))?.snapshot ?? {};
      let turns = 0, firstPrompt = '', latestReply = null, lastKind = null, partial = null, answeredBy = null;
      try {
        const raw = await readFile(join(dir, 'events.jsonl'), 'utf8');
        latestReply = latestCompletedReply(raw);
        for (const l of raw.split('\n')) {
          if (!l.includes('"user"')) continue;
          turns += 1;
          if (!firstPrompt) { try { firstPrompt = JSON.parse(l).event?.user?.text ?? ''; } catch {} }
        }
        const lines = raw.trim().split('\n');
        for (let i = lines.length - 1; i >= 0 && !lastKind; i--) {
          try {
            const ev = JSON.parse(lines[i]).event;
            lastKind = Object.keys(ev)[0];
            // A cancelled turn keeps what the model had started to write (a subagent's unfinished answer).
            if (lastKind === 'interrupted') partial = ev.interrupted?.partial_text || null;
          } catch {}
        }
        answeredBy = lastAnswerModel(lines);
      } catch {}
      // Subagents: the parent lists its children in subagent/children.json; a child names its parent in owner.json.
      const owner = await readJson(join(dir, 'subagent', 'owner.json'));
      const children = ((await readJson(join(dir, 'subagent', 'children.json')))?.children ?? []).filter((c) => safeId(c?.id)).map((c) => ({
        id: c.id,
        kind: c.kind,
        name: c.persistent?.agent ?? null,
        phase: c.phase, // running | idle | finished
        task: c.active?.message ?? null,
        startedAt: c.active?.created_at_ms ?? null,
        outcome: c.last_outcome ?? null,
        failure: c.last_failure ?? null,
      }));
      sessions.push({
        id,
        lastKind,
        partial,
        parentId: owner?.parent_id ?? null,
        children,
        title: meta.title ?? '(untitled)',
        firstPrompt: firstPrompt.replace(/\s+/g, ' ').slice(0, 160),
        latestReply,
        workspace: meta.workspace_root ?? meta.origin_workspace_root ?? '?',
        provider: meta.provider,
        // session.json keeps fx's default; the model that answered is in each reply (picked at start or with /model).
        model: answeredBy ?? meta.model,
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
    return sessions;
  }

  // fx leaves owner.live with the pid of the process that holds the session; a dead pid is an orphaned lock.
  async function ownerAlive(dir) {
    const owner = await readJson(join(dir, 'owner.live'));
    if (!owner?.pid) return false;
    try { process.kill(owner.pid, 0); return true; } catch { return false; }
  }

  async function events(id) {
    let raw;
    try { raw = await readFile(join(sessionsDir, id, 'events.jsonl'), 'utf8'); } catch { return []; }
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
        case 'assistant':
          out.push({ kind, ts, text: body.text ?? '' });
          break;
        case 'tool_call': {
          let args = body.arguments_json;
          try { args = JSON.parse(args); } catch {}
          const effect = EFFECTS[body.tool_name] ?? 'other';
          const item = { kind, ts, callId: body.call_id, name: body.tool_name, args, result: null, effect, path: ['write', 'edit', 'read'].includes(effect) ? args?.path ?? null : null };
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

  // Cache parsed completed snapshots by file signature; running turns are inferred from live
  // overview state and children.json, never from an assumed tail of events.jsonl.
  const timelineCache = new Map();
  async function timing(id) {
    const file = join(sessionsDir, id, 'events.jsonl');
    const info = await stat(file).catch(() => null);
    if (!info) return [];
    const key = `${info.mtimeMs}:${info.size}`;
    const hit = timelineCache.get(id);
    if (hit?.key === key) return hit.events;
    const parsed = parseTimeline(await readFile(file, 'utf8'));
    if (timelineCache.size > 100) timelineCache.delete(timelineCache.keys().next().value);
    timelineCache.set(id, { key, events: parsed });
    return parsed;
  }

  return {
    id: 'fx',
    label: 'fx',
    bin,
    sessionsDir,
    available: () => existsSync(bin),
    has: (id) => safeId(id) && existsSync(join(sessionsDir, id, 'session.json')),
    listSessions,
    events,
    timing,
    async artifact(id, name) {
      if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
      try { return await readFile(join(sessionsDir, id, 'tool-results', name), 'utf8'); } catch { return null; }
    },
    // fx's id appears only after it starts, so a new terminal is matched to its session later (see listTerminals).
    launch: ({ resume, flags = [] }) => ({ argv: [bin, ...(resume ? ['session', 'resume', resume] : flags)], id: resume ?? null }),
    // Reading the screen: fx shows "• Thinking (4s)" or similar while it works, and goes back to its "┃" prompt.
    // The "•" blinks (half the captures have none) and past a minute the time reads "(1m0s)": neither may decide.
    activity(screen) {
      const lines = screen.split('\n').filter((l) => l.trim()).slice(-8);
      if (lines.some((l) => /\[y\/n\]|\(y\/n\)|allow|approve|permission|confirm/i.test(l) && /\?/.test(l))) return 'needs_input';
      if (lines.some((l) => /^\s*(?:[•●◐◓◑◒◴◵◶◷⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+)?[A-Z][a-z]+(?: [a-z]+)*\s+\((?:\d+h)?(?:\d+m)?\d+s\)/.test(l) || /^\s*•\s+(Thinking|Working|Running)/i.test(l))) return 'working';
      return 'ready';
    },
    ready: (screen) => /^\s*┃\s*$/m.test(screen),
    screenModel,
  };
}
