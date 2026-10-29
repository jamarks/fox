import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const markdown = await readFile(new URL('../public/markdown.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
const mosaic = app.slice(app.indexOf('let mosaicCapture = 0;'), app.indexOf('\nfunction setMosaic('));

test('mosaic renders count-based tiles and formatted, escaped last replies', () => {
  const choices = { innerHTML: '' };
  const tiles = { dataset: {}, innerHTML: '', querySelectorAll: () => [] };
  const sessions = Array.from({ length: 4 }, (_, i) => ({
    id: `s${i}`, terminal: null, archived: false, state: 'ready', title: `Session ${i}`,
    workspace: '/home/fox/workspaces/fox', model: 'openai/gpt-5',
    latestReply: { text: '**Done** [details](https://example.com) <script>alert(1)</script>' },
  }));
  const state = { mosaic: true, mosaicIds: [], sessions };
  const context = {
    state, $: (sel) => ({ '#mosaic-choices': choices, '#mosaic-tiles': tiles })[sel],
    localStorage: { setItem: () => {} },
    esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    displayTitle: (s) => s.title, shortPath: (s) => s, modelShort: (s) => s,
    STATE_LABEL: { ready: 'waiting' }, sessionById: (id) => sessions.find((s) => s.id === id),
  };
  runInNewContext(`${app.slice(app.indexOf('const displayedModel ='), app.indexOf('const STATE_LABEL'))}\n${markdown}\n${mosaic}\nthis.render = renderMosaic`, context);
  for (const count of [0, 1, 2, 3, 4]) {
    state.mosaicIds = sessions.slice(0, count).map((s) => s.id);
    context.render();
    assert.equal(tiles.dataset.count, String(count));
    assert.equal((tiles.innerHTML.match(/class="mosaic-tile"/g) ?? []).length, count);
  }
  assert.match(tiles.innerHTML, /<strong>Done<\/strong>/);
  assert.match(tiles.innerHTML, /<a href="https:\/\/example.com" target="_blank" rel="noopener">details<\/a>/);
  assert.match(tiles.innerHTML, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(tiles.innerHTML, /<script>|\*\*Done\*\*/);
  assert.match(choices.innerHTML, /Watch · 4\/4/);
});

test('waking a watched session resumes it once without opening a tab', async () => {
  const wake = app.slice(app.indexOf('const mosaicWakes = new Map();'), app.indexOf('function updateMosaicScreen('));
  const session = { id: 'sleeping', workspace: '/workspace' };
  const requests = [];
  let resolvePost;
  const context = {
    state: { mosaicIds: [session.id] },
    post: (path, body) => { requests.push({ path, body }); return new Promise((resolve) => { resolvePost = resolve; }); },
    refresh: () => { context.refreshed = true; },
    renderMosaic: () => { context.rendered = true; },
  };
  runInNewContext(`${wake}\nthis.wake = wakeMosaicSession`, context);
  context.wake(session);
  context.wake(session); // overview polling while the first resume is still running
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/api/terminals');
  assert.equal(requests[0].body.resume, session.id);
  assert.equal(requests[0].body.cwd, session.workspace);
  resolvePost({ name: 'fx-sleeping' });
  await new Promise(setImmediate);
  assert.equal(context.refreshed, true);
  assert.equal(context.rendered, undefined);
});

test('mosaic layout fills 1 and 2 slots and spans the third tile without a hole', () => {
  assert.match(css, /#mosaic-tiles\[data-count="1"\] \{ grid-template-columns: minmax\(0, 1fr\); grid-template-rows: minmax\(0, 1fr\); \}/);
  assert.match(css, /#mosaic-tiles\[data-count="2"\] \{ grid-template-rows: minmax\(0, 1fr\); \}/);
  assert.match(css, /#mosaic-tiles\[data-count="3"\] \.mosaic-tile:last-child \{ grid-column: 1 \/ -1; \}/);
});
