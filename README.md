<p align="center"><img src="public/fox.svg" width="72" alt="fox" /></p>

<h1 align="center">fox</h1>

<p align="center"><b>A tiny local cockpit for <a href="https://fx.sh">▲ <i>ƒ</i>x</a>, the coding agent from Vercel Labs.</b><br/>
Every session, every subagent, one terminal that never dies. Nothing leaves your machine.</p>

<p align="center"><sub>Independent project, not affiliated with Vercel. fx is <a href="https://github.com/vercel-labs/fx">vercel-labs/fx</a>, Apache-2.0.</sub></p>

```bash
curl -fsSL https://raw.githubusercontent.com/jamarks/fox/main/setup.sh | bash
```

<p align="center"><sub>Checks Node 20+, tmux and <a href="https://fx.sh">fx</a> (offers to install the last two), installs fox and opens http://127.0.0.1:4848. Details in <a href="#install-and-run">Install and run</a>.</sub></p>

<p align="center"><sub>Optional: give fx more tools (a browser, Chrome DevTools, library docs, Vercel) with one click from the new-session panel. See <a href="#tools-for-fx">Tools for fx</a>.</sub></p>

<p align="center"><img src="docs/screenshot.png" alt="fox: three subagents on three models answering the same task, grouped for comparison in the right column, next to the real fx terminal" /></p>

<p align="center"><sub>One task, three models. The right column groups the subagents by task so you compare their answers, and flags the model that printed a tool call instead of running it.</sub></p>

---

fx is a 7 MB coding agent that lives in your terminal. It is fast and honest about being a shell, which also means that once you have four of them across three repos you lose track of which one is waiting for you, and you never quite see what the subagents did.

fox fixes that. It reads what fx already writes to `~/.fx`, runs every session inside tmux so nothing dies with a browser tab, and shows the whole picture. It never talks to a model itself: it only runs the real `fx` binary, so it uses whatever provider you logged fx into, a ChatGPT subscription included.

## Subagents: the part worth it

fx can split a job across subagents, and each one can run on a different model, as long as it is from the parent's provider (so use the `▲ gateway` to mix Google, DeepSeek, Meta and OpenAI). In the terminal you only see "Subagent finished". fox shows what each one did:

- **Grouped by task.** Same task on several models sits under one header: a side-by-side comparison.
- **The answer each returned to the parent.** Click a row; it opens in place, with a link to that subagent's own conversation.
- **Flags.** `didn't run tools` (printed a tool call as text), `couldn't`, `cancelled` (with what it had started to write), `failed`.
- **Their files.** The files each subagent wrote show up at the top with its number, `#3`.

Try it in a session on the Gateway:

```
Launch three one-off subagents in parallel, without asking me, each on a different model: google/gemini-2.5-flash-lite, deepseek/deepseek-v3.1 and meta/llama-4-scout. Ask all three the same thing: read calc.js and explain in three lines what bug it has.
```

Or a staged run with a named subagent that stays alive between rounds:

```
Do this in stages, without asking me anything. Stage 1: launch three one-off subagents in parallel: one counts the lines of every .js file, one looks for TODOs or FIXMEs, one reads README.md and proposes three improvements. Wait for all three. Stage 2: write a ten-line report from their answers. Stage 3: create a subagent named reviewer and ask it to critique the report in five points. Stage 4: ask reviewer for a second round on the most serious point only. Stage 5: fold the critique in and show the final report, saying what changed thanks to each subagent.
```

## Tools for fx

fx can use MCP servers. The new-session panel shows fox's catalog as chips: `✓` when fx already has one, `+` to add it, `sign in` when it needs an account. Adding one runs `fx mcp add`, so it lands in fx's own config and every fx session gets it, inside fox or not. Sessions that were already open pick it up on their next start.

| Tool | What fx can do with it | Account |
|---|---|---|
| Browser ([Playwright MCP](https://github.com/microsoft/playwright-mcp)) | Open pages, click, type and take screenshots, so it can check its own UI work. Uses its own Chrome profile, not yours. | No |
| Chrome DevTools ([chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)) | Console errors, network requests and performance traces of a page. | No |
| Library docs ([Context7](https://context7.com)) | Current docs and examples for libraries and frameworks, so it does not guess APIs. | No |
| [Vercel](https://vercel.com/docs/mcp) | Your projects, deployments and build logs. Vercel asks for read and write access; pick only the team you need and keep fx in `/permissions ask` if you want to approve each action. | Sign in |

To offer another one, add an entry to `tools.mjs`.

## What it does

- **Sessions by project**: grouped by workspace, collapsible, reorderable by drag, numbered.
- **Live state**: working, waiting or needs input, with an optional bell (sound + notification) when an agent finishes.
- **New replies**: an inbox above the projects lists answers you have not opened yet; click one to jump to it.
- **Provider and model**: `codex` subscription or pay-per-use `▲ gateway`, picked per new session.
- **Subagents**: grouped by task to compare models; click one for its answer; weak answers flagged.
- **Files**: what the session wrote, edited or read; preview in place or open with ↗.
- **One terminal**: fx runs in tmux, so closing the tab or the browser never stops it; pin to keep tabs.
- **Dictation**: in Chrome, tap the mic by the terminal tabs (or hold ⌥D) and speak. A pill over the terminal shows the words as they are heard, with level bars that follow your voice; when you stop, the text lands in fx's input for you to edit. Enter while dictating sends it right away, Esc discards it. Recognition is Chrome's (it may use its online service); fox stores no audio. On a phone, open fox over HTTPS for the mic.
- **Drop files**: drag images or files onto the terminal to attach them to your next message.
- **Search everything**: ⌥Space searches names and messages across all sessions.
- **Tools for fx**: chips in the new-session panel add MCP servers to fx in one click.
- **Archive and rename** without touching fx's files.
- **Git at a glance**: repo, branch and uncommitted files per project.
- **Keyboard first**: ⌥ shortcuts for sessions, tabs, search, themes and font size; ⌥? lists them.
- **Themes**: dark, dusk, mauve, terracotta, copper, plum and *sky*, a slowly drifting real star map.
- **Resizable columns** and a URL that follows the open session.

## Install and run

You need Node 20+, [fx](https://fx.sh) and tmux (`brew install tmux`).

One command checks what is missing, installs fox and starts it ([setup.sh](setup.sh); `FOX_NO_START=1` only installs):

```bash
curl -fsSL https://raw.githubusercontent.com/jamarks/fox/main/setup.sh | bash
```

Or with npm, if Node, tmux and fx are already there:

```bash
npm install -g https://github.com/jamarks/fox/archive/refs/heads/main.tar.gz && fox
```

Or run from a checkout without installing a global command:

```bash
git clone https://github.com/jamarks/fox && cd fox
npm install && node bin/fox.mjs
```

`fox` starts the server and opens http://127.0.0.1:4848 in your browser. If it is already running, it just opens the existing panel. The same panel adapts below 1100px to Sessions / Terminal / Read. Tap inside the terminal to type directly with the phone keyboard. No Tailscale setup or separate mobile URL is needed for this layout. Keep the terminal open; Ctrl+C stops fox, but tmux-backed fx sessions keep running. `npm start` runs only the server, without opening a browser. Knobs: `PORT`, `FX_BIN` (path to the fx binary), `TMUX_BIN`.

Deep links: `?session=<id>` selects a session, `?open=<id>` also opens its terminal.

## Open the same fox from another device

Keep fox and fx running on the Mac. Install Tailscale on the Mac and each phone/computer you want to use, and sign in to the same tailnet. On the Mac, with fox running on its default port:

```bash
tailscale serve --bg http://127.0.0.1:4848
tailscale serve status
```

Open the HTTPS tailnet URL reported by `tailscale serve status` on the other device. This serves the **same full panel and live tmux sessions**; nothing is copied or migrated. The Mac must stay awake and fox must stay running. Tailscale Serve is private to your tailnet; do **not** use Funnel, which publishes a public URL. Tailscale is installed separately (check `tailscale serve --help` if your version has different syntax). Fox does not have its own user login: **any device/user allowed by your tailnet policies can control fx and read session contents**. To remove remote access, disable the Serve configuration in Tailscale.

### Personal phone pairing, no email or account

Restart fox with a **separate** local gateway (existing fox processes must be stopped first):

```bash
FOX_SHARE_PORT=4851 fox
```

Install `cloudflared` if needed (`brew install cloudflared`). On the **Mac**, open `http://127.0.0.1:4848` and click **Pair phone** (⌁). Fox starts a temporary Quick Tunnel to its protected `4851` gateway, waits for Cloudflare to connect, and displays a QR automatically. Scan it on your phone, compare the six-digit code on both screens, and **Accept** on the Mac. Use **New QR** if it expires, **Stop sharing** to close the tunnel and revoke all devices, or **Revoke** to remove one phone. Closing just the dialog does not stop sharing. If Cloudflare cannot connect, fox shows an error and keeps the gateway blocked. Without the one-time QR and local approval, the gateway refuses session data, panel actions, and terminal WebSockets. **Never tunnel port 4848 or the old mobile port 4850**: they do not enforce this pairing gate. Quick Tunnel gives a public, changing URL; Cloudflare carries the traffic (not end-to-end encrypted from Cloudflare), but fox only authorizes paired browsers. Access is lost when fox restarts or the tunnel ends, so pair again. The Mac and fox must stay running. Test the real phone/browser flow before relying on remote access.

`FOX_MOBILE_PORT` is an older optional separate mobile view; it is **not needed** for the responsive full panel. The full panel stays on `PORT` (default `4848`) locally, and only `FOX_SHARE_PORT` is intended for a public tunnel when using fox pairing. While `FOX_SHARE_PORT` is set, port 4848 also rejects nonlocal Host headers to reduce accidental bypass; the Tailscale Serve instructions above apply only when pairing mode is **off**.

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
| Left | New replies on top, then sessions from `~/.fx/sessions` grouped by workspace. Click to open. Hover for pin, rename, archive. `+` on a group starts a new session there (pick a model and tools); the folder icon in the header opens any other folder. |
| Middle | The current terminal (preview, italic) plus pinned tabs. 📌 pins, × unpins. fx keeps running either way. |
| Right (⇥) | Model, provider, duration and cost; the files the session touched; its subagents (both sections fold). A subagent's own conversation; a session's conversation only when global search or the replies inbox points at a message (the terminal has the rest). × closes it. |

## How it works

fx keeps everything on disk and fox only reads it:

- `~/.fx/sessions/<id>/session.json`: title, workspace, model.
- `events.jsonl`: every message, tool call and result. fx flushes it at the end of each turn, which is why live state comes from the tmux screen instead: a spinner with seconds means working, the prompt means waiting, a yes/no question means needs input.
- `subagent/children.json` in the parent and `subagent/owner.json` in each child: the family tree, with each child's phase, task, start time and outcome. This file does update while subagents run.
- `usage-v2.json`: tokens, cost, wall time. Subagents bill to their parent.

Terminals are tmux sessions named `fx-<session id>`, created with `fx session resume <id>` in the session's workspace. The browser attaches over a WebSocket through node-pty and detaches when the tab closes. tmux is told to size the window to the most recent active client, so a second browser or a real terminal can attach without fighting.

A browser can't hand over a dropped file's path, so fox uploads it to its own server, which writes it to `~/.config/fox/drops/` (25 MB max, same-origin only) and pastes that path into the terminal. fx recognizes a pasted image path and attaches the image, the same as dragging a file into a real terminal.

fox's own state (archived ids, custom names, pins, collapsed groups) lives in `~/.config/fox/state.json` and the browser's local storage.

## Tests

```bash
npm test
```

Runs the tests (search index, replies inbox, tools catalog, launcher) with Node's built-in runner.

## Why not libfx?

Vercel ships `libfx`, a library version of the agent, and a browser terminal built on it. fox runs the CLI instead on purpose: it is the same binary you use by hand, it shares the same sessions and subscription, and it does not need an AI Gateway key.

## Gotchas

- `node-pty` ships a `spawn-helper` that npm installs without the execute bit. The `postinstall` script fixes it; if you see `posix_spawnp failed`, run `chmod +x node_modules/node-pty/prebuilds/*/spawn-helper`.
- fx allows one process per session. If a session is open in another terminal, fox shows `other terminal` and only lets you read it.
- The native folder picker is macOS only. Shift-click the folder icon to type a path instead.

MIT. Built in an afternoon with fx 0.0.13 and a lot of `tmux capture-pane`. Issues and forks welcome.
