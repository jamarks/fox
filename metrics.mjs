import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const DAY = 86_400_000;
const empty = () => ({ sessions: 0, prompts: 0, completed: 0 });

// Count timestamped records, not lifetime usage snapshots: a session can span both periods.
export async function readMetrics(sessionsDir, days = 7, now = Date.now()) {
  if (days !== 7 && days !== 30) throw new RangeError('days must be 7 or 30');
  const start = now - days * DAY;
  const previousStart = start - days * DAY;
  const current = empty(), previous = empty();
  const bucket = (timestamp) => {
    if (!Number.isFinite(timestamp) || timestamp < previousStart || timestamp >= now) return null;
    return timestamp >= start ? current : previous;
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
    const created = bucket(meta?.created_at_ms);
    if (created) created.sessions++;
    let raw;
    try { raw = await readFile(join(dir, 'events.jsonl'), 'utf8'); }
    catch (err) { if (err.code === 'ENOENT') continue; throw err; }
    for (const line of raw.split('\n')) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const counts = bucket(record?.timestamp_ms);
      if (!counts) continue;
      if (record.event?.user) counts.prompts++;
      if (record.event?.turn_completed) counts.completed++;
    }
  }
  return { days, start, end: now, previousStart, current, previous };
}
