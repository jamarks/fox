// Pull requests: open PRs and browsable merged history of the workspaces' repos, so a job's work is read, merged or closed from
// fox instead of GitHub. gh does the talking (a token per owner in ~/.config/fox-git/tokens, as for workspaces);
// fox only acts on repos it already knows and PR numbers it was given, and merging or closing is the person's click.
//
// What a row says comes from the PR itself: the review job's last comment (`fox review` and its verdict mark), the
// checks, and a Linear link in the body. Lists are cached briefly; a merge or close drops the cache.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO_PART } from './workspaces.mjs';
const execFileP = promisify(execFile);

const LIST_FIELDS = 'number,title,url,headRefName,headRefOid,additions,deletions,changedFiles,createdAt,mergedAt,state,isDraft,body,comments,statusCheckRollup';
const VERDICTS = [['✅', 'good'], ['🔧', 'fixed'], ['👀', 'needs-you']];

// The review job's verdict, from its newest comment: good, fixed, needs-you, or null when not reviewed yet. The comment
// names the commit it reviewed (`fox-review: <sha>`); when the PR has moved past it, the verdict is `outdated`.
export function reviewOf(comments = [], head = null) {
  const last = [...comments].reverse().find((c) => /\*\*fox review\*\*/.test(c?.body ?? ''));
  if (!last) return null;
  const reviewed = last.body.match(/fox-review: ([0-9a-f]{7,40})/)?.[1];
  const verdict = reviewed && head && !head.startsWith(reviewed) ? 'outdated'
    : VERDICTS.find(([mark]) => last.body.startsWith(mark))?.[1] ?? 'reviewed';
  const text = last.body.replace(/^\S+\s+\*\*fox review\*\*\s*/, '').replace(/<sub>[\s\S]*?<\/sub>/g, '').trim();
  return { verdict, text: text.slice(0, 1200) };
}

// Checks in one word: failing, pending, passing, or none when the repo has no CI.
export function checksOf(rollup = []) {
  if (!rollup?.length) return 'none';
  const states = rollup.map((c) => String(c.conclusion || c.state || c.status || '').toUpperCase());
  if (states.some((s) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(s))) return 'failing';
  if (states.some((s) => ['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED', 'WAITING'].includes(s))) return 'pending';
  return 'passing';
}

export function summarize(repo, pr) {
  const review = reviewOf(pr.comments, pr.headRefOid);
  const checks = checksOf(pr.statusCheckRollup);
  const job = String(pr.headRefName).startsWith('agent/');
  const issue = (String(pr.headRefName).match(/^agent\/([a-z]+-\d+)/)?.[1] ?? '').toUpperCase() || null;
  const linear = String(pr.body ?? '').match(/https:\/\/linear\.app\/[^\s)]+/)?.[0] ?? null;
  return {
    repo, number: pr.number, title: pr.title, url: pr.url, branch: pr.headRefName, draft: Boolean(pr.isDraft), state: pr.state ?? 'OPEN',
    additions: pr.additions ?? 0, deletions: pr.deletions ?? 0, files: pr.changedFiles ?? 0, createdAt: pr.createdAt, mergedAt: pr.mergedAt ?? null,
    job, issue, linear, checks, review,
    // Ready: nothing says no. Checks not failing, not a draft, and a job's PR reviewed as good or fixed.
    ready: !pr.isDraft && checks !== 'failing' && checks !== 'pending' && (!job || ['good', 'fixed'].includes(review?.verdict)),
    body: String(pr.body ?? '').slice(0, 2000),
    // The job run that made it, as foxjob writes it at the end of the PR's text (read before the text is cut).
    madeBy: String(pr.body ?? '').match(/Made by a fox job \(([0-9A-Za-z_-]+)\)/)?.[1] ?? null,
  };
}

export function createPrs({ repos, tokensDir = null, gh = 'gh', run = null, ttlMs = 60_000, now = () => Date.now() }) {
  const exec = run ?? ((args, env) => execFileP(gh, args, { timeout: 30_000, maxBuffer: 8 << 20, env: { ...process.env, GH_PROMPT_DISABLED: '1', ...env } }).then((x) => x.stdout));
  const cache = new Map();
  async function env(owner) {
    if (!tokensDir) return {};
    try { const t = (await readFile(join(tokensDir, owner.toLowerCase()), 'utf8')).trim(); return t ? { GH_TOKEN: t } : {}; } catch { return {}; }
  }
  async function known(repo) {
    const parts = String(repo).split('/');
    const [owner, name] = parts;
    if (parts.length !== 2 || !REPO_PART.test(owner) || !REPO_PART.test(name)) return null;
    const list = await repos();
    return list.find((r) => r.toLowerCase() === `${owner}/${name}`.toLowerCase()) ?? null;
  }
  const number = (n) => (/^\d{1,7}$/.test(String(n)) ? String(n) : null);
  async function gh_(repo, args) { return exec([...args, '--repo', repo], await env(repo.split('/')[0])); }
  return {
    async list({ force = false, state = 'open', limit = 50 } = {}) {
      if (!['open', 'merged', 'all'].includes(state)) throw Object.assign(new Error('invalid PR state'), { status: 400 });
      const count = state === 'open' ? 30 : Math.max(1, Math.floor(Number(limit) || 50));
      const key = `${state}:${count}`;
      const cached = cache.get(key);
      if (!force && cached && now() - cached.at < ttlMs) return cached.value;
      const all = await repos();
      const errors = [];
      const lists = await Promise.all(all.map((repo) => gh_(repo, ['pr', 'list', '--state', state, '--limit', String(count), '--json', LIST_FIELDS])
        .then((out) => JSON.parse(out || '[]').map((pr) => summarize(repo, pr)))
        .catch((err) => { errors.push({ repo, error: String(err.stderr || err.message).trim().split('\n')[0].slice(0, 200) }); return []; })));
      const value = { prs: lists.flat().sort((a, b) => String(b[state === 'merged' ? 'mergedAt' : 'createdAt']).localeCompare(String(a[state === 'merged' ? 'mergedAt' : 'createdAt']))), errors,
        hasMore: state !== 'open' && lists.some((list) => list.length === count) };
      cache.set(key, { at: now(), value });
      return value;
    },
    // What opening a row shows: the files changed, with their lines.
    async files(repo, n) {
      const r = await known(repo), num = number(n);
      if (!r || !num) throw Object.assign(new Error('unknown pull request'), { status: 404 });
      const out = JSON.parse(await gh_(r, ['pr', 'view', num, '--json', 'files']) || '{}');
      return (out.files ?? []).map((f) => ({ path: f.path, additions: f.additions ?? 0, deletions: f.deletions ?? 0 }));
    },
    async merge(repo, n) {
      const r = await known(repo), num = number(n);
      if (!r || !num) throw Object.assign(new Error('unknown pull request'), { status: 404 });
      await gh_(r, ['pr', 'merge', num, '--merge']);
      cache.clear();
      return { ok: true };
    },
    // Paused = a draft on GitHub: kept as it is, out of the agent's queue and the review job's, until resumed.
    async pause(repo, n) { return this.setDraft(repo, n, true); },
    async resume(repo, n) { return this.setDraft(repo, n, false); },
    async setDraft(repo, n, draft) {
      const r = await known(repo), num = number(n);
      if (!r || !num) throw Object.assign(new Error('unknown pull request'), { status: 404 });
      await gh_(r, ['pr', 'ready', num, ...(draft ? ['--undo'] : [])]);
      cache.clear();
      return { ok: true };
    },
    async close(repo, n, reason = '') {
      const r = await known(repo), num = number(n);
      if (!r || !num) throw Object.assign(new Error('unknown pull request'), { status: 404 });
      const why = String(reason ?? '').trim().slice(0, 1000);
      await gh_(r, ['pr', 'close', num, ...(why ? ['--comment', why] : [])]);
      cache.clear();
      return { ok: true };
    },
  };
}
