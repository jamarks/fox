// The models offered when opening a session. `fx models` only lists the active provider, so listing all of them
// means switching provider, listing and switching back: slow, so the result is kept on disk. It is asked again
// when the providers fx is signed in to change (a first `fx login codex` on a new server would otherwise leave
// an empty list forever) or once a day. `fx status` is cheap and answers which ones are connected. A failed
// refresh keeps the last good list; one refresh at a time, since each switches fx's provider.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const PROVIDERS = [
  { id: 'codex', match: /codex/i, label: 'ChatGPT subscription' },
  { id: 'gateway', match: /gateway/i, label: 'Vercel AI Gateway' },
  { id: 'grok', match: /grok/i, label: 'Grok subscription' },
];

export function connectedProviders(status) {
  const names = (status.match(/connected_providers=(.*)/)?.[1] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  return PROVIDERS.filter((p) => names.some((n) => p.match.test(n))).map(({ id, label }) => ({ id, label }));
}

export function createModels({ fx, file, readSettings, maxAgeMs = 24 * 60 * 60 * 1000, now = () => Date.now() }) {
  let cache = null;
  let pending = null;
  const readCache = async () => cache ??= await readFile(file, 'utf8').then(JSON.parse).catch(() => null);
  const ids = (providers) => providers.map((p) => p.id).sort().join(',');

  async function fetchAll(status) {
    const settings = await readSettings();
    const original = settings.provider ?? 'codex';
    const providers = connectedProviders(status ?? await fx(['status']).catch(() => ''));
    const out = { fetchedAt: now(), connected: ids(providers), default: { provider: original, model: settings.models?.[original] ?? null }, providers: [] };
    try {
      for (const p of providers) {
        await fx(['provider', p.id]).catch(() => {});
        let list = [];
        try { list = JSON.parse(await fx(['models', '--json'])).ids ?? []; } catch {}
        out.providers.push({ ...p, models: list, default: settings.models?.[p.id] ?? null });
      }
    } finally {
      if (providers.length) await fx(['provider', original]).catch(() => {});
    }
    cache = out;
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify(out, null, 2), { mode: 0o600 });
    return out;
  }
  const refresh = (status) => pending ??= fetchAll(status).finally(() => { pending = null; });

  return {
    refresh: () => refresh(),
    async get() {
      const cached = await readCache();
      const status = await fx(['status']).catch(() => null);
      const fresh = cached && now() - cached.fetchedAt < maxAgeMs;
      // Unknown status (fx failed): keep what there is rather than switching providers blindly.
      if (cached && (status === null || (fresh && cached.connected === ids(connectedProviders(status))))) return cached;
      try { return await refresh(status ?? ''); } catch (err) { if (cached) return cached; throw err; }
    },
  };
}
