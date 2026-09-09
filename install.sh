#!/bin/sh
# Coen 1 CLI installer — macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/adamnlynn/-coen1-cli/main/install.sh | sh
#
# What it does, in order:
#   1. Finds a Node 22+ to run with. If there isn't one, downloads an official build from
#      nodejs.org into this install's own directory and checks its SHA-256. Your system Node,
#      if you have one, is never touched or upgraded.
#   2. Installs @coen1/cli from npm into ~/.local/share/coen — a private prefix, so this never
#      needs sudo and never writes to /usr/local.
#   3. Drops a `coen` launcher in ~/.local/bin.
#
# Uninstall is `rm -rf ~/.local/share/coen ~/.local/bin/coen`. Nothing else is written.
#
# Env:
#   COEN_VERSION      version to install (default: latest)
#   COEN_INSTALL_DIR  where the package lives (default: ~/.local/share/coen)
#   COEN_BIN_DIR      where the launcher goes (default: ~/.local/bin)

set -eu

PKG="@coen1/cli"
NODE_FALLBACK="v24.21.0"          # only used when no suitable Node is already installed
MIN_NODE_MAJOR=22

INSTALL_DIR="${COEN_INSTALL_DIR:-$HOME/.local/share/coen}"
BIN_DIR="${COEN_BIN_DIR:-$HOME/.local/bin}"

say()  { printf '%s\n' "$*"; }
step() { printf '\033[2m›\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ── Refuse rather than half-install ──────────────────────────────────────────
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required and was not found."; }
need uname
need mkdir
command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 \
  || die "curl or wget is required and neither was found."

fetch() { # fetch <url> <dest>
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  else wget -qO "$2" "$1"; fi
}
fetch_stdout() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"
  else wget -qO- "$1"; fi
}

# ── Which machine is this ────────────────────────────────────────────────────
case "$(uname -s)" in
  Linux)  OS=linux ;;
  Darwin) OS=darwin ;;
  *) die "Unsupported OS: $(uname -s). Windows users: use install.ps1 in PowerShell." ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) die "Unsupported architecture: $(uname -m)." ;;
esac
step "$OS-$ARCH"

# ── A Node to run with ───────────────────────────────────────────────────────
# Prefer one this installer put there before, then the system's, and only download as a last
# resort. Checking the system's first means a normal machine installs in seconds with no download.
node_major() { "$1" -v 2>/dev/null | sed 's/^v//' | cut -d. -f1; }

NODE=""
if [ -x "$INSTALL_DIR/node/bin/node" ]; then
  NODE="$INSTALL_DIR/node/bin/node"
elif command -v node >/dev/null 2>&1; then
  m="$(node_major node || echo 0)"
  if [ "${m:-0}" -ge "$MIN_NODE_MAJOR" ] 2>/dev/null; then
    NODE="$(command -v node)"
    step "using your Node $(node -v)"
  else
    step "your Node $(node -v 2>/dev/null || echo '?') is older than v$MIN_NODE_MAJOR — leaving it alone"
  fi
fi

if [ -z "$NODE" ]; then
  NODE_VER="$NODE_FALLBACK"
  TARBALL="node-$NODE_VER-$OS-$ARCH.tar.gz"
  BASE="https://nodejs.org/dist/$NODE_VER"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT INT TERM

  step "downloading Node $NODE_VER (private to this install)"
  fetch "$BASE/$TARBALL" "$TMP/$TARBALL" || die "could not download $BASE/$TARBALL"

  # Verified, always. An installer that pipes an unverified download into your shell is the thing
  # people are right to be suspicious of.
  step "verifying checksum"
  fetch_stdout "$BASE/SHASUMS256.txt" > "$TMP/SHASUMS256.txt" || die "could not fetch SHASUMS256.txt"
  WANT="$(grep " $TARBALL\$" "$TMP/SHASUMS256.txt" | awk '{print $1}')"
  [ -n "$WANT" ] || die "no checksum published for $TARBALL"
  if command -v sha256sum >/dev/null 2>&1; then GOT="$(sha256sum "$TMP/$TARBALL" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1;   then GOT="$(shasum -a 256 "$TMP/$TARBALL" | awk '{print $1}')"
  else die "need sha256sum or shasum to verify the download"; fi
  [ "$WANT" = "$GOT" ] || die "checksum mismatch for $TARBALL — refusing to install.
  expected $WANT
  got      $GOT"
  ok "checksum verified"

  mkdir -p "$INSTALL_DIR"
  rm -rf "$INSTALL_DIR/node"
  mkdir -p "$INSTALL_DIR/node"
  tar -xzf "$TMP/$TARBALL" -C "$INSTALL_DIR/node" --strip-components=1
  NODE="$INSTALL_DIR/node/bin/node"
  [ -x "$NODE" ] || die "Node did not extract correctly"
  ok "Node $NODE_VER installed to $INSTALL_DIR/node"
fi

NPM_CLI="$(dirname "$NODE")/../lib/node_modules/npm/bin/npm-cli.js"
[ -f "$NPM_CLI" ] || NPM_CLI=""

# ── The package ──────────────────────────────────────────────────────────────
# Into our own prefix rather than the system one: no sudo, no fight with a distro-managed
# /usr/lib/node_modules, and uninstalling is deleting a directory.
SPEC="$PKG"
[ -n "${COEN_VERSION:-}" ] && SPEC="$PKG@$COEN_VERSION"

step "installing $SPEC"
mkdir -p "$INSTALL_DIR" "$BIN_DIR"
if [ -n "$NPM_CLI" ]; then
  "$NODE" "$NPM_CLI" install -g --prefix "$INSTALL_DIR" "$SPEC" >/dev/null 2>&1 \
    || die "npm install failed. Re-run with: $NODE $NPM_CLI install -g --prefix $INSTALL_DIR $SPEC"
else
  command -v npm >/dev/null 2>&1 || die "npm not found next to $NODE and not on PATH."
  npm install -g --prefix "$INSTALL_DIR" "$SPEC" >/dev/null 2>&1 || die "npm install failed."
fi

ENTRY="$INSTALL_DIR/lib/node_modules/$PKG/dist/index.js"
[ -f "$ENTRY" ] || die "installed, but $ENTRY is missing — the package layout is not what was expected."

# ── The launcher ─────────────────────────────────────────────────────────────
# A shim rather than a symlink into node_modules, so `coen` runs with the Node this installer
# picked even if the user later changes their nvm default.
#
# But it falls back to whatever `node` is on PATH, because the recorded one can genuinely vanish:
# if we used a system Node under ~/.nvm/versions/node/vX, `nvm uninstall vX` deletes it and a
# hardcoded path would leave `coen` permanently broken with a confusing "no such file" error.
cat > "$BIN_DIR/coen" <<LAUNCHER
#!/bin/sh
NODE="$NODE"
if [ ! -x "\$NODE" ]; then
  NODE="\$(command -v node 2>/dev/null || true)"
  if [ -z "\$NODE" ]; then
    echo "coen: the Node this was installed with is gone, and none is on PATH." >&2
    echo "      Reinstall:  curl -fsSL https://raw.githubusercontent.com/adamnlynn/-coen1-cli/main/install.sh | sh" >&2
    exit 1
  fi
fi
exec "\$NODE" "$ENTRY" "\$@"
LAUNCHER
chmod +x "$BIN_DIR/coen"

VER="$("$NODE" -e "process.stdout.write(require('$INSTALL_DIR/lib/node_modules/$PKG/package.json').version)" 2>/dev/null || echo '?')"
"$BIN_DIR/coen" --help >/dev/null 2>&1 || die "installed, but 'coen --help' did not run cleanly."
ok "Coen 1 CLI $VER installed"

# ── PATH ─────────────────────────────────────────────────────────────────────
# Told, not done. Editing someone's shell profile behind their back is not this script's business.
case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *)
    say ""
    say "  $BIN_DIR is not on your PATH. Add it:"
    say ""
    case "${SHELL##*/}" in
      zsh)  say "    echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc && exec zsh" ;;
      fish) say "    fish_add_path $BIN_DIR" ;;
      *)    say "    echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.bashrc && exec bash" ;;
    esac
    ;;
esac

say ""
say "  Next:  coen login      (it will offer to make you a free account)"
say "         coen            (Home)"
say ""
