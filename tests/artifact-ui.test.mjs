import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function artifactMatches(');
const end = source.indexOf('function showArtifactMatch(', start);

test('the full-output viewer finds each case-insensitive occurrence without overlapping matches', () => {
  assert.ok(start !== -1 && end > start);
  const find = vm.runInNewContext(source.slice(start, end) + '\nartifactMatches');
  assert.deepEqual(Array.from(find('error ERROR error', 'err')), [0, 6, 12]);
  assert.deepEqual(Array.from(find('aaaa', 'aa')), [0, 2]);
  assert.deepEqual(Array.from(find('output', '')), []);
  assert.deepEqual(Array.from(find('output', 'absent')), []);
});
