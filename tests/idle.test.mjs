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

test('candidates come least recently used first', () => {
  const now = 10_000_000_000;
  const at = (minAgo) => Math.floor((now - minAgo * 60_000) / 1000);
  const lines = [`fx-b|0|${at(10)}`, `fx-a|0|${at(50)}`, `fx-c|0|${at(3)}`].join('\n');
  assert.deepEqual(sleepCandidates(lines, { now, idleMs: 60_000 }), ['fx-a', 'fx-b', 'fx-c']);
});

test('sleeping is off unless a positive number of minutes is set', () => {
  assert.equal(idleSleepMs(undefined), 0);
  assert.equal(idleSleepMs(''), 0);
  assert.equal(idleSleepMs('0'), 0);
  assert.equal(idleSleepMs('abc'), 0);
  assert.equal(idleSleepMs('30'), 30 * 60_000);
  assert.equal(idleSleepMs('0.5'), 30_000);
});

test('memory is total minus available, as free shows it', async () => {
  const { memoryFromMeminfo } = await import('../idle.mjs');
  const meminfo = 'MemTotal:        3910656 kB\nMemFree:          489000 kB\nMemAvailable:    1990000 kB\nBuffers:           10000 kB\n';
  assert.deepEqual(memoryFromMeminfo(meminfo), { usedMb: 1876, totalMb: 3819, pct: 49 });
  assert.equal(memoryFromMeminfo('nothing here'), null);
});
