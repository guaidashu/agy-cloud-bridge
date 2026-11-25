import fs from "node:fs";
import path from "node:path";
import { runAgy } from "./agy-runner.js";
import { inspectRepoHygiene, purgeRunArtifacts, recoverPostFlightRepoHygiene, sweepExpiredRuns } from "./cleanup.js";
import { canAccessPeerProject, findGroupPeers, findProject, loadConfig } from "./config.js";
import {
  listGitRefRequests,
  matchesFastPaths,
  prepareRepoForHandoff,
  publishGitRefJson,
  readGitRefJson,
  runGit,
} from "./git-sync.js";
import { createRedactor, redactValue } from "./redact.js";
import { ensureDir, errorSummary, expandPath, readJson, Semaphore, shortId, writeJsonAtomic } from "./util.js";
import { syncBridgeWorkspace } from "./workspace.js";

const TERMINAL_STATUSES = new Set(["succeeded", "fast_synced", "failed", "blocked", "cancelled"]);
const AGENT_REQUIRED_TASK_TYPES = new Set(["preview_and_test", "debug_and_fix", "deploy_restart"]);

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

export function buildBridgeClosingContract({ record, project, peerPreps = [], runScratchDir }) {
  const pushablePeers = peerPreps.filter((p) => p.project?.allowGitPush);
  const noPushPeers = peerPreps.filter((p) => !p.project?.allowGitPush);

  const commitRule = project.allowGitPush
    ? `2. **合法改动必须提交并推送**：对本次合法修复或构建/编辑器自动生成的受控文件（如 \`.meta\`、lockfile、自动生成代码等），必须在对应仓库用清晰的中文 commit message 执行 \`git add\`、\`git commit\` 与 \`git push\` 推回当前分支 \`${record.branch || "main"}\`（禁止 \`--force\`），以便网关自动记录 \`pushedCommit\` 并供云端 \`--pull\` 同步；${
        noPushPeers.length > 0
          ? `（注意：同组仓库 ${noPushPeers.map((p) => `\`${p.project.id}\``).join("、")} 已禁用 \`allowGitPush\`，请勿对其执行 \`git push\`，需还原/清理其工作区改动并在 summary 中给出建议）`
          : ""
      }`
    : `2. **受限推送策略（\`allowGitPush=false\`）**：当前主项目禁止自动 \`git push\`，请勿对主仓库执行 \`git push\`；若发现问题请在 \`summary\` 中给出精确修改建议，并还原或清理主仓库内的临时/调试改动；${
        pushablePeers.length > 0
          ? `（同组开启推送的仓库 ${pushablePeers.map((p) => `\`${p.project.id}\``).join("、")} 如做了合法修复，请正常 \`git commit && git push\` 推回其当前分支）`
          : ""
      }`;

  return [
    "### 【桥接强制收尾契约】",
    "1. **退出前强制检查工作区**：动手前务必先进入对应目标仓库目录执行命令与测试；退出前必须对所有涉及仓库执行 `git status --porcelain` 检查工作区状态；",
    commitRule,
    `3. **无意义构建噪音立即还原**：对无意义构建噪音、临时调试修改必须执行 \`git checkout -- <file>\`（或 \`git restore\`）还原；所有截图、日志、临时产物仅可写入隔离暂存目录 \`${runScratchDir}\` 或立即删除，严禁留在业务仓库；`,
    `4. **工作区清零断言（\`dirtyCount=0\`）**：退出前务必确保各涉及仓库 \`git status --porcelain\` 输出为空；若退出时仍有残留未提交改动，网关 Post-flight 将自动执行 \`git stash push -u -m "agy-bridge-leftover:${record.handoffId}"\` 安全暂存并向云端追加告警；`,
    "5. **结构化回传**：回答最末尾必须按 workspace `AGENTS.md` 规定输出 `<<<AGY_RESULT_JSON>>> ... <<<END_AGY_RESULT_JSON>>>`。",
  ].join("\n");
}

function formatPostFlightWarning(projectId, hygiene) {
  if (!hygiene) return "";
  if (hygiene.leftoversStashed) {
    const files = Array.isArray(hygiene.stashedFiles) ? hygiene.stashedFiles : [];
    const preview =
      files.length > 10
        ? `${files.slice(0, 10).join(", ")} 等共 ${files.length} 项`
        : files.join(", ") || "（详见 git stash show）";
    const refText = hygiene.stashRef ? `（${hygiene.stashRef}）` : "";
    const remainNote =
      Array.isArray(hygiene.dirtyFiles) && hygiene.dirtyFiles.length > 0
        ? `；注意暂存后仍剩余 ${hygiene.dirtyFiles.length} 项未清理改动（${hygiene.dirtyFiles.slice(0, 5).join(", ")}）`
        : "";
    return `[Post-flight 告警] 项目 ${projectId} 在本地 agy 退出后残留 ${files.length || "若干"} 项未提交改动（${preview}），已自动执行 \`git stash push -u -m "${hygiene.stashMessage}"\`${refText} 安全暂存以防下一轮派发锁死在 phase=dirty_tree${remainNote}。请核对暂存内容：若为合法产物请本机 \`git stash pop\` 后提交推送，若为噪音可 \`git stash drop\`。`;
  }
  if (!hygiene.clean && !hygiene.autoStashSkipped) {
    const files = Array.isArray(hygiene.dirtyFiles) ? hygiene.dirtyFiles : [];
    const preview =
      files.length > 10
        ? `${files.slice(0, 10).join(", ")} 等共 ${files.length} 项`
        : files.join(", ");
    return `[Post-flight 告警] 项目 ${projectId} 在本地 agy 退出后残留 ${files.length} 项未提交改动（${preview}），但自动 \`git stash push -u\` 失败（${hygiene.stashError || "工作区仍非干净"}），下一轮可能触发 phase=dirty_tree，请人工处理。`;
  }
  return "";
}

export function buildAgyPrompt({ record, project, prep, peerPreps = [], runScratchDir }) {
  const changedList =
    prep.changedFiles.length > 0 ? prep.changedFiles.map((f) => `- ${f}`).join("\n") : "- （本次为同分支/同提交复测或无增量文件列表）";

  const multiRepoSection =
    peerPreps.length > 0
      ? [
          "",
          `### 本轮多仓库变更感知清单（分组：\`${project.group || "default"}\`）`,
          `- **[主触发仓 · ${prep.changedFiles.length > 0 || prep.beforeHead !== prep.afterHead ? "有变更" : "无增量变更"}] \`${project.id}\`**（\`${prep.workingDir}\`，\`${prep.branch}\` \`${(prep.beforeHead || "").slice(0, 8)} -> ${(prep.afterHead || "").slice(0, 8)}\`）`,
          ...(prep.changedFiles.length > 0 ? prep.changedFiles.slice(0, 30).map((f) => `  - \`${f}\``) : ["  - （无新增提交文件）"]),
          ...peerPreps.flatMap((tp) => {
            const hasDiff = tp.changedFiles.length > 0 || (tp.beforeHead && tp.afterHead && tp.beforeHead !== tp.afterHead);
            const lines = [
              `- **[同组关联仓 · ${hasDiff ? "有变更" : "未变更"}] \`${tp.project.id}\`**（\`${tp.workingDir}\`，\`${tp.branch}\` @ \`${(tp.afterHead || "").slice(0, 8)}\`）`,
            ];
            if (hasDiff && tp.changedFiles.length > 0) {
              for (const f of tp.changedFiles.slice(0, 30)) lines.push(`  - \`${f}\``);
            }
            if (tp.project.localContext) {
              lines.push(`  - 仓库说明：${tp.project.localContext}`);
            }
            return lines;
          }),
          "",
          "> **多仓执行指引**：请根据上方标注为「有变更」的仓库与文件，按各仓约定执行对应的编译、服务热重载、测试或联调；标注为「未变更」的关联仓库无需无故重启，仅在跨仓接口联调或定位问题需要时读取或联动修复。",
        ].join("\n")
      : [
          "",
          "### 本轮变更文件",
          changedList,
        ].join("\n");

  return [
    `## 云端协同任务派发（${record.handoffId}）`,
    `- **所属项目**：${project.name || project.id}（${project.id}${project.group ? ` · 组 ${project.group}` : ""}）`,
    `- **工作流 / 轮次**：${record.workflowId} · 第 ${record.round} 轮`,
    `- **主仓库目录**：\`${prep.workingDir}\``,
    `- **分支与提交**：\`${record.branch}\` @ \`${prep.afterHead.slice(0, 12)}\``,
    `- **隔离暂存目录（请把截图/测试日志写入此目录，勿留在业务仓库）**：\`${runScratchDir}\``,
    multiRepoSection,
    "",
    "### 云端交办任务说明",
    record.task || "请拉取检查最新代码，按项目约定执行本地验证/部署检查，并反馈结果。",
    "",
    buildBridgeClosingContract({ record, project, peerPreps, runScratchDir }),
  ].join("\n");
}

export class Orchestrator {
  constructor({
    home,
    config,
    logger,
    adapters = {},
  }) {
    this.home = home;
    this.config = config;
    this.logger = logger;
    this.adapters = {
      runAgy,
      prepareRepoForHandoff,
      inspectRepoHygiene,
      recoverPostFlightRepoHygiene,
      purgeRunArtifacts,
      syncBridgeWorkspace,
      publishGitRefJson,
      readGitRefJson,
      listGitRefRequests,
      ...adapters,
    };

    this.stateFile = path.join(this.home, "state.json");
    this.runsDir = config.runtime?.runsDir ? expandPath(config.runtime.runsDir) : path.join(this.home, "runs");
    this.worktreesDir = config.runtime?.worktreesDir
      ? expandPath(config.runtime.worktreesDir)
      : path.join(this.home, "worktrees");

    this.state = { handoffs: {}, workflows: {} };
    this.projectQueues = new Map();
    this.semaphore = new Semaphore(config.runtime?.concurrency || 2);
    this.waiters = new Map();
    this.abortControllers = new Map();
    this.redactor = createRedactor({ config, home: this.home });
    this.sweepTimer = null;
    this.gitWatchTimer = null;
    this.configStamp = "";
  }

  async init() {
    await ensureDir(this.home, 0o700);
    await ensureDir(this.runsDir);
    await ensureDir(this.worktreesDir);
    const saved = await readJson(this.stateFile, null);
    if (saved && typeof saved === "object") {
      this.state = {
        handoffs: saved.handoffs && typeof saved.handoffs === "object" ? saved.handoffs : {},
        workflows: saved.workflows && typeof saved.workflows === "object" ? saved.workflows : {},
      };
    }
    this.startTimers();
  }

  startTimers() {
    const intervalMin = Math.max(1, Number(this.config.cleanup?.sweepIntervalMin) || 30);
    this.sweepTimer = setInterval(() => {
      this.runSweep().catch((err) => this.logger?.warn?.(`定时清理异常：${errorSummary(err)}`));
    }, intervalMin * 60 * 1000);
    this.sweepTimer.unref?.();

    if (this.config.gitWatcher?.enabled) {
      const sec = Math.max(5, Number(this.config.gitWatcher.intervalSec) || 20);
      this.gitWatchTimer = setInterval(() => {
        this.pollGitRefRequests().catch((err) => this.logger?.debug?.(`git-ref 轮询异常：${errorSummary(err)}`));
      }, sec * 1000);
      this.gitWatchTimer.unref?.();
    }
  }

  async close() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.gitWatchTimer) clearInterval(this.gitWatchTimer);
    for (const ac of this.abortControllers.values()) {
      ac.abort();
    }
  }

  async refreshConfigIfChanged() {
    const cfgPath = path.join(this.home, "config.json");
    let stat;
    try {
      stat = await fs.promises.stat(cfgPath);
    } catch {
      return;
    }
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    if (stamp === this.configStamp) return;
    this.configStamp = stamp;
    try {
      const { config } = await loadConfig({ home: this.home });
      this.config = config;
      this.runsDir = config.runtime?.runsDir ? expandPath(config.runtime.runsDir) : path.join(this.home, "runs");
      this.worktreesDir = config.runtime?.worktreesDir
        ? expandPath(config.runtime.worktreesDir)
        : path.join(this.home, "worktrees");
      this.redactor = createRedactor({ config, home: this.home });
      this.logger?.info?.(`配置已热加载：已登记 ${config.projects.length} 个项目`);
    } catch (err) {
      this.logger?.warn?.(`配置热加载失败：${errorSummary(err)}`);
    }
  }

  async saveState() {
    const entries = Object.entries(this.state.handoffs);
    const maxHistory = Math.max(20, Number(this.config.runtime?.maxHistoryRecords) || 200);
    if (entries.length > maxHistory) {
      entries.sort((a, b) => String(b[1]?.createdAt || "").localeCompare(String(a[1]?.createdAt || "")));
      const trimmed = {};
      for (const [k, v] of entries.slice(0, maxHistory)) trimmed[k] = v;
      this.state.handoffs = trimmed;
    }
    await writeJsonAtomic(this.stateFile, this.state);
  }

  notifyWaiters(handoffId) {
    const set = this.waiters.get(handoffId);
    if (!set) return;
    for (const resolve of set) {
      resolve(this.getHandoff(handoffId));
    }
    set.clear();
    this.waiters.delete(handoffId);
  }

  getHandoff(handoffId) {
    const rec = this.state.handoffs[handoffId];
    return rec ? structuredClone(rec) : null;
  }

  listHandoffs(limit = 30, projectIdFilter = "") {
    return Object.values(this.state.handoffs)
      .filter((r) => !projectIdFilter || r.projectId === projectIdFilter)
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
      .slice(0, limit)
      .map((r) => ({
        handoffId: r.handoffId,
        workflowId: r.workflowId,
        round: r.round,
        projectId: r.projectId,
        branch: r.branch,
        status: r.status,
        phase: r.phase,
        summary: r.summary,
        createdAt: r.createdAt,
        finishedAt: r.finishedAt,
        ackedAt: r.ackedAt,
      }));
  }

  async waitForHandoff(handoffId, timeoutSec = 60) {
    const current = this.getHandoff(handoffId);
    if (!current) return null;
    if (isTerminalStatus(current.status)) return current;

    const maxWait = Math.max(1, Number(this.config.runtime?.waitMaxSeconds) || 300);
    const clampedSec = Math.max(1, Math.min(Number(timeoutSec) || 60, maxWait));

    return new Promise((resolve) => {
      let set = this.waiters.get(handoffId);
      if (!set) {
        set = new Set();
        this.waiters.set(handoffId, set);
      }

      const onDone = (latest) => {
        clearTimeout(timer);
        resolve(latest);
      };

      const timer = setTimeout(() => {
        set.delete(onDone);
        if (set.size === 0) this.waiters.delete(handoffId);
        resolve(this.getHandoff(handoffId));
      }, clampedSec * 1000);
      timer.unref?.();

      set.add(onDone);
    });
  }

  async dispatchHandoff(input = {}) {
    await this.refreshConfigIfChanged();

    const project = findProject(this.config, {
      projectId: input.projectId || input.project,
      repoUrl: input.repoUrl || input.remoteUrl,
    });
    if (!project) {
      const err = new Error(`未找到已登记项目（project=${input.projectId || input.project || "-"}, repoUrl=${input.repoUrl || "-"}）`);
      err.statusCode = 404;
      err.code = "PROJECT_NOT_FOUND";
      throw err;
    }

    const handoffId = String(input.handoffId || "").trim() || shortId("ho");
    const existing = this.getHandoff(handoffId);
    if (existing) {
      return { replay: true, record: existing };
    }

    const workflowId = String(input.workflowId || "").trim() || handoffId;
    const wf = this.state.workflows[workflowId] || {
      projectId: project.id,
      rounds: 0,
      conversationId: "",
      createdAt: new Date().toISOString(),
    };

    const maxRounds = Math.max(1, Number(input.maxRounds || project.maxRounds || this.config.runtime?.defaultMaxRounds || 5));
    if (wf.rounds >= maxRounds) {
      const err = new Error(`工作流 ${workflowId} 已达到最大往返轮次限制（${wf.rounds}/${maxRounds}），触发防死循环熔断`);
      err.statusCode = 429;
      err.code = "MAX_ROUNDS_EXCEEDED";
      throw err;
    }

    wf.rounds += 1;
    wf.updatedAt = new Date().toISOString();
    this.state.workflows[workflowId] = wf;

    const record = {
      handoffId,
      workflowId,
      round: wf.rounds,
      projectId: project.id,
      projectName: project.name,
      branch: String(input.branch || "main").trim(),
      expectedCommit: String(input.commit || input.expectedCommit || "").trim(),
      taskType: String(input.taskType || "custom_agent_task").trim(),
      mode: ["auto", "agent", "sync"].includes(input.mode) ? input.mode : "auto",
      resultChannel: input.resultChannel === "git-ref" ? "git-ref" : "http",
      task: String(input.task || "").trim(),
      hintChangedFiles: Array.isArray(input.changedFiles) ? input.changedFiles.map(String) : [],
      requestedTargets: Array.isArray(input.targets) ? structuredClone(input.targets) : [],
      autoPeers: input.autoPeers !== false,
      group: project.group || "",
      status: "queued",
      phase: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      ackedAt: null,
      purgedAt: null,
      beforeHead: "",
      afterHead: "",
      pushedCommit: "",
      pushedCommits: {},
      changedProjects: [],
      targets: [],
      changedFiles: [],
      hygiene: null,
      result: null,
      summary: "",
      error: "",
      worktreePath: "",
      extraWorktrees: [],
      gitRefs: Array.isArray(input.gitRefs) ? [...input.gitRefs] : [],
      conversationId: wf.conversationId || "",
    };

    this.state.handoffs[handoffId] = record;
    await this.saveState();

    const ac = new AbortController();
    this.abortControllers.set(handoffId, ac);

    const queueKey = project.group ? `group:${project.group}` : project.id;
    const prevQueue = this.projectQueues.get(queueKey) || Promise.resolve();
    const runPromise = prevQueue
      .catch(() => {})
      .then(async () => {
        const release = await this.semaphore.acquire();
        try {
          await this.executeHandoff(handoffId, project, ac.signal);
        } finally {
          release();
        }
      })
      .finally(() => {
        this.abortControllers.delete(handoffId);
      });

    this.projectQueues.set(queueKey, runPromise);
    return { replay: false, record: structuredClone(record) };
  }

  async executeHandoff(handoffId, project, signal) {
    const rec = this.state.handoffs[handoffId];
    if (!rec) return;
    if (signal.aborted || rec.status === "cancelled") {
      rec.status = "cancelled";
      rec.phase = "cancelled";
      rec.finishedAt = new Date().toISOString();
      rec.updatedAt = rec.finishedAt;
      await this.saveState();
      this.notifyWaiters(handoffId);
      return;
    }

    const redactText = (txt) => (this.config.security?.redact === false ? String(txt ?? "") : this.redactor(String(txt ?? "")).text);
    const redactObj = (obj) => (this.config.security?.redact === false ? obj : redactValue(obj, this.redactor));

    rec.status = "running";
    rec.phase = "git_sync";
    rec.startedAt = new Date().toISOString();
    rec.updatedAt = rec.startedAt;
    await this.saveState();

    let prep;
    try {
      prep = await this.adapters.prepareRepoForHandoff({
        project,
        branch: rec.branch,
        expectedCommit: rec.expectedCommit,
        handoffId,
        worktreesDir: this.worktreesDir,
      });
    } catch (err) {
      rec.status = "failed";
      rec.phase = "git_sync_failed";
      rec.error = redactText(errorSummary(err));
      rec.summary = `Git 同步失败：${rec.error}`;
      rec.finishedAt = new Date().toISOString();
      rec.updatedAt = rec.finishedAt;
      await this.saveState();
      this.notifyWaiters(handoffId);
      return;
    }

    if (!prep.ok) {
      rec.status = "blocked";
      rec.phase = prep.blocked || "blocked";
      rec.error = redactText(prep.message || "前置检查未通过");
      rec.summary = rec.error;
      rec.result = redactObj({
        status: "blocked",
        reason: prep.blocked,
        dirtyFiles: prep.dirtyFiles || [],
      });
      rec.finishedAt = new Date().toISOString();
      rec.updatedAt = rec.finishedAt;
      await this.saveState();
      this.notifyWaiters(handoffId);
      await this.maybeNotifyWebhook(rec);
      return;
    }

    rec.beforeHead = prep.beforeHead;
    rec.afterHead = prep.afterHead;
    rec.changedFiles = prep.changedFiles;
    if (prep.isWorktree) rec.worktreePath = prep.workingDir;

    // 解析并增量同步同组多仓库目标（仅拉取云端有新增提交的关联仓库，未变更仓库零开销跳过）
    const peerSpecs = [];
    const seenIds = new Set([project.id]);
    if (Array.isArray(rec.requestedTargets)) {
      for (const rawT of rec.requestedTargets) {
        if (!rawT || typeof rawT !== "object") continue;
        const tp = findProject(this.config, {
          projectId: rawT.projectId || rawT.project,
          repoUrl: rawT.repoUrl || rawT.remoteUrl,
        });
        if (!tp || seenIds.has(tp.id) || !canAccessPeerProject(project, tp)) continue;
        seenIds.add(tp.id);
        peerSpecs.push({
          project: tp,
          branch: String(rawT.branch || "main").trim(),
          expectedCommit: String(rawT.commit || rawT.expectedCommit || "").trim(),
        });
      }
    }
    if (rec.autoPeers !== false && project.group) {
      for (const gp of findGroupPeers(this.config, project)) {
        if (seenIds.has(gp.id)) continue;
        seenIds.add(gp.id);
        peerSpecs.push({ project: gp, branch: "", expectedCommit: "" });
      }
    }

    const peerPreps = [];
    for (const spec of peerSpecs) {
      let tpPrep;
      try {
        tpPrep = await this.adapters.prepareRepoForHandoff({
          project: spec.project,
          branch: spec.branch || "main",
          expectedCommit: spec.expectedCommit,
          handoffId,
          worktreesDir: this.worktreesDir,
          skipIfUnchanged: true,
        });
      } catch (err) {
        rec.status = "failed";
        rec.phase = "git_sync_failed";
        rec.error = redactText(`[${spec.project.id}] Git 同步失败：${errorSummary(err)}`);
        rec.summary = rec.error;
        rec.finishedAt = new Date().toISOString();
        rec.updatedAt = rec.finishedAt;
        await this.saveState();
        this.notifyWaiters(handoffId);
        return;
      }

      if (!tpPrep.ok) {
        rec.status = "blocked";
        rec.phase = tpPrep.blocked || "blocked";
        rec.error = redactText(`[${spec.project.id}] ${tpPrep.message || "前置检查未通过"}`);
        rec.summary = rec.error;
        rec.result = redactObj({
          status: "blocked",
          projectId: spec.project.id,
          reason: tpPrep.blocked,
          dirtyFiles: tpPrep.dirtyFiles || [],
        });
        rec.finishedAt = new Date().toISOString();
        rec.updatedAt = rec.finishedAt;
        await this.saveState();
        this.notifyWaiters(handoffId);
        await this.maybeNotifyWebhook(rec);
        return;
      }

      if (tpPrep.isWorktree) {
        rec.extraWorktrees.push({ repoPath: spec.project.repoPath, worktreePath: tpPrep.workingDir, gitEnv: spec.project.gitEnv || {} });
      }
      const changed = tpPrep.changedFiles.length > 0 || Boolean(tpPrep.beforeHead && tpPrep.afterHead && tpPrep.beforeHead !== tpPrep.afterHead);
      peerPreps.push({ ...tpPrep, project: spec.project, changed });
    }

    const primaryChanged = prep.changedFiles.length > 0 || Boolean(prep.beforeHead && prep.afterHead && prep.beforeHead !== prep.afterHead);
    const changedProjects = [
      ...(primaryChanged ? [project.id] : []),
      ...peerPreps.filter((p) => p.changed).map((p) => p.project.id),
    ];
    rec.changedProjects = changedProjects;
    rec.targets = [
      {
        projectId: project.id,
        workingDir: prep.workingDir,
        branch: prep.branch,
        changed: primaryChanged,
        beforeHead: prep.beforeHead,
        afterHead: prep.afterHead,
        changedFiles: prep.changedFiles,
        pushedCommit: "",
      },
      ...peerPreps.map((p) => ({
        projectId: p.project.id,
        workingDir: p.workingDir,
        branch: p.branch,
        changed: p.changed,
        skippedUnchanged: Boolean(p.skippedUnchanged),
        beforeHead: p.beforeHead,
        afterHead: p.afterHead,
        changedFiles: p.changedFiles,
        pushedCommit: "",
      })),
    ];

    const filesForFastCheck = prep.changedFiles.length > 0 ? prep.changedFiles : rec.hintChangedFiles;
    const isAgentRequired = rec.mode === "agent" || AGENT_REQUIRED_TASK_TYPES.has(rec.taskType);
    const changedPeerPreps = peerPreps.filter((p) => p.changed);
    const allChangedMatchFastPaths =
      changedPeerPreps.length === 0
        ? matchesFastPaths(filesForFastCheck, project.fastPaths)
        : (primaryChanged ? matchesFastPaths(prep.changedFiles, project.fastPaths) : true) &&
          changedPeerPreps.every((p) => matchesFastPaths(p.changedFiles, p.project.fastPaths));
    const canFastSync = rec.mode === "sync" || (!isAgentRequired && allChangedMatchFastPaths);

    if (canFastSync) {
      rec.status = "fast_synced";
      rec.phase = "completed";
      const totalChangedCount = filesForFastCheck.length + changedPeerPreps.reduce((acc, p) => acc + p.changedFiles.length, 0);
      rec.summary =
        changedProjects.length > 1
          ? `命中多仓 fastPaths 零 Token 快速拉取（${changedProjects.join(", ")}）：共 ${totalChangedCount} 个文件`
          : `命中 fastPaths 零 Token 快速拉取：已同步 ${filesForFastCheck.length} 个文件（${filesForFastCheck.slice(0, 8).join(", ")}）`;
      rec.result = {
        status: "ok",
        fastSync: true,
        testsPassed: true,
        changedProjects,
        changedFiles: filesForFastCheck,
        pushedCommit: "",
        pushedCommits: {},
      };
      rec.finishedAt = new Date().toISOString();
      rec.updatedAt = rec.finishedAt;
      await this.maybePublishGitRefResult(rec, project);
      await this.saveState();
      this.notifyWaiters(handoffId);
      await this.maybeNotifyWebhook(rec);
      return;
    }

    // Agent Mode via exit proxy launcher
    const runDir = path.join(this.runsDir, handoffId);
    const runScratchDir = path.join(runDir, "scratch");
    await ensureDir(runScratchDir);

    rec.phase = "preparing_workspace";
    rec.updatedAt = new Date().toISOString();
    await this.saveState();

    const { workspace } = await this.adapters.syncBridgeWorkspace({
      home: this.home,
      project,
      repoWorkingDir: prep.workingDir,
      runScratchDir,
      allowPush: project.allowGitPush,
      peerTargets: peerPreps,
    });

    const prompt = buildAgyPrompt({ record: rec, project, prep, peerPreps, runScratchDir });
    const allWriteDirs = Array.from(new Set([prep.workingDir, ...peerPreps.map((p) => p.workingDir), runScratchDir]));
    const allRepoDirs = Array.from(
      new Set([
        prep.workingDir,
        runScratchDir,
        ...peerPreps.map((p) => p.workingDir),
        ...(project.extraReadRoots || []),
        ...peerPreps.flatMap((p) => p.project.extraReadRoots || []),
      ]),
    );
    const extraEnv = {
      AGY_BRIDGE_LOCAL_SESSION: "1",
      AGY_BRIDGE_GUARD_WRITE_ROOTS: JSON.stringify(allWriteDirs),
      AGY_BRIDGE_GUARD_DENY: JSON.stringify(this.config.security?.deniedReadRoots || []),
      AGY_BRIDGE_ALLOW_PUSH: project.allowGitPush ? "1" : "0",
    };

    rec.phase = "running_agy";
    rec.updatedAt = new Date().toISOString();
    await this.saveState();

    this.logger?.info?.(
      `[${handoffId}] 开始通过代理执行本地 agy（项目 ${project.id}${changedProjects.length ? `，变更仓: ${changedProjects.join(",")}` : ""}，第 ${rec.round} 轮）`,
    );

    // 若同 workflow 续聊复用了上一轮 conversationId，临时补齐已被 --ack 清理的历史轮次空 scratch 目录，
    // 防止 agy 恢复会话句柄时因历史 CWD 不存在导致 run_command 报 no such directory；执行完立即移除空壳。
    const tempCompatDirs = [];
    if (rec.conversationId) {
      for (const prev of Object.values(this.state.handoffs)) {
        if (!prev || prev.handoffId === handoffId || prev.workflowId !== rec.workflowId) continue;
        const prevScratch = path.join(this.runsDir, prev.handoffId, "scratch");
        if (!fs.existsSync(prevScratch)) {
          await ensureDir(prevScratch).catch(() => {});
          tempCompatDirs.push(prevScratch);
        }
      }
    }

    let agyRes;
    try {
      agyRes = await this.adapters.runAgy({
        config: this.config,
        cwd: workspace,
        task: prompt,
        conversationId: rec.conversationId,
        repoPaths: allRepoDirs,
        sandbox: typeof project.sandbox === "boolean" ? project.sandbox : undefined,
        extraEnv,
        signal,
        logger: this.logger,
      });
    } catch (err) {
      agyRes = {
        ok: false,
        conversationId: rec.conversationId || "",
        text: "",
        structured: null,
        exitCode: null,
        timedOut: false,
        aborted: Boolean(signal?.aborted),
        durationMs: 0,
        error: errorSummary(err),
        reason: { kind: "error", error: { message: errorSummary(err) } },
      };
    } finally {
      for (const compatDir of tempCompatDirs) {
        try {
          const items = await fs.promises.readdir(compatDir);
          if (items.length === 0) {
            await fs.promises.rmdir(compatDir);
          }
        } catch {
          /* ignore */
        }
      }
    }

    if (agyRes.conversationId) {
      rec.conversationId = agyRes.conversationId;
      if (this.state.workflows[rec.workflowId]) {
        this.state.workflows[rec.workflowId].conversationId = agyRes.conversationId;
      }
    }

    // Post-flight 自动兜底：无论本地 agy 成功、报错、超时还是取消，
    // 均检查涉及仓库 git status --porcelain；若有残留改动则自动 git stash push -u 安全暂存。
    const primaryHygieneRaw = await this.adapters.recoverPostFlightRepoHygiene({
      repoPath: prep.workingDir,
      handoffId,
      gitEnv: project.gitEnv || {},
      skipAutoStash: Boolean(prep.preExistingDirty),
      logger: this.logger,
    });
    const primaryHygiene = redactObj(primaryHygieneRaw);
    rec.hygiene = primaryHygiene;

    const postFlightWarnings = [];
    const primaryWarn = formatPostFlightWarning(project.id, primaryHygiene);
    if (primaryWarn) postFlightWarnings.push(primaryWarn);

    const cleanStructured = redactObj(agyRes.structured);
    const cleanText = redactText(agyRes.text || "");
    const cleanErr = redactText(agyRes.error || "");

    const pushedCommits = {};
    const checkRepoPushed = async (proj, workDir, targetBranch, baseHead, explicitSha = "", preHygiene = null) => {
      let cand = String(explicitSha || "").trim();
      const h = preHygiene || (await this.adapters.inspectRepoHygiene({ repoPath: workDir, gitEnv: proj.gitEnv || {} }));
      if (!cand && h.head && baseHead && h.head !== baseHead) {
        try {
          const br = targetBranch || h.branch || "main";
          await runGit(workDir, ["fetch", "origin", br], { env: proj.gitEnv || {} });
          await runGit(workDir, ["merge-base", "--is-ancestor", h.head, `refs/remotes/origin/${br}`], {
            env: proj.gitEnv || {},
          });
          cand = h.head;
        } catch {
          cand = "";
        }
      }
      return { pushed: cand, head: h.head || baseHead, hygiene: redactObj(h) };
    };

    const structuredMap =
      cleanStructured?.pushedCommits && typeof cleanStructured.pushedCommits === "object"
        ? cleanStructured.pushedCommits
        : {};

    const primaryPost = await checkRepoPushed(
      project,
      prep.workingDir,
      rec.branch,
      prep.afterHead,
      structuredMap[project.id] || cleanStructured?.pushedCommit || "",
      primaryHygieneRaw,
    );
    if (primaryPost.pushed) pushedCommits[project.id] = primaryPost.pushed;
    rec.targets[0].afterHead = primaryPost.head;
    rec.targets[0].pushedCommit = primaryPost.pushed;
    rec.targets[0].hygiene = primaryHygiene;

    for (let idx = 0; idx < peerPreps.length; idx += 1) {
      const pp = peerPreps[idx];
      const peerHygieneRaw = await this.adapters.recoverPostFlightRepoHygiene({
        repoPath: pp.workingDir,
        handoffId,
        gitEnv: pp.project.gitEnv || {},
        skipAutoStash: Boolean(pp.preExistingDirty),
        logger: this.logger,
      });
      const peerHygiene = redactObj(peerHygieneRaw);
      const peerWarn = formatPostFlightWarning(pp.project.id, peerHygiene);
      if (peerWarn) postFlightWarnings.push(peerWarn);

      if (rec.targets[idx + 1]) {
        rec.targets[idx + 1].hygiene = peerHygiene;
      }

      if (!pp.project.allowGitPush) {
        if (rec.targets[idx + 1] && peerHygiene.head) {
          rec.targets[idx + 1].afterHead = peerHygiene.head;
        }
        continue;
      }

      const peerPost = await checkRepoPushed(
        pp.project,
        pp.workingDir,
        pp.branch,
        pp.afterHead,
        structuredMap[pp.project.id] || "",
        peerHygieneRaw,
      );
      if (peerPost.pushed) {
        pushedCommits[pp.project.id] = peerPost.pushed;
        if (!rec.changedProjects.includes(pp.project.id)) rec.changedProjects.push(pp.project.id);
      }
      if (rec.targets[idx + 1]) {
        rec.targets[idx + 1].afterHead = peerPost.head;
        rec.targets[idx + 1].pushedCommit = peerPost.pushed;
        rec.targets[idx + 1].hygiene = peerHygiene;
      }
    }

    const pushedCommit = pushedCommits[project.id] || Object.values(pushedCommits)[0] || "";
    rec.afterHead = primaryPost.head || prep.afterHead;
    rec.pushedCommit = pushedCommit;
    rec.pushedCommits = pushedCommits;
    rec.result = cleanStructured;

    if (agyRes.aborted || rec.status === "cancelled") {
      rec.status = "cancelled";
      rec.phase = "cancelled";
      rec.error = "任务已取消";
      rec.summary = "任务已取消";
    } else if (agyRes.ok && cleanStructured?.status !== "failed" && cleanStructured?.status !== "blocked") {
      rec.status = "succeeded";
      rec.phase = "completed";
      rec.summary = cleanStructured?.summary || cleanText.slice(0, 1500) || "本地 agy 执行完成";
    } else if (cleanStructured?.status === "blocked") {
      rec.status = "blocked";
      rec.phase = "agent_blocked";
      rec.summary = cleanStructured.summary || cleanText.slice(0, 1500);
      rec.error = cleanErr;
    } else {
      rec.status = "failed";
      rec.phase = agyRes.timedOut ? "timeout" : "agy_failed";
      rec.error = cleanErr || redactText(agyRes.reason?.error?.message || `agy 退出码 ${agyRes.exitCode}`);
      rec.summary = cleanStructured?.summary || cleanText.slice(0, 1200) || rec.error;
    }

    if (postFlightWarnings.length > 0) {
      const warningBlock = redactText(postFlightWarnings.join("\n"));
      rec.summary = rec.summary ? `${rec.summary}\n\n${warningBlock}` : warningBlock;
    }

    rec.finishedAt = new Date().toISOString();
    rec.updatedAt = rec.finishedAt;

    await writeJsonAtomic(path.join(runDir, "audit.json"), {
      handoffId: rec.handoffId,
      workflowId: rec.workflowId,
      round: rec.round,
      projectId: rec.projectId,
      status: rec.status,
      durationMs: agyRes.durationMs,
      beforeHead: rec.beforeHead,
      afterHead: rec.afterHead,
      pushedCommit: rec.pushedCommit,
      hygiene: rec.hygiene,
      summary: rec.summary,
      error: rec.error,
    });

    await this.maybePublishGitRefResult(rec, project);
    await this.saveState();
    this.notifyWaiters(handoffId);
    await this.maybeNotifyWebhook(rec);
  }

  async maybePublishGitRefResult(rec, project) {
    if (rec.resultChannel !== "git-ref") return;
    const resRef = `agy-collab/res-${rec.handoffId}`;
    try {
      await this.adapters.publishGitRefJson({
        repoPath: project.repoPath,
        refName: resRef,
        filename: "result.json",
        gitEnv: project.gitEnv || {},
        payload: {
          handoffId: rec.handoffId,
          workflowId: rec.workflowId,
          round: rec.round,
          projectId: rec.projectId,
          branch: rec.branch,
          status: rec.status,
          summary: rec.summary,
          error: rec.error,
          beforeHead: rec.beforeHead,
          afterHead: rec.afterHead,
          pushedCommit: rec.pushedCommit,
          changedFiles: rec.changedFiles,
          hygiene: rec.hygiene,
          result: rec.result,
          finishedAt: rec.finishedAt,
        },
      });
      if (!rec.gitRefs.includes(resRef)) rec.gitRefs.push(resRef);
    } catch (err) {
      this.logger?.warn?.(`[${rec.handoffId}] 发布 git-ref 结果失败：${errorSummary(err)}`);
    }
  }

  async maybeNotifyWebhook(rec) {
    const url = String(this.config.notify?.webhookUrl || "").trim();
    if (!url) return;
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          handoffId: rec.handoffId,
          projectId: rec.projectId,
          status: rec.status,
          summary: rec.summary,
          pushedCommit: rec.pushedCommit,
        }),
      });
    } catch {
      // 忽略通知失败
    }
  }

  async ackHandoff(handoffId) {
    const rec = this.state.handoffs[handoffId];
    if (!rec) return null;

    const now = new Date().toISOString();
    rec.ackedAt = now;
    rec.updatedAt = now;

    let purgeSummary = null;
    if (this.config.cleanup?.purgeOnAck !== false && !rec.purgedAt) {
      const project = findProject(this.config, { projectId: rec.projectId });
      purgeSummary = await this.adapters.purgeRunArtifacts({
        runDir: path.join(this.runsDir, handoffId),
        worktreePath: rec.worktreePath,
        repoPath: project?.repoPath || "",
        gitRefs: rec.gitRefs || [],
        gitEnv: project?.gitEnv || {},
        logger: this.logger,
      });
      if (Array.isArray(rec.extraWorktrees)) {
        for (const ew of rec.extraWorktrees) {
          if (ew?.worktreePath && ew?.repoPath) {
            await this.adapters
              .purgeRunArtifacts({
                runDir: "",
                worktreePath: ew.worktreePath,
                repoPath: ew.repoPath,
                gitRefs: [],
                gitEnv: ew.gitEnv || {},
                logger: this.logger,
              })
              .catch(() => {});
          }
        }
      }
      rec.purgedAt = now;
    }

    await this.saveState();
    return { record: structuredClone(rec), purgeSummary };
  }

  async cancelHandoff(handoffId) {
    const rec = this.state.handoffs[handoffId];
    if (!rec) return null;
    if (isTerminalStatus(rec.status)) {
      return { alreadyTerminal: true, record: structuredClone(rec) };
    }
    rec.status = "cancelled";
    rec.phase = "cancelling";
    rec.updatedAt = new Date().toISOString();
    await this.saveState();

    const ac = this.abortControllers.get(handoffId);
    if (ac) ac.abort();
    else {
      rec.phase = "cancelled";
      rec.finishedAt = rec.updatedAt;
      await this.saveState();
      this.notifyWaiters(handoffId);
    }
    return { alreadyTerminal: false, record: structuredClone(rec) };
  }

  async runSweep() {
    const count = await sweepExpiredRuns({
      runsDir: this.runsDir,
      handoffs: this.state.handoffs,
      retentionHours: this.config.cleanup?.retentionHours ?? 24,
      findRepoForHandoff: (rec) => (rec ? findProject(this.config, { projectId: rec.projectId }) : null),
      logger: this.logger,
    });
    if (count > 0) await this.saveState();
    return count;
  }

  async pollGitRefRequests() {
    for (const project of this.config.projects || []) {
      const reqRefs = await this.adapters
        .listGitRefRequests({ repoPath: project.repoPath, gitEnv: project.gitEnv || {} })
        .catch(() => []);
      for (const item of reqRefs) {
        const reqData = await this.adapters
          .readGitRefJson({
            repoPath: project.repoPath,
            refName: item.refName,
            filename: "request.json",
            gitEnv: project.gitEnv || {},
          })
          .catch(() => null);
        if (!reqData || !reqData.handoffId) continue;
        if (this.state.handoffs[reqData.handoffId]) continue;

        await this.dispatchHandoff({
          ...reqData,
          projectId: reqData.projectId || project.id,
          resultChannel: "git-ref",
          gitRefs: [item.refName],
        }).catch((err) => {
          this.logger?.warn?.(`处理 git-ref 请求 ${item.refName} 失败：${errorSummary(err)}`);
        });
      }
    }
  }
}
