import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTranscript, createClaude } from '../harnesses/claude.mjs';
import { createFx } from '../harnesses/fx.mjs';

// Claude Code transcript lines, shaped like the real ones (one record per content block, usage repeated).
const at = (s) => `2026-10-22T00:00:${String(s).padStart(2, '0')}.000Z`;
const user = (text, s, extra = {}) => ({ type: 'user', timestamp: at(s), cwd: '/w', message: { role: 'user', content: text }, ...extra });
const assistant = (id, block, stop, s, model = 'claude-opus-5-5') => ({ type: 'assistant', timestamp: at(s), message: { id, model, stop_reason: stop, content: [block], usage: { input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 100 } } });
const result = (toolUseId, text, s, isError = false) => ({ type: 'user', timestamp: at(s), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: isError }] } });
const lines = (...recs) => recs.map((r) => JSON.stringify(r)).join('\n') + '\n';

const TRANSCRIPT = lines(
  { type: 'queue-operation', operation: 'enqueue' },
  user('Make a page', 1),
  { type: 'attachment', attachment: {} },
  assistant('m1', { type: 'thinking', thinking: '…' }, 'tool_use', 2),
  assistant('m1', { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/w/a.html', content: '<h1>' } }, 'tool_use', 2),
  result('t1', 'File created', 3),
  assistant('m2', { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' } }, 'tool_use', 4),
  result('t2', 'boom', 5, true),
  assistant('m3', { type: 'text', text: 'Done: `a.html`' }, 'end_turn', 6),
  user('<command-name>/model</command-name><command-args>haiku</command-args>', 7),
  user('<local-command-stdout>Set model</local-command-stdout>', 7),
  user('meta', 7, { isMeta: true }),
  user('Now a subagent', 8),
  assistant('m4', { type: 'tool_use', id: 't3', name: 'Agent', input: { prompt: 'Look around', description: 'Explore', subagent_type: 'Explore' } }, 'tool_use', 9),
  result('t3', 'found it', 10),
  assistant('m5', { type: 'text', text: 'First part' }, 'end_turn', 11),
  assistant('m5', { type: 'text', text: 'Second part' }, 'end_turn', 11),
  user('<task-notification>done</task-notification>', 11, { promptSource: 'system' }),
  user('Stop', 12, { promptSource: 'typed' }),
  user('[Request interrupted by user]', 13),
  assistant('m6', { type: 'text', text: 'No response requested.' }, 'stop_sequence', 14, '<synthetic>'),
  { type: 'custom-title', customTitle: 'Pages' },
  '{"type":"assistant","message":', // a half-written last line
);

test('a Claude Code transcript becomes fox events: turns, tools with their effect, prompts without wrappers', () => {
  const { events, info } = parseTranscript(TRANSCRIPT);
  assert.deepEqual(events.map((e) => e.kind), ['user', 'tool_call', 'tool_call', 'assistant', 'turn_completed', 'user', 'user', 'tool_call', 'assistant', 'assistant', 'turn_completed', 'user', 'interrupted']);
  const [write, bash] = events.filter((e) => e.kind === 'tool_call');
  assert.deepEqual([write.name, write.effect, write.path, write.result.status], ['Write', 'write', '/w/a.html', 'ok']);
  assert.deepEqual([bash.effect, bash.path, bash.result.status, bash.result.preview], ['shell', null, 'error', 'boom']);
  assert.equal(events[5].text, '/model haiku'); // a slash command reads as typed; its output and meta lines are not prompts
  assert.equal(events.filter((e) => e.kind === 'turn_completed').length, 2); // one per answered turn, not one per block
  assert.equal(info.title, 'Pages');
  assert.equal(info.firstPrompt, 'Make a page');
  assert.equal(info.turns, 4);
  assert.equal(info.model, 'claude-opus-5-5'); // the synthetic resume message is not the model
  assert.equal(info.lastKind, 'interrupted');
  assert.deepEqual(info.latestReply, { text: 'Second part', messageIndex: 5, turn: 2, at: Date.parse(at(11)) });
  assert.deepEqual(info.usage, { input: 75, output: 35, cacheRead: 500, cost: 0, wallMs: 0 }); // usage once per message
  assert.deepEqual(info.subagentCalls.map((c) => [c.prompt, c.type, c.done.ok]), [['Look around', 'Explore', true]]);
  assert.ok(!events.some((e) => e.text === 'No response requested.'));
});

test('fox lists only the Claude Code sessions it launched, finds their transcripts, and resumes or restarts them', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'fox-claude-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const projectsDir = join(home, 'projects'), stateDir = join(home, 'state'), cwd = join(home, 'work dir');
  const claude = createClaude({ bin: '/bin/claude', stateDir, projectsDir, liveDir: join(home, 'live'), env: {} });
  // Someone else's session in the same folder never shows.
  await mkdir(join(projectsDir, cwd.replace(/[^A-Za-z0-9]/g, '-')), { recursive: true });
  await writeFile(join(projectsDir, cwd.replace(/[^A-Za-z0-9]/g, '-'), '11111111-1111-4111-8111-111111111111.jsonl'), TRANSCRIPT);

  const first = await claude.launch({ cwd, model: 'sonnet', addDirs: ['/repo/b'] });
  assert.match(first.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(first.argv, ['/bin/claude', '--session-id', first.id, '--model', 'sonnet', '--add-dir', '/repo/b']);
  await assert.rejects(claude.launch({ cwd, model: 'gpt-5' }), /Unknown model/);
  assert.equal(JSON.parse(await readFile(join(stateDir, 'claude-sessions.json'), 'utf8'))[first.id].cwd, cwd);

  // Before its first message there is no transcript: listed as new, and reopened with the same id.
  let [row] = await claude.listSessions();
  assert.deepEqual([row.id, row.title, row.model, row.workspace, row.turns], [first.id, '(untitled)', 'sonnet', cwd, 0]);
  assert.deepEqual((await claude.launch({ cwd, resume: first.id })).argv, ['/bin/claude', '--session-id', first.id]);

  const dir = join(projectsDir, cwd.replace(/[^A-Za-z0-9]/g, '-'));
  await writeFile(join(dir, `${first.id}.jsonl`), TRANSCRIPT);
  await mkdir(join(dir, first.id, 'subagents'), { recursive: true });
  await writeFile(join(dir, first.id, 'subagents', 'agent-a1b2c3d4e5f6a7b8c.jsonl'), lines(
    user('Look around', 9, { isSidechain: true }),
    assistant('s1', { type: 'text', text: 'found it' }, 'end_turn', 10),
  ));
  const rows = await claude.listSessions();
  row = rows.find((r) => r.id === first.id);
  assert.deepEqual([row.title, row.model, row.turns, row.latestReply.text], ['Pages', 'claude-opus-5-5', 4, 'Second part']);
  assert.deepEqual(row.children.map((c) => [c.id, c.kind, c.name, c.phase, c.task, c.outcome, c.answer]), [[`${first.id}-a1b2c3d4e5f6a7b8c`, 'Explore', null, 'finished', 'Explore', 'completed', 'found it']]);
  const child = rows.find((r) => r.parentId === first.id);
  assert.equal(child.subagentChild, true);
  assert.ok(claude.has(child.id) && claude.has(first.id) && !claude.has('11111111-1111-4111-8111-111111111111'));
  assert.deepEqual((await claude.events(child.id)).map((e) => e.kind), ['user', 'assistant', 'turn_completed']); // a subagent's own records
  assert.deepEqual((await claude.launch({ cwd, resume: first.id })).argv, ['/bin/claude', '--resume', first.id]);
  // A background agent: the parent's call already answered, its own transcript still going.
  await writeFile(join(dir, first.id, 'subagents', 'agent-afffffffffffffff0.jsonl'), lines(user('Keep going', 9, { isSidechain: true }), assistant('s2', { type: 'tool_use', id: 'x', name: 'Read', input: {} }, 'tool_use', 10)));
  let bg = (await claude.listSessions()).find((r) => r.id === first.id).children.find((c) => c.id.endsWith('afffffffffffffff0'));
  assert.deepEqual([bg.phase, bg.outcome, bg.answer], ['running', null, null]);
  // It hands its report back and Claude Code marks it finished.
  await writeFile(join(dir, first.id, 'subagents', 'agent-afffffffffffffff0.jsonl'), lines(user('Keep going', 9, { isSidechain: true }), assistant('s2', { type: 'tool_use', id: 'x', name: 'SubagentHandback', input: { message: 'All read' } }, 'tool_use', 10)));
  await writeFile(join(dir, first.id, 'subagents', 'agent-afffffffffffffff0.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Read all', finished: true }));
  bg = (await claude.listSessions()).find((r) => r.id === first.id).children.find((c) => c.id.endsWith('afffffffffffffff0'));
  assert.deepEqual([bg.kind, bg.task, bg.phase, bg.outcome, bg.answer], ['general-purpose', 'Read all', 'finished', 'completed', 'All read']);
});

test('a fox started inside a Claude Code session does not pass that session on to the claude it launches', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'fox-claude-env-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const claude = createClaude({ bin: 'claude', stateDir: home, projectsDir: home, env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', ANTHROPIC_BASE_URL: 'https://proxy', PATH: '/bin' } });
  const { argv, id } = await claude.launch({ cwd: home });
  assert.deepEqual(argv, ['env', '-u', 'CLAUDECODE', '-u', 'CLAUDE_CODE_SESSION_ID', '-u', 'ANTHROPIC_BASE_URL', 'claude', '--session-id', id]);
});

test('fx preserves snapshot presence and file freshness separately from zero token counts', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fox-usage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const id of ['parent', 'child', 'empty']) {
    await mkdir(join(dir, id));
    await writeFile(join(dir, id, 'session.json'), JSON.stringify({ title: id, created_at_ms: 1 }));
  }
  await writeFile(join(dir, 'empty', 'usage-v2.json'), JSON.stringify({ snapshot: {} }));
  await writeFile(join(dir, 'child', 'usage-v2.json'), JSON.stringify({ snapshot: { input_tokens: 3, output_tokens: 2, cache_read_tokens: 8 } }));
  const rows = await createFx({ sessionsDir: dir, bin: 'fx' }).listSessions();
  assert.equal(rows.find((s) => s.id === 'parent').usage.savedAt, null);
  assert.equal(rows.find((s) => s.id === 'empty').usage.savedAt, null);
  assert.deepEqual([rows.find((s) => s.id === 'child').usage.input, rows.find((s) => s.id === 'child').usage.cacheRead], [3, 8]);
  assert.ok(rows.find((s) => s.id === 'child').usage.savedAt > 0);
});

test('each harness reads its own screen: working, waiting for an answer, or ready for a message', () => {
  const claude = createClaude({ bin: 'claude', stateDir: tmpdir(), env: {} });
  assert.equal(claude.activity('❯ make it\n✻ Churning… (3s · esc to interrupt)\n❯ \n  ⏵⏵ auto mode on · esc to interrupt'), 'working');
  assert.equal(claude.activity(' Do you want to create a.html?\n ❯ 1. Yes\n   2. No\n Esc to cancel'), 'needs_input');
  assert.equal(claude.activity(' Is this a project you trust?\n ❯ No, exit\n Enter to confirm · Esc to cancel'), 'needs_input');
  assert.equal(claude.activity('⏺ Done.\n────\n❯ \n────\n  ⏵⏵ auto mode on (shift+tab to cycle)'), 'ready');
  assert.ok(claude.ready('────\n❯ \n────'));
  assert.equal(claude.screenModel('▝▜██████▀  Haiku 5.5 · Claude Max'), 'Haiku 5.5');
  const fx = createFx({ sessionsDir: tmpdir(), bin: 'fx' });
  assert.equal(fx.activity('• Thinking (4s)'), 'working');
  // Captured on a server: the "•" blinks, and past a minute the time reads "1m0s".
  for (const line of ['  Running (47s) (↑29 ↓90)', '• Running (49s) (↑29 ↓90)', '  Running (1m0s) (↑29 ↓90)', '• Running (1m2s) (↑29 ↓90)', '  Thinking (1h2m3s)']) {
    assert.equal(fx.activity(`● 1 tool call · 1 command\n${line}\n┃\nauto · gpt-6.1-sol · 7k/500k 1%`), 'working', line);
  }
  assert.equal(fx.activity('● 1 tool call · 1 command\n  DONE-AFTER-SLEEP\n  2m 7s (↑38 ↓100)\n┃\nauto · gpt-6.1-sol'), 'ready', 'a finished turn');
  assert.equal(fx.activity('  It should take a while (5s or so).\n┃'), 'ready', 'a reply that mentions seconds');
  assert.equal(fx.activity('┃\nauto · gpt · codex'), 'ready');
  assert.ok(fx.ready('┃'));
});

test('fx sessions keep their files on disk and get the same tool effects as any harness', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fox-fx-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'abcd1234'));
  await writeFile(join(dir, 'abcd1234', 'session.json'), JSON.stringify({ title: 'T', workspace_root: '/w', created_at_ms: 1, updated_at_ms: 2 }));
  await writeFile(join(dir, 'abcd1234', 'events.jsonl'), [
    { timestamp_ms: 1, event: { user: { text: 'hi' } } },
    { timestamp_ms: 2, event: { tool_call: { call_id: 'c', tool_name: 'write_file', arguments_json: '{"path":"a.md"}' } } },
    { timestamp_ms: 3, event: { tool_result: { call_id: 'c', status: 'ok' } } },
    { timestamp_ms: 4, event: { assistant: { text: 'ok' } } },
    { timestamp_ms: 5, event: { turn_completed: {} } },
  ].map((x) => JSON.stringify(x)).join('\n'));
  const fx = createFx({ sessionsDir: dir, bin: '/bin/fx' });
  const call = (await fx.events('abcd1234')).find((e) => e.kind === 'tool_call');
  assert.deepEqual([call.effect, call.path, call.result.status], ['write', 'a.md', 'ok']);
  const [s] = await fx.listSessions();
  assert.deepEqual([s.id, s.title, s.workspace, s.turns, s.latestReply.text], ['abcd1234', 'T', '/w', 1, 'ok']);
  assert.ok(fx.has('abcd1234') && !fx.has('nope1234'));
  assert.deepEqual(fx.launch({ resume: 'abcd1234' }), { argv: ['/bin/fx', 'session', 'resume', 'abcd1234'], id: 'abcd1234' });
  assert.deepEqual(fx.launch({ flags: ['--model', 'x'] }), { argv: ['/bin/fx', '--model', 'x'], id: null });
});

test('fox knows whether Claude Code is signed in, from `claude auth status`', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fox-claude-auth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = (name, out) => writeFile(join(dir, name), `#!/bin/sh\n[ "$1 $2" = "auth status" ] && echo '${out}'\n`, { mode: 0o755 });
  await fake('in', '{"loggedIn": true, "authMethod": "claude.ai"}');
  await fake('out', '{"loggedIn": false, "authMethod": "none"}');
  assert.equal(await createClaude({ bin: join(dir, 'in'), stateDir: dir, env: { PATH: '/bin:/usr/bin' } }).signedIn(), true);
  assert.equal(await createClaude({ bin: join(dir, 'out'), stateDir: dir, env: { PATH: '/bin:/usr/bin' } }).signedIn(), false);
  assert.equal(await createClaude({ bin: join(dir, 'missing'), stateDir: dir, env: { PATH: '/bin:/usr/bin' } }).signedIn(), false);
});

test('Claude Code tools live in its user config: fox reads them there and adds or removes them with its CLI', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fox-claude-mcp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls');
  await writeFile(join(dir, 'claude'), `#!/bin/sh\necho "$@" >> '${log}'\n`, { mode: 0o755 });
  const configFile = join(dir, 'claude.json');
  const claude = createClaude({ bin: join(dir, 'claude'), stateDir: dir, configFile, env: { PATH: '/bin:/usr/bin' } });
  assert.deepEqual(await claude.mcp.servers(), {});
  await writeFile(configFile, JSON.stringify({ mcpServers: { pw: { type: 'stdio', command: 'npx', args: ['@playwright/mcp@latest'] } } }));
  assert.deepEqual(Object.keys(await claude.mcp.servers()), ['pw']);
  await claude.mcp.add({ name: 'playwright', command: ['npx', '@playwright/mcp@latest'] });
  await claude.mcp.add({ name: 'docs', url: 'https://mcp.context7.com/mcp' });
  await claude.mcp.remove('pw');
  assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), [
    'mcp add --scope user playwright -- npx @playwright/mcp@latest',
    'mcp add --scope user --transport http docs https://mcp.context7.com/mcp',
    'mcp remove --scope user pw',
  ]);
});
