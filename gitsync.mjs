// Keep a checkout current before fx or a job works in it, without ever touching work in progress: only a clean
// repo, on its default branch, with nothing of its own unpushed, is fast-forwarded to the remote. Anything else is
// left exactly as it is, and the reason is returned.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const defaultGit = (args, opts = {}) => execFileP('git', args, { timeout: 20000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...opts }).then((x) => x.stdout.trim());

export async function fastForward(dir, { git = defaultGit } = {}) {
  if (!existsSync(join(dir, '.git'))) return { status: 'skipped', reason: 'not a git repo' };
  const run = (args) => git(['-C', dir, ...args]);
  try {
    const branch = await run(['rev-parse', '--abbrev-ref', 'HEAD']);
    const main = (await run(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => 'origin/main')).replace(/^origin\//, '');
    if (branch !== main) return { status: 'skipped', reason: `on branch ${branch}` };
    if (await run(['status', '--porcelain'])) return { status: 'skipped', reason: 'uncommitted changes' };
    await run(['fetch', '--quiet', 'origin', main]);
    if (Number(await run(['rev-list', '--count', `origin/${main}..HEAD`])) > 0) return { status: 'skipped', reason: 'local commits not pushed' };
    const from = await run(['rev-parse', '--short', 'HEAD']);
    if (Number(await run(['rev-list', '--count', `HEAD..origin/${main}`])) === 0) return { status: 'current', at: from };
    await run(['merge', '--ff-only', '--quiet', `origin/${main}`]);
    return { status: 'updated', from, to: await run(['rev-parse', '--short', 'HEAD']) };
  } catch (err) {
    return { status: 'skipped', reason: String(err.stderr || err.message).trim().split('\n')[0].slice(0, 200) };
  }
}
