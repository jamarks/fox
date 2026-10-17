import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRuns, scheduleError, describeSchedule, zonedToUtc } from '../schedule.mjs';

const tz = 'Europe/Berlin';
const iso = (ms) => new Date(ms).toISOString();
const at = (s) => Date.parse(s);

test('every 2 hours inside a weekday window, in local time', () => {
  const s = { kind: 'hours', every: 2, days: [1, 2, 3, 4, 5], from: '09:00', to: '19:00' };
  // Friday 2026-10-16 14:30 Berlin (CEST, UTC+2) = 12:30 UTC
  const runs = nextRuns(s, tz, at('2026-10-16T12:30:00Z'), 5).map(iso);
  assert.deepEqual(runs, [
    '2026-10-16T13:00:00.000Z', // 15:00 local
    '2026-10-16T15:00:00.000Z', // 17:00
    '2026-10-16T17:00:00.000Z', // 19:00, the end of the window counts
    '2026-10-19T07:00:00.000Z', // Monday 09:00, skipping the weekend
    '2026-10-19T09:00:00.000Z',
  ]);
});

test('local times hold across the daylight saving change', () => {
  const s = { kind: 'daily', at: '08:00' };
  // Berlin leaves summer time on Sunday 2026-10-25: 08:00 is 06:00 UTC before and 07:00 UTC after.
  const runs = nextRuns(s, tz, at('2026-10-24T00:00:00Z'), 3).map(iso);
  assert.deepEqual(runs, ['2026-10-24T06:00:00.000Z', '2026-10-25T07:00:00.000Z', '2026-10-26T07:00:00.000Z']);
});

test('a time skipped by spring-forward moves to the next valid minute, a repeated one runs once', () => {
  // Berlin jumps from 02:00 to 03:00 on 2027-03-28.
  assert.equal(iso(zonedToUtc(2027, 3, 28, 2, 30, tz)), '2027-03-28T01:30:00.000Z'); // 03:30 local
  // 02:30 happens twice on 2026-10-25; the first one (still CEST) is chosen.
  assert.equal(iso(zonedToUtc(2026, 10, 25, 2, 30, tz)), '2026-10-25T00:30:00.000Z');
  const runs = nextRuns({ kind: 'daily', at: '02:30' }, tz, at('2026-10-24T12:00:00Z'), 2).map(iso);
  assert.deepEqual(runs, ['2026-10-25T00:30:00.000Z', '2026-10-26T01:30:00.000Z']);
});

test('weekly is daily on some days; once runs a single time', () => {
  const weekly = { kind: 'daily', at: '10:00', days: [1, 4] };
  assert.deepEqual(nextRuns(weekly, tz, at('2026-10-17T00:00:00Z'), 2).map(iso), ['2026-10-19T08:00:00.000Z', '2026-10-22T08:00:00.000Z']);
  const once = { kind: 'once', date: '2026-10-20', at: '10:00' };
  assert.deepEqual(nextRuns(once, tz, at('2026-10-17T00:00:00Z'), 3).map(iso), ['2026-10-20T08:00:00.000Z']);
  assert.deepEqual(nextRuns(once, tz, at('2026-10-21T00:00:00Z'), 3), []);
});

test('bad schedules are explained, never run', () => {
  assert.match(scheduleError({ kind: 'hours', every: 0, from: '09:00', to: '19:00' }, tz), /Every/);
  assert.match(scheduleError({ kind: 'hours', every: 2, from: '19:00', to: '09:00' }, tz), /end after/);
  assert.match(scheduleError({ kind: 'daily', at: '8am' }, tz), /HH:MM/);
  assert.match(scheduleError({ kind: 'daily', at: '08:00', days: [] }, tz), /day/);
  assert.match(scheduleError({ kind: 'daily', at: '08:00' }, 'Mars/Olympus'), /time zone/);
  assert.match(scheduleError({ kind: 'cron', expr: '* * * * *' }, tz), /Unknown/);
  assert.deepEqual(nextRuns({ kind: 'daily', at: 'x' }, tz, Date.now(), 3), []);
});

test('schedules read in plain words', () => {
  assert.equal(describeSchedule({ kind: 'hours', every: 2, days: [1, 2, 3, 4, 5], from: '09:00', to: '19:00' }), 'every 2 h · Mon–Fri 09:00–19:00');
  assert.equal(describeSchedule({ kind: 'daily', at: '08:00' }), 'daily 08:00');
  assert.equal(describeSchedule({ kind: 'daily', at: '10:00', days: [1, 4] }), 'Mon, Thu 10:00');
  assert.equal(describeSchedule({ kind: 'once', date: '2026-10-20', at: '10:00' }), 'once 2026-10-20 10:00');
});
