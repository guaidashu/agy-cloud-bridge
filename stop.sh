#!/usr/bin/env bash
set -euo pipefail

HOME_DIR="${AGY_BRIDGE_HOME:-$HOME/.agy-bridge}"
PID_FILE="$HOME_DIR/logs/bridge.pid"

if [[ ! -f "$PID_FILE" ]]; then
    printf '未找到运行中的网关 PID 文件（%s）。\n' "$PID_FILE"
    exit 0
fi

pid="$(cat "$PID_FILE" 2>/dev/null || true)"
if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    printf '正在停止 agy-cloud-bridge（PID %s）...\n' "$pid"
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 25); do
        if ! kill -0 "$pid" 2>/dev/null; then
            break
        fi
        sleep 0.2
    done
    if kill -0 "$pid" 2>/dev/null; then
        kill -KILL "$pid" 2>/dev/null || true
    fi
    printf '网关已停止。\n'
else
    printf '进程（PID %s）已不在运行。\n' "${pid:-未知}"
fi

rm -f "$PID_FILE"
