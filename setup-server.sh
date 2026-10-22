#!/usr/bin/env bash
# fox on a server: turns a fresh Ubuntu or Debian machine (a VPS or a computer at home) into a running fox.
#   curl -fsSL https://raw.githubusercontent.com/jamarks/fox/release/setup-server.sh | sudo bash -s -- --cloudflare fox.example.com
#   ... | sudo bash -s -- --tailscale          no domain: only your tailnet's devices reach it
#   ... | sudo bash -s -- --origin https://…   you already route that address to 127.0.0.1:4848
#   ... | sudo bash                            no way in yet: reach fox over an SSH tunnel
#   add --claude-code to also install Claude Code, to run sessions on your Claude Pro or Max subscription
# Or from a checkout: sudo ./setup-server.sh [same options]. Running it again is safe: every step checks first.
# It never asks for or stores a secret. The logins (fx's provider, GitHub, Cloudflare, Tailscale) are yours: it
# stops and tells you, or prints the exact command. What it sets up, step by step, is below; docs/server.md
# explains why. FOX_REPO=https://github.com/<you>/fox.git deploys a fork; FOX_REF picks the setup files' ref.
set -euo pipefail

FOX_REPO="${FOX_REPO:-https://github.com/jamarks/fox.git}"
FOX_REF="${FOX_REF:-release}"
MODE="" HOSTNAME_ARG="" ORIGIN="" FIREWALL=1 HARDEN_SSH=1 CLAUDE_CODE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --cloudflare) MODE=cloudflare; HOSTNAME_ARG="${2:?--cloudflare needs a hostname, e.g. fox.example.com}"; shift ;;
    --tailscale) MODE=tailscale ;;
    --origin) MODE=origin; ORIGIN="${2:?--origin needs an https:// address}"; shift ;;
    --no-firewall) FIREWALL=0 ;;
    --no-ssh-hardening) HARDEN_SSH=0 ;;
    --claude-code) CLAUDE_CODE=1 ;;
    -h|--help) sed -n '2,13p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

bold=$'\033[1m'; dim=$'\033[2m'; red=$'\033[31m'; green=$'\033[32m'; yellow=$'\033[33m'; reset=$'\033[0m'
step() { printf '\n%s›%s %s\n' "$bold" "$reset" "$1"; }
ok() { printf '  %s✓%s %s\n' "$green" "$reset" "$1"; }
note() { printf '  %s%s%s\n' "$dim" "$1" "$reset"; }
warn() { printf '  %s!%s %s\n' "$yellow" "$reset" "$1"; }
fail() { printf '  %s✗%s %s\n' "$red" "$reset" "$1" >&2; exit 1; }
# Piped into bash, stdin is this script: questions go to the terminal, and nothing else may read stdin.
pause() { [ -r /dev/tty ] || fail "$1 (no terminal to wait on: run it, then run this script again)"; printf '  %s%s%s\n  Press Enter when done. ' "$yellow" "$1" "$reset"; read -r _ </dev/tty; }
apt_install() { DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" </dev/null >/dev/null; }
as_fox() { runuser -u fox -- env HOME=/home/fox XDG_RUNTIME_DIR="/run/user/$(id -u fox)" PATH=/home/fox/.local/bin:/usr/local/bin:/usr/bin:/bin "$@" </dev/null; }
set_env() { # set_env KEY VALUE: one line in /etc/fox/fox.env, replaced if there
  grep -q "^$1=" /etc/fox/fox.env && sed -i "s#^$1=.*#$1=$2#" /etc/fox/fox.env || echo "$1=$2" >> /etc/fox/fox.env
}

printf '\n%sfox%s %s· server setup%s\n' "$bold" "$reset" "$dim" "$reset"

[ "$(id -u)" -eq 0 ] || fail "Run it as root: sudo bash setup-server.sh, or pipe it into sudo bash."
command -v apt-get >/dev/null || fail "This script knows Ubuntu and Debian (apt). On another Linux, follow docs/server.md by hand."
[ -d /run/systemd/system ] || fail "fox runs as systemd services, and this machine has no systemd."

# The files this script installs (deploy/): from this checkout, or from the repo at FOX_REF.
SRC="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -z "$SRC" ] || [ ! -f "$SRC/deploy/fox-update" ]; then
  SRC="$(mktemp -d)"; trap 'rm -rf "$SRC"' EXIT
  command -v curl >/dev/null || { apt-get update -qq </dev/null; apt_install curl ca-certificates; }
  curl -fsSL "${FOX_REPO%.git}/archive/$FOX_REF.tar.gz" | tar -xz -C "$SRC" --strip-components=1 \
    || fail "Could not download $FOX_REPO at $FOX_REF."
fi
DEPLOY="$SRC/deploy"

step "System packages"
apt-get update -qq </dev/null
apt_install curl ca-certificates git tmux build-essential python3 gnupg
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | DEBIAN_FRONTEND=noninteractive bash - >/dev/null 2>&1
  apt_install nodejs
fi
if ! command -v gh >/dev/null; then # GitHub's CLI, from GitHub's apt repository
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
  apt-get update -qq </dev/null && apt_install gh
fi
ok "node $(node -v), $(tmux -V), git, gh, build tools"

step "Users"
# fox runs fox, fx and your code, without sudo: fx runs commands a model writes, and with sudo a prompt injection
# would be root. foxbuild only builds new versions of fox (npm runs install scripts), never as root.
id fox >/dev/null 2>&1 || useradd --create-home --shell /bin/bash fox
chmod 700 /home/fox
id foxbuild >/dev/null 2>&1 || useradd --system --home-dir /var/lib/foxbuild --create-home --shell /usr/sbin/nologin foxbuild
install -d -o foxbuild -g foxbuild -m 755 /var/lib/foxbuild/builds
if [ -e /etc/sudoers.d/fox ] || id -nG fox | grep -qw sudo; then warn "fox has sudo: remove it (deluser fox sudo; rm /etc/sudoers.d/fox)"; fi
ok "fox (no sudo), foxbuild"

step "Machine"
if [ "$HARDEN_SSH" = 1 ] && [ -d /etc/ssh/sshd_config.d ]; then
  # Only once a key can get in, or this would lock the owner out.
  keys=0
  for f in /root/.ssh/authorized_keys ${SUDO_USER:+/home/$SUDO_USER/.ssh/authorized_keys}; do [ -s "$f" ] && keys=1; done
  if [ "$keys" = 1 ]; then
    printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/10-fox.conf
    sshd -t && (systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true)
    ok "SSH: keys only"
  else
    warn "SSH keeps accepting passwords: no authorized key found for root${SUDO_USER:+ or $SUDO_USER}"
  fi
fi
if [ "$FIREWALL" = 1 ]; then
  apt_install ufw
  if ufw status | grep -q "Status: active"; then ok "firewall already on (left as it is)"
  else
    ufw allow 22/tcp >/dev/null && ufw --force enable >/dev/null && ok "firewall on: only SSH comes in" \
      || warn "could not turn the firewall on (ufw); fox still only listens on 127.0.0.1"
    note "Other services on this machine need their own rule: ufw allow <port>. Or rerun with --no-firewall."
  fi
fi
# An automatic reboot stops every agent mid-task: security updates stay automatic, reboots are yours.
printf 'Unattended-Upgrade::Automatic-Reboot "false";\n' > /etc/apt/apt.conf.d/52fox-no-auto-reboot
install -m 644 "$DEPLOY/fox-metadata-block.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now fox-metadata-block >/dev/null 2>&1 && ok "fox cannot reach the cloud metadata service" \
  || warn "could not block the metadata service for fox (iptables)"
ok "no automatic reboots"

step "fx"
if [ ! -x /home/fox/.local/bin/fx ]; then
  runuser -u fox -- env HOME=/home/fox bash -c 'curl -fsSL https://fx.sh/setup.sh | bash' >/dev/null
fi
grep -q '.local/bin' /home/fox/.bashrc || echo 'export PATH="$HOME/.local/bin:$PATH"' >> /home/fox/.bashrc
ok "fx $(as_fox fx --version 2>/dev/null | tail -1)"
# Claude Code, next to fx: fox offers it in the new-session sheet once it is installed. It updates itself.
if [ "$CLAUDE_CODE" = 1 ] || [ -x /home/fox/.local/bin/claude ]; then
  step "Claude Code"
  [ -x /home/fox/.local/bin/claude ] || runuser -u fox -- env HOME=/home/fox bash -c 'curl -fsSL https://claude.ai/install.sh | bash' >/dev/null
  ok "Claude Code $(as_fox claude --version 2>/dev/null | tail -1)"
fi
# GitHub: one token per owner, picked by the repo's owner (deploy/git). gh's own login covers the rest.
install -d -o fox -g fox /home/fox/.local/bin
install -o fox -g fox -m 755 "$DEPLOY/git/fox-git-credential" "$DEPLOY/git/fox-git-token" "$DEPLOY/git/gh" /home/fox/.local/bin/
as_fox git config --global credential.https://github.com.helper '!fox-git-credential'
as_fox git config --global credential.https://github.com.useHttpPath true
ok "GitHub helpers (gh, fox-git-token)"

step "Settings"
install -d -m 755 /etc/fox
[ -f /etc/fox/fox.env ] || install -m 644 "$DEPLOY/fox.env.example" /etc/fox/fox.env
[ -f /etc/fox/secrets.env ] || install -m 600 /dev/null /etc/fox/secrets.env
[ "$FOX_REPO" = "https://github.com/jamarks/fox.git" ] && rm -f /etc/fox/update.conf || echo "FOX_REPO=$FOX_REPO" > /etc/fox/update.conf
ok "/etc/fox/fox.env"

step "A way in"
case "$MODE" in
  cloudflare)
    ORIGIN="https://$HOSTNAME_ARG"
    if ! command -v cloudflared >/dev/null; then
      curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
      echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" > /etc/apt/sources.list.d/cloudflared.list
      apt-get update -qq </dev/null && apt_install cloudflared
    fi
    ok "cloudflared $(cloudflared --version 2>/dev/null | awk '{print $3}')"
    if [ ! -f /etc/cloudflared/config.yml ]; then
      # Access first, so the address never answers without a login.
      pause "In Cloudflare Zero Trust → Access → Applications, add a self-hosted app for $HOSTNAME_ARG that allows only your email."
      [ -f /root/.cloudflared/cert.pem ] || { note "Approve this server in your browser:"; cloudflared tunnel login </dev/null; }
      cloudflared tunnel list 2>/dev/null | awk '{print $2}' | grep -qx fox || cloudflared tunnel create fox </dev/null >/dev/null
      TUNNEL_ID="$(cloudflared tunnel list 2>/dev/null | awk '$2=="fox"{print $1}')"
      cloudflared tunnel route dns fox "$HOSTNAME_ARG" </dev/null >/dev/null 2>&1 || warn "DNS route for $HOSTNAME_ARG not created (it may exist already)"
      install -d -m 755 /etc/cloudflared
      printf 'tunnel: %s\ncredentials-file: /root/.cloudflared/%s.json\ningress:\n  - hostname: %s\n    service: http://127.0.0.1:4848\n  - service: http_status:404\n' "$TUNNEL_ID" "$TUNNEL_ID" "$HOSTNAME_ARG" > /etc/cloudflared/config.yml
      cloudflared tunnel ingress validate >/dev/null
      systemctl is-enabled cloudflared >/dev/null 2>&1 || cloudflared service install >/dev/null 2>&1
      systemctl restart cloudflared
    fi
    ok "Cloudflare Tunnel → $ORIGIN"
    ;;
  tailscale)
    command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh >/dev/null 2>&1
    if ! tailscale status >/dev/null 2>&1; then note "Approve this server in your browser:"; tailscale up </dev/null; fi
    tailscale serve --bg http://127.0.0.1:4848 >/dev/null
    ORIGIN="https://$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
    ok "Tailscale Serve → $ORIGIN (only your tailnet)"
    ;;
  origin) ok "$ORIGIN (you route it to 127.0.0.1:4848)" ;;
  *)
    ORIGIN="$(sed -n 's/^FOX_PUBLIC_ORIGIN=//p' /etc/fox/fox.env)"
    [ "$ORIGIN" = "https://fox.example.com" ] && ORIGIN=""
    if [ -n "$ORIGIN" ]; then ok "$ORIGIN (from /etc/fox/fox.env)"
    else note "None yet: fox answers at localhost through an SSH tunnel. Rerun with --cloudflare or --tailscale later."; fi
    ;;
esac
if [ -n "$ORIGIN" ]; then
  [[ "$ORIGIN" =~ ^https://[A-Za-z0-9.-]+$ ]] || fail "The address must be https://host, without a path: $ORIGIN"
  set_env FOX_PUBLIC_ORIGIN "$ORIGIN"
else
  sed -i '/^FOX_PUBLIC_ORIGIN=/d' /etc/fox/fox.env
fi

step "Services"
install -m 644 "$DEPLOY/fox.service" "$DEPLOY/fox-jobs.service" "$DEPLOY/fox-update.service" "$DEPLOY/fox-update.timer" /etc/systemd/system/
install -m 755 "$DEPLOY/fox-update" /usr/local/sbin/fox-update
systemctl daemon-reload
# fx sessions live in a tmux server of fox's own (a user service), so restarting or updating fox never stops one.
loginctl enable-linger fox
for _ in $(seq 1 20); do [ -S "/run/user/$(id -u fox)/bus" ] && break; sleep 0.5; done
install -d -o fox -g fox /home/fox/.config /home/fox/.config/systemd /home/fox/.config/systemd/user
install -o fox -g fox -m 644 "$DEPLOY/fox-tmux.service" /home/fox/.config/systemd/user/
as_fox systemctl --user daemon-reload
as_fox systemctl --user enable --now fox-tmux >/dev/null 2>&1
ok "fox-tmux (fx sessions)"
systemctl enable fox fox-jobs >/dev/null 2>&1
note "Building fox and running its tests as foxbuild (a few minutes the first time)…"
/usr/local/sbin/fox-update || fail "fox-update could not deploy fox: see journalctl -t fox-update"
[ -L /opt/fox/current ] || fail "fox is not deployed (/opt/fox/current is missing)"
systemctl restart fox
systemctl enable --now fox-update.timer fox-jobs >/dev/null 2>&1
ok "fox $(basename "$(readlink -f /opt/fox/current)" | cut -c1-12), updated every minute from $FOX_REPO (Settings → Deploy picks the branch)"

step "Your turn"
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
ME="${SUDO_USER:-root}"
n=1
if ! as_fox fx status 2>/dev/null | grep -q 'connected_providers=.\+'; then
  printf '\n  %s%d. Sign fx in to a model provider%s, from your computer (the login comes back to port 1455 on the server):\n' "$bold" $n "$reset"; n=$((n+1))
  printf '     ssh -t -L 1455:localhost:1455 %s@%s sudo -iu fox fx login codex     %s(ChatGPT subscription)%s\n' "$ME" "$IP" "$dim" "$reset"
  printf '     ssh -t %s@%s sudo -iu fox fx setup                                   %s(or a Vercel AI Gateway key)%s\n' "$ME" "$IP" "$dim" "$reset"
fi
if [ -x /home/fox/.local/bin/claude ] && ! as_fox claude auth status 2>/dev/null | grep -q '"loggedIn": true'; then
  printf '\n  %s%d. Sign Claude Code in%s to your Claude Pro or Max subscription: it prints a link; open it, approve, paste the code back:\n' "$bold" $n "$reset"; n=$((n+1))
  printf '     ssh -t %s@%s sudo -iu fox claude auth login\n' "$ME" "$IP"
fi
if ! as_fox gh auth status >/dev/null 2>&1; then
  printf '\n  %s%d. GitHub%s (optional): sudo -iu fox gh auth login, with a fine-grained token for the repos fx may use.\n' "$bold" $n "$reset"; n=$((n+1))
fi
if [ ! -f /home/fox/.config/fox/passkey.json ]; then
  if [ -n "$ORIGIN" ]; then
    CODE_MSG="$(cd /opt/fox/current && as_fox env FOX_PUBLIC_ORIGIN="$ORIGIN" node bin/fox-enroll.mjs 2>&1 | sed -n '2p')"
    printf '\n  %s%d. Create your passkey%s: open %s and type this code (valid 10 minutes, single use; never put it in a URL):\n     %s%s%s\n' "$bold" $n "$reset" "$ORIGIN" "$bold" "$CODE_MSG" "$reset"
    note "   Expired? Run this script again for a new one."
  else
    printf '\n  %s%d. Open fox%s through an SSH tunnel, then create your passkey there:\n     ssh -L 4848:localhost:4848 %s@%s   and open http://localhost:4848\n' "$bold" $n "$reset" "$ME" "$IP"
  fi
else
  printf '\n  fox is ready: %s\n' "${ORIGIN:-http://localhost:4848 (through ssh -L 4848:localhost:4848 $ME@$IP)}"
fi
printf '\n'
