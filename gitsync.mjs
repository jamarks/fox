// Keep a checkout current before fx or a job works in it, without ever touching local work: only a clean
// repo, on its default branch, with no ignored untracked paths or unpushed commits, is fast-forwarded. Anything
// else is left exactly as it is, and the reason is returned.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
// fox runs git on its own, in folders it may not have made: never a program the repo's own config or hooks name
// (core.fsmonitor runs on every `git status`; a post-merge hook on every update).
export const SAFE_GIT = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];
const defaultGit = (args, opts = {}) => execFileP('git', args, { timeout: 20000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...opts }).then((x) => x.stdout.trim());

export async function fastForward(dir, { git = defaultGit } = {}) {
  if (!existsSync(join(dir, '.git'))) return { status: 'skipped', reason: 'not a git repo' };
  const run = (args) => git(['-C', dir, ...SAFE_GIT, ...args]);
  try {
    const branch = await run(['rev-parse', '--abbrev-ref', 'HEAD']);
    const main = (await run(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => 'origin/main')).replace(/^origin\//, '');
    if (branch !== main) return { status: 'skipped', reason: `on branch ${branch}` };
    if (await run(['status', '--porcelain'])) return { status: 'skipped', reason: 'uncommitted changes' };
    // An incoming tracked path can replace ignored local data without appearing in porcelain status.
    if (await run(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'])) return { status: 'skipped', reason: 'ignored local files' };
    await run(['fetch', '--quiet', '--end-of-options', 'origin', main]);
    if (Number(await run(['rev-list', '--count', `origin/${main}..HEAD`])) > 0) return { status: 'skipped', reason: 'local commits not pushed' };
    const from = await run(['rev-parse', '--short', 'HEAD']);
    if (Number(await run(['rev-list', '--count', `HEAD..origin/${main}`])) === 0) return { status: 'current', at: from };
    await run(['merge', '--ff-only', '--quiet', `origin/${main}`]);
    return { status: 'updated', from, to: await run(['rev-parse', '--short', 'HEAD']) };
  } catch (err) {
    return { status: 'skipped', reason: String(err.stderr || err.message).trim().split('\n')[0].slice(0, 200) };
  }
}
