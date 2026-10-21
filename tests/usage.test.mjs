import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsage, normalizeUsage } from '../usage.mjs';

const base = (source, extra = {}) => ({ kind: 'usage', schema_version: 2, source, period: 'today', status: 'ready', fetched_at_ms: 123456, ...extra });

test('provider-specific reports expose only reported headroom, with missing resets left unknown', () => {
  assert.deepEqual(normalizeUsage(base('ai_gateway', { budget: { limit: 50, spent: 12, period: 'monthly' }, totals: { spend: 2.75 }, models: [{ secret: 'do not leak' }] }), 'gateway'),
    { fetchedAt: 123456, data: { budget: { limit: 50, spent: 12, period: 'monthly' }, spend: 2.75 } });
  assert.deepEqual(normalizeUsage(base('ai_gateway', { budget: null, totals: { spend: 0 } }), 'gateway').data, { spend: 0 });
  const codex = normalizeUsage(base('chatgpt', { codex: { plan: 'pro', limits: [{ name: 'codex', primary: { used_percent: 42, window_seconds: 18000, resets_at_ms: null }, secondary: { used_percent: 18, window_seconds: 604800, resets_at_ms: 456789 } }], credits: { has_credits: true, unlimited: false, balance: '12.40' } } }), 'codex');
  assert.deepEqual(codex.data.limits, [{ name: 'codex', usedPercent: 42, windowSeconds: 18000, resetsAt: null }, { name: 'codex', usedPercent: 18, windowSeconds: 604800, resetsAt: 456789 }]);
  assert.equal(codex.data.credits, '12.40');
  assert.deepEqual(normalizeUsage(base('chatgpt', { codex: { limits: [
    { name: 'bad', primary: { used_percent: 101, window_seconds: 18000 }, secondary: { used_percent: -2, window_seconds: 18000 } },
    { name: 'zero window', primary: { used_percent: 40, window_seconds: 0 } },
  ] } }), 'codex').data.limits, []);
  assert.deepEqual(normalizeUsage(base('grok', { grok: { used_percent: 63, period: 'weekly', resets_at_ms: null, prepaid_cents: 1250, on_demand_used_cents: 300, on_demand_cap_cents: 10000 } }), 'grok').data,
    { allowance: { usedPercent: 63, period: 'weekly', resetsAt: null }, prepaidCents: 1250, onDemandCents: 300, onDemandCapCents: 10000 });
  assert.throws(() => normalizeUsage(base('grok'), 'codex'), /Invalid usage/);
});

test('explicit refresh is deduplicated per provider, cached briefly, and never leaks failed diagnostics', async () => {
  const calls = []; let clock = 100000; let fail = false;
  const fx = async (args, env) => {
    calls.push({ args, env });
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (fail) throw Object.assign(new Error('token=TOP_SECRET'), { stderr: 'private diagnostic' });
    return JSON.stringify(base(env.FX_PROVIDER === 'codex' ? 'chatgpt' : 'ai_gateway', env.FX_PROVIDER === 'codex' ? { codex: { limits: [] } } : { totals: { spend: 4 } }));
  };
  const usage = createUsage({ fx, now: () => clock });
  const [a, b, c] = await Promise.all([usage.refresh('gateway'), usage.refresh('gateway'), usage.refresh('codex')]);
  assert.deepEqual(a, b);
  assert.equal(c.status, 'ready');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { args: ['usage', '--period', 'today', '--json'], env: { FX_PROVIDER: 'gateway' } });
  assert.deepEqual(await usage.refresh('gateway'), a);
  assert.equal(calls.length, 2);
  clock += 61000; fail = true;
  const stale = await usage.refresh('gateway');
  assert.deepEqual(stale, { ...a, status: 'stale' });
  assert.doesNotMatch(JSON.stringify(stale), /TOP_SECRET|private diagnostic/);
  assert.equal((await usage.refresh('my-local')).status, 'unsupported');
  assert.equal(calls.length, 3);
  assert.deepEqual(await createUsage({ fx }).refresh('grok'), { status: 'unavailable' });
});

test('rejects malformed or failed CLI reports without fabricating amounts', async () => {
  const usage = createUsage({ fx: async () => JSON.stringify(base('chatgpt', { status: 'failed', reason: 'token=SECRET', codex: { limits: [] } })) });
  assert.deepEqual(await usage.refresh('codex'), { status: 'unavailable' });
});
