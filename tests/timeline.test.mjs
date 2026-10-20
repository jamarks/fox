import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTimeline, turnTimeline } from '../timeline.mjs';

const event = (ts, kind, body = {}) => JSON.stringify({ timestamp_ms: ts, event: { [kind]: body } });

test('timeline preserves tool result timestamps and overlapping child lanes', () => {
  const parent = parseTimeline([
    event(1000, 'user'), event(2000, 'tool_call', { call_id: 'a', tool_name: 'subagent' }),
    event(7000, 'tool_result', { call_id: 'a' }), event(8000, 'turn_completed'),
  ].join('\n'));
  const child = parseTimeline([
    event(2500, 'user'), event(3000, 'tool_call', { call_id: 'b', tool_name: 'shell' }),
    event(6000, 'tool_result', { call_id: 'b' }), event(6500, 'turn_completed'),
  ].join('\n'));
  const t = turnTimeline(parent, [{ id: 'child-one', phase: 'finished', events: child }], 9000);
  assert.equal(t.elapsed, 7000);
  assert.deepEqual(t.lanes[0].intervals.map((x) => x.kind), ['agent', 'handoff', 'agent']);
  assert.equal(t.lanes[0].intervals[1].end, 7000);
  assert.equal(t.lanes[1].intervals[1].kind, 'tool');
  assert.deepEqual(t.chain.map((x) => x.label), ['parent', 'agent 1', 'parent']);
});

test('unflushed live turn uses children phase, never extends the last saved turn', () => {
  const parent = parseTimeline([event(1000, 'user'), event(2000, 'turn_completed')].join('\n'));
  const t = turnTimeline(parent, [{ id: 'child-one', phase: 'running', startedAt: 5000, events: [] }], 9000, true);
  assert.equal(t.start, 5000);
  assert.equal(t.pending, true);
  assert.equal(t.lanes[0].intervals.length, 0);
  assert.equal(t.lanes[1].intervals[0].provisional, true);
  assert.equal(turnTimeline(parent, [], 9000, true).lanes.length, 0);
});

test('parallel tools overlap without inventing parent time or doubling the path', () => {
  const events = parseTimeline([
    event(1000, 'user'), event(2000, 'tool_call', { call_id: 'a', tool_name: 'shell' }),
    event(3000, 'tool_call', { call_id: 'b', tool_name: 'read_file' }),
    event(5000, 'tool_result', { call_id: 'a' }), event(6000, 'tool_result', { call_id: 'b' }),
    event(7000, 'turn_completed'),
  ].join('\n'));
  const t = turnTimeline(events);
  assert.deepEqual(t.lanes[0].intervals.map((i) => [i.kind, i.start, i.end]), [
    ['agent', 1000, 2000], ['tool', 2000, 5000], ['tool', 3000, 6000], ['agent', 6000, 7000],
  ]);
  assert.equal(t.chain.reduce((n, x) => n + x.ms, 0), 6000);
});

test('turn-end stamped records use child creation and completion without invented parent/tool spans', () => {
  const parent = parseTimeline([event(1000, 'user'), event(1000, 'tool_call', { call_id: 'a', tool_name: 'subagent' }), event(1000, 'turn_completed')].join('\n'));
  const child = parseTimeline([event(800, 'user'), event(800, 'tool_call', { call_id: 'b', tool_name: 'shell' }), event(800, 'turn_completed')].join('\n'));
  const t = turnTimeline(parent, [{ id: 'child-one', phase: 'finished', createdAt: 500, events: child }]);
  assert.equal(t.coarse, true);
  assert.equal(t.elapsed, 500);
  assert.deepEqual(t.lanes[0].intervals, []);
  assert.deepEqual(t.lanes[1].intervals.map((x) => x.kind), ['agent']);
  assert.equal(t.lanes[1].end, 800);
});

test('bounded intervals and corrupt records cannot crowd out recent events', () => {
  const lines = [event(1000, 'user'), '{broken'];
  for (let i = 0; i < 100; i++) lines.push(event(2000 + i * 20, 'tool_call', { call_id: String(i), tool_name: 'shell' }), event(2010 + i * 20, 'tool_result', { call_id: String(i) }));
  lines.push(event(5000, 'turn_completed'));
  const t = turnTimeline(parseTimeline(lines.join('\n')));
  assert.ok(t.lanes[0].intervals.length <= 60);
  assert.equal(t.lanes[0].intervals.at(-1).end, 5000);
});
