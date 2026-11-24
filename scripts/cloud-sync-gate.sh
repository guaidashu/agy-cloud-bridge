#!/usr/bin/env bash
set -euo pipefail

# Antigravity Cloud Lifecycle Hook (`SessionStart` & `Stop`) for agy-cloud-bridge.
# Placed at `<repo>/.agents/hooks/cloud-sync-gate.sh` and invoked by `<repo>/.agents/hooks.json`.
#
# Guarantees:
# 1. On Local Machine (`.agy-local` present, `AGY_BRIDGE_LOCAL_SESSION=1`, or registered local path):
#    exits in <5ms as a pure no-op so local IDE/CLI work is never interrupted.
# 2. In Antigravity Cloud (`fullyIdle == false` while async `handoff.sh` is waiting in background):
#    allows stop immediately so zero LLM tokens are consumed while waiting.
# 3. In Antigravity Cloud (`Stop` with `NO_TOOL_CALL` and `fullyIdle == true`):
#    checks current repo + all workspace/sibling group repos for:
#      a) uncommitted changes (`git status --porcelain`),
#      b) unpushed commits (`HEAD` ahead of `origin/<branch>`),
#      c) pushed commits in this session that have not yet triggered `handoff.sh dispatch`.
#    If any exist, returns `{"decision":"continue","reason":"..."}` to prevent forgetting local deployment!

HOOK_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_DIR="$(cd -- "${HOOK_DIR}/.." && pwd)"
REPO_ROOT="$(cd -- "${AGENTS_DIR}/.." && pwd)"
STDIN_JSON="$(cat || true)"

if command -v python3 >/dev/null 2>&1; then
exec python3 - "$REPO_ROOT" "$STDIN_JSON" <<'PY'
import hashlib
import json
import os
import subprocess
import sys

repo_root = os.path.realpath(sys.argv[1])
raw_stdin = (sys.argv[2] if len(sys.argv) > 2 else "").strip()
payload = {}
if raw_stdin:
    try:
        payload = json.loads(raw_stdin)
    except Exception:
        payload = {}

event_name = str(payload.get("hookEventName") or "")


def allow_out():
    if event_name == "Stop":
        print(json.dumps({"decision": "stop"}))
    else:
        print("{}")
    sys.exit(0)


if os.environ.get("AGY_BRIDGE_LOCAL_SESSION") == "1":
    allow_out()

bridge_cfg = {}
bj_file = os.path.join(repo_root, ".agents", "bridge.json")
if os.path.isfile(bj_file):
    try:
        with open(bj_file, "r", encoding="utf-8") as f:
            bridge_cfg = json.load(f) or {}
    except Exception:
        bridge_cfg = {}

marker_rel = str(bridge_cfg.get("localMarkerFile") or ".agy-local").strip().lstrip("./") or ".agy-local"
if os.path.exists(os.path.join(repo_root, marker_rel)):
    allow_out()

local_bridge_cfg = os.path.expanduser(os.path.join(os.environ.get("AGY_BRIDGE_HOME") or "~/.agy-bridge", "config.json"))
if os.path.isfile(local_bridge_cfg):
    try:
        with open(local_bridge_cfg, "r", encoding="utf-8") as f:
            lcfg = json.load(f) or {}
        for p in lcfg.get("projects") or []:
            rp = p.get("repoPath") or ""
            if rp and os.path.exists(os.path.expanduser(rp)) and os.path.realpath(os.path.expanduser(rp)) == repo_root:
                allow_out()
    except Exception:
        pass


def repo_hash(path):
    return hashlib.sha256(os.path.realpath(path).encode("utf-8")).hexdigest()[:16]


def git_out(cwd, args):
    res = subprocess.run(["git", "-C", cwd] + args, capture_output=True, text=True)
    return res.returncode, res.stdout.strip()


def collect_group_repos():
    group_name = str(bridge_cfg.get("group") or "").strip()
    bridge_url = str(bridge_cfg.get("bridgeUrl") or "").strip().rstrip("/")
    dirs = [repo_root]

    for wp in payload.get("workspacePaths") or []:
        if isinstance(wp, str) and os.path.isdir(wp):
            rwp = os.path.realpath(wp)
            if rwp not in dirs and os.path.isfile(os.path.join(rwp, ".agents", "bridge.json")):
                dirs.append(rwp)

    if group_name:
        parent = os.path.dirname(repo_root)
        try:
            for name in sorted(os.listdir(parent)):
                sub = os.path.realpath(os.path.join(parent, name))
                if sub in dirs or not os.path.isdir(sub):
                    continue
                sbj = os.path.join(sub, ".agents", "bridge.json")
                if not os.path.isfile(sbj):
                    continue
                with open(sbj, "r", encoding="utf-8") as f:
                    scfg = json.load(f) or {}
                if str(scfg.get("group") or "").strip() == group_name:
                    surl = str(scfg.get("bridgeUrl") or "").strip().rstrip("/")
                    if not bridge_url or not surl or surl == bridge_url:
                        dirs.append(sub)
        except Exception:
            pass
    return dirs


gate_dir = "/tmp/agy-cloud-gate"
os.makedirs(gate_dir, exist_ok=True)
conv_id = str(payload.get("conversationId") or "default").replace("/", "_")
repos = collect_group_repos()

if event_name == "SessionStart":
    for r in repos:
        rc, head = git_out(r, ["rev-parse", "HEAD"])
        if rc == 0 and head:
            init_file = os.path.join(gate_dir, f"init-{conv_id}-{repo_hash(r)}")
            if not os.path.isfile(init_file):
                with open(init_file, "w", encoding="utf-8") as f:
                    f.write(head + "\n")
    print("{}")
    sys.exit(0)

if event_name != "Stop":
    allow_out()

# Respect async background handoff.sh waiting & non-normal stop reasons
if payload.get("fullyIdle") is False:
    allow_out()

term_reason = str(payload.get("terminationReason") or "NO_TOOL_CALL")
if term_reason != "NO_TOOL_CALL":
    allow_out()

dirty_repos = []
ahead_repos = []
undeployed_repos = []

for r in repos:
    rc_in, inside = git_out(r, ["rev-parse", "--is-inside-work-tree"])
    if rc_in != 0 or inside != "true":
        continue
    name = os.path.basename(r)
    _, status_txt = git_out(r, ["status", "--porcelain"])
    dirty_lines = [ln for ln in status_txt.splitlines() if ln.strip()]
    if dirty_lines:
        dirty_repos.append(f"{name}({len(dirty_lines)}项未提交)")

    rc_h, head = git_out(r, ["rev-parse", "HEAD"])
    if rc_h != 0 or not head:
        continue
    _, branch = git_out(r, ["rev-parse", "--abbrev-ref", "HEAD"])
    branch = branch or "main"

    rc_u, cnt = git_out(r, ["rev-list", "--count", f"origin/{branch}..HEAD"])
    if rc_u == 0 and cnt.isdigit() and int(cnt) > 0:
        ahead_repos.append(f"{name}({cnt}个提交未push)")
        continue

    rhash = repo_hash(r)
    init_file = os.path.join(gate_dir, f"init-{conv_id}-{rhash}")
    attempted_file = os.path.join(gate_dir, f"attempted-{rhash}")
    init_head = open(init_file, "r", encoding="utf-8").read().strip() if os.path.isfile(init_file) else ""
    attempted_head = open(attempted_file, "r", encoding="utf-8").read().strip() if os.path.isfile(attempted_file) else ""

    if not init_head:
        # First time seeing this repo without SessionStart: record baseline if clean
        with open(init_file, "w", encoding="utf-8") as f:
            f.write(head + "\n")
        continue

    if head != init_head and head != attempted_head:
        undeployed_repos.append(f"{name}@{head[:8]}")

counter_file = os.path.join(gate_dir, f"turn-count-{conv_id}")
if not dirty_repos and not ahead_repos and not undeployed_repos:
    if os.path.isfile(counter_file):
        try:
            os.remove(counter_file)
        except Exception:
            pass
    allow_out()

# Anti-infinite-loop circuit breaker (max 2 forced continuations per user turn)
cont_active = bool(payload.get("continuationActive"))
count = 0
if cont_active and os.path.isfile(counter_file):
    try:
        count = int(open(counter_file, "r", encoding="utf-8").read().strip() or "0")
    except Exception:
        count = 0
if cont_active and count >= 2:
    allow_out()

with open(counter_file, "w", encoding="utf-8") as f:
    f.write(str(count + 1 if cont_active else 1) + "\n")

issues = []
if dirty_repos:
    issues.append("未提交改动: " + ", ".join(dirty_repos))
if ahead_repos:
    issues.append("未推送提交: " + ", ".join(ahead_repos))
if undeployed_repos:
    issues.append("已推送但尚未触发本地拉取部署: " + ", ".join(undeployed_repos))

reason = (
    "[Cloud ⇄ Local 实时部署守卫] 检测到本轮云端存在尚未同步部署到本机环境的变更（"
    + "；".join(issues)
    + "）。若用户未明确要求暂缓提交/部署，请立即：1) 在所有改动过的仓库执行 git commit && git push；"
    + "2) 在主改动仓库执行单条命令 `bash .agents/skills/cloud-local-handoff/scripts/handoff.sh dispatch --mode agent --task-type deploy_restart --workflow <任务ID> --task \"拉取最新改动并按变更仓库执行本地部署重载与健康检查\" --wait 600 --pull --ack`（若转入后台请立即停止调用工具等待唤醒）。"
)
print(json.dumps({"decision": "continue", "reason": reason}, ensure_ascii=False))
PY
fi

# Fallback when python3 is absent: allow stop gracefully if node is also absent
if ! command -v node >/dev/null 2>&1; then
    printf '{"decision":"stop"}\n'
    exit 0
fi

exec node - "$REPO_ROOT" "$STDIN_JSON" <<'JS'
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repoRoot = fs.realpathSync(process.argv[2]);
let payload = {};
try {
  const raw = String(process.argv[3] || "").trim();
  if (raw) payload = JSON.parse(raw);
} catch {}

const eventName = String(payload.hookEventName || "");
const allowOut = () => {
  process.stdout.write(eventName === "Stop" ? '{"decision":"stop"}\n' : "{}\n");
  process.exit(0);
};

if (process.env.AGY_BRIDGE_LOCAL_SESSION === "1") allowOut();

let bridgeCfg = {};
const bjFile = path.join(repoRoot, ".agents", "bridge.json");
if (fs.existsSync(bjFile)) {
  try { bridgeCfg = JSON.parse(fs.readFileSync(bjFile, "utf8")) || {}; } catch {}
}
const markerRel = String(bridgeCfg.localMarkerFile || ".agy-local").trim().replace(/^(\.\/)+/, "") || ".agy-local";
if (fs.existsSync(path.join(repoRoot, markerRel))) allowOut();

const homeCfg = path.join(os.homedir(), ".agy-bridge", "config.json");
if (fs.existsSync(homeCfg)) {
  try {
    const lcfg = JSON.parse(fs.readFileSync(homeCfg, "utf8")) || {};
    for (const p of lcfg.projects || []) {
      const rp = p?.repoPath ? p.repoPath.replace(/^~(?=$|\/)/, os.homedir()) : "";
      if (rp && fs.existsSync(rp) && fs.realpathSync(rp) === repoRoot) allowOut();
    }
  } catch {}
}

const repoHash = (p) => crypto.createHash("sha256").update(fs.realpathSync(p)).digest("hex").slice(0, 16);
const gitOut = (cwd, args) => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { code: r.status ?? 1, out: String(r.stdout || "").trim() };
};

const groupName = String(bridgeCfg.group || "").trim();
const bridgeUrl = String(bridgeCfg.bridgeUrl || "").trim().replace(/\/+$/, "");
const repos = [repoRoot];
if (groupName) {
  const parent = path.dirname(repoRoot);
  try {
    for (const name of fs.readdirSync(parent).sort()) {
      const sub = fs.realpathSync(path.join(parent, name));
      if (repos.includes(sub) || !fs.statSync(sub).isDirectory()) continue;
      const sbj = path.join(sub, ".agents", "bridge.json");
      if (!fs.existsSync(sbj)) continue;
      const scfg = JSON.parse(fs.readFileSync(sbj, "utf8")) || {};
      if (String(scfg.group || "").trim() === groupName) {
        const surl = String(scfg.bridgeUrl || "").trim().replace(/\/+$/, "");
        if (!bridgeUrl || !surl || surl === bridgeUrl) repos.push(sub);
      }
    }
  } catch {}
}

const gateDir = "/tmp/agy-cloud-gate";
fs.mkdirSync(gateDir, { recursive: true });
const convId = String(payload.conversationId || "default").replace(/\//g, "_");

if (eventName === "SessionStart") {
  for (const r of repos) {
    const h = gitOut(r, ["rev-parse", "HEAD"]);
    if (h.code === 0 && h.out) {
      const initFile = path.join(gateDir, `init-${convId}-${repoHash(r)}`);
      if (!fs.existsSync(initFile)) fs.writeFileSync(initFile, `${h.out}\n`);
    }
  }
  process.stdout.write("{}\n");
  process.exit(0);
}

if (eventName !== "Stop" || payload.fullyIdle === false || String(payload.terminationReason || "NO_TOOL_CALL") !== "NO_TOOL_CALL") {
  allowOut();
}

const dirty = [], ahead = [], undeployed = [];
for (const r of repos) {
  if (gitOut(r, ["rev-parse", "--is-inside-work-tree"]).out !== "true") continue;
  const name = path.basename(r);
  const st = gitOut(r, ["status", "--porcelain"]).out.split("\n").filter((l) => l.trim());
  if (st.length) dirty.push(`${name}(${st.length}项未提交)`);
  const h = gitOut(r, ["rev-parse", "HEAD"]);
  if (h.code !== 0 || !h.out) continue;
  const br = gitOut(r, ["rev-parse", "--abbrev-ref", "HEAD"]).out || "main";
  const cnt = gitOut(r, ["rev-list", "--count", `origin/${br}..HEAD`]);
  if (cnt.code === 0 && /^\d+$/.test(cnt.out) && Number(cnt.out) > 0) {
    ahead.push(`${name}(${cnt.out}个提交未push)`);
    continue;
  }
  const rhash = repoHash(r);
  const initFile = path.join(gateDir, `init-${convId}-${rhash}`);
  const attFile = path.join(gateDir, `attempted-${rhash}`);
  const initHead = fs.existsSync(initFile) ? fs.readFileSync(initFile, "utf8").trim() : "";
  const attHead = fs.existsSync(attFile) ? fs.readFileSync(attFile, "utf8").trim() : "";
  if (!initHead) {
    fs.writeFileSync(initFile, `${h.out}\n`);
    continue;
  }
  if (h.out !== initHead && h.out !== attHead) undeployed.push(`${name}@${h.out.slice(0, 8)}`);
}

const counterFile = path.join(gateDir, `turn-count-${convId}`);
if (!dirty.length && !ahead.length && !undeployed.length) {
  if (fs.existsSync(counterFile)) try { fs.unlinkSync(counterFile); } catch {}
  allowOut();
}

const contActive = Boolean(payload.continuationActive);
let count = 0;
if (contActive && fs.existsSync(counterFile)) {
  try { count = Number(fs.readFileSync(counterFile, "utf8").trim()) || 0; } catch {}
}
if (contActive && count >= 2) allowOut();
fs.writeFileSync(counterFile, `${contActive ? count + 1 : 1}\n`);

const issues = [];
if (dirty.length) issues.push(`未提交改动: ${dirty.join(", ")}`);
if (ahead.length) issues.push(`未推送提交: ${ahead.join(", ")}`);
if (undeployed.length) issues.push(`已推送但尚未触发本地拉取部署: ${undeployed.join(", ")}`);
const reason = `[Cloud ⇄ Local 实时部署守卫] 检测到本轮云端存在尚未同步部署到本机环境的变更（${issues.join("；")}）。若用户未明确要求暂缓提交/部署，请立即：1) 在所有改动过的仓库执行 git commit && git push；2) 在主改动仓库执行单条命令 \`bash .agents/skills/cloud-local-handoff/scripts/handoff.sh dispatch --mode agent --task-type deploy_restart --workflow <任务ID> --task "拉取最新改动并按变更仓库执行本地部署重载与健康检查" --wait 600 --pull --ack\`（若转入后台请立即停止调用工具等待唤醒）。`;
process.stdout.write(`${JSON.stringify({ decision: "continue", reason })}\n`);
JS
