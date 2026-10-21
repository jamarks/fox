# How fox works

## Reading the screen

| Where | What |
|---|---|
| Left | New replies on top, then sessions from `~/.fx/sessions` grouped by workspace. Click to open. Hover for pin, rename, archive. `+` on a group starts a new session there (pick a model and tools); the folder icon in the header opens any other folder. |
| Middle | The current terminal (preview, italic) plus pinned tabs. 📌 pins, × unpins. fx keeps running either way. |
| Right (⇥) | What the session made: the newest page as a card, then the files it wrote or changed (newest first), then its subagents. No repeated name or model; a subagent shows a link back to its parent. It closes itself when you switch to a session with nothing to show, and comes back as you left it when there is. × closes it. |

## What fox reads

fx keeps everything on disk and fox only reads it:

- `~/.fx/sessions/<id>/session.json`: title, workspace, model.
- `events.jsonl`: every message, tool call and result. fx flushes it at the end of each turn, which is why live state comes from the tmux screen instead: a spinner with seconds means working, the prompt means waiting, a yes/no question means needs input.
- `subagent/children.json` in the parent and `subagent/owner.json` in each child: the family tree, with each child's phase, task, start time and outcome. This file does update while subagents run.
- `usage-v2.json`: tokens, cost, wall time. Subagents bill to their parent.

### Claude Code sessions

When Claude Code is installed (`claude` in `~/.local/bin` or `CLAUDE_BIN`), the `+` sheet offers **fx | Claude Code**, and each session runs the one you picked; both live side by side in the same workspace. fox starts it as `claude --session-id <id>` (so it knows the id from the start), keeps the sessions it launched in `~/.config/fox/claude-sessions.json`, and reads only those:

- `~/.claude/projects/<folder with every non-alphanumeric as ->/<id>.jsonl`: messages, tool calls and results, written as they happen. The title is the one you set with `/rename`, else the first message.
- `<id>/subagents/agent-<id>.jsonl` and `.meta.json`: each subagent's own conversation, and whether it finished.
- `~/.claude/sessions/<pid>.json`: open sessions, to mark one running in another terminal.

Live state also comes from the screen: "esc to interrupt" means working, a choice list ("Enter to confirm", "Do you want to…") means needs input. How fox talks to each agent is in `harnesses/` (see `docs/harnesses.md`).

Terminals are tmux sessions named `fx-<session id>` for every agent, created with `fx session resume <id>` or `claude --resume <id>` in the session's workspace. The browser attaches over a WebSocket through node-pty and detaches when the tab closes. tmux is told to size the window to the most recent active client, so a second browser or a real terminal can attach without fighting.

A browser can't hand over a dropped file's path, so fox uploads it to its own server, which writes it to `~/.config/fox/drops/` (25 MB max, same-origin only) and pastes that path into the terminal. fx recognizes a pasted image path and attaches the image, the same as dragging a file into a real terminal.

fox's own state (archived ids, custom names, pins, collapsed groups) lives in `~/.config/fox/state.json` and the browser's local storage.

## Why not libfx?

Vercel ships `libfx`, a library version of the agent, and a browser terminal built on it. fox runs the CLI instead on purpose: it is the same binary you use by hand, it shares the same sessions and subscription, and it does not need an AI Gateway key.
