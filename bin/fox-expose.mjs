#!/usr/bin/env node
// fox-expose: give a dev server on this machine its own private address, https://<name>.<domain>, instead of
// the per-port preview. Same list fox's router reads (apps.json), so it works at once. See apps.mjs.
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createAppRegistry, appUrl } from '../apps.mjs';

// fox's settings: the environment, else the server's config file (an SSH shell does not carry fox's environment).
export function foxEnv(name, env = process.env, readEnvFile = () => readFileSync('/etc/fox/fox.env', 'utf8')) {
  if (env[name]) return env[name];
  try { const m = readEnvFile().match(new RegExp(`^${name}=(.+)$`, 'm')); if (m) return m[1].trim(); } catch {}
  return null;
}

const USAGE = `fox-expose: a private address for a dev server on this machine

  fox-expose <name> <port>   publish it at https://<name>.<domain> (only you can open it)
  fox-expose list
  fox-expose remove <name>`;

async function main(argv) {
  const template = foxEnv('FOX_APPS_URL');
  if (!template) throw new Error('Named apps are not set up on this machine (FOX_APPS_URL). Use the per-port preview instead.');
  const denyPorts = [foxEnv('PORT') ?? '4848', foxEnv('FOX_APPS_PORT'), '4849'].filter(Boolean).map(Number);
  const registry = createAppRegistry({ stateDir: process.env.FOX_STATE_DIR || join(homedir(), '.config', 'fox'), denyPorts });
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return console.log(USAGE);
  if (cmd === 'list') {
    const apps = await registry.list();
    if (!apps.length) return console.log('No named apps yet.');
    for (const a of apps) console.log(`${a.name}\t:${a.port}\t${appUrl(template, a.name)}`);
    return;
  }
  if (cmd === 'remove') {
    const name = rest[0];
    return console.log(await registry.remove(name) ? `Removed ${name}; the server itself keeps running.` : `No app named ${name}.`);
  }
  if (rest.length !== 1) throw new Error(USAGE);
  const app = await registry.set(cmd, rest[0]);
  console.log(`${app.name} → port ${app.port}: ${appUrl(template, app.name)}`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('fox-expose')) {
  main(process.argv.slice(2)).catch((err) => { console.error(err.message); process.exitCode = 1; });
}
