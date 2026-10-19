#!/usr/bin/env bash
# fox installer: checks Node, tmux and fx, installs fox from GitHub and starts it. On a server, docs/server.md.
#   curl -fsSL https://raw.githubusercontent.com/jamarks/fox/release/setup.sh | bash
# FOX_NO_START=1 installs without starting fox. FOX_REF=<commit, branch or tag> installs that instead of release.
set -euo pipefail

# What gets installed is one exact commit: the one `release` points to (what the server runs, after its tests),
# never whatever `main` has at that moment. Its dependencies are the ones npm-shrinkwrap.json pins.
# The tarball, not "github:jamarks/fox": npm fails installing a git dependency globally when it has
# install scripts (node-pty), with "spawn sh ENOENT".
REF="${FOX_REF:-release}"
COMMIT="$(curl -fsSL -H 'Accept: application/vnd.github.sha' "https://api.github.com/repos/jamarks/fox/commits/$REF" 2>/dev/null || true)"
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || COMMIT="$REF" # GitHub's API is rate-limited: fall back to the name
REPO="https://github.com/jamarks/fox/archive/$COMMIT.tar.gz"
bold=$'\033[1m'; dim=$'\033[2m'; red=$'\033[31m'; green=$'\033[32m'; reset=$'\033[0m'
step() { printf '%s›%s %s\n' "$bold" "$reset" "$1"; }
ok() { printf '  %s✓%s %s\n' "$green" "$reset" "$1"; }
fail() { printf '  %s✗%s %s\n' "$red" "$reset" "$1" >&2; exit 1; }
# Piped into bash, stdin is the script itself: ask questions on the terminal.
ask() { local answer=""; [ -r /dev/tty ] || return 1; printf '  %s [Y/n] ' "$1"; read -r answer </dev/tty || return 1; [[ -z "$answer" || "$answer" =~ ^[Yy] ]]; }
# Debian and Ubuntu (a VPS, a home server, WSL): system packages through apt, with sudo unless already root.
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"
has_apt() { command -v apt-get >/dev/null 2>&1; }
# </dev/null: piped into bash, stdin is the rest of this script, and apt would read it. No questions (tzdata) either.
apt_install() { $SUDO env DEBIAN_FRONTEND=noninteractive apt-get update -qq </dev/null && $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" </dev/null >/dev/null; }

printf '\n%sfox%s %s· your fx agents, from any device%s\n\n' "$bold" "$reset" "$dim" "$reset"

step "Node.js"
if ! command -v node >/dev/null 2>&1; then
  if has_apt && ask "Node.js is missing. Install Node 22 from NodeSource with apt?"; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO env DEBIAN_FRONTEND=noninteractive bash - >/dev/null 2>&1 && apt_install nodejs
  else
    fail "Node 20 or newer is needed: 'brew install node' on macOS, Node 22 from https://github.com/nodesource/distributions on Debian or Ubuntu."
  fi
fi
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 20 ] || fail "Node $(node -v) is too old; fox needs 20 or newer."
ok "node $(node -v)"

step "tmux"
if ! command -v tmux >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1 && ask "tmux is missing. Install it with Homebrew?"; then
    brew install tmux
  elif has_apt && ask "tmux is missing. Install it with apt?"; then
    apt_install tmux
  else
    fail "tmux is needed: 'brew install tmux' on macOS, 'sudo apt install tmux' on Debian or Ubuntu."
  fi
fi
ok "$(tmux -V)"

# node-pty, the terminal, ships no Linux binaries: npm compiles it, which needs a compiler, make and python3.
if [ "$(uname -s)" = "Linux" ]; then
  step "Build tools"
  if ! command -v make >/dev/null 2>&1 || ! command -v g++ >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
    if has_apt && ask "A compiler, make and python3 are needed to build the terminal. Install them with apt?"; then
      apt_install build-essential python3
    else
      fail "Install a C++ compiler, make and python3 ('sudo apt install build-essential python3'), then run this again."
    fi
  fi
  ok "g++, make, python3"
fi

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
# A system Node (apt) keeps its global folder for root: install into ~/.local instead of asking for sudo.
PREFIX="$(npm prefix -g)"
if [ ! -w "$PREFIX/lib" ] && [ ! -w "$PREFIX" ]; then PREFIX="$HOME/.local"; mkdir -p "$PREFIX"; fi
npm install -g --prefix "$PREFIX" "$REPO" --no-fund --no-audit --loglevel=error \
  || fail "npm could not install fox into $PREFIX."
FOX="$PREFIX/bin/fox"
ok "installed $FOX (${COMMIT:0:12})"
case ":$PATH:" in *":$PREFIX/bin:"*) ;; *) printf '  %sAdd it to your PATH: echo '\''export PATH="%s/bin:$PATH"'\'' >> ~/.bashrc%s\n' "$dim" "$PREFIX" "$reset" ;; esac

if [ "${FOX_NO_START:-}" = "1" ]; then
  printf '\nRun %sfox%s to start it.\n' "$bold" "$reset"
  exit 0
fi
printf '\nStarting fox. It opens http://127.0.0.1:4848; Ctrl+C stops it, your fx sessions keep running.\n\n'
exec "$FOX" </dev/tty
