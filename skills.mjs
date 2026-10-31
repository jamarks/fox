// Skills fx discovers. GitHub content is held in memory for an explicit preview/confirmation; never execute it.
import { readdir, lstat, readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { join, resolve, sep, posix } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export const SOURCES = ['vercel-labs/skills', 'anthropics/skills', 'mattpocock/skills', 'vercel-labs/agent-browser'];
const USER_ROOTS = [['.fx/skills', 'fx'], ['.claude/skills', 'Claude Code'], ['.codex/skills', 'Codex'], ['.config/opencode/skills', 'opencode'], ['.agents/skills', 'agents'], ['.claw/skills', 'claw']];
const PROJECT_ROOTS = [['.fx/skills', 'workspace'], ['skills', 'workspace'], ['.opencode/skills', 'opencode'], ['.codex/skills', 'Codex'], ['.claude/skills', 'Claude Code'], ['.agents/skills', 'agents'], ['.claw/skills', 'claw']];
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const hash = (b) => createHash('sha256').update(b).digest('hex');
export const header = (text) => {
  const yaml = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1] ?? '';
  const field = (key) => {
    const lines = yaml.split(/\r?\n/);
    const i = lines.findIndex((line) => line.startsWith(`${key}:`));
    if (i < 0) return '';
    const value = lines[i].slice(key.length + 1).trim();
    if (/^[|>][-+]?\s*$/.test(value)) {
      const block = [];
      for (let j = i + 1; j < lines.length && (!lines[j].trim() || /^\s/.test(lines[j])); j++) block.push(lines[j].trim());
      return block.join(value.startsWith('>') ? ' ' : '\n').trim();
    }
    if (value.startsWith('"') && value.endsWith('"')) {
      try { return JSON.parse(value); } catch { return value.slice(1, -1); }
    }
    return value.replace(/^'|'$/g, '');
  };
  return { name: field('name'), description: field('description') };
};
const safeFile = (p) => p.split('/').every((s) => s && s !== '.' && s !== '..' && s !== '.git') && !p.includes('\\') && !p.includes('\0');
const plain = (b) => { try { return !b.includes(0) && new TextDecoder('utf-8', { fatal: true }).decode(b) !== undefined; } catch { return false; } };
// Text only, but room for skills that ship reference files (Office schemas, API docs).
const MAX_FILE = 1024 * 1024, MAX_TOTAL = 4 * 1024 * 1024, MAX_FILES = 120;
// A skill is a folder under skills/ holding SKILL.md, at any depth (skills/<group>/<name> too), unless a folder above it
// is already a skill: then it is that skill's own material. A SKILL.md at the root makes the whole repo one skill.
function skillDirs(entries) {
  const all = entries.filter((x) => x.type === 'blob' && /^skills\/(?:[^/]+\/)*[^/]+\/SKILL\.md$/.test(x.path)).map((x) => posix.dirname(x.path));
  const dirs = all.filter((d) => !all.some((o) => d.startsWith(o + '/'))).sort();
  if (entries.some((x) => x.path === 'SKILL.md' && x.type === 'blob')) dirs.unshift('');
  return dirs;
}
// skills.sh names a skill by its id, which is its folder's name; it may sit outside skills/ (say .claude/skills/x).
function findDir(entries, id) {
  const listed = skillDirs(entries);
  if (listed.includes(id)) return id;
  const all = entries.filter((x) => x.type === 'blob' && /(?:^|\/)SKILL\.md$/.test(x.path)).map((x) => x.path.includes('/') ? posix.dirname(x.path) : '');
  const tops = all.filter((d) => !all.some((o) => o !== d && (o === '' ? false : d.startsWith(o + '/'))));
  const hits = tops.filter((d) => d && posix.basename(d) === id);
  if (hits.length === 1) return hits[0];
  if (!hits.length && tops.includes('') && NAME.test(id)) return '';
  fail(hits.length ? `More than one ${id} in this repository.` : 'That skill is not in this repository.', hits.length ? 409 : 404);
}
const SKILLS_SH = 'https://skills.sh';
// One verdict out of skills.sh's audits: any reviewer failing it or rating it high or critical risk fails it.
export const auditStatus = (entries) => !entries.length ? 'unavailable'
  : entries.some((a) => a.status === 'fail' || ['HIGH', 'CRITICAL'].includes(a.risk)) ? 'fail'
  : entries.some((a) => a.status === 'warn') ? 'warn' : 'pass';
async function fetchText(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { accept: 'text/html,application/json' } });
  if (!r.ok) throw Object.assign(new Error('skills.sh did not answer.'), { status: 502 });
  return r.text();
}
const filesOf = (entries, dir) => entries.filter((x) => x.type !== 'tree' && (dir ? x.path.startsWith(`${dir}/`) : !x.path.includes('/')));
async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

export function createSkills({ home, stateDir, workspaces, web = fetchText, gh = (args) => exec('gh', ['api', ...args], { timeout: 30000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }).then((r) => r.stdout) }) {
  const record = join(stateDir, 'skills.json');
  const previews = new Map(), trees = new Map(), audits = new Map();
  let writing = Promise.resolve();
  const locked = (fn) => { const p = writing.then(fn); writing = p.catch(() => {}); return p; };
  const records = async () => { try { return JSON.parse(await readFile(record, 'utf8')); } catch { return {}; } };
  async function save(r) { await mkdir(stateDir, { recursive: true, mode: 0o700 }); const tmp = `${record}.${randomUUID()}`; await writeFile(tmp, JSON.stringify(r), { mode: 0o600 }); await rename(tmp, record); }
  // Installs go to .claude/skills (in home, or in the workspace): Claude Code reads only that folder and fx reads it
  // too, so one copy serves both agents. Earlier installs went to .fx/skills, which only fx reads; they still count.
  async function base(scope) {
    if (scope === 'global') return home;
    const ws = typeof scope === 'string' && scope.startsWith('workspace:') ? await workspaces.get(scope.slice(10)) : null;
    if (!ws || !resolve(ws.dir).startsWith(resolve(home, 'workspaces') + sep) || await lstat(ws.dir).then((s) => !s.isDirectory()).catch(() => true)) fail('Unknown workspace.');
    return ws.dir;
  }
  const target = async (scope) => join(await base(scope), '.claude/skills');
  const roots = async (scope) => { const b = await base(scope); return [join(b, '.claude/skills'), join(b, '.fx/skills')]; };
  // Never follow a symlink in an installation destination (including a parent created by someone else).
  async function ensureParents(dir) {
    const root = resolve(dir); let path = root.startsWith(resolve(home) + sep) ? resolve(home) : fail('Invalid target.');
    for (const part of root.slice(path.length + 1).split(sep)) {
      path = join(path, part);
      const st = await lstat(path).catch(() => null);
      if (st && !st.isDirectory()) fail('Skill destination contains a symlink or file.', 409);
      if (!st) await mkdir(path, { mode: 0o700 });
    }
  }
  async function scan(root, group, scope, owned) {
    // Discovery must not follow linked workspace, repo, or skill roots into arbitrary private folders.
    let parent = resolve(home);
    for (const part of resolve(root).slice(parent.length + 1).split(sep)) {
      if (!part) return [];
      parent = join(parent, part);
      if (!(await lstat(parent).catch(() => null))?.isDirectory()) return [];
    }
    const out = [];
    for (const e of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || !NAME.test(e.name)) continue;
      const path = join(root, e.name, 'SKILL.md');
      const st = await lstat(path).catch(() => null);
      if (!st?.isFile() || st.size > 128 * 1024) continue;
      const b = await readFile(path).catch(() => null);
      if (!b || b.length > 128 * 1024 || !plain(b)) continue;
      const meta = header(b.toString('utf8'));
      out.push({ id: `${scope}|${root}|${e.name}`, name: meta.name || e.name, description: meta.description, group, scope,
        owned: Boolean(owned[`${scope}|${e.name}`]?.path === join(root, e.name)),
        source: owned[`${scope}|${e.name}`]?.path === join(root, e.name) ? owned[`${scope}|${e.name}`].source : null,
        path: join(root, e.name) });
    }
    return out;
  }
  async function list() {
    const owned = await records(), items = [];
    for (const [root, group] of USER_ROOTS) items.push(...await scan(join(home, root), group, 'global', owned));
    for (const ws of await workspaces.list()) {
      if (!resolve(ws.dir).startsWith(resolve(home, 'workspaces') + sep)) continue;
      // fox's skills only: the workspace folder is fox's, its repos are not. A repo's own skills (a catalogue repo
      // can carry dozens) still reach fx in sessions there, but they belong to that repo, not to this page.
      for (const [root, group] of PROJECT_ROOTS) items.push(...await scan(join(ws.dir, root), `${ws.name} · ${group}`, `workspace:${ws.id}`, owned));
    }
    return { items, sources: SOURCES, scopes: (await workspaces.list()).map((w) => ({ id: `workspace:${w.id}`, name: w.name })) };
  }
  async function read(id) {
    const item = (await list()).items.find((x) => x.id === id);
    if (!item) fail('Skill not found.', 404);
    const path = join(item.path, 'SKILL.md');
    const st = await lstat(path);
    if (!(await lstat(item.path)).isDirectory() || !st.isFile() || st.size > 128 * 1024) fail('Skill changed.', 409);
    const b = await readFile(path);
    if (b.length > 128 * 1024 || !plain(b)) fail('Skill is not plain text.', 400);
    return { ...item, text: b.toString('utf8') };
  }
  // Only GitHub file links are accepted; no arbitrary URL is fetched. The ref is a single URL segment
  // (branch names containing / need a commit permalink), and the selected path must be an actual SKILL.md.
  function skillLink(value) {
    let url;
    try { url = new URL(value); } catch { fail('Enter a GitHub SKILL.md URL.'); }
    const parts = url.pathname.split('/').slice(1);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port || url.search || url.hash || value.includes('%') ||
        parts.length < 5 || parts[2] !== 'blob' || parts.at(-1) !== 'SKILL.md' ||
        parts.some((p) => !p || p.includes('%') || p === '..') || !REPO.test(parts.slice(0, 2).join('/')) ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(parts[3])) fail('Enter a GitHub SKILL.md URL (https://github.com/owner/repo/blob/ref/path/SKILL.md).');
    const dir = parts.slice(4, -1).join('/');
    if (dir && !safeFile(dir)) fail('Unsafe skill path.');
    return { source: parts.slice(0, 2).join('/'), ref: parts[3], dir };
  }
  // A repo's tree, held a few minutes for the cards and lists; a preview reads it fresh, since that is what installs.
  async function repoTree(source, fresh = false, ref = 'HEAD') {
    if (typeof source !== 'string' || !REPO.test(source) || source.includes('..')) fail('Enter a GitHub owner/repo.');
    const key = `${source}@${ref}`, hit = trees.get(key);
    if (!fresh && hit && hit.until > Date.now()) return hit.entries;
    const tree = JSON.parse(await gh([`repos/${source}/git/trees/${ref}?recursive=1`]));
    if (tree.truncated || !Array.isArray(tree.tree) || tree.tree.length > 10000) fail('Repository tree is too large or incomplete.');
    trees.set(key, { until: Date.now() + 10 * 60_000, entries: tree.tree });
    return tree.tree;
  }
  async function blob(source, f) {
    const j = JSON.parse(await gh([`repos/${source}/git/blobs/${f.sha}`]));
    const b = Buffer.from(String(j.content ?? '').replace(/\s/g, ''), 'base64');
    if (j.encoding !== 'base64' || b.length !== f.size || !plain(b)) fail(`${f.path} is not a text file or changed during download.`);
    return b;
  }
  // What the tree alone says would stop an install, so the list can say it before anything is downloaded.
  function problem(files) {
    if (files.length > MAX_FILES) return `${files.length} files, more than ${MAX_FILES}`;
    if (files.some((f) => f.type !== 'blob' || f.mode !== '100644' && f.mode !== '100755' || !/^[a-f0-9]{40}$/.test(f.sha))) return 'contains links or submodules';
    if (files.some((f) => !safeFile(f.path))) return 'contains unsafe paths';
    if (files.some((f) => !Number.isSafeInteger(f.size) || f.size > MAX_FILE)) return 'has a file over 1 MB';
    if (files.reduce((a, f) => a + f.size, 0) > MAX_TOTAL) return 'over 4 MB in all';
    return null;
  }
  // skills.sh, the open skills directory: its search API (the one `npx skills find` uses) and, for Popular, the
  // ranking its home page carries (there is no API for it). Only repo and skill names come from there; what gets
  // installed is still read from GitHub and reviewed file by file.
  const shSkill = (x) => x && REPO.test(x.source) && NAME.test(x.skillId) ? { source: x.source, skill: x.skillId, name: String(x.name || x.skillId).slice(0, 100), installs: Number(x.installs) || 0 } : null;
  let popularCache = null;
  async function popular() {
    if (popularCache && popularCache.until > Date.now()) return popularCache.value;
    const html = (await web(`${SKILLS_SH}/`)).replace(/\\"/g, '"'), seen = new Map();
    for (const m of html.matchAll(/"source":"([^"]+)","skillId":"([^"]+)","name":"([^"]*)","installs":(\d+)/g)) {
      const s = shSkill({ source: m[1], skillId: m[2], name: m[3], installs: m[4] });
      if (s && !seen.has(`${s.source}/${s.skill}`)) seen.set(`${s.source}/${s.skill}`, s);
    }
    if (!seen.size) fail('Could not read skills.sh. Pick a repo instead.', 502);
    popularCache = { until: Date.now() + 60 * 60_000, value: { skills: [...seen.values()].sort((a, b) => b.installs - a.installs).slice(0, 60) } };
    return popularCache.value;
  }
  async function search({ q }) {
    if (typeof q !== 'string' || q.trim().length < 2 || q.length > 100) fail('Type at least 2 characters.');
    const j = JSON.parse(await web(`${SKILLS_SH}/api/search?${new URLSearchParams({ q: q.trim(), limit: '50' })}`));
    return { skills: (Array.isArray(j.skills) ? j.skills : []).map(shSkill).filter(Boolean).slice(0, 50) };
  }
  // A repo's skills with the name and description from each SKILL.md: only those files are downloaded here.
  async function browse({ source }) {
    const entries = await repoTree(source), dirs = skillDirs(entries);
    if (!dirs.length) fail('No SKILL.md in this repository.', 404);
    if (dirs.length > 300) fail('Too many skills in this repository.');
    const skills = await pool(dirs, 8, async (dir) => {
      const files = filesOf(entries, dir), md = files.find((f) => f.path === (dir ? `${dir}/SKILL.md` : 'SKILL.md'));
      let meta = { name: '', description: '' };
      try { if (md.size <= MAX_FILE) meta = header((await blob(source, md)).toString('utf8')); } catch {}
      const name = meta.name || posix.basename(dir) || source.split('/')[1];
      return { dir, name, description: meta.description, files: files.length, size: files.reduce((a, f) => a + f.size, 0),
        problem: problem(files) || (!NAME.test(name) || !meta.description ? 'SKILL.md needs a name and a description' : null) };
    });
    return { source, skills };
  }
  // One skill from a repo's list, to read before ticking it: its SKILL.md and the files that would come with it.
  async function peek({ source, dir }) {
    const entries = await repoTree(source);
    if (typeof dir !== 'string') fail('That skill is not in this repository.', 404);
    dir = findDir(entries, dir);
    const files = filesOf(entries, dir), md = files.find((f) => f.path === (dir ? `${dir}/SKILL.md` : 'SKILL.md'));
    if (md.size > MAX_FILE) fail('SKILL.md is too large to show.');
    const prefix = dir ? `${dir}/` : '';
    return { source, dir, text: (await blob(source, md)).toString('utf8'), files: files.map((f) => ({ name: f.path.slice(prefix.length), size: f.size })) };
  }
  // skills.sh's security audits of a skill: outside reviewers (Snyk, Socket, Gen…) each say pass, warn or fail,
  // some with a risk level. Public, no token; held a few minutes. Not audited (or skills.sh away): 'unavailable'.
  async function audit(source, id) {
    if (!REPO.test(source) || !NAME.test(id)) return { status: 'unavailable', entries: [] };
    const key = `${source}/${id}`, hit = audits.get(key);
    if (hit && hit.until > Date.now()) return hit.value;
    let value;
    try {
      const j = JSON.parse(await web(`${SKILLS_SH}/api/v1/skills/audit/${key}`));
      const entries = (Array.isArray(j.audits) ? j.audits : []).slice(0, 12).map((a) => ({
        provider: String(a.provider || 'Unknown').slice(0, 60),
        status: ['pass', 'warn', 'fail'].includes(a.status) ? a.status : 'warn',
        risk: String(a.riskLevel || '').toUpperCase().slice(0, 12) || null,
        summary: String(a.summary || '').slice(0, 300),
        at: /^\d{4}-\d{2}-\d{2}/.test(a.auditedAt ?? '') ? a.auditedAt.slice(0, 10) : null,
      }));
      value = { status: auditStatus(entries), entries };
    } catch { value = { status: 'unavailable', entries: [] }; }
    audits.set(key, { value, until: Date.now() + (value.status === 'unavailable' ? 60_000 : 5 * 60_000) });
    return value;
  }
  async function preview({ source, dirs, scope, url }) {
    await target(scope);
    const link = url === undefined ? null : skillLink(url);
    if (link) { source = link.source; dirs = [link.dir]; }
    const entries = await repoTree(source, true, link?.ref);
    if (link && (!entries.some((e) => e.type === 'blob' && e.path === (link.dir ? `${link.dir}/SKILL.md` : 'SKILL.md')) ||
        link.dir.split('/').some((_, i, parts) => entries.some((e) => e.type === 'blob' && e.path === `${parts.slice(0, i).join('/')}${i ? '/' : ''}SKILL.md`)))) fail('That URL does not point to a standalone skill.', 404);
    if (!Array.isArray(dirs) || !dirs.length) fail('Choose at least one skill.');
    if (dirs.length > 40) fail('Choose 40 skills or fewer.');
    if (dirs.some((d) => typeof d !== 'string')) fail('That skill is not in this repository.', 404);
    const skills = [];
    for (const dir of new Set(dirs.map((d) => link ? d : findDir(entries, d)))) {
      const files = filesOf(entries, dir), prefix = dir ? `${dir}/` : '', why = problem(files);
      if (why) fail(`${posix.basename(dir) || source}: ${why}.`);
      const data = await pool(files, 8, async (f) => ({ name: f.path.slice(prefix.length), data: await blob(source, f) }));
      const meta = header(data.find((f) => f.name === 'SKILL.md').data.toString('utf8'));
      if (!NAME.test(meta.name) || !meta.description || meta.description.length > 4000) fail('SKILL.md needs a valid name and description.');
      if (skills.some((s) => s.name === meta.name)) fail('Duplicate skill names.');
      skills.push({ ...meta, files: data, audit: await audit(source, posix.basename(dir) || source.split('/')[1]) });
    }
    const token = randomUUID();
    for (const [k, v] of previews) if (v.until < Date.now()) previews.delete(k);
    previews.set(token, { until: Date.now() + 10 * 60_000, scope, source, skills });
    return { token, source, scope, dir: link?.dir, url: link ? url : undefined, skills: skills.map((s) => ({ name: s.name, description: s.description, audit: s.audit, files: s.files.map((f) => ({ name: f.name, size: f.data.length })), text: s.files.find((f) => f.name === 'SKILL.md').data.toString('utf8') })) };
  }
  // `scope` may change where it goes after the preview (picked next to Install); what goes is what was shown.
  // A skill that failed a security audit installs only with `confirmRisk`, the "Install anyway" of the page.
  async function install(token, scope = null, confirmRisk = false) {
    return locked(async () => {
      const p = previews.get(token);
      if (!p || p.until < Date.now()) { previews.delete(token); fail('Preview expired. Preview again.', 409); }
      const risky = p.skills.filter((s) => s.audit?.status === 'fail').map((s) => s.name);
      if (risky.length && !confirmRisk) fail(`${risky.join(', ')} failed a security audit on skills.sh; install anyway only if you trust it.`, 409);
      previews.delete(token);
      if (scope) p.scope = scope;
      const root = await target(p.scope), owned = await records();
      await ensureParents(root);
      for (const s of p.skills) for (const r of await roots(p.scope)) if (await lstat(join(r, s.name)).catch(() => null)) fail(`${s.name} already exists; nothing was replaced.`, 409);
      const installed = [];
      try {
        for (const s of p.skills) {
          const dir = join(root, s.name);
          await mkdir(dir, { mode: 0o700 }); installed.push(dir);
          for (const f of s.files) {
            const path = join(dir, ...f.name.split('/'));
            await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
            await writeFile(path, f.data, { flag: 'wx', mode: 0o600 });
          }
          owned[`${p.scope}|${s.name}`] = { path: dir, source: p.source, files: Object.fromEntries(s.files.map((f) => [f.name, hash(f.data)])) };
        }
        await save(owned);
      } catch (err) { for (const dir of installed) await rm(dir, { recursive: true, force: true }); throw err; }
      return { installed: p.skills.map((s) => s.name) };
    });
  }
  async function remove(id) {
    return locked(async () => {
      const item = (await list()).items.find((x) => x.id === id);
      if (!item?.owned) fail('Only skills installed by fox can be removed.', 403);
      const owned = await records(), entry = owned[`${item.scope}|${posix.basename(item.path)}`];
      if (!(await roots(item.scope)).some((r) => entry?.path === join(r, posix.basename(item.path))) || !(await lstat(item.path)).isDirectory()) fail('Skill changed.', 409);
      const check = async (dir, prefix = '') => {
        for (const f of await readdir(dir, { withFileTypes: true })) {
          const name = prefix + f.name, path = join(dir, f.name);
          if (f.isDirectory()) {
            if (!Object.keys(entry.files).some((file) => file.startsWith(`${name}/`))) fail('Skill has changed; remove it manually.', 409);
            await check(path, `${name}/`);
          } else if (!f.isFile() || !entry.files[name] || hash(await readFile(path)) !== entry.files[name]) fail('Skill has changed; remove it manually.', 409);
        }
      };
      await check(item.path);
      for (const name of Object.keys(entry.files)) if (!(await lstat(join(item.path, ...name.split('/'))).catch(() => null))?.isFile()) fail('Skill has changed; remove it manually.', 409);
      await rm(item.path, { recursive: true }); delete owned[`${item.scope}|${posix.basename(item.path)}`]; await save(owned);
      return { removed: true };
    });
  }
  return { list, read, popular, search, browse, peek, preview, install, remove };
}
