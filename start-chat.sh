#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js 20 or newer is required."
  exit 1
fi

if ! node scripts/check-runtime.mjs; then
  exit 1
fi

set -- $(node scripts/choose-port.mjs)
ACTION="$1"
PORT="$2"
if [ "$ACTION" = "ERROR" ]; then
  echo "[ERROR] No available local port was found."
  exit 1
fi
echo "[ModelBridge] Open http://127.0.0.1:${PORT}"
if [ "$ACTION" = "REUSE" ]; then
  echo "[ModelBridge] Current version is already running."
  exit 0
fi
export MODELBRIDGE_PORT="$PORT"
exec node server.mjs
