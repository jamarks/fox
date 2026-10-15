import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createTunnel } from '../tunnel.mjs';

function fakeProcess() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null; child.signalCode = null;
  child.kill = (signal) => { child.signalCode = signal; queueMicrotask(() => child.emit('exit', null, signal)); return true; };
  return child;
}

test('waits for tunnel registration, reuses connection, and closes it on demand', async () => {
  const child = fakeProcess();
  let args, disconnected = 0, starts = 0;
  const tunnel = createTunnel({ port: 4851, spawnProcess: (bin, argv) => { starts++; args = [bin, ...argv]; return child; }, onDisconnect: () => disconnected++ });
  const waiting = tunnel.start();
  assert.deepEqual(args, ['cloudflared', 'tunnel', '--url', 'http://127.0.0.1:4851']);
  assert.equal(tunnel.url, null);
  child.stderr.write('https://fox-demo.trycloudflare.com\n');
  assert.equal(tunnel.url, null);
  child.stderr.write('Registered tunnel connection\n');
  assert.equal(await waiting, 'https://fox-demo.trycloudflare.com');
  assert.equal(await tunnel.start(), 'https://fox-demo.trycloudflare.com');
  assert.equal(starts, 1);
  tunnel.stop();
  assert.equal(tunnel.url, null);
  assert.equal(disconnected, 1);
});

test('disconnect and startup failures never produce a usable URL', async () => {
  const child = fakeProcess();
  let disconnected = 0;
  const tunnel = createTunnel({ port: 4851, spawnProcess: () => child, onDisconnect: () => disconnected++ });
  const waiting = tunnel.start();
  child.stderr.write('https://fox-demo.trycloudflare.com\n');
  child.emit('exit', 1, null);
  await assert.rejects(waiting, /exited before connecting/);
  assert.equal(tunnel.url, null);
  const absent = createTunnel({ port: 4851, spawnProcess: () => { const c = fakeProcess(); queueMicrotask(() => c.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' }))); return c; } });
  await assert.rejects(absent.start(), { code: 'ENOENT' });
  assert.equal(absent.url, null);
  assert.equal(disconnected, 0);
});

test('unexpected disconnect clears an established tunnel', async () => {
  const child = fakeProcess();
  let disconnected = 0;
  const tunnel = createTunnel({ port: 4851, spawnProcess: () => child, onDisconnect: () => disconnected++ });
  const waiting = tunnel.start();
  child.stderr.write('https://fox-demo.trycloudflare.com\nRegistered tunnel connection\n');
  await waiting;
  child.emit('exit', 1, null);
  assert.equal(tunnel.url, null);
  assert.equal(disconnected, 1);
});
