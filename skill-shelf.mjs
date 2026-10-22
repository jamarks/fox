// Read only the small catalog headers from fx's documented project and personal skill roots.
// Skill bodies are never returned to the browser, and symlinks cannot move a scan outside a root.
import { readdir, lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { header } from './skills.mjs';

const PROJECT_ROOTS = ['.fx/skills', 'skills', '.opencode/skills', '.codex/skills', '.claude/skills', '.agents/skills', '.claw/skills'];
const PERSONAL_ROOTS = ['.fx/skills', '.config/opencode/skills', '.codex/skills', '.claude/skills', '.agents/skills', '.claw/skills'];
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const MAX_SKILLS = 200;
const MAX_FILE = 128 * 1024;

function metadata(text, folder) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return NAME.test(folder) ? { name: folder, description: '' } : null;
  const front = /^---\r?\n([\s\S]{0,4096}?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  if (front === undefined || front.split(/\r?\n/).some((line) => line.trim() && !/^([a-zA-Z][\w-]*:|\s+)/.test(line))) return null;
  const fields = header(text);
  const name = fields.name || folder, description = fields.description.replace(/\s+/g, ' ').trim();
  if (!NAME.test(name) || /[\x00-\x1f\x7f-\x9f]/.test(fields.description) || /[\[\]{}<>]/.test(description)) return null;
  return { name, description: description.slice(0, 160) };
}

export async function listSkills(cwd, home) {
  if (typeof cwd !== 'string' || !cwd || cwd.length > 4096) throw Object.assign(new Error('Invalid directory'), { status: 400 });
  let dir, homeReal;
  try {
    dir = await realpath(cwd);
    homeReal = await realpath(home);
    if (!(await lstat(dir)).isDirectory()) throw new Error('not directory');
  } catch { throw Object.assign(new Error('Directory not found'), { status: 400 }); }
  const roots = [];
  // Work upwards as fx does, but never inspect the home directory as a project root.
  // An outside-home directory is not a reason to scan its ancestors up to /.
  const inHome = dir.startsWith(homeReal + sep);
  for (let at = dir, depth = 0; (inHome ? at !== homeReal : at === dir) && depth < 32; at = dirname(at), depth++) {
    for (const root of PROJECT_ROOTS) roots.push({ base: at, parts: root.split('/'), source: at === dir ? `Project · ${root}` : `Parent · ${root}` });
  }
  for (const root of PERSONAL_ROOTS) roots.push({ base: homeReal, parts: root.split('/'), source: `Personal · ${root}` });
  const skills = [];
  for (const root of roots) {
    if (skills.length >= MAX_SKILLS) break;
    // Require real directories at every step: a symlinked root or skill is not a discovery root.
    let path = root.base, safe = true;
    try {
      for (const part of root.parts) { path = join(path, part); if (!(await lstat(path)).isDirectory()) { safe = false; break; } }
      if (!safe) continue;
      const entries = (await readdir(path, { withFileTypes: true })).filter((e) => e.isDirectory() && NAME.test(e.name)).slice(0, MAX_SKILLS);
      for (const entry of entries) {
        if (skills.length >= MAX_SKILLS) break;
        const file = join(path, entry.name, 'SKILL.md');
        try {
          // Open without following a changed SKILL.md symlink, and bound what is read.
          const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const info = await handle.stat();
            if (!info.isFile() || info.size > MAX_FILE) continue;
            const skill = metadata(await handle.readFile('utf8'), entry.name);
            if (skill) skills.push({ ...skill, source: root.source });
          } finally { await handle.close(); }
        } catch {} // Missing, unreadable, or changing skills simply do not appear.
      }
    } catch {}
  }
  return skills;
}
