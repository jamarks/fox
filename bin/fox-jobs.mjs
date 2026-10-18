#!/usr/bin/env node
// The jobs runner, as its own service on a server (FOX_JOBS_RUNNER=external for fox): a fox deploy restarts fox,
// never a job in the middle of its run. A deploy leaves <state>/jobs/restart-requested; the runner exits when it
// is idle and systemd starts it again on the new version.
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createJobStore, createRunner, updateJobRepo } from '../jobs.mjs';

const stateDir = process.env.FOX_STATE_DIR || join(homedir(), '.config', 'fox');
const store = createJobStore({ stateDir });
const runner = createRunner({ store, restartFile: join(stateDir, 'jobs', 'restart-requested'), onRestart: () => process.exit(0), beforeRun: updateJobRepo });
await runner.start();
console.log(`fox-jobs: watching ${join(stateDir, 'jobs.json')}`);
// Stopping waits for a run in progress (systemd gives it time): a job is never cut in half on purpose.
for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, async () => {
  runner.stop();
  if (runner.busy) { console.log('fox-jobs: waiting for the running job to finish'); await runner.idle(); }
  process.exit(0);
});
