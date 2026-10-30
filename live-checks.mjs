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
    const script = ['lint', 'typecheck', 'check'].find((name) => typeof p.scripts?.[name] === 'string' && p.scripts[name].trim());
    return script ?? null;
  } catch { return null; }
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
    if (end < 0 || events.slice(end + 1).some((e) => e.kind === 'user' || e.kind === 'tool_call')) return null;
    const start = events.slice(0, end).findLastIndex((e) => e.kind === 'turn_completed');
    const changed = new Set(events.slice(start + 1, end).filter((e) => e.kind === 'tool_call' && ['write', 'edit'].includes(e.effect) && !/error|fail/i.test(e.result?.status ?? '')).map((e) => resolve(session.workspace, e.path ?? '')));
    const key = `${ws.id}:${end}:${ws.liveCheck.command ?? ''}`;
    const old = results.get(session.id);
    if (old?.key === key) return old.result;
    // Subagents have their own event streams; their file mtimes place their writes inside the parent's turn.
    const from = events[start + 1]?.ts, to = events[end]?.ts;
    // Never follow a repo symlink or run from an unconfigured checkout.
    const root = await realpath(ws.dir).catch(() => null);
    const files = (await filesFor(session.id)).filter((f) => f.exists && ['write', 'edit'].includes(f.action) &&
      (changed.has(f.path) || (f.by?.some((n) => n > 0) && Number.isFinite(from) && Number.isFinite(to) && f.mtime >= from && f.mtime <= to + 2000)));
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
        const script = ws.liveCheck.command ? null : await declaredCommand(dir);
        if (!script && !ws.liveCheck.command) continue;
        const [bin, args] = script ? ['npm', ['run', script, ...(script === 'lint' ? ['--', ...selected.map((f) => f.rel)] : [])]] : [commandArgs(ws.liveCheck.command)[0], commandArgs(ws.liveCheck.command).slice(1)];
        const outcome = await run(bin, args, dir);
        if (outcome.status === 'passed') continue;
        const lines = outcome.output.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 80);
        let matched = false;
        for (const f of selected) {
          const hits = lines.filter((line) => line.includes(f.rel) || (selected.filter((x) => x.rel.endsWith('/' + f.rel.split('/').pop()) || x.rel === f.rel).length === 1 && line.includes(f.rel.split('/').pop()))).slice(0, 3);
          if (hits.length) { problems.push({ path: f.path, lines: hits }); matched = true; }
        }
        if (!matched) general.push(`${relative(ws.dir, dir)}: ${outcome.status === 'timeout' ? 'check timed out' : lines.slice(0, 3).join('\n') || 'check failed'}`);
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
