#!/usr/bin/env bash
# Launches the dockeru desktop app. Chromium's SUID sandbox helper must be
# root-owned with mode 4755; on plain npm installs it isn't, so fall back to
# --no-sandbox (the app only loads its own local UI). To restore the sandbox:
#   sudo chown root:root node_modules/electron/dist/chrome-sandbox
#   sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
set -e
cd "$(dirname "$0")/.."
SANDBOX=node_modules/electron/dist/chrome-sandbox
args=()
if [ ! -u "$SANDBOX" ] || [ "$(stat -c %u "$SANDBOX")" != 0 ]; then
  args+=(--no-sandbox)
fi
exec node_modules/electron/dist/electron "${args[@]}" . "$@"
