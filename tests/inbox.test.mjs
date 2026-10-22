import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { latestCompletedReply, lastAnswerModel } from '../inbox.mjs';

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

test('first load baselines history, polling adds unread, selection clears only that reply', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('let inboxSeen = null;');
  const end = source.indexOf('// ---------- sidebar ----------', start);
  const selection = source.slice(source.indexOf('function selectSession(id) {'), source.indexOf('async function renameInline(id) {'));
  assert.ok(start >= 0 && end > start && selection.includes('markReplyRead(id)'));
  const handlers = {};
  const elements = Object.fromEntries(['reply-inbox', 'reply-inbox-list', 'reply-inbox-toggle', 'reply-inbox-count', 'reply-inbox-label'].map((name) => [name, {
    classList: { values: new Set(['hidden']), toggle(key, force) { if (force === undefined ? !this.values.has(key) : force) this.values.add(key); else this.values.delete(key); }, add(key) { this.values.add(key); }, contains(key) { return this.values.has(key); } },
    setAttribute() {}, addEventListener(type, handler) { handlers[`${name}:${type}`] = handler; },
    innerHTML: '', textContent: '',
  }]));
  const storage = new Map();
  const state = { sessions: [{ id: 'abcd', archived: false, parentId: null, workspace: '/repo', title: 'Session' }], selected: null };
  const ctx = { state, $: (selector) => elements[selector.slice(1)], localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    sessionById: (id) => state.sessions.find((s) => s.id === id), displayTitle: (s) => s.title, shortPath: (s) => s, fmtTime: String, esc: String,
    globalMessage: null, convoShown: new Set(), setTranscript() {}, renderSessions() {}, loadTranscript() {}, syncUrl() {}, updatePageTitle() {}, syncNothingOpen() {}, foxMotion: { activity: 0 }, gestures: [], foxGesture(name) { ctx.gestures.push(name); },
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
  assert.deepEqual(ctx.opened, [], 'on a computer the reply opens in Read');
  // On a phone it opens the session's terminal instead.
  ctx.mobileLayout.matches = true;
  handlers['reply-inbox-list:click']({ target: { closest: () => ({ dataset: { reply: 'abcd' } }) } });
  assert.deepEqual(ctx.opened, ['abcd']);
});

test('the model of a session is the one that answered last, not fx\'s default in session.json', () => {
  const reply = (model) => JSON.stringify({ event: { assistant: { text: 'hi', provider_replay: { source: { model } } } } });
  assert.equal(lastAnswerModel([JSON.stringify({ event: { user: { text: 'q' } } })]), null);
  assert.equal(lastAnswerModel([reply('gpt-6.1-sol'), JSON.stringify({ event: { user: { text: 'q' } } }), reply('gpt-6-luna'), '{"event":{"tool":{}}}']), 'gpt-6-luna');
  assert.equal(lastAnswerModel([reply('gpt-6-luna'), '{not json "provider_replay"']), 'gpt-6-luna');
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
