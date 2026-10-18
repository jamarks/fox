// Pull request links on a job's runs: a job that opened a pull request prints its URL as a FOX_LINK, and the
// run keeps showing it. Whether it was merged since is not in the run; gh knows. This asks gh once per link,
// remembers the answer (merged and closed are final, open is asked again after a while) and never slows a
// page down: a link whose state is not known yet comes back without one, and the next refresh has it.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const execFileP = promisify(execFile);

export const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/;
const FINAL = new Set(['merged', 'closed']);

export function createPrStates({ tokensDir = null, gh = 'gh', run = null, openTtlMs = 2 * 60 * 1000, now = () => Date.now() } = {}) {
  const cache = new Map(); // url -> { state, at }
  const pending = new Map(); // url -> promise
  const exec = run ?? ((args, env) => execFileP(gh, args, { timeout: 15000, env: { ...process.env, GH_PROMPT_DISABLED: '1', ...env } }).then((x) => x.stdout));
  async function tokenFor(owner) {
    if (!tokensDir) return null;
    try { return (await readFile(join(tokensDir, owner.toLowerCase()), 'utf8')).trim() || null; } catch { return null; }
  }
  async function fetchState(url) {
    const m = url.match(PR_URL);
    if (!m) return null;
    const [, owner, repo, number] = m;
    const token = await tokenFor(owner);
    const out = await exec(['pr', 'view', number, '--repo', `${owner}/${repo}`, '--json', 'state'], token ? { GH_TOKEN: token } : {});
    const state = String(JSON.parse(out).state ?? '').toLowerCase();
    return state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : state === 'open' ? 'open' : null;
  }
  function lookup(url) {
    const hit = cache.get(url);
    if (hit && (FINAL.has(hit.state) || now() - hit.at < openTtlMs)) return hit.state;
    if (!pending.has(url)) {
      pending.set(url, fetchState(url).then((state) => { if (state) cache.set(url, { state, at: now() }); return state; }).catch(() => null).finally(() => pending.delete(url)));
    }
    return hit?.state ?? null; // stale-while-revalidate: an old answer now, a fresh one on the next call
  }
  return {
    // Adds `pr: 'merged' | 'closed' | 'open'` to the links of each run that point at a GitHub pull request.
    decorate(runs) {
      for (const r of runs) for (const l of r.links ?? []) { if (PR_URL.test(l.url)) { const s = lookup(l.url); if (s) l.pr = s; } }
      return runs;
    },
    // For tests: wait until every lookup in flight has settled.
    settle: () => Promise.all([...pending.values()]),
    cache,
  };
}
