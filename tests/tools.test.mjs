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
});
