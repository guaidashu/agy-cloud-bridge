#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="${AGY_BRIDGE_HOME:-$HOME/.agy-bridge}"
LOG_DIR="$HOME_DIR/logs"
PID_FILE="$LOG_DIR/bridge.pid"
LOG_FILE="$LOG_DIR/bridge.log"

resolve_node() {
    if command -v node >/dev/null 2>&1; then
        command -v node
        return 0
    fi
    local nvm_root="${NVM_DIR:-$HOME/.nvm}"
    if [[ -d "$nvm_root/versions/node" ]] && command -v python3 >/dev/null 2>&1; then
        local found
        found="$(python3 - "$nvm_root/versions/node" <<'PY'
import glob, os, re, sys
base = sys.argv[1]
cands = glob.glob(os.path.join(base, '*', 'bin', 'node'))
def ver_key(p):
    d = os.path.basename(os.path.dirname(os.path.dirname(p)))
    return tuple(int(x) for x in re.findall(r'\d+', d))
for c in sorted(cands, key=ver_key, reverse=True):
    if os.path.isfile(c) and os.access(c, os.X_OK):
        print(c); sys.exit(0)
sys.exit(1)
PY
        )" && [[ -n "$found" ]] && { printf '%s\n' "$found"; return 0; }
    fi
    for cand in /opt/homebrew/bin/node /usr/local/bin/node; do
        if [[ -x "$cand" ]]; then
            printf '%s\n' "$cand"
            return 0
        fi
    done
    printf '错误：未找到 Node.js 可执行文件。\n' >&2
    return 1
}

read_port_from_config() {
    if [[ -n "${PORT:-}" ]]; then
        printf '%s\n' "$PORT"
        return 0
    fi
    if [[ -f "$HOME_DIR/config.json" ]] && command -v python3 >/dev/null 2>&1; then
        python3 - "$HOME_DIR/config.json" <<'PY'
import json, sys
try:
    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        d = json.load(f)
    print(int(d.get('server', {}).get('port', 3190)))
except Exception:
    print(3190)
PY
        return 0
    fi
    printf '3190\n'
}

NODE_BIN="$(resolve_node)"
BRIDGE_PORT="$(read_port_from_config)"

mkdir -p "$LOG_DIR"

if [[ -f "$PID_FILE" ]]; then
    old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
        printf '停止旧网关进程（PID %s）...\n' "$old_pid"
        kill -TERM "$old_pid" 2>/dev/null || true
        for _ in $(seq 1 25); do
            if ! kill -0 "$old_pid" 2>/dev/null; then
                break
            fi
            sleep 0.2
        done
        if kill -0 "$old_pid" 2>/dev/null; then
            kill -KILL "$old_pid" 2>/dev/null || true
            sleep 0.2
        fi
    fi
    rm -f "$PID_FILE"
fi

LSOF_BIN=""
if command -v lsof >/dev/null 2>&1; then
    LSOF_BIN="$(command -v lsof)"
elif [[ -x /usr/sbin/lsof ]]; then
    LSOF_BIN="/usr/sbin/lsof"
fi

if [[ -n "$LSOF_BIN" ]]; then
    listen_pids="$("$LSOF_BIN" -nP -tiTCP:"$BRIDGE_PORT" -sTCP:LISTEN 2>/dev/null || true)"
    for lpid in $listen_pids; do
        cmd_args="$(ps -p "$lpid" -o args= 2>/dev/null || true)"
        if [[ "$cmd_args" == *"$ROOT_DIR/src/cli.js"* ]]; then
            kill -TERM "$lpid" 2>/dev/null || true
            sleep 0.4
        else
            printf '错误：端口 %s 已被其他进程占用（PID %s: %s）。\n' "$BRIDGE_PORT" "$lpid" "$cmd_args" >&2
            exit 1
        fi
    done
fi

new_pid="$(python3 - "$NODE_BIN" "$ROOT_DIR" "$LOG_FILE" "$HOME_DIR" "$BRIDGE_PORT" <<'PY'
import os, subprocess, sys
node_bin, root_dir, log_file, home_dir, port = sys.argv[1:6]
env = os.environ.copy()
env['AGY_BRIDGE_HOME'] = home_dir
env['PORT'] = port
with open(log_file, 'ab') as log:
    proc = subprocess.Popen(
        [node_bin, os.path.join(root_dir, 'src', 'cli.js'), 'start'],
        cwd=root_dir,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
        close_fds=True,
    )
print(proc.pid)
PY
)"

echo "$new_pid" > "$PID_FILE"

ready=0
for _ in $(seq 1 25); do
    if ! kill -0 "$new_pid" 2>/dev/null; then
        printf '网关启动失败，请查看日志：%s\n' "$LOG_FILE" >&2
        rm -f "$PID_FILE"
        exit 1
    fi
    if curl -sSf "http://127.0.0.1:${BRIDGE_PORT}/api/v1/health" >/dev/null 2>&1; then
        ready=1
        break
    fi
    sleep 0.2
done

if [[ "$ready" -ne 1 ]]; then
    printf '网关健康检查超时，请查看日志：%s\n' "$LOG_FILE" >&2
    exit 1
fi

printf 'agy-cloud-bridge 协同网关已启动（PID %s）\n' "$new_pid"
printf '监听地址: http://127.0.0.1:%s\n' "$BRIDGE_PORT"
printf '日志文件: %s\n' "$LOG_FILE"
