import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sleepCandidates, idleSleepMs } from '../idle.mjs';

test('only unattended fx sessions idle long enough are candidates to sleep', () => {
  const now = 10_000_000_000;
  const at = (minAgo) => Math.floor((now - minAgo * 60_000) / 1000);
  const lines = [
    `fx-old|0|${at(45)}`,      // idle 45 min, nobody looking: sleeps
    `fx-watched|1|${at(45)}`,  // open on a screen: never
    `fx-recent|0|${at(5)}`,    // active 5 min ago: not yet
    `keepalive|0|${at(900)}`,  // not an fx session
    `vite-test|0|${at(900)}`,
    'garbage',
  ].join('\n');
  assert.deepEqual(sleepCandidates(lines, { now, idleMs: 30 * 60_000 }), ['fx-old']);
});

test('sleeping is off unless a positive number of minutes is set', () => {
  assert.equal(idleSleepMs(undefined), 0);
  assert.equal(idleSleepMs(''), 0);
  assert.equal(idleSleepMs('0'), 0);
  assert.equal(idleSleepMs('abc'), 0);
  assert.equal(idleSleepMs('30'), 30 * 60_000);
  assert.equal(idleSleepMs('0.5'), 30_000);
});
