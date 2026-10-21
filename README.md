<p align="center"><img src="public/fox.svg" width="72" alt="fox" /></p>

<h1 align="center">fox</h1>

<p align="center"><b>Your <a href="https://fx.sh">▲ <i>ƒ</i>x</a> agents on your own server, from any device.</b><br/>
fx is the coding agent from Vercel Labs. fox runs it on a VPS or a computer at home and gives you every session, every subagent and a terminal that never dies, from your phone or your laptop.</p>

<p align="center"><sub>Independent project, not affiliated with Vercel. fx is <a href="https://github.com/vercel-labs/fx">vercel-labs/fx</a>, Apache-2.0.</sub></p>

<p align="center"><b><a href="docs/server.md">Set up fox on your server →</a></b></p>

<p align="center"><img src="docs/screenshot.png" alt="fox: three subagents on three models answering the same task, grouped for comparison in the right column, next to the real fx terminal" /></p>

## TL;DR

- **Many fx sessions, one screen.** Which one works, which one waits for you, what each subagent answered, what files they wrote.
- **The real fx, nothing else.** fox runs the `fx` binary in tmux and reads what it writes to `~/.fx`. It never talks to a model, so it uses whatever you logged fx into, a ChatGPT subscription included.
- **Your server, your choice.** Any VPS or a box at home. Agents keep working with every browser closed; you come back from any device, behind a passkey.

## What's new

<!-- changelog:start -->
- **2026-10-21** Waking a session hides the terminal behind the notice ([#30](https://github.com/jamarks/fox/pull/30))
- **2026-10-21** Opening a sleeping session shows at once ([#29](https://github.com/jamarks/fox/pull/29))
- **2026-10-21** Right column steps aside on Jobs, Pull requests, Settings and the mosaic ([#28](https://github.com/jamarks/fox/pull/28))
- **2026-10-21** Expose new fx settings as opt-in controls ([#27](https://github.com/jamarks/fox/pull/27))
- **2026-10-21** Check provider headroom before launching a swarm ([#26](https://github.com/jamarks/fox/pull/26))
- **2026-10-20** Choose model effort and speed without changing defaults ([#25](https://github.com/jamarks/fox/pull/25))

All of it: [CHANGELOG.md](CHANGELOG.md).
<!-- changelog:end -->

## What it does

- **Sessions** grouped by workspace, with a live dot (working, waiting, needs input), a bell when one finishes, and an inbox of replies you have not read.
- **Subagents** grouped by task, so the same question on three models is a side-by-side comparison; weak answers are flagged.
- **Files** fx wrote, opened the way they read best: pages and images rendered, Markdown formatted, CSV as a table, code highlighted. The newest page shows as a live card, sandboxed.
- **One terminal** per session in tmux; pin the ones you keep. Drop files on it, dictate into it (the text lands in fx's input; you send it). Toggle the read-only mosaic in the tab bar to watch up to four live sessions, then open a tile to type.
- **Workspaces**: a folder of GitHub repos, cloned once, with each repo's branch and changes at a glance. Start a session in one repo and explicitly grant fx file access to selected sibling repos for that launch only.
- **Jobs**: scripts on a schedule, each with its model, log, summary and links. A job can have fx make a change and open a pull request it checked itself. [docs/jobs.md](docs/jobs.md)
- **Pull requests** of your workspaces' repos in one list: what each does, its files, the review job's verdict; merge or close it from fox.
- **Tools for fx** from Settings: a browser, Chrome DevTools, library docs, Vercel, Linear.
- **Skills for fx** in Settings: read discovered skills, preview and install GitHub skills globally or per workspace, and remove fox-installed skills.
- **Search** across every session (⌥Space), **metrics** for the last 7 and 30 days, seven **themes** (one is a real star map).
- **On a server**: open it from any device, see the dev servers fx starts, publish them as named apps. [docs/server.md](docs/server.md)

## What you need

| | |
|---|---|
| **A server** | A Linux VPS or a computer at home: Ubuntu 24.04, 4 GB of RAM or more. You use it from any device with a browser: Windows, macOS, Linux or a phone. |
| **A model provider** for fx | One of: a ChatGPT subscription (`fx login codex`), a [Vercel AI Gateway](https://vercel.com/ai-gateway) key (pay per use; mixes models from several vendors) or a Grok subscription. |
| **A way in** | A domain on Cloudflare (Tunnel + Access, free), or [Tailscale](https://tailscale.com) if you have no domain. |
| **A passkey** | On the devices you will use. It is fox's login. |
| GitHub *(optional)* | `gh` with a fine-grained token, to open workspaces from your repos and let fx open pull requests. |

## Set up

**On your server** (Ubuntu or Debian), one script sets up everything but your logins, which it tells you how to do. With a domain on Cloudflare, or `--tailscale` instead:

```bash
curl -fsSL https://raw.githubusercontent.com/jamarks/fox/release/setup-server.sh | sudo bash -s -- --cloudflare fox.example.com
```

What it does and the steps after it: [docs/server.md](docs/server.md).

**To try it first on your own computer** (macOS or Linux), one command checks Node, tmux and fx, installs what is missing, installs fox and opens it at http://127.0.0.1:4848, where you create a passkey:

```bash
curl -fsSL https://raw.githubusercontent.com/jamarks/fox/release/setup.sh | bash
```

Settings and gotchas: [docs/install.md](docs/install.md). What fox reads and how: [docs/how-it-works.md](docs/how-it-works.md).

## Keyboard

Option is the modifier, because ⌘T and ⌘W belong to the browser. ⌥? lists them all.

| Keys | Action | Keys | Action |
|---|---|---|---|
| ⌥T | New session | ⌥Space | Search all sessions |
| ⌥W | Close tab (fx keeps running) | ⌥\ | Show / hide the right column |
| ⌥[ ⌥] ⌥1…9 | Switch tabs | ⌥L | Next theme |
| ⌥P | Pin the tab | ⌥= ⌥- ⌥0 | Font size |

## Develop

`npm test` runs everything with Node's own runner. Plain Node and browser JS, no build step. [AGENTS.md](AGENTS.md) is the map.

MIT. Built in an afternoon with fx 0.0.13 and a lot of `tmux capture-pane`. Issues and forks welcome.
