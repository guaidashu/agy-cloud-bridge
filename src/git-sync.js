import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isBranchAllowed, normalizeLocalMarkerFile } from "./config.js";
import { ensureDir } from "./util.js";

const execFileAsync = promisify(execFile);

export async function runGit(repoPath, args, { env = {}, timeoutMs = 60000 } = {}) {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd: repoPath,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { stdout: String(stdout || ""), stderr: String(stderr || "") };
}

export function runGitWithStdin(repoPath, args, stdinText = "", { env = {}, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: repoPath,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGKILL");
      reject(new Error(`git ${args.join(" ")} 超时`));
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`git ${args.join(" ")} 失败（exit ${code}）：${stderr.trim() || stdout.trim()}`));
      }
    });
    child.stdin.end(stdinText);
  });
}

export async function inspectRepo(repoPath, gitEnv = {}) {
  if (!repoPath || !fs.existsSync(repoPath)) {
    return { exists: false, isGit: false, branch: "", head: "", dirtyFiles: [], remoteUrl: "" };
  }
  try {
    const { stdout: inside } = await runGit(repoPath, ["rev-parse", "--is-inside-work-tree"], { env: gitEnv });
    if (inside.trim() !== "true") {
      return { exists: true, isGit: false, branch: "", head: "", dirtyFiles: [], remoteUrl: "" };
    }
  } catch {
    return { exists: true, isGit: false, branch: "", head: "", dirtyFiles: [], remoteUrl: "" };
  }

  const [branchRes, headRes, statusRes, remoteRes] = await Promise.all([
    runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"], { env: gitEnv }).catch(() => ({ stdout: "" })),
    runGit(repoPath, ["rev-parse", "HEAD"], { env: gitEnv }).catch(() => ({ stdout: "" })),
    runGit(repoPath, ["status", "--porcelain"], { env: gitEnv }).catch(() => ({ stdout: "" })),
    runGit(repoPath, ["remote", "get-url", "origin"], { env: gitEnv }).catch(() => ({ stdout: "" })),
  ]);

  const dirtyFiles = statusRes.stdout
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean);

  return {
    exists: true,
    isGit: true,
    branch: branchRes.stdout.trim(),
    head: headRes.stdout.trim(),
    dirtyFiles,
    remoteUrl: remoteRes.stdout.trim(),
  };
}

export function matchesFastPaths(changedFiles, fastPaths) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return false;
  if (!Array.isArray(fastPaths) || fastPaths.length === 0) return false;
  const regexes = fastPaths.map((pat) => new RegExp(pat));
  return changedFiles.every((file) => regexes.some((rx) => rx.test(file)));
}

export async function prepareRepoForHandoff({
  project,
  branch = "main",
  expectedCommit = "",
  handoffId,
  worktreesDir,
  skipIfUnchanged = false,
}) {
  const gitEnv = project.gitEnv || {};
  const info = await inspectRepo(project.repoPath, gitEnv);
  if (!info.exists || !info.isGit) {
    if (skipIfUnchanged) {
      return {
        ok: true,
        workingDir: project.repoPath,
        isWorktree: false,
        beforeHead: "",
        afterHead: "",
        changedFiles: [],
        branch: branch || "main",
        skippedUnchanged: true,
        preExistingDirty: false,
      };
    }
    return {
      ok: false,
      blocked: "repo_missing",
      message: `本地仓库不存在或非 Git 仓库：${project.repoPath}`,
    };
  }

  const effectiveBranch = String(branch || info.branch || "main").trim();

  const preExistingDirty = info.dirtyFiles.length > 0;

  if (skipIfUnchanged) {
    try {
      await runGit(project.repoPath, ["fetch", "origin", "--prune"], { env: gitEnv, timeoutMs: 120000 });
    } catch {
      return {
        ok: true,
        workingDir: project.repoPath,
        isWorktree: false,
        beforeHead: info.head,
        afterHead: info.head,
        changedFiles: [],
        branch: info.branch || effectiveBranch,
        skippedUnchanged: true,
        preExistingDirty,
      };
    }

    const candRef = `refs/remotes/origin/${effectiveBranch}`;
    let remoteExists = false;
    try {
      await runGit(project.repoPath, ["rev-parse", "--verify", candRef], { env: gitEnv });
      remoteExists = true;
    } catch {
      remoteExists = false;
    }
    if (!remoteExists) {
      return {
        ok: true,
        workingDir: project.repoPath,
        isWorktree: false,
        beforeHead: info.head,
        afterHead: info.head,
        changedFiles: [],
        branch: info.branch || effectiveBranch,
        skippedUnchanged: true,
        preExistingDirty,
      };
    }

    if (expectedCommit) {
      if (info.head === expectedCommit && info.branch === effectiveBranch) {
        return {
          ok: true,
          workingDir: project.repoPath,
          isWorktree: false,
          beforeHead: info.head,
          afterHead: info.head,
          changedFiles: [],
          branch: effectiveBranch,
          skippedUnchanged: true,
          preExistingDirty,
        };
      }
    } else if (info.head) {
      try {
        // 若 origin/<branch> 已是本地 HEAD 的祖先（相等或本地超前），说明云端未向该同组仓库推送新提交
        await runGit(project.repoPath, ["merge-base", "--is-ancestor", candRef, info.head], { env: gitEnv });
        return {
          ok: true,
          workingDir: project.repoPath,
          isWorktree: false,
          beforeHead: info.head,
          afterHead: info.head,
          changedFiles: [],
          branch: info.branch || effectiveBranch,
          skippedUnchanged: true,
          preExistingDirty,
        };
      } catch {
        // origin/<branch> 有新提交，继续下方同步流程
      }
    }
    branch = effectiveBranch;
  }

  if (!isBranchAllowed(branch, project.allowedBranches)) {
    return {
      ok: false,
      blocked: "branch_not_allowed",
      message: `分支 "${branch}" 不在允许白名单（${project.allowedBranches.join(", ")}）内`,
    };
  }

  if (!skipIfUnchanged) {
    await runGit(project.repoPath, ["fetch", "origin", "--prune"], { env: gitEnv, timeoutMs: 120000 });
  }

  const remoteRef = `refs/remotes/origin/${branch}`;
  try {
    await runGit(project.repoPath, ["rev-parse", "--verify", remoteRef], { env: gitEnv });
  } catch {
    return {
      ok: false,
      blocked: "remote_branch_missing",
      message: `远端分支 origin/${branch} 不存在`,
    };
  }

  if (expectedCommit) {
    try {
      await runGit(project.repoPath, ["merge-base", "--is-ancestor", expectedCommit, remoteRef], { env: gitEnv });
    } catch {
      return {
        ok: false,
        blocked: "commit_not_on_remote",
        message: `预期提交 ${expectedCommit} 尚未推送到 origin/${branch}`,
      };
    }
  }

  const beforeHead = info.head;

  if (project.dirtyPolicy === "worktree") {
    const wtPath = path.join(worktreesDir, project.id, handoffId);
    await ensureDir(path.dirname(wtPath));
    await fsp.rm(wtPath, { recursive: true, force: true });
    const targetRef = expectedCommit || remoteRef;
    await runGit(project.repoPath, ["worktree", "add", "--detach", wtPath, targetRef], { env: gitEnv });
    const markerRel = normalizeLocalMarkerFile(project.localMarkerFile);
    try {
      await runGit(wtPath, ["check-ignore", "-q", markerRel], { env: gitEnv });
      const wtMarker = path.join(wtPath, markerRel);
      if (!fs.existsSync(wtMarker)) {
        await ensureDir(path.dirname(wtMarker));
        await fsp.writeFile(
          wtMarker,
          "# Local environment marker for agy-cloud-bridge (gitignored).\n# Present => local machine; absent => cloud sandbox.\n",
          "utf8",
        );
      }
    } catch {
      // 未配置 .gitignore 忽略规则时跳过写入，避免污染 worktree git status（由 AGY_BRIDGE_LOCAL_SESSION=1 兜底）
    }
    const wtHead = (await runGit(wtPath, ["rev-parse", "HEAD"], { env: gitEnv })).stdout.trim();

    let changedFiles = [];
    if (beforeHead && wtHead && beforeHead !== wtHead) {
      const diffRes = await runGit(project.repoPath, ["diff", "--name-only", `${beforeHead}..${wtHead}`], { env: gitEnv });
      changedFiles = diffRes.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    }

    return {
      ok: true,
      workingDir: wtPath,
      isWorktree: true,
      beforeHead,
      afterHead: wtHead,
      changedFiles,
      branch,
      preExistingDirty: false,
    };
  }

  // 默认 safe-block：若工作区有未提交修改则直接安全阻断
  if (info.dirtyFiles.length > 0) {
    return {
      ok: false,
      blocked: "dirty_tree",
      dirtyFiles: info.dirtyFiles,
      message: `本地仓库存在 ${info.dirtyFiles.length} 项未提交改动，已安全阻断同步以防覆盖本地代码`,
    };
  }

  if (info.branch !== branch) {
    let hasLocalBranch = false;
    try {
      await runGit(project.repoPath, ["show-ref", "--verify", `refs/heads/${branch}`], { env: gitEnv });
      hasLocalBranch = true;
    } catch {
      hasLocalBranch = false;
    }
    if (hasLocalBranch) {
      await runGit(project.repoPath, ["checkout", branch], { env: gitEnv });
    } else {
      await runGit(project.repoPath, ["checkout", "-b", branch, remoteRef], { env: gitEnv });
    }
  }

  await runGit(project.repoPath, ["pull", "--ff-only", "origin", branch], { env: gitEnv, timeoutMs: 120000 });
  const afterHead = (await runGit(project.repoPath, ["rev-parse", "HEAD"], { env: gitEnv })).stdout.trim();

  let changedFiles = [];
  if (beforeHead && afterHead && beforeHead !== afterHead) {
    const diffRes = await runGit(project.repoPath, ["diff", "--name-only", `${beforeHead}..${afterHead}`], { env: gitEnv });
    changedFiles = diffRes.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  }

  return {
    ok: true,
    workingDir: project.repoPath,
    isWorktree: false,
    beforeHead,
    afterHead,
    changedFiles,
    branch,
    preExistingDirty: false,
  };
}

/**
 * Post-flight 安全兜底：在本地 agy 退出后，若仓库仍残留未提交/未跟踪改动，
 * 执行 `git stash push -u -m "agy-bridge-leftover:<handoffId>"` 将其安全暂存，
 * 既不丢失任何文件（保留 gitignored 标记文件如 .agy-local），又防止下一轮派发锁死在 phase=dirty_tree。
 */
export async function stashRepoLeftovers({ repoPath, handoffId = "unknown", message = "", gitEnv = {} }) {
  const info = await inspectRepo(repoPath, gitEnv);
  if (!info.exists || !info.isGit) {
    return {
      ok: true,
      stashed: false,
      dirtyFiles: [],
      remainingDirtyFiles: [],
      stashMessage: "",
      stashRef: "",
      stashSha: "",
      head: "",
      branch: "",
      error: "",
    };
  }
  if (info.dirtyFiles.length === 0) {
    return {
      ok: true,
      stashed: false,
      dirtyFiles: [],
      remainingDirtyFiles: [],
      stashMessage: "",
      stashRef: "",
      stashSha: "",
      head: info.head,
      branch: info.branch,
      error: "",
    };
  }

  const cleanId = String(handoffId || "unknown").replace(/[\r\n]+/g, " ").trim() || "unknown";
  const stashMessage = String(message || `agy-bridge-leftover:${cleanId}`).replace(/[\r\n]+/g, " ").trim();

  try {
    try {
      await runGit(repoPath, ["stash", "push", "-u", "-m", stashMessage], { env: gitEnv, timeoutMs: 60000 });
    } catch (err) {
      const detail = `${err?.stderr || ""}\n${err?.stdout || ""}\n${err?.message || ""}`;
      if (/Author identity unknown|unable to auto-detect email|please tell me who you are/i.test(detail)) {
        await runGit(
          repoPath,
          ["-c", "user.name=agy-bridge", "-c", "user.email=agy-bridge@local", "stash", "push", "-u", "-m", stashMessage],
          { env: gitEnv, timeoutMs: 60000 },
        );
      } else {
        throw err;
      }
    }

    const after = await inspectRepo(repoPath, gitEnv);
    let stashRef = "";
    let stashSha = "";
    let stashed = false;
    try {
      const { stdout } = await runGit(repoPath, ["stash", "list", "-n", "1", "--format=%H\t%gd\t%s"], { env: gitEnv });
      const topLine = stdout.trim().split("\n")[0] || "";
      const [sha = "", ref = "", subject = ""] = topLine.split("\t");
      if (sha && subject.includes(stashMessage)) {
        stashed = true;
        stashSha = sha.trim();
        stashRef = ref.trim() || "stash@{0}";
      }
    } catch {
      // 忽略读取 stash list 失败
    }

    return {
      ok: after.dirtyFiles.length === 0,
      stashed,
      dirtyFiles: info.dirtyFiles,
      remainingDirtyFiles: after.dirtyFiles,
      stashMessage: stashed ? stashMessage : "",
      stashRef: stashed ? stashRef : "",
      stashSha: stashed ? stashSha : "",
      head: after.head,
      branch: after.branch,
      error: after.dirtyFiles.length > 0 && !stashed ? "git stash push 未能清理全部残留改动" : "",
    };
  } catch (err) {
    const after = await inspectRepo(repoPath, gitEnv).catch(() => info);
    return {
      ok: false,
      stashed: false,
      dirtyFiles: info.dirtyFiles,
      remainingDirtyFiles: after.dirtyFiles,
      stashMessage,
      stashRef: "",
      stashSha: "",
      head: after.head,
      branch: after.branch,
      error: err?.stderr?.trim?.() || err?.message || String(err),
    };
  }
}

/**
 * 通过 Git plumbing 在独立远端引用（refs/heads/agy-collab/...）写入单文件 JSON，
 * 完全不修改工作区与主分支提交历史。
 */
export async function publishGitRefJson({ repoPath, refName, filename = "payload.json", payload, gitEnv = {} }) {
  const jsonText = `${JSON.stringify(payload, null, 2)}\n`;
  const { stdout: blobOut } = await runGitWithStdin(repoPath, ["hash-object", "-w", "--stdin"], jsonText, { env: gitEnv });
  const blobSha = blobOut.trim();
  const { stdout: treeOut } = await runGitWithStdin(repoPath, ["mktree"], `100644 blob ${blobSha}\t${filename}\n`, {
    env: gitEnv,
  });
  const treeSha = treeOut.trim();
  const { stdout: commitOut } = await runGitWithStdin(
    repoPath,
    ["commit-tree", treeSha, "-m", `agy-collab: ${refName}`],
    "",
    { env: gitEnv },
  );
  const commitSha = commitOut.trim();
  await runGit(repoPath, ["push", "-f", "origin", `${commitSha}:refs/heads/${refName}`], {
    env: gitEnv,
    timeoutMs: 120000,
  });
  return { refName, commitSha };
}

export async function readGitRefJson({ repoPath, refName, filename = "payload.json", gitEnv = {} }) {
  await runGit(repoPath, ["fetch", "origin", `refs/heads/${refName}`], { env: gitEnv, timeoutMs: 120000 });
  const fetchSha = (await runGit(repoPath, ["rev-parse", "FETCH_HEAD"], { env: gitEnv })).stdout.trim();
  const { stdout } = await runGit(repoPath, ["show", `${fetchSha}:${filename}`], { env: gitEnv });
  return JSON.parse(stdout);
}

export async function deleteRemoteGitRef({ repoPath, refName, gitEnv = {} }) {
  if (!refName) return;
  try {
    await runGit(repoPath, ["push", "origin", `:refs/heads/${refName}`], { env: gitEnv, timeoutMs: 60000 });
  } catch {
    // 远端分支可能已被消费清理，忽略不存在的错误
  }
}

export async function listGitRefRequests({ repoPath, prefix = "agy-collab/req-", gitEnv = {} }) {
  const { stdout } = await runGit(repoPath, ["ls-remote", "--heads", "origin", `${prefix}*`], {
    env: gitEnv,
    timeoutMs: 60000,
  });
  const refs = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [sha, fullRef] = trimmed.split(/\s+/);
    if (sha && fullRef?.startsWith("refs/heads/")) {
      refs.push({ sha, refName: fullRef.slice("refs/heads/".length) });
    }
  }
  return refs;
}
