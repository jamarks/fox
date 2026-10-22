// Read only the small catalog headers from fx's documented project and personal skill roots.
// Skill bodies are never returned to the browser, and symlinks cannot move a scan outside a root.
import { readdir, lstat, readFile, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const PROJECT_ROOTS = ['.fx/skills', 'skills', '.opencode/skills', '.codex/skills', '.claude/skills', '.agents/skills', '.claw/skills'];
const PERSONAL_ROOTS = ['.fx/skills', '.config/opencode/skills', '.codex/skills', '.claude/skills', '.agents/skills', '.claw/skills'];
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const MAX_SKILLS = 200;
const MAX_FILE = 8192;

function metadata(text, folder) {
  if (!text.startsWith('---\n')) return NAME.test(folder) ? { name: folder, description: '' } : null;
  const end = text.indexOf('\n---', 4);
  if (end < 0 || end > 4096 || !/^\n(?:---|\.\.\.)(?:\r?\n|$)/.test(text.slice(end))) return null;
  const fields = new Map();
  for (const line of text.slice(4, end).split('\n')) {
    if (line.trim() && !/^[a-zA-Z][\w-]*:\s*[^\r\n]*\r?$/.test(line)) return null;
    const match = /^(name|description):\s*(.*)\r?$/.exec(line);
    if (match) {
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      fields.set(match[1], value);
    }
  }
  const name = fields.get('name') ?? folder, description = fields.get('description') ?? '';
  if (!NAME.test(name) || description.length > 160 || /[\x00-\x1f\x7f-\x9f]/.test(description) || /[\[\]{}<>]/.test(description)) return null;
  return { name, description };
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
  for (let at = dir, depth = 0; at !== homeReal && at !== dirname(at) && depth < 32; at = dirname(at), depth++) {
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
          const info = await lstat(file);
          if (!info.isFile() || info.size > MAX_FILE) continue;
          const skill = metadata(await readFile(file, 'utf8'), entry.name);
          if (skill) skills.push({ ...skill, source: root.source });
        } catch {} // Missing, unreadable, or changing skills simply do not appear.
      }
    } catch {}
  }
  return skills;
}
