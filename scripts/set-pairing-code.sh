#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export DATA_DIR="${DATA_DIR:-$HOME/.local/share/lan-agent}"
if [[ ! -t 0 ]]; then echo '请在交互终端运行此脚本；自动部署请私下配置 PAIR_CODE 环境变量。' >&2; exit 1; fi
read -r -s -p '设置自定义配对码（12–256 个字符，建议随机短语）: ' code; printf '\n'
read -r -s -p '再次输入: ' confirm; printf '\n'
if [[ "$code" != "$confirm" ]]; then echo '两次输入不同，没有修改配对码。' >&2; exit 1; fi
printf '%s' "$code" | node "$HERE/bridge/src/pairing-code.js"
unset code confirm
