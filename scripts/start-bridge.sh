#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export AGENT_ROOT="${AGENT_ROOT:-$PWD}"
export DATA_DIR="${DATA_DIR:-$HOME/.local/share/lan-agent}"
export PORT="${PORT:-8787}"
if ! command -v node >/dev/null || ! command -v pi >/dev/null || ! command -v codex >/dev/null; then
  echo '需要 Node.js 22+、pi 和 codex。先在 WSL 登录 agent；参见 README。' >&2; exit 1
fi
if [[ ! -d "$HERE/bridge/node_modules" ]]; then (cd "$HERE/bridge" && npm ci --omit=dev --ignore-scripts); fi
exec node "$HERE/bridge/src/server.js"
