import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createJobStore, createRunner, commandFor } from '../jobs.mjs';

const tz = 'Europe/Berlin';
async function setup(scripts = {}) {
  const base = await mkdtemp(join(tmpdir(), 'fox-jobs-'));
  const work = join(base, 'work');
  await mkdir(join(work, 'jobs'), { recursive: true });
  for (const [name, body] of Object.entries(scripts)) await writeFile(join(work, 'jobs', name), body);
  const store = createJobStore({ stateDir: join(base, 'state') });
  return { base, work, store };
}
const quiet = () => {};
const daily = (at) => ({ kind: 'daily', at });

test('a job is validated before it is saved', async () => {
  const { work, store } = await setup({ 'ok.mjs': '' });
  const base = { cwd: work, script: 'jobs/ok.mjs', schedule: daily('08:00'), tz };
  await assert.rejects(store.create({ ...base, name: 'Bad Name' }), /lowercase/);
  await assert.rejects(store.create({ ...base, name: 'x', script: '../etc/passwd' }), /inside the folder/);
  await assert.rejects(store.create({ ...base, name: 'x', script: 'jobs/missing.py' }), /does not exist/);
  await assert.rejects(store.create({ ...base, name: 'x', cwd: '/no/such/dir' }), /does not exist/);
  await assert.rejects(store.create({ ...base, name: 'x', schedule: { kind: 'cron' } }), /Unknown kind/);
  await assert.rejects(store.create({ ...base, name: 'x', args: 'rm -rf /' }), /list of words/);
  const job = await store.create({ ...base, name: 'report' });
  assert.equal(job.enabled, true);
  assert.equal(job.timeoutMin, 30);
  await assert.rejects(store.create({ ...base, name: 'report' }), /already exists/);
  const [o] = await store.overview(Date.parse('2026-10-17T05:00:00Z'));
  assert.equal(o.scheduleText, 'daily 08:00');
  assert.equal(new Date(o.nextRun).toISOString(), '2026-10-17T06:00:00.000Z');
});

test('a due job runs once, with its log, summary and output files', async () => {
  const { store, work } = await setup({ 'report.mjs': `
    import { writeFile } from 'node:fs/promises';
    console.log('gathering data');
    console.error('a warning');
    await writeFile(process.env.FOX_JOB_OUTPUT + '/report.md', '# hi\\n');
    console.log('FOX_SUMMARY: wrote report.md');
    console.log('FOX_LINK: PR #7 https://github.com/o/r/pull/7');
    console.log('FOX_LINK: https://example.com/report');
    console.log('FOX_LINK: not a link javascript:alert(1)');
  ` });
  const job = await store.create({ name: 'report', cwd: work, script: 'jobs/report.mjs', schedule: daily('08:00'), tz });
  let clock = Date.parse('2026-10-17T05:59:00Z'); // 07:59 Berlin
  const runner = createRunner({ store, now: () => clock, log: quiet });
  await runner.tick(); await runner.idle();
  assert.equal((await store.runs(job.id)).length, 0, 'not due yet');
  clock = Date.parse('2026-10-17T06:00:30Z');
  await runner.tick(); await runner.tick(); await runner.idle();
  const runs = await store.runs(job.id);
  assert.equal(runs.length, 1, 'ran exactly once');
  assert.equal(runs[0].status, 'ok');
  assert.equal(runs[0].reason, 'schedule');
  assert.equal(runs[0].summary, 'wrote report.md');
  assert.deepEqual(runs[0].outputs, [{ name: 'report.md', size: 5 }]);
  assert.deepEqual(runs[0].links, [{ label: 'PR #7', url: 'https://github.com/o/r/pull/7' }, { label: 'example.com', url: 'https://example.com/report' }]);
  const log = await store.readLog(job.id, runs[0].id);
  assert.match(log, /gathering data/);
  assert.match(log, /a warning/);
  assert.equal(await readFile(await store.outputPath(job.id, runs[0].id, 'report.md'), 'utf8'), '# hi\n');
  assert.equal(await store.outputPath(job.id, runs[0].id, '../../jobs.json'), null);
});

test('provenance captures post-sync bytes and checkout, and compares later changes without rewriting the run', async () => {
  const { store, work } = await setup({ 'report.sh': 'echo old\n' });
  const git = (...args) => execFileSync('git', ['-C', work, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  git('add', '.'); git('commit', '-qm', 'initial');
  const job = await store.create({ name: 'report', cwd: work, script: 'jobs/report.sh', args: ['--token=private-value', '--password', 'hidden', 'safe', '--endpoint=https://alice:private@host', 'sk-private'], schedule: daily('03:00'), tz, model: 'gpt-test', effort: 'low' });
  const updated = 'echo FOX_SUMMARY: updated\n';
  const runner = createRunner({ store, log: quiet, beforeRun: async () => { await writeFile(join(work, 'jobs/report.sh'), updated); } });
  await store.trigger(job.id); await runner.tick(); await runner.idle();
  const [run] = await store.runs(job.id);
  const p = run.provenance;
  assert.equal(run.summary, 'updated');
  assert.equal(p.script, 'jobs/report.sh');
  assert.equal(p.sha256, createHash('sha256').update(updated).digest('hex'));
  assert.deepEqual(p.args, ['--token=[redacted]', '--password', '[redacted]', '[redacted]', '--endpoint=[redacted]', '[redacted]']);
  assert.doesNotMatch(JSON.stringify(run), /private-value|hidden|sk-private|alice|FOX_JOB_OUTPUT/);
  assert.equal(p.trigger, 'manual'); assert.deepEqual(p.schedule, daily('03:00'));
  assert.equal(p.model, 'gpt-test'); assert.equal(p.effort, 'low');
  assert.ok(p.fxVersion === null || typeof p.fxVersion === 'string');
  assert.deepEqual(p.repos, [{ path: '.', head: git('rev-parse', 'HEAD'), dirty: true }]);
  assert.equal((await store.provenance(job.id, run.id)).scriptChanged, false);
  await writeFile(join(work, 'jobs/report.sh'), 'echo changed again\n');
  git('add', '.'); git('commit', '-qm', 'changed');
  const compared = await store.provenance(job.id, run.id);
  assert.equal(compared.scriptChanged, true);
  assert.deepEqual(compared.reposChanged, [{ path: '.', changed: true }]);
  assert.deepEqual((await store.runs(job.id))[0].provenance, p, 'run.json stays immutable');
});

test('workspace sibling checkouts are captured; older runs have no provenance', async () => {
  const { store, work } = await setup({ 'report.sh': 'echo done\n' });
  const sibling = join(work, 'other'); await mkdir(sibling);
  const git = (...args) => execFileSync('git', ['-C', sibling, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  await writeFile(join(sibling, 'file'), 'a'); git('add', '.'); git('commit', '-qm', 'initial');
  const job = await store.create({ name: 'report', cwd: work, script: 'jobs/report.sh', schedule: daily('03:00'), tz });
  const runner = createRunner({ store, log: quiet });
  await store.trigger(job.id); await runner.tick(); await runner.idle();
  const [run] = await store.runs(job.id);
  assert.deepEqual(run.provenance.repos, [{ path: 'other', head: git('rev-parse', 'HEAD'), dirty: false }]);
  await writeFile(join(sibling, 'file'), 'b');
  assert.deepEqual((await store.provenance(job.id, run.id)).reposChanged, [{ path: 'other', changed: false }], 'dirty is not a HEAD change');
  const oldId = '20261017-100000-abc123';
  await mkdir(join(store.runsDir(job.id), oldId));
  await writeFile(join(store.runsDir(job.id), oldId, 'run.json'), JSON.stringify({ id: oldId, status: 'ok' }));
  assert.deepEqual(await store.provenance(job.id, oldId), { provenance: null });
});

test('Run now starts a job that is not due; a failing script is recorded as failed', async () => {
  const { store, work } = await setup({ 'fail.sh': 'echo trying; exit 3\n' });
  const job = await store.create({ name: 'flaky', cwd: work, script: 'jobs/fail.sh', schedule: daily('03:00'), tz });
  const runner = createRunner({ store, now: () => Date.parse('2026-10-17T10:00:00Z'), log: quiet });
  await store.trigger(job.id);
  await runner.tick(); await runner.idle();
  const [run] = await store.runs(job.id);
  assert.equal(run.reason, 'manual');
  assert.equal(run.status, 'failed');
  assert.equal(run.exitCode, 3);
  assert.equal(run.summary, 'exit code 3');
});

test('a job past its time limit is stopped with its children', async () => {
  const { store, work } = await setup({ 'slow.sh': 'sleep 30 & sleep 30\n' });
  const job = await store.create({ name: 'slow', cwd: work, script: 'jobs/slow.sh', schedule: daily('03:00'), tz, timeoutMin: 1 });
  const runner = createRunner({ store, now: () => Date.now(), minuteMs: 300, log: quiet });
  await store.trigger(job.id);
  const t0 = Date.now();
  await runner.tick(); await runner.idle();
  const [run] = await store.runs(job.id);
  assert.equal(run.status, 'timeout');
  assert.ok(Date.now() - t0 < 5000, 'stopped promptly');
});

test('one job at a time, and an outage never fires a burst of missed runs', async () => {
  const { store, work } = await setup({ 'quick.sh': 'echo FOX_SUMMARY: done\n' });
  const hourly = { kind: 'hours', every: 1, from: '00:00', to: '23:00' };
  const a = await store.create({ name: 'a', cwd: work, script: 'jobs/quick.sh', schedule: hourly, tz });
  const b = await store.create({ name: 'b', cwd: work, script: 'jobs/quick.sh', schedule: hourly, tz });
  let clock = Date.parse('2026-10-17T10:10:00Z');
  const runner = createRunner({ store, now: () => clock, log: quiet });
  await runner.tick();
  clock += 10 * 3600_000; // ten hours pass at once
  await runner.tick();
  assert.ok(runner.busy, 'the first runs');
  await runner.idle(); await runner.tick(); await runner.idle();
  assert.equal((await store.runs(a.id)).length, 1, 'a: one run, not ten');
  assert.equal((await store.runs(b.id)).length, 1, 'b: one run, after a');
});

test('runs a crash left running are marked interrupted', async () => {
  const { store, work } = await setup({ 'x.sh': '' });
  const job = await store.create({ name: 'x', cwd: work, script: 'jobs/x.sh', schedule: daily('03:00'), tz });
  const dir = join(store.runsDir(job.id), '20261017-100000-abc123');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'run.json'), JSON.stringify({ id: '20261017-100000-abc123', jobId: job.id, status: 'running', startedAt: 1 }));
  await createRunner({ store, log: quiet }).recover();
  const [run] = await store.runs(job.id);
  assert.equal(run.status, 'interrupted');
});

test('scripts start by extension, never through a shell string', () => {
  assert.deepEqual(commandFor('jobs/a.py', ['--x']), ['python3', ['-u', 'jobs/a.py', '--x']]);
  assert.deepEqual(commandFor('jobs/a.sh'), ['bash', ['jobs/a.sh']]);
  assert.equal(commandFor('jobs/a.mjs')[1][0], 'jobs/a.mjs');
  assert.deepEqual(commandFor('jobs/run', ['a b; rm -rf /']), ['jobs/run', ['a b; rm -rf /']]);
});

test('output that only looks like a link never stops the runner; links and output files are what they say', async () => {
  const { store, work } = await setup({ 'odd.mjs': `
    import { writeFile, symlink } from 'node:fs/promises';
    console.log('FOX_LINK: https://[oops');
    console.log('FOX_LINK: ok https://example.com/x');
    await writeFile(process.env.FOX_JOB_OUTPUT + '/real.txt', 'real');
    await symlink('/etc/hosts', process.env.FOX_JOB_OUTPUT + '/hosts.txt');
  ` });
  const job = await store.create({ name: 'odd', cwd: work, script: 'jobs/odd.mjs', schedule: daily('03:00'), tz });
  const runner = createRunner({ store, log: quiet });
  await store.trigger(job.id);
  await runner.tick(); await runner.idle();
  const [run] = await store.runs(job.id);
  assert.equal(run.status, 'ok');
  assert.deepEqual(run.links, [{ label: 'ok', url: 'https://example.com/x' }]);
  assert.deepEqual(run.outputs, [{ name: 'real.txt', size: 4 }], 'a symlink is not an output');
  assert.equal(await store.outputPath(job.id, run.id, 'hosts.txt'), null);
});

test('a script without an extension is the file in the folder, not a command on PATH', async () => {
  const { store, work } = await setup();
  await writeFile(join(work, 'ls'), '#!/bin/sh\necho FOX_SUMMARY: the folder one\n', { mode: 0o755 });
  const job = await store.create({ name: 'own', cwd: work, script: 'ls', schedule: daily('03:00'), tz });
  const runner = createRunner({ store, log: quiet });
  await store.trigger(job.id);
  await runner.tick(); await runner.idle();
  const [run] = await store.runs(job.id);
  assert.equal(run.summary, 'the folder one');
});

test('what a script leaves running in the background ends with its run', async () => {
  const { store, work } = await setup({ 'bg.sh': 'sleep 30 > /dev/null 2>&1 &\necho $! > "$FOX_JOB_OUTPUT/pid"\n' });
  const job = await store.create({ name: 'bg', cwd: work, script: 'jobs/bg.sh', schedule: daily('03:00'), tz });
  const runner = createRunner({ store, log: quiet });
  await store.trigger(job.id);
  await runner.tick(); await runner.idle();
  const [run] = await store.runs(job.id);
  const pid = Number(await readFile(await store.outputPath(job.id, run.id, 'pid'), 'utf8'));
  // Stopped means gone or a zombie: under a subreaper that does not reap (fx running the tests, some containers)
  // the killed sleep stays in the table as Z, and kill(pid, 0) still succeeds on it.
  const running = () => { try { process.kill(pid, 0); return !/Z/.test(execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })); } catch { return false; } };
  for (let i = 0; i < 20 && running(); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(running(), false, 'the background sleep was stopped');
});

test('two writers at once both land in jobs.json', async () => {
  const { store, work } = await setup({ 'a.sh': '' });
  const def = (name) => ({ name, cwd: work, script: 'jobs/a.sh', schedule: daily('03:00'), tz });
  await Promise.all(['one', 'two', 'three', 'four'].map((n) => store.create(def(n))));
  assert.deepEqual((await store.list()).map((j) => j.name).sort(), ['four', 'one', 'three', 'two']);
});

test('a job added from a terminal waits for the OK on fox\'s page before it ever runs', async () => {
  const { store, work } = await setup({ 'a.sh': 'echo FOX_SUMMARY: ran\n' });
  const job = await store.create({ name: 'from-fx', cwd: work, script: 'jobs/a.sh', schedule: { kind: 'hours', every: 1, from: '00:00', to: '23:00', days: [1, 2, 3, 4, 5, 6, 7] }, tz }, { from: 'terminal' });
  assert.equal(job.enabled, false);
  assert.equal(job.pendingApproval, true);
  await assert.rejects(store.update(job.id, { enabled: true }, { from: 'terminal' }), /approve/);
  await assert.rejects(store.trigger(job.id, { from: 'terminal' }), /approve/);
  // Even a trigger file written by hand does not run it.
  await mkdir(store.triggers, { recursive: true });
  await writeFile(join(store.triggers, job.id), '1');
  const runner = createRunner({ store, log: quiet });
  await runner.tick(); await runner.idle();
  assert.equal((await store.runs(job.id)).length, 0);
  // Turning it on in fox is the OK; from then on the terminal manages it like any other.
  const approved = await store.update(job.id, { enabled: true });
  assert.equal(approved.pendingApproval, undefined);
  await store.update(job.id, { enabled: false }, { from: 'terminal' });
  await store.update(job.id, { enabled: true }, { from: 'terminal' });
});

test('a job can pick fx\'s model and effort; its script sees them as FOX_JOB_MODEL and FOX_JOB_EFFORT', async () => {
  const { store, work } = await setup({ 'm.sh': 'echo "FOX_SUMMARY: ${FOX_JOB_MODEL:-none} ${FOX_JOB_EFFORT:-none}"\n' });
  const base = { cwd: work, script: 'jobs/m.sh', schedule: daily('08:00'), tz };
  await assert.rejects(store.create({ ...base, name: 'x', model: 'gpt; rm -rf /' }), /model id/);
  await assert.rejects(store.create({ ...base, name: 'x', effort: 'max' }), /Effort is one of/);
  const job = await store.create({ ...base, name: 'm', model: 'gpt-6.1-sol', effort: 'medium' });
  const runner = createRunner({ store, log: quiet });
  await store.trigger(job.id); await runner.tick(); await runner.idle();
  const [first] = await store.runs(job.id);
  assert.equal(first.summary, 'gpt-6.1-sol medium');
  await store.update(job.id, { model: '', effort: '' });
  const plain = await store.get(job.id);
  assert.equal('model' in plain || 'effort' in plain, false, 'empty leaves it to the script again');
  await store.trigger(job.id); await runner.tick(); await runner.idle();
  assert.equal((await store.runs(job.id)).find((r) => r.id !== first.id).summary, 'none none', 'runs in the same second can list in either order');
});
