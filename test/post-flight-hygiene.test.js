import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { addProject, initBridge, loadConfig, saveConfig, validateConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { buildAgyPrompt, Orchestrator } from "../src/orchestrator.js";
import { createRedactor } from "../src/redact.js";
import { buildWorkspaceRuleMd, buildWorkspaceSkillMd } from "../src/templates.js";
import { buildBridgeAgentsMd } from "../src/workspace.js";

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return String(stdout || "").trim();
}

async function createRepoPair(baseDir, name) {
  const bareDir = path.join(baseDir, `${name}.git`);
  const cloudDir = path.join(baseDir, `cloud-${name}`);
  const localDir = path.join(baseDir, `local-${name}`);

  await fsp.mkdir(bareDir, { recursive: true });
  await git(bareDir, ["init", "--bare", "-b", "main"]);

  await git(baseDir, ["clone", bareDir, cloudDir]);
  await git(cloudDir, ["config", "user.email", "cloud@example.com"]);
  await git(cloudDir, ["config", "user.name", "Cloud"]);
  await fsp.writeFile(path.join(cloudDir, ".gitignore"), ".agy-local\n");
  await fsp.writeFile(path.join(cloudDir, "app.js"), "console.log('v1');\n");
  await git(cloudDir, ["add", "-A"]);
  await git(cloudDir, ["commit", "-m", "init"]);
  await git(cloudDir, ["push", "-u", "origin", "main"]);

  await git(baseDir, ["clone", bareDir, localDir]);
  await git(localDir, ["config", "user.email", "local@example.com"]);
  await git(localDir, ["config", "user.name", "Local"]);
  await fsp.writeFile(path.join(localDir, ".agy-local"), "# local marker\n");

  return { bareDir, cloudDir, localDir };
}

test("Prompt envelope and workspace AGENTS.md inject forced closing contract", () => {
  const prompt = buildAgyPrompt({
    record: {
      handoffId: "ho_contract_01",
      workflowId: "wf_1",
      round: 1,
      branch: "main",
      task: "检查构建并重启服务",
    },
    project: {
      id: "demo-app",
      name: "Demo App",
      allowGitPush: true,
    },
    prep: {
      workingDir: "/tmp/demo-app",
      branch: "main",
      beforeHead: "111111111111",
      afterHead: "222222222222",
      changedFiles: ["src/index.js"],
    },
    peerPreps: [],
    runScratchDir: "/tmp/runs/ho_contract_01/scratch",
  });

  assert.match(prompt, /【桥接强制收尾契约】/);
  assert.match(prompt, /git status --porcelain/);
  assert.match(prompt, /git commit/);
  assert.match(prompt, /git push/);
  assert.match(prompt, /pushedCommit/);
  assert.match(prompt, /\.meta/);
  assert.match(prompt, /git checkout/);
  assert.match(prompt, /dirtyCount=0/);
  assert.match(prompt, /agy-bridge-leftover:ho_contract_01/);

  const noPushPrompt = buildAgyPrompt({
    record: {
      handoffId: "ho_nopush_01",
      workflowId: "wf_2",
      round: 1,
      branch: "main",
      task: "只读检查",
    },
    project: {
      id: "readonly-app",
      name: "Readonly App",
      allowGitPush: false,
    },
    prep: {
      workingDir: "/tmp/readonly-app",
      branch: "main",
      beforeHead: "111111111111",
      afterHead: "222222222222",
      changedFiles: [],
    },
    peerPreps: [],
    runScratchDir: "/tmp/runs/ho_nopush_01/scratch",
  });

  assert.match(noPushPrompt, /【桥接强制收尾契约】/);
  assert.match(noPushPrompt, /allowGitPush=false/);
  assert.match(noPushPrompt, /请勿对主仓库执行 `git push`/);

  const agentsMd = buildBridgeAgentsMd({
    project: { id: "demo-app", name: "Demo App" },
    repoWorkingDir: "/tmp/demo-app",
    runScratchDir: "/tmp/runs/ho_contract_01/scratch",
    allowPush: true,
  });

  assert.match(agentsMd, /【桥接强制收尾契约】/);
  assert.match(agentsMd, /git status --porcelain/);
  assert.match(agentsMd, /dirtyCount=0/);
  assert.match(agentsMd, /pushedCommit/);
});

test("Templates generate dual-end symmetric rule and clean-tree dispatch examples", () => {
  const ruleMd = buildWorkspaceRuleMd({
    projectId: "demo-game",
    allowGitPush: true,
  });
  assert.match(ruleMd, /云端 ⇄ 本机双端对称协同规则/);
  assert.match(ruleMd, /本机端收尾强制提交与工作区清零规则/);
  assert.match(ruleMd, /git status --porcelain/);
  assert.match(ruleMd, /git commit/);
  assert.match(ruleMd, /git push/);
  assert.match(ruleMd, /dirtyCount=0/);
  assert.match(ruleMd, /agy-bridge-leftover:/);

  const skillMd = buildWorkspaceSkillMd({ projectId: "demo-game" });
  assert.match(skillMd, /git status --porcelain/);
  assert.match(skillMd, /git commit && git push/);
  assert.match(skillMd, /dirtyCount=0/);
  assert.match(skillMd, /Post-flight/);
});

test("Post-flight auto-stashes leftovers across success, push+leftover, failure, timeout, and multi-repo while preserving Pre-flight dirty_tree protection", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-postflight-"));
  t.after(async () => fsp.rm(tmpDir, { recursive: true, force: true }));

  const homeDir = path.join(tmpDir, "bridge-home");
  const primary = await createRepoPair(tmpDir, "primary");
  const peerChanged = await createRepoPair(tmpDir, "peer-changed");
  const peerUntouched = await createRepoPair(tmpDir, "peer-untouched");

  const initRes = await initBridge({ home: homeDir });
  const cfg = initRes.config;
  cfg.agy.requireProxy = false;
  addProject(cfg, {
    id: "primary",
    name: "Primary",
    group: "grp",
    repoPath: primary.localDir,
    allowedBranches: ["main"],
    dirtyPolicy: "safe-block",
    allowGitPush: true,
    maxRounds: 10,
  });
  addProject(cfg, {
    id: "peer-changed",
    name: "Peer Changed",
    group: "grp",
    repoPath: peerChanged.localDir,
    allowedBranches: ["main"],
    dirtyPolicy: "safe-block",
    allowGitPush: true,
    maxRounds: 10,
  });
  addProject(cfg, {
    id: "peer-untouched",
    name: "Peer Untouched",
    group: "grp",
    repoPath: peerUntouched.localDir,
    allowedBranches: ["main"],
    dirtyPolicy: "safe-block",
    allowGitPush: true,
    maxRounds: 10,
  });
  await saveConfig(cfg, homeDir);

  let nextBehavior = null;
  let capturedPrompt = "";
  const orchestrator = new Orchestrator({
    home: homeDir,
    config: cfg,
    logger: createLogger({ level: "error" }),
    adapters: {
      runAgy: async ({ task }) => {
        capturedPrompt = task;
        return nextBehavior(task);
      },
    },
  });
  await orchestrator.init();
  t.after(async () => orchestrator.close());

  // 1. Pre-flight dirty_tree protection stays intact for pre-existing manual edits
  await fsp.writeFile(path.join(primary.localDir, "manual.txt"), "user editing\n");
  const blockedDispatch = await orchestrator.dispatchHandoff({
    projectId: "primary",
    handoffId: "ho_preflight_dirty",
    branch: "main",
    mode: "agent",
    task: "should block before running agy",
    autoPeers: false,
  });
  const blockedRec = await orchestrator.waitForHandoff(blockedDispatch.record.handoffId, 10);
  assert.equal(blockedRec.status, "blocked");
  assert.equal(blockedRec.phase, "dirty_tree");
  assert.equal(fs.existsSync(path.join(primary.localDir, "manual.txt")), true);
  await fsp.rm(path.join(primary.localDir, "manual.txt"));

  // 2. Success with leftover tracked + untracked files -> Post-flight auto-stashes, preserves .agy-local, appends summary warning, unblocks next round
  nextBehavior = async () => {
    await fsp.writeFile(path.join(primary.localDir, "app.js"), "console.log('dirty-noise');\n");
    await fsp.writeFile(path.join(primary.localDir, "generated.meta"), "uuid: 123\n");
    return {
      ok: true,
      conversationId: "conv-1",
      text: "ok",
      structured: { status: "ok", summary: "本地预览完成" },
      exitCode: 0,
      timedOut: false,
      aborted: false,
      durationMs: 10,
      error: "",
    };
  };
  const d1 = await orchestrator.dispatchHandoff({
    projectId: "primary",
    handoffId: "ho_leftover_ok",
    branch: "main",
    mode: "agent",
    task: "preview build",
    autoPeers: false,
  });
  const r1 = await orchestrator.waitForHandoff(d1.record.handoffId, 10);
  assert.match(capturedPrompt, /【桥接强制收尾契约】/);
  assert.equal(r1.status, "succeeded");
  assert.equal(r1.hygiene.clean, true);
  assert.equal(r1.hygiene.leftoversStashed, true);
  assert.equal(r1.hygiene.stashMessage, "agy-bridge-leftover:ho_leftover_ok");
  assert.ok(r1.hygiene.stashedFiles.some((f) => f.includes("app.js")));
  assert.ok(r1.hygiene.stashedFiles.some((f) => f.includes("generated.meta")));
  assert.match(r1.summary, /\[Post-flight 告警\]/);
  assert.match(r1.summary, /agy-bridge-leftover:ho_leftover_ok/);
  assert.equal(await git(primary.localDir, ["status", "--porcelain"]), "");
  assert.equal(fs.existsSync(path.join(primary.localDir, ".agy-local")), true, ".agy-local must remain intact");
  const stashList1 = await git(primary.localDir, ["stash", "list"]);
  assert.match(stashList1, /agy-bridge-leftover:ho_leftover_ok/);

  // 3. Failure (non-zero exit) with leftovers -> Post-flight still stashes and keeps repo clean
  nextBehavior = async () => {
    await fsp.writeFile(path.join(primary.localDir, "broken.tmp"), "partial output\n");
    return {
      ok: false,
      conversationId: "conv-1",
      text: "",
      structured: null,
      exitCode: 1,
      timedOut: false,
      aborted: false,
      durationMs: 12,
      error: "build failed",
      reason: { kind: "error", error: { message: "build failed" } },
    };
  };
  const d2 = await orchestrator.dispatchHandoff({
    projectId: "primary",
    handoffId: "ho_leftover_fail",
    branch: "main",
    mode: "agent",
    task: "trigger failure",
    autoPeers: false,
  });
  const r2 = await orchestrator.waitForHandoff(d2.record.handoffId, 10);
  assert.equal(r2.status, "failed");
  assert.equal(r2.phase, "agy_failed");
  assert.equal(r2.hygiene.clean, true);
  assert.equal(r2.hygiene.leftoversStashed, true);
  assert.equal(r2.hygiene.stashMessage, "agy-bridge-leftover:ho_leftover_fail");
  assert.match(r2.summary, /\[Post-flight 告警\]/);
  assert.equal(await git(primary.localDir, ["status", "--porcelain"]), "");

  // 4. Timeout with leftovers -> Post-flight still stashes and keeps repo clean
  nextBehavior = async () => {
    await fsp.writeFile(path.join(primary.localDir, "timeout.meta"), "partial\n");
    return {
      ok: false,
      conversationId: "conv-1",
      text: "",
      structured: null,
      exitCode: null,
      timedOut: true,
      aborted: false,
      durationMs: 30000,
      error: "timeout",
      reason: { kind: "timeout" },
    };
  };
  const d3 = await orchestrator.dispatchHandoff({
    projectId: "primary",
    handoffId: "ho_leftover_timeout",
    branch: "main",
    mode: "agent",
    task: "trigger timeout",
    autoPeers: false,
  });
  const r3 = await orchestrator.waitForHandoff(d3.record.handoffId, 10);
  assert.equal(r3.status, "failed");
  assert.equal(r3.phase, "timeout");
  assert.equal(r3.hygiene.clean, true);
  assert.equal(r3.hygiene.leftoversStashed, true);
  assert.equal(r3.hygiene.stashMessage, "agy-bridge-leftover:ho_leftover_timeout");
  assert.match(r3.summary, /\[Post-flight 告警\]/);
  assert.equal(await git(primary.localDir, ["status", "--porcelain"]), "");

  // 5. Next round commits & pushes valid fix AND leaves extra untracked noise -> pushedCommit recorded AND noise stashed
  nextBehavior = async () => {
    await fsp.writeFile(path.join(primary.localDir, "app.js"), "console.log('v2-pushed');\n");
    await git(primary.localDir, ["add", "app.js"]);
    await git(primary.localDir, ["commit", "-m", "fix: local commit"]);
    await git(primary.localDir, ["push", "origin", "main"]);
    await fsp.writeFile(path.join(primary.localDir, "extra.log"), "noise\n");
    return {
      ok: true,
      conversationId: "conv-1",
      text: "done",
      structured: { status: "ok", summary: "已提交修复" },
      exitCode: 0,
      timedOut: false,
      aborted: false,
      durationMs: 10,
      error: "",
    };
  };
  const d4 = await orchestrator.dispatchHandoff({
    projectId: "primary",
    handoffId: "ho_push_and_leftover",
    branch: "main",
    mode: "agent",
    task: "fix and push",
    autoPeers: false,
  });
  const r4 = await orchestrator.waitForHandoff(d4.record.handoffId, 10);
  assert.equal(r4.status, "succeeded");
  assert.ok(r4.pushedCommit, "pushedCommit must still be recorded when leftovers are stashed");
  assert.equal(r4.hygiene.clean, true);
  assert.equal(r4.hygiene.leftoversStashed, true);
  assert.match(r4.summary, /\[Post-flight 告警\]/);
  assert.equal(await git(primary.localDir, ["status", "--porcelain"]), "");

  // 6. Multi-repo: untouched peer with pre-existing manual edit is preserved; changed peer with leftovers is auto-stashed
  await fsp.writeFile(path.join(peerUntouched.localDir, "user-wip.txt"), "do not touch\n");
  await fsp.writeFile(path.join(peerChanged.cloudDir, "app.js"), "console.log('peer-v2');\n");
  await git(peerChanged.cloudDir, ["add", "app.js"]);
  await git(peerChanged.cloudDir, ["commit", "-m", "feat: peer update"]);
  await git(peerChanged.cloudDir, ["push", "origin", "main"]);

  nextBehavior = async () => {
    await fsp.writeFile(path.join(peerChanged.localDir, "peer-leftover.meta"), "leftover\n");
    return {
      ok: true,
      conversationId: "conv-multi",
      text: "multi ok",
      structured: { status: "ok", summary: "多仓联调完成" },
      exitCode: 0,
      timedOut: false,
      aborted: false,
      durationMs: 10,
      error: "",
    };
  };
  const d5 = await orchestrator.dispatchHandoff({
    projectId: "primary",
    handoffId: "ho_multi_leftover",
    branch: "main",
    mode: "agent",
    task: "multi repo check",
    autoPeers: true,
  });
  const r5 = await orchestrator.waitForHandoff(d5.record.handoffId, 10);
  assert.equal(r5.status, "succeeded");
  assert.equal(await git(peerChanged.localDir, ["status", "--porcelain"]), "");
  assert.match(r5.summary, /\[Post-flight 告警\].*peer-changed/);
  assert.match(await git(peerChanged.localDir, ["stash", "list"]), /agy-bridge-leftover:ho_multi_leftover/);
  // Untouched peer's pre-existing manual edit must NOT have been stashed
  assert.equal(fs.existsSync(path.join(peerUntouched.localDir, "user-wip.txt")), true);
  assert.equal(await git(peerUntouched.localDir, ["stash", "list"]), "");
});

test("Open-source defaults pass validation, support custom SSD-offload runsDir/worktreesDir and extraRedactEnvFiles", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-oss-config-"));
  t.after(async () => fsp.rm(tmpDir, { recursive: true, force: true }));

  const homeDir = path.join(tmpDir, "home");
  const customRunsDir = path.join(tmpDir, "ramdisk-runs");
  const customWorktreesDir = path.join(tmpDir, "ramdisk-worktrees");
  const customEnvFile = path.join(tmpDir, "custom-proxy.env");
  await fsp.writeFile(customEnvFile, 'PROXY_PASS="SuperSecretProxyPass999"\n', { mode: 0o600 });

  const { config } = await initBridge({ home: homeDir });
  assert.equal(config.agy.requireProxy, false);
  assert.equal(config.server.publicUrl, "");
  assert.deepEqual(validateConfig(config).errors, []);

  config.runtime.runsDir = customRunsDir;
  config.runtime.worktreesDir = customWorktreesDir;
  config.security.extraRedactEnvFiles = [customEnvFile];
  await saveConfig(config, homeDir);

  const loaded = (await loadConfig({ home: homeDir })).config;
  const redact = createRedactor({ config: loaded, home: homeDir });
  assert.doesNotMatch(redact("failed with SuperSecretProxyPass999").text, /SuperSecretProxyPass999/);

  const repo = await createRepoPair(tmpDir, "ssd-offload");
  addProject(loaded, {
    id: "ssd-offload",
    name: "SSD Offload",
    repoPath: repo.localDir,
    allowedBranches: ["main"],
    dirtyPolicy: "worktree",
    allowGitPush: true,
  });
  await saveConfig(loaded, homeDir);

  const orchestrator = new Orchestrator({
    home: homeDir,
    config: loaded,
    logger: createLogger({ level: "error" }),
    adapters: {
      runAgy: async () => ({
        ok: true,
        conversationId: "conv-ssd",
        text: "ok",
        structured: { status: "ok", summary: "ok" },
        exitCode: 0,
        timedOut: false,
        aborted: false,
        durationMs: 5,
        error: "",
      }),
    },
  });
  await orchestrator.init();
  t.after(async () => orchestrator.close());

  const d = await orchestrator.dispatchHandoff({
    projectId: "ssd-offload",
    handoffId: "ho_ssd_01",
    branch: "main",
    mode: "agent",
    task: "verify custom offload paths",
  });
  const rec = await orchestrator.waitForHandoff(d.record.handoffId, 10);
  assert.equal(rec.status, "succeeded");
  assert.ok(rec.worktreePath.startsWith(customWorktreesDir), `expected worktree under ${customWorktreesDir}, got ${rec.worktreePath}`);
  assert.equal(fs.existsSync(path.join(customRunsDir, "ho_ssd_01", "audit.json")), true);
  assert.equal(fs.existsSync(path.join(homeDir, "runs", "ho_ssd_01")), false);
  await orchestrator.ackHandoff("ho_ssd_01");
  assert.equal(fs.existsSync(rec.worktreePath), false);
});

test("Multi-round workflow continuation temporarily restores purged prior scratch dir during runAgy", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-scratch-compat-"));
  t.after(async () => fsp.rm(tmpDir, { recursive: true, force: true }));

  const homeDir = path.join(tmpDir, "home");
  const { config } = await initBridge({ home: homeDir });
  const repo = await createRepoPair(tmpDir, "multi-round");
  addProject(config, {
    id: "multi-round",
    name: "Multi Round",
    repoPath: repo.localDir,
    allowedBranches: ["main"],
  });
  await saveConfig(config, homeDir);

  let round1ScratchExistedInRound2 = false;
  let round1Id = "";
  const orchestrator = new Orchestrator({
    home: homeDir,
    config,
    logger: createLogger({ level: "error" }),
    adapters: {
      runAgy: async ({ conversationId }) => {
        if (conversationId && round1Id) {
          round1ScratchExistedInRound2 = fs.existsSync(path.join(homeDir, "runs", round1Id, "scratch"));
        }
        return {
          ok: true,
          conversationId: conversationId || "conv-persist-1",
          text: "ok",
          structured: { status: "ok", summary: "ok" },
          exitCode: 0,
          timedOut: false,
          aborted: false,
          durationMs: 5,
          error: "",
        };
      },
    },
  });
  await orchestrator.init();
  t.after(async () => orchestrator.close());

  const d1 = await orchestrator.dispatchHandoff({
    projectId: "multi-round",
    handoffId: "ho_r1",
    workflowId: "wf_compat",
    branch: "main",
    mode: "agent",
    task: "round 1",
  });
  round1Id = d1.record.handoffId;
  await orchestrator.waitForHandoff(round1Id, 10);
  await orchestrator.ackHandoff(round1Id);
  assert.equal(fs.existsSync(path.join(homeDir, "runs", round1Id, "scratch")), false);

  const d2 = await orchestrator.dispatchHandoff({
    projectId: "multi-round",
    handoffId: "ho_r2",
    workflowId: "wf_compat",
    branch: "main",
    mode: "agent",
    task: "round 2",
  });
  const r2 = await orchestrator.waitForHandoff(d2.record.handoffId, 10);
  assert.equal(r2.status, "succeeded");
  assert.equal(round1ScratchExistedInRound2, true, "prior scratch dir must exist while resumed conversation runs");
  assert.equal(fs.existsSync(path.join(homeDir, "runs", round1Id, "scratch")), false, "empty compat dir cleaned up after run");
});
