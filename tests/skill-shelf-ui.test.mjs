// Exercise the real paste-sheet shelf without attaching to somebody's live tmux.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const section = source.slice(source.indexOf('function pasteIntoTerminal('), source.indexOf('async function openTerminal('));
function fixture() {
  const nodes = {}, handlers = {}, pasted = [];
  function element() {
    return {
      value: '', children: [],
      set textContent(value) { this.text = value; this.children = []; }, get textContent() { return this.text ?? ''; },
      classList: { values: new Set(), add(x) { this.values.add(x); }, remove(x) { this.values.delete(x); }, contains(x) { return this.values.has(x); } },
      addEventListener(type, fn) { this.events ??= {}; this.events[type] = fn; },
      append(...children) { this.children.push(...children); }, appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; },
      setAttribute() {}, focus() {},
    };
  }
  const $ = (sel) => nodes[sel] ??= element();
  const tab = { ws: { readyState: 1 }, term: { paste: (text) => pasted.push(text), focus() {} } };
  const state = { terminals: [{ name: 'fx-one', harness: 'fx', cwd: '/home/a/repo' }, { name: 'claude', harness: 'claude', cwd: '/home/a/other' }], activeTab: 'fx-one', tabs: new Map([['fx-one', tab], ['claude', tab]]), selected: 'a', sessions: [{ id: 'a', harness: 'fx', workspace: '/home/a/repo' }] };
  const ctx = { $, document: { createElement: element }, state, WebSocket: { OPEN: 1 }, toast: () => {}, navigator: {}, shortPath: String, sessionById: (id) => state.sessions.find((s) => s.id === id), fetch: async () => ({ ok: true, json: async () => [{ name: 'review-tests', description: 'Review the tests', source: 'Project · .fx/skills' }, { name: 'ship', description: 'Ship', source: 'Personal · .fx/skills' }] }) };
  vm.createContext(ctx); vm.runInContext(section, ctx);
  return { ctx, state, pasted, $, nodes, run: (code) => vm.runInContext(code, ctx) };
}

test('searches by description/source and inserts an unsent draft into the active fx terminal', async () => {
  const f = fixture(); await f.run('openSkillShelf()');
  assert.equal(f.$('#skill-list').children.length, 2);
  f.$('#skill-search').value = 'review the tests'; f.run('renderSkillShelf()');
  assert.equal(f.$('#skill-list').children.length, 1);
  f.$('#skill-list').children[0].events.click();
  assert.deepEqual(f.pasted, ['Use the review-tests skill to ']);
  assert.equal(f.$('#pastesheet').classList.contains('hidden'), true);
});

test('Enter in the shelf search never submits a previous paste draft', async () => {
  const f = fixture();
  f.$('#paste-text').value = 'previous draft';
  await f.run('openSkillShelf()');
  assert.equal(f.$('#paste-text').value, '');
  f.$('#paste-text').value = 'unexpected draft';
  f.$('#pasteform').events.submit({ preventDefault() {} });
  assert.deepEqual(f.pasted, []);
  assert.equal(f.$('#pastesheet').classList.contains('hidden'), false);
});

test('changing to another terminal or closing while loading cannot insert or show stale results', async () => {
  const f = fixture(); await f.run('openSkillShelf()');
  f.state.activeTab = 'claude'; f.$('#skill-list').children[0].events.click();
  assert.deepEqual(f.pasted, []);
  f.state.activeTab = 'fx-one';
  let finish;
  f.ctx.fetch = () => new Promise((resolve) => { finish = resolve; });
  const pending = f.run('openSkillShelf()'); f.run('closePasteSheet()');
  finish({ ok: true, json: async () => [{ name: 'stale' }] }); await pending;
  assert.equal(f.$('#skill-list').children.length, 0);
});
