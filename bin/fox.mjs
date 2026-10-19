#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

const execFileAsync = promisify(execFile);
export async function runFox({
  port = process.env.PORT ?? '4848',
  fetchPage = (url) => fetch(url, { signal: AbortSignal.timeout(2000) }),
  startServer = () => import('../server.mjs'),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  openUrl = async (url) => {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null;
    if (!command) throw new Error('No browser opener available on this platform');
    await execFileAsync(command, [url]);
  },
  // A server has no screen: say where to open fox instead of failing on a missing xdg-open.
  headless = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  if (!/^[0-9]+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) {
    stderr.write('Invalid PORT: expected a number from 1 to 65535.\n');
    return 1;
  }
  const url = `http://127.0.0.1:${Number(port)}/`;
  const probe = async () => {
    try {
      const response = await fetchPage(url);
      return response.ok && (await response.text()).includes('<title>fox</title>') ? 'fox' : 'other';
    } catch { return 'offline'; }
  };
  let status = await probe();
  if (status === 'other') {
    stderr.write(`The server at ${url} is not fox. Check PORT before opening it.\n`);
    return 1;
  }
  if (status === 'offline') {
    try { await startServer(); }
    catch (error) { stderr.write(`Could not start fox: ${error.message}\n`); return 1; }
    for (let attempt = 0; attempt < 30; attempt++) {
      status = await probe();
      if (status !== 'offline') break;
      await wait(100);
    }
    if (status !== 'fox') {
      stderr.write(`fox did not start at ${url}${status === 'other' ? ' (port occupied by another app)' : ''}.\n`);
      return 1;
    }
    stdout.write(`fox running at ${url} · Ctrl+C stops the panel, not fx sessions.\n`);
  }
  if (headless) {
    stdout.write(`No browser on this machine. To use fox from your other devices, open http://127.0.0.1:${Number(port)} through a tunnel: https://github.com/jamarks/fox#install-and-run\n`);
    return 0;
  }
  try { await openUrl(url); }
  catch (error) {
    stderr.write(`Could not open the browser: ${error.message}\nOpen ${url} manually.\n`);
    return 1;
  }
  stdout.write(`Opened ${url}\n`);
  return 0;
}

// npm installs `fox` as a symlink to this file: compare real paths, or the command quietly does nothing.
const invokedPath = (() => { try { return realpathSync(process.argv[1]); } catch { return null; } })();
if (process.argv[1] && invokedPath === realpathSync(fileURLToPath(import.meta.url))) {
  if (process.argv.length !== 2) {
    process.stderr.write('Usage: fox\n');
    process.exitCode = 1;
  } else process.exitCode = await runFox();
}
