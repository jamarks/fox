import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppRegistry, createAppRouter, staticFile, appUrl } from '../apps.mjs';

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

test('an app can be a folder or a command; folders and working dirs stay inside home and out of hidden ones', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fox-home-'));
  const { mkdir, symlink } = await import('node:fs/promises');
  await mkdir(join(home, 'site'));
  await mkdir(join(home, '.ssh'));
  const outside = await mkdtemp(join(tmpdir(), 'fox-outside-'));
  await symlink(outside, join(home, 'external'));
  await symlink(join(home, '.ssh'), join(home, 'private'));
  await symlink(join(home, 'site'), join(home, 'linked'));
  const reg = createAppRegistry({ stateDir: join(home, 'state'), home });
  assert.deepEqual(Object.keys(await reg.set('site', { dir: join(home, 'site') })).sort(), ['createdAt', 'dir', 'name']);
  await assert.rejects(reg.set('keys', { dir: join(home, '.ssh') }), /hidden/);
  await assert.rejects(reg.set('external', { dir: join(home, 'external') }), /inside your home/);
  await assert.rejects(reg.set('private', { dir: join(home, 'private') }), /hidden/);
  assert.equal((await reg.set('linked', { dir: join(home, 'linked') })).dir, join(home, 'site'));
  for (const [name, folder] of [['external', 'external'], ['private', 'private']]) {
    await assert.rejects(reg.set(`${name}-cmd`, { cmd: 'npm start', cwd: join(home, folder), port: 3002 }), /inside your home/);
  }
  const sibling = `${home}-other`;
  await mkdir(sibling);
  await assert.rejects(reg.set('sibling', { dir: sibling }), /inside your home/);
  await symlink(sibling, join(home, 'sibling-link'));
  await assert.rejects(reg.set('sibling-link', { dir: join(home, 'sibling-link') }), /inside your home/);
  await assert.rejects(reg.set('root', { dir: '/etc' }), /inside your home/);
  await assert.rejects(reg.set('home', { dir: home }), /inside your home/);
  await assert.rejects(reg.set('nope', { dir: join(home, 'missing') }), /not a folder/);
  const app = await reg.set('board', { cmd: 'npm start', cwd: join(home, 'site'), port: 3002 });
  assert.equal(app.port, 3002);
  assert.equal(app.cwd, join(home, 'site'));
  assert.equal((await reg.set('linked-cmd', { cmd: 'npm start', cwd: join(home, 'linked'), port: 3003 })).cwd, join(home, 'site'));
  await assert.rejects(reg.set('two', { cmd: 'a\nb', cwd: join(home, 'site'), port: 3003 }), /one line/);
  assert.equal((await reg.setPaused('board', true)).paused, true);
  assert.equal((await reg.setPaused('board', false)).paused, undefined);
});

test('a linked home is resolved before checking and storing app roots', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'fox-apps-'));
  const { mkdir, symlink } = await import('node:fs/promises');
  const home = join(parent, 'home');
  const alias = join(parent, 'alias');
  await mkdir(join(home, 'site'), { recursive: true });
  await symlink(home, alias);
  const reg = createAppRegistry({ stateDir: join(parent, 'state'), home: alias });
  assert.equal((await reg.set('site', { dir: join(alias, 'site') })).dir, join(home, 'site'));
  assert.equal((await reg.set('board', { cmd: 'npm start', cwd: join(alias, 'site'), port: 3002 })).cwd, join(home, 'site'));
});

test('a folder app serves its files, index.html for a folder, and never hidden files or a way out', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fox-home-'));
  const { mkdir, writeFile, symlink } = await import('node:fs/promises');
  await mkdir(join(home, 'site', 'docs'), { recursive: true });
  await mkdir(join(home, 'site', '.private'));
  await mkdir(join(home, 'outside'));
  await writeFile(join(home, 'site', 'index.html'), '<h1>hi</h1>');
  await writeFile(join(home, 'site', 'docs', 'index.html'), 'docs');
  await writeFile(join(home, 'site', '.env'), 'SECRET=1');
  await writeFile(join(home, 'site', '.private', 'secret.txt'), 'hidden');
  await writeFile(join(home, 'outside', 'secret.txt'), 'outside');
  await writeFile(join(home, 'secret.txt'), 'outside file');
  await symlink(join(home, 'secret.txt'), join(home, 'site', 'public.txt'));
  await symlink(join(home, 'outside'), join(home, 'site', 'external'));
  await symlink(join(home, 'site', '.private'), join(home, 'site', 'private'));
  await symlink(join(home, 'site', 'docs'), join(home, 'site', 'more'));
  const reg = createAppRegistry({ stateDir: join(home, 'state'), home });
  await reg.set('site', { dir: join(home, 'site') });
  await reg.set('off', { dir: join(home, 'site') });
  await reg.setPaused('off', true);
  const router = createAppRouter({ registry: reg, domain: 'jwass.xyz' });
  await new Promise((r) => router.listen(0, '127.0.0.1', r));
  const get = (host, path = '/') => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: router.address().port, path, headers: { host } }, (res) => {
    let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => resolve({ status: res.statusCode, body, type: res.headers['content-type'] }));
  }).on('error', reject));
  try {
    assert.deepEqual(await get('site.jwass.xyz'), { status: 200, body: '<h1>hi</h1>', type: 'text/html; charset=utf-8' });
    assert.equal((await get('site.jwass.xyz', '/docs/')).body, 'docs');
    assert.equal((await get('site.jwass.xyz', '/more/')).body, 'docs');
    assert.equal((await get('site.jwass.xyz', '/public.txt')).status, 404);
    assert.equal((await get('site.jwass.xyz', '/external/secret.txt')).status, 404);
    assert.equal((await get('site.jwass.xyz', '/private/secret.txt')).status, 404);
    assert.equal((await get('site.jwass.xyz', '/.env')).status, 404);
    assert.equal((await get('site.jwass.xyz', '/../secret.txt')).status, 404);
    assert.equal((await get('site.jwass.xyz', '/%2e%2e/secret.txt')).status, 404);
    assert.equal((await get('off.jwass.xyz')).status, 503);
  } finally { router.close(); }
});

test('a named pipe in a published folder does not hold a request open', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fox-home-'));
  const { mkdir } = await import('node:fs/promises');
  const site = join(home, 'site');
  await mkdir(join(site, 'docs'), { recursive: true });
  execFileSync('mkfifo', [join(site, 'waiting.txt')]);
  execFileSync('mkfifo', [join(site, 'docs', 'index.html')]);
  const reg = createAppRegistry({ stateDir: join(home, 'state'), home });
  await reg.set('site', { dir: site });
  const router = createAppRouter({ registry: reg, domain: 'jwass.xyz' });
  await new Promise((r) => router.listen(0, '127.0.0.1', r));
  try {
    for (const path of ['/waiting.txt', '/docs/']) {
      const status = await new Promise((resolve, reject) => http.get({
        host: '127.0.0.1', port: router.address().port, path,
        headers: { host: 'site.jwass.xyz' }, signal: AbortSignal.timeout(2000),
      }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject));
      assert.equal(status, 404, path);
    }
  } finally { router.close(); }
});

test('static responses keep the validated open file when its name changes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fox-home-'));
  const { mkdir, writeFile, rename, symlink } = await import('node:fs/promises');
  const site = join(home, 'site');
  await mkdir(site);
  await writeFile(join(site, 'page.txt'), 'published');
  await writeFile(join(home, 'private.txt'), 'private');
  const f = await staticFile(site, '/page.txt');
  assert.ok(f);
  try {
    await rename(join(site, 'page.txt'), join(site, 'old.txt'));
    await symlink(join(home, 'private.txt'), join(site, 'page.txt'));
    assert.equal(await f.handle.readFile({ encoding: 'utf8' }), 'published');
  } finally { await f.handle.close(); }
});

test('reconcile keeps tmux matching the list: starts, restarts what changed, stops paused and removed', async () => {
  const { reconcileApps, appSpecHash } = await import('../apps.mjs');
  const home = await mkdtemp(join(tmpdir(), 'fox-home-'));
  const { mkdir, readFile } = await import('node:fs/promises');
  await mkdir(join(home, 'board'));
  const reg = createAppRegistry({ stateDir: join(home, 'state'), home });
  const sessions = new Map(); // name -> spec
  const calls = [];
  const tmux = async (...args) => {
    calls.push(args.join(' '));
    if (args[0] === 'list-sessions') return [...sessions.keys()].join('\n');
    if (args[0] === 'show-options') return sessions.get(args[2]) ?? '';
    if (args[0] === 'new-session') sessions.set(args[3], '');
    if (args[0] === 'set-option' && args[3] === '@fox_app_spec') sessions.set(args[2], args[4]);
    if (args[0] === 'kill-session') sessions.delete(args[2]);
    return '';
  };
  const logDir = join(home, 'state', 'apps');
  const board = await reg.set('board', { cmd: 'node server.js', cwd: join(home, 'board'), port: 3005 });
  sessions.set('app-stale', 'x'); // an app removed while fox was down
  await reconcileApps({ registry: reg, tmux, logDir });
  assert.deepEqual([...sessions.keys()], ['app-board']);
  assert.equal(sessions.get('app-board'), appSpecHash(board));
  assert.match(await readFile(join(logDir, 'board.sh'), 'utf8'), /export PORT=3005[\s\S]*while :; do[\s\S]*'node server\.js'/);
  calls.length = 0;
  await reconcileApps({ registry: reg, tmux, logDir });
  assert.ok(!calls.some((c) => c.startsWith('new-session') || c.startsWith('kill-session')), 'nothing to do when it already runs');
  await reg.set('board', { cmd: 'node server.js --watch', cwd: join(home, 'board'), port: 3005 });
  await reconcileApps({ registry: reg, tmux, logDir });
  assert.ok(calls.some((c) => c.startsWith('kill-session -t app-board')) && sessions.has('app-board'), 'a changed command restarts');
  await reg.setPaused('board', true);
  await reconcileApps({ registry: reg, tmux, logDir });
  assert.equal(sessions.size, 0);
});
