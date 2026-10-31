import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { latestCompletedReply, childCompletion, lastAnswerModel } from '../inbox.mjs';

const record = (event, timestamp_ms) => JSON.stringify({ event, timestamp_ms }) + '\n';

test('only completed turns with a visible assistant answer appear', () => {
  const raw = record({ user: { text: 'hello' } }, 1)
    + record({ assistant: { text: '' } }, 2)
    + record({ assistant: { text: 'First answer' } }, 3)
    + record({ turn_completed: {} }, 4)
    + record({ user: { text: 'next' } }, 5)
    + record({ assistant: { text: 'Unfinished' } }, 6);
  assert.deepEqual(latestCompletedReply(raw), { turn: 1, messageIndex: 1, at: 4, text: 'First answer' });
  assert.equal(latestCompletedReply(record({ user: { text: 'hello' } }, 1) + record({ assistant: { text: 'Unfinished' } }, 2)), null);
  assert.deepEqual(latestCompletedReply(raw + record({ assistant: { text: 'New answer' } }, 7) + record({ turn_completed: {} }, 8)), { turn: 2, messageIndex: 4, at: 8, text: 'New answer' });
});

test('a child result uses only a completed turn or a recorded failure, not an unfinished answer', () => {
  const first = record({ user: { text: 'review' } }, 1) + record({ assistant: { text: 'First review' } }, 2) + record({ turn_completed: {} }, 3);
  const child = { turns: 1, latestReply: latestCompletedReply(first), updatedAt: 4 };
  assert.deepEqual(childCompletion(child, { phase: 'finished', outcome: 'completed' }), { ...child.latestReply, marker: 'turn:1', failed: false });
  assert.equal(childCompletion(child, { phase: 'running', outcome: null }), null);
  child.turns = 2;
  assert.equal(childCompletion(child, { phase: 'running', outcome: null, failure: 'old failure' }), null);
  assert.deepEqual(childCompletion(child, { phase: 'idle', outcome: 'failed', failure: { message: 'Timed out' } }),
    { marker: 'failed:2', failed: true, text: 'Timed out', at: 4, messageIndex: null });
  assert.deepEqual(childCompletion(child, { phase: 'finished', outcome: 'cancelled' }),
    { marker: 'failed:2', failed: true, text: 'Subagent cancelled', at: 4, messageIndex: null });
  const unfinished = first + record({ user: { text: 'follow up' } }, 4) + record({ assistant: { text: 'Still writing' } }, 5);
  assert.equal(latestCompletedReply(unfinished).turn, 1);
  assert.equal(childCompletion({ ...child, latestReply: latestCompletedReply(unfinished) }, { phase: 'running' }), null);
  assert.equal(childCompletion({ turns: 1, latestReply: null }, { phase: 'finished', outcome: 'completed' }), null);
});

test('first load baselines history, polling adds unread, selection clears only that reply', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('let inboxSeen = null;');
  const end = source.indexOf('// ---------- sidebar ----------', start);
  const selection = source.slice(source.indexOf('function selectSession(id) {'), source.indexOf('async function renameInline(id) {'));
  assert.ok(start >= 0 && end > start && selection.includes('markReplyRead(id)'));
  const handlers = {};
  const elements = Object.fromEntries(['reply-inbox', 'reply-inbox-list', 'reply-inbox-toggle', 'reply-inbox-clear', 'reply-inbox-count', 'reply-inbox-label'].map((name) => [name, {
    classList: { values: new Set(['hidden']), toggle(key, force) { if (force === undefined ? !this.values.has(key) : force) this.values.add(key); else this.values.delete(key); }, add(key) { this.values.add(key); }, contains(key) { return this.values.has(key); } },
    setAttribute() {}, addEventListener(type, handler) { handlers[`${name}:${type}`] = handler; },
    innerHTML: '', textContent: '',
  }]));
  const storage = new Map();
  const state = { sessions: [{ id: 'abcd', archived: false, parentId: null, workspace: '/repo', title: 'Session' }], selected: null };
  const ctx = { state, $: (selector) => elements[selector.slice(1)], localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    sessionById: (id) => state.sessions.find((s) => s.id === id), ICON: { threads: '↳' }, displayTitle: (s) => s.title, shortPath: (s) => s, fmtTime: String, esc: String,
    globalMessage: null, convoShown: new Set(), setTranscript() {}, closePages() {}, renderSessions() {}, renderNextDraft() {}, loadTranscript() {}, syncUrl() {}, updatePageTitle() {}, syncNothingOpen() {}, foxMotion: { activity: 0 }, gestures: [], foxGesture(name) { ctx.gestures.push(name); },
    mobileLayout: { matches: false }, opened: [], openSession(id) { ctx.opened.push(id); },
  };
  vm.runInNewContext(source.slice(start, end) + selection, ctx);
  vm.runInNewContext('renderReplyInbox()', ctx); // old server must not initialize read state
  assert.equal(storage.has('fox.inbox.seen'), false);
  state.sessions[0].latestReply = { turn: 1, text: 'First', at: 1, messageIndex: 1 };
  vm.runInNewContext('renderReplyInbox()', ctx);
  assert.equal(elements['reply-inbox'].classList.contains('hidden'), true);
  assert.deepEqual(ctx.gestures, [], 'loading fox is no new reply: no wink');
  state.sessions[0].latestReply = { turn: 2, text: 'Second', at: 2, messageIndex: 3 };
  vm.runInNewContext('renderReplyInbox()', ctx);
  assert.deepEqual(ctx.gestures, ['wink'], 'a new reply: the fox winks');
  assert.ok(ctx.foxMotion.activity > 0, 'a new reply breaks a quiet spell');
  vm.runInNewContext('renderReplyInbox()', ctx);
  assert.deepEqual(ctx.gestures, ['wink'], 'the same reply again: no second wink');
  assert.equal(elements['reply-inbox-count'].textContent, 1);
  assert.match(elements['reply-inbox-list'].innerHTML, /Second/);
  handlers['reply-inbox-list:click']({ target: { closest: () => ({ dataset: { reply: 'abcd' } }) } });
  assert.equal(state.selected, 'abcd');
  assert.equal(elements['reply-inbox'].classList.contains('hidden'), true);
  assert.equal(JSON.parse(storage.get('fox.inbox.seen')).abcd, 2);
  assert.equal(ctx.globalMessage.index, 3);
  assert.deepEqual(ctx.opened, ['abcd'], 'on a computer the reply opens in Read and its terminal comes to the center');
  // On a phone it opens the session's terminal only.
  ctx.mobileLayout.matches = true; ctx.opened = []; ctx.globalMessage = null;
  handlers['reply-inbox-list:click']({ target: { closest: () => ({ dataset: { reply: 'abcd' } }) } });
  assert.deepEqual(ctx.opened, ['abcd']);
  assert.equal(ctx.globalMessage, null);

  state.sessions[0].latestReply.turn = 3;
  state.sessions.push({ id: 'other', title: 'Other', latestReply: { turn: 2, text: 'Other reply' } },
    { id: 'child', parentId: 'abcd', latestReply: { turn: 1 }, childCompletion: { marker: 'done:1', text: 'Child result', at: 3 } },
    { id: 'archived', archived: true, latestReply: { turn: 1 } });
  vm.runInNewContext('renderReplyInbox()', ctx);
  assert.equal(elements['reply-inbox-count'].textContent, 3, 'two replies and one subagent result');
  ctx.opened = [];
  handlers['reply-inbox-clear:click']();
  assert.equal(elements['reply-inbox'].classList.contains('hidden'), true);
  assert.equal(elements['reply-inbox-list'].classList.contains('hidden'), true);
  const seen = JSON.parse(storage.get('fox.inbox.seen'));
  assert.equal(seen.abcd, 3); assert.equal(seen.other, 2);
  assert.equal(seen['child:child'], 'done:1', 'subagent results clear too');
  assert.equal(seen.archived, undefined, 'archived sessions are left alone');
  assert.deepEqual(ctx.opened, [], 'clearing replies never opens a terminal');
  vm.runInNewContext('inboxSeen = null; renderReplyInbox()', ctx);
  assert.equal(elements['reply-inbox'].classList.contains('hidden'), true, 'cleared replies stay read after reload');
  state.sessions[0].latestReply.turn = 4;
  vm.runInNewContext('renderReplyInbox()', ctx);
  assert.equal(elements['reply-inbox-count'].textContent, 1);
  assert.equal(elements['reply-inbox'].classList.contains('hidden'), false, 'future replies still appear');
});

test('child rounds appear under the parent without duplicate parent alerts or terminal attachment', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('let inboxSeen = null;'), source.indexOf('// ---------- sidebar ----------'))
    + source.slice(source.indexOf('function selectSession(id) {'), source.indexOf('async function renameInline(id) {'))
    + source.slice(source.indexOf('function detectTransitions() {'), source.indexOf('// ---------- the fox\'s gestures ----------'));
  const handlers = {}, elements = {};
  const $ = (selector) => elements[selector] ??= { classList: { hidden: true, toggle(_, value) { this.hidden = value; }, add() {}, contains() { return this.hidden; } }, setAttribute() {}, addEventListener(type, fn) { handlers[`${selector}:${type}`] = fn; }, innerHTML: '', textContent: '' };
  const parent = { id: 'parent', title: 'Parser', state: 'working', latestReply: { turn: 1, text: 'Started', at: 1 }, archived: false };
  const child = { id: 'child', parentId: 'parent', title: 'reviewer', subagent: { name: 'reviewer', phase: 'running' }, state: 'working', latestReply: { turn: 1, text: 'Old round', at: 2 }, childCompletion: null };
  const second = { ...child, id: 'child2', title: 'tester', latestReply: null };
  const state = { sessions: [parent, child, second], selected: null, prevStates: new Map(), prevChildResults: new Map(), prevReplyTurns: new Map() };
  const storage = new Map([['fox.inbox.seen', JSON.stringify({ parent: 1 })]]);
  const notifications = [], opened = [];
  const ctx = { $, state, ICON: { threads: '↳' }, localStorage: { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    sessionById: (id) => state.sessions.find((s) => s.id === id), displayTitle: (s) => s.subagent?.name ?? s.title,
    shortPath: String, fmtTime: String, esc: String, notify: (...args) => notifications.push(args),
    foxMotion: { activity: 0 }, foxGesture() {}, mobileLayout: { matches: false }, convoShown: new Set(),
    closePages() {}, setTranscript() {}, renderSessions() {}, renderNextDraft() {}, loadTranscript() {}, syncUrl() {}, updatePageTitle() {}, syncNothingOpen() {},
    openSession: (id) => opened.push(id), showMobileView: (view) => { ctx.mobileView = view; }, globalMessage: null, Date,
  };
  vm.runInNewContext(code, ctx);
  vm.runInNewContext('renderReplyInbox(); detectTransitions()', ctx);
  assert.equal(JSON.parse(storage.get('fox.inbox.seen'))['child:child'], 'turn:1', 'migrating a browser seeds the old completed child round');
  assert.equal(elements['#reply-inbox'].classList.hidden, true);
  child.subagent.phase = 'idle'; child.state = 'ready';
  child.childCompletion = { marker: 'turn:2', turn: 2, text: 'New review', at: 4, messageIndex: 3, failed: false };
  parent.state = 'ready'; parent.latestReply = { turn: 2, text: 'Parent reply', at: 5 };
  second.subagent = { name: 'tester', phase: 'finished' }; second.state = 'done';
  second.childCompletion = { marker: 'failed:1', failed: true, text: 'Timed out', at: 6, messageIndex: null };
  vm.runInNewContext('renderReplyInbox(); detectTransitions()', ctx);
  assert.equal(notifications.length, 2, 'two child outcomes, no duplicate parent state notification');
  assert.match(elements['#reply-inbox-list'].innerHTML, /reviewer.*Parser.*New review/s);
  assert.match(elements['#reply-inbox-list'].innerHTML, /tester.*failed.*Timed out/s);
  assert.equal(elements['#reply-inbox-count'].textContent, 3, 'a distinct parent answer must remain unread even if a child finished in the same poll');
  assert.equal(JSON.parse(storage.get('fox.inbox.seen')).parent, 1);
  vm.runInNewContext('renderReplyInbox(); detectTransitions()', ctx);
  assert.equal(notifications.length, 2, 'repeat poll does not notify again');
  handlers['#reply-inbox-list:click']({ target: { closest: () => ({ dataset: { reply: 'child' } }) } });
  assert.equal(state.selected, 'child'); assert.equal(ctx.globalMessage.index, 3); assert.deepEqual(opened, []);
  assert.equal(JSON.parse(storage.get('fox.inbox.seen'))['child:child'], 'turn:2');
  assert.equal(elements['#reply-inbox-count'].textContent, 2, 'the parent answer and other child result remain unread');
  ctx.mobileLayout.matches = true;
  handlers['#reply-inbox-list:click']({ target: { closest: () => ({ dataset: { reply: 'child2' } }) } });
  assert.equal(state.selected, 'child2'); assert.equal(ctx.mobileView, 'read'); assert.deepEqual(opened, [], 'phone also stays in Read, never the parent terminal');
  parent.latestReply = { turn: 3, text: 'A separate parent answer', at: 7 };
  vm.runInNewContext('renderReplyInbox(); detectTransitions()', ctx);
  assert.match(elements['#reply-inbox-list'].innerHTML, /A separate parent answer/, 'a later parent reply remains visible');
  vm.runInNewContext('markReplyRead("parent")', ctx);
  child.subagent.phase = 'running'; child.state = 'working'; child.childCompletion = null;
  vm.runInNewContext('renderReplyInbox(); detectTransitions()', ctx);
  child.subagent.phase = 'idle'; child.state = 'ready';
  child.childCompletion = { marker: 'turn:3', turn: 3, text: 'Follow-up', at: 9, messageIndex: 6, failed: false };
  vm.runInNewContext('renderReplyInbox(); detectTransitions()', ctx);
  assert.match(elements['#reply-inbox-list'].innerHTML, /Follow-up/);
  assert.equal(notifications.length, 3, 'a named child returning to idle has a new round');
});

test('the model of a session is the one that answered last, not fx\'s default in session.json', () => {
  const reply = (model) => JSON.stringify({ event: { assistant: { text: 'hi', provider_replay: { source: { model } } } } });
  assert.equal(lastAnswerModel([JSON.stringify({ event: { user: { text: 'q' } } })]), null);
  assert.equal(lastAnswerModel([reply('gpt-6.1-sol'), JSON.stringify({ event: { user: { text: 'q' } } }), reply('gpt-6-luna'), '{"event":{"tool":{}}}']), 'gpt-6-luna');
  assert.equal(lastAnswerModel([reply('gpt-6-luna'), '{not json "provider_replay"']), 'gpt-6-luna');
});

test('sidebar and Read share the live parent model, falling back to the saved model', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const modelCode = source.slice(source.indexOf('const displayedModel ='), source.indexOf('const STATE_LABEL'));
  const code = source.slice(source.indexOf('function sessionCard('), source.indexOf('function childrenHtml(', source.indexOf('function sessionCard(')));
  const ctx = { document: { createElement: () => ({ dataset: {} }) }, state: { terminals: [], activeTab: null, tabs: new Map(), selected: null, pinned: new Set() },
    foxConfig: { remote: false }, ICON: { pin: '', rename: '', archive: '' }, STATE_LABEL: { working: 'working', ready: 'waiting', idle: '' },
    agentName: () => 'fx', esc: String, displayTitle: (s) => s.title, modelShort: String, providerLabel: () => 'gateway', providerTag: () => '', fmtTime: () => '', childrenHtml: () => '' };
  vm.runInNewContext(modelCode + code + 'this.card = sessionCard; this.readModel = displayedModel', ctx);
  const parent = { id: 'parent', title: 'Parent', state: 'working', model: 'saved-model', activeModel: 'live-model' };
  assert.equal(ctx.readModel(parent), 'live-model');
  assert.match(ctx.card(parent).innerHTML, /title="live-model via gateway">live-model</);
  parent.activeModel = null;
  assert.match(ctx.card(parent).innerHTML, /title="saved-model via gateway">saved-model</);
  parent.activeModel = 'live-model'; parent.state = 'idle';
  assert.match(ctx.card(parent).innerHTML, /title="saved-model via gateway">saved-model</);
  parent.state = 'working'; parent.parentId = 'another-session';
  assert.equal(ctx.readModel(parent), 'saved-model');
  assert.match(ctx.card(parent).innerHTML, /title="saved-model via gateway">saved-model</);
  delete parent.parentId; parent.subagentChild = true;
  assert.equal(ctx.readModel(parent), 'saved-model');
});

test('hidden or reduced-motion yawns do not consume the next visible yawn', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('const FOX_YAWN_IDLE'), source.indexOf('let inboxSeen = null;'));
  let now = 0, tick;
  const fox = { classList: { add() {}, remove() {} }, getBoundingClientRect() {} };
  const ctx = { Date: { now: () => now }, state: { sessions: [] }, document: { hidden: false, querySelector: () => fox },
    window: { addEventListener() {} }, matchMedia: () => ({ matches: false }),
    setInterval: (fn) => { tick = fn; }, setTimeout: () => 1, clearTimeout() {} };
  vm.runInNewContext(code, ctx);
  now = 10 * 60_000;
  ctx.document.hidden = true;
  tick();
  ctx.document.hidden = false;
  vm.runInNewContext('this.yawned = foxMotion.yawned', ctx);
  assert.equal(ctx.yawned, 0, 'hidden yawn was not counted');
  tick();
  vm.runInNewContext('this.yawned = foxMotion.yawned', ctx);
  assert.equal(ctx.yawned, now, 'the fox yawns when visible again');
  now += 20 * 60_000;
  ctx.matchMedia = () => ({ matches: true });
  tick();
  vm.runInNewContext('this.yawned = foxMotion.yawned', ctx);
  assert.equal(ctx.yawned, 10 * 60_000, 'reduced motion never consumes a yawn');
  ctx.state.sessions = [{ state: 'working' }];
  ctx.matchMedia = () => ({ matches: false });
  tick();
  assert.equal(ctx.yawned, 10 * 60_000, 'working sessions prevent a yawn');
});

test('the fox yawns after 10 quiet minutes, then every 20, and any activity starts it over', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('const FOX_YAWN_IDLE'), source.indexOf('const foxMotion'))
    + source.slice(source.indexOf('function foxShouldYawn'), source.indexOf('for (const type of'));
  const ctx = {};
  vm.runInNewContext(code + '; this.yawn = foxShouldYawn;', ctx);
  const min = 60_000, quietFrom = 1_000 * min;
  assert.equal(ctx.yawn({ now: quietFrom + 9 * min, idleSince: quietFrom, yawned: 0 }), false, 'not before 10 minutes');
  assert.equal(ctx.yawn({ now: quietFrom + 10 * min, idleSince: quietFrom, yawned: 0 }), true);
  assert.equal(ctx.yawn({ now: quietFrom + 25 * min, idleSince: quietFrom, yawned: quietFrom + 10 * min }), false, 'not again before 20 minutes');
  assert.equal(ctx.yawn({ now: quietFrom + 30 * min, idleSince: quietFrom, yawned: quietFrom + 10 * min }), true);
  const back = quietFrom + 40 * min;
  assert.equal(ctx.yawn({ now: back + 5 * min, idleSince: back, yawned: quietFrom + 30 * min }), false, 'activity starts the 10 minutes over');
  assert.equal(ctx.yawn({ now: back + 10 * min, idleSince: back, yawned: quietFrom + 30 * min }), true, 'a new quiet spell yawns at its own 10 minutes');
});
