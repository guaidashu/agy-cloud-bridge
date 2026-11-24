import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { deleteRemoteGitRef, inspectRepo, runGit, stashRepoLeftovers } from "./git-sync.js";

/**
 * 复检业务仓库在 agy 退出后的状态，报告是否有 AI 遗留的未提交/未跟踪文件。
 */
export async function inspectRepoHygiene({ repoPath, gitEnv = {} }) {
  const info = await inspectRepo(repoPath, gitEnv);
  return {
    clean: info.dirtyFiles.length === 0,
    dirtyFiles: info.dirtyFiles,
    head: info.head,
    branch: info.branch,
  };
}

/**
 * Post-flight 卫生复检与自动兜底暂存：
 * - 若工作区干净，直接返回干净状态；
 * - 若检测到 agy 退出后残留未提交/未跟踪改动（且非执行前已有的无关关联仓用户手改），
 *   自动执行 `git stash push -u -m "agy-bridge-leftover:<handoffId>"` 安全暂存，
 *   确保既不丢任何文件，又永远不会把下一轮派发锁死在 phase=dirty_tree。
 */
export async function recoverPostFlightRepoHygiene({
  repoPath,
  handoffId = "unknown",
  gitEnv = {},
  skipAutoStash = false,
  logger,
} = {}) {
  const initial = await inspectRepoHygiene({ repoPath, gitEnv });
  if (initial.clean || skipAutoStash) {
    return {
      ...initial,
      leftoversStashed: false,
      stashedFiles: [],
      stashMessage: "",
      stashRef: "",
      stashSha: "",
      stashError: "",
      autoStashSkipped: Boolean(skipAutoStash && !initial.clean),
    };
  }

  const stashRes = await stashRepoLeftovers({ repoPath, handoffId, gitEnv });
  if (stashRes.stashed) {
    logger?.warn?.(
      `[${handoffId}] Post-flight 检测到 ${stashRes.dirtyFiles.length} 项残留未提交改动，已自动暂存至 ${stashRes.stashRef || "stash@{0}"} (${stashRes.stashMessage})`,
    );
  } else if (stashRes.error || stashRes.remainingDirtyFiles.length > 0) {
    logger?.warn?.(
      `[${handoffId}] Post-flight 自动暂存残留改动未完全清理（剩余 ${stashRes.remainingDirtyFiles.length} 项）：${stashRes.error || "未知原因"}`,
    );
  }

  return {
    clean: stashRes.remainingDirtyFiles.length === 0,
    dirtyFiles: stashRes.remainingDirtyFiles,
    head: stashRes.head || initial.head,
    branch: stashRes.branch || initial.branch,
    leftoversStashed: Boolean(stashRes.stashed),
    stashedFiles: stashRes.stashed ? stashRes.dirtyFiles : [],
    stashMessage: stashRes.stashMessage || `agy-bridge-leftover:${handoffId}`,
    stashRef: stashRes.stashRef || "",
    stashSha: stashRes.stashSha || "",
    stashError: stashRes.error || "",
    autoStashSkipped: false,
  };
}

/**
 * 清理单次运行的临时产物：
 * - 删除 runDir 下的 scratch/、artifacts/、events.ndjson（保留精简 audit.json）；
 * - 若使用了临时 worktree，强制卸载并 prune；
 * - 若存在远端协作标记分支（agy-collab/*），一并删除。
 */
export async function purgeRunArtifacts({ runDir, worktreePath, repoPath, gitRefs = [], gitEnv = {}, logger } = {}) {
  const summary = {
    scratchRemoved: false,
    worktreeRemoved: false,
    deletedRefs: [],
  };

  if (runDir && fs.existsSync(runDir)) {
    for (const sub of ["scratch", "artifacts", "events.ndjson"]) {
      const target = path.join(runDir, sub);
      if (fs.existsSync(target)) {
        await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
        if (sub === "scratch") summary.scratchRemoved = true;
      }
    }
  }

  if (worktreePath && repoPath) {
    try {
      await runGit(repoPath, ["worktree", "remove", "--force", worktreePath], { env: gitEnv });
      summary.worktreeRemoved = true;
    } catch {
      await fsp.rm(worktreePath, { recursive: true, force: true }).catch(() => {});
      summary.worktreeRemoved = true;
    }
    await runGit(repoPath, ["worktree", "prune"], { env: gitEnv }).catch(() => {});
  }

  if (repoPath && Array.isArray(gitRefs) && gitRefs.length > 0) {
    for (const refName of gitRefs) {
      if (!refName) continue;
      await deleteRemoteGitRef({ repoPath, refName, gitEnv });
      summary.deletedRefs.push(refName);
    }
  }

  logger?.debug?.(`产物清理完成：${JSON.stringify(summary)}`);
  return summary;
}

/**
 * 兜底定时清理：清理超过 retentionHours 小时未 ACK 的临时运行目录与残留 worktree。
 */
export async function sweepExpiredRuns({
  runsDir,
  handoffs = {},
  retentionHours = 24,
  findRepoForHandoff,
  logger,
} = {}) {
  if (!runsDir || !fs.existsSync(runsDir)) return 0;
  const maxAgeMs = Math.max(1, Number(retentionHours) || 24) * 3600 * 1000;
  const cutoff = Date.now() - maxAgeMs;
  let cleaned = 0;

  const entries = await fsp.readdir(runsDir, { withFileTypes: true }).catch(() => []);
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const runDir = path.join(runsDir, ent.name);
    const stat = await fsp.stat(runDir).catch(() => null);
    if (!stat || stat.mtimeMs > cutoff) continue;

    const record = handoffs[ent.name];
    if (record?.purgedAt) continue;

    const repoInfo = typeof findRepoForHandoff === "function" ? findRepoForHandoff(record) : null;
    await purgeRunArtifacts({
      runDir,
      worktreePath: record?.worktreePath || "",
      repoPath: repoInfo?.repoPath || "",
      gitRefs: record?.gitRefs || [],
      gitEnv: repoInfo?.gitEnv || {},
      logger,
    });
    if (record) {
      record.purgedAt = new Date().toISOString();
    }
    cleaned += 1;
  }

  return cleaned;
}
