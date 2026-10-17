import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const log = await store.readLog(job.id, runs[0].id);
  assert.match(log, /gathering data/);
  assert.match(log, /a warning/);
  assert.equal(await readFile(await store.outputPath(job.id, runs[0].id, 'report.md'), 'utf8'), '# hi\n');
  assert.equal(await store.outputPath(job.id, runs[0].id, '../../jobs.json'), null);
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
