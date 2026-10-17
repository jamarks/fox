// Idle fx sessions keep their tools running (a headless browser for each, about 500 MB on a server), even
// while they only wait for you. fox puts them to sleep: it ends the tmux session, and fx's conversation stays
// on disk; opening the session again resumes it with `fx session resume`. Only sessions that wait for you,
// with nobody looking at them, and no activity for a while, ever sleep.

// tmux `list-sessions -F '#{session_name}|#{session_attached}|#{session_activity}'` lines -> names to consider.
export function sleepCandidates(lines, { now = Date.now(), idleMs, prefix = 'fx-' }) {
  const out = [];
  for (const line of String(lines).split('\n')) {
    const [name, attached, activity] = line.split('|');
    if (!name?.startsWith(prefix) || Number(attached) > 0) continue;
    const last = Number(activity) * 1000;
    if (Number.isFinite(last) && last > 0 && now - last >= idleMs) out.push(name);
  }
  return out;
}

// Minutes from FOX_IDLE_SLEEP_MIN; 0 or unset turns sleeping off (the default on a laptop).
export function idleSleepMs(value) {
  const min = Number(value);
  return Number.isFinite(min) && min > 0 ? min * 60 * 1000 : 0;
}
