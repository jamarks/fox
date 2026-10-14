import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, isInstalled } from '../tools.mjs';

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
