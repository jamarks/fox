import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrStates, PR_URL } from '../prstate.mjs';

const link = (url, label = 'review') => ({ label, url });

test('recognizes GitHub pull request links only', () => {
  assert.ok(PR_URL.test('https://github.com/jamarks/fox/pull/7'));
  assert.ok(PR_URL.test('https://github.com/jamarks/fox/pull/7/files'));
  assert.ok(!PR_URL.test('https://github.com/jamarks/fox/issues/7'));
  assert.ok(!PR_URL.test('https://example.com/pull/7'));
});

test('decorates links with the state gh reports, after the first lookup', async () => {
  const calls = [];
  const states = createPrStates({ run: async (args) => { calls.push(args); return JSON.stringify({ state: args[2] === '7' ? 'MERGED' : 'OPEN' }); } });
  const runs = [{ links: [link('https://github.com/jamarks/fox/pull/7'), link('https://github.com/jamarks/fox/pull/8'), link('https://example.com/report')] }];
  states.decorate(runs); // first call: nothing known yet, lookups start
  assert.equal(runs[0].links[0].pr, undefined);
  await states.settle();
  states.decorate(runs);
  assert.equal(runs[0].links[0].pr, 'merged');
  assert.equal(runs[0].links[1].pr, 'open');
  assert.equal(runs[0].links[2].pr, undefined);
  assert.deepEqual(calls[0], ['pr', 'view', '7', '--repo', 'jamarks/fox', '--json', 'state']);
});

test('merged is final; open is asked again after its ttl', async () => {
  let t = 0, n = 0;
  const states = createPrStates({ run: async () => { n++; return JSON.stringify({ state: n === 1 ? 'MERGED' : 'OPEN' }); }, openTtlMs: 1000, now: () => t });
  const merged = [{ links: [link('https://github.com/a/b/pull/1')] }];
  states.decorate(merged); await states.settle(); states.decorate(merged);
  t = 10_000; states.decorate(merged); await states.settle();
  assert.equal(n, 1, 'a merged pull request is never asked again');
  const open = [{ links: [link('https://github.com/a/b/pull/2')] }];
  states.decorate(open); await states.settle(); states.decorate(open);
  assert.equal(open[0].links[0].pr, 'open');
  t = 20_000; states.decorate(open); await states.settle();
  assert.equal(n, 3, 'an open one is checked again once the ttl passed');
});

test('uses the owner token from the tokens folder when there is one', async () => {
  const envs = [];
  const states = createPrStates({ tokensDir: new URL('./fixtures-no-such-dir', import.meta.url).pathname, run: async (args, env) => { envs.push(env); return '{"state":"OPEN"}'; } });
  states.decorate([{ links: [link('https://github.com/jamarks/fox/pull/9')] }]); await states.settle();
  assert.deepEqual(envs[0], {}, 'no token file: gh uses its own login');
});

test('a failing gh leaves the link as it was', async () => {
  const states = createPrStates({ run: async () => { throw new Error('gh: not logged in'); } });
  const runs = [{ links: [link('https://github.com/a/b/pull/3')] }];
  states.decorate(runs); await states.settle(); states.decorate(runs);
  assert.equal(runs[0].links[0].pr, undefined);
});
