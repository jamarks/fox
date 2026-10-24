// A few of fx's own settings (~/.fx/settings.json, see fx.sh/docs/configure-fx/configuration) that fox shows in
// Settings. Only these keys are read or written; everything else in the file (models, provider…) stays as fx left it.
import { readFile, writeFile, rename, stat, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

export const FX_SETTINGS = [
  { key: 'collapse_tool_calls', label: 'Summarize tool calls', description: 'One line per group of reads, edits and commands', type: 'bool', default: false },
  { key: 'statusLine.context', label: 'Context in the footer', description: 'How full the session is, to know when to start a new one', type: 'bool', default: false },
  { key: 'statusLine.session', label: 'Session title in the footer', description: 'Identify the session in fox’s terminal view', type: 'bool', default: false, introduced: '2026-10-24', documentation: 'https://fx.sh/docs/configure-fx/configuration.md#interface-and-update-settings', upstreamDefault: 'off' },
  { key: 'statusLine.workspace', label: 'Folder and branch in the footer', description: 'Where fx is working and on which git branch', type: 'bool', default: false },
  { key: 'fast_mode', label: 'Fast mode', description: 'Faster answers when the provider supports it', type: 'bool', default: false },
  { key: 'max_tool_result_bytes', label: 'Tool output budget (bytes)', description: 'Limit tool output kept in model context; saved results can be larger', type: 'integer', min: 1024, max: 2147483647, default: 65536, introduced: '2026-10-22', documentation: 'https://fx.sh/docs/configure-fx/configuration.md#project-configuration', upstreamDefault: '65536 bytes' },
  { key: 'session_titles', label: 'Automatic session titles', description: 'Generate a title from the first prompt using a separate model request', type: 'bool', default: false, introduced: '2026-10-23', documentation: 'https://fx.sh/docs/configure-fx/configuration.md#interface-and-update-settings', upstreamDefault: 'on' },
  { key: 'effort', label: 'Effort', description: 'How much the model thinks before answering', type: 'choice', choices: ['auto', 'low', 'medium', 'high'], default: 'auto' },
  { key: 'auto_compact_percent', label: 'Automatic compaction threshold (%)', description: 'Compact the conversation at this percentage of usable input capacity', type: 'integer', min: 10, max: 80, default: 80, introduced: '2026-10-21', documentation: 'https://fx.sh/docs/configure-fx/configuration.md#agent-and-model-settings', upstreamDefault: '80%' },
  { key: 'max_agent_steps', label: 'Maximum steps per turn', description: 'Stop a turn after this many agent steps; 0 means unlimited', type: 'integer', min: 0, max: 2147483647, default: 0, introduced: '2026-10-18', documentation: 'https://fx.sh/docs/configure-fx/configuration.md#project-configuration', upstreamDefault: '0 (unlimited)' },
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
  return FX_SETTINGS.map((s) => ({ ...s, value: getPath(settings, s.key) ?? s.default,
    ...(s.introduced ? { applied: getPath(settings, s.key) !== undefined } : {}) }));
}

// One change, checked against the list above; the rest of the settings are returned as they were.
export function withFxSetting(settings, key, value) {
  const spec = FX_SETTINGS.find((s) => s.key === key);
  if (!spec) throw Object.assign(new Error('fox does not manage that setting'), { status: 400 });
  // Only opt-in entries support removing an override; null never changes legacy defaults.
  if (value === null && spec.introduced) {
    const keys = key.split('.');
    const out = structuredClone(settings);
    let at = out;
    for (const k of keys.slice(0, -1)) {
      if (!at[k] || typeof at[k] !== 'object' || Array.isArray(at[k])) return out;
      at = at[k];
    }
    delete at[keys.at(-1)];
    return out;
  }
  if (spec.type === 'integer' && (!Number.isSafeInteger(value) || value < spec.min || value > spec.max)) throw Object.assign(new Error(`Expected an integer from ${spec.min} to ${spec.max}`), { status: 400 });
  // Do not replace a malformed nested object and silently discard its saved value.
  let parent = settings;
  for (const k of key.split('.').slice(0, -1)) {
    if (parent[k] !== undefined && (!parent[k] || typeof parent[k] !== 'object' || Array.isArray(parent[k]))) throw Object.assign(new Error('Invalid nested setting'), { status: 400 });
    parent = parent[k] ?? {};
  }
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
      await chmod(tmp, mode); // writeFile's mode is filtered by the process umask
      await rename(tmp, file); // whole file at once: fx never reads half of it
      return fxSettingsView(next);
    },
  };
}
