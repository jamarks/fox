import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const DAY = 86_400_000;
const empty = () => ({ sessions: 0, prompts: 0, completed: 0 });

// Count timestamped records, not lifetime usage snapshots: a session can span both periods.
// `others`: sessions of other agents in fox's shape, [{ agent, createdAt, events: [{ kind, ts }] }]. They add to the
// totals, and every agent gets its own line in `byAgent`.
export async function readMetrics(sessionsDir, days = 7, now = Date.now(), others = []) {
  if (days !== 7 && days !== 30) throw new RangeError('days must be 7 or 30');
  const start = now - days * DAY;
  const previousStart = start - days * DAY;
  const current = empty(), previous = empty();
  const agents = new Map();
  // One more `key` at `timestamp`, in the totals and in its agent's line; outside both periods it is not counted.
  const count = (timestamp, key, agent = 'fx') => {
    if (!Number.isFinite(timestamp) || timestamp < previousStart || timestamp >= now) return;
    const period = timestamp >= start ? 'current' : 'previous';
    if (!agents.has(agent)) agents.set(agent, { agent, current: empty(), previous: empty() });
    (period === 'current' ? current : previous)[key]++;
    agents.get(agent)[period][key]++;
  };
  let entries;
  try { entries = await readdir(sessionsDir, { withFileTypes: true }); }
  catch (err) { if (err.code === 'ENOENT') entries = []; else throw err; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(sessionsDir, entry.name);
    let meta;
    try { meta = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8')); }
    catch (err) { if (err.code === 'ENOENT' || err instanceof SyntaxError) continue; throw err; }
    count(meta?.created_at_ms, 'sessions');
    let raw;
    try { raw = await readFile(join(dir, 'events.jsonl'), 'utf8'); }
    catch (err) { if (err.code === 'ENOENT') continue; throw err; }
    for (const line of raw.split('\n')) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record?.event?.user) count(record.timestamp_ms, 'prompts');
      if (record?.event?.turn_completed) count(record.timestamp_ms, 'completed');
    }
  }
  for (const s of others) {
    count(s.createdAt, 'sessions', s.agent);
    for (const ev of s.events ?? []) {
      if (ev.kind === 'user') count(ev.ts, 'prompts', s.agent);
      if (ev.kind === 'turn_completed') count(ev.ts, 'completed', s.agent);
    }
  }
  return { days, start, end: now, previousStart, current, previous, byAgent: [...agents.values()] };
}
