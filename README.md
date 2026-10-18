<p align="center"><img src="public/fox.svg" width="72" alt="fox" /></p>

<h1 align="center">fox</h1>

<p align="center"><b>A tiny local cockpit for <a href="https://fx.sh">▲ <i>ƒ</i>x</a>, the coding agent from Vercel Labs.</b><br/>
Every session, every subagent, one terminal that never dies. Nothing leaves your machine.</p>

<p align="center"><sub>Independent project, not affiliated with Vercel. fx is <a href="https://github.com/vercel-labs/fx">vercel-labs/fx</a>, Apache-2.0.</sub></p>

```bash
curl -fsSL https://raw.githubusercontent.com/jamarks/fox/release/setup.sh | bash
```

<p align="center"><img src="docs/screenshot.png" alt="fox: three subagents on three models answering the same task, grouped for comparison in the right column, next to the real fx terminal" /></p>

## TL;DR

- **Many fx sessions, one screen.** Which one works, which one waits for you, what each subagent answered, what files they wrote.
- **The real fx, nothing else.** fox runs the `fx` binary in tmux and reads what it writes to `~/.fx`. It never talks to a model, so it uses whatever you logged fx into, a ChatGPT subscription included.
- **Nothing dies, nothing leaks.** Closing the browser never stops fx; everything stays on your machine, behind a passkey.

## What's new

<!-- changelog:start -->
- **2026-10-18** Model per job, URLs for every page, no stale waking overlay ([#10](https://github.com/jamarks/fox/pull/10))
- **2026-10-18** Docs: deploy branch chosen in Settings, fox-update every minute ([#8](https://github.com/jamarks/fox/pull/8))
- **2026-10-18** Sidebar footer in one line, cleaner cards, jobs list with last run, merged mark on PR links ([#9](https://github.com/jamarks/fox/pull/9))
- **2026-10-18** Steer named subagents from their result rows ([#7](https://github.com/jamarks/fox/pull/7))
- **2026-10-18** Foxjob: retry once when the provider drops fx's answer ([#6](https://github.com/jamarks/fox/pull/6))
- **2026-10-18** Security hardening, jobs from fx wait for approval, pinned install, deploy branch in Settings ([#5](https://github.com/jamarks/fox/pull/5))

All of it: [CHANGELOG.md](CHANGELOG.md).
<!-- changelog:end -->

## What it does

- **Sessions** grouped by workspace, with a live dot (working, waiting, needs input), a bell when one finishes, and an inbox of replies you have not read.
- **Subagents** grouped by task, so the same question on three models is a side-by-side comparison; weak answers are flagged.
- **Files** fx wrote, opened the way they read best: pages and images rendered, Markdown formatted, CSV as a table, code highlighted. The newest page shows as a live card, sandboxed.
- **One terminal** per session in tmux; pin the ones you keep. Drop files on it, dictate into it (the text lands in fx's input; you send it).
- **Workspaces**: a folder of GitHub repos, cloned once, with each repo's branch and changes at a glance.
- **Jobs**: scripts on a schedule, each with its model, log, summary and links. A job can have fx make a change and open a pull request it checked itself. [docs/jobs.md](docs/jobs.md)
- **Pull requests** of your workspaces' repos in one list: what each does, its files, the review job's verdict; merge or close it from fox.
- **Tools for fx** from Settings: a browser, Chrome DevTools, library docs, Vercel, Linear.
- **Search** across every session (⌥Space), **metrics** for the last 7 and 30 days, seven **themes** (one is a real star map).
- **On a server**: open it from any device, publish dev servers as named apps, and merging a pull request deploys it. [docs/remote-access.md](docs/remote-access.md)

## Install

You need Node 20+, tmux and [fx](https://fx.sh). The command above checks what is missing, installs fox and opens http://127.0.0.1:4848, where you create a passkey on first use. Without it:

```bash
npm install -g https://github.com/jamarks/fox/archive/refs/heads/release.tar.gz && fox
```

Sign-in, settings and gotchas: [docs/install.md](docs/install.md). What fox reads and how: [docs/how-it-works.md](docs/how-it-works.md).

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
