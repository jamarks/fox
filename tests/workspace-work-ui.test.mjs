// Check workspace counts against the same grouping functions the sidebar and lists use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const section = source.slice(source.indexOf('const workspaceNamed ='), source.indexOf('function renderSessions()'));
const workspaces = [
  { name: 'fox', dir: '/workspaces/fox', repos: [{ owner: 'a', name: 'fox' }] },
  { name: 'jobs', dir: '/workspaces/jobs', repos: [] },
];
const failed = { lastRun: { status: 'failed' }, enabled: true };
const state = {
  workspaces,
  jobs: [{ cwd: '/workspaces/jobs/scripts', workspace: 'fox', ...failed }, { cwd: '/workspaces/jobs/scripts', pendingApproval: true }, { cwd: '/workspaces/jobs/scripts', workspace: 'removed', ...failed }],
  prs: { prs: [{ repo: 'A/FOX', ready: true }, { repo: 'a/fox', checks: 'failing' }, { repo: 'a/fox' }, { repo: 'a/other', ready: true }] },
};
const ctx = { state, workspaceFor: (path) => workspaces.find((w) => path === w.dir || path.startsWith(w.dir + '/')), esc: (s) => String(s),
  BAD: ['failed', 'timeout', 'interrupted'], jobState: (j) => j.lastRun?.status === 'running' ? 'running' : !j.enabled ? 'paused' : j.lastRun?.status ?? 'none' };
vm.createContext(ctx);
vm.runInContext(section, ctx);

test('sidebar counts and list filters assign explicit jobs only to their named workspace, PRs by repo', () => {
  const fox = vm.runInContext('wsWorkLine(state.workspaces[0])', ctx), jobs = vm.runInContext('wsWorkLine(state.workspaces[1])', ctx);
  assert.match(fox, /1 PR ready to merge.*1 PR needs you.*1 job failed/s, 'only what needs you; the plain open PR is not counted');
  assert.doesNotMatch(fox, /to approve/);
  assert.match(jobs, /1 job to approve/);
  assert.doesNotMatch(jobs, /failed/, 'the job with a removed workspace belongs to none');
  assert.equal(vm.runInContext('jobWorkspace(state.jobs[2])', ctx), undefined, 'a removed explicit workspace must not silently fall back to the script folder');
  assert.equal(vm.runInContext('state.prs.prs.filter(p => prWorkspace(p) === state.workspaces[0]).length', ctx), 3);
  state.jobs = []; state.prs = { prs: [{ repo: 'a/fox' }] };
  assert.equal(vm.runInContext('wsWorkLine(state.workspaces[0])', ctx), '', 'nothing pending: no line');
});
