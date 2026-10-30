import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const section = source.slice(source.indexOf('let filesCollapsed = false;'), source.indexOf("$('#transcript').addEventListener('click'"));
const ctx = { localStorage: { getItem: () => '0' }, esc: (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;'), hasPreview: () => false, defaultMode: () => 'code' };
vm.createContext(ctx);
vm.runInContext(section, ctx);

test('file diagnostics stay beside their file, escaped; passing checks add nothing', () => {
  const f = { path: '/repo/a.js', rel: 'a.js', action: 'write', exists: true, by: [0], mtime: 1 };
  ctx.f = [f];
  ctx.c = { count: 1, problems: [{ path: f.path, lines: ['a.js:1 <bad>'] }] };
  const clean = vm.runInContext('filesSection("s", f, {count: 0, problems: []})', ctx);
  const failed = vm.runInContext('filesSection("s", f, c)', ctx);
  assert.doesNotMatch(clean, /check-dot|file-check/);
  assert.match(failed, /check-dot/);
  assert.match(failed, /a.js:1 &lt;bad>/);
  assert.doesNotMatch(failed, /<bad>/);
});
