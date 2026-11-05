import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, isInstalled, addArgs } from '../tools.mjs';

const browser = TOOLS.find((t) => t.id === 'browser');

test('browser tool is missing from an empty or absent fx config', () => {
  assert.equal(isInstalled(browser, null), false);
  assert.equal(isInstalled(browser, { mcp: {} }), false);
});

test('browser tool is found by name or by package under another name', () => {
  assert.equal(isInstalled(browser, { mcp: { playwright: { command: ['npx', '@playwright/mcp@latest'] } } }), true);
  assert.equal(isInstalled(browser, { mcp: { web: { command: ['npx', '-y', '@playwright/mcp'] } } }), true);
  assert.equal(isInstalled(browser, { mcp: { slack: { type: 'remote', url: 'https://example.com/mcp' } } }), false);
});

test('docs tool is found by URL under any name', () => {
  const docs = TOOLS.find((t) => t.id === 'docs');
  assert.equal(isInstalled(docs, { mcp: { c7: { type: 'http', url: 'https://mcp.context7.com/mcp' } } }), true);
});

test('add arguments: local command or remote HTTP server', () => {
  assert.deepEqual(addArgs(TOOLS.find((t) => t.id === 'browser')), ['mcp', 'add', 'playwright', 'npx', '@playwright/mcp@latest']);
  assert.deepEqual(addArgs(TOOLS.find((t) => t.id === 'docs')), ['mcp', 'add', '--transport', 'http', 'docs', 'https://mcp.context7.com/mcp']);
  assert.deepEqual(addArgs(TOOLS.find((t) => t.id === 'vercel')), ['mcp', 'add', '--transport', 'http', 'vercel', 'https://mcp.vercel.com']);
  const linear = TOOLS.find((t) => t.id === 'linear');
  assert.deepEqual(addArgs(linear), ['mcp', 'add', '--transport', 'http', 'linear', 'https://mcp.linear.app/mcp']);
  assert.ok(isInstalled(linear, { mcp: { work: { type: 'http', url: 'https://mcp.linear.app/mcp', bearer_token_env: 'LINEAR_API_KEY' } } }), 'a Linear set up by hand with a key counts as installed');
});

test('a tool turns off and on through its enabled flag, keeping its own setup', async () => {
  const { TOOLS, isEnabled, withEnabled } = await import('../tools.mjs');
  const browser = TOOLS.find((t) => t.id === 'browser');
  // Set up on a server to run without npx, under its own name: still recognized, and kept as is.
  const config = { mcp: { playwright: { type: 'local', command: ['/usr/bin/node', '/opt/tools/@playwright/mcp/cli.js', '--headless'], enabled: true }, docs: { url: 'https://mcp.context7.com/mcp' } } };
  assert.equal(isEnabled(browser, config), true);
  const off = withEnabled(config, browser, false);
  assert.equal(isEnabled(browser, off), false);
  assert.deepEqual(off.mcp.playwright.command, config.mcp.playwright.command);
  assert.deepEqual(off.mcp.docs, config.mcp.docs, 'other tools untouched');
  assert.equal(config.mcp.playwright.enabled, true, 'the original is not changed');
  assert.equal(isEnabled(browser, withEnabled(off, browser, true)), true);
  assert.equal(isEnabled(TOOLS.find((t) => t.id === 'docs'), config), true, 'no flag means on');
  assert.throws(() => withEnabled({ mcp: {} }, browser, false), /does not have/);
  assert.equal(isEnabled(browser, { mcp: {} }), false);
});

test('every matching alias follows the switch, and the displayed state follows any active entry', async () => {
  const { isEnabled, withEnabled } = await import('../tools.mjs');
  const config = { mcp: {
    webA: { command: ['npx', '@playwright/mcp@latest'], enabled: true },
    webB: { command: ['/opt/@playwright/mcp/cli.js'] },
    docs: { url: 'https://mcp.context7.com/mcp' },
  } };
  const partlyOff = { mcp: { ...config.mcp, webA: { ...config.mcp.webA, enabled: false } } };
  assert.equal(isEnabled(browser, partlyOff), true, 'another active alias keeps the tool on');
  const off = withEnabled(config, browser, false);
  assert.equal(off.mcp.webA.enabled, false);
  assert.equal(off.mcp.webB.enabled, false);
  assert.equal(isEnabled(browser, off), false, 'the displayed state is off only when all matches are off');
  assert.deepEqual(off.mcp.docs, config.mcp.docs);
  assert.equal(config.mcp.webB.enabled, undefined, 'the original config is unchanged');
  const on = withEnabled(off, browser, true);
  assert.equal(on.mcp.webA.enabled, true);
  assert.equal(on.mcp.webB.enabled, true);
  assert.equal(isEnabled(browser, on), true);
});

test('all matching remote aliases switch without changing unrelated servers or credentials', async () => {
  const { withEnabled, isEnabled } = await import('../tools.mjs');
  const linear = TOOLS.find((t) => t.id === 'linear');
  const config = { mcp: {
    work: { type: 'http', url: 'https://mcp.linear.app/mcp', bearer_token_env: 'LINEAR_API_KEY' },
    issues: { type: 'http', url: 'https://mcp.linear.app/mcp', enabled: false },
    docs: { type: 'http', url: 'https://mcp.context7.com/mcp' },
  } };
  const off = withEnabled(config, linear, false);
  assert.equal(isEnabled(linear, off), false);
  assert.deepEqual(off.mcp.work, { ...config.mcp.work, enabled: false });
  assert.deepEqual(off.mcp.issues, config.mcp.issues);
  assert.deepEqual(off.mcp.docs, config.mcp.docs);
  const on = withEnabled(off, linear, true);
  assert.equal(isEnabled(linear, on), true);
  assert.equal(on.mcp.work.bearer_token_env, 'LINEAR_API_KEY');
  assert.equal(on.mcp.issues.enabled, true);
});

test('the canonical server and matching aliases are switched together', async () => {
  const { isEnabled, withEnabled } = await import('../tools.mjs');
  const config = { mcp: {
    playwright: { command: ['custom-browser'], enabled: false },
    web: { command: ['npx', '@playwright/mcp@latest'] },
  } };
  assert.equal(isEnabled(browser, config), true);
  const off = withEnabled(config, browser, false);
  assert.equal(off.mcp.playwright.enabled, false);
  assert.equal(off.mcp.web.enabled, false);
  assert.equal(isEnabled(browser, off), false);
  const on = withEnabled(off, browser, true);
  assert.equal(on.mcp.playwright.enabled, true);
  assert.equal(on.mcp.web.enabled, true);
  assert.equal(isEnabled(browser, on), true);
});
