// A workspace repo's branch, changed from the sidebar. The branch belongs to the workspace's copy of the repo, which every
// session in that workspace shares, so changing it changes what all of them see: fox refuses while one of them is
// working, never drops uncommitted work (it is kept in a wip/ branch, pushed, or the switch does not happen), and only
// fast-forwards. git runs inside the repo folder with SAFE_GIT, on branch names it checked first.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { SAFE_GIT } from './gitsync.mjs';
const execFileP = promisify(execFile);

const fail = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });
// A branch name git would accept, without a leading dash (it could read as an option) and without whitespace.
export const okBranchName = (name) => typeof name === 'string' && /^[\w][\w./-]{0,199}$/.test(name) && !/\.\.|\/\/|\/$|\.lock$|@\{/.test(name);

export function wipName(current, now = new Date()) {
  const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  return `wip/${String(current).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'branch'}-${stamp}`;
}

export function createBranches({
  workspaces,
  busy = async () => [],
  git = (args, opts = {}) => execFileP('git', args, { timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...opts }).then((x) => x.stdout.trim()),
  now = () => new Date(),
}) {
  async function repoOf(id, dir) {
    const ws = await workspaces.get(id);
    const repo = ws?.repos.find((r) => r.dir === dir);
    if (!ws || !repo) throw fail('Repo not found in this workspace.', 404);
    const path = resolve(join(ws.dir, repo.dir));
    if (!path.startsWith(resolve(ws.dir) + sep) || !existsSync(join(path, '.git'))) throw fail('That repo is not cloned yet.', 409);
    const run = (args, opts) => git(['-C', path, ...SAFE_GIT, ...args], opts);
    return { ws, repo, path, run };
  }
  async function facts(run) {
    const current = await run(['rev-parse', '--abbrev-ref', 'HEAD']);
    const def = (await run(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => 'origin/main')).replace(/^origin\//, '');
    const dirty = (await run(['status', '--porcelain'])).split('\n').filter(Boolean).length;
    const merged = current !== def && current !== 'HEAD'
      && await run(['merge-base', '--is-ancestor', 'HEAD', `origin/${def}`]).then(() => true, () => false);
    return { current, default: def, dirty, merged };
  }
  async function refuseIfBusy(ws) {
    const working = await busy(ws.dir);
    if (working.length) throw fail(`${working.length === 1 ? 'A session is' : `${working.length} sessions are`} working in ${ws.name}. Changing the branch would change files under it; wait for it to finish.`, 409, { busy: working });
  }
  async function fastForward(run) {
    const upstream = await run(['rev-parse', '--abbrev-ref', '@{u}']).catch(() => '');
    if (!upstream) return 'no upstream';
    return run(['merge', '--ff-only', '--quiet', '@{u}']).then(() => 'up to date', () => 'diverged from its remote: not updated');
  }
  async function keepWork(run, cur, target) {
    const name = wipName(cur, now());
    await run(['switch', '--quiet', '-c', name]);
    await run(['add', '-A']);
    const who = await run(['config', 'user.name']).catch(() => '');
    await run([...(who ? [] : ['-c', 'user.name=fox', '-c', 'user.email=fox@localhost']), 'commit', '--quiet', '--no-verify', '-m', `WIP kept by fox before switching to ${target}`]);
    const pushed = await run(['push', '--quiet', '-u', 'origin', name], { timeout: 120_000 }).then(() => true, () => false);
    return { name, pushed };
  }
  return {
    // The branches to offer, newest first (local and origin's, once each), and what the copy is on now.
    async list(id, dir) {
      const { run } = await repoOf(id, dir);
      await run(['fetch', '--quiet', '--prune', 'origin'], { timeout: 60_000 }).catch(() => {});
      const refs = (await run(['for-each-ref', '--sort=-committerdate', '--format=%(refname)\t%(committerdate:unix)', 'refs/heads', 'refs/remotes/origin'])).split('\n').filter(Boolean);
      const seen = new Map();
      for (const line of refs) {
        const [ref, at] = line.split('\t');
        const local = ref.startsWith('refs/heads/');
        const name = ref.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\/origin\//, '');
        if (name === 'HEAD' || !okBranchName(name)) continue;
        const b = seen.get(name) ?? { name, at: Number(at) * 1000, local: false, remote: false };
        if (local) b.local = true; else b.remote = true;
        seen.set(name, b);
      }
      return { ...(await facts(run)), branches: [...seen.values()].slice(0, 40) };
    },
    // Switch to `branch` (local, or tracking origin's). Uncommitted work: `keep` puts it in a wip/ branch first, else 409.
    async switch(id, dir, branch, { keep = false } = {}) {
      if (!okBranchName(branch)) throw fail('That is not a branch name.');
      const { ws, run } = await repoOf(id, dir);
      await refuseIfBusy(ws);
      const f = await facts(run);
      const exists = async (ref) => run(['show-ref', '--verify', '--quiet', ref]).then(() => true, () => false);
      await run(['fetch', '--quiet', 'origin'], { timeout: 60_000 }).catch(() => {});
      const local = await exists(`refs/heads/${branch}`), remote = await exists(`refs/remotes/origin/${branch}`);
      if (!local && !remote) throw fail(`There is no branch ${branch}.`, 404);
      let kept = null;
      if (f.dirty) {
        if (!keep) throw fail(`${f.dirty} uncommitted file${f.dirty === 1 ? '' : 's'} on ${f.current}. Keep them in a branch first?`, 409, { dirty: f.dirty });
        kept = await keepWork(run, f.current, branch);
      }
      if (branch !== f.current || kept) await run(local ? ['switch', '--quiet', branch] : ['switch', '--quiet', '--track', `origin/${branch}`]);
      const update = await fastForward(run);
      return { branch, kept, update };
    },
    // Fetch and fast-forward the current branch; never a merge commit.
    async update(id, dir) {
      const { ws, run } = await repoOf(id, dir);
      await refuseIfBusy(ws);
      await run(['fetch', '--quiet', 'origin'], { timeout: 60_000 });
      return { update: await fastForward(run) };
    },
    // A new branch from where the copy is now (uncommitted work comes along, as git does).
    async create(id, dir, name) {
      if (!okBranchName(name)) throw fail('Use letters, numbers, dots, dashes, underscores and slashes for the name.');
      const { ws, run } = await repoOf(id, dir);
      await refuseIfBusy(ws);
      await run(['check-ref-format', '--branch', name]).catch(() => { throw fail('git does not accept that branch name.'); });
      await run(['switch', '--quiet', '-c', name]).catch((err) => { throw fail(String(err.stderr || err.message).trim().split('\n')[0], 409); });
      return { branch: name };
    },
  };
}
