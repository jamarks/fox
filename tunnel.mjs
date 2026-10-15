import { spawn } from 'node:child_process';

// Quick Tunnels are temporary. Never treat a printed URL as live until the edge registers the connection.
export function createTunnel({ port, bin = process.env.CLOUDFLARED_BIN || 'cloudflared', spawnProcess = spawn, onDisconnect = () => {}, timeoutMs = 45000 } = {}) {
  let child = null, url = null, pending = null;
  function stop() {
    const current = child;
    child = null; url = null;
    if (current && current.exitCode === null && current.signalCode === null) current.kill('SIGTERM');
    onDisconnect();
  }
  function start() {
    if (url && child && child.exitCode === null && child.signalCode === null) return Promise.resolve(url);
    if (pending) return pending;
    pending = new Promise((resolve, reject) => {
      let proc;
      try { proc = spawnProcess(bin, ['tunnel', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (error) { pending = null; reject(error); return; }
      child = proc;
      let candidate = null, registered = false, logs = '', settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true; clearTimeout(timer); pending = null;
        if (error) { if (child === proc) { child = null; url = null; } proc.kill('SIGTERM'); reject(error); }
        else { url = candidate; resolve(url); }
      };
      const consume = (chunk) => {
        logs = (logs + chunk.toString()).slice(-16000);
        const match = logs.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i);
        if (match) candidate = match[0];
        if (/Registered tunnel connection/.test(logs)) registered = true;
        if (candidate && registered) finish();
      };
      proc.stdout?.on('data', consume);
      proc.stderr?.on('data', consume);
      proc.once('error', (error) => finish(error));
      proc.once('exit', () => {
        if (!settled) finish(new Error('cloudflared exited before connecting. Check your network or VPN.'));
        else if (child === proc) { child = null; url = null; onDisconnect(); }
      });
      const timer = setTimeout(() => finish(new Error('Cloudflare did not connect within 45 seconds. Check your network or VPN.')), timeoutMs);
    });
    return pending;
  }
  return { start, stop, get url() { return url; }, get running() { return Boolean(child && url); } };
}
