// Provider headroom is an explicitly refreshed, process-local view of fx usage reports.
// Keep only display-safe fields; never retain raw CLI output or provider diagnostics.
const number = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const percent = (v) => number(v) !== null && v <= 100 ? v : null;
const text = (v) => typeof v === 'string' && /^[\w .-]{1,40}$/.test(v) ? v : null;
const time = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null;
const sources = { gateway: 'ai_gateway', codex: 'chatgpt', grok: 'grok' };

export function normalizeUsage(raw, provider) {
  if (!raw || raw.kind !== 'usage' || raw.schema_version !== 2 || raw.source !== sources[provider] || raw.period !== 'today' || raw.status !== 'ready') throw new Error('Invalid usage report');
  const data = {};
  if (provider === 'gateway') {
    const b = raw.budget;
    if (number(b?.limit) !== null && number(b?.spent) !== null) data.budget = { limit: b.limit, spent: b.spent, period: text(b.period) };
    if (number(raw.totals?.spend) !== null) data.spend = raw.totals.spend;
  } else if (provider === 'codex') {
    if (text(raw.codex?.plan)) data.plan = text(raw.codex.plan);
    data.limits = (Array.isArray(raw.codex?.limits) ? raw.codex.limits : []).slice(0, 16).flatMap((limit) => {
      const name = text(limit?.name);
      if (!name) return [];
      return ['primary', 'secondary'].flatMap((key) => {
        const w = limit[key];
        if (percent(w?.used_percent) === null || number(w?.window_seconds) === null || w.window_seconds === 0) return [];
        return [{ name, usedPercent: w.used_percent, windowSeconds: w.window_seconds, resetsAt: time(w.resets_at_ms) }];
      });
    });
    if (raw.codex?.credits?.has_credits && !raw.codex.credits.unlimited && typeof raw.codex.credits.balance === 'string' && /^\d+(\.\d{1,2})?$/.test(raw.codex.credits.balance)) data.credits = raw.codex.credits.balance;
    if (raw.codex?.spend_limit_reached === true) data.spendLimitReached = true;
  } else if (provider === 'grok') {
    const g = raw.grok;
    if (text(g?.settings?.plan)) data.plan = text(g.settings.plan);
    if (percent(g?.used_percent) !== null) data.allowance = { usedPercent: g.used_percent, period: text(g.period), resetsAt: time(g.resets_at_ms) };
    if (number(g?.prepaid_cents) !== null) data.prepaidCents = g.prepaid_cents;
    if (number(g?.on_demand_used_cents) !== null) data.onDemandCents = g.on_demand_used_cents;
    if (number(g?.on_demand_cap_cents) !== null) data.onDemandCapCents = g.on_demand_cap_cents;
  }
  return { data, fetchedAt: time(raw.fetched_at_ms) };
}

export function createUsage({ fx, now = () => Date.now(), maxAgeMs = 60_000 }) {
  const cache = new Map(), pending = new Map();
  return {
    async refresh(provider) {
      if (!Object.hasOwn(sources, provider)) return { status: 'unsupported' };
      const old = cache.get(provider);
      if (old?.status === 'ready' && now() - old.observedAt >= 0 && now() - old.observedAt < maxAgeMs) return old;
      if (pending.has(provider)) return pending.get(provider);
      const request = (async () => {
        try {
          const raw = JSON.parse(await fx(['usage', '--period', 'today', '--json'], { FX_PROVIDER: provider }));
          const report = normalizeUsage(raw, provider);
          const result = { status: 'ready', ...report, observedAt: now() };
          cache.set(provider, result);
          return result;
        } catch {
          // Failed refreshes do not renew the TTL, nor erase the previous observation.
          return { status: old ? 'stale' : 'unavailable', ...(old ? { data: old.data, fetchedAt: old.fetchedAt, observedAt: old.observedAt } : {}) };
        }
      })().finally(() => pending.delete(provider));
      pending.set(provider, request);
      return request;
    },
  };
}
