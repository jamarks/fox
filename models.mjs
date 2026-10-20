// A bounded, sanitized model catalog for new sessions. Queries use process-local provider overrides;
// fox never changes fx's saved provider merely to populate a picker.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const LABELS = { codex: 'ChatGPT subscription', gateway: 'Vercel AI Gateway', grok: 'Grok subscription' };
const BUILTINS = { codex: 'codex', grok: 'grok', gateway: 'gateway', 'vercel-ai-gateway': 'gateway' };
const safeName = (s) => typeof s === 'string' && s.length <= 128 && /^[a-z][a-z0-9_-]*$/i.test(s);
const safeId = (s) => typeof s === 'string' && s.length <= 256 && s.length > 0 && !/[\x00-\x1f\x7f]/.test(s) && !s.startsWith('-');
const safeEffort = (s) => typeof s === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(s);

export function connectedProviders(status, settings = {}) {
  const names = Array.isArray(status?.connected_providers) ? status.connected_providers : [];
  const custom = settings.providers && typeof settings.providers === 'object' && !Array.isArray(settings.providers) ? settings.providers : {};
  const ids = new Set(names.map((n) => BUILTINS[String(n).toLowerCase()] ?? n));
  // A configured local endpoint may not appear among authenticated providers.
  for (const name of Object.keys(custom)) ids.add(name);
  if (safeName(settings.provider) && (custom[settings.provider] || LABELS[settings.provider])) ids.add(settings.provider);
  return [...ids].filter(safeName).filter((id) => LABELS[id] || Object.hasOwn(custom, id))
    .map((id) => ({ id, label: LABELS[id] ?? id }));
}

function cleanModels(raw) {
  const details = Array.isArray(raw?.models) ? raw.models : [];
  const byId = new Map(details.filter((m) => safeId(m?.id)).map((m) => [m.id, m]));
  const ids = Array.isArray(raw?.ids) ? raw.ids : [...byId.keys()];
  return [...new Set(ids.filter(safeId))].map((id) => {
    const m = byId.get(id) ?? {};
    return { id, name: typeof m.name === 'string' ? m.name.slice(0, 160) : null,
      efforts: Array.isArray(m.efforts) ? [...new Set(m.efforts.filter(safeEffort))] : [],
      fast: m.fast === true, ultrafast: m.ultrafast === true };
  });
}

export function launchArgs(catalog, { provider, model, effort, speed } = {}) {
  if ([provider, model, effort, speed].every((x) => x == null || x === '')) return [];
  const p = catalog?.providers?.find((x) => x.id === provider);
  const m = p?.details?.find((x) => x.id === model);
  if (!m || !safeName(provider)) throw new Error('Unknown provider or model');
  if (effort && !m.efforts.includes(effort)) throw new Error('Unsupported effort');
  if (speed && !['default', 'fast', 'ultrafast'].includes(speed)) throw new Error('Unsupported speed');
  if (speed === 'fast' && !m.fast || speed === 'ultrafast' && !m.ultrafast) throw new Error('Unsupported speed');
  const args = ['--provider', provider, '--model', model];
  if (effort) args.push('--effort', effort);
  if (speed === 'fast') args.push('--fast', '--no-ultrafast');
  else if (speed === 'ultrafast') args.push('--no-fast', '--ultrafast');
  // No speed selection leaves fx's saved speed untouched, even with an explicit model.
  return args;
}

export function createModels({ fx, file, readSettings, maxAgeMs = 24 * 60 * 60 * 1000, maxStaleMs = 7 * 24 * 60 * 60 * 1000, now = () => Date.now() }) {
  let cache = null, pending = null;
  const readCache = async () => cache ??= await readFile(file, 'utf8').then(JSON.parse).then((v) => v?.schema === 2 ? v : null).catch(() => null);
  const signature = (ps) => ps.map((p) => p.id).sort().join(',');
  async function status() {
    try {
      const result = JSON.parse(await fx(['status', '--json']));
      return Array.isArray(result?.connected_providers) ? result : null;
    } catch { return null; } // older fx: no structured provider status; never infer from text
  }
  async function fetchAll(s) {
    const settings = await readSettings();
    const state = s ?? await status();
    const original = settings.provider ?? null;
    // Without structured status, only the saved provider can be identified on older fx.
    const providers = state ? connectedProviders(state, settings) :
      connectedProviders({ connected_providers: [] }, { provider: original, providers: settings.providers?.[original] ? { [original]: true } : {} });
    const out = { schema: 2, fetchedAt: now(), connected: signature(providers),
      default: { provider: original, model: settings.models?.[original] ?? null }, providers: [] };
    for (const p of providers) {
      try {
        const raw = JSON.parse(await fx(['models', '--json'], state ? { FX_PROVIDER: p.id } : {}));
        if (!Array.isArray(raw?.ids) && !Array.isArray(raw?.models)) throw new Error('Invalid models response');
        const details = cleanModels(raw);
        out.providers.push({ ...p, models: details.map((m) => m.id), details, default: settings.models?.[p.id] ?? null });
      } catch { /* An unlisted provider is retried on the next request, not advertised as selectable. */ }
    }
    // Never replace a complete cache with a partial one after a transient failure.
    if (providers.length && !out.providers.length || (cache && out.providers.length < providers.length)) throw new Error('Could not list models');
    out.connected = signature(out.providers);
    cache = out;
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify(out, null, 2), { mode: 0o600 });
    return out;
  }
  const refresh = (s) => pending ??= fetchAll(s).finally(() => { pending = null; });
  return {
    refresh: () => refresh(),
    async get() {
      const cached = await readCache();
      const s = await status();
      const fresh = cached && now() - cached.fetchedAt >= 0 && now() - cached.fetchedAt < maxAgeMs;
      const usable = cached && now() - cached.fetchedAt >= 0 && now() - cached.fetchedAt < maxStaleMs;
      const settings = await readSettings();
      const sameDefault = cached?.default?.provider === (settings.provider ?? null) && cached?.default?.model === (settings.models?.[settings.provider] ?? null);
      const providers = s ? connectedProviders(s, settings) : null;
      if (usable && sameDefault && (s === null || (fresh && cached.connected === signature(providers)))) return cached;
      try { return await refresh(s); } catch (err) { if (usable) return cached; throw err; }
    },
  };
}
