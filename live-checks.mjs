// Opt-in workspace checks run only after a completed fx turn, in a configured repo.
// Never execute model text or use a shell for a custom command. Keep results in memory, not in fx's events.
import { readFile, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, relative, resolve, sep } from 'node:path';

const LIMIT = 32 * 1024;
const TIMEOUT = 15000;
const bad = (message) => Object.assign(new Error(message), { status: 400 });
export function commandArgs(text) {
  if (typeof text !== 'string' || text.length > 300 || !text.trim() || /[\x00-\x1f\x7f;&|<>`$\\]/.test(text)) throw bad('Use a plain command and arguments (no shell operators).');
  const args = [];
  const token = /\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/y;
  let pos = 0;
  while (pos < text.length) {
    token.lastIndex = pos;
    const match = token.exec(text);
    if (!match) { if (text.slice(pos).trim()) throw bad('Use a plain command and arguments.'); break; }
    args.push(match[1] ?? match[2] ?? match[3]);
    pos = token.lastIndex;
  }
  if (!args[0]) throw bad('Specify a command.');
  return args;
}
export async function declaredCommand(dir) {
  try {
    const p = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    const scripts = ['lint', 'typecheck'].filter((name) => typeof p.scripts?.[name] === 'string' && p.scripts[name].trim());
    return scripts.length ? scripts : typeof p.scripts?.check === 'string' && p.scripts.check.trim() ? ['check'] : [];
  } catch { return []; }
}
export function runCheck(bin, args, cwd, { timeout = TIMEOUT } = {}) {
  return new Promise((done) => {
    const child = spawn(bin, args, { cwd, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', npm_config_yes: 'false' } });
    let output = '', timedOut = false, clipped = false;
    const append = (chunk) => { const text = chunk.toString('utf8'); if (output.length + text.length > LIMIT) clipped = true; output += text.slice(0, Math.max(0, LIMIT - output.length)); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    const kill = () => { timedOut = true; if (child.pid && process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } else child.kill('SIGKILL'); };
    const timer = setTimeout(kill, timeout);
    child.once('error', (err) => { clearTimeout(timer); done({ status: 'error', output: err.message }); });
    child.once('close', (code) => { clearTimeout(timer); done({ status: timedOut ? 'timeout' : code === 0 ? 'passed' : 'failed', output: output.replace(/\x1b\[[0-9;]*m/g, '').trim() + (clipped ? '\n… output truncated' : '') }); });
  });
}
export function createLiveChecks({ workspaces, filesFor, eventsFor, run = runCheck }) {
  const results = new Map();
  const pending = new Map();
  async function inspect(session) {
    if (!session || session.harness !== 'fx' || session.parentId) return null;
    const ws = await workspaces.forPath(session.workspace);
    if (!ws?.liveCheck?.enabled) return null;
    const events = await eventsFor(session.id);
    const end = events.findLastIndex((e) => e.kind === 'turn_completed');
    if (end < 0 || (ws.liveCheck.enabledAt && events[end].ts < ws.liveCheck.enabledAt) || events.slice(end + 1).some((e) => e.kind === 'user' || e.kind === 'tool_call')) return null;
    const start = events.slice(0, end).findLastIndex((e) => e.kind === 'turn_completed');
    const key = `${ws.id}:${end}:${events[end]?.ts}:${ws.liveCheck.command ?? ''}`;
    const old = results.get(session.id);
    if (old?.key === key) return old.result;
    const writes = (stream) => stream.filter((e) => e.kind === 'tool_call' && e.path && ['write', 'edit'].includes(e.effect) && !/error|fail/i.test(e.result?.status ?? ''));
    const changed = new Set(writes(events.slice(start + 1, end)).map((e) => resolve(session.workspace, e.path)));
    // A subagent's file mtime can change after this turn; use its recorded writes instead.
    const from = events[start + 1]?.ts, to = events[end]?.ts;
    if (Number.isFinite(from) && Number.isFinite(to)) {
      for (const child of session.children ?? []) {
        const stream = await eventsFor(child.id);
        for (const e of writes(stream).filter((e) => e.ts >= from && e.ts <= to)) {
          const path = resolve(child.workspace ?? session.workspace, e.path);
          changed.add(await realpath(path).catch(() => path));
        }
      }
    }
    // Never follow a repo symlink or run from an unconfigured checkout.
    const root = await realpath(ws.dir).catch(() => null);
    const files = (await filesFor(session.id)).filter((f) => f.exists && ['write', 'edit'].includes(f.action) && changed.has(f.path));
    if (!files.length) return null;
    const groups = [];
    for (const repo of ws.repos) {
      const dir = join(ws.dir, repo.dir);
      if (!root || !repo.dir || repo.dir.includes('/') || await realpath(dir).catch(() => null) !== join(root, repo.dir) ||
          (workspaces.originMatches && !(await workspaces.originMatches(ws, repo)))) continue;
      const selected = [];
      for (const f of files) {
        if (!f.path.startsWith(dir + sep) || await realpath(f.path).catch(() => null) !== f.path) continue;
        selected.push({ path: f.path, rel: relative(dir, f.path) });
      }
      if (selected.length) groups.push({ dir, selected });
    }
    if (!groups.length) return null;
    const task = (async () => {
      const problems = [], general = [];
      for (const { dir, selected } of groups) {
        const commands = ws.liveCheck.command ? [commandArgs(ws.liveCheck.command)] : (await declaredCommand(dir)).map((script) => ['npm', 'run', script]);
        for (const [bin, ...args] of commands) {
          // Package scripts can run whole-project checks; not all lint commands accept file arguments.
          const outcome = await run(bin, args, dir);
          if (outcome.status === 'passed') continue;
          const lines = outcome.output.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 80);
          let matched = false;
          for (const f of selected) {
            const hits = lines.flatMap((line, i) => line.includes(f.rel) ? [line, ...lines.slice(i + 1, i + 3).filter((next) => /^\d+:\d+\s|^\d+\s|^error\s/i.test(next))] : []).slice(0, 3);
            if (hits.length) {
              const problem = problems.find((p) => p.path === f.path);
              if (problem) problem.lines.push(...hits);
              else problems.push({ path: f.path, lines: hits });
              matched = true;
            }
          }
          if (!matched) general.push(`${relative(ws.dir, dir)}: ${outcome.status === 'timeout' ? 'check timed out' : lines.slice(0, 3).join('\n') || 'check failed'}`);
        }
      }
      return { problems, general, count: problems.length + general.length };
    })();
    const result = await task;
    results.set(session.id, { key, result });
    return result;
  }
  return { status(session) {
    if (!session?.id) return Promise.resolve(null);
    if (pending.has(session.id)) return pending.get(session.id);
    const task = inspect(session).finally(() => pending.delete(session.id));
    pending.set(session.id, task);
    return task;
  } };
}
