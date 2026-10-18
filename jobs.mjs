// Jobs: a script on a schedule. fox stores and shows them; a runner (its own service on a server, so a fox
// deploy never kills a job mid-run) starts them on time, one at a time, and records every run.
//
//   <stateDir>/jobs.json                  definitions
//   <stateDir>/jobs/<id>/runs/<run>/      run.json, output.log, out/ (FOX_JOB_OUTPUT: files the script makes)
//   <stateDir>/jobs/triggers/<id>         "Run now" requests, written by fox, taken by the runner
//
// A script prints "FOX_SUMMARY: <one line>" to say what the run did; the last such line is its summary.
// "FOX_LINK: <label> <https://…>" adds a link to the run (a pull request, a report); up to 5, http(s) only.
// Times missed while the runner was down are skipped, not caught up in a burst.
// A job added from a terminal (fox-job, which is how fx adds one) starts paused and waits for the user's OK on
// fox's page (`pendingApproval`): until then nothing runs it, and the terminal cannot resume or run it.
import { readFile, writeFile, mkdir, rename, readdir, rm, stat, lstat, open } from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import { fastForward } from './gitsync.mjs';
import { fileURLToPath } from 'node:url';
// Helpers jobs share (lib/python/foxjob.py): on every job's PYTHONPATH, so a script only needs `import foxjob`.
export const FOXJOB_LIB = fileURLToPath(new URL('./lib/python', import.meta.url));
import { join, resolve, sep, extname, isAbsolute, basename } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { nextRuns, scheduleError, describeSchedule } from './schedule.mjs';

export const JOB_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const KEEP_RUNS = 50;
const LOG_LIMIT = 5 * 1024 * 1024;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const APPROVE_FIRST = 'This job waits for the user to approve it on fox\'s Jobs page.';

export function createJobStore({ stateDir }) {
  const file = join(stateDir, 'jobs.json');
  const root = join(stateDir, 'jobs');
  const runsDir = (id) => join(root, id, 'runs');
  const triggers = join(root, 'triggers');

  // fox (the page) and fox-job (a terminal) both edit jobs.json: one writer at a time, or one's change is lost.
  // The lock is a folder (mkdir is atomic); one left by a process that died is taken over after 10 s.
  const lockDir = `${file}.lock`;
  async function locked(fn) {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    for (let i = 0; ; i++) {
      try { await mkdir(lockDir); break; } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        const age = Date.now() - ((await stat(lockDir).catch(() => null))?.mtimeMs ?? Date.now());
        if (age > 10_000 || i > 200) { await rm(lockDir, { recursive: true, force: true }); continue; }
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    try { return await fn(); } finally { await rm(lockDir, { recursive: true, force: true }); }
  }
  async function load() { try { const d = JSON.parse(await readFile(file, 'utf8')); return Array.isArray(d) ? d : []; } catch { return []; } }
  async function save(list) {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
    await rename(tmp, file);
  }
  // The script must be a file inside the job's folder: a relative path without "..".
  async function checkTarget(cwd, script) {
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw fail('Pick the folder the job runs in.');
    if (!(await stat(cwd).catch(() => null))?.isDirectory()) throw fail('That folder does not exist.');
    if (typeof script !== 'string' || !script || isAbsolute(script) || script.split(/[\\/]/).includes('..')) throw fail('The script is a path inside the folder, like jobs/report.py.');
    const full = resolve(cwd, script);
    if (!(full === cwd || full.startsWith(resolve(cwd) + sep))) throw fail('The script must be inside the folder.');
    if (!(await stat(full).catch(() => null))?.isFile()) throw fail(`${script} does not exist in that folder.`);
  }
  function clean(def, current = {}) {
    const job = { ...current };
    if (def.name !== undefined) {
      const name = String(def.name).trim();
      if (!JOB_NAME.test(name)) throw fail('Name it with lowercase letters, numbers, dots, dashes or underscores.');
      job.name = name;
    }
    for (const k of ['cwd', 'script']) if (def[k] !== undefined) job[k] = String(def[k]).trim();
    if (def.args !== undefined) {
      if (!Array.isArray(def.args) || !def.args.every((a) => typeof a === 'string' && a.length < 500) || def.args.length > 20) throw fail('Arguments are a list of words.');
      job.args = def.args;
    }
    if (def.schedule !== undefined) job.schedule = def.schedule;
    if (def.tz !== undefined) job.tz = String(def.tz);
    if (def.enabled !== undefined) job.enabled = Boolean(def.enabled);
    // fx's model and effort for this job's fx calls (FOX_JOB_MODEL, FOX_JOB_EFFORT); empty leaves it to the script.
    if (def.model !== undefined) {
      const m = String(def.model ?? '').trim();
      if (m && !/^[\w.:/-]{1,100}$/.test(m)) throw fail('That is not a model id.');
      if (m) job.model = m; else delete job.model;
    }
    if (def.effort !== undefined) {
      const e = String(def.effort ?? '').trim();
      if (e && !EFFORTS.includes(e)) throw fail(`Effort is one of ${EFFORTS.join(', ')}.`);
      if (e) job.effort = e; else delete job.effort;
    }
    if (def.timeoutMin !== undefined) {
      const t = Number(def.timeoutMin);
      if (!Number.isInteger(t) || t < 1 || t > 240) throw fail('Time limit between 1 and 240 minutes.');
      job.timeoutMin = t;
    }
    const err = scheduleError(job.schedule, job.tz);
    if (err) throw fail(err);
    return job;
  }

  const store = {
    root, triggers, runsDir,
    load,
    async list() { return load(); },
    async get(id) { return (await load()).find((j) => j.id === id) ?? null; },
    create: (def, { from = 'page' } = {}) => locked(async () => {
      const all = await load();
      const job = clean({ args: [], enabled: true, timeoutMin: 30, ...def });
      if (from === 'terminal') Object.assign(job, { enabled: false, pendingApproval: true });
      if (!job.name) throw fail('Name the job.');
      if (all.some((j) => j.name === job.name)) throw fail(`A job named ${job.name} already exists.`, 409);
      await checkTarget(job.cwd, job.script);
      Object.assign(job, { id: randomUUID(), createdAt: Date.now() });
      all.push(job); await save(all);
      return job;
    }),
    update: (id, def, { from = 'page' } = {}) => locked(async () => {
      const all = await load();
      const i = all.findIndex((j) => j.id === id);
      if (i < 0) throw fail('Job not found.', 404);
      if (all[i].pendingApproval && from === 'terminal' && def.enabled) throw fail(APPROVE_FIRST, 403);
      const job = clean(def, all[i]);
      if (from === 'page' && job.enabled) delete job.pendingApproval; // turning it on in fox is the OK
      if (all.some((j) => j.id !== id && j.name === job.name)) throw fail(`A job named ${job.name} already exists.`, 409);
      if (def.cwd !== undefined || def.script !== undefined) await checkTarget(job.cwd, job.script);
      all[i] = { ...job, updatedAt: Date.now() };
      await save(all);
      return all[i];
    }),
    async remove(id) {
      await locked(async () => {
        const all = await load();
        if (!all.some((j) => j.id === id)) throw fail('Job not found.', 404);
        await save(all.filter((j) => j.id !== id));
      });
      await rm(join(root, id), { recursive: true, force: true });
      await rm(join(triggers, id), { force: true });
    },
    async trigger(id, { from = 'page' } = {}) {
      const job = await store.get(id);
      if (!job) throw fail('Job not found.', 404);
      if (job.pendingApproval && from === 'terminal') throw fail(APPROVE_FIRST, 403);
      await mkdir(triggers, { recursive: true, mode: 0o700 });
      await writeFile(join(triggers, id), String(Date.now()));
    },
    async takeTriggers() {
      const ids = [];
      for (const f of await readdir(triggers).catch(() => [])) {
        if (!/^[0-9a-f-]{36}$/.test(f)) continue;
        await rm(join(triggers, f), { force: true });
        ids.push(f);
      }
      return ids;
    },
    async runs(id, limit = KEEP_RUNS) {
      const dir = runsDir(id), out = [];
      for (const r of (await readdir(dir).catch(() => [])).sort().reverse().slice(0, limit)) {
        try { out.push(JSON.parse(await readFile(join(dir, r, 'run.json'), 'utf8'))); } catch {}
      }
      return out;
    },
    async readLog(id, runId, maxBytes = 200 * 1024) {
      if (!/^[0-9A-Za-z_-]+$/.test(runId)) throw fail('Bad run.');
      const path = join(runsDir(id), runId, 'output.log');
      const size = (await stat(path).catch(() => null))?.size ?? 0;
      if (!size) return '';
      const fh = await open(path, 'r');
      try {
        const start = Math.max(0, size - maxBytes);
        const buf = Buffer.alloc(size - start);
        await fh.read(buf, 0, buf.length, start);
        return (start ? '…\n' : '') + buf.toString('utf8');
      } finally { await fh.close(); }
    },
    // A file the run left in its output folder (only names listed in run.json).
    async outputPath(id, runId, name) {
      if (!/^[0-9A-Za-z_-]+$/.test(runId)) return null;
      const run = (await store.runs(id)).find((r) => r.id === runId);
      if (!run?.outputs?.some((o) => o.name === name)) return null;
      const path = join(runsDir(id), runId, 'out', basename(name));
      return (await lstat(path).catch(() => null))?.isFile() ? path : null; // never through a symlink
    },
    // Definitions with their next run, last run and plain-words schedule, for the page.
    async overview(now = Date.now()) {
      const all = await load();
      return Promise.all(all.map(async (j) => {
        const [last] = await store.runs(j.id, 1);
        return { ...j, scheduleText: describeSchedule(j.schedule), nextRun: j.enabled ? nextRuns(j.schedule, j.tz, now, 1)[0] ?? null : null, lastRun: last ?? null };
      }));
    },
  };
  return store;
}

// How a script is started: by its extension, or directly if it is executable.
const EFFORTS = ['low', 'medium', 'high'];

export function commandFor(script, args = []) {
  const ext = extname(script).toLowerCase();
  if (ext === '.py') return ['python3', ['-u', script, ...args]];
  if (ext === '.mjs' || ext === '.js' || ext === '.cjs') return [process.execPath, [script, ...args]];
  if (ext === '.sh') return ['bash', [script, ...args]];
  // A bare name ("deploy") would be looked up on PATH; run the file in the job's folder instead.
  return [script.includes('/') ? script : `./${script}`, args];
}

// Before each run, the job's folder is brought up to date when it is a clean checkout (see gitsync.mjs).
export async function updateJobRepo(job) {
  const r = await fastForward(job.cwd);
  if (r.status === 'updated') return `updated ${job.cwd} ${r.from}..${r.to}`;
  if (r.status === 'skipped' && r.reason !== 'not a git repo') return `${job.cwd} not updated: ${r.reason}`;
  return null;
}

export function createRunner({ store, now = () => Date.now(), spawn = nodeSpawn, tickMs = 15_000, minuteMs = 60_000, log = console.log, restartFile = null, onRestart = () => {}, beforeRun = null }) {
  let running = null, current = null, timer = null, stopped = false; // running: the promise; current: what runs
  const queue = [];                 // [{ id, reason }]
  const next = new Map();            // id -> { at, sig }
  const sig = (j) => JSON.stringify([j.schedule, j.tz, j.enabled]);

  async function plan(jobs) {
    const t = now();
    for (const j of jobs) {
      const known = next.get(j.id);
      if (!known || known.sig !== sig(j)) next.set(j.id, { at: j.enabled ? nextRuns(j.schedule, j.tz, t, 1)[0] ?? null : null, sig: sig(j) });
    }
    for (const id of next.keys()) if (!jobs.some((j) => j.id === id)) next.delete(id);
  }

  async function tick() {
    if (stopped) return;
    // A new version was deployed: restart now if idle, otherwise after the run in progress (see afterRun).
    if (!running && restartFile && existsSync(restartFile)) { await rm(restartFile, { force: true }); log('fox-jobs: restarting for a new version'); stopped = true; return onRestart(); }
    const jobs = (await store.load()).filter((j) => !j.pendingApproval);
    await plan(jobs);
    for (const id of await store.takeTriggers()) if (!queue.some((q) => q.id === id)) queue.push({ id, reason: 'manual' });
    const t = now();
    for (const j of jobs) {
      const n = next.get(j.id);
      if (n?.at && t >= n.at) {
        // Due: queue it once and plan the next time from now, so a long outage never fires a burst.
        if (!queue.some((q) => q.id === j.id) && current?.job.id !== j.id) queue.push({ id: j.id, reason: 'schedule', scheduledAt: n.at });
        next.set(j.id, { at: nextRuns(j.schedule, j.tz, t, 1)[0] ?? null, sig: sig(j) });
      }
    }
    if (!running && queue.length) {
      const item = queue.shift();
      const job = jobs.find((j) => j.id === item.id);
      if (job) running = runJob(job, item).finally(() => { running = null; current = null; afterRun(); });
    }
  }

  async function afterRun() {
    if (restartFile && existsSync(restartFile)) { await rm(restartFile, { force: true }); log('fox-jobs: restarting for a new version'); return onRestart(); }
    tick().catch((err) => log(`fox-jobs: ${err.message}`));
  }

  async function runJob(job, item) {
    const id = new Date(now()).toISOString().replace(/[-:.]/g, '').replace('T', '-').slice(0, 15) + '-' + randomBytes(3).toString('hex');
    const dir = join(store.runsDir(job.id), id);
    const outDir = join(dir, 'out');
    await mkdir(outDir, { recursive: true, mode: 0o700 });
    const run = { id, jobId: job.id, reason: item.reason, scheduledAt: item.scheduledAt ?? null, startedAt: now(), status: 'running', summary: null };
    const write = () => writeFile(join(dir, 'run.json'), JSON.stringify(run, null, 2), { mode: 0o600 });
    await write();
    current = { job, run };
    const logStream = createWriteStream(join(dir, 'output.log'), { mode: 0o600 });
    let written = 0, truncated = false, carry = '';
    run.links = [];
    const readLine = (line) => {
      const m = line.match(/^FOX_SUMMARY:\s*(.*)$/); if (m) run.summary = m[1].slice(0, 300);
      const l = line.match(/^FOX_LINK:\s*(?:(.*?)\s+)?(https?:\/\/\S+)\s*$/);
      // Any output can look like this line (a test printing it), so a bad URL is skipped, never thrown.
      if (l && run.links.length < 5 && URL.canParse(l[2])) run.links.push({ label: (l[1] || new URL(l[2]).hostname).slice(0, 60), url: l[2].slice(0, 500) });
    };
    let ended = false;
    const take = (chunk) => {
      if (ended) return;
      const text = chunk.toString('utf8');
      for (const line of (carry + text).split('\n').slice(0, -1)) readLine(line);
      carry = (carry + text).split('\n').pop().slice(-2000);
      if (written >= LOG_LIMIT) { if (!truncated) { truncated = true; logStream.write('\n[fox] output limit reached; the rest is not saved\n'); } return; }
      written += chunk.length; logStream.write(chunk);
    };
    log(`fox-jobs: ${job.name} started (${item.reason}), run ${id}`);
    // For example, bring the job's repo up to date (see gitsync.mjs); what it says goes at the top of the log.
    if (beforeRun) await Promise.resolve(beforeRun(job)).then((note) => { if (note) logStream.write(`[fox] ${note}\n`); }, () => {});
    const [cmd, args] = commandFor(job.script, job.args ?? []);
    const result = await new Promise((done) => {
      let child;
      try {
        child = spawn(cmd, args, { cwd: job.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, FOX_JOB_ID: job.id, FOX_JOB_NAME: job.name, FOX_JOB_RUN_ID: id, FOX_JOB_OUTPUT: outDir, PYTHONUNBUFFERED: '1',
            ...(job.model ? { FOX_JOB_MODEL: job.model } : {}), ...(job.effort ? { FOX_JOB_EFFORT: job.effort } : {}),
            PYTHONPATH: [FOXJOB_LIB, process.env.PYTHONPATH].filter(Boolean).join(':') } });
      } catch (err) { return done({ status: 'failed', error: err.message }); }
      run.pid = child.pid; write();
      child.stdout.on('data', take); child.stderr.on('data', take);
      let timedOut = false, watchdog = null;
      const limit = setTimeout(() => {
        timedOut = true;
        try { process.kill(-child.pid, 'SIGTERM'); } catch {}
        setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 10_000).unref?.();
        // Something that left the process group can keep the output open, and the run would never end:
        // a little after the kill the run is over anyway, so the next job is not held up.
        watchdog = setTimeout(() => done({ status: 'timeout', exitCode: null, signal: 'SIGKILL' }), 15_000);
        watchdog.unref?.();
      }, (job.timeoutMin ?? 30) * minuteMs);
      child.once('error', (err) => { clearTimeout(limit); clearTimeout(watchdog); done({ status: 'failed', error: err.message }); });
      child.once('close', (code, signal) => {
        clearTimeout(limit); clearTimeout(watchdog);
        // What the script left running in the background ends with the run: the time limit covers all of it.
        try { process.kill(-child.pid, 'SIGTERM'); } catch {}
        done(timedOut ? { status: 'timeout', exitCode: code, signal } : { status: code === 0 ? 'ok' : 'failed', exitCode: code, signal });
      });
    });
    ended = true;
    if (carry) readLine(carry);
    await new Promise((r) => logStream.end(r));
    Object.assign(run, result, { endedAt: now() });
    delete run.pid;
    run.outputs = [];
    for (const name of await readdir(outDir).catch(() => [])) {
      const s = await lstat(join(outDir, name)).catch(() => null);
      if (s?.isFile()) run.outputs.push({ name, size: s.size });
    }
    if (!run.summary && run.status !== 'ok') run.summary = result.error ?? (run.status === 'timeout' ? `stopped after ${job.timeoutMin ?? 30} min` : `exit code ${result.exitCode ?? result.signal}`);
    await write();
    log(`fox-jobs: ${job.name} ${run.status} in ${Math.round((run.endedAt - run.startedAt) / 1000)} s`);
    // Keep the last runs only.
    const all = (await readdir(store.runsDir(job.id)).catch(() => [])).sort();
    for (const old of all.slice(0, Math.max(0, all.length - KEEP_RUNS))) await rm(join(store.runsDir(job.id), old), { recursive: true, force: true });
    return run;
  }

  // Runs left "running" by a crash or a kill are marked interrupted, never assumed done.
  async function recover() {
    for (const j of await store.load()) {
      for (const r of await store.runs(j.id)) {
        if (r.status !== 'running') continue;
        Object.assign(r, { status: 'interrupted', endedAt: r.endedAt ?? now(), summary: r.summary ?? 'stopped before it finished (the runner restarted)' });
        await writeFile(join(store.runsDir(j.id), r.id, 'run.json'), JSON.stringify(r, null, 2), { mode: 0o600 });
      }
    }
  }

  return {
    tick, recover,
    get busy() { return Boolean(running); },
    async start() {
      await recover();
      await tick();
      // Keeps the process alive on its own (bin/fox-jobs.mjs has nothing else to wait on).
      timer = setInterval(() => tick().catch((err) => log(`fox-jobs: ${err.message}`)), tickMs);
    },
    stop() { stopped = true; clearInterval(timer); },
    async idle() { while (running) await running; },
    get current() { return current ? { jobId: current.job.id, runId: current.run.id, startedAt: current.run.startedAt } : null; },
  };
}
