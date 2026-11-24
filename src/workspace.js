import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, writeFileAtomic, writeJsonAtomic } from "./util.js";

const BRIDGE_GUARD_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bridge/agy-bridge-guard.mjs");

function shellQuote(input) {
  return `'${String(input).replace(/'/g, "'\\''")}'`;
}

export function buildWorkspaceHooks({ nodePath = process.execPath, guardScriptPath = BRIDGE_GUARD_PATH } = {}) {
  return {
    "agy-bridge-guard": {
      enabled: true,
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: `${shellQuote(nodePath)} ${shellQuote(guardScriptPath)}`,
              timeout: 10,
            },
          ],
        },
      ],
    },
  };
}

export function buildBridgeAgentsMd({
  project,
  repoWorkingDir,
  runScratchDir,
  allowPush,
  peerTargets = [],
  generatedAt = new Date(),
}) {
  const peerBlock =
    Array.isArray(peerTargets) && peerTargets.length > 0
      ? [
          `- **同组多仓库协同清单（分组 \`${project.group || "default"}\`，均已授权读写与沙箱访问）**：`,
          ...peerTargets.map(
            (t) =>
              `  - \`${t.project.id}\`：\`${t.workingDir}\`（${t.changed ? "本轮有变更" : "本轮无增量提交"}${t.project.localContext ? `；说明：${t.project.localContext}` : ""}）`,
          ),
        ].join("\n")
      : "";

  return `<!-- 由 agy-cloud-bridge 自动生成（${generatedAt.toISOString()}），用于云端 ⇄ 本地协同会话。 -->

# 云地协同工作区：${project.name || project.id}（${project.id}）

你是本机（macOS / Linux）上的 Antigravity 工程接力 Agent，负责承接云端派发过来的本地环境任务（如部署重启、本机/移动端预览调试、本地数据库/内网资源检查、修复并回推代码）。

## 一、工作目录与环境边界

- **主触发仓库（实际操作目录）**：\`${repoWorkingDir}\`
- **本次任务隔离暂存目录（放截图/测试日志/临时输出）**：\`${runScratchDir}\`
- **主仓库本地运行说明**：${project.localContext ? project.localContext : "请先阅读目标仓库根目录的 `AGENTS.md` 与 `README.md`。"}
${peerBlock ? `${peerBlock}\n` : ""}
## 二、执行守则（务必遵守）

1. **按实际变更精准操作**：进入对应仓库操作前，先阅读其 \`AGENTS.md\`（如有）；多仓库场景下根据提示词中的「本轮多仓库变更感知清单」，只对实际发生变更或联调受影响的仓库执行构建、重启与验证，避免无故重启未改动的无关服务。
2. **严禁污染业务仓库与工作区清零断言（【桥接强制收尾契约】）**：所有截图、浏览器抓取、临时测试日志、中间调试文件**一律放入 \`${runScratchDir}\`**，绝不要留在任何业务仓库里；退出前必须对所有涉及仓库执行 \`git status --porcelain\`，对无意义构建噪音或临时调试改动执行 \`git checkout -- <file>\`（或 \`git restore\`）还原，清理未跟踪临时文件，**确保退出时 \`git status --porcelain\` 为空（\`dirtyCount=0\`）**（否则网关 Post-flight 将自动执行 \`git stash push -u -m "agy-bridge-leftover:<handoffId>"\` 安全暂存并向云端告警）。
3. **Git 提交与推送契约**：${
    allowPush
      ? "若你在本地修复了代码问题，或构建/编辑器自动生成了受控文件（如 `.meta`、lockfile、生成代码，含同组关联仓库），必须先完成验证测试，再在对应仓库用清晰的中文 commit message 执行干净的 `git add`、`git commit` 与 `git push` 推回当前分支（禁止 `--force`），以便网关自动记录 `pushedCommit`（多仓修复可同时填 `pushedCommits` 映射）。"
      : "当前项目未开启自动推送（`allowGitPush=false`），请不要执行 `git push`，仅做本地验证并在结果中给出待云端修复的精确建议，退出前务必还原或清理业务仓库中的本地改动，保持 `git status --porcelain` 为空。"
  }
4. **安全红线**：禁止读取或输出 \`~/.ssh\`、\`~/.agy-bridge\`、任何代理凭据文件、密钥/token 或敏感环境变量。禁止调用交互式阻塞提问工具。

## 三、结构化回传格式（必须附在回答最末尾）

完成任务后，在最终回答的**最末尾**原样输出如下分隔块与合法 JSON（便于网关精确回传给云端）：

<<<AGY_RESULT_JSON>>>
{
  "status": "ok",
  "summary": "用中文简洁总结本轮本地对哪些仓库做了什么、验证结果、是否修改/推送了代码或重启了服务",
  "testsPassed": true,
  "changedFiles": [],
  "serviceRestarted": false,
  "pushedCommit": "",
  "pushedCommits": {},
  "nextSuggestion": ""
}
<<<END_AGY_RESULT_JSON>>>
`;
}

export async function syncBridgeWorkspace({
  home,
  project,
  repoWorkingDir,
  runScratchDir,
  allowPush,
  peerTargets = [],
  guardScriptPath = BRIDGE_GUARD_PATH,
}) {
  const wsKey = project.group ? `group-${project.group}` : project.id;
  const workspace = path.join(home, "workspaces", wsKey);
  await ensureDir(workspace);
  await ensureDir(runScratchDir);

  const agentsFile = path.join(workspace, "AGENTS.md");
  await writeFileAtomic(
    agentsFile,
    buildBridgeAgentsMd({ project, repoWorkingDir, runScratchDir, allowPush, peerTargets }),
  );

  const hooksFile = path.join(workspace, ".agents", "hooks.json");
  await writeJsonAtomic(hooksFile, buildWorkspaceHooks({ guardScriptPath }));

  return { workspace, agentsFile, hooksFile };
}
