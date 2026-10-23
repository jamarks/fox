// When the server (or its tmux) goes down in the middle of a turn, the agents doing that work stop with it.
// fox remembers which sessions were working and under which tmux server; when it finds a different tmux server
// running (a reboot, a crash), it resumes those sessions and tells each one to continue, so the work goes on
// without anyone there. A deploy restarts fox, not tmux, so it never sets this off; nor does a session you stop
// yourself (fox forgets it at once), and one that waited for you is left to resume when you open it.

// Says what was lost, not only "continue": told just that, a model took a command cut off midway for finished.
export const CONTINUE_TEXT = 'The server restarted in the middle of your last turn. Whatever was running then (commands, tools, subagents) was stopped and may not have finished, so check what actually got done, then continue where you left off.';
export const RESUME_ONCE_MS = 60 * 60_000;

// The sessions to resume: working under a tmux server that is not the one running now, and not back already.
export function toResume(saved, tmuxStart, liveIds) {
  if (!saved || !Array.isArray(saved.working) || !saved.tmuxStart || !tmuxStart || saved.tmuxStart === tmuxStart) return [];
  return [...new Set(saved.working)].filter((id) => typeof id === 'string' && !liveIds.has(id));
}

// Once: a session resumed within the hour and cut off again stays as it is, so a crash loop does not become a resume loop.
export function splitOnce(ids, resumed, now = Date.now(), windowMs = RESUME_ONCE_MS) {
  const again = (id) => now - (Number(resumed?.[id]) || 0) < windowMs;
  return { resume: ids.filter((id) => !again(id)), skip: ids.filter(again) };
}

// What to remember now: the tmux server and the sessions working in it, plus the ones about to be resumed, so a
// crash while resuming them does not lose them.
export function nextWorking(tmuxStart, terminals, resuming = []) {
  const working = terminals.filter((t) => t.resume && t.activity === 'working').map((t) => t.resume);
  return { tmuxStart, working: [...new Set([...working, ...resuming])].sort() };
}
