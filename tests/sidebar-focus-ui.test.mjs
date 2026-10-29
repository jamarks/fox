// Exercise the sidebar's browser-only filter with the same render and click handler as the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const slice = (from, to) => app.slice(app.indexOf(from), app.indexOf(to));
const workspace = { id: 'fox', name: 'fox', dir: '/workspaces/fox', repos: [] };
const folder = '/projects/notes';
function harness(savedFocus = null) {
  const data = new Map(savedFocus ? [['fox.focusedGroup', savedFocus]] : []);
  const localStorage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) };
  const handlers = {};
  const root = { children: [], set innerHTML(_) { this.children = []; }, appendChild(el) { this.children.push(el); }, addEventListener: (type, fn) => { handlers[type] = fn; } };
  const clear = { hidden: true, classList: { toggle(_, hidden) { clear.hidden = hidden; } }, addEventListener: (_, fn) => { handlers.clear = fn; } };
  const state = { selected: 'elsewhere', sessions: [
    { id: 'fox-session', workspace: workspace.dir, createdAt: 2 },
    { id: 'notes-session', workspace: folder, createdAt: 1 },
  ], workspaces: [workspace], repos: {}, renaming: null };
  const collapsed = new Set([workspace.dir]);
  const groupOrder = [folder, workspace.dir];
  const context = { state, localStorage, collapsed, groupOrder, showArchived: { value: false },
    document: { createElement: () => ({ dataset: {}, classList: { add() {} }, appendChild(el) { (this.children ??= []).push(el); } }) },
    workspaceFor: (path) => path === workspace.dir ? workspace : null,
    wsSummaryLine: () => '', wsWorkLine: () => '', wsRepoSummary: () => '', sessionCard: (s) => ({ id: s.id }),
    esc: (s) => String(s), shortPath: (s) => s, ICON: { rename: 'edit', focus: 'focus' },
    saveCollapsed: () => {}, saveGroupOrder: () => {},
  };
  context.$ = (selector) => selector === '#session-groups' ? root : clear;
  vm.createContext(context);
  vm.runInContext(slice('let focusedGroup = null;', 'function debounce'), context);
  vm.runInContext(slice('function renderSessions() {', 'function sessionCard('), context);
  vm.runInContext(slice("$('#clear-focus').addEventListener", '// Pages in the center'), context);
  context.render = context.renderSessions = vm.runInContext('renderSessions', context);
  context.focusClick = (path) => handlers.click({ target: { closest: (selector) => selector === 'button' ? { dataset: { focusGroup: path } } : null } });
  context.clearClick = handlers.clear;
  return { context, state, root, clear, data, collapsed, groupOrder };
}

test('focus isolates a workspace without changing selection, collapse or order; clearing restores them', () => {
  const { context, state, root, clear, data, collapsed, groupOrder } = harness();
  context.render();
  assert.deepEqual(root.children.map((g) => g.dataset.ws), [folder, workspace.dir]);
  assert.equal(root.children[1].children, undefined, 'workspace starts collapsed');
  context.focusClick(workspace.dir);
  assert.deepEqual(root.children.map((g) => g.dataset.ws), [workspace.dir]);
  assert.equal(root.children[0].children[0].id, 'fox-session', 'focused group opens temporarily');
  assert.match(root.children[0].innerHTML, /aria-pressed="true"/);
  assert.doesNotMatch(root.children[0].innerHTML, /data-toggle-group=/, 'focus does not change saved collapse state');
  assert.equal(data.get('fox.focusedGroup'), workspace.dir);
  assert.equal(clear.hidden, false);
  assert.equal(state.selected, 'elsewhere');
  context.render(); // overview poll
  assert.equal(root.children.length, 1);
  context.clearClick();
  assert.deepEqual(root.children.map((g) => g.dataset.ws), [folder, workspace.dir]);
  assert.equal(root.children[1].children, undefined, 'previous collapse returns');
  assert.equal(clear.hidden, true);
  assert.equal(data.has('fox.focusedGroup'), false);
  assert.deepEqual([...collapsed], [workspace.dir]);
  assert.deepEqual(groupOrder, [folder, workspace.dir]);
});

test('focus works for plain folders and stale stored paths clear on poll', () => {
  const { context, root, data, state, clear } = harness(folder);
  context.render();
  assert.deepEqual(root.children.map((g) => g.dataset.ws), [folder]);
  context.focusClick(folder);
  assert.equal(data.has('fox.focusedGroup'), false, 'toggle off');
  context.focusClick(folder);
  state.sessions = state.sessions.filter((s) => s.workspace !== folder);
  context.render();
  assert.deepEqual(root.children.map((g) => g.dataset.ws), [workspace.dir]);
  assert.equal(clear.hidden, true);
  assert.equal(data.has('fox.focusedGroup'), false);
});
