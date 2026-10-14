<p align="center"><img src="public/fox.svg" width="72" alt="fox" /></p>

<h1 align="center">fox</h1>

<p align="center"><b>A tiny local cockpit for <a href="https://fx.sh">▲ <i>ƒ</i>x</a>, the coding agent from Vercel Labs.</b><br/>
Every session, every subagent, one terminal that never dies. Nothing leaves your machine.</p>

<p align="center"><sub>Independent project, not affiliated with Vercel. fx is <a href="https://github.com/vercel-labs/fx">vercel-labs/fx</a>, Apache-2.0.</sub></p>

<p align="center"><img src="docs/screenshot.png" alt="fox: sessions grouped by project on the left, the real fx terminal in the middle, subagents on the right" /></p>

<p align="center"><sub>Left: sessions by project, with subagents nested under their parent. Middle: the real fx terminal, running in tmux. Right: the subagent board.</sub></p>

---

fx is a 7 MB coding agent that lives in your terminal. It is fast and honest about being a shell, which also means that once you have four of them across three repos you lose track of which one is waiting for you, and you never quite see what the subagents did.

fox fixes that. It reads what fx already writes to `~/.fx`, runs every session inside tmux so nothing dies with a browser tab, and shows the whole picture. It never talks to a model itself: it only runs the real `fx` binary, so it uses whatever provider you logged fx into, a ChatGPT subscription included.

## What it does

- **Sessions by project.** The sidebar groups fx sessions by workspace, collapsible per folder and reorderable by dragging the project header, with the first prompt under each title so fx's auto-generated names ("Casual Greeting") make sense. Sessions are numbered and keep a stable order; a triangle in the margin marks the one that is in the terminal.
- **Live state.** A green dot means a live session waiting for you; `working` and `needs input` get a label, read from the tmux screen every few seconds. The bar at the top counts only what needs attention. A 🔔 toggle beeps and sends a desktop notification when an agent finishes a turn or asks for input.
- **Provider and model at a glance.** Each session shows its model and whether it runs on a subscription (`codex`) or on the pay-per-use `▲ gateway`. Pick a provider and model when you open a new session; the picker lists your subscription models and the whole Gateway catalog grouped by vendor.
- **Subagents, visibly.** Each session counts its subagents and how many are working. Select the parent and the right column lists them; when the same task went to several models they are grouped under it, so it reads as a side-by-side comparison. A subagent with a task of its own shows that task until its answer arrives. Every row has a vendor-colored dot, the full model id, elapsed time and the first lines of its answer. Click a row to read the whole answer it returned to the parent, in place; open a subagent and it arrives with its row expanded, above its own conversation. Weak answers are flagged: `didn't run tools` when a model printed a tool call as text instead of making it, `couldn't` when it refused or gave up, `cancelled` when fx stopped it (with whatever it had started to write), `failed` when it never started. Subagents can run on different models than the parent, as long as they share its provider.
- **Files the session touched.** At the top of the right column, above the subagents: the files fx wrote or edited (and which subagent did it, `#3`), files it names in its answers that exist on disk, so a file made by a shell command still shows up, and, folded away, the ones it only read. Click one to preview it in place; ↗ opens it with the default app. Only files from that list can be read or opened through fox.
- **One terminal, pinned tabs.** Clicking a session shows its terminal in the middle as a preview; clicking another replaces it. Pin the ones you want to keep as tabs. Either way fx keeps running in tmux: close the tab, reload, restart fox, `tmux attach -t fx-<id>` from a real terminal, it is all still there.
- **Drop files on the terminal.** Drag images, text or anything else from Finder onto the terminal. Images become fx image attachments (`[Image 1]`); text files up to 200 KB are pasted inline with their name; other files are saved to `~/.config/fox/drops/` and their path is pasted so the agent can read them. Nothing is sent until you press Enter.
- **Search across all sessions.** ⌥Space (or the ⌕ in the header) opens a palette that searches session names and messages in every project, archived ones included. Pick a hit and the session opens on that message. The index lives in memory, refreshes only the sessions whose files changed, and never includes tool output.
- **Tokens and cost** per session, and a transcript viewer with expandable tool calls for sessions whose terminal is not open.
- **Archive and rename** without touching fx's files. Archiving a running session stops its process first, after asking.
- **Open any folder** with the native macOS picker, or the `+` on a group for a new session in that project.
- **Keyboard first.** Option shortcuts for new sessions, tabs, pinning, search, themes and terminal font size; ⌥? lists them.
- **Git at a glance.** Each workspace shows its GitHub repo (linked), current branch and the number of uncommitted files.
- **Themes.** Dark (default), *dusk*, *mauve*, *terracotta*, *copper*, *plum*, and *sky*: the dark palette with translucent panels over a slowly drifting star field drawn from real star coordinates, Orion, the Big Dipper, Cassiopeia, Scorpius, Cygnus, Lyra, Leo and friends.
- **Resizable columns.** Drag the dividers; widths are remembered. The address bar follows the open session, so a refresh or a bookmark lands back on it.

## Run it

You need Node 20+, [fx](https://fx.sh) and tmux (`brew install tmux`).

```bash
git clone https://github.com/jamarks/fox && cd fox
npm install
npm start
```

Open http://127.0.0.1:4848. Knobs: `PORT`, `FX_BIN` (path to the fx binary), `TMUX_BIN`.

fox is a plain Node process: run `npm start` in any terminal tab and leave it there, or put it under a process manager if you want it always on. Stopping fox never stops fx: the sessions live in tmux and are picked up again on the next start.

Deep links: `?session=<id>` selects a session, `?open=<id>` also opens its terminal.

## Keyboard

Option is the modifier, because ⌘T and ⌘W belong to the browser.

| Keys | Action |
|---|---|
| ⌥T | New session in the current project |
| ⌥W | Close the current tab (fx keeps running) |
| ⌥] / ⌥[ · ⌥1…9 | Switch tabs |
| ⌥P | Pin / unpin the current tab |
| ⌥Space | Search all sessions |
| ⌥\ | Show / hide the right column |
| ⌥L / ⌥⇧L | Next / previous theme |
| ⌥= / ⌥- / ⌥0 | Terminal font bigger / smaller / reset |
| ⌥? | Shortcut list |

## How to read the screen

| Where | What |
|---|---|
| Left | Sessions from `~/.fx/sessions`, grouped by workspace. Click to open. Hover for pin, rename, archive. `+` on a group starts a new session there; the folder icon in the header opens any other folder. |
| Middle | The current terminal (preview, italic) plus pinned tabs. 📌 pins, × unpins. fx keeps running either way. |
| Right (⇥) | Model, provider, duration and cost; the subagent board when there are children; the transcript only when the session's terminal is not open. × closes it. |

## How it works

fx keeps everything on disk and fox only reads it:

- `~/.fx/sessions/<id>/session.json`: title, workspace, model.
- `events.jsonl`: every message, tool call and result. fx flushes it at the end of each turn, which is why live state comes from the tmux screen instead: a spinner with seconds means working, the prompt means waiting, a yes/no question means needs input.
- `subagent/children.json` in the parent and `subagent/owner.json` in each child: the family tree, with each child's phase, task, start time and outcome. This file does update while subagents run.
- `usage-v2.json`: tokens, cost, wall time. Subagents bill to their parent.

Terminals are tmux sessions named `fx-<session id>`, created with `fx session resume <id>` in the session's workspace. The browser attaches over a WebSocket through node-pty and detaches when the tab closes. tmux is told to size the window to the most recent active client, so a second browser or a real terminal can attach without fighting.

A browser can't hand over a dropped file's path, so fox uploads it to its own server, which writes it to `~/.config/fox/drops/` (25 MB max, same-origin only) and pastes that path into the terminal. fx recognizes a pasted image path and attaches the image, the same as dragging a file into a real terminal.

fox's own state (archived ids, custom names, pins, collapsed groups) lives in `~/.config/fox/state.json` and the browser's local storage.

## Try the subagents

Open a session in any project and paste:

```
Do this in stages, without asking me anything. Stage 1: launch three one-off subagents in parallel: one counts the lines of every .js file, one looks for TODOs or FIXMEs, one reads README.md and proposes three improvements. Wait for all three. Stage 2: write a ten-line report from their answers. Stage 3: create a subagent named reviewer and ask it to critique the report in five points. Stage 4: ask reviewer for a second round on the most serious point only. Stage 5: fold the critique in and show the final report, saying what changed thanks to each subagent.
```

Watch the sidebar: three children appear and pulse, the parent sits in `working` without writing anything until they return, `reviewer` stays alive in green between rounds while the one-offs go grey as they finish.

## Tests

```bash
npm test
```

Runs the search index tests with Node's built-in runner.

## Why not libfx?

Vercel ships `libfx`, a library version of the agent, and a browser terminal built on it. fox runs the CLI instead on purpose: it is the same binary you use by hand, it shares the same sessions and subscription, and it does not need an AI Gateway key.

## Gotchas

- `node-pty` ships a `spawn-helper` that npm installs without the execute bit. The `postinstall` script fixes it; if you see `posix_spawnp failed`, run `chmod +x node_modules/node-pty/prebuilds/*/spawn-helper`.
- fx allows one process per session. If a session is open in another terminal, fox shows `other terminal` and only lets you read it.
- The native folder picker is macOS only. Shift-click the folder icon to type a path instead.

MIT. Built in an afternoon with fx 0.0.13 and a lot of `tmux capture-pane`. Issues and forks welcome.
