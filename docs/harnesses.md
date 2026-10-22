# Harnesses: the coding agents fox runs

fox runs coding agents in tmux and shows them in the browser. Each agent (a "harness": fx, Claude Code, maybe others later) is one file in `harnesses/`. That file is the only place that knows the agent's files on disk, its command line and its screen. The rest of fox (sidebar, Read, the files panel, search, new replies, the phone) only sees the two shapes below.

The plan behind this, and what comes next, is in `docs/plans/2026-10-19-harnesses.md`.

## What a harness file exports

```js
{
  id: 'claude', label: 'Claude Code', bin, models,   // models: [{ id, name }] for the new-session sheet (fx has its own catalog)
  available(),                 // installed? The agent switch shows only installed ones
  has(id),                     // is this session id ours?
  listSessions(),              // → session rows (below)
  events(id),                  // → events (below)
  timing(id), artifact(id, name),
  launch({ cwd, resume, model, flags, addDirs }) // → { argv, id }: id when known before it starts
  activity(screen),            // 'working' | 'ready' | 'needs_input', from `tmux capture-pane`
  ready(screen),               // is its prompt waiting for a message (the phone's reply waits for it)
  screenModel(screen),         // optional: the model shown on screen before anything is on disk
}
```

`server.mjs` lists the harnesses in `HARNESSES`; fx is first and owns any id nobody else claims.

## Session rows

`id`, `title`, `firstPrompt`, `workspace`, `model`, `provider`, `createdAt`, `updatedAt`, `turns`, `live` (open in another terminal), `lastKind`, `partial`, `latestReply` (`{ text, messageIndex, turn, at }`, for new replies), `usage`, `parentId` and `subagentChild` for a subagent, and `children` (`{ id, kind, name, phase: running | idle | finished, task, startedAt, outcome, failure, answer? }`). A `name` means a persistent agent you can talk to again (fx's "Tell <name>:"); leave it null otherwise, and the Follow up button stays away. fox adds `harness`, `harnessLabel`, its own names and the archive.

## Events

In order, one per thing that happened:

- `{ kind: 'user', ts, text }`: only what a person typed.
- `{ kind: 'assistant', ts, text }`
- `{ kind: 'tool_call', ts, callId, name, args, result: { status, preview, bytes, artifact } | null, effect, path }`: `effect` is `write`, `edit`, `read`, `shell` or `other`, and `path` the file for the first three. The files panel and previews use these two, never tool names.
- `{ kind: 'turn_completed', ts }`: once per answered turn.
- `{ kind: 'interrupted', ts, reason, partial }`

Anything the agent's format has that is not here is skipped, so an upstream change costs Read some detail, never the session.
