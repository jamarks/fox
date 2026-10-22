import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const openTerminal = app.slice(app.indexOf('async function openTerminal('), app.indexOf('\nfunction terminalFontFamily()'));

for (const [kind, terminal, expected] of [
  ['new', { name: 'new-terminal' }, ['refresh', 'settings', 'prs', 'jobs', 'attach']],
  ['resume', { name: 'existing', resume: 'session-1' }, ['refresh', 'attach', 'select']],
  ['error', { error: 'failed' }, ['alert']],
]) {
  test(`${kind} terminal navigation`, async () => {
    const calls = [];
    const context = {
      state: { jobView: 'list', waking: null },
      post: async () => terminal,
      refresh: async () => calls.push('refresh'),
      closeSettings: () => calls.push('settings'),
      closePrs: () => calls.push('prs'),
      closeJob: () => calls.push('jobs'),
      attachTab: () => calls.push('attach'),
      selectSession: () => calls.push('select'),
      updateTermLoading: () => {},
      alert: () => calls.push('alert'),
    };
    runInNewContext(`${openTerminal}\nthis.open = openTerminal`, context);
    await context.open({ cwd: '/workspace', ...(kind === 'resume' ? { resume: 'session-1' } : {}) });
    assert.deepEqual(calls, expected);
  });
}
