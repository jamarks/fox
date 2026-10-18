import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJobStore, createRunner } from '../jobs.mjs';

const exec = promisify(execFile);

test('foxjob, the Python helpers for jobs, passes its own tests', async () => {
  const { stderr } = await exec('python3', ['-m', 'unittest', 'discover', '-s', 'lib/python/tests', '-q'], { cwd: new URL('..', import.meta.url).pathname, timeout: 120_000 });
  assert.match(stderr, /\nOK\s*$/);
});

test('a Python job can import foxjob without setting anything up', async () => {
  const base = await mkdtemp(join(tmpdir(), 'fox-foxjob-'));
  await mkdir(join(base, 'jobs'));
  await writeFile(join(base, 'jobs', 'hello.py'), 'import foxjob\nfoxjob.link("PR #3", "https://github.com/o/r/pull/3")\nfoxjob.summary("hello from foxjob")\n');
  const store = createJobStore({ stateDir: join(base, 'state') });
  const job = await store.create({ name: 'hello', cwd: base, script: 'jobs/hello.py', schedule: { kind: 'daily', at: '03:00' }, tz: 'UTC' });
  const runner = createRunner({ store, log: () => {} });
  await store.trigger(job.id);
  await runner.tick(); await runner.idle();
  const [run] = await store.runs(job.id);
  assert.equal(run.status, 'ok');
  assert.equal(run.summary, 'hello from foxjob');
  assert.deepEqual(run.links, [{ label: 'PR #3', url: 'https://github.com/o/r/pull/3' }]);
});
