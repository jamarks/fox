import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the same selection and tab-render paths that keep the column in sync, without attaching to tmux.
test('right column steps aside only when neither a tab nor a session is open', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const selection = source.slice(source.indexOf('function syncNothingOpen()'), source.indexOf('async function renameInline(id)'));
  const render = source.slice(source.indexOf('function renderTabs()'), source.indexOf('// Keep the address bar in sync', source.indexOf('function renderTabs()')));
  const classes = new Set();
  const elements = {
    '#tabs': { innerHTML: '' }, '#mobile-terminal-title': { textContent: '' }, '#empty-state': { style: {} },
  };
  const state = { selected: null, tabs: new Map(), activeTab: null, terminals: [] };
  const ctx = {
    state, document: { body: { classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); } } } },
    $: (selector) => elements[selector], updateDictationAvailability() {}, updatePageTitle() {}, markReplyRead() {},
    renderSessions() {}, renderNextDraft() {}, loadTranscript() {}, syncUrl() {},
  };
  vm.runInNewContext(selection + render, ctx);
  vm.runInNewContext('renderTabs()', ctx);
  assert.equal(classes.has('nothing-open'), true);

  vm.runInNewContext("selectSession('session-1')", ctx);
  assert.equal(classes.has('nothing-open'), false, 'a read-only selection still has files and subagents');

  vm.runInNewContext('selectSession(null)', ctx);
  assert.equal(classes.has('nothing-open'), true);
  state.tabs.set('terminal', { kind: 'view', label: 'Preview' });
  ctx.viewTabEl = () => ({});
  elements['#tabs'].appendChild = () => {};
  vm.runInNewContext('renderTabs()', ctx);
  assert.equal(classes.has('nothing-open'), false, 'an open tab keeps the column');

  state.tabs.clear();
  vm.runInNewContext('renderTabs()', ctx);
  assert.equal(classes.has('nothing-open'), true, 'closing the last tab restores the empty layout');
});
