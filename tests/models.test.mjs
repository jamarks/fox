import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createModels, connectedProviders, launchArgs } from '../models.mjs';

const exec = promisify(execFile);
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'fox-models-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, 'fx'), settings = join(dir, 'settings.json'), calls = join(dir, 'calls');
  await writeFile(settings, JSON.stringify({ provider: 'codex', models: { codex: 'gpt', 'my-local': 'qwen:7b' }, providers: { 'my-local': { base_url: 'http://127.0.0.1:1234/v1', auth: { type: 'bearer', env: 'PRIVATE_KEY' } } } }));
  await writeFile(bin, `#!/usr/bin/env node
const fs=require('fs'); const a=process.argv.slice(2), p=process.env.FX_PROVIDER || 'codex';
fs.appendFileSync(process.env.CALLS, JSON.stringify({a,p})+'\\n');
if(a[0]==='status') console.log(JSON.stringify({kind:'status',connected_providers:['codex','grok']}));
else if(a[0]==='models') { const id=p==='my-local'?'qwen:7b':'gpt'; console.log(JSON.stringify({ids:[id],models:[{id,name:'Named '+id,efforts:p==='codex'?['low','high']:[],fast:p==='codex',ultrafast:p==='codex'}]})); }
else process.exit(2);
`);
  await chmod(bin, 0o755);
  let clock = 1000;
  const fx = async (args, env = {}) => (await exec(bin, args, { env: { ...process.env, ...env, CALLS: calls }, timeout: 3000 })).stdout;
  const make = (options = {}) => createModels({ fx, file: join(dir, 'models.json'), readSettings: () => readFile(settings, 'utf8').then(JSON.parse), maxAgeMs: 60_000, now: () => clock, ...options });
  const history = async () => (await readFile(calls, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  return { dir, make, history, tick: (ms) => clock += ms, settings };
}

test('status JSON names and configured local connections are included without credentials', () => {
  assert.deepEqual(connectedProviders({ connected_providers: ['vercel-ai-gateway', 'grok'] }, { providers: { local: {} } }).map((p) => p.id), ['gateway', 'grok', 'local']);
});

test('concurrent refreshes use process-local overrides and leave defaults and secrets untouched', async (t) => {
  const { make, history, settings } = await setup(t);
  const before = await readFile(settings, 'utf8');
  const catalog = await Promise.all([make().refresh(), make().refresh()]);
  assert.equal(await readFile(settings, 'utf8'), before);
  assert.ok(catalog[0].providers.some((p) => p.id === 'my-local' && p.models.includes('qwen:7b')));
  assert.doesNotMatch(JSON.stringify(catalog), /base_url|PRIVATE_KEY|127\.0\.0\.1/);
  assert.ok((await history()).every(({ a, p }) => a[0] !== 'provider' && (a[0] !== 'models' || ['codex', 'grok', 'my-local'].includes(p))));
});

test('cache is bounded, reused across instances and survives fx failure', async (t) => {
  const { make, history, tick, dir } = await setup(t);
  const first = await make().get();
  const count = (await history()).length;
  assert.deepEqual(await make().get(), first);
  assert.equal((await history()).length, count + 1, 'status still checked');
  tick(61_000);
  const refreshed = await make().get();
  assert.ok((await history()).length > count + 1);
  await writeFile(join(dir, 'fx'), '#!/bin/sh\nexit 1\n');
  tick(61_000);
  assert.deepEqual(await make().get(), refreshed);
  tick(120_000);
  await assert.rejects(make({ maxStaleMs: 120_000 }).get(), /Could not list models/);
});

test('older text status and ids-only models expose only the saved provider, with unknown capabilities', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fox-legacy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [];
  const fx = async (args, env) => {
    calls.push({ args, env });
    if (args[0] === 'status' && args.includes('--json')) throw new Error('unsupported');
    if (args[0] === 'status') return '[status] connected_providers=Codex, Grok';
    return JSON.stringify({ ids: ['old-model'] });
  };
  const catalog = await createModels({ fx, file: join(dir, 'cache'), readSettings: async () => ({ provider: 'codex' }) }).get();
  assert.deepEqual(catalog.providers.map((p) => p.id), ['codex']);
  assert.deepEqual(catalog.providers[0].details[0], { id: 'old-model', name: null, efforts: [], fast: false, ultrafast: false, ultrafastKnown: false });
  assert.equal(calls.some((c) => c.args[0] === 'status' && !c.args.includes('--json')), false, 'never parse text status');
  assert.deepEqual(launchArgs(catalog, { provider: 'codex', model: 'old-model' }), ['--provider', 'codex', '--model', 'old-model']);
  assert.equal(calls.find((c) => c.args[0] === 'models').env.FX_PROVIDER, undefined);
});

test('explicit launch flags reject unsupported effort and speed; never combine speed enables', async (t) => {
  const { make } = await setup(t);
  const cat = await make().get();
  const choice = { provider: 'codex', model: 'gpt' };
  assert.deepEqual(launchArgs(cat, { ...choice, effort: 'high', speed: 'ultrafast' }), ['--provider','codex','--model','gpt','--effort','high','--no-fast','--ultrafast']);
  assert.deepEqual(launchArgs(cat, { ...choice, speed: 'fast' }).slice(-2), ['--fast', '--no-ultrafast']);
  assert.deepEqual(launchArgs(cat, choice).slice(-1), ['--no-ultrafast']);
  assert.throws(() => launchArgs(cat, { ...choice, effort: 'xhigh' }), /Unsupported effort/);
  assert.throws(() => launchArgs(cat, { provider: 'my-local', model: 'qwen:7b', speed: 'ultrafast' }), /Unsupported speed/);
  assert.throws(() => launchArgs(cat, { provider: "local';touch /tmp/x;#", model: 'gpt' }), /Unknown provider/);
  assert.deepEqual(launchArgs(cat, {}), []);
  const future = { providers: [{ id: 'my-local', details: [{ id: 'qwen:7b', efforts: ['very_high'], fast: false, ultrafast: false, ultrafastKnown: false }] }] };
  assert.deepEqual(launchArgs(future, { provider: 'my-local', model: 'qwen:7b', effort: 'very_high' }).slice(-2), ['--effort', 'very_high']);
});
