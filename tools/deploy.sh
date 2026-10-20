#!/usr/bin/env bash
# Deploy the Enbrighten Tuya plugin into Homebridge.
#
# The plugin's files are installed as a SELF-CONTAINED copy in a dedicated,
# CI-controlled directory ($DEST_ROOT), kept out of Homebridge's apt install
# (/opt/homebridge) and out of its UI-managed plugin store. Because hb-service
# supports only ONE plugin directory (-P /var/lib/homebridge/node_modules under
# --strict-plugin-resolution, and source.sh pins UIX_CUSTOM_PLUGIN_PATH to it),
# the plugin is linked into that store with a single symlink: the files stay in
# $DEST_ROOT, only a pointer lives in the store.
#
# Used manually and by CI (Jenkins). Must run as root (writes under
# /var/lib/homebridge, owned by 'homebridge', and restarts the service).
#
#   sudo bash tools/deploy.sh [SOURCE_DIR]
#
# SOURCE_DIR defaults to the repo root containing this script.
set -euo pipefail
export PATH="/opt/homebridge/bin:$PATH"

NAME="homebridge-enbrighten-tuya"
NODE="/opt/homebridge/bin/node"
NPM="$NODE /opt/homebridge/lib/node_modules/npm/bin/npm-cli.js"
SRC="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
DEST_ROOT="/var/lib/homebridge/custom"
STORE="/var/lib/homebridge/node_modules"

[ -f "$SRC/package.json" ] || { echo "ERROR: no package.json in $SRC"; exit 1; }
[ -x "$NODE" ] || { echo "ERROR: $NODE missing"; exit 1; }
echo "[deploy] source: $SRC"

# 1) Build a self-contained copy from an npm pack tarball (respects .npmignore/
#    .gitignore, so .secrets/ and node_modules/ are excluded), then add prod deps.
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
TGZ="$($NPM pack "$SRC" --pack-destination "$TMP" --loglevel=error | tail -1)"
mkdir -p "$TMP/extract"
tar xzf "$TMP/$TGZ" -C "$TMP/extract" --strip-components=1
( cd "$TMP/extract" && $NPM install --omit=dev --no-audit --no-fund --loglevel=error )
VER="$($NODE -e "console.log(require('$TMP/extract/package.json').version)")"

# 2) Atomic-ish swap into the dedicated deploy dir, owned by homebridge.
install -d -o homebridge -g homebridge "$DEST_ROOT"
STAGE="$DEST_ROOT/.${NAME}.new.$$"
rm -rf "$STAGE"; mkdir -p "$STAGE"
cp -a "$TMP/extract/." "$STAGE/"
chown -R homebridge:homebridge "$STAGE"
rm -rf "$DEST_ROOT/.${NAME}.old"
[ -d "$DEST_ROOT/$NAME" ] && mv "$DEST_ROOT/$NAME" "$DEST_ROOT/.${NAME}.old"
mv "$STAGE" "$DEST_ROOT/$NAME"
echo "[deploy] installed $NAME@$VER -> $DEST_ROOT/$NAME"

# 3) Link it into Homebridge's single plugin path (idempotent). Relative target
#    so the files remain in the separate deploy dir, not copied into the store.
install -d -o homebridge -g homebridge "$STORE"
ln -sfn "../custom/$NAME" "$STORE/$NAME"
chown -h homebridge:homebridge "$STORE/$NAME"
echo "[deploy] linked $STORE/$NAME -> ../custom/$NAME"

# 4) Restart to load the new code.
systemctl restart homebridge
echo "[deploy] homebridge restarted; deployed from separate dir $DEST_ROOT"
