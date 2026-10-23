import test from 'node:test';
import assert from 'node:assert/strict';
import { familyUsage } from '../family-usage.mjs';

const parent = { id: 'parent', children: [{ id: 'child' }, { id: 'child' }, { id: 'missing' }] };
const row = (id, usage, rest = {}) => ({ id, model: 'model/' + id, usage, ...rest });
const saved = (input, output, cacheRead, savedAt = 1000) => ({ input, output, cacheRead, savedAt });

test('family totals count each session snapshot once and shares have a usable denominator', () => {
  const byId = new Map([
    ['parent', row('parent', saved(10, 20, 70))],
    ['child', row('child', saved(5, 5, 10))],
  ]);
  assert.deepEqual(familyUsage(parent, byId), {
    tokens: 120, missing: 1,
    rows: [
      { id: 'parent', model: 'model/parent', input: 10, output: 20, cacheRead: 70, tokens: 100, savedAt: 1000, pending: false },
      { id: 'child', model: 'model/child', input: 5, output: 5, cacheRead: 10, tokens: 20, savedAt: 1000, pending: false },
    ],
  });
});

test('missing and invalid snapshots never masquerade as zero usage', () => {
  assert.equal(familyUsage(parent, new Map([['parent', row('parent', { input: 0 })]])), null);
  const result = familyUsage(parent, new Map([['parent', row('parent', saved(-5, NaN, 0))]]));
  assert.equal(result.tokens, 0);
  assert.equal(result.missing, 2);
});

test('older snapshots and working sessions are marked as potentially lagging', () => {
  const result = familyUsage(parent, new Map([
    ['parent', row('parent', saved(10, 0, 0), { updatedAt: 62_001 })],
    ['child', row('child', saved(1, 0, 0), { state: 'working' })],
  ]));
  assert.deepEqual(result.rows.map((r) => r.pending), [true, true]);
  assert.equal(familyUsage({ id: 'parent', children: [] }, new Map([['parent', row('parent', saved(1, 0, 0), { updatedAt: 61_000 })]])).rows[0].pending, false);
});
