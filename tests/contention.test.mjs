import test from 'node:test';
import assert from 'node:assert/strict';
import { latestWrites, intersectWrites } from '../contention.mjs';

const canon = (cwd, path) => `${cwd}/${path}`;
const call = (name, path, ts, status = 'success') => ({ kind: 'tool_call', name, args: { path }, ts, result: { status } });
test('only file-tool writes in unfinished or latest completed turn; never reads, mentions or failures', () => {
  const events = [call('write_file', 'old', 1), { kind: 'turn_completed' },
    { kind: 'user' }, call('read_file', 'a', 2), call('shell', 'b', 3), call('edit_file', 'bad', 4, 'failure'),
    call('edit_file', 'a', 5), { kind: 'turn_completed' }];
  assert.deepEqual(latestWrites(events, '/repo', canon), [{ path: '/repo/a', eventIndex: 6 }]);
  assert.deepEqual(latestWrites([...events, { kind: 'user' }, call('write_file', 'new', 6)], '/repo', canon), [{ path: '/repo/new', eventIndex: 9 }]);
  // Long-lived sessions must not exhaust the argument stack when locating the last turn.
  const long = Array.from({ length: 150_000 }, () => ({ kind: 'assistant' }));
  long.push({ kind: 'turn_completed' }, call('write_file', 'recent', 7));
  assert.deepEqual(latestWrites(long, '/repo', canon), [{ path: '/repo/recent', eventIndex: 150_001 }]);
});
test('same parent and child are one actor; distinct roots only overlap on exact paths', () => {
  const writes = (path) => [{ path, ts: 10 }];
  const members = [
    { id: 'parent', writes: writes('/tree/a') }, { id: 'kid', parentId: 'parent', writes: writes('/tree/a') },
    { id: 'other', writes: writes('/tree/a') }, { id: 'third', writes: writes('/tree/a-more') },
  ];
  assert.deepEqual(intersectWrites(members.slice(0, 2), 'parent'), {});
  assert.deepEqual(intersectWrites(members, 'parent')['/tree/a'], [{ path: '/tree/a', ts: 10, id: 'other', actor: 'other' }]);
  assert.equal(intersectWrites(members, 'parent')['/tree/a-more'], undefined);
});
