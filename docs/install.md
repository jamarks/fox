# Install and run, in detail

The short version is in the [README](../README.md#install).

## Sign-in and knobs

`fox` starts the server and opens the local sign-in screen (redirecting from `127.0.0.1` to `localhost` for WebAuthn). On first use, choose **Create passkey** in the browser on this computer; after that, opening fox asks for the passkey on its own (Touch ID); **Unlock with passkey** appears only if you cancel or the browser wants a click first. The passkey is bound to `localhost` and the credential record is stored at `~/.config/fox/passkey.json` (mode 0600). Back up this file and your passkey; if the passkey is lost, local recovery requires deliberately removing the credential record and registering a new one (existing fx sessions remain on disk). **Lock fox** in Settings revokes the current browser session; sessions expire after 12 hours and survive a server restart (fox stores only SHA-256 hashes of the session cookies in `~/.config/fox/sessions.json`, mode 0600, and drops them all when the passkey is replaced). Keep the terminal open; Ctrl+C stops fox, but tmux-backed fx sessions keep running. `npm start` runs only the server, without opening a browser. Knobs: `PORT`, `FX_BIN` (path to the fx binary), `TMUX_BIN`, `FOX_STATE_DIR` (fox's own state, default `~/.config/fox`; give a second fox on the same machine its own), `FOX_IDLE_SLEEP_MIN` (put fx sessions that wait for you, with nobody looking, to sleep after that many minutes; their tools hold about 500 MB each on a server; opening the session resumes it; off by default), `FOX_MEMORY_HIGH_PCT` (on Linux, from this share of RAM in use fox puts idle sessions to sleep on its own, least recently used first, until there is room again; 85 by default, 0 turns it off).

Deep links: `?session=<id>` selects a session, `?open=<id>` also opens its terminal; `?view=settings`, `?view=jobs` and `?job=<id>` open those pages.

## Gotchas

- `node-pty` ships a `spawn-helper` that npm installs without the execute bit. The `postinstall` script fixes it; if you see `posix_spawnp failed`, run `chmod +x node_modules/node-pty/prebuilds/*/spawn-helper`.
- fx allows one process per session. If a session is open in another terminal, fox shows `other terminal` and only lets you read it.
- The native folder picker is macOS only. Shift-click the folder icon to type a path instead.
