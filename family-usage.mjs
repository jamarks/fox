// A family is the parent plus the child IDs it lists, not every row with an owner pointer: the
// latter can be orphaned, and repeated child entries must not inflate the local estimate.
const tokens = (n) => Number.isFinite(n) && n > 0 ? n : 0;

export function familyUsage(parent, byId) {
  const ids = new Set([parent.id, ...(parent.children ?? []).map((c) => c.id)]);
  const rows = [];
  for (const id of ids) {
    const session = byId.get(id);
    const usage = session?.usage;
    if (!session || !Number.isFinite(usage?.savedAt)) continue;
    const input = tokens(usage.input), output = tokens(usage.output), cacheRead = tokens(usage.cacheRead);
    rows.push({ id, model: session.model ?? null, input, output, cacheRead,
      tokens: input + output + cacheRead, savedAt: usage.savedAt,
      pending: session.state === 'working' || session.state === 'external' ||
        (Number.isFinite(session.updatedAt) && session.updatedAt - usage.savedAt > 60_000) });
  }
  if (!rows.length) return null;
  return { tokens: rows.reduce((sum, row) => sum + row.tokens, 0),
    missing: ids.size - rows.length, rows };
}
