import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import vm from 'node:vm';

// The desktop draft is local to the browser; exercise its real handlers without attaching to tmux.
test('next-message drafts stay scoped, survive selection/reconnect, and insert only on an open ready parent terminal', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const snippet = source.slice(source.indexOf('const DRAFT_LIMIT = 4000;'), source.indexOf('// Paste on a phone (see #pastesheet).'));
  const stored = new Map(), handlers = {}, elements = {};
  const $ = (key) => elements[key] ??= {
    value: '', textContent: '', disabled: false, open: false,
    classList: { hidden: false, toggle(_key, value) { this.hidden = value; }, contains() { return this.hidden; } },
    addEventListener(event, cb) { handlers[`${key}:${event}`] = cb; },
  };
  const parent = { id: 'parent', state: 'working', terminal: 'term' };
  const other = { id: 'other', state: 'ready', terminal: 'other-term' };
  const child = { id: 'child', parentId: 'parent', state: 'ready' };
  const sent = [], ws = { readyState: 1, send: (data) => sent.push(JSON.parse(data)) };
  const tab = { name: 'term', ws, term: { focus() {}, paste(text) { if (ws.readyState === 1) { sent.push({ type: 'input', data: text }); tab.draftSent = true; } } } };
  const state = { selected: 'parent', sessions: [parent, other, child], terminals: [{ name: 'term', resume: 'parent' }, { name: 'other-term', resume: 'other' }], tabs: new Map([['term', tab]]), activeTab: 'term' };
  const ctx = { $, state, WebSocket: { OPEN: 1 }, localStorage: { getItem: (k) => stored.get(k), setItem: (k, v) => stored.set(k, v), removeItem: (k) => stored.delete(k) }, sessionById: (id) => state.sessions.find((s) => s.id === id) };
  vm.createContext(ctx); vm.runInContext(snippet, ctx);
  const render = () => vm.runInContext('renderNextDraft()', ctx);
  const edit = (text) => { $('#next-draft-text').value = text; handlers['#next-draft-text:input'](); };
  const insert = () => handlers['#next-draft-insert:click']();
  render(); edit('first\nsecond\x1b');
  assert.equal(stored.get('fox.nextDraft.parent'), 'first\nsecond\x1b');
  assert.equal($('#next-draft-insert').disabled, true, 'working cannot insert');
  state.selected = 'other'; render(); edit('other draft');
  state.selected = 'child'; render(); assert.equal($('#next-draft').classList.hidden, true); insert();
  state.selected = 'parent'; parent.state = 'ready'; render();
  assert.equal($('#next-draft-text').value, 'first\nsecond\x1b');
  assert.equal($('#next-draft-insert').disabled, false);
  ws.readyState = 0; render(); insert(); assert.equal(sent.length, 0); assert.ok(stored.has('fox.nextDraft.parent'));
  ws.readyState = 1; state.activeTab = 'other-term'; render(); insert(); assert.equal(sent.length, 0);
  state.activeTab = 'term'; render(); tab.term.paste = () => {}; insert(); assert.ok(stored.has('fox.nextDraft.parent'), 'no accepted input keeps draft');
  tab.term.paste = (text) => { sent.push({ type: 'input', data: text }); tab.draftSent = true; };
  insert(); assert.equal(sent.length, 1);
  assert.equal(sent[0].data, 'first second ');
  assert.equal(stored.has('fox.nextDraft.parent'), false);
  assert.equal(stored.get('fox.nextDraft.other'), 'other draft');
  edit('a'.repeat(5000)); assert.equal(stored.get('fox.nextDraft.parent').length, 4000);
});

const freePort = () => new Promise((resolve, reject) => {
  const server = createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
async function ready(url) {
  for (let attempt = 0; attempt < 200; attempt++) { // up to 10 s: a busy machine (all tests at once) starts fox slower
    try { return await fetch(url); } catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  throw new Error('mobile server did not start');
}
test('mobile listener sends scoped session replies without exposing panel APIs or terminal upgrade', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fox-mobile-'));
  const id = 'test-session';
  const dir = join(home, '.fx', 'sessions', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'session.json'), JSON.stringify({ title: 'Test', workspace_root: '/repo', updated_at_ms: 10 }));
  await writeFile(join(dir, 'events.jsonl'), [
    { event: { user: { text: 'hello' } } },
    { event: { tool_result: { preview: 'SECRET_TOOL_OUTPUT' } } },
    { event: { assistant: { text: 'answer' } } },
    { event: { turn_completed: {} } },
  ].map((x) => JSON.stringify(x)).join('\n'));
  const fakeTmux = join(home, 'tmux.mjs'), tmuxLog = join(home, 'tmux.log');
  await writeFile(fakeTmux, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const [command, ...args] = process.argv.slice(2);
if (command === 'list-sessions') console.log('fx-test-session|1|0');
else if (command === 'show-options') console.log(args.at(-1) === '@fx_resume' ? 'test-session' : '/repo');
else if (command === 'capture-pane') console.log('┃ prompt');
else appendFileSync(${JSON.stringify(tmuxLog)}, JSON.stringify([command, ...args]) + '\\n');
`);
  await chmod(fakeTmux, 0o755);
  const port = await freePort(), mobilePort = await freePort();
  const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, HOME: home, PORT: String(port), FOX_MOBILE_PORT: String(mobilePort), TMUX_BIN: fakeTmux, FOX_AUTH_DISABLED: '1' }, stdio: 'pipe' });
  const base = `http://127.0.0.1:${mobilePort}`;
  try {
    const page = await ready(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="composer"/);
    const overview = await (await fetch(`${base}/api/overview`)).json();
    assert.equal(overview.sessions[0].title, 'Test');
    assert.equal(overview.sessions[0].usage, undefined);
    const messages = await (await fetch(`${base}/api/sessions/${id}/events`)).json();
    assert.deepEqual(messages.map((ev) => ev.text), ['hello', 'answer']);
    assert.equal((await fetch(`${base}/api/search?q=answer`)).status, 200);
    for (const path of ['/api/terminals', '/api/tools', `/api/sessions/${id}/files`, '/vendor/xterm/css/xterm.css', '/app.js']) {
      assert.equal((await fetch(base + path)).status, 404, path);
    }
    for (const [method, path] of [['POST', '/api/terminals'], ['DELETE', '/api/terminals/fx-test'], ['POST', `/api/sessions/${id}/archive`]]) {
      assert.equal((await fetch(base + path, { method })).status, 405, `${method} ${path}`);
    }
    const reply = (session, text, origin = base) => fetch(`${base}/api/sessions/${session}/reply`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ text }),
    });
    assert.equal((await reply(id, 'hello', 'https://evil.example')).status, 403);
    assert.equal((await reply(id, 'hello', 'not-a-url')).status, 403);
    assert.equal((await reply(id, 'a'.repeat(8001))).status, 400);
    assert.equal((await reply('missing-session', 'hello')).status, 404);
    assert.equal((await reply(id, '\u0001')).status, 400);
    assert.equal((await reply(id, 'first line\nsecond line')).status, 202);
    const commands = (await readFile(tmuxLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
      .filter((args) => !(args[0] === 'set-option' && args.includes('terminal-features'))); // server-wide, once at start (hyperlinks)
    assert.deepEqual(commands.map((args) => args[0]), ['set-buffer', 'paste-buffer', 'send-keys']);
    assert.equal(commands[0].at(-1), 'first line\nsecond line');
    assert.equal(commands[2].at(-1), 'Enter');
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${mobilePort}/pty?name=fx-${id}`, { handshakeTimeout: 2000 });
      ws.once('open', () => { ws.close(); reject(new Error('mobile terminal upgrade succeeded')); });
      ws.once('error', () => resolve());
    });
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    await rm(home, { recursive: true, force: true });
  }
});
