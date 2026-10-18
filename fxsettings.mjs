// A few of fx's own settings (~/.fx/settings.json, see fx.sh/docs/configure-fx/configuration) that fox shows in
// Settings. Only these keys are read or written; everything else in the file (models, provider…) stays as fx left it.
import { readFile, writeFile, rename, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

export const FX_SETTINGS = [
  { key: 'collapse_tool_calls', label: 'Summarize tool calls', description: 'One line per group of reads, edits and commands', type: 'bool', default: false },
  { key: 'statusLine.context', label: 'Context in the footer', description: 'How full the session is, to know when to start a new one', type: 'bool', default: false },
  { key: 'statusLine.workspace', label: 'Folder and branch in the footer', description: 'Where fx is working and on which git branch', type: 'bool', default: false },
  { key: 'fast_mode', label: 'Fast mode', description: 'Faster answers when the provider supports it', type: 'bool', default: false },
  { key: 'effort', label: 'Effort', description: 'How much the model thinks before answering', type: 'choice', choices: ['auto', 'low', 'medium', 'high'], default: 'auto' },
];

const getPath = (obj, path) => path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
function setPath(obj, path, value) {
  const keys = path.split('.');
  const out = { ...obj };
  let at = out;
  for (const k of keys.slice(0, -1)) { at[k] = at[k] && typeof at[k] === 'object' && !Array.isArray(at[k]) ? { ...at[k] } : {}; at = at[k]; }
  at[keys.at(-1)] = value;
  return out;
}

export function fxSettingsView(settings) {
  return FX_SETTINGS.map((s) => ({ ...s, value: getPath(settings, s.key) ?? s.default }));
}

// One change, checked against the list above; the rest of the settings are returned as they were.
export function withFxSetting(settings, key, value) {
  const spec = FX_SETTINGS.find((s) => s.key === key);
  if (!spec) throw Object.assign(new Error('fox does not manage that setting'), { status: 400 });
  if (spec.type === 'bool' && typeof value !== 'boolean') throw Object.assign(new Error('Expected on or off'), { status: 400 });
  if (spec.type === 'choice' && !spec.choices.includes(value)) throw Object.assign(new Error(`Expected one of ${spec.choices.join(', ')}`), { status: 400 });
  return setPath(settings, key, value);
}

export function createFxSettings(file) {
  const read = async () => { try { return JSON.parse(await readFile(file, 'utf8')); } catch (err) { if (err.code === 'ENOENT') return {}; throw err; } };
  return {
    async list() { return fxSettingsView(await read()); },
    async set(key, value) {
      const next = withFxSetting(await read(), key, value);
      const mode = await stat(file).then((s) => s.mode & 0o777, () => 0o600);
      const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', { mode });
      await rename(tmp, file); // whole file at once: fx never reads half of it
      return fxSettingsView(next);
    },
  };
}
