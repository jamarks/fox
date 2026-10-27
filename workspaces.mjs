// Workspaces: a named folder under ~/workspaces made of one or more GitHub repos (cloned as subfolders),
// plus whatever else you keep there. Created once, reopened many times. Definitions live in
// ~/.config/fox/workspaces.json; fox never writes in ~/.fx. Removing a repo or a workspace never deletes
// files unless asked, and never when a repo has uncommitted or unpushed work.
import { readFile, writeFile, mkdir, rename, readdir, rm, realpath, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { SAFE_GIT } from './gitsync.mjs';
const execFileP = promisify(execFile);

export const WORKSPACE_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
export const REPO_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const validRepo = (r) => Boolean(r && REPO_PART.test(String(r.owner)) && REPO_PART.test(String(r.name)) && !String(r.name).endsWith('.git'));
const key = (r) => `${r.owner}/${r.name}`.toLowerCase();

const sha = (text) => createHash('sha256').update(text).digest('hex');

export function createWorkspaces({
  stateDir, rootDir,
  agentNotes = () => null, // (ws) => AGENTS.md for the workspace root: that it is no repo, and which subfolder is which
  remoteUrl = (r) => `https://github.com/${r.owner}/${r.name}.git`,
  git = (args, opts = {}) => execFileP('git', args, { timeout: 30000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...opts }).then((x) => x.stdout.trim()),
}) {
  const file = join(stateDir, 'workspaces.json');
  const cloning = new Map(); // "<id>|owner/name" -> true while a clone runs
  const errors = new Map();  // "<id>|owner/name" -> last clone error

  async function load() {
    try { const d = JSON.parse(await readFile(file, 'utf8')); return Array.isArray(d) ? d : []; } catch { return []; }
  }
  async function save(list) {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
    await rename(tmp, file);
  }
  // Every path fox touches must stay inside rootDir, after resolving symlinks.
  async function inside(dir) {
    const root = await realpath(rootDir).catch(() => resolve(rootDir));
    const real = await realpath(dir).catch(() => resolve(dir));
    return real === root || real.startsWith(root + sep);
  }
  // Folder name for a repo: its name, or name-owner if another owner's repo already took it.
  function folderFor(ws, repo) {
    const taken = new Set(ws.repos.filter((r) => key(r) !== key(repo)).map((r) => r.dir.toLowerCase()));
    const plain = repo.name;
    return taken.has(plain.toLowerCase()) ? `${repo.name}-${repo.owner}` : plain;
  }
  async function cloneOne(ws, repo) {
    const k = `${ws.id}|${key(repo)}`;
    if (cloning.has(k)) return;
    const dir = join(ws.dir, repo.dir);
    if (existsSync(join(dir, '.git'))) return;
    cloning.set(k, true); errors.delete(k);
    try {
      if (!(await inside(ws.dir))) throw new Error('workspace folder is outside ~/workspaces');
      await git(['clone', '--', remoteUrl(repo), dir], { timeout: 600000 });
    } catch (err) {
      errors.set(k, String(err.stderr || err.message).trim().split('\n').filter(Boolean).pop() || 'clone failed');
    } finally { cloning.delete(k); }
  }
  async function cloneMissing(ws) { for (const r of ws.repos) await cloneOne(ws, r); } // one at a time

  // The AGENTS.md fox keeps at the workspace root, so fx started there knows it is no repo and which subfolder is
  // which. Written when missing, also for workspaces made before it existed, and rewritten when the repos change,
  // but only while it is still the text fox wrote (agentsHash): once you edit it, it is yours and fox leaves it.
  // Returns true when ws changed (its agentsHash), so the caller saves.
  async function ensureNotes(ws) {
    const notes = agentNotes(ws);
    if (!notes || !(await inside(ws.dir))) return false;
    const path = join(ws.dir, 'AGENTS.md');
    const current = await readFile(path, 'utf8').catch(() => null);
    if (current === notes) { if (ws.agentsHash === sha(notes)) return false; ws.agentsHash = sha(notes); return true; }
    if (current !== null && sha(current) !== ws.agentsHash) return false; // someone else's file, or edited by hand
    if (!(await stat(ws.dir).catch(() => null))?.isDirectory()) return false;
    await writeFile(path, notes);
    ws.agentsHash = sha(notes);
    return true;
  }
  const noted = new Set(); // workspace ids whose notes were checked since fox started

  async function repoState(ws, r) {
    const dir = join(ws.dir, r.dir), k = `${ws.id}|${key(r)}`;
    const base = { owner: r.owner, name: r.name, dir: r.dir };
    if (cloning.has(k)) return { ...base, status: 'cloning' };
    if (!existsSync(join(dir, '.git'))) return { ...base, status: errors.has(k) ? 'error' : 'missing', error: errors.get(k) ?? null };
    const run = (args) => git(['-C', dir, ...SAFE_GIT, ...args], { timeout: 5000 }).catch(() => '');
    const [branch, porcelain, counts, def] = await Promise.all([
      run(['rev-parse', '--abbrev-ref', 'HEAD']), run(['status', '--porcelain']),
      run(['rev-list', '--left-right', '--count', '@{u}...HEAD']), run(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
    ]);
    const [behind, ahead] = counts ? counts.split(/\s+/).map(Number) : [0, 0];
    return { ...base, status: 'ready', branch, default: def.replace(/^origin\//, '') || null, changed: porcelain ? porcelain.split('\n').filter(Boolean).length : 0, ahead: ahead || 0, behind: behind || 0 };
  }

  return {
    rootDir,
    async list() {
      let all = await load();
      // Once per workspace per run of fox: workspaces from before the notes get theirs.
      const unchecked = all.filter((w) => !noted.has(w.id));
      if (unchecked.length) {
        let changed = false;
        for (const w of unchecked) { noted.add(w.id); changed = (await ensureNotes(w).catch(() => false)) || changed; }
        if (changed) await save(all);
      }
      return Promise.all(all.map(async (ws) => ({ ...ws, repos: await Promise.all(ws.repos.map((r) => repoState(ws, r))) })));
    },
    async get(id) { return (await load()).find((w) => w.id === id) ?? null; },
    // Creates the entry and the folder, answers at once and clones in the background (poll list()).
    // No repos is fine: an empty folder to start something from scratch. The name is the folder, for good.
    async create({ name, repos = [] }) {
      name = String(name ?? '').trim();
      if (!WORKSPACE_NAME.test(name)) throw Object.assign(new Error('Use lowercase letters, numbers, dots, dashes or underscores for the name.'), { status: 400 });
      if (!Array.isArray(repos) || !repos.every(validRepo)) throw Object.assign(new Error('Invalid repo.'), { status: 400 });
      const all = await load();
      const dir = join(rootDir, name);
      if (all.some((w) => w.name === name || resolve(w.dir) === resolve(dir))) throw Object.assign(new Error(`A workspace named ${name} already exists.`), { status: 409 });
      if ((await readdir(dir).catch(() => [])).length) throw Object.assign(new Error(`~/workspaces/${name} already exists and is not empty. Pick another name.`), { status: 409 });
      await mkdir(dir, { recursive: true });
      if (!(await inside(dir))) throw Object.assign(new Error('Workspace folder is outside ~/workspaces.'), { status: 400 });
      const ws = { id: randomUUID(), name, dir, repos: [], createdAt: Date.now() };
      for (const r of repos) {
        if (ws.repos.some((x) => key(x) === key(r))) continue;
        const repo = { owner: String(r.owner), name: String(r.name) };
        ws.repos.push({ ...repo, dir: folderFor(ws, { ...repo, dir: '' }) });
      }
      await ensureNotes(ws).catch(() => {}); noted.add(ws.id);
      all.push(ws); await save(all);
      cloneMissing(ws);
      return ws;
    },
    async update(id, { name, add = [], remove = [] }) {
      const all = await load();
      const ws = all.find((w) => w.id === id);
      if (!ws) throw Object.assign(new Error('Workspace not found.'), { status: 404 });
      if (name !== undefined && String(name).trim() !== ws.name) throw Object.assign(new Error('The name is the folder and cannot change. Create a new workspace instead.'), { status: 400 });
      if (!add.every(validRepo) || !remove.every(validRepo)) throw Object.assign(new Error('Invalid repo.'), { status: 400 });
      const drop = new Set(remove.map(key));
      ws.repos = ws.repos.filter((r) => !drop.has(key(r))); // leaves its folder on disk
      for (const r of add) {
        if (ws.repos.some((x) => key(x) === key(r))) continue;
        const repo = { owner: String(r.owner), name: String(r.name) };
        ws.repos.push({ ...repo, dir: folderFor(ws, { ...repo, dir: '' }) });
      }
      await ensureNotes(ws).catch(() => {});
      await save(all);
      cloneMissing(ws);
      return ws;
    },
    async retry(id) { const ws = await this.get(id); if (ws) { for (const r of ws.repos) errors.delete(`${ws.id}|${key(r)}`); cloneMissing(ws); } return Boolean(ws); },
    // Fetch only: never merges or pulls.
    async fetch(id) {
      const ws = await this.get(id);
      if (!ws) return false;
      await Promise.all(ws.repos.map((r) => existsSync(join(ws.dir, r.dir, '.git')) ? git(['-C', join(ws.dir, r.dir), 'fetch', '--quiet', '--prune'], { timeout: 60000 }).catch(() => {}) : null));
      return true;
    },
    // What stops the folder from being deleted: dirty, ignored or unpushed repos, and any file that is not a repo.
    async blockers(id) {
      const ws = await this.get(id);
      if (!ws) return null;
      const out = [];
      const repoDirs = new Set(ws.repos.map((r) => r.dir));
      for (const r of ws.repos) {
        const dir = join(ws.dir, r.dir);
        if (!existsSync(dir)) continue; // never cloned: nothing to lose
        // A repo folder without .git (a failed clone, or .git removed) is plain files: nothing says they are pushed.
        if (!existsSync(join(dir, '.git'))) { if ((await readdir(dir).catch(() => [])).length) out.push(`${r.dir}: files outside git`); continue; }
        const run = (args) => git(['-C', dir, ...SAFE_GIT, ...args], { timeout: 10000 });
        const dirty = await run(['status', '--porcelain']).catch(() => 'unknown');
        if (dirty) out.push(`${r.dir}: uncommitted changes`);
        // Ignored local files are absent from status but still must not be deleted.
        const ignored = await run(['ls-files', '--others', '--ignored', '--exclude-standard']).catch(() => null);
        if (ignored === null) out.push(`${r.dir}: unable to check ignored files`);
        else if (ignored) out.push(`${r.dir}: ignored files`);
        // Commits on any ref (a detached HEAD and a stash too) that no remote has.
        const unpushed = await run(['log', '--all', '--not', '--remotes', '--oneline', '-n', '1']).catch(() => 'unknown');
        if (unpushed) out.push(`${r.dir}: commits not pushed`);
      }
      for (const entry of await readdir(ws.dir).catch(() => [])) {
        if (repoDirs.has(entry)) continue;
        // The AGENTS.md fox wrote, untouched, is fox's own; anything else is yours.
        if (entry === 'AGENTS.md' && ws.agentsHash && sha(await readFile(join(ws.dir, entry), 'utf8').catch(() => '')) === ws.agentsHash) continue;
        out.push(`${entry}: not one of the workspace repos`);
      }
      const shared = (await load()).filter((w) => w.id !== ws.id && resolve(w.dir) === resolve(ws.dir));
      for (const w of shared) out.push(`the folder is also the workspace ${w.name}`);
      return out;
    },
    async remove(id, { deleteFolder = false } = {}) {
      const all = await load();
      const ws = all.find((w) => w.id === id);
      if (!ws) throw Object.assign(new Error('Workspace not found.'), { status: 404 });
      if (deleteFolder) {
        const blocking = await this.blockers(id);
        if (blocking.length) throw Object.assign(new Error(`The folder was kept: ${blocking.join('; ')}.`), { status: 409, blockers: blocking });
        if (!(await inside(ws.dir)) || resolve(ws.dir) === resolve(rootDir)) throw Object.assign(new Error('Workspace folder is outside ~/workspaces.'), { status: 400 });
        if ((await stat(ws.dir).catch(() => null))?.isDirectory()) await rm(ws.dir, { recursive: true, force: true });
      }
      await save(all.filter((w) => w.id !== id));
      return true;
    },
    // Only configured, cloned siblings inside this workspace can become extra fx file-access roots.
    async companions(cwd) {
      if (typeof cwd !== 'string') return [];
      const ws = await this.forPath(cwd);
      if (!ws || !(await inside(ws.dir))) return [];
      const root = await realpath(ws.dir).catch(() => null);
      const current = await realpath(cwd).catch(() => null);
      // Parent links (including macOS's /var) are fine; links inside the workspace are not.
      if (!root || !current || current === root || current !== join(root, relative(resolve(ws.dir), resolve(cwd))) || !current.startsWith(root + sep)) return [];
      if (!ws.repos.some((r) => REPO_PART.test(r.dir) && (current === join(root, r.dir) || current.startsWith(join(root, r.dir) + sep)))) return [];
      const repos = [];
      for (const r of ws.repos) {
        if (!REPO_PART.test(r.dir) || r.dir === '..') continue;
        const dir = join(ws.dir, r.dir), realDir = join(root, r.dir);
        // Do not expose links, missing clones or folders without git, even if listed in workspaces.json.
        if (await realpath(dir).catch(() => null) !== realDir || !(await stat(dir).catch(() => null))?.isDirectory() ||
            !(await stat(join(dir, '.git')).catch(() => null))) continue;
        if (current === realDir || current.startsWith(realDir + sep)) continue;
        repos.push({ owner: r.owner, name: r.name, dir });
      }
      return repos;
    },
    async validateCompanions(cwd, dirs) {
      if (!Array.isArray(dirs) || dirs.length > 32 || dirs.some((d) => typeof d !== 'string' || !d.startsWith('/') || d.length > 4096))
        throw Object.assign(new Error('Invalid companion directories.'), { status: 400 });
      if (!dirs.length) return [];
      const allowed = new Set((await this.companions(cwd)).map((r) => r.dir));
      if (new Set(dirs).size !== dirs.length || dirs.some((d) => !allowed.has(d)))
        throw Object.assign(new Error('Choose cloned sibling repos in this workspace.'), { status: 400 });
      return dirs;
    },
    // The workspace a folder belongs to (the folder itself or anything inside it).
    async forPath(path) {
      const p = resolve(path);
      return (await load()).find((w) => p === resolve(w.dir) || p.startsWith(resolve(w.dir) + sep)) ?? null;
    },
  };
}

// Repos you can pick: every owner gh can see (your user, your orgs, and owners with a token in
// ~/.config/fox-git/tokens), newest first. Token files let one server hold one fine-grained token per owner.
export function createRepoCatalog({ tokensDir, gh = 'gh', ttlMs = 5 * 60 * 1000, now = () => Date.now() }) {
  let cache = null;
  const run = (args, env = {}) => execFileP(gh, args, { timeout: 30000, env: { ...process.env, GH_PROMPT_DISABLED: '1', ...env } }).then((x) => x.stdout);
  async function tokenFor(owner) {
    try { return (await readFile(join(tokensDir, owner.toLowerCase()), 'utf8')).trim() || null; } catch { return null; }
  }
  async function fetchAll() {
    const owners = new Map(); // lowercased -> display name
    const login = (await run(['api', 'user', '--jq', '.login']).catch(() => '')).trim();
    if (login) owners.set(login.toLowerCase(), login);
    for (const o of (await run(['api', 'user/orgs', '--jq', '.[].login']).catch(() => '')).split('\n').map((x) => x.trim()).filter(Boolean)) owners.set(o.toLowerCase(), o);
    for (const f of await readdir(tokensDir).catch(() => [])) if (REPO_PART.test(f) && !owners.has(f.toLowerCase())) owners.set(f.toLowerCase(), f);
    if (!owners.size) throw new Error('gh is not signed in: run gh auth login on this machine to list repos.');
    const groups = [];
    for (const [low, display] of owners) {
      const token = await tokenFor(low);
      const env = token ? { GH_TOKEN: token } : {};
      try {
        const repos = JSON.parse(await run(['repo', 'list', display, '--limit', '200', '--json', 'name,owner,isPrivate,updatedAt,description'], env));
        if (repos.length) groups.push({ owner: repos[0].owner.login, repos: repos.map((r) => ({ owner: r.owner.login, name: r.name, private: r.isPrivate, updatedAt: r.updatedAt, description: r.description || '' })) });
      } catch {}
    }
    return groups;
  }
  return {
    async list({ refresh = false } = {}) {
      if (!refresh && cache && now() - cache.at < ttlMs) return cache.groups;
      const groups = await fetchAll();
      cache = { at: now(), groups };
      return groups;
    },
  };
}
