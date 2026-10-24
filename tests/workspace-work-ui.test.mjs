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
const state = {
  workspaces,
  jobs: [{ cwd: '/workspaces/jobs/scripts', workspace: 'fox' }, { cwd: '/workspaces/jobs/scripts' }, { cwd: '/workspaces/jobs/scripts', workspace: 'removed' }],
  prs: { prs: [{ repo: 'A/FOX' }, { repo: 'a/other' }] },
};
const ctx = { state, workspaceFor: (path) => workspaces.find((w) => path === w.dir || path.startsWith(w.dir + '/')), esc: (s) => String(s) };
vm.createContext(ctx);
vm.runInContext(section, ctx);

test('sidebar counts and list filters assign explicit jobs only to their named workspace, PRs by repo', () => {
  assert.match(vm.runInContext('wsWorkLine(state.workspaces[0])', ctx), /1 job.*1 open PR/s);
  assert.match(vm.runInContext('wsWorkLine(state.workspaces[1])', ctx), /1 job/);
  assert.doesNotMatch(vm.runInContext('wsWorkLine(state.workspaces[1])', ctx), /2 jobs/);
  assert.equal(vm.runInContext('jobWorkspace(state.jobs[2])', ctx), undefined, 'a removed explicit workspace must not silently fall back to the script folder');
  assert.equal(vm.runInContext('state.jobs.filter(j => jobWorkspace(j) === state.workspaces[0]).length', ctx), 1);
  assert.equal(vm.runInContext('state.prs.prs.filter(p => prWorkspace(p) === state.workspaces[0]).length', ctx), 1);
});
