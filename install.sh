#!/usr/bin/env sh
# Installs Jean Code.
#
#   curl -fsSL https://raw.githubusercontent.com/hackerxj2010/Jean_Code/main/install.sh | sh
#   ./install.sh               from a checkout: builds that checkout
#
# Run on its own, it downloads the prebuilt Jean for this machine into
# ~/.jean/bin — one program, nothing else needed. From a checkout, or with
# --source, it builds from source instead, installing Bun, the Rust toolchain,
# the native core, the debuggers, and the common language servers.
#
# Options:
#   --source     build from source even when a prebuilt release exists
#   --version V  a specific release (default: the latest)
#   --all        (source) every debugger and language server that installs
#                itself, not only those for the languages on this machine
#   --no-rust    (source) do not install Rust; Jean runs on its TypeScript fallbacks
#   --no-tools   (source) skip debuggers and language servers (`jean setup` later)
#
# The prebuilt Jean lives in ~/.jean/bin; a source build's `jean` goes next to
# `bun`, in ~/.bun/bin.
set -eu

GITHUB="${JEAN_GITHUB:-hackerxj2010/Jean_Code}"
REPO="${JEAN_REPO:-https://github.com/$GITHUB.git}"
HOME_DIR="${JEAN_INSTALL_DIR:-$HOME/.jean/jean-code}"
SETUP="default"
RUST=1
TOOLS=1
SOURCE=0
VERSION="${JEAN_VERSION:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --source) SOURCE=1 ;;
    --version) shift; VERSION="${1:-}" ;;
    --all) SETUP="all" ;;
    --no-rust) RUST=0 ;;
    --no-tools) TOOLS=0 ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || echo "")
IN_CHECKOUT=0
[ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/packages/cli/src/index.ts" ] && IN_CHECKOUT=1

# The prebuilt release: which platform this is, then download and unpack it.
# Returns non-zero, without changing anything, when there is none to use.
install_release() {
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) warn "no prebuilt Jean for $(uname -s)"; return 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) cpu=x64 ;;
    aarch64|arm64) cpu=arm64 ;;
    *) warn "no prebuilt Jean for $(uname -m)"; return 1 ;;
  esac
  # An x64 shell on an Apple Silicon Mac (Rosetta) should still get arm64.
  if [ "$os" = darwin ] && [ "$cpu" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then
    cpu=arm64
  fi
  # The prebuilt Linux binary needs glibc; Alpine and other musl systems build from source.
  if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then
    warn "this system uses musl libc; the prebuilt Jean needs glibc"
    return 1
  fi
  have curl || { warn "curl is needed to download Jean"; return 1; }
  have tar || { warn "tar is needed to unpack Jean"; return 1; }

  file="jean-$os-$cpu.tar.gz"
  if [ -n "${JEAN_RELEASE_URL:-}" ]; then
    url="$JEAN_RELEASE_URL/$file"   # a mirror, or a local build to test
  elif [ -n "$VERSION" ]; then
    url="https://github.com/$GITHUB/releases/download/v${VERSION#v}/$file"
  else
    url="https://github.com/$GITHUB/releases/latest/download/$file"
  fi

  tmp=$(mktemp -d)
  say "Downloading $file"
  if ! curl -fSL --progress-bar "$url" -o "$tmp/$file"; then
    rm -rf "$tmp"
    warn "no prebuilt release at $url"
    return 1
  fi
  mkdir -p "$tmp/jean"
  tar -xzf "$tmp/$file" -C "$tmp/jean"

  # Replaced whole, so no file from an older version is left behind — but
  # only once the new one has unpacked.
  BIN="$HOME/.jean/bin"
  mkdir -p "$BIN"
  rm -rf "$BIN/skills"
  cp -R "$tmp/jean/." "$BIN/"
  chmod +x "$BIN/jean"
  [ -f "$BIN/pi-natives" ] && chmod +x "$BIN/pi-natives"
  rm -rf "$tmp"

  say "Installed $("$BIN/jean" --version) in $BIN"
  case ":$PATH:" in
    *":$BIN:"*) ;;
    *)
      for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
        [ -f "$rc" ] || continue
        grep -qs '.jean/bin' "$rc" || printf '\n# Jean Code\nexport PATH="$HOME/.jean/bin:$PATH"\n' >> "$rc"
      done
      warn "open a new terminal, or run: export PATH=\"$BIN:\$PATH\""
      ;;
  esac
  printf '\nDone. Give it a key with `jean auth login openrouter` (or another provider), then run: jean\n'
}

if [ "$SOURCE" = 0 ] && [ "$IN_CHECKOUT" = 0 ]; then
  install_release && exit 0
  say "Building from source instead"
fi

# 1. The checkout: this one when run from it, otherwise a clone kept current.
if [ "$IN_CHECKOUT" = 1 ]; then
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
