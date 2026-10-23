# Run fox on your server

From a fresh server to fox on your phone. A VPS and a computer at home are the same case: both ways in (Cloudflare Tunnel and Tailscale) connect outward, so nothing has to be opened on your router.

## What you need

- **A Linux server**: Ubuntu 24.04 or Debian, 4 GB of RAM at least, 8 GB to be comfortable (each session with a browser tool takes about 300–500 MB). A VPS (Hetzner's CX23/CX33 are €5–9 a month in Europe) or a machine at home, reached over SSH.
- **A model provider for fx**, one of:
  - **ChatGPT subscription** (`fx login codex`): a fixed monthly price.
  - **Vercel AI Gateway** (`fx setup`, an API key): pay per use; set a spending limit. It is the one that mixes models from several vendors in one task.
  - **Grok subscription** (`fx login grok`).
- **Claude Code** *(optional)*, next to fx: with `--claude-code` the script installs it, and each new session can run fx or Claude Code. It uses your **Claude Pro or Max subscription** (no API key, no extra cost).
- **A way in from your devices**, one of:
  - **Cloudflare**: a domain whose DNS is on Cloudflare, plus Cloudflare Zero Trust (free). fox gets a public HTTPS address behind a Cloudflare login.
  - **Tailscale**: no domain. fox is reachable only from your own devices signed in to your tailnet.
  - Neither, for now: fox answers through an SSH tunnel from your computer.
- **A passkey** on the devices you will use (iCloud Keychain, Google Password Manager, 1Password…). It is fox's login.
- Optional, recommended: **GitHub**, to open workspaces from your repos and let fx open pull requests.

Your own computer can be Windows, macOS or Linux: you only use a browser and SSH.

## 1. Run the setup script

On the server, as root or with sudo, pick your way in:

```bash
curl -fsSL https://raw.githubusercontent.com/jamarks/fox/release/setup-server.sh | sudo bash -s -- --cloudflare fox.example.com
```

```bash
curl -fsSL https://raw.githubusercontent.com/jamarks/fox/release/setup-server.sh | sudo bash -s -- --tailscale
```

```bash
curl -fsSL https://raw.githubusercontent.com/jamarks/fox/release/setup-server.sh | sudo bash
```

Add `--claude-code` to any of them to install Claude Code too (or run the script again later with it).

The last one has no way in yet: open fox through `ssh -L 4848:localhost:4848 <you>@<server>` at http://localhost:4848. A passkey made there belongs to `localhost`; when you add a domain later, make a new one (see [If you lose your passkey](#if-you-lose-your-passkey)).

Prefer to read it first? `git clone https://github.com/jamarks/fox && cd fox && git checkout release && sudo ./setup-server.sh --tailscale`: same script, every step commented. Running it again is safe; it checks before each step.

With Cloudflare it stops once and asks you to add a **self-hosted Access app** for your hostname in Cloudflare Zero Trust, allowing only your email: done before the DNS record, so the address never answers without a login. Then it prints a link to approve the server in your browser. With Tailscale it prints a link to add the server to your tailnet.

## 2. Your turn

The script ends with what is left, with the exact commands for your server:

1. **Sign fx in to a model provider.** The ChatGPT login opens a page on your computer that comes back to port 1455 on the server, so it runs with that port forwarded:

   ```bash
   ssh -t -L 1455:localhost:1455 <you>@<server> sudo -iu fox fx login codex
   ```

   Or `ssh -t <you>@<server> sudo -iu fox fx setup` for an AI Gateway key, pasted on the server, never in a chat.
2. **Sign Claude Code in** (if you installed it) to your Claude subscription. It prints a link: open it on your computer or phone, approve with your Claude account, and paste the code it shows back into the terminal:

   ```bash
   ssh -t <you>@<server> sudo -iu fox claude auth login
   ```

   The login stays on the server (`~/.claude` of fox's user) and renews itself; you do it once. `/login` inside a Claude Code session in fox does the same.
3. **GitHub** (optional): `sudo -iu fox gh auth login` with a **fine-grained token** limited to the repos fx should work on (Contents and Pull requests: read and write). A second owner (an org): `sudo -iu fox fox-git-token <org>`.
4. **Create your passkey**: open your fox address and type the one-time code the script printed (10 minutes, single use; never put it in a URL). Expired? Run the script again. Save the passkey in a manager that syncs, so it works on your phone and your laptop.

Then open the address on any device, sign in with the passkey and press **+**. With Claude Code installed, the sheet has an **fx | Claude Code** switch: pick one per session, and both kinds sit side by side in the same workspace.

## What the script sets up

- **Two users**: `fox` runs fox, fx and your code, **without sudo** (fx runs commands a model writes; with sudo, a prompt injection would be root). `foxbuild` only builds new versions of fox.
- **The machine**: SSH by key only (when a key is already there), a firewall that lets only SSH in (`--no-firewall` on a home server with other services), no automatic reboots (they would stop agents mid-task), and `fox` kept away from a cloud provider's metadata service.
- **Node 22, tmux, git, gh and fx.**
- **Services** (files in [`deploy/`](../deploy)): `fox` (the panel, only on `127.0.0.1:4848`), `fox-tmux` (where fx sessions live, so restarting fox never stops one), `fox-jobs` (scheduled scripts) and `fox-update` (below).
- **Settings** in `/etc/fox/fox.env` ([example](../deploy/fox.env.example)); secrets for fx, if any, in `/etc/fox/secrets.env` (root only).

## Updates

`fox-update` checks every minute for a new commit on `release` (or `main`, chosen in Settings → Deploy). It builds it as `foxbuild`, runs the tests, switches `/opt/fox/current` and restarts fox; fx sessions keep running. If fox does not answer after the switch, it goes back to the previous version on its own and never retries that commit. By hand: `sudo fox-update`, or `sudo fox-update --rollback` to go back one version. A fork: `FOX_REPO=https://github.com/<you>/fox.git` in `/etc/fox/update.conf`.

fox's code in `/opt/fox` belongs to root, so an agent cannot change the fox that controls it. `fox-update` itself is installed once by the setup script and never updates itself.

A reboot stops the fx sessions; their conversations stay on disk, and opening one in fox resumes it.

## If you lose your passkey

The enrollment code is refused while a passkey is registered. Over SSH: `sudo systemctl stop fox`, move `/home/fox/.config/fox/passkey.json` somewhere safe, `sudo systemctl start fox`, and run the setup script again for a new code. Your sessions stay on disk.

## Good to know

- **Never** set `FOX_AUTH_DISABLED=1`, make fox listen on `0.0.0.0` or give `fox` sudo: fox is a shell on this machine.
- **Credentials**: an agent can read anything `fox` can. Keep them minimal and capped: a Gateway key with a spending limit, GitHub tokens per repo. For repos you do not trust, use fx's `/permissions ask`.
- **Backups**: what matters is in `/home/fox` (your repos, `~/.fx` with the conversations, `~/.config/fox` with the passkey). Your provider's backups or `restic` to a bucket both work.
- **TLS ends at Cloudflare** with Cloudflare: it can see the traffic. Fine for personal use; Tailscale is end-to-end.
- **Previews and named apps**: fox can turn the dev servers fx starts into links and publish them at `https://<name>.<your domain>`. They need extra hostnames in Cloudflare; the settings are in [fox.env.example](../deploy/fox.env.example).
  A named app stays up after the session that made it: `fox-expose <name> --dir <folder>` serves a static site from fox itself; `fox-expose <name> --cmd "<command>" --port <port>` keeps a server running in tmux (it survives fox deploys, restarts if it exits and after a reboot); `fox-expose <name> <port>` only forwards to something already running. `fox-expose list`, `pause`, `resume`, `remove`, `logs`. The Apps page in fox's sidebar shows the same list: status, address, what each one serves, a command's log, and pause, resume, restart, remove. fx and Claude Code get the same instructions, so asking them to publish something does this. Every app is behind the same Cloudflare Access login as fox.
