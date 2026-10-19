import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrs, reviewOf, checksOf } from '../prs.mjs';

const pr = (over = {}) => ({ number: 12, title: 'FOX-10: Hand off', url: 'https://github.com/o/r/pull/12', headRefName: 'agent/fox-10-hand-off',
  additions: 214, deletions: 12, changedFiles: 3, createdAt: '2026-10-19T08:00:00Z', isDraft: false,
  body: 'Did it.\n\nLinear: https://linear.app/x/issue/FOX-10/hand-off', comments: [], statusCheckRollup: [], ...over });

function fake(responses) {
  const calls = [];
  const run = async (args, env) => { calls.push({ args, env }); const r = responses(args); if (r instanceof Error) throw r; return r; };
  return { run, calls };
}

test('a row says what the review job and the checks said', () => {
  assert.equal(reviewOf([]), null);
  assert.deepEqual(reviewOf([{ body: '✅ **fox review** (gpt-6-luna): Good.\n\n- ok\n\n<sub>fox-review: abc123</sub>' }]), { verdict: 'good', text: '(gpt-6-luna): Good.\n\n- ok' });
  assert.equal(reviewOf([{ body: '✅ **fox review** (m): first' }, { body: '👀 **fox review** (m): later' }]).verdict, 'needs-you', 'the newest review counts');
  assert.equal(checksOf([]), 'none');
  assert.equal(checksOf([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }]), 'failing');
  assert.equal(checksOf([{ status: 'IN_PROGRESS' }]), 'pending');
  assert.equal(checksOf([{ conclusion: 'SUCCESS' }]), 'passing');
});

test('open PRs of every known repo in one list; a job PR is ready once reviewed', async () => {
  const { run, calls } = fake((args) => {
    const repo = args[args.indexOf('--repo') + 1];
    if (repo === 'o/r') return JSON.stringify([pr(), pr({ number: 13, headRefName: 'agent/fox-9-x', createdAt: '2026-10-19T09:00:00Z', comments: [{ body: '🔧 **fox review** (m): fixed it' }] })]);
    if (repo === 'o/mine') return JSON.stringify([pr({ number: 3, headRefName: 'my-branch', body: '', createdAt: '2026-10-18T00:00:00Z' })]);
    return new Error('HTTP 404: Not Found');
  });
  const prs = createPrs({ repos: async () => ['o/r', 'o/mine', 'o/gone'], run });
  const { prs: list, errors } = await prs.list();
  assert.deepEqual(list.map((p) => [p.repo, p.number, p.ready]), [['o/r', 13, true], ['o/r', 12, false], ['o/mine', 3, true]], 'newest first; an unreviewed job PR is not ready, a person\'s is');
  assert.equal(list[1].issue, 'FOX-10');
  assert.equal(list[1].linear, 'https://linear.app/x/issue/FOX-10/hand-off');
  assert.deepEqual(errors.map((e) => e.repo), ['o/gone'], 'a repo gh cannot read is reported, the rest still show');
  await prs.list();
  assert.equal(calls.length, 3, 'cached');
});

test('merged history is sorted by merge time, loads progressively, and has separate cache', async () => {
  const { run, calls } = fake((args) => args[args.indexOf('--state') + 1] === 'merged'
    ? JSON.stringify([pr({ number: 1, state: 'MERGED', mergedAt: '2026-10-18T08:00:00Z' }), pr({ number: 2, state: 'MERGED', mergedAt: '2026-10-19T08:00:00Z' })]) : '[]');
  const prs = createPrs({ repos: async () => ['o/r'], run });
  await prs.list();
  const history = await prs.list({ state: 'merged', limit: 2 });
  assert.deepEqual(history.prs.map((p) => p.number), [2, 1]);
  assert.equal(history.hasMore, true);
  assert.equal(history.prs[0].state, 'MERGED');
  assert.deepEqual(calls.at(-1).args.slice(0, 8), ['pr', 'list', '--state', 'merged', '--limit', '2', '--json', 'number,title,url,headRefName,additions,deletions,changedFiles,createdAt,mergedAt,state,isDraft,body,comments,statusCheckRollup']);
  await prs.list({ state: 'merged', limit: 2 });
  assert.equal(calls.length, 2, 'same page is cached');
  await prs.list({ state: 'merged', limit: 3 });
  assert.equal(calls.length, 3, 'larger history fetches again');
  assert.equal((await prs.list({ state: 'merged', limit: 3 })).hasMore, false);
  await assert.rejects(prs.list({ state: 'closed' }), /invalid PR state/);
});

test('all PRs include open, merged and closed, ordered by creation date with more history available', async () => {
  const { run, calls } = fake(() => JSON.stringify([
    pr({ number: 1, state: 'MERGED', createdAt: '2026-10-18T08:00:00Z', mergedAt: '2026-10-19T00:00:00Z' }),
    pr({ number: 2, state: 'CLOSED', createdAt: '2026-10-20T08:00:00Z' }),
    pr({ number: 3, state: 'OPEN', createdAt: '2026-10-19T08:00:00Z' }),
  ]));
  const prs = createPrs({ repos: async () => ['o/r'], run });
  const all = await prs.list({ state: 'all', limit: 3 });
  assert.deepEqual(all.prs.map((p) => [p.number, p.state]), [[2, 'CLOSED'], [3, 'OPEN'], [1, 'MERGED']]);
  assert.equal(all.hasMore, true);
  assert.deepEqual(calls[0].args.slice(0, 6), ['pr', 'list', '--state', 'all', '--limit', '3']);
});

test('merge and close act only on known repos and real numbers, and drop the cache', async () => {
  const { run, calls } = fake((args) => (args[1] === 'list' ? '[]' : ''));
  const prs = createPrs({ repos: async () => ['o/r'], run, tokensDir: null });
  await prs.list();
  await prs.merge('o/r', '12');
  assert.deepEqual(calls.at(-1).args, ['pr', 'merge', '12', '--merge', '--repo', 'o/r']);
  await prs.close('O/R', 13, 'not needed');
  assert.deepEqual(calls.at(-1).args, ['pr', 'close', '13', '--comment', 'not needed', '--repo', 'o/r']);
  await assert.rejects(prs.merge('evil/repo', '1'), /unknown pull request/);
  await assert.rejects(prs.merge('o/r', '1; rm -rf /'), /unknown pull request/);
  await assert.rejects(prs.close('o/r/../x', '1'), /unknown pull request/);
  const before = calls.length;
  await prs.list();
  assert.equal(calls.length, before + 1, 'listed again after acting');
});
