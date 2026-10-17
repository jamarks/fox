// When a job runs. A schedule is one of:
//   { kind: 'hours', every: 2, days: [1..7], from: '09:00', to: '19:00' }  every N hours inside a daily window
//   { kind: 'daily', at: '08:00', days: [1..7] }                          once a day at a time (some days = weekly)
//   { kind: 'once', date: '2026-10-20', at: '10:00' }                     a single time
// Days are ISO weekdays (1 Monday … 7 Sunday). Times are local to `tz` (an IANA zone such as Europe/Berlin), so
// "09:00" stays 09:00 across daylight saving changes. No cron syntax: the editor builds these with buttons.

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return typeof tz === 'string' && tz.length > 0; } catch { return false; }
}

// Returns an error message, or null when the schedule is usable.
export function scheduleError(s, tz) {
  if (!validTimeZone(tz)) return 'Unknown time zone.';
  if (!s || typeof s !== 'object') return 'Pick when the job runs.';
  const days = s.days ?? [1, 2, 3, 4, 5, 6, 7];
  if (s.kind !== 'once' && (!Array.isArray(days) || !days.length || !days.every((d) => Number.isInteger(d) && d >= 1 && d <= 7))) return 'Pick at least one day.';
  if (s.kind === 'hours') {
    if (!Number.isInteger(s.every) || s.every < 1 || s.every > 24) return 'Every 1 to 24 hours.';
    if (!TIME.test(s.from ?? '') || !TIME.test(s.to ?? '')) return 'Use HH:MM for the window.';
    if (minutes(s.to) < minutes(s.from)) return 'The window must end after it starts.';
    return null;
  }
  if (s.kind === 'daily') return TIME.test(s.at ?? '') ? null : 'Use HH:MM for the time.';
  if (s.kind === 'once') return DATE.test(s.date ?? '') && TIME.test(s.at ?? '') ? null : 'Pick a date and a time.';
  return 'Unknown kind of schedule.';
}

const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

// Local wall-clock parts of an instant in a zone.
function partsIn(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const weekday = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday];
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), min: Number(p.minute), s: Number(p.second), weekday };
}

// The instant when the clock in `tz` shows y-m-d h:min. In a spring-forward gap it moves to the next valid
// minute; in a fall-back overlap it takes the first occurrence.
export function zonedToUtc(y, m, d, h, min, tz) {
  const want = Date.UTC(y, m - 1, d, h, min);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = partsIn(guess, tz);
    const shown = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
    if (shown === want) break;
    guess += want - shown;
  }
  const wall = (ms) => { const p = partsIn(ms, tz); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min); };
  if (wall(guess) === want) {
    // Prefer the earlier instant when the same wall time happens twice (fall back).
    return wall(guess - 3600_000) === want ? guess - 3600_000 : guess;
  }
  // The wall time does not exist (spring forward): take the instant an hour on, the same minute after the gap.
  return [guess - 3600_000, guess, guess + 3600_000].filter((ms) => wall(ms) > want).sort((a, b) => wall(a) - wall(b))[0];
}

// Wall-clock times (minutes from midnight) a schedule fires on a day it is active.
function timesOfDay(s) {
  if (s.kind === 'daily' || s.kind === 'once') return [minutes(s.at)];
  const out = [];
  for (let t = minutes(s.from); t <= minutes(s.to); t += s.every * 60) out.push(t);
  return out;
}

// The next `count` run times strictly after `after` (ms), as ms timestamps.
export function nextRuns(s, tz, after = Date.now(), count = 1) {
  if (scheduleError(s, tz)) return [];
  const out = [];
  if (s.kind === 'once') {
    const [y, m, d] = s.date.split('-').map(Number);
    const t = zonedToUtc(y, m, d, Number(s.at.slice(0, 2)), Number(s.at.slice(3, 5)), tz);
    return t > after ? [t] : [];
  }
  const days = new Set(s.days ?? [1, 2, 3, 4, 5, 6, 7]);
  const times = timesOfDay(s);
  const start = partsIn(after, tz);
  // Walk local calendar days from today; 15 days covers any weekly pattern twice.
  for (let i = 0; i < 15 && out.length < count; i++) {
    const noon = Date.UTC(start.y, start.m - 1, start.d + i, 12);
    const day = new Date(noon);
    const y = day.getUTCFullYear(), m = day.getUTCMonth() + 1, d = day.getUTCDate();
    const weekday = ((day.getUTCDay() + 6) % 7) + 1;
    if (!days.has(weekday)) continue;
    for (const t of times) {
      const at = zonedToUtc(y, m, d, Math.floor(t / 60), t % 60, tz);
      if (at > after) { out.push(at); if (out.length >= count) break; }
    }
  }
  return out;
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function daysText(days = [1, 2, 3, 4, 5, 6, 7]) {
  const set = [...new Set(days)].sort();
  if (set.length === 7) return 'every day';
  if (set.join() === '1,2,3,4,5') return 'Mon–Fri';
  if (set.join() === '6,7') return 'weekends';
  return set.map((d) => DAY_NAMES[d - 1]).join(', ');
}
// "every 2 h · Mon–Fri 09:00–19:00", "daily 08:00", "Mon, Thu 08:00", "once Oct 20 10:00"
export function describeSchedule(s) {
  if (!s) return '';
  if (s.kind === 'hours') return `every ${s.every} h · ${daysText(s.days)} ${s.from}–${s.to}`;
  if (s.kind === 'daily') { const d = daysText(s.days); return d === 'every day' ? `daily ${s.at}` : `${d} ${s.at}`; }
  if (s.kind === 'once') return `once ${s.date} ${s.at}`;
  return '';
}
