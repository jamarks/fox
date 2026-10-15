#!/usr/bin/env bash
# fox installer: checks Node, tmux and fx, installs fox from GitHub and starts it.
#   curl -fsSL https://raw.githubusercontent.com/jamarks/fox/main/setup.sh | bash
# FOX_NO_START=1 installs without starting fox.
set -euo pipefail

# The tarball, not "github:jamarks/fox": npm fails installing a git dependency globally when it has
# install scripts (node-pty), with "spawn sh ENOENT".
REPO="https://github.com/jamarks/fox/archive/refs/heads/main.tar.gz"
bold=$'\033[1m'; dim=$'\033[2m'; red=$'\033[31m'; green=$'\033[32m'; reset=$'\033[0m'
step() { printf '%s›%s %s\n' "$bold" "$reset" "$1"; }
ok() { printf '  %s✓%s %s\n' "$green" "$reset" "$1"; }
fail() { printf '  %s✗%s %s\n' "$red" "$reset" "$1" >&2; exit 1; }
# Piped into bash, stdin is the script itself: ask questions on the terminal.
ask() { local answer=""; [ -r /dev/tty ] || return 1; printf '  %s [Y/n] ' "$1"; read -r answer </dev/tty || return 1; [[ -z "$answer" || "$answer" =~ ^[Yy] ]]; }

printf '\n%sfox%s %s· a local cockpit for fx%s\n\n' "$bold" "$reset" "$dim" "$reset"

step "Node.js"
command -v node >/dev/null 2>&1 || fail "Node 20 or newer is needed. Install it from https://nodejs.org or with 'brew install node', then run this again."
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 20 ] || fail "Node $(node -v) is too old; fox needs 20 or newer."
ok "node $(node -v)"

step "tmux"
if ! command -v tmux >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1 && ask "tmux is missing. Install it with Homebrew?"; then
    brew install tmux
  else
    fail "tmux is needed: 'brew install tmux' on macOS, 'sudo apt install tmux' on Debian or Ubuntu."
  fi
fi
ok "$(tmux -V)"

step "fx"
if command -v fx >/dev/null 2>&1 || [ -x "$HOME/.local/bin/fx" ]; then
  ok "fx is installed"
elif ask "fx is not installed. Install it now from fx.sh?"; then
  curl -fsSL https://fx.sh/setup.sh | bash
  ok "fx installed"
else
  printf '  %sfox needs fx to do anything useful: curl -fsSL https://fx.sh/setup.sh | bash%s\n' "$dim" "$reset"
fi

step "fox"
npm install -g "$REPO" --no-fund --no-audit --loglevel=error \
  || fail "npm could not install globally. If it is a permissions error, use a Node from nvm or Homebrew instead of the system one."
FOX="$(command -v fox || echo "$(npm prefix -g)/bin/fox")"
ok "installed $FOX"

if [ "${FOX_NO_START:-}" = "1" ]; then
  printf '\nRun %sfox%s to start it.\n' "$bold" "$reset"
  exit 0
fi
printf '\nStarting fox. It opens http://127.0.0.1:4848; Ctrl+C stops it, your fx sessions keep running.\n\n'
exec "$FOX" </dev/tty
