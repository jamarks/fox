// Idle fx sessions keep their tools running (a headless browser for each, about 500 MB on a server), even
// while they only wait for you. fox puts them to sleep: it ends the tmux session, and fx's conversation stays
// on disk; opening the session again resumes it with `fx session resume`. Only sessions that wait for you,
// with nobody looking at them, and no activity for a while, ever sleep.

// tmux `list-sessions -F '#{session_name}|#{session_attached}|#{session_activity}'` lines -> names to consider,
// least recently used first.
export function sleepCandidates(lines, { now = Date.now(), idleMs, prefix = 'fx-' }) {
  const out = [];
  for (const line of String(lines).split('\n')) {
    const [name, attached, activity] = line.split('|');
    if (!name?.startsWith(prefix) || Number(attached) > 0) continue;
    const last = Number(activity) * 1000;
    if (Number.isFinite(last) && last > 0 && now - last >= idleMs) out.push({ name, last });
  }
  return out.sort((a, b) => a.last - b.last).map((x) => x.name); // the one you used longest ago first
}

// Minutes from FOX_IDLE_SLEEP_MIN; 0 or unset turns sleeping off (the default on a laptop).
export function idleSleepMs(value) {
  const min = Number(value);
  return Number.isFinite(min) && min > 0 ? min * 60 * 1000 : 0;
}

// Memory as the sidebar shows it: used = total - available (Linux /proc/meminfo, in kB), like `free`.
// Page cache counts as available, so the number means what new sessions can still use.
export function memoryFromMeminfo(text) {
  const kb = (key) => Number(String(text).match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm'))?.[1]);
  const total = kb('MemTotal'), available = kb('MemAvailable');
  if (!(total > 0) || !(available >= 0)) return null;
  const usedMb = Math.round((total - available) / 1024), totalMb = Math.round(total / 1024);
  return { usedMb, totalMb, pct: Math.round((usedMb / totalMb) * 100) };
}
