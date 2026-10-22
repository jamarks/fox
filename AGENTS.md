Antes de lanzar subagentes con otros modelos, ejecutá fx models --json y usá IDs exactos de esa lista.

# fox

fox is a web panel for the fx coding agent: each fx session runs in tmux on this machine and fox shows it in the browser (terminal, Read view, sidebar), on a laptop or on a server behind a Cloudflare tunnel. Plain Node (ESM, no build step, no framework); the browser code is plain JS in `public/`.

## Before you change anything

- `git pull` first: this checkout can be behind `main`, and what you remember of fox may be old.
- Read the module you are about to change and the comment at its top: each one says what it is for and why.
- Look for what exists before proposing something new: most needs (settings, jobs, links, previews, named apps) already have a place below.

## Map

Server (`server.mjs` is the HTTP/WebSocket entry point; the rest are its parts, each with tests in `tests/`):

- `harnesses/`: one file per coding agent fox can run (`fx.mjs`, `claude.mjs` for Claude Code). Everything about an agent's files on disk, its command line and its screen lives there; the rest of fox only sees sessions and events in fox's shape (`docs/harnesses.md`). Adding an agent = a file there plus its tests in `tests/harnesses.test.mjs`.

- `auth.mjs`, `enrollment.mjs`, `pairing.mjs`: passkey sign-in, first enrollment (`bin/fox-enroll.mjs`), phone pairing.
- `workspaces.mjs`: named folders under `~/workspaces` made of GitHub repos; `gitsync.mjs` fast-forwards their clean checkouts when a session starts, and a job's repo before each run.
- `jobs.mjs`, `schedule.mjs`: scheduled scripts (store, runner, schedules). `bin/fox-job.mjs` is the CLI, `bin/fox-jobs.mjs` the runner service on a server. A run's script prints `FOX_SUMMARY:` and `FOX_LINK: <label> <url>` lines.
- `lib/python/foxjob.py`: helpers every Python job can import (summary, links, `propose_change` for a pull request, `publish_merged`); `docs/jobs.md` is the guide to writing jobs.
- `notes.mjs`: the block fox keeps in fx's personal instructions (`~/.fx/AGENTS.md`) on a server: dev servers, previews, named apps, jobs.
- `fxsettings.mjs`: the fx settings shown in Settings → fx (the `FX_SETTINGS` list). Adding one = an entry there plus its test.
- `tools.mjs`: the MCP tools offered in Settings → Tools for fx (add, switch on and off, sign in).
- `skills.mjs`: the Skills page (sidebar, under Pull requests): skills fx can load, read them, install from GitHub after a preview, remove fox-installed ones.
- `prs.mjs`: the Pull requests page: open PRs of the workspaces' repos through gh (token per owner), the review job's verdict from its comment, merge and close. `prstate.mjs`: merged or open marks on PR links in job runs.
- `apps.mjs`: named apps (`bin/fox-expose.mjs`): `https://<name>.<domain>` routed to a local port.
- `view.mjs`: preview links for pages fx wrote. `idle.mjs`: putting idle sessions to sleep to save memory. `search.mjs`, `inbox.mjs`: search and the "new replies" list. `metrics.mjs`: the metrics page. `share.mjs`, `tunnel.mjs`: the older laptop sharing modes.

Browser (`public/`): `index.html`, `app.js`, `style.css` are the panel; `markdown.js` formats fx's answers in Read; `dictation.js` the mic; `login.*`, `enroll.*`, `pair.*`, `mobile.*`, `metrics.*` are their own pages.

Server: `setup-server.sh` sets a server up; `deploy/` has what it installs (systemd units, `fox-update`, the GitHub helpers). `fox-update` is installed once as root and never deploys itself: changing it here only reaches new servers and reruns of the script.

Docs: `README.md` for users, short (detail in `docs/server.md`, `docs/install.md`, `docs/remote-access.md`, `docs/how-it-works.md`, `docs/jobs.md`); its "What's new" block and `CHANGELOG.md` are written by a changelog job from merged PR titles, so a good PR title is the changelog line; `docs/plans/` for designs and the server setup (`2026-10-16-cloud-only-hetzner.md`).

## Live or on disk

- fx writes `events.jsonl` only at the end of each turn. A session in the middle of a turn (even a long first one) has nothing new on disk: anything that should look live (what a session is doing, its newest text, its model) comes from its tmux screen, as the sidebar's dots do.
- Reading a screen: `tmux capture-pane -p -J -t <name>` gives the visible screen with wrapped lines joined; `-S -<n>` adds history above it. Never `-E -1`: that stops above the visible screen.
- `session.json`'s model is fx's default, not what the session runs: the model is on each reply (`provider_replay.source.model`) and in fx's footer on screen.

## Checking a UI change

Look at it with real data, not an empty fox: a page that works with no sessions can be wrong with real ones.

- Start a throwaway fox from your checkout that reads the real sessions: `PORT=4870 FOX_STATE_DIR=$(mktemp -d) FOX_AUTH_DISABLED=1 FOX_MEMORY_HIGH_PCT=0 FOX_IDLE_SLEEP_MIN=0 node server.mjs` (same user and HOME as the real fox, so it sees `~/.fx` and the tmux sessions; it listens on 127.0.0.1 only and its own state is thrown away). Stop it when you are done.
- It is read-only for you: never click a session in the sidebar, open `?open=<id>` or a terminal tab (that attaches to the person's tmux, resizes it and can type, or wakes a sleeping session); to show one session use `?session=<id>`, which only selects it. Never send to a session, put one to sleep, archive, rename or create anything, run or approve jobs, merge or close PRs. Reading lists, transcripts, screen snapshots, the mosaic, Jobs and Pull requests is fine.
- Check what the change is about with sessions in different states: one working mid-turn, one waiting, one with subagents if it matters.
- Save the screenshots the job asks for from that fox, so the person reviewing sees real content.

## Tests and shipping

- `npm test` runs everything (`node --test`). Run it before every commit and check the exit code, not only the summary.
- Commit to `main` directly, agents included: no pull requests, no review step. The owner wants the models trusted and the bureaucracy out; the protection is `npm test` before the push and the server's rollback. The server deploys the branch chosen in Settings → Deploy within a minute (`main` by default), running `npm ci && npm test` first and rolling back if fox does not answer. `release` only exists for the other setting: a merged pull request reaches it on its own (`.github/workflows/publish-merged.yml`). Never push to `release` by hand.
- Keep fox's dependencies minimal; adding one needs a reason.

## Conventions

- Comments explain why, at the top of a module or above a non-obvious block; match the surrounding density.
- UI copy is short and in English; the user wants a minimal UI, nothing that acts on their behalf without a last look (insert, do not send), and visual options before a new screen is built.
- Secrets never go in this repo (it is public), in logs, or in chat.
