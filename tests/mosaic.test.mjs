import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { screenModel } from '../inbox.mjs';

test('screen model reads the footer regardless of fx mode', () => {
  assert.equal(screenModel('answer\nauto · gpt-6-sol · tokens\n'), 'gpt-6-sol');
  assert.equal(screenModel('answer\ncodex · openai/gpt-5 · tokens\n'), 'openai/gpt-5');
  assert.equal(screenModel('no footer\n'), null);
});

test('mosaic marks a first unfinished turn as working, not an absent reply', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const markdown = await readFile(new URL('../public/markdown.js', import.meta.url), 'utf8');
  const render = `${source.slice(source.indexOf('const displayedModel ='), source.indexOf('const STATE_LABEL'))}\n${markdown}\n${source.slice(source.indexOf('let mosaicCapture = 0;'), source.indexOf('function setMosaic(on)'))}\nrenderMosaic()`;
  const pre = { isConnected: true, dataset: {}, textContent: 'Loading…', scrollTop: 0, scrollHeight: 300, clientHeight: 300 };
  const meta = { textContent: '' };
  const replyText = { innerHTML: '' };
  const reply = { querySelector: (selector) => selector === 'span' ? { textContent: '' } : replyText };
  const elements = { pre, '.st': {}, strong: {}, '[data-remove]': { setAttribute() {} }, '.mosaic-meta': meta, '.mosaic-reply': reply };
  const tile = { dataset: { tile: 'session-two' }, querySelector: (selector) => elements[selector] };
  let html = '';
  const tiles = { dataset: {}, get innerHTML() { return html; }, set innerHTML(value) { html = value; }, querySelectorAll: () => html.includes('data-tile') ? [tile] : [] };
  const choices = { innerHTML: '' };
  const session = { id: 'session-two', title: 'Answering', terminal: 'fx-session-two', state: 'working', workspace: '/demo', model: 'old-default', latestReply: null };
  const context = {
    state: { mosaic: true, sessions: [session], mosaicIds: [session.id] },
    $: (id) => id === '#mosaic-tiles' ? tiles : choices,
    localStorage: { setItem() {} },
    sessionById: () => session, displayTitle: (s) => s.title, shortPath: (p) => p, modelShort: (m) => m,
    esc: (s) => String(s), STATE_LABEL: {},
    fetch: async () => ({ ok: true, json: async () => ({ text: 'line at the bottom', model: 'gpt-6-sol' }) }),
  };
  runInNewContext(render.replace(/renderMosaic\(\)$/, 'this.render = renderMosaic'), context);
  context.render();
  assert.match(tiles.innerHTML, /Current turn<\/span><div class="md mosaic-reply-text"><p>Working…<\/p><\/div>/);
  assert.doesNotMatch(tiles.innerHTML, /No reply yet/);
  await new Promise(setImmediate);
  assert.equal(pre.textContent, 'line at the bottom');
  assert.equal(pre.scrollTop, 300);
  assert.equal(meta.textContent, '/demo · gpt-6-sol');
  session.latestReply = { text: 'Older answer' };
  meta.textContent = '';
  context.render();
  await new Promise(setImmediate);
  assert.equal(meta.textContent, '/demo · gpt-6-sol'); // the current turn may use a different model
});

const freePort = () => new Promise((resolve) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});

test('mosaic snapshot is bounded, plain text and only for a live fox session', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fox-mosaic-'));
  const dir = join(home, '.fx', 'sessions', 'session-one');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'session.json'), JSON.stringify({ title: 'One', workspace_root: home, model: 'openai/gpt-5', updated_at_ms: 10 }));
  await writeFile(join(dir, 'events.jsonl'), [
    { event: { assistant: { text: 'Last answer', provider_replay: { source: { model: 'openai/saved-model' } } } } }, { event: { turn_completed: {} } },
  ].map(JSON.stringify).join('\n'));
  const working = join(home, '.fx', 'sessions', 'session-two');
  await mkdir(working, { recursive: true });
  await writeFile(join(working, 'session.json'), JSON.stringify({ title: 'Answering', workspace_root: home, model: 'openai/old-default', updated_at_ms: 20 }));
  await writeFile(join(working, 'events.jsonl'), '');
  for (const id of ['session-three', 'session-four']) {
    const dir = join(home, '.fx', 'sessions', id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'session.json'), JSON.stringify({ title: id, workspace_root: home, model: 'openai/default', updated_at_ms: 30 }));
    await writeFile(join(dir, 'events.jsonl'), [
      { event: { assistant: { text: 'Earlier answer', provider_replay: { source: { model: 'openai/saved-model' } } } } },
      { event: { turn_completed: {} } },
    ].map(JSON.stringify).join('\n'));
  }
  const script = join(home, 'tmux.mjs'), log = join(home, 'captures.log');
  await writeFile(script, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'list-sessions') console.log('fx-session-one|1|0\\nfx-session-two|2|0\\nfx-session-three|3|0\\nfx-session-four|4|0');
else if (cmd === 'show-options') { if (!['fx-session-one', 'fx-session-two', 'fx-session-three', 'fx-session-four'].some((s) => args.includes(s))) process.exit(1); console.log(args.at(-1) === '@fx_resume' ? args.find((s) => s.startsWith('fx-')).replace('fx-', '') : ${JSON.stringify(home)}); }
else if (cmd === 'capture-pane') {
  appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
  const two = args.includes('fx-session-two');
  if (args.includes('-E')) console.log('old history banner');
  else if (args.includes('-S')) console.log([...Array.from({length: 36}, (_, i) => 'line-' + i), two ? 'Live assistant answer' : '\\x1b[31mLAST\\x1b[0m\\x00', two ? 'codex · gpt-6-sol · tokens' : 'auto · gpt-6-sol · tokens', '', ''].join('\\n'));
  else console.log(args.includes('fx-session-three') ? '• Thinking (4s)\\ncodex · gpt-6-sol · tokens' : args.includes('fx-session-four') ? '• Thinking (4s)\\nfooter unavailable' : two ? 'Live assistant answer\\n• Thinking (4s)\\ncodex · gpt-6-sol · tokens' : 'LAST\\nauto · gpt-6-sol · tokens');
}
`);
  await chmod(script, 0o755);
  const port = await freePort();
  const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, HOME: home, FOX_STATE_DIR: join(home, 'state'), TMUX_BIN: script, PORT: String(port), FOX_AUTH_DISABLED: '1', FOX_JOBS_RUNNER: 'external' }, stdio: 'pipe' });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 200; i++) {
      try { ready = (await fetch(`${base}/api/overview`)).ok; if (ready) break; } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(ready, 'server started');
    const before = (await readFile(log, 'utf8')).trim().split('\n').length;
    const overview = await (await fetch(`${base}/api/overview`)).json();
    const overviewCaptures = (await readFile(log, 'utf8')).trim().split('\n').slice(before).map(JSON.parse);
    assert.deepEqual(overviewCaptures, [
      ...['one', 'two', 'three', 'four'].map((id) => ['-p', '-t', `fx-session-${id}`]),
    ], 'overview shares one visible screen per terminal for activity and model');
    const answered = overview.sessions.find((s) => s.id === 'session-one');
    const answering = overview.sessions.find((s) => s.id === 'session-two');
    assert.equal(answered.terminal, 'fx-session-one');
    assert.equal(answered.latestReply.text, 'Last answer');
    assert.equal(answered.model, 'openai/saved-model');
    assert.equal(answered.activeModel, null, 'waiting sessions use the saved reply, not a stale footer');
    assert.equal(answering.state, 'working');
    assert.equal(answering.latestReply, null);
    assert.equal(answering.model, 'openai/old-default');
    assert.equal(answering.activeModel, 'gpt-6-sol');
    const switched = overview.sessions.find((s) => s.id === 'session-three');
    assert.equal(switched.model, 'openai/saved-model');
    assert.equal(switched.activeModel, 'gpt-6-sol', 'current footer wins over the previous answer during work');
    const missingFooter = overview.sessions.find((s) => s.id === 'session-four');
    assert.equal(missingFooter.model, 'openai/saved-model');
    assert.equal(missingFooter.activeModel, null, 'missing footer preserves the saved answer');
    const response = await fetch(`${base}/api/terminals/fx-session-one/snapshot`);
    assert.equal(response.status, 200);
    const { text } = await response.json();
    assert.equal(text.split('\n').length, 32);
    assert.match(text, /LAST\nauto · gpt-6-sol · tokens$/);
    assert.doesNotMatch(text, /\x1b|\x00|line-0\n|old history banner/);
    const live = await (await fetch(`${base}/api/terminals/fx-session-two/snapshot`)).json();
    assert.match(live.text, /Live assistant answer/);
    assert.equal(live.model, 'gpt-6-sol');
    assert.equal((await fetch(`${base}/api/terminals/fx-missing/snapshot`)).status, 404);
    assert.equal((await fetch(`${base}/api/terminals/other/snapshot`)).status, 404);
    const captures = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(captures.find((args) => args.includes('-S')), ['-p', '-J', '-S', '-32', '-t', 'fx-session-one']);
    assert.equal(captures.filter((args) => args.includes('-S')).length, 2); // invalid names never get a snapshot
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    await rm(home, { recursive: true, force: true });
  }
});
