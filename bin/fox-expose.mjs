#!/usr/bin/env node
// fox-expose: give something on this machine its own private address, https://<name>.<domain>: a server on a
// port, a folder of static files fox serves, or a command fox keeps running. Same list fox's router reads
// (apps.json), so it works at once; fox's Apps page shows the same list. See apps.mjs.
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { createAppRegistry, appUrl, appKind, reconcileApps } from '../apps.mjs';

// fox's settings: the environment, else the server's config file (an SSH shell does not carry fox's environment).
export function foxEnv(name, env = process.env, readEnvFile = () => readFileSync('/etc/fox/fox.env', 'utf8')) {
  if (env[name]) return env[name];
  try { const m = readEnvFile().match(new RegExp(`^${name}=(.+)$`, 'm')); if (m) return m[1].trim(); } catch {}
  return null;
}

const USAGE = `fox-expose: a private address on this machine, https://<name>.<domain> (only you can open it)

  fox-expose <name> <port>                          a server something else keeps running
  fox-expose <name> --dir <folder>                  a static site: fox serves the folder, nothing else runs
  fox-expose <name> --cmd "<command>" --port <port> [--cwd <folder>]
                                                    fox keeps the command running (PORT is set for it)
  fox-expose list
  fox-expose pause|resume|remove <name>
  fox-expose logs <name>                            the last lines a --cmd app printed`;

const TMUX = process.env.TMUX_BIN || 'tmux';
const execP = promisify(execFile);
async function tmux(...args) {
  try { return (await execP(TMUX, args)).stdout; }
  catch (err) { if (/no server running|no sessions|error connecting to/.test(err.stderr ?? '')) return ''; throw err; }
}
const flag = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const describe = (a) => (a.dir ? `folder ${a.dir}` : a.cmd ? `runs "${a.cmd}" on :${a.port}` : `:${a.port}`);

async function main(argv) {
  const template = foxEnv('FOX_APPS_URL');
  if (!template) throw new Error('Named apps are not set up on this machine (FOX_APPS_URL). Use the per-port preview instead.');
  const denyPorts = [foxEnv('PORT') ?? '4848', foxEnv('FOX_APPS_PORT'), '4849'].filter(Boolean).map(Number);
  const registry = createAppRegistry({ stateDir: process.env.FOX_STATE_DIR || join(homedir(), '.config', 'fox'), denyPorts });
  const stateDir = process.env.FOX_STATE_DIR || join(homedir(), '.config', 'fox');
  const logDir = join(stateDir, 'apps');
  // Commands start (or stop) now; fox's own check every few seconds does the same if this one cannot.
  const apply = () => reconcileApps({ registry, tmux, logDir }).catch((err) => console.error(`fox will start it shortly (${err.message}).`));
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return console.log(USAGE);
  if (cmd === 'list') {
    const apps = await registry.list();
    if (!apps.length) return console.log('No named apps yet.');
    for (const a of apps) console.log(`${a.name}\t${appUrl(template, a.name)}\t${describe(a)}${a.paused ? '\tpaused' : ''}`);
    return;
  }
  if (cmd === 'remove' || cmd === 'pause' || cmd === 'resume') {
    const name = rest[0];
    const app = await registry.get(name);
    if (!app) return console.log(`No app named ${name}.`);
    if (cmd === 'remove') await registry.remove(name); else await registry.setPaused(name, cmd === 'pause');
    if (app.cmd) await apply();
    return console.log(cmd === 'remove' ? `Removed ${name}.${appKind(app) === 'port' ? ' The server itself keeps running.' : ''}` : `${name} ${cmd === 'pause' ? 'is paused' : 'is back'}: ${appUrl(template, name)}`);
  }
  if (cmd === 'logs') {
    const text = await readFile(join(logDir, `${rest[0]}.log`), 'utf8').catch(() => '');
    return console.log(text ? text.split('\n').slice(-60).join('\n') : `No log for ${rest[0]} (only --cmd apps have one).`);
  }
  const spec = rest.includes('--dir') ? { dir: flag(rest, '--dir') }
    : rest.includes('--cmd') ? { cmd: flag(rest, '--cmd'), port: flag(rest, '--port'), cwd: flag(rest, '--cwd') ?? process.cwd() }
    : rest.length === 1 ? { port: rest[0] } : null;
  if (!spec) throw new Error(USAGE);
  const app = await registry.set(cmd, spec);
  if (app.cmd) await apply();
  console.log(`${app.name} (${describe(app)}): ${appUrl(template, app.name)}`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('fox-expose')) {
  main(process.argv.slice(2)).catch((err) => { console.error(err.message); process.exitCode = 1; });
}
