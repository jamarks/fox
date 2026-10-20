import test from 'node:test';
import assert from 'node:assert/strict';
import { runFox } from '../bin/fox.mjs';
import { launchArgs } from '../models.mjs';
import { execFile } from 'node:child_process';
import { mkdtemp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('CLI launch arguments keep arbitrary catalog IDs as separate words and exclude contradictory speed flags', () => {
  const model = "qwen:7b's test";
  const catalog = { providers: [{ id: 'my-local', details: [{ id: model, efforts: ['low'], fast: true, ultrafast: false }] }] };
  const args = launchArgs(catalog, { provider: 'my-local', model, effort: 'low', speed: 'fast' });
  assert.deepEqual(args, ['--provider', 'my-local', '--model', model, '--effort', 'low', '--fast', '--no-ultrafast']);
  assert.ok(!args.includes('--ultrafast'));
});

const stream = () => ({ text: '', write(chunk) { this.text += chunk; } });
const foxPage = { ok: true, text: async () => '<title>fox</title>' };

test('fox opens an already running panel without starting another server', async () => {
  const stdout = stream(), stderr = stream();
  const opened = [];
  const code = await runFox({ port: '4848', stdout, stderr, headless: false,
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
  const code = await runFox({ stdout, stderr: stream(), headless: false,
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

test('fox on a machine without a screen says how to reach it instead of opening a browser', async () => {
  const stdout = stream();
  const code = await runFox({ stdout, stderr: stream(), headless: true,
    fetchPage: async () => foxPage, openUrl: async () => { throw new Error('must not open'); } });
  assert.equal(code, 0);
  assert.match(stdout.text, /No browser on this machine/);
});

// npm installs the command as a symlink: run through one, the way `fox` really starts, with a bad argument
// so it answers right away instead of starting a server.
test('fox runs when started through a symlink, as npm installs it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fox-bin-'));
  try {
    const link = join(dir, 'fox');
    await symlink(fileURLToPath(new URL('../bin/fox.mjs', import.meta.url)), link);
    const result = await new Promise((done) => execFile(process.execPath, [link, 'extra'], (error, stdout, stderr) => done({ code: error?.code ?? 0, stderr })));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Usage: fox/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
