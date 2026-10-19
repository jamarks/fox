import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, connectedProviders } from '../models.mjs';

// A fake fx: `status` reports the connected providers, `provider` switches, `models --json` lists the active one's.
function fakeFx({ connected = 'Codex', fail = false } = {}) {
  const fx = { connected, fail, active: 'codex', calls: [] };
  fx.run = async (args) => {
    fx.calls.push(args.join(' '));
    if (fx.fail) throw new Error('fx is down');
    if (args[0] === 'status') return `[status] auth=x\n[status] connected_providers=${fx.connected}\n`;
    if (args[0] === 'provider') { fx.active = args[1]; return ''; }
    if (args[0] === 'models') return JSON.stringify({ ids: [`${fx.active}/model-a`] });
    return '';
  };
  return fx;
}
async function setup(t, fxOptions) {
  const dir = await mkdtemp(join(tmpdir(), 'fox-models-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fx = fakeFx(fxOptions);
  let clock = 1000;
  const file = join(dir, 'state', 'models.json');
  const make = () => createModels({ fx: fx.run, file, readSettings: async () => ({ provider: 'codex' }), maxAgeMs: 60_000, now: () => clock });
  return { fx, file, make, tick: (ms) => (clock += ms) };
}
const listed = (fx) => fx.calls.filter((c) => c.startsWith('models')).length;

test('connected providers come from fx status, Grok included', () => {
  assert.deepEqual(connectedProviders('[status] connected_providers=Vercel AI Gateway, Codex, Grok').map((p) => p.id), ['codex', 'gateway', 'grok']);
  assert.deepEqual(connectedProviders('[status] auth=missing'), []);
});

test('a first login after an empty list is picked up without deleting any file', async (t) => {
  const { fx, make } = await setup(t, { connected: '' });
  const models = make();
  assert.deepEqual((await models.get()).providers, []);
  fx.connected = 'Codex';
  const after = await models.get();
  assert.deepEqual(after.providers.map((p) => p.id), ['codex']);
  assert.deepEqual(after.providers[0].models, ['codex/model-a']);
  assert.equal(fx.active, 'codex', 'switches back to the original provider');
});

test('the list is reused while fresh and the providers are the same, kept on disk across restarts', async (t) => {
  const { fx, file, make, tick } = await setup(t);
  await make().get();
  assert.equal(listed(fx), 1);
  await make().get(); // a new fox reads the file
  assert.equal(listed(fx), 1);
  assert.ok(JSON.parse(await readFile(file, 'utf8')).providers.length);
  tick(61_000);
  await make().get();
  assert.equal(listed(fx), 2, 'asked again once stale');
});

test('a failing fx keeps the last good list', async (t) => {
  const { fx, make, tick } = await setup(t);
  const models = make();
  const good = await models.get();
  fx.fail = true;
  tick(61_000);
  assert.deepEqual(await models.get(), good);
});

test('refreshes at the same time share one run', async (t) => {
  const { fx, make } = await setup(t);
  const models = make();
  await Promise.all([models.refresh(), models.refresh(), models.refresh()]);
  assert.equal(listed(fx), 1);
});
