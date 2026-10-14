# fox

A local web panel for the fx CLI: a sidebar with every session from `~/.fx/sessions`
grouped by project, embedded terminals running the real `fx` binary, and a transcript
viewer showing each message, tool call and cost.

Everything runs on your machine. The panel only reads `~/.fx`; fx is the only writer.
It uses whatever provider fx is configured with (for example your Codex subscription).

## Requirements

- Node 20+, the fx CLI, and tmux (`brew install tmux`). Every terminal runs inside a tmux
  session named `fx-<session id>`, so fx keeps running when you close the tab, reload the
  page or restart this server. The browser only attaches and detaches.

## Run

```bash
npm install
npm start
```

Open http://127.0.0.1:4848. Optional env vars: `PORT` and `FX_BIN` (path to the fx binary).

## Usage

- **Sidebar**: click a session to resume it in a terminal (`fx session resume <id>`
  inside its workspace). If it is already open in a tab, the click focuses that tab.
  If another fx process owns it, only the transcript is shown. The "+" on each group
  starts a new session in that folder; the field at the top in any other folder.
- **Hover actions**: ✎ renames (panel-only name, stored outside `~/.fx`), ⌫ archives.
  Archived sessions collapse into a group at the bottom and can be restored.
- **Terminals**: one tab per tmux session. The × on a tab only detaches; the ■ on a
  session card kills the process. On load the panel reattaches to every running
  `fx-*` tmux session. You can also attach from any terminal:
  `tmux attach -t fx-<session id>`.
- **States**: each running session shows `working`, `ready` or `needs input`, read from
  the tmux screen (fx flushes its event log only at the end of a turn). The summary at
  the top counts them, and groups with running agents sort first. The 🔔 toggle plays a
  beep and shows a desktop notification when an agent finishes a turn or asks for input.
- **Transcript**: refreshes every 2 s while terminals are open. Tool calls expand to show
  arguments and result. `subagent` calls are marked with 🧵, child sessions with a
  "subagent" badge. Hide the column with ⇥ next to the tabs.

## Notes

- Session titles come from fx itself: it asks the model for one after the first turn.
- Panel state (archived ids, custom names) lives in `~/.config/fox/state.json`.
- `node-pty` ships a `spawn-helper` binary that npm installs without the execute bit;
  the `postinstall` script fixes it. If you see `posix_spawnp failed`, run
  `chmod +x node_modules/node-pty/prebuilds/*/spawn-helper`.
- Design notes: `docs/plans/2026-10-14-fx-panel-design.md`.
