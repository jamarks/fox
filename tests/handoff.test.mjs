import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const section = app.slice(app.indexOf('// ---------- local handoff packet ----------'), app.indexOf("$('#transcript').addEventListener('click'"));

test('handoff requires a completed source turn and uses recorded model', () => {
  const ctx = vm.createContext({});
  vm.runInContext(section.slice(section.indexOf('const handoffResult'), section.indexOf('async function handoffFile')), ctx);
  const events = [{ kind: 'user', text: 'Exact task' }, { kind: 'assistant', text: 'Exact answer', model: 'model-a', ts: 10 }, { kind: 'turn_completed', ts: 11 }];
  assert.equal(vm.runInContext('handoffEvidence', ctx)(events, { kind: 'answer', index: 1 }).model, 'model-a');
  assert.equal(vm.runInContext('handoffEvidence', ctx)(events.slice(0, 2), { kind: 'answer', index: 1 }), null);
  const agent = [{ kind: 'tool_call', name: 'subagent', args: { request: { task: 'Child task' } }, result: { preview: '{"result":"Child answer"}' } }, { kind: 'assistant', text: 'Parent continued' }, { kind: 'turn_completed', ts: 12 }];
  assert.equal(vm.runInContext('handoffEvidence', ctx)(agent, { kind: 'agent', index: 0, model: 'child-model' }).answer, 'Child answer');
});

function harness() {
  const handlers = {}, elements = {}, sent = [];
  for (const id of ['handoff-status', 'handoff-target', 'handoff-choices', 'handoff-text', 'handoffsheet', 'handoff-boundary', 'handoff-refresh', 'handoff-cancel', 'handoffform']) {
    const classes = new Set(['hidden']);
    elements[id] = { value: '', textContent: '', innerHTML: '', disabled: false,
      classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) },
      addEventListener(type, callback) { handlers[`${id}:${type}`] = callback; },
    };
  }
  const submit = { disabled: false };
  elements.handoffform.querySelector = () => submit;
  const src = { id: 'src', workspace: '/repo-a', model: 'old-default', title: 'Source', state: 'ready' };
  const dst = { id: 'dst', workspace: '/repo-b', title: 'Destination', state: 'ready', terminal: 'fx-dst' };
  const alt = { id: 'alt', workspace: '/repo-c', title: 'Other', state: 'ready', terminal: 'fx-alt' };
  let events = [{ kind: 'user', text: 'Task' }, { kind: 'assistant', text: 'Answer\x1b[31m\r\nline', model: 'actual-model', ts: 2 }, { kind: 'turn_completed', ts: 3 }];
  let file = 'first', fileResponse;
  const ws = { readyState: 1, send: (value) => sent.push(JSON.parse(value)) };
  const tab = { ws, term: { focus() {} }, closed: false };
  const state = { sessions: [src, dst, alt], terminals: [{ resume: 'dst', name: 'fx-dst' }, { resume: 'alt', name: 'fx-alt' }], tabs: new Map([['fx-dst', tab], ['fx-alt', { ...tab, ws: { readyState: 3, send() { throw Error('closed'); } } }]]), repos: { '/repo-a': { repo: 'owner/repo-a', root: '/repo-a', branch: 'work' } } };
  const fetch = async (url) => ({ ok: true, json: async () => url.endsWith('/events') ? events : url.endsWith('/files') ? [{ path: '/repo-a/a.js', action: 'edit' }] : fileResponse ? fileResponse() : { text: file } });
  const ctx = vm.createContext({ state, fetch, crypto: webcrypto, TextEncoder, WebSocket: { OPEN: 1 },
    $: (selector) => selector.startsWith('#handoffform ') ? submit : elements[selector.slice(1)], window: { addEventListener() {} },
    sessionById: (id) => state.sessions.find((s) => s.id === id), displayTitle: (s) => s.title,
    esc: String, shortPath: String, briefArgs: (a) => a.command, activateTab: () => {},
  });
  vm.runInContext(section, ctx);
  const open = () => vm.runInContext('openHandoff({ dataset: { handoffSession: "src", handoffKind: "answer", handoffIndex: "1" } })', ctx);
  const insert = () => handlers['handoffform:submit']({ preventDefault() {} });
  return { ctx, handlers, elements, state, tab, ws, sent, open, insert, submit, setFile: (x) => { file = x; }, setFileResponse: (x) => { fileResponse = x; }, setEvents: (x) => { events = x; }, events: () => events };
}

test('destination switching never sends; outside-root warning and explicitly selected files', async () => {
  const h = harness();
  await h.open();
  assert.match(h.elements['handoff-text'].value, /actual-model/);
  assert.doesNotMatch(h.elements['handoff-text'].value, /a\.js/);
  h.elements['handoff-target'].value = 'dst';
  h.handlers['handoff-target:change']();
  assert.equal(h.sent.length, 0);
  h.handlers['handoff-choices:change']({ target: { dataset: { handoffChoice: 'file:0' }, checked: true } });
  assert.match(h.elements['handoff-boundary'].textContent, /outside this session/);
  assert.match(h.elements['handoff-text'].value, /sha256:/);
  h.elements['handoff-target'].value = 'alt';
  h.handlers['handoff-target:change']();
  assert.equal(h.sent.length, 0);
  await h.insert();
  assert.equal(h.sent.length, 0, 'closed destination socket must not be used');
  h.elements['handoff-target'].value = 'dst';
  h.setFile('changed');
  await h.insert();
  assert.equal(h.sent.length, 0, 'changed file must block insertion');
  assert.match(h.elements['handoff-status'].textContent, /File changed/);
});

test('unreadable file references are omitted rather than treated as verified', async () => {
  const h = harness();
  h.setFileResponse(() => ({}));
  await h.open();
  assert.doesNotMatch(h.elements['handoff-choices'].innerHTML, /a\.js/);
});

test('closing while evidence is loading cannot reopen the dialog', async () => {
  const h = harness();
  let release;
  h.setFileResponse(() => new Promise((resolve) => { release = resolve; }));
  const pending = h.open();
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  h.handlers['handoff-cancel:click']();
  release({ text: 'first' });
  await pending;
  assert.equal(h.elements.handoffsheet.classList.contains('hidden'), true);
});

test('source changes block insertion; safe bracketed paste inserts without Enter', async () => {
  const h = harness();
  await h.open();
  h.elements['handoff-target'].value = 'dst';
  h.setEvents([{ ...h.events()[0] }, { ...h.events()[1], text: 'changed' }, h.events()[2]]);
  await h.insert();
  assert.equal(h.sent.length, 0);
  assert.match(h.elements['handoff-status'].textContent, /Source changed/);
  h.setEvents([{ ...h.events()[0] }, { ...h.events()[1], text: 'Answer\x1b[31m\r\nline' }, h.events()[2]]);
  h.elements['handoff-text'].value = 'Review\x1b[31m\r\nthis\x07';
  await h.insert();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].type, 'input');
  assert.equal(h.sent[0].data, '\x1b[200~Review [31m\nthis \x1b[201~');
  assert.ok(!h.sent[0].data.endsWith('\r'));
});
