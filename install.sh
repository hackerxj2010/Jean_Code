#!/usr/bin/env sh
# Installs Jean Code and everything it runs on: Bun, the Rust toolchain, the
# native core, the debuggers, and the common language servers.
#
#   ./install.sh               from a checkout
#   curl -fsSL https://raw.githubusercontent.com/jean-code/jean-code/main/install.sh | sh
#
# Options:
#   --all        every debugger and language server that installs itself,
#                not only the ones for the languages found on this machine
#   --no-rust    do not install Rust; Jean runs on its TypeScript fallbacks
#   --no-tools   skip debuggers and language servers (`jean setup` later)
#
# Everything Jean installs goes under ~/.jean; the `jean` command goes next to
# `bun`, in ~/.bun/bin.
set -eu

REPO="${JEAN_REPO:-https://github.com/jean-code/jean-code.git}"
HOME_DIR="${JEAN_INSTALL_DIR:-$HOME/.jean/jean-code}"
SETUP="default"
RUST=1
TOOLS=1
for arg in "$@"; do
  case "$arg" in
    --all) SETUP="all" ;;
    --no-rust) RUST=0 ;;
    --no-tools) TOOLS=0 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }

# 1. The checkout: this one when run from it, otherwise a clone kept current.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || echo "")
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/packages/cli/src/index.ts" ]; then
  ROOT="$SCRIPT_DIR"
else
  have git || { warn "git is needed to fetch Jean Code: https://git-scm.com"; exit 1; }
  if [ -d "$HOME_DIR/.git" ]; then
    say "Updating $HOME_DIR"
    git -C "$HOME_DIR" pull --ff-only
  else
    say "Cloning Jean Code into $HOME_DIR"
    mkdir -p "$(dirname "$HOME_DIR")"
    git clone --depth 1 "$REPO" "$HOME_DIR"
  fi
  ROOT="$HOME_DIR"
fi
cd "$ROOT"

# 2. Bun runs Jean.
if ! have bun; then
  if [ -x "$HOME/.bun/bin/bun" ]; then
    export PATH="$HOME/.bun/bin:$PATH"
  else
    say "Installing Bun"
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
  fi
fi

# 3. Rust builds the native core — search, edits, the shell, LSP, and DAP.
if [ "$RUST" = 1 ] && ! have cargo; then
  if [ -x "$HOME/.cargo/bin/cargo" ]; then
    export PATH="$HOME/.cargo/bin:$PATH"
  else
    say "Installing Rust (rustup)"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
    export PATH="$HOME/.cargo/bin:$PATH"
  fi
fi

# 4. Dependencies.
say "Installing dependencies"
bun install

# 5. The native core, debuggers, and language servers.
if [ "$TOOLS" = 1 ]; then
  say "Setting up the native core, debuggers, and language servers"
  bun packages/cli/src/index.ts setup "$SETUP" || warn "some steps failed; run \`jean setup\` to retry"
else
  say "Building the native core"
  bun packages/cli/src/index.ts setup native || warn "the native build failed; Jean runs on its TypeScript fallbacks"
fi

# 6. The `jean` command, beside `bun`.
BIN="$HOME/.bun/bin"
mkdir -p "$BIN"
cat > "$BIN/jean" <<EOF
#!/usr/bin/env sh
exec bun "$ROOT/packages/cli/src/index.ts" "\$@"
EOF
chmod +x "$BIN/jean"
say "Installed \`jean\` in $BIN"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) warn "add $BIN to your PATH: echo 'export PATH=\"$BIN:\$PATH\"' >> ~/.profile" ;;
esac

printf '\nDone. Set a key (export OPENROUTER_API_KEY=...) and run: jean\n'
