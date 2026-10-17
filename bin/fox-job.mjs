#!/usr/bin/env node
// fox-job: manage fox's jobs from a terminal (fx uses it too). Same store and validation as the panel, so a job
// made here shows up in fox's sidebar at once. See jobs.mjs and schedule.mjs.
import { join, resolve, relative, isAbsolute } from 'node:path';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createJobStore } from '../jobs.mjs';
import { describeSchedule } from '../schedule.mjs';

const stateDir = process.env.FOX_STATE_DIR || join(homedir(), '.config', 'fox');
const store = createJobStore({ stateDir });
// Your time zone: FOX_DEFAULT_TZ, else the one fox's server config sets (an SSH shell does not carry fox's
// environment), else this machine's.
export function defaultTz(env = process.env, readEnvFile = () => readFileSync('/etc/fox/fox.env', 'utf8')) {
  if (env.FOX_DEFAULT_TZ) return env.FOX_DEFAULT_TZ;
  try { const m = readEnvFile().match(/^FOX_DEFAULT_TZ=(.+)$/m); if (m) return m[1].trim(); } catch {}
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
const DAYS = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };
const USAGE = `fox-job: scripts on a schedule, shown in fox

  fox-job list
  fox-job add <name> --script <path> [--cwd <dir>]
              (--every <hours> --from HH:MM --to HH:MM | --daily HH:MM | --once YYYY-MM-DD HH:MM)
              [--days mon-fri|sat,sun|mon,thu|all] [--tz Area/City] [--timeout <minutes>] [--paused]
              [-- <script arguments>]
  fox-job run <name>         run now
  fox-job pause <name> | resume <name> | remove <name>
  fox-job runs <name>        recent runs and their summaries
  fox-job log <name> [<run>] output of the last (or a given) run`;

export function parseDays(text = 'all') {
  const t = String(text).toLowerCase().trim();
  if (t === 'all' || t === 'daily' || t === 'every') return [1, 2, 3, 4, 5, 6, 7];
  if (t === 'weekdays') return [1, 2, 3, 4, 5];
  if (t === 'weekends') return [6, 7];
  const out = new Set();
  for (const part of t.split(',')) {
    const [a, b] = part.split('-').map((x) => DAYS[x.trim().slice(0, 3)]);
    if (!a || (part.includes('-') && !b)) throw new Error(`Unknown days: ${text}`);
    if (b) for (let d = a; ; d = d % 7 + 1) { out.add(d); if (d === b) break; } else out.add(a);
  }
  return [...out].sort();
}

export function parseAdd(argv, { cwd = process.cwd(), tz = defaultTz() } = {}) {
  const [name, ...rest] = argv;
  const dash = rest.indexOf('--');
  const opts = dash >= 0 ? rest.slice(0, dash) : rest;
  const args = dash >= 0 ? rest.slice(dash + 1) : [];
  const get = (flag, n = 1) => { const i = opts.indexOf(flag); return i < 0 ? null : opts.slice(i + 1, i + 1 + n); };
  const one = (flag) => get(flag)?.[0] ?? null;
  const days = parseDays(one('--days') ?? 'all');
  let schedule;
  if (opts.includes('--every')) schedule = { kind: 'hours', every: Number(one('--every')), from: one('--from') ?? '00:00', to: one('--to') ?? '23:59', days };
  else if (opts.includes('--daily')) schedule = { kind: 'daily', at: one('--daily'), days };
  else if (opts.includes('--once')) { const [date, at] = get('--once', 2) ?? []; schedule = { kind: 'once', date, at }; }
  else throw new Error('Say when: --every <hours> --from HH:MM --to HH:MM, --daily HH:MM, or --once YYYY-MM-DD HH:MM');
  if (schedule.kind === 'hours' && schedule.to === '23:59') schedule.to = '23:00';
  const dir = resolve(cwd, one('--cwd') ?? '.');
  // The script may be given relative to the folder or as a full path inside it.
  let script = one('--script');
  if (script && isAbsolute(script)) { const rel = relative(dir, script); if (rel && !rel.startsWith('..') && !isAbsolute(rel)) script = rel; }
  return {
    name, script, cwd: dir, args, schedule,
    tz: one('--tz') ?? tz, timeoutMin: one('--timeout') ? Number(one('--timeout')) : undefined, enabled: !opts.includes('--paused'),
  };
}

// Times in the job's own zone, the one its schedule is written in.
const when = (ms, tz) => ms ? new Date(ms).toLocaleString('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-';
async function byName(name) {
  const job = (await store.list()).find((j) => j.name === name);
  if (!job) throw new Error(`No job named ${name}. fox-job list shows them.`);
  return job;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return console.log(USAGE);
  if (cmd === 'list') {
    const jobs = await store.overview();
    if (!jobs.length) return console.log('No jobs yet.');
    for (const j of jobs) console.log(`${j.name}\t${j.enabled ? describeSchedule(j.schedule) : 'paused'}\tnext ${j.enabled ? when(j.nextRun, j.tz) : '-'}\tlast ${j.lastRun ? `${j.lastRun.status}${j.lastRun.summary ? ': ' + j.lastRun.summary : ''}` : 'never'}\t${j.cwd}/${j.script}`);
    return;
  }
  if (cmd === 'add') {
    const def = parseAdd(rest);
    if (def.timeoutMin === undefined) delete def.timeoutMin;
    const job = await store.create(def);
    const [o] = (await store.overview()).filter((j) => j.id === job.id);
    return console.log(`Created ${job.name}: ${describeSchedule(job.schedule)} (${job.tz})${job.enabled ? `, next ${when(o?.nextRun, job.tz)}` : ', paused'}.`);
  }
  const job = await byName(rest[0]);
  if (cmd === 'run') { await store.trigger(job.id); return console.log(`${job.name} will start within a few seconds (after any job already running).`); }
  if (cmd === 'pause' || cmd === 'resume') { await store.update(job.id, { enabled: cmd === 'resume' }); return console.log(`${job.name} ${cmd === 'pause' ? 'paused' : 'resumed'}.`); }
  if (cmd === 'remove') { await store.remove(job.id); return console.log(`Removed ${job.name} and its run history; the script stays.`); }
  if (cmd === 'runs') {
    const runs = await store.runs(job.id, 20);
    if (!runs.length) return console.log('No runs yet.');
    for (const r of runs) console.log(`${r.id}\t${when(r.startedAt, job.tz)}\t${r.status}\t${r.summary ?? ''}`);
    return;
  }
  if (cmd === 'log') {
    const runId = rest[1] ?? (await store.runs(job.id, 1))[0]?.id;
    if (!runId) return console.log('No runs yet.');
    return process.stdout.write(await store.readLog(job.id, runId));
  }
  throw new Error(`Unknown command ${cmd}.\n\n${USAGE}`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('fox-job')) {
  main(process.argv.slice(2)).catch((err) => { console.error(err.message); process.exitCode = 1; });
}
