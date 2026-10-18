Antes de lanzar subagentes con otros modelos, ejecutá fx models --json y usá IDs exactos de esa lista.

# fox

fox is a web panel for the fx coding agent: each fx session runs in tmux on this machine and fox shows it in the browser (terminal, Read view, sidebar), on a laptop or on a server behind a Cloudflare tunnel. Plain Node (ESM, no build step, no framework); the browser code is plain JS in `public/`.

## Before you change anything

- `git pull` first: this checkout can be behind `main`, and what you remember of fox may be old.
- Read the module you are about to change and the comment at its top: each one says what it is for and why.
- Look for what exists before proposing something new: most needs (settings, jobs, links, previews, named apps) already have a place below.

## Map

Server (`server.mjs` is the HTTP/WebSocket entry point; the rest are its parts, each with tests in `tests/`):

- `auth.mjs`, `enrollment.mjs`, `pairing.mjs`: passkey sign-in, first enrollment (`bin/fox-enroll.mjs`), phone pairing.
- `workspaces.mjs`: named folders under `~/workspaces` made of GitHub repos; `gitsync.mjs` fast-forwards their clean checkouts when a session starts, and a job's repo before each run.
- `jobs.mjs`, `schedule.mjs`: scheduled scripts (store, runner, schedules). `bin/fox-job.mjs` is the CLI, `bin/fox-jobs.mjs` the runner service on a server. A run's script prints `FOX_SUMMARY:` and `FOX_LINK: <label> <url>` lines.
- `lib/python/foxjob.py`: helpers every Python job can import (summary, links, `propose_change` for a pull request, `publish_merged`); `docs/jobs.md` is the guide to writing jobs.
- `notes.mjs`: the block fox keeps in fx's personal instructions (`~/.fx/AGENTS.md`) on a server: dev servers, previews, named apps, jobs.
- `fxsettings.mjs`: the fx settings shown in Settings → fx (the `FX_SETTINGS` list). Adding one = an entry there plus its test.
- `tools.mjs`: the MCP tools offered in Settings → Tools for fx (add, switch on and off, sign in).
- `apps.mjs`: named apps (`bin/fox-expose.mjs`): `https://<name>.<domain>` routed to a local port.
- `view.mjs`: preview links for pages fx wrote. `idle.mjs`: putting idle sessions to sleep to save memory. `search.mjs`, `inbox.mjs`: search and the "new replies" list. `metrics.mjs`: the metrics page. `share.mjs`, `tunnel.mjs`: the older laptop sharing modes.

Browser (`public/`): `index.html`, `app.js`, `style.css` are the panel; `markdown.js` formats fx's answers in Read; `dictation.js` the mic; `login.*`, `enroll.*`, `pair.*`, `mobile.*`, `metrics.*` are their own pages.

Docs: `README.md` for users, short (detail in `docs/install.md`, `docs/remote-access.md`, `docs/how-it-works.md`, `docs/jobs.md`); its "What's new" block and `CHANGELOG.md` are written by a changelog job from merged PR titles, so a good PR title is the changelog line; `docs/plans/` for designs and the server setup (`2026-10-16-cloud-only-hetzner.md`).

## Tests and shipping

- `npm test` runs everything (`node --test`). Run it before every commit and check the exit code, not only the summary.
- Commit to `main` directly, agents included: no pull requests, no review step. The owner wants the models trusted and the bureaucracy out; the protection is `npm test` before the push and the server's rollback. The server deploys the branch chosen in Settings → Deploy within a minute (`main` by default), running `npm ci && npm test` first and rolling back if fox does not answer. `release` only exists for the other setting: a merged pull request reaches it on its own (`.github/workflows/publish-merged.yml`). Never push to `release` by hand.
- Keep fox's dependencies minimal; adding one needs a reason.

## Conventions

- Comments explain why, at the top of a module or above a non-obvious block; match the surrounding density.
- UI copy is short and in English; the user wants a minimal UI, nothing that acts on their behalf without a last look (insert, do not send), and visual options before a new screen is built.
- Secrets never go in this repo (it is public), in logs, or in chat.
