#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export AGENT_ROOT="${AGENT_ROOT:-$PWD}"
export DATA_DIR="${DATA_DIR:-$HOME/.local/share/lan-agent}"
export PORT="${PORT:-8787}"
if ! command -v node >/dev/null; then
  echo '需要 Node.js 22+。请先在 Linux 安装 Node.js。' >&2; exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  echo '需要 Node.js 22+，当前版本太旧。' >&2; exit 1
fi
# Either agent can be installed independently. The web UI reports missing CLIs.
# LAN_URL is optional: the service discovers a Linux IPv4 interface automatically.
if [[ ! -d "$HERE/bridge/node_modules" ]]; then (cd "$HERE/bridge" && npm ci --omit=dev --ignore-scripts); fi
exec node "$HERE/bridge/src/server.js"
