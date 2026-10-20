// A turn's on-disk events are a completed snapshot, not a live stream. Keep the clock and
// child phases separate so an unfinished parent never looks like a fully recorded turn.
const LIMIT = 60;
const stamp = (n) => Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : null;

export function parseTimeline(raw) {
  const events = [];
  for (const line of raw.split('\n')) {
    try {
      const rec = JSON.parse(line), kind = Object.keys(rec.event ?? {})[0];
      const ts = stamp(rec.timestamp_ms);
      if (ts && ['user', 'tool_call', 'tool_result', 'turn_completed', 'interrupted'].includes(kind))
        events.push({ ts, kind, id: rec.event[kind]?.call_id, name: rec.event[kind]?.tool_name });
    } catch {} // partial last lines and non-events are not timing evidence
  }
  return events.sort((a, b) => a.ts - b.ts);
}

function intervals(events, end, provisional = false) {
  const out = [], calls = new Map();
  let cursor = events[0]?.ts;
  if (!cursor) return out;
  for (const e of events.slice(1)) {
    if (e.ts < cursor || e.ts > end) continue;
    if (e.kind === 'tool_call') {
      if (!calls.size && e.ts > cursor) out.push({ start: cursor, end: e.ts, kind: 'agent' });
      calls.set(e.id, { ts: e.ts, name: e.name });
      cursor = e.ts;
    } else if (e.kind === 'tool_result') {
      const call = calls.get(e.id);
      if (call) {
        out.push({ start: call.ts, end: e.ts, kind: call.name === 'subagent' ? 'handoff' : 'tool', label: call.name });
        calls.delete(e.id);
        if (!calls.size) cursor = e.ts;
      }
    } else if (e.kind === 'turn_completed' || e.kind === 'interrupted') {
      if (!calls.size && e.ts > cursor) out.push({ start: cursor, end: e.ts, kind: 'agent' });
      cursor = e.ts;
    }
  }
  for (const call of calls.values()) if (end > call.ts) out.push({ start: call.ts, end, kind: call.name === 'subagent' ? 'handoff' : 'tool', label: call.name, provisional });
  if (!calls.size && end > cursor) out.push({ start: cursor, end, kind: 'agent', provisional });
  return out.filter((x) => x.end > x.start).sort((a, b) => a.start - b.start).slice(-LIMIT);
}

export function turnTimeline(parent, children = [], now = Date.now(), working = false) {
  const events = parent.filter((e) => e.ts && e.kind);
  const lastUser = events.findLastIndex((e) => e.kind === 'user');
  const lastEnd = events.findLastIndex((e) => e.kind === 'turn_completed' || e.kind === 'interrupted');
  // The current turn may not have been flushed at all. Do not extend an older completed turn.
  const unflushed = working && lastEnd >= lastUser;
  const parentEvents = unflushed ? [] : events.slice(lastUser, lastEnd > lastUser && !working ? lastEnd + 1 : undefined);
  const coarse = !unflushed && parentEvents.length > 0 && parentEvents.every((e) => e.ts === parentEvents[0].ts);
  const previousEnd = events.slice(0, lastUser).findLast((e) => e.kind === 'turn_completed')?.ts ?? 0;
  const end = unflushed ? now : (!working && lastEnd > lastUser ? events[lastEnd].ts : now);
  const eligible = children.slice(0, 12).filter((c) => !coarse || (c.events ?? []).some((e) => e.ts > previousEnd && e.ts <= end));
  const start = unflushed
    ? Math.min(...children.filter((c) => c.phase === 'running').map((c) => stamp(c.startedAt) ?? stamp(c.createdAt)).filter(Boolean), Infinity)
    : coarse ? Math.min(...eligible.map((c) => stamp(c.startedAt) ?? stamp(c.createdAt)).filter(Boolean), Infinity) : events[lastUser]?.ts;
  if (!Number.isFinite(start) || end <= start) return { pending: working, lanes: [], elapsed: 0, chain: [] };
  const lanes = [{ id: null, label: 'parent', intervals: unflushed || coarse ? [] : intervals(parentEvents, end, working) }];
  for (const child of eligible) {
    const from = stamp(child.startedAt) ?? stamp(child.createdAt);
    const childEvents = (child.events ?? []).filter((e) => e.ts >= start && e.ts <= end);
    const first = coarse ? from : childEvents.find((e) => e.kind === 'user')?.ts ?? from;
    if (!first || first > end) continue;
    const done = childEvents.findLast((e) => e.kind === 'turn_completed' || e.kind === 'interrupted')?.ts;
    const active = child.phase === 'running' && working;
    const until = active ? end : Math.min(end, done ?? childEvents.at(-1)?.ts ?? first);
    const laneEvents = coarse ? [{ kind: 'user', ts: first }] : childEvents.length ? childEvents : [{ kind: 'user', ts: first }];
    lanes.push({ id: child.id, label: child.name || child.label || `agent ${lanes.length}`, intervals: intervals(laneEvents, until, active), start: first, end: until });
  }
  // Slice the parent clock at boundaries: overlapping calls contribute only once to an
  // observed path. Handoffs use the longest overlapping child, never the sum of workers.
  const spans = lanes[0].intervals;
  const points = [...new Set(spans.flatMap((s) => [s.start, s.end]))].sort((a, b) => a - b);
  const chain = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const span = spans.filter((s) => s.start < b && s.end > a).sort((x, y) =>
      (y.kind === 'handoff') - (x.kind === 'handoff') || (y.end - y.start) - (x.end - x.start))[0];
    if (!span) continue;
    const child = span.kind === 'handoff' ? lanes.slice(1).filter((l) => l.start < b && l.end > a).sort((x, y) => (y.end - y.start) - (x.end - x.start))[0] : null;
    const label = child?.label ?? (span.kind === 'handoff' ? 'handoff' : span.kind === 'tool' ? span.label : 'parent');
    if (chain.at(-1)?.label === label) chain.at(-1).ms += b - a;
    else chain.push({ label, ms: b - a });
  }
  if (!spans.length && lanes.length > 1 && (unflushed || coarse)) {
    const longest = lanes.slice(1).sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
    chain.push({ label: longest.label, ms: longest.end - longest.start });
  }
  return { start, end, elapsed: end - start, pending: unflushed, coarse, provisional: working, lanes, chain: chain.slice(-LIMIT), omitted: Math.max(0, children.length - 12) };
}
