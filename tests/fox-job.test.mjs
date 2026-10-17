import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseDays, parseAdd } from '../bin/fox-job.mjs';
import { withFoxBlock, ensureFoxNotes, foxNotes } from '../notes.mjs';
const run = promisify(execFile);
const cli = new URL('../bin/fox-job.mjs', import.meta.url).pathname;

test('days read the way people write them', () => {
  assert.deepEqual(parseDays('mon-fri'), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseDays('sat,sun'), [6, 7]);
  assert.deepEqual(parseDays('fri-mon'), [1, 5, 6, 7]);
  assert.deepEqual(parseDays('mon,thu'), [1, 4]);
  assert.deepEqual(parseDays('all'), [1, 2, 3, 4, 5, 6, 7]);
  assert.throws(() => parseDays('monday-someday'), /Unknown days/);
});

test('add options become the same definition the panel makes', () => {
  const def = parseAdd(['linear-bugfix', '--script', 'jobs/bugfix.py', '--every', '2', '--from', '09:00', '--to', '19:00', '--days', 'mon-fri', '--', '--team', 'FOX'], { cwd: '/w', tz: 'Europe/Berlin' });
  assert.deepEqual(def, { name: 'linear-bugfix', script: 'jobs/bugfix.py', cwd: '/w', args: ['--team', 'FOX'], tz: 'Europe/Berlin', timeoutMin: undefined, enabled: true,
    schedule: { kind: 'hours', every: 2, from: '09:00', to: '19:00', days: [1, 2, 3, 4, 5] } });
  assert.deepEqual(parseAdd(['r', '--script', 'a.py', '--daily', '08:00', '--paused'], { cwd: '/w', tz: 'UTC' }).schedule, { kind: 'daily', at: '08:00', days: [1, 2, 3, 4, 5, 6, 7] });
  assert.deepEqual(parseAdd(['r', '--script', 'a.py', '--once', '2026-10-20', '10:00'], { cwd: '/w', tz: 'UTC' }).schedule, { kind: 'once', date: '2026-10-20', at: '10:00' });
  assert.throws(() => parseAdd(['r', '--script', 'a.py'], { cwd: '/w' }), /Say when/);
});

test('fox-job manages jobs end to end, sharing the panel\'s store', async () => {
  const base = await mkdtemp(join(tmpdir(), 'fox-jobcli-'));
  await mkdir(join(base, 'work', 'jobs'), { recursive: true });
  await writeFile(join(base, 'work', 'jobs', 'report.py'), 'print("hi")\n');
  const env = { ...process.env, FOX_STATE_DIR: join(base, 'state'), FOX_DEFAULT_TZ: 'Europe/Berlin' };
  const fox = (...args) => run(process.execPath, [cli, ...args], { env, cwd: join(base, 'work') }).then((r) => r.stdout);
  assert.match(await fox('add', 'report', '--script', 'jobs/report.py', '--daily', '08:00', '--days', 'mon-fri'), /Created report: Mon–Fri 08:00 \(Europe\/Berlin\), next/);
  assert.match(await fox('list'), /report\tMon–Fri 08:00\tnext .*\tlast never/);
  await fox('pause', 'report');
  assert.match(await fox('list'), /report\tpaused/);
  assert.match(await fox('run', 'report'), /will start/);
  const saved = JSON.parse(await readFile(join(base, 'state', 'jobs.json'), 'utf8'));
  assert.equal(saved[0].cwd, await realpath(join(base, 'work')));
  await assert.rejects(fox('add', 'Bad Name', '--script', 'jobs/report.py', '--daily', '08:00'), /lowercase/);
  await assert.rejects(fox('pause', 'nope'), /No job named nope/);
  assert.match(await fox('remove', 'report'), /Removed report/);
  assert.match(await fox('list'), /No jobs yet/);
});

test('fox keeps its block in fx\'s instructions without touching the rest', async () => {
  assert.equal(withFoxBlock('', 'A'), '<!-- fox:start · written by fox; edits inside this block are replaced -->\nA\n<!-- fox:end -->\n');
  const mine = '# My rules\n\nBe brief.\n';
  const once = withFoxBlock(mine, 'A');
  assert.ok(once.startsWith(mine.trim()));
  const twice = withFoxBlock(once + '\nMore of mine.\n', 'B');
  assert.match(twice, /Be brief\./); assert.match(twice, /More of mine\./);
  assert.match(twice, /\nB\n/); assert.doesNotMatch(twice, /\nA\n/);
  const dir = await mkdtemp(join(tmpdir(), 'fox-notes-'));
  const file = join(dir, '.fx', 'AGENTS.md');
  assert.equal(await ensureFoxNotes(file, foxNotes()), true);
  assert.equal(await ensureFoxNotes(file, foxNotes()), false, 'unchanged: not rewritten');
  const text = await readFile(file, 'utf8');
  assert.match(text, /fox-job add <name>/);
  assert.match(text, /only when the user asks/);
  assert.match(foxNotes({ preview: { url: 'https://fox-{port}.example.com', ports: [5173] } }), /https:\/\/fox-5173\.example\.com/);
});
