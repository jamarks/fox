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
const header = (text) => {
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

export function createSkills({ home, stateDir, workspaces, gh = (args) => exec('gh', ['api', ...args], { timeout: 30000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }).then((r) => r.stdout) }) {
  const record = join(stateDir, 'skills.json');
  const previews = new Map();
  let writing = Promise.resolve();
  const locked = (fn) => { const p = writing.then(fn); writing = p.catch(() => {}); return p; };
  const records = async () => { try { return JSON.parse(await readFile(record, 'utf8')); } catch { return {}; } };
  async function save(r) { await mkdir(stateDir, { recursive: true, mode: 0o700 }); const tmp = `${record}.${randomUUID()}`; await writeFile(tmp, JSON.stringify(r), { mode: 0o600 }); await rename(tmp, record); }
  async function target(scope) {
    if (scope === 'global') return join(home, '.fx/skills');
    const ws = typeof scope === 'string' && scope.startsWith('workspace:') ? await workspaces.get(scope.slice(10)) : null;
    if (!ws || !resolve(ws.dir).startsWith(resolve(home, 'workspaces') + sep) || await lstat(ws.dir).then((s) => !s.isDirectory()).catch(() => true)) fail('Unknown workspace.');
    return join(ws.dir, '.fx/skills');
  }
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
      for (const [root, group] of PROJECT_ROOTS) items.push(...await scan(join(ws.dir, root), `${ws.name} · ${group}`, `workspace:${ws.id}`, owned));
      // A repo is a session directory; fx sees its own local skills as well as the workspace root.
      for (const repo of ws.repos ?? []) if (NAME.test(repo.dir)) for (const [root, group] of PROJECT_ROOTS)
        items.push(...await scan(join(ws.dir, repo.dir, root), `${ws.name}/${repo.dir} · ${group}`, `repo:${ws.id}`, owned));
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
  async function preview({ source, skill, scope }) {
    if (typeof source !== 'string' || !REPO.test(source) || source.includes('..')) fail('Enter a GitHub owner/repo.');
    await target(scope);
    if (skill && (typeof skill !== 'string' || !NAME.test(skill))) fail('Invalid skill name.');
    const tree = JSON.parse(await gh([`repos/${source}/git/trees/HEAD?recursive=1`]));
    if (tree.truncated || !Array.isArray(tree.tree) || tree.tree.length > 10000) fail('Repository tree is too large or incomplete.');
    const entries = tree.tree;
    const skillDirs = entries.filter((x) => x.type === 'blob' && x.path.endsWith('/SKILL.md') && x.path.startsWith('skills/') && x.path.split('/').length >= 3).map((x) => posix.dirname(x.path));
    if (entries.some((x) => x.path === 'SKILL.md')) skillDirs.push('');
    const dirs = [...new Set(skillDirs)].filter((p) => !skill || posix.basename(p) === skill || (!p && source.split('/')[1] === skill));
    if (!dirs.length) fail('No matching SKILL.md in this repository.', 404);
    if (dirs.length > 40) fail('Choose one skill to install (too many in this repository).');
    let total = 0; const skills = [];
    for (const dir of dirs) {
      const prefix = dir ? `${dir}/` : '';
      const files = entries.filter((x) => x.type !== 'tree' && x.path.startsWith(prefix) && (!dir || !x.path.slice(prefix.length).startsWith('../')) && (dir || !x.path.includes('/')));
      if (!files.some((x) => x.path === `${prefix}SKILL.md`) || files.length > 80) fail('Invalid skill folder.');
      const data = [];
      for (const f of files) {
        const name = f.path.slice(prefix.length);
        if (!safeFile(name) || f.mode !== '100644' && f.mode !== '100755' || !Number.isSafeInteger(f.size) || f.size > 128 * 1024 || (total += f.size) > 2 * 1024 * 1024 || !/^[a-f0-9]{40}$/.test(f.sha)) fail('Skill contains unsafe paths, links, or oversized files.');
        const blob = JSON.parse(await gh([`repos/${source}/git/blobs/${f.sha}`]));
        const b = Buffer.from(String(blob.content ?? '').replace(/\s/g, ''), 'base64');
        if (blob.encoding !== 'base64' || b.length !== f.size || !plain(b)) fail('Skill contains non-text files or changed during download.');
        data.push({ name, data: b });
      }
      const meta = header(data.find((f) => f.name === 'SKILL.md').data.toString('utf8'));
      if (!NAME.test(meta.name) || !meta.description || meta.description.length > 4000) fail('SKILL.md needs a valid name and description.');
      if (skills.some((s) => s.name === meta.name)) fail('Duplicate skill names.');
      skills.push({ ...meta, files: data });
    }
    const token = randomUUID();
    for (const [k, v] of previews) if (v.until < Date.now()) previews.delete(k);
    previews.set(token, { until: Date.now() + 10 * 60_000, scope, source, skills });
    return { token, source, scope, skills: skills.map((s) => ({ name: s.name, description: s.description, files: s.files.map((f) => ({ name: f.name, size: f.data.length })), text: s.files.find((f) => f.name === 'SKILL.md').data.toString('utf8') })) };
  }
  async function install(token) {
    return locked(async () => {
      const p = previews.get(token); previews.delete(token);
      if (!p || p.until < Date.now()) fail('Preview expired. Preview again.', 409);
      const root = await target(p.scope), owned = await records();
      await ensureParents(root);
      for (const s of p.skills) if (await lstat(join(root, s.name)).catch(() => null)) fail(`${s.name} already exists; nothing was replaced.`, 409);
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
      const root = await target(item.scope);
      if (entry?.path !== join(root, posix.basename(item.path)) || !(await lstat(item.path)).isDirectory()) fail('Skill changed.', 409);
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
  return { list, read, preview, install, remove };
}
