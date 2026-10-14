import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSearchIndex } from '../search.mjs';

test('global search indexes names and messages, never tool content, and refreshes changed sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fox-search-'));
  try {
    const dir = join(root, 'abcd');
    await mkdir(dir);
    await writeFile(join(dir, 'session.json'), JSON.stringify({ title: 'Original', updated_at_ms: 100 }));
    const events = join(dir, 'events.jsonl');
    const record = (event) => JSON.stringify({ event }) + '\n';
    await writeFile(events, record({ user: { text: 'Find the widget' } }) + record({ tool_call: { arguments_json: 'secretneedle' } }) + record({ assistant: { text: 'Widget is ready' } }) + record({ tool_result: { preview: 'secretneedle' } }));
    const state = { names: {} };
    const search = createSearchIndex(root, async () => state);
    assert.deepEqual((await search('Original')).map((h) => h.kind), ['name']);
    assert.deepEqual((await search('widget')).map((h) => [h.kind, h.messageIndex]), [['user', 0], ['assistant', 1]]);
    assert.deepEqual(await search('secretneedle'), []);
    state.names.abcd = 'Custom name';
    assert.equal((await search('Custom name'))[0].kind, 'name');
    await appendFile(events, record({ assistant: { text: 'New answer with starlight' } }));
    assert.equal((await search('starlight'))[0].messageIndex, 2);
    const childDir = join(root, 'child');
    await mkdir(join(childDir, 'subagent'), { recursive: true });
    await mkdir(join(dir, 'subagent'));
    await writeFile(join(childDir, 'session.json'), JSON.stringify({ title: 'Child', updated_at_ms: 90 }));
    await writeFile(join(childDir, 'subagent', 'owner.json'), JSON.stringify({ parent_id: 'abcd' }));
    const childrenPath = join(dir, 'subagent', 'children.json');
    await writeFile(childrenPath, JSON.stringify({ children: [{ id: 'child', persistent: { agent: 'Reviewer' } }] }));
    assert.equal((await search('Reviewer'))[0].id, 'child');
    await writeFile(childrenPath, JSON.stringify({ children: [{ id: 'child', persistent: { agent: 'Critic' } }] }));
    assert.equal((await search('Critic'))[0].id, 'child');
    await rm(childDir, { recursive: true });
    await rm(dir, { recursive: true });
    assert.deepEqual(await search('widget'), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
