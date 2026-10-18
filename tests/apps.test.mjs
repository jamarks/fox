import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppRegistry, createAppRouter, appUrl } from '../apps.mjs';

test('names are checked, fox and its ports stay out', async () => {
  const reg = createAppRegistry({ stateDir: await mkdtemp(join(tmpdir(), 'fox-apps-')), denyPorts: [4848, 4850] });
  await assert.rejects(reg.set('Folio App', 3001), /lowercase/);
  await assert.rejects(reg.set('fox', 3001), /taken/);
  await assert.rejects(reg.set('fox-3001', 3001), /taken/);
  await assert.rejects(reg.set('folio', 80), /1024/);
  await assert.rejects(reg.set('folio', 4848), /fox itself/);
  const app = await reg.set('folio', '3001');
  assert.equal(app.port, 3001);
  assert.equal((await stat(reg.file)).mode & 0o777, 0o600);
  assert.deepEqual((await reg.list()).map((a) => [a.name, a.port]), [['folio', 3001]]);
  assert.equal(await reg.remove('folio'), true);
  assert.equal(await reg.remove('folio'), false);
  assert.equal(appUrl('https://{name}.jwass.xyz', 'folio'), 'https://folio.jwass.xyz');
});

test('the router forwards by name, as localhost, and says when an app is missing or down', async () => {
  const reg = createAppRegistry({ stateDir: await mkdtemp(join(tmpdir(), 'fox-apps-')) });
  const app = http.createServer((req, res) => res.end(`${req.method} ${req.url} host=${req.headers.host} fwd=${req.headers['x-forwarded-host']}`));
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  await reg.set('folio', app.address().port);
  await reg.set('gone', 65000);
  const router = createAppRouter({ registry: reg, domain: 'jwass.xyz' });
  await new Promise((r) => router.listen(0, '127.0.0.1', r));
  const get = (host, path = '/') => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: router.address().port, path, headers: { host } }, (res) => {
    let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject));
  try {
    assert.deepEqual(await get('folio.jwass.xyz', '/api/x?y=1'), { status: 200, body: 'GET /api/x?y=1 host=localhost fwd=folio.jwass.xyz' });
    assert.equal((await get('nope.jwass.xyz')).status, 404);
    assert.match((await get('nope.jwass.xyz')).body, /fox-expose nope/);
    assert.equal((await get('folio.evil.example')).status, 404, 'only names under the domain');
    assert.equal((await get('gone.jwass.xyz')).status, 502);
  } finally { router.close(); app.close(); }
});

test('the router keeps Cloudflare Access proof from the app, and never reaches a port fox denies', async () => {
  const reg = createAppRegistry({ stateDir: await mkdtemp(join(tmpdir(), 'fox-apps-')) });
  const app = http.createServer((req, res) => res.end(JSON.stringify({ cookie: req.headers.cookie ?? null, jwt: req.headers['cf-access-jwt-assertion'] ?? null })));
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  await reg.set('folio', app.address().port);
  const router = createAppRouter({ registry: reg, domain: 'jwass.xyz' });
  const guarded = createAppRouter({ registry: reg, domain: 'jwass.xyz', denyPorts: [app.address().port] });
  await new Promise((r) => router.listen(0, '127.0.0.1', r));
  await new Promise((r) => guarded.listen(0, '127.0.0.1', r));
  const get = (port, headers) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: '/', headers: { host: 'folio.jwass.xyz', ...headers } }, (res) => {
    let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject));
  try {
    const r = await get(router.address().port, { cookie: 'CF_Authorization=secret; theme=dark', 'cf-access-jwt-assertion': 'secret' });
    assert.deepEqual(JSON.parse(r.body), { cookie: 'theme=dark', jwt: null });
    assert.equal((await get(guarded.address().port, {})).status, 404, 'apps.json pointing at fox is not followed');
  } finally { router.close(); guarded.close(); app.close(); }
});
