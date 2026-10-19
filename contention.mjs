// Recorded file-tool contention only: this is not a lock or a live filesystem watcher.
// Each member's latest turn is independent; a child and its parent count as one actor.
export function latestWrites(events, cwd, canonicalize) {
  const end = events.at(-1)?.kind === 'turn_completed' || events.at(-1)?.kind === 'interrupted' ? events.length - 1 : events.length;
  const last = Math.max(-1, ...events.slice(0, end).flatMap((ev, i) => ev.kind === 'turn_completed' || ev.kind === 'interrupted' ? [i] : []));
  const turn = events.slice(last + 1, end);
  const writes = new Map();
  for (const [offset, ev] of turn.entries()) {
    if (ev.kind !== 'tool_call' || !['write_file', 'edit_file'].includes(ev.name) ||
        !ev.args || typeof ev.args.path !== 'string' || !ev.args.path || ev.args.path.length > 400 ||
        /error|fail/i.test(ev.result?.status ?? '')) continue;
    const path = canonicalize(cwd, ev.args.path);
    if (path) writes.set(path, { path, eventIndex: last + 1 + offset });
  }
  return [...writes.values()];
}

// Inputs are already scoped to the selected checkout; archived roots and their children are excluded upstream.
export function intersectWrites(members, selectedRoot) {
  const actors = new Map();
  for (const member of members) {
    const actor = member.parentId ?? member.id;
    if (!actors.has(actor)) actors.set(actor, new Map());
    for (const write of member.writes) actors.get(actor).set(write.path, { ...write, id: member.id, actor });
  }
  const own = actors.get(selectedRoot) ?? new Map();
  const collisions = {};
  for (const [path] of own) {
    const others = [...actors.entries()].filter(([id, paths]) => id !== selectedRoot && paths.has(path)).map(([, paths]) => paths.get(path));
    if (others.length) collisions[path] = others;
  }
  return collisions;
}
