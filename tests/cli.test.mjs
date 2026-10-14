import test from 'node:test';
import assert from 'node:assert/strict';
import { runFox } from '../bin/fox.mjs';

const stream = () => ({ text: '', write(chunk) { this.text += chunk; } });
const foxPage = { ok: true, text: async () => '<title>fox</title>' };

test('fox opens an already running panel without starting another server', async () => {
  const stdout = stream(), stderr = stream();
  const opened = [];
  const code = await runFox({ port: '4848', stdout, stderr,
    fetchPage: async (url) => { assert.equal(url, 'http://127.0.0.1:4848/'); return foxPage; },
    startServer: () => { throw new Error('must not start'); },
    openUrl: async (url) => opened.push(url),
  });
  assert.equal(code, 0);
  assert.deepEqual(opened, ['http://127.0.0.1:4848/']);
  assert.equal(stderr.text, '');
});

test('fox starts the panel when offline, waits for readiness, then opens the browser', async () => {
  let started = false, probes = 0;
  const stdout = stream(), opened = [];
  const code = await runFox({ stdout, stderr: stream(),
    fetchPage: async () => { probes++; if (!started || probes < 3) throw new Error('not ready'); return foxPage; },
    startServer: async () => { started = true; }, wait: async () => {},
    openUrl: async (url) => opened.push(url),
  });
  assert.equal(code, 0);
  assert.ok(started);
  assert.deepEqual(opened, ['http://127.0.0.1:4848/']);
  assert.match(stdout.text, /Ctrl\+C/);
});

test('fox refuses another app, invalid ports and start failures', async () => {
  const cases = [
    { options: { fetchPage: async () => ({ ok: true, text: async () => '<title>other</title>' }) }, error: /not fox/ },
    { options: { port: 'bad' }, error: /Invalid PORT/ },
    { options: { fetchPage: async () => { throw new Error('offline'); }, startServer: async () => { throw new Error('no tmux'); } }, error: /Could not start fox: no tmux/ },
  ];
  for (const { options, error } of cases) {
    const stderr = stream();
    const code = await runFox({ ...options, stderr, stdout: stream(), openUrl: async () => { throw new Error('must not open'); } });
    assert.equal(code, 1);
    assert.match(stderr.text, error);
  }
});
