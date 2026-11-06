#!/usr/bin/env bash
#
# Run n8n with our in-development node loaded AND a public HTTPS tunnel, so
# ServiceNow can reach the trigger webhooks and wait/resume URLs (it needs
# a public HTTPS URL, not localhost).
#
# n8n 2.x removed the built-in `--tunnel` flag, so this uses a Cloudflare quick
# tunnel (no account needed) and points n8n at it via WEBHOOK_URL.
#
# What it does:
#   1. Symlinks this package into n8n's custom-extensions folder (once).
#   2. Builds (compiles TS + copies icons/codex into dist).
#   3. Keeps dist fresh with tsc --watch in the background.
#   4. Starts a cloudflared quick tunnel and captures its https URL.
#   5. Starts n8n with WEBHOOK_URL set to that tunnel, pinning a few settings so
#      the "default will change" deprecation warnings stay quiet.
#
# Usage:
#   npm run dev:tunnel                  # public tunnel (default)
#   npm run dev:tunnel -- --no-tunnel   # localhost only, no tunnel
#   WEBHOOK_URL=https://my.tunnel npm run dev:tunnel   # bring your own tunnel
#   N8N_PORT=5679 npm run dev:tunnel    # when 5678 is taken (e.g. by a Docker n8n)
#   N8N_VERSION=2.45.3 npm run dev:tunnel  # use a specific n8n version
#   N8N_REINSTALL=1 npm run dev:tunnel   # force a fresh n8n install (e.g. to pick up a newer latest)
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

PKG_NAME="$(node -p "require('./package.json').name")"
USER_FOLDER="${N8N_USER_FOLDER:-$HOME/.n8n-node-cli}"
CUSTOM_DIR="$USER_FOLDER/.n8n/custom/node_modules"
LINK_PATH="$CUSTOM_DIR/$PKG_NAME"
HOST=127.0.0.1
PORT="${N8N_PORT:-5678}"

WANT_TUNNEL=1
if [ "${1:-}" = "--no-tunnel" ]; then
	WANT_TUNNEL=0
fi

if lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
	echo "Port $PORT is already in use (another n8n?). Stop it or use N8N_PORT=5679 npm run dev:tunnel" >&2
	exit 1
fi

CF_PID=""
WATCH_PID=""
cleanup() {
	[ -n "$WATCH_PID" ] && kill "$WATCH_PID" 2>/dev/null || true
	[ -n "$CF_PID" ] && kill "$CF_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 1. Ensure the node is symlinked into n8n's custom folder.
# Remove a link left by an earlier, unscoped package name: n8n would load the
# nodes twice. Only links pointing at this repo are touched.
OLD_NAME="${PKG_NAME#*/}"
if [ "$OLD_NAME" != "$PKG_NAME" ] && [ -L "$CUSTOM_DIR/$OLD_NAME" ] \
	&& [ "$(readlink "$CUSTOM_DIR/$OLD_NAME")" = "$REPO_DIR" ]; then
	rm "$CUSTOM_DIR/$OLD_NAME"
	echo "Removed old link $CUSTOM_DIR/$OLD_NAME"
fi

# dirname handles scoped names (@scope/name).
mkdir -p "$(dirname "$LINK_PATH")"
if [ ! -e "$LINK_PATH" ]; then
	ln -s "$REPO_DIR" "$LINK_PATH"
	echo "Linked $PKG_NAME -> $LINK_PATH"
fi

# 2. Build once so dist/ has fresh JS + icons + codex.
echo "Building $PKG_NAME..."
npm run build

# 3. Recompile on change in the background.
npm run build:watch >/dev/null 2>&1 &
WATCH_PID=$!

# 4. Bring up a public tunnel (unless disabled or supplied via WEBHOOK_URL).
if [ "$WANT_TUNNEL" = "1" ] && [ -z "${WEBHOOK_URL:-}" ]; then
	if ! command -v cloudflared >/dev/null 2>&1; then
		echo "cloudflared not found. Install it with:  brew install cloudflared" >&2
		echo "Or bring your own tunnel:  WEBHOOK_URL=https://your.tunnel npm run dev:tunnel" >&2
		exit 1
	fi

	CF_LOG="$(mktemp -t servicenow-cf.XXXXXX)"
	echo "Starting Cloudflare tunnel to http://$HOST:$PORT ..."
	cloudflared tunnel --no-autoupdate --url "http://$HOST:$PORT" >"$CF_LOG" 2>&1 &
	CF_PID=$!

	TUNNEL_URL=""
	for _ in $(seq 1 60); do
		TUNNEL_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$CF_LOG" | head -1 || true)"
		[ -n "$TUNNEL_URL" ] && break
		sleep 1
	done

	if [ -z "$TUNNEL_URL" ]; then
		echo "Could not obtain a tunnel URL. cloudflared output:" >&2
		cat "$CF_LOG" >&2
		exit 1
	fi

	export WEBHOOK_URL="$TUNNEL_URL"
	echo "Tunnel URL: $WEBHOOK_URL  ->  http://localhost:$PORT"
fi

# 5. Pin current defaults (silences the deprecation warnings) and run n8n.
# Bind IPv4 loopback so the cloudflared origin (127.0.0.1) can reach n8n — by
# default n8n listens on IPv6 `::`, which the tunnel can't hit (Bad Gateway 502).
export N8N_LISTEN_ADDRESS="$HOST"
export N8N_PORT="$PORT"
export N8N_USER_FOLDER="$USER_FOLDER"
export N8N_DEV_RELOAD=true
export DB_SQLITE_POOL_SIZE=10
export N8N_UNVERIFIED_PACKAGES_ENABLED=true
export N8N_RUNNERS_TASK_TIMEOUT=300
export N8N_COMPRESSION_NODE_MAX_DECOMPRESSED_SIZE_BYTES=2147483648
export N8N_COMPRESSION_NODE_MAX_ZIP_ENTRIES=5000

if [ -n "${WEBHOOK_URL:-}" ]; then
	echo "n8n webhook base: $WEBHOOK_URL"
else
	echo "No tunnel — webhooks will use localhost (ServiceNow cannot call back into n8n)."
fi
echo "Editor: http://localhost:$PORT"
# n8n runs from its own install (not npx) so scripts/n8n-runtime/package.json
# "overrides" can pin around broken upstream dependency releases. The install
# lives OUTSIDE the repo: the repo is symlinked into n8n's custom folder, and
# n8n's hot reload reads everything under it — an n8n install inside the repo
# made it run out of memory.
N8N_VERSION="${N8N_VERSION:-latest}"
N8N_DIR="${N8N_RUNTIME_DIR:-$USER_FOLDER/runtime/$PKG_NAME}"
# Reuse the n8n install made under the earlier, unscoped package name.
if [ ! -d "$N8N_DIR" ] && [ -d "$USER_FOLDER/runtime/$OLD_NAME" ] && [ "$OLD_NAME" != "$PKG_NAME" ]; then
	mkdir -p "$(dirname "$N8N_DIR")"
	mv "$USER_FOLDER/runtime/$OLD_NAME" "$N8N_DIR"
fi
SPEC="$REPO_DIR/scripts/n8n-runtime/package.json"
# Written only after npm install exits cleanly: an interrupted install leaves
# n8n/package.json behind with other packages half-extracted.
MARKER="$N8N_DIR/node_modules/.dev-tunnel-installed"
WANT="$N8N_VERSION $(shasum "$SPEC" | cut -d' ' -f1)"

# Clean up the old in-repo install from earlier versions of this script.
if [ -d "$REPO_DIR/.n8n-dev" ]; then
	echo "Removing old in-repo n8n install (.n8n-dev) ..."
	rm -rf "$REPO_DIR/.n8n-dev"
fi

if [ "${N8N_REINSTALL:-}" = "1" ] || [ "$(cat "$MARKER" 2>/dev/null || true)" != "$WANT" ]; then
	echo "Installing n8n@$N8N_VERSION into $N8N_DIR (clean) ..."
	rm -rf "$N8N_DIR"
	mkdir -p "$N8N_DIR"
	cp "$SPEC" "$N8N_DIR/package.json"
	npm install --prefix "$N8N_DIR" --no-audit --no-fund --no-save "n8n@$N8N_VERSION"
	echo "$WANT" >"$MARKER"
fi
"$N8N_DIR/node_modules/.bin/n8n" start
