import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LOCAL_MARKER, normalizeLocalMarkerFile } from "./config.js";
import { ensureDir, normalizeGitRemote, writeFileAtomic, writeJsonAtomic } from "./util.js";

const DEFAULT_HANDOFF_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/handoff.sh");
const DEFAULT_CLOUD_GATE_HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/cloud-sync-gate.sh");

export function buildRepoHooksJson() {
  return {
    "agy-cloud-sync-gate": {
      enabled: true,
      SessionStart: [
        {
          type: "command",
          command: "bash ./hooks/cloud-sync-gate.sh",
          timeout: 10,
        },
      ],
      Stop: [
        {
          type: "command",
          command: "bash ./hooks/cloud-sync-gate.sh",
          timeout: 15,
        },
      ],
    },
  };
}

export function buildBridgeConfigJson({
  bridgeUrl,
  projectId,
  projectToken,
  group = "",
  defaultChannel = "http",
  defaultWaitSec = 960,
  localMarkerFile = DEFAULT_LOCAL_MARKER,
}) {
  const out = {
    version: 1,
    bridgeUrl: String(bridgeUrl || "").replace(/\/+$/, ""),
    projectId: String(projectId || ""),
    projectToken: String(projectToken || ""),
    defaultChannel,
    defaultWaitSec,
    localMarkerFile: normalizeLocalMarkerFile(localMarkerFile),
  };
  if (group) out.group = String(group).trim();
  return out;
}

export async function ensureGitignoreEntry(repoPath, entry) {
  const normalized = normalizeLocalMarkerFile(entry);
  const gitignorePath = path.join(repoPath, ".gitignore");
  let existing = "";
  try {
    existing = await fsp.readFile(gitignorePath, "utf8");
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }

  const lines = existing.split("\n").map((l) => l.replace(/\r$/, "").trim());
  const alreadyPresent = lines.some((l) => l && !l.startsWith("#") && (l === normalized || l === `/${normalized}`));
  if (alreadyPresent) {
    return { gitignorePath, added: false };
  }

  const next = !existing
    ? `${normalized}\n`
    : existing.endsWith("\n")
      ? `${existing}${normalized}\n`
      : `${existing}\n${normalized}\n`;
  await writeFileAtomic(gitignorePath, next);
  return { gitignorePath, added: true };
}

export async function ensureLocalMarkerFile(repoPath, localMarkerFile = DEFAULT_LOCAL_MARKER) {
  const rel = normalizeLocalMarkerFile(localMarkerFile);
  const markerPath = path.join(repoPath, rel);
  await ensureDir(path.dirname(markerPath));
  if (fs.existsSync(markerPath)) {
    return { markerPath, created: false };
  }
  await writeFileAtomic(
    markerPath,
    "# Local environment marker for agy-cloud-bridge (gitignored).\n# Present => local machine; absent => cloud sandbox.\n",
  );
  return { markerPath, created: true };
}

export function buildWorkspaceRuleMd({
  projectId,
  group = "",
  fastPaths = [],
  localContext = "",
  localMarkerFile = DEFAULT_LOCAL_MARKER,
  allowGitPush = true,
}) {
  const marker = normalizeLocalMarkerFile(localMarkerFile);
  const groupLine = group
    ? `- **多仓库协同分组（\`group: ${group}\`）**：若云端同时修改并 \`git push\` 了多个同组仓库，只需在任意一个已推代码的仓库执行**一次** \`handoff.sh dispatch\`（脚本会自动扫描云端同级目录 \`../*/.agents/bridge.json\` 的同组仓库提交，且本地网关也会自动增量拉取所有有新提交的同组仓库、汇总变更清单交给单个本地 \`agy\` 统一处理，支持 \`--pull\` 批量拉回多仓修复）。\n`
    : "";
  const fastLine =
    Array.isArray(fastPaths) && fastPaths.length > 0
      ? `- **零 Token 快同路径（\`fastPaths\`）**：\`${fastPaths.join("`, `")}\`（仅改这些文件时本地自动 \`git pull\`，不唤起本地 \`agy\`）。\n`
      : "";
  const ctxLine = localContext ? `- **本地环境说明**：${localContext}\n` : "";
  const localCommitStep = allowGitPush
    ? "对本次合法修复或构建/编辑器自动生成的受控文件（如 `.meta`、lockfile、自动生成代码等），在对应仓库用清晰的中文 commit message 执行 `git add`、`git commit` 并 `git push` 推回当前分支（禁止 `--force`），以便网关记录 `pushedCommit` 供云端 `--pull` 同步；"
    : "当前项目未开启自动推送（`allowGitPush=false`），请勿执行 `git push`，仅在返回 `summary` 中给出精确修复建议，并还原或清理仓库内临时改动；";

  return `---
trigger: always_on
description: Antigravity 云端 ⇄ 本机双端对称协同规则（云端强制推送与本地部署闭环 + 本机强制收尾提交与工作区清零）
---

# 云端 ⇄ 本机双端对称协同规则（项目：${projectId}）

1. **云端 / 本机环境判定与防递归（双端通用，最高优先级）**：
   - 检查项目目录下是否存在 \`${marker}\`（已被 \`.gitignore\` 忽略，永远不会被推送到远端 Git）或环境变量 \`AGY_BRIDGE_LOCAL_SESSION=1\`：
     - **存在 \`${marker}\` 或 \`AGY_BRIDGE_LOCAL_SESSION=1\`** ⇒ 当前在 **本机环境（macOS / Linux）**；直接在本机执行任务，**严禁调用 \`handoff.sh\`**，并严格执行下方「本机端收尾规则」。
     - **不存在 \`${marker}\` 且无 \`AGY_BRIDGE_LOCAL_SESSION=1\`** ⇒ 当前在 **Antigravity 云端**；按下方「云端收尾与派发规则」通过 \`handoff.sh\` 协同本机。
2. **云端收尾强制推送与实时本地部署闭环（云端生效，自带 \`.agents/hooks.json\` \`Stop\` 钩子兜底）**：
   - **铁律**：云端每次修改代码或配置文件后，在结束任务前**必须完成 \`git commit && git push\` 并触发本地实时拉取部署**（若未推送或未触发 \`handoff.sh\`，仓内 \`Stop\` 钩子会自动拦截收尾）：
   - **情况 A（仅改动快同文件并已 \`git push\`）**：若刚完成内容创作/文档更新并推送，主动执行一次 \`handoff.sh dispatch --mode auto --wait 120 --ack\` 让本机秒级同步。
   - **情况 B（代码/配置改动 ➔ 实时拉取部署与验活）**：云端在所有改过的仓库完成 \`git commit && git push\` 后，先读取 \`.agents/skills/cloud-local-handoff/SKILL.md\`，再通过**单条 \`run_command\`** 执行 \`bash .agents/skills/cloud-local-handoff/scripts/handoff.sh dispatch --mode agent --task-type deploy_restart --workflow <任务ID> --task "<说明改动与本地验证/部署要求>；结束前检查 git status --porcelain，将合法修复或受控生成文件（如 .meta/lockfile/生成代码）git commit && git push 推回当前分支，还原无意义构建噪音，确保退出时 dirtyCount=0" --wait 600 --pull --ack\`。
   - **异步零 Token 等待与多轮往返**：网关域名与本项目独立令牌已写入 \`.agents/bridge.json\`，**不需要任何云端环境变量**。若 \`run_command\` 转入后台任务，**严禁调用 \`manage_task\` 轮询或 \`sleep\`**，直接结束当前工具调用等待系统唤醒；若本地返回问题，云端修复推送后沿用同一 \`--workflow <任务ID>\` 发起下一轮（受 \`maxRounds\` 熔断保护）。
3. **本机端收尾强制提交与工作区清零规则（本机生效，与云端对称）**：
   - **对称铁律**：在本机承接云端协同任务（\`AGY_BRIDGE_LOCAL_SESSION=1\`）或执行本地构建/验证修复后，**退出前必须清理并提交合法改动，断言工作区清零（\`dirtyCount=0\`）**，杜绝残留未提交改动导致下一轮云端派发锁死在 \`phase=dirty_tree\`：
     1. 退出前对所有涉及仓库执行 \`git status --porcelain\`；
     2. ${localCommitStep}
     3. 对无意义构建噪音或临时调试修改执行 \`git checkout -- <file>\`（或 \`git restore\`）还原；截图、日志、临时产物只写入桥接隔离暂存目录或立即删除，严禁留在业务仓库；
     4. **退出前断言 \`git status --porcelain\` 输出为空（\`dirtyCount=0\`）**；若退出时仍残留未提交改动，桥接网关 Post-flight 将自动执行 \`git stash push -u -m "agy-bridge-leftover:<handoffId>"\` 安全暂存并向云端追加告警（注：任务启动前的 Pre-flight \`dirty_tree\` 检查保持不变，继续保护用户平时手改未提交的代码）。
${groupLine}${fastLine}${ctxLine}`;
}

export function buildWorkspaceSkillMd({ projectId, localMarkerFile = DEFAULT_LOCAL_MARKER }) {
  const marker = normalizeLocalMarkerFile(localMarkerFile);
  return `---
name: cloud-local-handoff
description: Dispatch a local sync, restart, preview, or debug task for project ${projectId} to the user's local Antigravity bridge using the project-scoped .agents/bridge.json configuration, waiting with zero LLM token consumption and automatically cleaning up artifacts.
---

# Cloud ⇄ Local Handoff Skill (${projectId})

本技能专供 **Antigravity 云端 Agent** 在完成 \`git commit && git push\` 后自主调用本机 Antigravity，已内置项目级配置（\`.agents/bridge.json\`），**无需环境变量，也无需用户手工运行 Shell**。

## 执行前检查

1. **环境判定**：检查项目目录下是否存在 \`${marker}\` 或环境变量 \`AGY_BRIDGE_LOCAL_SESSION=1\`；若存在则说明当前在本机环境，**严禁调用本技能**；不存在则为 Antigravity 云端，可执行下方派发。
2. 确认当前修改已 \`git commit && git push\` 到远端分支（本地网关会据此 \`git pull --ff-only\`）。

## 标准调用命令（单条 \`run_command\` 完成派发 + 0 Token 等待 + 拉回修复 + 自动清理）

### 场景一：代码改动后需本地重启、预览调试或修 Bug（Agent 模式）

\`\`\`bash
bash .agents/skills/cloud-local-handoff/scripts/handoff.sh dispatch \\
  --mode agent \\
  --task-type preview_and_test \\
  --workflow "<稳定任务ID，多轮往返复用>" \\
  --task "<写明本地需要做什么：拉取最新代码、重启/启动哪个服务、验证哪些页面/接口，若有报错修复并推回；收尾前检查 git status --porcelain，将本次合法修复或构建生成的受控文件（如 .meta/lockfile/生成代码）git commit && git push 推回当前分支，还原无意义构建噪音，确保退出时工作区清零（dirtyCount=0）>" \\
  --wait 600 \\
  --pull \\
  --ack
\`\`\`

### 场景二：仅静态内容/小说章节改动需本地同步（命中 \`fastPaths\` 零 Token 拉取）

\`\`\`bash
bash .agents/skills/cloud-local-handoff/scripts/handoff.sh dispatch \\
  --mode auto \\
  --task "同步最新远端提交" \\
  --wait 120 \\
  --ack
\`\`\`

## 云端 Agent 调度守则

- **转入后台时不要轮询**：在 Antigravity 中，若 \`run_command\` 超过 \`WaitMsBeforeAsync\` 自动转入后台，**立即停止调用工具等待系统唤醒通知**，禁止调用 \`manage_task\` 轮询或 \`sleep\`。
- **双端收尾与 Post-flight 兜底**：网关会自动向本地 \`agy\` 注入【桥接强制收尾契约】要求提交合法改动并保持 \`dirtyCount=0\`；若本地执行（含成功、报错或超时）退出后仍残留未提交文件，网关 Post-flight 会自动 \`git stash push -u -m "agy-bridge-leftover:<handoffId>"\` 安全暂存并在 \`summary\` 中追加告警，既不丢文件也不会把下一轮锁死在 \`phase=dirty_tree\`。
- **兼容性说明**：脚本同时内置 \`python3\` 与 \`node\` 双运行时，无 \`python3\` 的容器也能直接执行。
- **本机直跑调试**：\`handoff.sh\` 会自动检测 \`${marker}\`（以及 \`AGY_BRIDGE_LOCAL_SESSION=1\`）；若在本机仓库内手工模拟云端触发，需追加 \`--force-local\`（正常云端容器无需该参数）。
- **退出码处理**：
  - \`0\`：成功（若本地推回修复且带了 \`--pull\`，最新修复已自动拉到云端工作区，可继续检查并进入下一轮；若 \`summary\` 含 \`[Post-flight 告警]\`，提示用户留意本地已自动暂存的残留改动）；
  - \`2\`：任务启动前 Pre-flight 检测到用户平时手改未提交改动，被 \`safe-block\` 拦截（\`phase=dirty_tree\`），停止重试并向用户报告本地脏文件清单；
  - \`1\`：执行失败或超时，向用户报告返回的 \`error\` 与 \`summary\`。
`;
}

const START_MARKER = "<!-- AGY_CLOUD_BRIDGE_START -->";
const END_MARKER = "<!-- AGY_CLOUD_BRIDGE_END -->";

export async function upsertAgentsMdPointer(agentsMdPath, projectId, localMarkerFile = DEFAULT_LOCAL_MARKER) {
  const marker = normalizeLocalMarkerFile(localMarkerFile);
  const block = [
    START_MARKER,
    `## 云端 ⇄ 本地协同入口（\`${projectId}\`）`,
    `- **环境判定与防递归**：项目存在 \`${marker}\`（已被 \`.gitignore\` 忽略）或 \`AGY_BRIDGE_LOCAL_SESSION=1\` 时为本地环境，严禁调用 \`handoff.sh\`；云端仓库无该文件，可正常发起协同。`,
    "- **云端 Agent 自动联动**：在云端完成改动并 `git push` 后，按 `.agents/rules/cloud-local-bridge.md` 与 `.agents/skills/cloud-local-handoff/SKILL.md` 由 Agent 自主执行 `.agents/skills/cloud-local-handoff/scripts/handoff.sh`（配置位于 `.agents/bridge.json`，无需环境变量；转入后台后直接结束本轮等待系统唤醒，严禁轮询）。",
    "- **本机 Agent 对称收尾**：承接桥接任务退出前必须检查 `git status --porcelain`，将合法修复及受控生成文件 `git commit && git push` 推回当前分支、还原构建噪音并确保 `dirtyCount=0`（残留改动将由网关 Post-flight 自动 `git stash push -u` 暂存并告警）。",
    END_MARKER,
  ].join("\n");

  let existing = "";
  try {
    existing = await fsp.readFile(agentsMdPath, "utf8");
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }

  let next;
  if (!existing.trim()) {
    next = `# 项目协同说明\n\n${block}\n`;
  } else {
    const startIdx = existing.indexOf(START_MARKER);
    const endIdx = existing.indexOf(END_MARKER);
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      next = `${existing.slice(0, startIdx)}${block}${existing.slice(endIdx + END_MARKER.length)}`;
    } else {
      const sep = existing.endsWith("\n") ? "\n---\n\n" : "\n\n---\n\n";
      next = `${existing}${sep}${block}\n`;
    }
  }

  await writeFileAtomic(agentsMdPath, next);
}

export async function checkGithubRepoPublic(remoteUrl) {
  const norm = normalizeGitRemote(remoteUrl);
  if (!norm.startsWith("github.com/")) {
    return { checked: false, isPublic: false };
  }
  const ownerRepo = norm.slice("github.com/".length);
  if (!ownerRepo || !ownerRepo.includes("/")) {
    return { checked: false, isPublic: false };
  }
  try {
    const res = await fetch(`https://github.com/${ownerRepo}`, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    return { checked: true, isPublic: res.status === 200, status: res.status };
  } catch {
    return { checked: false, isPublic: false };
  }
}

export async function writeRepoBridgeFiles({
  repoPath,
  bridgeUrl,
  project,
  handoffScriptSource = DEFAULT_HANDOFF_SCRIPT,
  cloudGateHookSource = DEFAULT_CLOUD_GATE_HOOK,
}) {
  const localMarkerFile = normalizeLocalMarkerFile(project.localMarkerFile);
  const agentsDir = path.join(repoPath, ".agents");
  const rulesDir = path.join(agentsDir, "rules");
  const hooksDir = path.join(agentsDir, "hooks");
  const skillScriptsDir = path.join(agentsDir, "skills", "cloud-local-handoff", "scripts");
  await ensureDir(rulesDir);
  await ensureDir(hooksDir);
  await ensureDir(skillScriptsDir);

  const bridgeJsonPath = path.join(agentsDir, "bridge.json");
  await writeJsonAtomic(
    bridgeJsonPath,
    buildBridgeConfigJson({
      bridgeUrl,
      projectId: project.id,
      projectToken: project.token,
      group: project.group || "",
      defaultChannel: project.defaultChannel || "http",
      localMarkerFile,
    }),
  );

  const rulePath = path.join(rulesDir, "cloud-local-bridge.md");
  await writeFileAtomic(
    rulePath,
    buildWorkspaceRuleMd({
      projectId: project.id,
      group: project.group || "",
      fastPaths: project.fastPaths,
      localContext: project.localContext,
      localMarkerFile,
      allowGitPush: project.allowGitPush !== false,
    }),
  );

  const skillPath = path.join(agentsDir, "skills", "cloud-local-handoff", "SKILL.md");
  await writeFileAtomic(skillPath, buildWorkspaceSkillMd({ projectId: project.id, localMarkerFile }));

  const scriptDstPath = path.join(skillScriptsDir, "handoff.sh");
  const scriptBytes = await fsp.readFile(handoffScriptSource, "utf8");
  await writeFileAtomic(scriptDstPath, scriptBytes, 0o755);
  await fs.promises.chmod(scriptDstPath, 0o755).catch(() => {});

  const hooksJsonPath = path.join(agentsDir, "hooks.json");
  await writeJsonAtomic(hooksJsonPath, buildRepoHooksJson());

  const hookScriptDstPath = path.join(hooksDir, "cloud-sync-gate.sh");
  const hookBytes = await fsp.readFile(cloudGateHookSource, "utf8");
  await writeFileAtomic(hookScriptDstPath, hookBytes, 0o755);
  await fs.promises.chmod(hookScriptDstPath, 0o755).catch(() => {});

  const agentsMdPath = path.join(repoPath, "AGENTS.md");
  await upsertAgentsMdPointer(agentsMdPath, project.id, localMarkerFile);

  const { gitignorePath } = await ensureGitignoreEntry(repoPath, localMarkerFile);
  const { markerPath: localMarkerPath } = await ensureLocalMarkerFile(repoPath, localMarkerFile);

  return {
    bridgeJsonPath,
    hooksJsonPath,
    hookScriptDstPath,
    rulePath,
    skillPath,
    scriptDstPath,
    agentsMdPath,
    gitignorePath,
    localMarkerPath,
  };
}
