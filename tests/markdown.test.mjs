import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const ctx = {};
vm.runInNewContext(readFileSync(new URL('../public/markdown.js', import.meta.url), 'utf8') + '\nthis.md = renderMarkdown;', ctx);
const md = ctx.md;

test('fx answers render as formatted text', () => {
  assert.equal(md('**Una distinción:** hola *ahí*'), '<p><strong>Una distinción:</strong> hola <em>ahí</em></p>');
  assert.equal(md('uno\ndos\n\ntres'), '<p>uno<br>dos</p><p>tres</p>');
  assert.equal(md('## Plan'), '<h4>Plan</h4>');
  assert.equal(md('- a\n- **b**'), '<ul><li>a</li><li><strong>b</strong></li></ul>');
  assert.equal(md('2. dos\n3. tres'), '<ol start="2"><li>dos</li><li>tres</li></ol>');
  assert.equal(md('| Métrica | Qué |\n|---|---|\n| Capital | Depósitos |'),
    '<div class="md-table"><table><thead><tr><th>Métrica</th><th>Qué</th></tr></thead><tbody><tr><td>Capital</td><td>Depósitos</td></tr></tbody></table></div>');
  assert.equal(md('```\nconst a = 1 * 2 * 3;\n```'), '<pre><code>const a = 1 * 2 * 3;</code></pre>');
  assert.equal(md('usá `fox-job **list**`'), '<p>usá <code>fox-job **list**</code></p>');
  assert.equal(md('> ojo'), '<blockquote><p>ojo</p></blockquote>');
  assert.equal(md('snake_case_name y 2 * 3 = 6'), '<p>snake_case_name y 2 * 3 = 6</p>');
});

test('links are made only for web addresses, and text never becomes markup', () => {
  assert.equal(md('mirá https://github.com/jamarks/fox/pull/1.'), '<p>mirá <a href="https://github.com/jamarks/fox/pull/1" target="_blank" rel="noopener">https://github.com/jamarks/fox/pull/1</a>.</p>');
  assert.equal(md('[el PR](https://github.com/o/r/pull/2)'), '<p><a href="https://github.com/o/r/pull/2" target="_blank" rel="noopener">el PR</a></p>');
  assert.equal(md('"https://x.example/a"'), '<p>&quot;<a href="https://x.example/a" target="_blank" rel="noopener">https://x.example/a</a>&quot;</p>');
  assert.equal(md('[x](javascript:alert(1))'), '<p>[x](javascript:alert(1))</p>');
  assert.equal(md('<img src=x onerror=alert(1)> **<b>**'), '<p>&lt;img src=x onerror=alert(1)&gt; <strong>&lt;b&gt;</strong></p>');
  assert.equal(md('| <script> |\n|---|\n| a |').includes('<script>'), false);
});
