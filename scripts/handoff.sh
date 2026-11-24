#!/usr/bin/env bash
set -euo pipefail

# Universal zero-token, zero-env-var Cloud <-> Local Antigravity (agy) handoff client.
# Dual-runtime (python3 primary, node 18+ fallback).
# Auto-discovers `.agents/bridge.json` in current directory or git repo root.
# Supports:
#   - --channel http    : FRP HTTPS + Per-Project Scoped HMAC + long-poll wait + ACK cleanup
#   - --channel git-ref : Git plumbing (refs/heads/agy-collab/*) for air-gapped cloud sandboxes

CMD="${1:-}"
if [[ -z "$CMD" || "$CMD" == "-h" || "$CMD" == "--help" || "$CMD" == "help" ]]; then
    cat <<'EOF'
用法:
  handoff.sh health [--url <URL>] [--config <PATH>]
  handoff.sh dispatch [选项]

选项:
  --config <PATH>            指定 bridge.json 路径（默认自动查找 .agents/bridge.json）
  --channel <http|git-ref>   协同通道（默认读取 bridge.json 或 http）
  --url <URL>                网关地址（优先级：--url > $AGY_BRIDGE_URL > .agents/bridge.json）
  --secret-file <PATH>       密钥文件（优先级：--secret-file > $AGY_BRIDGE_SECRET > projectToken > ~/.agy-bridge/secret.env）
  --project <ID>             项目 ID（默认读取 .agents/bridge.json 或按 git remote 自动匹配）
  --repo-url <URL>           仓库远端 URL（默认读取 git remote get-url origin）
  --branch <BRANCH>          当前分支（默认读取 git rev-parse --abbrev-ref HEAD）
  --commit <SHA>             当前提交（默认读取 git rev-parse HEAD）
  --task <TEXT>              交办给本地的任务说明
  --task-file <PATH>         从文件读取任务说明
  --task-type <TYPE>         preview_and_test | debug_and_fix | deploy_restart | sync | custom_agent_task
  --mode <auto|agent|sync>   执行模式（默认：auto）
  --workflow <ID>            工作流 ID（同一 ID 多轮往返可续聊本地 agy）
  --handoff-id <ID>          指定幂等 ID（默认自动生成）
  --wait <SEC>               等待完成超时秒数，0 表示异步派发立即返回（默认读取 bridge.json 或 0）
  --poll-interval <SEC>      轮询间隔秒数（http 默认 2，git-ref 默认 8）
  --pull                     若本地推回了修复提交，自动执行 git pull --ff-only（多仓自动批量拉回）
  --ack                      读取完成后通知本地清理本次临时产物与协作分支
  --also-repo <DIR>          显式附加另一个同组本地/云端仓库目录参与多仓协同（可重复指定）
  --no-siblings              禁用自动扫描同级目录（../*/.agents/bridge.json）的同组仓库
  --allow-nested             允许在 AGY_BRIDGE_LOCAL_SESSION=1 下嵌套派发（默认禁止防递归）
  --force-local              允许在本机存在 .agy-local 标记或已登记目录内强制触发自测（默认本机直跑自动跳过）
  --json                     仅输出原始 JSON 结果
EOF
    exit 0
fi
shift

CONFIG_PATH=""
BRIDGE_URL=""
SECRET_FILE=""
CHANNEL=""
PROJECT_ID=""
REPO_URL=""
BRANCH=""
COMMIT_SHA=""
TASK_TEXT=""
TASK_FILE=""
TASK_TYPE="custom_agent_task"
MODE="auto"
WORKFLOW_ID=""
HANDOFF_ID=""
WAIT_SEC=""
POLL_INTERVAL=""
DO_PULL="0"
DO_ACK="0"
ALLOW_NESTED="0"
FORCE_LOCAL="0"
OUT_JSON="0"
ALSO_REPOS=""
NO_SIBLINGS="0"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --config) CONFIG_PATH="$2"; shift 2 ;;
        --channel) CHANNEL="$2"; shift 2 ;;
        --url) BRIDGE_URL="$2"; shift 2 ;;
        --secret-file) SECRET_FILE="$2"; shift 2 ;;
        --project) PROJECT_ID="$2"; shift 2 ;;
        --repo-url) REPO_URL="$2"; shift 2 ;;
        --branch) BRANCH="$2"; shift 2 ;;
        --commit) COMMIT_SHA="$2"; shift 2 ;;
        --task) TASK_TEXT="$2"; shift 2 ;;
        --task-file) TASK_FILE="$2"; shift 2 ;;
        --task-type) TASK_TYPE="$2"; shift 2 ;;
        --mode) MODE="$2"; shift 2 ;;
        --workflow) WORKFLOW_ID="$2"; shift 2 ;;
        --handoff-id) HANDOFF_ID="$2"; shift 2 ;;
        --wait) WAIT_SEC="$2"; shift 2 ;;
        --poll-interval) POLL_INTERVAL="$2"; shift 2 ;;
        --pull) DO_PULL="1"; shift ;;
        --ack) DO_ACK="1"; shift ;;
        --also-repo) ALSO_REPOS="${ALSO_REPOS:+$ALSO_REPOS$'\n'}$2"; shift 2 ;;
        --no-siblings) NO_SIBLINGS="1"; shift ;;
        --allow-nested) ALLOW_NESTED="1"; shift ;;
        --force-local) FORCE_LOCAL="1"; shift ;;
        --json) OUT_JSON="1"; shift ;;
        *)
            printf '错误：未知参数 %s\n' "$1" >&2
            exit 1
            ;;
    esac
done

if [[ -n "$TASK_FILE" ]]; then
    TASK_TEXT="$(cat "$TASK_FILE")"
fi

if [[ -z "$REPO_URL" ]] && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    REPO_URL="$(git remote get-url origin 2>/dev/null || true)"
fi
if [[ -z "$BRANCH" ]] && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
fi
if [[ -z "$COMMIT_SHA" ]] && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    COMMIT_SHA="$(git rev-parse HEAD 2>/dev/null || true)"
fi

export AGY_HANDOFF_ALSO_REPOS="$ALSO_REPOS"
export AGY_HANDOFF_NO_SIBLINGS="$NO_SIBLINGS"

RUNTIME="${AGY_HANDOFF_RUNTIME:-auto}"
if [[ "$RUNTIME" == "auto" ]]; then
    if command -v python3 >/dev/null 2>&1; then
        RUNTIME="python3"
    elif command -v node >/dev/null 2>&1; then
        RUNTIME="node"
    else
        printf '错误：handoff.sh 需要 python3 或 node（v18+）。\n' >&2
        exit 1
    fi
fi

if [[ "$RUNTIME" == "python3" ]]; then
exec python3 - "$CMD" "$CONFIG_PATH" "$CHANNEL" "$BRIDGE_URL" "$SECRET_FILE" "$PROJECT_ID" "$REPO_URL" "$BRANCH" "$COMMIT_SHA" "$TASK_TEXT" "$TASK_TYPE" "$MODE" "$WORKFLOW_ID" "$HANDOFF_ID" "$WAIT_SEC" "$POLL_INTERVAL" "$DO_PULL" "$DO_ACK" "$ALLOW_NESTED" "$FORCE_LOCAL" "$OUT_JSON" <<'PY'
import hashlib
import hmac
import json
import os
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request

(
    cmd,
    config_path_arg,
    channel_arg,
    bridge_url_arg,
    secret_file_arg,
    project_id_arg,
    repo_url,
    branch,
    commit_sha,
    task_text,
    task_type,
    mode,
    workflow_id,
    handoff_id,
    wait_sec_arg,
    poll_interval_raw,
    do_pull_raw,
    do_ack_raw,
    allow_nested_raw,
    force_local_raw,
    out_json_raw,
) = sys.argv[1:22]

do_pull = do_pull_raw == "1"
do_ack = do_ack_raw == "1"
allow_nested = allow_nested_raw == "1"
force_local = force_local_raw == "1"
out_json = out_json_raw == "1"

TERMINAL = {"succeeded", "fast_synced", "failed", "blocked", "cancelled"}


def git_toplevel():
    try:
        top = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        return os.path.realpath(top) if top else ""
    except Exception:
        return ""


def load_bridge_config():
    candidates = []
    if config_path_arg:
        candidates.append(config_path_arg)
    else:
        candidates.append(os.path.join(os.getcwd(), ".agents", "bridge.json"))
        top = git_toplevel()
        if top:
            candidates.append(os.path.join(top, ".agents", "bridge.json"))

    for cand in candidates:
        if cand and os.path.isfile(cand):
            with open(cand, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return data
    if config_path_arg:
        raise RuntimeError(f"指定的 bridge.json 不存在：{config_path_arg}")
    return {}


def normalize_marker_rel(marker_rel):
    cleaned = str(marker_rel or ".agy-local").strip().replace("\\", "/").lstrip("/")
    while cleaned.startswith("./"):
        cleaned = cleaned[2:]
    cleaned = cleaned.strip("/")
    if not cleaned or cleaned == ".":
        cleaned = ".agy-local"
    parts = [p for p in cleaned.split("/") if p]
    if ".." in parts:
        return ""
    return "/".join(parts)


def has_local_marker(marker_rel):
    rel = normalize_marker_rel(marker_rel)
    if not rel:
        return False
    roots = []
    for candidate in (git_toplevel(), os.path.realpath(os.getcwd())):
        if candidate and candidate not in roots:
            roots.append(candidate)
    for root in roots:
        if os.path.exists(os.path.join(root, *rel.split("/"))):
            return True
    return False


def is_running_on_registered_local_host():
    bridge_home = os.path.expanduser(os.environ.get("AGY_BRIDGE_HOME") or "~/.agy-bridge")
    local_cfg_path = os.path.join(bridge_home, "config.json")
    if not os.path.isfile(local_cfg_path):
        return False
    cur_root = git_toplevel() or os.path.realpath(os.getcwd())
    if not cur_root:
        return False
    try:
        with open(local_cfg_path, "r", encoding="utf-8") as f:
            local_cfg = json.load(f)
        for p in local_cfg.get("projects") or []:
            rp = p.get("repoPath") or ""
            if rp and os.path.realpath(os.path.expanduser(rp)) == cur_root:
                return True
    except Exception:
        return False
    return False


bridge_cfg = load_bridge_config()

bridge_url = (
    bridge_url_arg.strip()
    or os.environ.get("AGY_BRIDGE_URL", "").strip()
    or str(bridge_cfg.get("bridgeUrl", "")).strip()
)
project_id = project_id_arg.strip() or str(bridge_cfg.get("projectId", "")).strip()
channel = channel_arg.strip() or str(bridge_cfg.get("defaultChannel", "")).strip() or "http"
if wait_sec_arg.strip():
    wait_sec = max(0, int(wait_sec_arg.strip()))
elif bridge_cfg.get("defaultWaitSec") is not None:
    wait_sec = max(0, int(bridge_cfg.get("defaultWaitSec")))
else:
    wait_sec = 0

def open_http(req, timeout):
    proxy_env = (
        os.environ.get("HTTPS_PROXY")
        or os.environ.get("https_proxy")
        or os.environ.get("HTTP_PROXY")
        or os.environ.get("http_proxy")
        or ""
    )
    direct_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    env_opener = urllib.request.build_opener()

    prefer_direct = "127.0.0.1:7900" in proxy_env or "localhost" in bridge_url or "127.0.0.1" in bridge_url or not proxy_env
    first, second = (direct_opener, env_opener) if prefer_direct else (env_opener, direct_opener)

    try:
        return first.open(req, timeout=timeout)
    except urllib.error.HTTPError:
        raise
    except urllib.error.URLError:
        if not proxy_env:
            raise
        return second.open(req, timeout=timeout)


if cmd == "health":
    if not bridge_url:
        print("错误：请通过 --url、AGY_BRIDGE_URL 或 .agents/bridge.json 指定网关地址。", file=sys.stderr)
        sys.exit(1)
    req = urllib.request.Request(bridge_url.rstrip("/") + "/api/v1/health", method="GET")
    try:
        with open_http(req, timeout=15) as resp:
            print(resp.read().decode("utf-8"))
        sys.exit(0)
    except Exception as e:
        print(f"错误：健康检查失败：{e}", file=sys.stderr)
        sys.exit(1)

if cmd != "dispatch":
    print(f"错误：未知命令 {cmd}（支持 health | dispatch）", file=sys.stderr)
    sys.exit(1)

# 防递归 & 本机自调用保护
local_marker = normalize_marker_rel(bridge_cfg.get("localMarkerFile") or ".agy-local")

if os.environ.get("AGY_BRIDGE_LOCAL_SESSION") == "1" and not allow_nested:
    skip_payload = {
        "handoffId": handoff_id or "skipped",
        "projectId": project_id,
        "status": "skipped_nested_local_session",
        "phase": "anti_recursion_guard",
        "summary": "当前正处于本地 agy 协同会话（AGY_BRIDGE_LOCAL_SESSION=1），已自动跳过嵌套派发以防无限递归。",
    }
    print(json.dumps(skip_payload, ensure_ascii=False, indent=2) if out_json else skip_payload["summary"])
    sys.exit(0)

if not force_local and not allow_nested:
    if local_marker and has_local_marker(local_marker):
        skip_payload = {
            "handoffId": handoff_id or "skipped",
            "projectId": project_id,
            "status": "skipped_local_marker_present",
            "phase": "local_marker_guard",
            "localMarkerFile": local_marker,
            "summary": f"检测到项目存在本地标记文件（{local_marker}），判定为本地环境，已自动跳过云端派发（如需本机强制自测请传 --force-local）。",
        }
        print(json.dumps(skip_payload, ensure_ascii=False, indent=2) if out_json else skip_payload["summary"])
        sys.exit(0)
    if is_running_on_registered_local_host():
        skip_payload = {
            "handoffId": handoff_id or "skipped",
            "projectId": project_id,
            "status": "skipped_already_on_local_host",
            "phase": "local_host_guard",
            "summary": "检测到当前直接运行在本机已登记仓库内，无需再经公网回环调用本地网关（如需强制自测请传 --force-local）。",
        }
        print(json.dumps(skip_payload, ensure_ascii=False, indent=2) if out_json else skip_payload["summary"])
        sys.exit(0)

if not handoff_id:
    handoff_id = f"ho-{int(time.time())}-{secrets.token_hex(3)}"
if not workflow_id:
    workflow_id = handoff_id


def parse_env_secret(path):
    if not path or not os.path.isfile(path):
        return ""
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            if s.startswith("export "):
                s = s[7:].strip()
            if s.startswith("AGY_BRIDGE_SECRET="):
                val = s.split("=", 1)[1].strip().strip('"').strip("'")
                if val:
                    return val
    return ""


def load_secret():
    if secret_file_arg:
        s = parse_env_secret(secret_file_arg)
        if s:
            return s
        raise RuntimeError(f"密钥文件中未找到 AGY_BRIDGE_SECRET：{secret_file_arg}")
    env_val = os.environ.get("AGY_BRIDGE_SECRET", "").strip()
    if env_val:
        return env_val
    proj_tok = str(bridge_cfg.get("projectToken", "")).strip()
    if proj_tok:
        return proj_tok
    local_env = parse_env_secret(os.path.expanduser("~/.agy-bridge/secret.env"))
    if local_env:
        return local_env
    return ""


def signed_request(method, path_with_query, body_obj=None, timeout=30):
    secret = load_secret()
    if not secret:
        raise RuntimeError("未找到鉴权密钥（请检查 .agents/bridge.json 的 projectToken 或 AGY_BRIDGE_SECRET）")
    base = bridge_url.rstrip("/")
    if not base:
        raise RuntimeError("未指定网关地址（请检查 .agents/bridge.json 的 bridgeUrl 或 --url）")
    raw_body = json.dumps(body_obj, ensure_ascii=False) if body_obj is not None else ""
    ts = str(int(time.time()))
    nonce = secrets.token_hex(12)
    body_hash = hashlib.sha256(raw_body.encode("utf-8")).hexdigest()
    canonical = f"{method.upper()}\n{path_with_query}\n{ts}\n{nonce}\n{body_hash}"
    sig = "sha256=" + hmac.new(secret.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest()

    headers = {
        "X-Bridge-Timestamp": ts,
        "X-Bridge-Nonce": nonce,
        "X-Bridge-Signature": sig,
    }
    if project_id:
        headers["X-Bridge-Project"] = project_id

    data = None
    if body_obj is not None:
        headers["Content-Type"] = "application/json; charset=utf-8"
        data = raw_body.encode("utf-8")

    req = urllib.request.Request(base + path_with_query, data=data, headers=headers, method=method.upper())
    try:
        with open_http(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_text = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} {path_with_query}: {err_text}")


def run_git(args, stdin_text=None):
    res = subprocess.run(
        ["git"] + args,
        input=stdin_text,
        text=True,
        capture_output=True,
        check=True,
    )
    return res.stdout


def publish_git_ref(ref_name, filename, payload):
    txt = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    blob_sha = run_git(["hash-object", "-w", "--stdin"], stdin_text=txt).strip()
    tree_sha = run_git(["mktree"], stdin_text=f"100644 blob {blob_sha}\t{filename}\n").strip()
    commit_sha_out = run_git(["commit-tree", tree_sha, "-m", f"agy-collab: {ref_name}"], stdin_text="").strip()
    run_git(["push", "-f", "origin", f"{commit_sha_out}:refs/heads/{ref_name}"])


def delete_git_ref(ref_name):
    subprocess.run(["git", "push", "origin", f":refs/heads/{ref_name}"], capture_output=True, text=True)


def discover_peer_targets():
    cur_top = git_toplevel()
    group_name = str(bridge_cfg.get("group") or "").strip()
    no_sibs = os.environ.get("AGY_HANDOFF_NO_SIBLINGS") == "1"
    also_raw = [p.strip() for p in (os.environ.get("AGY_HANDOFF_ALSO_REPOS") or "").splitlines() if p.strip()]
    cand_dirs = []
    for d in also_raw:
        rp = os.path.realpath(os.path.expanduser(d))
        if os.path.isdir(rp) and rp not in cand_dirs:
            cand_dirs.append(rp)
    if group_name and not no_sibs and cur_top:
        parent = os.path.dirname(cur_top)
        try:
            for name in sorted(os.listdir(parent)):
                sub = os.path.realpath(os.path.join(parent, name))
                if sub != cur_top and os.path.isdir(sub) and sub not in cand_dirs:
                    cand_dirs.append(sub)
        except Exception:
            pass

    targets = []
    dir_map = {}
    if cur_top and project_id:
        dir_map[project_id] = (cur_top, branch or "main")

    for d in cand_dirs:
        bj_path = os.path.join(d, ".agents", "bridge.json")
        is_explicit = d in [os.path.realpath(os.path.expanduser(x)) for x in also_raw]
        peer_cfg = {}
        if os.path.isfile(bj_path):
            try:
                with open(bj_path, "r", encoding="utf-8") as f:
                    peer_cfg = json.load(f) or {}
            except Exception:
                peer_cfg = {}
        if not is_explicit:
            if not peer_cfg or str(peer_cfg.get("group") or "").strip() != group_name:
                continue
            peer_url = str(peer_cfg.get("bridgeUrl") or "").strip().rstrip("/")
            if peer_url and bridge_url and peer_url != bridge_url.rstrip("/"):
                continue
        try:
            inside = subprocess.run(["git", "-C", d, "rev-parse", "--is-inside-work-tree"], capture_output=True, text=True, check=True).stdout.strip()
            if inside != "true":
                continue
            p_remote = subprocess.run(["git", "-C", d, "remote", "get-url", "origin"], capture_output=True, text=True).stdout.strip()
            p_branch = subprocess.run(["git", "-C", d, "rev-parse", "--abbrev-ref", "HEAD"], capture_output=True, text=True).stdout.strip() or "main"
            p_commit = subprocess.run(["git", "-C", d, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        except Exception:
            continue
        p_id = str(peer_cfg.get("projectId") or "").strip()
        if p_id and p_id == project_id:
            continue
        targets.append({
            "projectId": p_id,
            "repoUrl": p_remote,
            "branch": p_branch,
            "commit": p_commit,
        })
        if p_id:
            dir_map[p_id] = (d, p_branch)
    return targets, dir_map


peer_targets, repo_dir_map = discover_peer_targets()


def maybe_pull_fix(rec):
    if not do_pull:
        return
    pushed_map = rec.get("pushedCommits") if isinstance(rec.get("pushedCommits"), dict) else {}
    if pushed_map:
        for pid, sha in pushed_map.items():
            if not sha:
                continue
            entry = repo_dir_map.get(pid)
            if entry:
                d, br = entry
                res = subprocess.run(["git", "-C", d, "pull", "--ff-only", "origin", br], capture_output=True, text=True, check=True)
                if not out_json and res.stdout.strip():
                    print(f"[{pid}] {res.stdout.strip()}", file=sys.stderr)
        return
    pushed = (rec.get("pushedCommit") or "").strip()
    if pushed:
        res = subprocess.run(["git", "pull", "--ff-only", "origin", branch], capture_output=True, text=True, check=True)
        if not out_json and res.stdout.strip():
            print(res.stdout.strip(), file=sys.stderr)


def record_cloud_gate_stamp():
    try:
        gate_dir = "/tmp/agy-cloud-gate"
        os.makedirs(gate_dir, exist_ok=True)
        seen_dirs = []
        top = git_toplevel()
        if top:
            seen_dirs.append(top)
        for d, _br in repo_dir_map.values():
            rd = os.path.realpath(d)
            if rd not in seen_dirs:
                seen_dirs.append(rd)
        for rd in seen_dirs:
            res = subprocess.run(["git", "-C", rd, "rev-parse", "HEAD"], capture_output=True, text=True)
            if res.returncode == 0 and res.stdout.strip():
                rhash = hashlib.sha256(rd.encode("utf-8")).hexdigest()[:16]
                with open(os.path.join(gate_dir, f"attempted-{rhash}"), "w", encoding="utf-8") as f:
                    f.write(res.stdout.strip() + "\n")
    except Exception:
        pass


def print_output_and_exit(rec):
    if rec.get("status") in TERMINAL:
        record_cloud_gate_stamp()
    if out_json:
        print(json.dumps(rec, ensure_ascii=False, indent=2))
    else:
        print(f"handoffId: {rec.get('handoffId')}")
        print(f"status:    {rec.get('status')} (phase={rec.get('phase')})")
        print(f"project:   {rec.get('projectId')} @ {rec.get('branch')}")
        if rec.get("changedProjects"):
            print(f"changedProjects: {', '.join(rec.get('changedProjects'))}")
        if rec.get("pushedCommits"):
            print(f"pushedCommits:   {json.dumps(rec.get('pushedCommits'), ensure_ascii=False)}")
        elif rec.get("pushedCommit"):
            print(f"pushedCommit: {rec.get('pushedCommit')}")
        if rec.get("summary"):
            print(f"summary:\n{rec.get('summary')}")
        if rec.get("error"):
            print(f"error:     {rec.get('error')}")

    st = rec.get("status")
    if st in ("succeeded", "fast_synced"):
        sys.exit(0)
    if st == "blocked":
        sys.exit(2)
    if st in ("queued", "running") and wait_sec == 0:
        sys.exit(0)
    sys.exit(1)


payload = {
    "handoffId": handoff_id,
    "workflowId": workflow_id,
    "projectId": project_id,
    "repoUrl": repo_url,
    "branch": branch,
    "commit": commit_sha,
    "task": task_text,
    "taskType": task_type,
    "mode": mode,
    "resultChannel": channel,
}
if peer_targets:
    payload["targets"] = peer_targets

if channel == "git-ref":
    req_ref = f"agy-collab/req-{handoff_id}"
    res_ref = f"agy-collab/res-{handoff_id}"
    publish_git_ref(req_ref, "request.json", payload)

    if wait_sec == 0:
        print_output_and_exit({"handoffId": handoff_id, "status": "queued", "phase": "git_ref_pushed", "reqRef": req_ref})

    poll_interval = max(2, int(poll_interval_raw or "8"))
    deadline = time.time() + wait_sec
    result_rec = None
    while time.time() < deadline:
        ls_out = run_git(["ls-remote", "--heads", "origin", res_ref]).strip()
        if ls_out:
            run_git(["fetch", "origin", f"refs/heads/{res_ref}"])
            fetch_sha = run_git(["rev-parse", "FETCH_HEAD"]).strip()
            raw = run_git(["show", f"{fetch_sha}:result.json"])
            result_rec = json.loads(raw)
            break
        remaining = deadline - time.time()
        if remaining <= 0:
            break
        time.sleep(min(poll_interval, max(1, int(remaining))))

    if result_rec is None:
        result_rec = {
            "handoffId": handoff_id,
            "projectId": project_id,
            "branch": branch,
            "status": "timeout",
            "phase": "wait_timeout",
            "error": f"等待本地处理超时（>{wait_sec}s）",
        }
    else:
        maybe_pull_fix(result_rec)
        if do_ack:
            delete_git_ref(req_ref)
            delete_git_ref(res_ref)

    print_output_and_exit(result_rec)

# HTTP channel (FRP HTTPS)
poll_interval = max(1, int(poll_interval_raw or "2"))
_, dispatch_res = signed_request("POST", "/api/v1/handoffs", payload, timeout=30)
rec = dispatch_res.get("handoff") or {}

if wait_sec == 0:
    print_output_and_exit(rec)

deadline = time.time() + wait_sec
while rec.get("status") not in TERMINAL:
    remaining = int(deadline - time.time())
    if remaining <= 0:
        rec["status"] = "timeout"
        rec["phase"] = "wait_timeout"
        rec["error"] = f"等待本地处理超时（>{wait_sec}s）"
        break
    chunk_timeout = max(5, min(remaining, 120))
    _, wait_res = signed_request(
        "GET",
        f"/api/v1/handoffs/{handoff_id}/wait?timeout={chunk_timeout}",
        body_obj=None,
        timeout=chunk_timeout + 15,
    )
    rec = wait_res.get("handoff") or rec
    if rec.get("status") in TERMINAL:
        break
    if time.time() < deadline:
        time.sleep(min(poll_interval, max(1, int(deadline - time.time()))))

if rec.get("status") in TERMINAL:
    maybe_pull_fix(rec)
    if do_ack:
        signed_request("POST", f"/api/v1/handoffs/{handoff_id}/ack", {}, timeout=30)

print_output_and_exit(rec)
PY
fi

# Node.js fallback runtime (when python3 is unavailable in cloud container)
exec node --input-type=module - "$CMD" "$CONFIG_PATH" "$CHANNEL" "$BRIDGE_URL" "$SECRET_FILE" "$PROJECT_ID" "$REPO_URL" "$BRANCH" "$COMMIT_SHA" "$TASK_TEXT" "$TASK_TYPE" "$MODE" "$WORKFLOW_ID" "$HANDOFF_ID" "$WAIT_SEC" "$POLL_INTERVAL" "$DO_PULL" "$DO_ACK" "$ALLOW_NESTED" "$FORCE_LOCAL" "$OUT_JSON" <<'JS'
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv[1] === "-" ? process.argv.slice(2) : process.argv.slice(1);
const [
  cmd,
  configPathArg,
  channelArg,
  bridgeUrlArg,
  secretFileArg,
  projectIdArg,
  repoUrl,
  branch,
  commitSha,
  taskText,
  taskType,
  mode,
  workflowIdArg,
  handoffIdArg,
  waitSecArg,
  pollIntervalRaw,
  doPullRaw,
  doAckRaw,
  allowNestedRaw,
  forceLocalRaw,
  outJsonRaw,
] = args;

const doPull = doPullRaw === "1";
const doAck = doAckRaw === "1";
const allowNested = allowNestedRaw === "1";
const forceLocal = forceLocalRaw === "1";
const outJson = outJsonRaw === "1";
const TERMINAL = new Set(["succeeded", "fast_synced", "failed", "blocked", "cancelled"]);

function gitToplevel() {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out ? fs.realpathSync(out) : "";
  } catch {
    return "";
  }
}

function loadBridgeConfig() {
  const cands = [];
  if (configPathArg) cands.push(configPathArg);
  else {
    cands.push(path.join(process.cwd(), ".agents", "bridge.json"));
    const top = gitToplevel();
    if (top) cands.push(path.join(top, ".agents", "bridge.json"));
  }
  for (const c of cands) {
    if (c && fs.existsSync(c)) {
      const data = JSON.parse(fs.readFileSync(c, "utf8"));
      if (data && typeof data === "object") return data;
    }
  }
  if (configPathArg) throw new Error(`指定的 bridge.json 不存在：${configPathArg}`);
  return {};
}

function expandHome(p) {
  if (!p) return "";
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function normalizeMarkerRel(markerRel) {
  let cleaned = String(markerRel || ".agy-local").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  while (cleaned.startsWith("./")) cleaned = cleaned.slice(2);
  cleaned = cleaned.replace(/^\/+|\/+$/g, "");
  if (!cleaned || cleaned === ".") cleaned = ".agy-local";
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.includes("..")) return "";
  return parts.join("/");
}

function hasLocalMarker(markerRel) {
  const rel = normalizeMarkerRel(markerRel);
  if (!rel) return false;
  const roots = [];
  let cwdReal = "";
  try { cwdReal = fs.realpathSync(process.cwd()); } catch { cwdReal = ""; }
  for (const cand of [gitToplevel(), cwdReal]) {
    if (cand && !roots.includes(cand)) roots.push(cand);
  }
  for (const root of roots) {
    if (fs.existsSync(path.join(root, ...rel.split("/")))) return true;
  }
  return false;
}

function isRunningOnRegisteredLocalHost() {
  const homeDir = expandHome(process.env.AGY_BRIDGE_HOME || "~/.agy-bridge");
  const cfgPath = path.join(homeDir, "config.json");
  if (!fs.existsSync(cfgPath)) return false;
  let curRoot = gitToplevel();
  if (!curRoot) {
    try { curRoot = fs.realpathSync(process.cwd()); } catch { return false; }
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    for (const p of cfg.projects || []) {
      const rp = p?.repoPath ? expandHome(p.repoPath) : "";
      if (rp && fs.existsSync(rp) && fs.realpathSync(rp) === curRoot) return true;
    }
  } catch {
    return false;
  }
  return false;
}

const bridgeCfg = loadBridgeConfig();
const bridgeUrl = (bridgeUrlArg || process.env.AGY_BRIDGE_URL || bridgeCfg.bridgeUrl || "").trim();
const projectId = (projectIdArg || bridgeCfg.projectId || "").trim();
const channel = (channelArg || bridgeCfg.defaultChannel || "http").trim();
const waitSec = waitSecArg.trim()
  ? Math.max(0, Number.parseInt(waitSecArg.trim(), 10) || 0)
  : bridgeCfg.defaultWaitSec != null
    ? Math.max(0, Number(bridgeCfg.defaultWaitSec) || 0)
    : 0;

if (cmd === "health") {
  if (!bridgeUrl) {
    console.error("错误：请通过 --url、AGY_BRIDGE_URL 或 .agents/bridge.json 指定网关地址。");
    process.exit(1);
  }
  const resp = await fetch(`${bridgeUrl.replace(/\/+$/, "")}/api/v1/health`, { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) {
    console.error(`错误：健康检查失败 HTTP ${resp.status}`);
    process.exit(1);
  }
  console.log(await resp.text());
  process.exit(0);
}

if (cmd !== "dispatch") {
  console.error(`错误：未知命令 ${cmd}（支持 health | dispatch）`);
  process.exit(1);
}

const localMarker = normalizeMarkerRel(bridgeCfg.localMarkerFile || ".agy-local");

if (process.env.AGY_BRIDGE_LOCAL_SESSION === "1" && !allowNested) {
  const skip = {
    handoffId: handoffIdArg || "skipped",
    projectId,
    status: "skipped_nested_local_session",
    phase: "anti_recursion_guard",
    summary: "当前正处于本地 agy 协同会话（AGY_BRIDGE_LOCAL_SESSION=1），已自动跳过嵌套派发以防无限递归。",
  };
  console.log(outJson ? JSON.stringify(skip, null, 2) : skip.summary);
  process.exit(0);
}

if (!forceLocal && !allowNested) {
  if (localMarker && hasLocalMarker(localMarker)) {
    const skip = {
      handoffId: handoffIdArg || "skipped",
      projectId,
      status: "skipped_local_marker_present",
      phase: "local_marker_guard",
      localMarkerFile: localMarker,
      summary: `检测到项目存在本地标记文件（${localMarker}），判定为本地环境，已自动跳过云端派发（如需本机强制自测请传 --force-local）。`,
    };
    console.log(outJson ? JSON.stringify(skip, null, 2) : skip.summary);
    process.exit(0);
  }
  if (isRunningOnRegisteredLocalHost()) {
    const skip = {
      handoffId: handoffIdArg || "skipped",
      projectId,
      status: "skipped_already_on_local_host",
      phase: "local_host_guard",
      summary: "检测到当前直接运行在本机已登记仓库内，无需再经公网回环调用本地网关（如需强制自测请传 --force-local）。",
    };
    console.log(outJson ? JSON.stringify(skip, null, 2) : skip.summary);
    process.exit(0);
  }
}

const handoffId = handoffIdArg || `ho-${Math.floor(Date.now() / 1000)}-${crypto.randomBytes(3).toString("hex")}`;
const workflowId = workflowIdArg || handoffId;

function parseEnvSecret(file) {
  if (!file || !fs.existsSync(file)) return "";
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    let s = line.trim();
    if (!s || s.startsWith("#")) continue;
    if (s.startsWith("export ")) s = s.slice(7).trim();
    if (s.startsWith("AGY_BRIDGE_SECRET=")) {
      const v = s.slice("AGY_BRIDGE_SECRET=".length).trim().replace(/^["']|["']$/g, "");
      if (v) return v;
    }
  }
  return "";
}

function loadSecret() {
  if (secretFileArg) {
    const s = parseEnvSecret(secretFileArg);
    if (!s) throw new Error(`密钥文件中未找到 AGY_BRIDGE_SECRET：${secretFileArg}`);
    return s;
  }
  if (process.env.AGY_BRIDGE_SECRET?.trim()) return process.env.AGY_BRIDGE_SECRET.trim();
  if (String(bridgeCfg.projectToken || "").trim()) return String(bridgeCfg.projectToken).trim();
  return parseEnvSecret(path.join(os.homedir(), ".agy-bridge", "secret.env"));
}

async function signedRequest(method, pathWithQuery, bodyObj = null, timeoutMs = 30000) {
  const secret = loadSecret();
  if (!secret) throw new Error("未找到鉴权密钥");
  if (!bridgeUrl) throw new Error("未指定网关地址");
  const rawBody = bodyObj !== null ? JSON.stringify(bodyObj) : "";
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(12).toString("hex");
  const bodyHash = crypto.createHash("sha256").update(rawBody, "utf8").digest("hex");
  const canonical = `${method.toUpperCase()}\n${pathWithQuery}\n${ts}\n${nonce}\n${bodyHash}`;
  const sig = `sha256=${crypto.createHmac("sha256", secret).update(canonical, "utf8").digest("hex")}`;
  const headers = {
    "X-Bridge-Timestamp": ts,
    "X-Bridge-Nonce": nonce,
    "X-Bridge-Signature": sig,
  };
  if (projectId) headers["X-Bridge-Project"] = projectId;
  if (bodyObj !== null) headers["Content-Type"] = "application/json; charset=utf-8";
  const resp = await fetch(`${bridgeUrl.replace(/\/+$/, "")}${pathWithQuery}`, {
    method: method.toUpperCase(),
    headers,
    body: bodyObj !== null ? rawBody : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${pathWithQuery}: ${text}`);
  return JSON.parse(text);
}

function discoverPeerTargets() {
  const curTop = gitToplevel();
  const groupName = String(bridgeCfg.group || "").trim();
  const noSibs = process.env.AGY_HANDOFF_NO_SIBLINGS === "1";
  const alsoRaw = String(process.env.AGY_HANDOFF_ALSO_REPOS || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const candDirs = [];
  const explicitSet = new Set();
  for (const d of alsoRaw) {
    try {
      const rp = fs.realpathSync(expandHome(d));
      explicitSet.add(rp);
      if (!candDirs.includes(rp)) candDirs.push(rp);
    } catch {
      /* ignore */
    }
  }
  if (groupName && !noSibs && curTop) {
    const parent = path.dirname(curTop);
    try {
      for (const name of fs.readdirSync(parent).sort()) {
        const sub = fs.realpathSync(path.join(parent, name));
        if (sub !== curTop && fs.statSync(sub).isDirectory() && !candDirs.includes(sub)) {
          candDirs.push(sub);
        }
      }
    } catch {
      /* ignore */
    }
  }

  const targets = [];
  const dirMap = new Map();
  if (curTop && projectId) dirMap.set(projectId, { dir: curTop, branch: branch || "main" });

  for (const d of candDirs) {
    const bjPath = path.join(d, ".agents", "bridge.json");
    let peerCfg = {};
    if (fs.existsSync(bjPath)) {
      try {
        peerCfg = JSON.parse(fs.readFileSync(bjPath, "utf8")) || {};
      } catch {
        peerCfg = {};
      }
    }
    if (!explicitSet.has(d)) {
      if (!peerCfg || String(peerCfg.group || "").trim() !== groupName) continue;
      const peerUrl = String(peerCfg.bridgeUrl || "").trim().replace(/\/+$/, "");
      if (peerUrl && bridgeUrl && peerUrl !== bridgeUrl.replace(/\/+$/, "")) continue;
    }
    try {
      const inside = execFileSync("git", ["-C", d, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (inside !== "true") continue;
      const pRemote = execFileSync("git", ["-C", d, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      const pBranch = execFileSync("git", ["-C", d, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "main";
      const pCommit = execFileSync("git", ["-C", d, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      const pId = String(peerCfg.projectId || "").trim();
      if (pId && pId === projectId) continue;
      targets.push({ projectId: pId, repoUrl: pRemote, branch: pBranch, commit: pCommit });
      if (pId) dirMap.set(pId, { dir: d, branch: pBranch });
    } catch {
      /* ignore */
    }
  }
  return { targets, dirMap };
}

const { targets: peerTargets, dirMap: repoDirMap } = discoverPeerTargets();

function maybePullFix(rec) {
  if (!doPull) return;
  const pushedMap = rec?.pushedCommits && typeof rec.pushedCommits === "object" ? rec.pushedCommits : null;
  if (pushedMap && Object.keys(pushedMap).length > 0) {
    for (const [pid, sha] of Object.entries(pushedMap)) {
      if (!sha) continue;
      const entry = repoDirMap.get(pid);
      if (entry) {
        const out = execFileSync("git", ["-C", entry.dir, "pull", "--ff-only", "origin", entry.branch], { encoding: "utf8" }).trim();
        if (!outJson && out) console.error(`[${pid}] ${out}`);
      }
    }
    return;
  }
  const pushed = String(rec?.pushedCommit || "").trim();
  if (pushed) {
    const out = execFileSync("git", ["pull", "--ff-only", "origin", branch], { encoding: "utf8" }).trim();
    if (!outJson && out) console.error(out);
  }
}

function recordCloudGateStamp() {
  try {
    const gateDir = "/tmp/agy-cloud-gate";
    fs.mkdirSync(gateDir, { recursive: true });
    const seen = [];
    const top = gitToplevel();
    if (top) seen.push(top);
    for (const { dir } of repoDirMap.values()) {
      const rd = fs.realpathSync(dir);
      if (!seen.includes(rd)) seen.push(rd);
    }
    for (const rd of seen) {
      const head = execFileSync("git", ["-C", rd, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (head) {
        const rhash = crypto.createHash("sha256").update(rd).digest("hex").slice(0, 16);
        fs.writeFileSync(path.join(gateDir, `attempted-${rhash}`), `${head}\n`);
      }
    }
  } catch {
    /* ignore */
  }
}

function printOutputAndExit(rec) {
  if (TERMINAL.has(rec?.status)) recordCloudGateStamp();
  if (outJson) {
    console.log(JSON.stringify(rec, null, 2));
  } else {
    console.log(`handoffId: ${rec.handoffId}`);
    console.log(`status:    ${rec.status} (phase=${rec.phase})`);
    console.log(`project:   ${rec.projectId} @ ${rec.branch}`);
    if (Array.isArray(rec.changedProjects) && rec.changedProjects.length > 0) {
      console.log(`changedProjects: ${rec.changedProjects.join(", ")}`);
    }
    if (rec.pushedCommits && Object.keys(rec.pushedCommits).length > 0) {
      console.log(`pushedCommits:   ${JSON.stringify(rec.pushedCommits)}`);
    } else if (rec.pushedCommit) {
      console.log(`pushedCommit: ${rec.pushedCommit}`);
    }
    if (rec.summary) console.log(`summary:\n${rec.summary}`);
    if (rec.error) console.log(`error:     ${rec.error}`);
  }
  const st = rec.status;
  if (st === "succeeded" || st === "fast_synced") process.exit(0);
  if (st === "blocked") process.exit(2);
  if ((st === "queued" || st === "running") && waitSec === 0) process.exit(0);
  process.exit(1);
}

if (channel === "git-ref") {
  console.error("Node fallback 模式暂仅支持 http 通道；请安装 python3 或使用默认 http 通道。");
  process.exit(1);
}

const payload = {
  handoffId,
  workflowId,
  projectId,
  repoUrl,
  branch,
  commit: commitSha,
  task: taskText,
  taskType,
  mode,
  resultChannel: channel,
};
if (peerTargets.length > 0) payload.targets = peerTargets;

const pollInterval = Math.max(1, Number.parseInt(pollIntervalRaw || "2", 10) || 2);
const dispatchRes = await signedRequest("POST", "/api/v1/handoffs", payload, 30000);
let rec = dispatchRes.handoff || {};

if (waitSec === 0) printOutputAndExit(rec);

const deadline = Date.now() + waitSec * 1000;
while (!TERMINAL.has(rec.status)) {
  const remainingSec = Math.floor((deadline - Date.now()) / 1000);
  if (remainingSec <= 0) {
    rec.status = "timeout";
    rec.phase = "wait_timeout";
    rec.error = `等待本地处理超时（>${waitSec}s）`;
    break;
  }
  const chunkTimeout = Math.max(5, Math.min(remainingSec, 120));
  const waitRes = await signedRequest("GET", `/api/v1/handoffs/${handoffId}/wait?timeout=${chunkTimeout}`, null, (chunkTimeout + 15) * 1000);
  rec = waitRes.handoff || rec;
  if (TERMINAL.has(rec.status)) break;
  if (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.min(pollInterval * 1000, Math.max(200, deadline - Date.now()))));
  }
}

if (TERMINAL.has(rec.status)) {
  maybePullFix(rec);
  if (doAck) await signedRequest("POST", `/api/v1/handoffs/${handoffId}/ack`, {}, 30000);
}
printOutputAndExit(rec);
JS
