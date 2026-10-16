import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createViewTokens, rewriteRootLinks } from '../view.mjs';

const root = '/work/app';
const tokenOf = (url) => url.split('/')[2];

test('a page link reaches files next to it and in the project, nothing else', () => {
  const v = createViewTokens();
  const t = tokenOf(v.issue(root, '/work/app/public/enroll.html'));
  assert.deepEqual(v.candidates(t, 'enroll.css'), ['/work/app/public/enroll.css', '/work/app/enroll.css']);
  assert.deepEqual(v.candidates(t, '../../etc/passwd.txt'), []); // outside the project
  assert.deepEqual(v.candidates(t, '.env'), []);
  assert.deepEqual(v.candidates(t, '.git/config.txt'), []);
  assert.deepEqual(v.candidates(t, 'secrets.pem'), []); // not a type pages load
  assert.equal(v.candidates('nope', 'enroll.css'), null);
});

test('links expire and are reused while alive', () => {
  let clock = 0;
  const v = createViewTokens({ ttlMs: 1000, now: () => clock });
  const a = v.issue(root, '/work/app/x.html');
  assert.equal(v.issue(root, '/work/app/x.html'), a);
  clock = 5000;
  assert.equal(v.candidates(tokenOf(a), 'x.html'), null);
  assert.notEqual(v.issue(root, '/work/app/x.html'), a);
});

test('root-relative links in HTML and CSS stay inside the preview', () => {
  const html = rewriteRootLinks('<link href="/style.css"><script src="/app.js"></script><a href="//cdn.example/x">', 'T', 'text/html; charset=utf-8');
  assert.equal(html, '<link href="/view/T/style.css"><script src="/view/T/app.js"></script><a href="//cdn.example/x">');
  assert.equal(rewriteRootLinks('a{background:url("/bg.png")}', 'T', 'text/css'), 'a{background:url("/view/T/bg.png")}');
});
