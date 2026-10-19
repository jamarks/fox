import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { summarizeEvidence } from '../evidence.mjs';

// These are normalized saved tool-call/result pairs, including a preview truncated before the exit field.
const call = (callId, name, args, result, ts = 0) => ({ kind: 'tool_call', callId, name, args, result, ts });
const shell = (callId, request, value, preview = JSON.stringify(value)) => call(callId, 'shell', { request }, value === null ? null : { status: 'success', preview });

test('same-task models retain distinct recorded executions, not answers or command-name guesses', () => {
  const agents = [
    [shell('a1', { action: 'run', command: 'npm test' }, { state: 'completed', exit_code: 1, duration_ms: 2100 })],
    [shell('b1', { action: 'run', command: 'npm test' }, { state: 'completed', exit_code: 0, duration_ms: 3200 })],
    [shell('c1', { action: 'run', command: 'echo verified' }, { state: 'completed', exit_code: 0 })],
  ].map(summarizeEvidence);
  assert.deepEqual(agents.map((e) => e.commands[0].exit), [1, 0, 0]);
  assert.deepEqual(agents.map((e) => e.counts.failed), [1, 0, 0]);
  assert.ok(agents.every((e) => !('verified' in e)), 'exit zero on an arbitrary command is not verification');
});

test('interact completes the run by handle; missing exits and truncated artifacts remain unknown', () => {
  const events = [
    shell('r', { action: 'run', command: 'node --test' }, { state: 'running', session_id: 'handle-a', duration_ms: 100 }),
    shell('i', { action: 'interact', session_id: 'handle-a' }, { state: 'completed', exit_code: 2, session_id: null, duration_ms: 200 }),
    shell('t', { action: 'run', command: 'npm test' }, { state: 'completed', exit_code: 0 }, '{"state":"completed","exit_code":'),
    shell('p', { action: 'run', command: 'long test' }, { state: 'running', session_id: 'handle-b' }),
    { kind: 'interrupted', reason: 'cancelled' },
    call('e', 'edit_file', { path: 'src/a.mjs' }, { status: 'success' }),
    call('f', 'write_file', { path: 'src/b.mjs' }, { status: 'error' }),
  ];
  const summary = summarizeEvidence(events);
  assert.equal(summary.commands.length, 3);
  assert.deepEqual(summary.commands[0], { command: 'node --test', exit: 2, state: 'failed', elapsedMs: 300, callIds: ['r', 'i'] });
  assert.equal(summary.commands[1].state, 'exit unknown');
  assert.equal(summary.commands[2].state, 'interrupted');
  assert.equal(summarizeEvidence(events.slice(0, 4)).commands[2].state, 'running');
  assert.equal(summary.counts.unknown, 2);
  assert.equal(summary.cancellations, 1);
  assert.deepEqual(summary.files, [{ path: 'src/a.mjs', callId: 'e' }]);
});

test('complete retained JSON establishes exit, generic success or partial output does not', () => {
  const events = [shell('a', { action: 'run', command: 'test' }, { state: 'completed' })];
  events[0].result.detail = '{"state":"completed","exit_code":0}';
  assert.equal(summarizeEvidence(events).commands[0].exit, 0);
  events[0].result.detail = '{"state":"completed","exit_code":';
  assert.equal(summarizeEvidence(events).commands[0].exit, null);
  events[0].result.preview = 'success';
  assert.equal(summarizeEvidence(events).commands[0].state, 'exit unknown');
  assert.equal(summarizeEvidence([shell('x', { action: 'run', command: 'test' }, null)]).commands[0].exit, null);
});

test('board links a child command and retained result; navigation opens the exact tool call', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function evidenceView('), end = source.indexOf('function agentsBoard(', start);
  assert.ok(start > 0 && end > start);
  const ctx = { esc: (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])), fmtDur: (ms) => ms + 'ms', encodeURIComponent };
  vm.createContext(ctx);
  vm.runInContext(source.slice(start, end), ctx);
  const summary = summarizeEvidence([shell('call-1', { action: 'run', command: 'npm test' }, { exit_code: 1 })]);
  summary.commands[0].artifact = 'output.json';
  summary.note = 'Evidence may lag until fx flushes the turn.';
  ctx.summary = summary;
  const html = vm.runInContext('evidenceView("child-a", summary)', ctx);
  assert.match(html, /data-evidence-child="child-a" data-evidence-call="call-1"/);
  assert.match(html, /exit 1/);
  assert.match(html, /sessions\/child-a\/artifact\/output.json/);
  assert.match(html, /may lag/);
  assert.match(source, /target\.open = true; target\.scrollIntoView/);
  assert.match(source, /evidenceOpened\.callId === ev\.callId \? ' open' : ''/, 'polling keeps the selected result expanded');
});
