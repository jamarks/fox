import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the browser's real board, draft handlers and paste path without a terminal or model.
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const section = (from, to) => {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
};
function fixture({ name = 'reviewer', working = false, phase = 'done' } = {}) {
  const handlers = {}, elements = {};
  const $ = (selector) => elements[selector] ??= {
    value: '', textContent: '', disabled: false, focus() {}, setSelectionRange() {},
    classList: { values: new Set(['hidden']), add(v) { this.values.add(v); }, remove(v) { this.values.delete(v); }, contains(v) { return this.values.has(v); } },
    addEventListener(type, handler) { handlers[`${selector}:${type}`] = handler; },
  };
  const child = { id: 'child-a', name, phase, task: 'Review the parser' };
  const parent = { id: 'parent-a', title: 'Parser', state: working ? 'working' : 'ready', terminal: 'term-a', children: [child] };
  const other = { id: 'parent-b', title: 'Other', terminal: 'term-b', children: [{ id: 'child-b', name }] };
  const pasted = [], opened = [], messages = [];
  const tab = (id) => ({ ws: { readyState: 1 }, term: { paste: (text) => pasted.push({ id, text }), focus() {} } });
  const state = { sessions: [parent, other], selected: 'child-b', terminals: [{ name: 'term-a', resume: parent.id }, { name: 'term-b', resume: other.id }], tabs: new Map([['term-a', tab('term-a')], ['term-b', tab('term-b')]]), activeTab: 'term-b' };
  const answer = { contains: (node) => node === ctx.selection.focusNode };
  const row = { contains: (node) => node === answer };
  const button = { dataset: { agentParent: parent.id, agentFollowup: child.id, agentName: name }, closest: () => row };
  const ctx = {
    state, $, WebSocket: { OPEN: 1 }, navigator: {}, toast: (s) => messages.push(s),
    sessionById: (id) => state.sessions.find((s) => s.id === id), displayTitle: (s) => s.title,
    esc: (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    refresh: async () => {}, openSession: async (id) => { opened.push(id); state.activeTab = state.sessions.find((s) => s.id === id)?.terminal; },
    getSelection: () => ctx.selection, selection: { rangeCount: 0, toString: () => '' },
    localStorage: { getItem() {} }, norm: String, vendorOf: () => null, modelShort: String, ICON: { threads: '' },
    cachedResults: { id: parent.id, byAgent: new Map([[name, [{ message: 'Initial review', text: 'First answer' }, { message: 'Check again', text: 'Second answer' }]]]), assigned: new Map() },
    parent, child, button,
  };
  vm.createContext(ctx);
  vm.runInContext(section('function pasteIntoTerminal(', 'async function openTerminal(')
    + section('function answerFor(', 'const convoShown = new Set();'), ctx);
  const run = (code) => vm.runInContext(code, ctx);
  const open = () => run('openAgentDraft(button)');
  const insert = () => run('insertAgentDraft()');
  return { ctx, run, open, insert, $, elements, handlers, parent, child, state, pasted, opened, messages, answer };
}

test('only expanded named rows get one follow-up; all rounds remain visible, including while running', () => {
  for (const phase of ['running', 'done']) {
    const f = fixture({ name: 'reviewer"<&', phase });
    f.parent.children.push({ id: 'one-off', phase });
    assert.doesNotMatch(f.run('agentsBoard(parent)'), /data-agent-followup/);
    f.run('expandedAgents.add("child-a"); expandedAgents.add("one-off")');
    const html = f.run('agentsBoard(parent, { selectedId: "child-a" })');
    assert.equal((html.match(/data-agent-followup=/g) ?? []).length, 1);
    assert.match(html, /data-agent-parent="parent-a"/);
    assert.match(html, /data-agent-name="reviewer&quot;&lt;&amp;"/);
    assert.match(html, /round 1.*First answer.*round 2.*Second answer/s);
    assert.doesNotMatch(html, /data-agent-followup="one-off"/);
  }
});

test('child rows never borrow the parent live model and a running child without evidence is unknown', () => {
  const f = fixture({ working: true, phase: 'running' });
  f.parent.activeModel = 'parent-live';
  assert.match(f.run('agentsBoard(parent)'), /model unknown/);
  assert.doesNotMatch(f.run('agentsBoard(parent)'), /parent-live|failed to start/);
  f.state.sessions.push({ id: f.child.id, model: 'child-saved', usage: {} });
  assert.match(f.run('agentsBoard(parent)'), /child-saved/);
  assert.doesNotMatch(f.run('agentsBoard(parent)'), /parent-live/);
});

test('board shows saved family usage as a compact expandable estimate only when available', () => {
  const f = fixture();
  assert.doesNotMatch(f.run('agentsBoard(parent)'), /family-usage/);
  f.ctx.fmtTokens = (n) => String(n);
  f.parent.familyUsage = { tokens: 120, missing: 1, rows: [
    { id: f.parent.id, model: 'vendor/parent', tokens: 100, pending: false },
    { id: f.child.id, model: 'vendor/child', tokens: 20, pending: true },
  ] };
  const html = f.run('agentsBoard(parent)');
  assert.match(html, /local partial estimate · 120 tokens/);
  assert.match(html, /shares of saved total/);
  assert.match(html, /parent · vendor\/parent.*100 · 83%/s);
  assert.match(html, /child 1 · vendor\/child.*20 · 17% · saved/s);
  assert.match(html, /1 without snapshot/);
  assert.match(html, /Not provider spend or remaining quota/);
  f.parent.familyUsage.missing = 0;
  assert.match(f.run('agentsBoard(parent)'), /local estimate · 120 tokens/);
});

test('draft keeps the exact escaped name and only an excerpt from this row’s answer', () => {
  const f = fixture({ name: 'reviewer"<&' });
  f.ctx.selection = { rangeCount: 1, anchorNode: { parentElement: { closest: () => f.answer } }, focusNode: {}, toString: () => 'check <parser>\nagain' };
  f.open();
  assert.equal(f.$('#paste-text').value, 'Tell "reviewer\\"<&": Regarding “check <parser>\nagain”, ');
  f.ctx.selection.anchorNode = { nodeType: 1, closest: () => f.answer };
  f.open();
  assert.match(f.$('#paste-text').value, /check <parser>/, 'selecting an entire answer element keeps its excerpt');
  f.ctx.selection.anchorNode = { parentElement: { closest: () => null } };
  f.open();
  assert.equal(f.$('#paste-text').value, 'Tell "reviewer\\"<&": ');
});

test('working parent is Steer; idle parent is Follow up regardless of child phase', () => {
  for (const phase of ['running', 'done']) {
    const f = fixture({ phase }); f.open();
    assert.equal(f.$('#paste-title').textContent, 'Follow up');
    f.parent.state = 'working'; f.open();
    assert.equal(f.$('#paste-title').textContent, 'Steer');
    assert.match(f.$('#paste-hint').textContent, /after the current tool/);
  }
});

test('refresh and focus the exact parent, never the same-named agent in another session; zero Enter/control bytes', async () => {
  const f = fixture({ working: true, phase: 'running' }); f.open();
  f.$('#paste-text').value += 'fix this\r\nthen test\x1b\x03\t\u0085';
  let refreshed = false;
  f.ctx.refresh = async () => { refreshed = true; f.state.selected = 'child-b'; };
  await f.insert();
  assert.equal(refreshed, true);
  assert.deepEqual(f.opened, ['parent-a']);
  assert.equal(f.pasted.length, 1);
  assert.equal(f.pasted[0].id, 'term-a');
  assert.match(f.pasted[0].text, /Tell reviewer: fix this/);
  assert.doesNotMatch(f.pasted[0].text, /[\x00-\x1f\x7f-\x9f]/);
  assert.equal(f.$('#pastesheet').classList.contains('hidden'), true);
});

test('missing, archived, renamed or reparented target retains the edited draft without opening anything', async () => {
  const mutations = [
    (f) => { f.state.sessions = f.state.sessions.filter((s) => s.id !== f.parent.id); },
    (f) => { f.parent.archived = true; },
    (f) => { f.parent.state = 'external'; },
    (f) => { f.child.name = 'different'; },
    (f) => { f.parent.children = []; },
    (f) => { f.parent.parentId = 'another'; },
  ];
  for (const mutate of mutations) {
    const f = fixture(); f.open(); f.$('#paste-text').value += 'keep this';
    f.ctx.refresh = async () => mutate(f);
    await f.insert();
    assert.deepEqual(f.opened, []); assert.deepEqual(f.pasted, []);
    assert.equal(f.$('#paste-text').value, 'Tell reviewer: keep this');
    assert.equal(f.$('#pastesheet').classList.contains('hidden'), false);
    assert.match(f.$('#paste-hint').textContent, /unavailable/);
  }
});

test('sleep requires explicit resume and keeps the draft until a ready parent terminal exists', async () => {
  const f = fixture(); f.parent.terminal = null; f.state.terminals.shift(); f.open();
  assert.equal(f.$('#pasteform button[type="submit"]').textContent, 'Resume parent');
  f.ctx.openSession = async (id) => {
    f.opened.push(id); f.parent.terminal = 'term-a';
    f.state.terminals.push({ name: 'term-a', resume: id }); f.state.activeTab = 'term-a';
  };
  await f.insert();
  assert.deepEqual(f.opened, ['parent-a']); assert.deepEqual(f.pasted, []);
  assert.equal(f.$('#paste-text').value, 'Tell reviewer: ');
  await f.insert();
  assert.equal(f.pasted.length, 1);
});

test('parent sleeping after draft opened requires a separate resume confirmation', async () => {
  const f = fixture(); f.open();
  f.ctx.refresh = async () => { f.parent.terminal = null; f.state.terminals = []; };
  await f.insert();
  assert.deepEqual(f.opened, []); assert.deepEqual(f.pasted, []);
  assert.equal(f.$('#pasteform button[type="submit"]').textContent, 'Resume parent');
});

test('late target disappearance, wrong active tab, disconnected terminal and waking parent never receive input', async () => {
  const mutations = [
    (f) => { f.state.sessions = []; },
    (f) => { f.state.activeTab = 'term-b'; },
    (f) => { f.state.tabs.get('term-a').ws.readyState = 0; },
    (f) => { f.state.tabs.get('term-a').closed = true; },
    (f) => { f.state.waking = { id: 'parent-a' }; },
    (f) => { f.state.terminals[0].resume = 'parent-b'; },
  ];
  for (const mutate of mutations) {
    const f = fixture(); f.open();
    f.ctx.openSession = async () => { f.state.activeTab = 'term-a'; mutate(f); };
    await f.insert();
    assert.deepEqual(f.pasted, []);
    assert.equal(f.$('#paste-text').value, 'Tell reviewer: ');
  }
});

test('refresh failure and cancellation during refresh do not insert', async () => {
  const f = fixture(); f.open();
  f.ctx.refresh = async () => { throw new Error('offline'); };
  await f.insert();
  assert.deepEqual(f.pasted, []); assert.match(f.$('#paste-hint').textContent, /Could not/);
  assert.equal(f.$('#pasteform button[type="submit"]').disabled, false);
  f.ctx.refresh = async () => f.run('closePasteSheet()');
  await f.insert();
  assert.deepEqual(f.opened, []); assert.deepEqual(f.pasted, []);
});

test('follow-up click is routed before row collapsing and the paste sheet remains a plain paste otherwise', () => {
  const f = fixture();
  const click = section("$('#transcript').addEventListener('click'", '// ---------- global search ----------');
  assert.ok(click.indexOf('openAgentDraft(followup)') < click.indexOf("e.target.closest('[data-agent]')"));
  vm.runInContext(click, f.ctx);
  f.handlers['#transcript:click']({ preventDefault() {}, target: { closest: (selector) => selector === '[data-agent-followup]' ? f.ctx.button : null } });
  assert.equal(f.$('#paste-text').value, 'Tell reviewer: ');
  f.run('closePasteSheet()');
  assert.equal(f.$('#paste-title').textContent, 'Paste');
  f.$('#paste-text').value = 'ordinary paste';
  f.handlers['#pasteform:submit']({ preventDefault() {} });
  assert.deepEqual(f.pasted, [{ id: 'term-b', text: 'ordinary paste' }]);
});
