# Run fox on your server

From a fresh server to fox on your phone. A VPS and a computer at home are the same case: both ways in (Cloudflare Tunnel and Tailscale) connect outward, so nothing has to be opened on your router or firewall.

These are the steps done by hand. A script that does them for you is on the way.

## What you need

- **A Linux server**: Ubuntu 24.04 (Debian works too), 4 GB of RAM at least, 8 GB to be comfortable (each session with a browser tool takes about 300–500 MB). A VPS (Hetzner's CX23/CX33 are €5–9 a month in Europe) or a machine at home. You reach it over SSH with a key.
- **A model provider for fx**, one of:
  - **ChatGPT subscription** (`fx login codex`): a fixed monthly price.
  - **Vercel AI Gateway** (`fx setup`, an API key): pay per use. Set a spending limit. It is the one that mixes models from several vendors in one task.
  - **Grok subscription** (`fx login grok`).
- **A way in from your devices**, one of:
  - **Cloudflare**: a domain whose DNS is on Cloudflare, plus Cloudflare Zero Trust (free). fox gets a public HTTPS address behind a Cloudflare login.
  - **Tailscale**: no domain. fox is reachable only from your own devices signed in to your tailnet.
- **A passkey** on the devices you will use (iCloud Keychain, Google Password Manager, 1Password…). It is fox's login.
- Optional, recommended: **GitHub** (`gh`), to open workspaces from your repos and let fx open pull requests.

Your own computer can be Windows, macOS or Linux: you only use a browser and SSH.

## 1. Prepare the server

Two users: `admin` (with sudo) to manage the machine, and `fox` (**without sudo**) where fox, fx and your code run. fx runs commands a model writes; if `fox` had sudo, a prompt injection would be root.

As root, the first time:

```bash
adduser --disabled-password --gecos "" admin && usermod -aG sudo admin
echo 'admin ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/admin
mkdir -p /home/admin/.ssh && cp ~/.ssh/authorized_keys /home/admin/.ssh/ && chown -R admin: /home/admin/.ssh
adduser --disabled-password --gecos "" fox && chmod 700 /home/fox
```

Check that `ssh admin@<server>` works in another terminal, then close the door to passwords and root, and to everything except SSH:

```bash
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/; s/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl restart ssh
ufw allow OpenSSH && ufw --force enable
```

On a VPS, also keep `fox` away from the provider's metadata service (it can hold the server's setup data):

```bash
iptables -A OUTPUT -m owner --uid-owner fox -d 169.254.169.254 -j REJECT
apt-get install -y iptables-persistent
```

## 2. Install fox, fx, Node and tmux

As `admin`, install the system packages (Node 22, tmux, and the compiler the terminal needs) and fox itself, owned by root so an agent cannot change the fox that controls it:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs tmux git build-essential python3
sudo npm install -g --prefix /opt/fox https://github.com/jamarks/fox/archive/refs/heads/release.tar.gz
```

As `fox`, install fx:

```bash
sudo -iu fox
curl -fsSL https://fx.sh/setup.sh | bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
```

## 3. Sign fx in to a model provider

As `fox`. The ChatGPT login opens a page on your computer that comes back to `localhost:1455` **on the server**, so connect with that port forwarded (from your computer):

```bash
ssh -t -L 1455:localhost:1455 fox@<server> 'bash -lc "fx login codex"'
```

Open the link it prints in your browser and approve. Never copy the page it lands on by hand: it carries an authorization code.

For the AI Gateway instead: `fx setup` and paste the key when it asks (on the server, not in a chat). Check with `fx status`: `connected_providers=` lists what fx can use.

## 4. Keep fox and the sessions running

fx sessions live in tmux, in a service of their own, so restarting or updating fox never stops an agent. As `admin`:

```bash
sudo loginctl enable-linger fox
sudo -iu fox bash -c 'mkdir -p ~/.config/systemd/user && cat > ~/.config/systemd/user/fox-tmux.service' <<'EOF'
[Unit]
Description=tmux server for fox (fx sessions live here, apart from fox)

[Service]
Type=forking
Environment=TMUX_TMPDIR=/home/fox/.tmux
Environment=LANG=C.UTF-8
Environment=PATH=/home/fox/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStartPre=/usr/bin/mkdir -p -m 700 /home/fox/.tmux
ExecStart=/usr/bin/tmux new-session -d -s keepalive
ExecStop=/usr/bin/tmux kill-server
Restart=always

[Install]
WantedBy=default.target
EOF
sudo -iu fox bash -c 'XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user enable --now fox-tmux'
```

fox's settings go in `/etc/fox/fox.env`. `FOX_PUBLIC_ORIGIN` is the address you will open (step 5); fox only accepts requests for exactly that host:

```bash
sudo mkdir -p /etc/fox && sudo tee /etc/fox/fox.env >/dev/null <<'EOF'
FOX_PUBLIC_ORIGIN=https://fox.example.com
PORT=4848
TMUX_TMPDIR=/home/fox/.tmux
FOX_IDLE_SLEEP_MIN=30
EOF
sudo tee /etc/systemd/system/fox.service >/dev/null <<'EOF'
[Unit]
Description=fox
After=network-online.target
Wants=network-online.target

[Service]
User=fox
Group=fox
WorkingDirectory=/opt/fox/lib/node_modules/fox
EnvironmentFile=/etc/fox/fox.env
Environment=HOME=/home/fox
Environment=LANG=C.UTF-8
Environment=PATH=/home/fox/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/node /opt/fox/lib/node_modules/fox/server.mjs
Restart=always
RestartSec=2
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now fox
```

fox listens only on `127.0.0.1:4848`. Never make it listen on `0.0.0.0`, and never set `FOX_AUTH_DISABLED=1` on a server: fox is a shell on this machine.

## 5. A way in

### Cloudflare (with a domain)

Cloudflare Tunnel connects outward from the server, and Cloudflare Access asks for your login before anything reaches fox: two locks, fox's passkey being the second.

1. In Cloudflare Zero Trust → Access → Applications, add a **self-hosted** app for `fox.example.com`, with a policy that allows only your email. **Do this before step 3**, so the address never answers without a login.
2. Install `cloudflared` from [Cloudflare's apt repository](https://pkg.cloudflare.com/), then as `admin`:

   ```bash
   sudo cloudflared tunnel login                # opens a link to approve in your browser
   sudo cloudflared tunnel create fox
   sudo cloudflared tunnel route dns fox fox.example.com
   ```

3. `/etc/cloudflared/config.yml` (the tunnel id and credentials file come from `tunnel create`):

   ```yaml
   tunnel: <tunnel id>
   credentials-file: /root/.cloudflared/<tunnel id>.json
   ingress:
     - hostname: fox.example.com
       service: http://127.0.0.1:4848
     - service: http_status:404
   ```

   Then `sudo cloudflared tunnel ingress validate && sudo cloudflared service install`.

### Tailscale (no domain)

Install Tailscale on the server and on your devices, signed in to the same tailnet. On the server:

```bash
sudo tailscale serve --bg http://127.0.0.1:4848
tailscale serve status        # shows https://<server>.<tailnet>.ts.net
```

Set `FOX_PUBLIC_ORIGIN` in `/etc/fox/fox.env` to that `https://….ts.net` address and `sudo systemctl restart fox`. Only devices in your tailnet reach it; never use Tailscale Funnel, which makes it public.

> Not yet tested end to end with fox's passkey login. If the login page refuses the address, open an issue.

## 6. Create your passkey

As `admin`, ask fox for a one-time enrollment code (valid 10 minutes):

```bash
cd /opt/fox/lib/node_modules/fox && sudo -u fox -H env FOX_PUBLIC_ORIGIN=https://fox.example.com node bin/fox-enroll.mjs
```

Open your fox address, type the code and create the passkey. Save it in a password manager that syncs, so the same passkey works on your phone and your laptop. Never put the code in a URL or a chat.

That's it: open the address on any device, sign in with the passkey, and press **+** to start a session.

## 7. GitHub (optional)

As `fox`, `gh auth login` with a **fine-grained token** limited to the repos fx should work on (Contents and Pull requests: read and write). Never a classic token with your whole account: everything in `fox`'s home is reachable by an agent. Then workspaces list your repos, and fx can push and open pull requests.

## Updating

```bash
sudo npm install -g --prefix /opt/fox https://github.com/jamarks/fox/archive/refs/heads/release.tar.gz && sudo systemctl restart fox
```

Restarting fox does not stop fx sessions: they live in `fox-tmux`. A reboot does stop them; their conversations stay on disk, and opening one in fox resumes it.

## If you lose your passkey

`fox-enroll` refuses while a passkey is registered. Over SSH: `sudo systemctl stop fox`, move `/home/fox/.config/fox/passkey.json` somewhere safe, `sudo systemctl start fox`, and run step 6 again. Your sessions stay on disk.

## Good to know

- **Backups**: everything that matters is in `/home/fox` (your repos, `~/.fx` with the conversations, `~/.config/fox` with the passkey). Your provider's backups or `restic` to a bucket both work.
- **Automatic reboots** (`unattended-upgrades`) stop every running agent mid-task. Set `Unattended-Upgrade::Automatic-Reboot "false";` and reboot by hand.
- **Credentials**: an agent can read anything `fox` can. Keep them minimal and capped: a Gateway key with a spending limit, GitHub tokens per repo. For repos you do not trust, start fx with `/permissions ask`.
- **TLS ends at Cloudflare** in the Cloudflare setup: Cloudflare can see the traffic. Fine for personal use; Tailscale is end-to-end.
