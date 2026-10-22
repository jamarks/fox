import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { readMetrics } from '../metrics.mjs';

const DAY = 86_400_000;
const now = 100 * DAY;

test('metrics compare exact adjacent rolling windows using event times, including older and child sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fox-metrics-'));
  try {
    const session = async (id, created, events, extra = {}) => {
      const dir = join(root, id);
      await mkdir(dir);
      await writeFile(join(dir, 'session.json'), JSON.stringify({ created_at_ms: created, ...extra }));
      if (events) await writeFile(join(dir, 'events.jsonl'), events.map(([timestamp_ms, event]) => JSON.stringify({ timestamp_ms, event })).join('\n') + '\n{partial');
    };
    await session('old', DAY, [[93 * DAY, { user: {} }], [86 * DAY, { turn_completed: {} }], [now, { user: {} }], [now + DAY, { user: {} }], [85 * DAY, { user: {} }], [null, { user: {} }]]);
    await session('child', 93 * DAY, [[99 * DAY, { turn_completed: {} }]], { subagent_child: true });
    await session('previous', 86 * DAY);
    await session('thirty', 70 * DAY, [[70 * DAY, { user: {} }], [40 * DAY, { user: {} }]]);
    await mkdir(join(root, 'broken'));
    await writeFile(join(root, 'broken', 'session.json'), 'broken');
    await writeFile(join(root, 'not-a-session'), 'ignored');
    const week = await readMetrics(root, 7, now);
    assert.deepEqual(week.current, { sessions: 1, prompts: 1, completed: 1 });
    assert.deepEqual(week.previous, { sessions: 1, prompts: 0, completed: 1 });
    assert.equal(week.start, 93 * DAY);
    assert.equal(week.previousStart, 86 * DAY);
    const month = await readMetrics(root, 30, now);
    assert.deepEqual(month.current, { sessions: 3, prompts: 3, completed: 2 });
    assert.deepEqual(month.previous, { sessions: 0, prompts: 1, completed: 0 });
    assert.deepEqual((await readMetrics(join(root, 'missing'), 7, now)).current, { sessions: 0, prompts: 0, completed: 0 });
    await assert.rejects(readMetrics(root, 14, now), RangeError);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('metrics UI switches periods, handles zero baselines and shows fetch failures', async () => {
  const element = () => ({ textContent: '', children: [], append(child) { this.children.push(child); }, replaceChildren() { this.children = []; }, setAttribute(key, value) { this[key] = value; }, addEventListener(_, handler) { this.click = handler; } });
  const nodes = Object.fromEntries(['#metrics-status', '.metrics-table-wrap', '#metrics-range', '#metrics-rows', '#metrics-agents-wrap', '#metrics-agents'].map((key) => [key, element()]));
  const buttons = [7, 30].map((days) => ({ ...element(), dataset: { days: String(days) } }));
  let fail = false;
  const urls = [];
  const context = vm.createContext({ document: { querySelector: (key) => nodes[key], querySelectorAll: () => buttons, createElement: element }, fetch: async (url) => {
    urls.push(url);
    return { ok: !fail, json: async () => ({ start: 93 * DAY, end: now, previousStart: 86 * DAY, current: { sessions: 2, prompts: 0, completed: 1 }, previous: { sessions: 0, prompts: 0, completed: 2 } }) };
  } });
  vm.runInContext(await readFile(new URL('../public/metrics.js', import.meta.url), 'utf8'), context);
  await new Promise(setImmediate);
  assert.equal(nodes['#metrics-rows'].children[0].children[3].textContent, 'New');
  assert.equal(nodes['#metrics-rows'].children[1].children[3].textContent, '0%');
  assert.equal(nodes['#metrics-rows'].children[2].children[3].textContent, '-50.0%');
  await buttons[1].click();
  assert.equal(urls.at(-1), '/api/metrics?days=30');
  assert.equal(buttons[1]['aria-pressed'], 'true');
  fail = true;
  await buttons[0].click();
  assert.equal(nodes['.metrics-table-wrap'].hidden, true);
  assert.equal(nodes['#metrics-agents-wrap'].hidden, true); // one agent: no per-agent table
  assert.match(nodes['#metrics-status'].textContent, /Could not load/);
});

test('other agents add to the totals and get their own line', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fox-metrics-agents-'));
  try {
    await mkdir(join(root, 'fx1'));
    await writeFile(join(root, 'fx1', 'session.json'), JSON.stringify({ created_at_ms: 99 * DAY }));
    const claude = { agent: 'Claude Code', createdAt: 98 * DAY, events: [{ kind: 'user', ts: 98 * DAY }, { kind: 'assistant', ts: 98 * DAY }, { kind: 'turn_completed', ts: 98 * DAY }, { kind: 'user', ts: 90 * DAY }] };
    const week = await readMetrics(root, 7, now, [claude]);
    assert.deepEqual(week.current, { sessions: 2, prompts: 1, completed: 1 });
    assert.deepEqual(week.previous, { sessions: 0, prompts: 1, completed: 0 });
    assert.deepEqual(week.byAgent, [
      { agent: 'fx', current: { sessions: 1, prompts: 0, completed: 0 }, previous: { sessions: 0, prompts: 0, completed: 0 } },
      { agent: 'Claude Code', current: { sessions: 1, prompts: 1, completed: 1 }, previous: { sessions: 0, prompts: 1, completed: 0 } },
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
