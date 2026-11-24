import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createAuthHeaders } from "../src/auth.js";
import { initBridge, saveConfig, addProject } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { Orchestrator } from "../src/orchestrator.js";
import { createBridgeServer } from "../src/server.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HANDOFF_SH = path.resolve(__dirname, "../scripts/handoff.sh");

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return String(stdout || "").trim();
}

async function setupTempRepos(baseDir) {
  const bareDir = path.join(baseDir, "origin.git");
  const cloudDir = path.join(baseDir, "cloud-repo");
  const localDir = path.join(baseDir, "local-repo");

  await fsp.mkdir(bareDir, { recursive: true });
  await git(bareDir, ["init", "--bare", "-b", "main"]);

  await git(baseDir, ["clone", bareDir, cloudDir]);
  await git(cloudDir, ["config", "user.email", "cloud@example.com"]);
  await git(cloudDir, ["config", "user.name", "Cloud"]);
  await fsp.mkdir(path.join(cloudDir, "novels"), { recursive: true });
  await fsp.mkdir(path.join(cloudDir, "web"), { recursive: true });
  await fsp.writeFile(path.join(cloudDir, "novels/ch01.md"), "# ch1\ninit\n");
  await fsp.writeFile(path.join(cloudDir, "web/app.js"), "console.log('v1');\n");
  await git(cloudDir, ["add", "-A"]);
  await git(cloudDir, ["commit", "-m", "init"]);
  await git(cloudDir, ["push", "-u", "origin", "main"]);

  await git(baseDir, ["clone", bareDir, localDir]);
  await git(localDir, ["config", "user.email", "local@example.com"]);
  await git(localDir, ["config", "user.name", "Local"]);

  return { bareDir, cloudDir, localDir };
}

test("End-to-end bridge: fastPaths, agent round-trip, dirty safe-block, worktree, maxRounds, git-ref, and handoff.sh", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-bridge-e2e-"));
  t.after(async () => fsp.rm(tmpDir, { recursive: true, force: true }));

  const homeDir = path.join(tmpDir, "bridge-home");
  const { cloudDir, localDir } = await setupTempRepos(tmpDir);

  // Mock proxy launcher that writes an artifact in scratch, edits & pushes a fix from localDir when requested
  const mockLauncher = path.join(tmpDir, "mock-agy-proxy.sh");
  await fsp.writeFile(
    mockLauncher,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "--check" ]]; then
  echo "mock proxy ok"
  exit 0
fi
read -r prompt_line
conv="conv-test-1"
# Write a temporary screenshot into scratch dir (parsed from AGY_BRIDGE_GUARD_WRITE_ROOTS)
node -e '
  const fs = require("fs");
  const path = require("path");
  const { execSync } = require("child_process");
  const roots = JSON.parse(process.env.AGY_BRIDGE_GUARD_WRITE_ROOTS);
  const repoDir = roots[0];
  const scratchDir = roots[1];
  fs.mkdirSync(scratchDir, { recursive: true });
  fs.writeFileSync(path.join(scratchDir, "preview.png"), "fake-png");
  const line = process.argv[1];
  if (line.includes("FIX_AND_PUSH")) {
    fs.writeFileSync(path.join(repoDir, "web/app.js"), "console.log(\\"v2-fixed\\");\\n");
    execSync("git add web/app.js && git commit -m \\"fix: local debug fix\\" && git push origin HEAD:main", { cwd: repoDir, stdio: "inherit" });
  }
' "$prompt_line"
echo '{"event":"init","conversation_id":"conv-test-1"}'
echo '{"event":"result","result":{"conversation_id":"conv-test-1","status":"SUCCESS","response":"本地已完成预览与验证。\\n<<<AGY_RESULT_JSON>>>\\n{\\"status\\":\\"ok\\",\\"summary\\":\\"本地调试完成并验证通过\\",\\"testsPassed\\":true}\\n<<<END_AGY_RESULT_JSON>>>"}}'
`,
    { mode: 0o755 },
  );
  fs.chmodSync(mockLauncher, 0o755);

  const initRes = await initBridge({ home: homeDir });
  const cfg = initRes.config;
  cfg.agy.launcher = mockLauncher;
  cfg.agy.requireProxy = true;
  addProject(cfg, {
    id: "demo-novel",
    name: "Demo Novel",
    repoPath: localDir,
    remoteMatch: path.join(tmpDir, "origin.git"),
    allowedBranches: ["main", "feat/*"],
    dirtyPolicy: "safe-block",
    allowGitPush: true,
    maxRounds: 3,
    fastPaths: ["^novels/.*\\.md$"],
  });
  await saveConfig(cfg, homeDir);

  const logger = createLogger({ level: "error" });
  const orchestrator = new Orchestrator({ home: homeDir, config: cfg, logger });
  await orchestrator.init();

  const { loadSecret } = await import("../src/config.js");
  const secret = loadSecret({ home: homeDir, config: cfg });
  const server = createBridgeServer({
    orchestrator,
    getSecret: () => secret,
    logger,
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await orchestrator.close();
    await new Promise((resolve) => server.close(resolve));
  });

  // 1. Test handoff.sh health
  const healthOut = await execFileAsync("bash", [HANDOFF_SH, "health", "--url", baseUrl], {
    cwd: cloudDir,
  });
  assert.equal(JSON.parse(healthOut.stdout).ok, true);

  // 2. Test fastPaths (novels/*.md -> fast_synced without invoking agy)
  await fsp.writeFile(path.join(cloudDir, "novels/ch02.md"), "# ch2\nhello\n");
  await git(cloudDir, ["add", "-A"]);
  await git(cloudDir, ["commit", "-m", "feat: ch02"]);
  await git(cloudDir, ["push", "origin", "main"]);

  const fastOut = await execFileAsync(
    "bash",
    [
      HANDOFF_SH,
      "dispatch",
      "--url",
      baseUrl,
      "--secret-file",
      initRes.secretFile,
      "--project",
      "demo-novel",
      "--task",
      "同步第2章正文",
      "--wait",
      "30",
      "--ack",
      "--json",
    ],
    { cwd: cloudDir },
  );
  const fastJson = JSON.parse(fastOut.stdout);
  assert.equal(fastJson.status, "fast_synced");
  assert.equal(fs.existsSync(path.join(localDir, "novels/ch02.md")), true);

  // 3. Test full Agent round-trip with FIX_AND_PUSH + --pull + --ack artifact cleanup
  await fsp.writeFile(path.join(cloudDir, "web/app.js"), "console.log('v2-bug');\n");
  await git(cloudDir, ["add", "-A"]);
  await git(cloudDir, ["commit", "-m", "feat: web v2"]);
  await git(cloudDir, ["push", "origin", "main"]);

  const agentOut = await execFileAsync(
    "bash",
    [
      HANDOFF_SH,
      "dispatch",
      "--url",
      baseUrl,
      "--secret-file",
      initRes.secretFile,
      "--project",
      "demo-novel",
      "--workflow",
      "wf-loop",
      "--task",
      "请调试 web 并 FIX_AND_PUSH",
      "--task-type",
      "preview_and_test",
      "--wait",
      "30",
      "--pull",
      "--ack",
      "--json",
    ],
    { cwd: cloudDir },
  );
  const agentJson = JSON.parse(agentOut.stdout);
  assert.equal(agentJson.status, "succeeded");
  assert.ok(agentJson.pushedCommit, "should detect commit pushed by local agy");

  // Cloud workspace should now have local's v2-fixed via --pull!
  const cloudAppContent = await fsp.readFile(path.join(cloudDir, "web/app.js"), "utf8");
  assert.match(cloudAppContent, /v2-fixed/);

  // Ephemeral scratch directory should have been purged by --ack!
  const scratchAfterAck = path.join(homeDir, "runs", agentJson.handoffId, "scratch");
  assert.equal(fs.existsSync(scratchAfterAck), false);
  assert.equal(fs.existsSync(path.join(homeDir, "runs", agentJson.handoffId, "audit.json")), true);

  // 4. Test dirtyPolicy = safe-block protects uncommitted local changes
  await fsp.writeFile(path.join(localDir, "uncommitted.txt"), "keep-me\n");
  const dirtyDispatch = await orchestrator.dispatchHandoff({
    projectId: "demo-novel",
    workflowId: "wf-loop",
    branch: "main",
    task: "check dirty",
  });
  const dirtyWait = await orchestrator.waitForHandoff(dirtyDispatch.record.handoffId, 10);
  assert.equal(dirtyWait.status, "blocked");
  assert.equal(dirtyWait.phase, "dirty_tree");
  assert.equal(fs.existsSync(path.join(localDir, "uncommitted.txt")), true);

  // 5. Test maxRounds circuit breaker (wf-loop has maxRounds=3; round 1=agent, round 2=dirty -> round 3 succeeds, round 4 rejects)
  await orchestrator.dispatchHandoff({
    projectId: "demo-novel",
    workflowId: "wf-loop",
    branch: "main",
    task: "round 3",
  });
  await assert.rejects(
    () =>
      orchestrator.dispatchHandoff({
        projectId: "demo-novel",
        workflowId: "wf-loop",
        branch: "main",
        task: "round 4 should trip circuit breaker",
      }),
    (err) => err?.code === "MAX_ROUNDS_EXCEEDED",
  );

  // Clean up dirty file for next check & test worktree + git-ref channel
  await fsp.rm(path.join(localDir, "uncommitted.txt"));
  orchestrator.config.projects[0].dirtyPolicy = "worktree";
  await saveConfig(orchestrator.config, homeDir);

  // Enable poll check: push git-ref request asynchronously, trigger pollGitRefRequests, verify handoff.sh reads result & deletes refs
  const refHandoffId = "ho-gitref-1";
  const waitProc = execFileAsync(
    "bash",
    [
      HANDOFF_SH,
      "dispatch",
      "--channel",
      "git-ref",
      "--handoff-id",
      refHandoffId,
      "--project",
      "demo-novel",
      "--task",
      "test git-ref roundtrip",
      "--wait",
      "20",
      "--poll-interval",
      "1",
      "--ack",
      "--json",
    ],
    { cwd: cloudDir },
  );

  // Poll until remote req ref appears, then invoke pollGitRefRequests
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    await orchestrator.pollGitRefRequests();
    const rec = orchestrator.getHandoff(refHandoffId);
    if (rec && ["succeeded", "failed", "blocked"].includes(rec.status)) break;
  }

  const refRes = await waitProc;
  const refJson = JSON.parse(refRes.stdout);
  assert.equal(refJson.status, "succeeded");
  assert.equal(refJson.handoffId, refHandoffId);

  // Verify ACK deleted remote agy-collab/* refs and worktree was cleaned
  const remainingRefs = await git(cloudDir, ["ls-remote", "--heads", "origin", "agy-collab/*"]);
  assert.equal(remainingRefs, "");

  // Also test worktree cleanup on ack for a direct HTTP worktree run
  const wtDispatch = await orchestrator.dispatchHandoff({
    projectId: "demo-novel",
    branch: "main",
    task: "verify worktree",
  });
  const wtDone = await orchestrator.waitForHandoff(wtDispatch.record.handoffId, 15);
  assert.equal(wtDone.status, "succeeded");
  assert.ok(wtDone.worktreePath && fs.existsSync(wtDone.worktreePath));
  await orchestrator.ackHandoff(wtDispatch.record.handoffId);
  assert.equal(fs.existsSync(wtDone.worktreePath), false);

  // Verify unauthenticated request fails
  const unauthRes = await fetch(`${baseUrl}/api/v1/handoffs`);
  assert.equal(unauthRes.status, 401);
  // Verify authenticated list works
  const listHeaders = createAuthHeaders({ secret, method: "GET", pathWithQuery: "/api/v1/handoffs" });
  const listRes = await fetch(`${baseUrl}/api/v1/handoffs`, { headers: listHeaders });
  assert.equal(listRes.status, 200);
});

test("Enroll, per-project token scoping, zero-env handoff.sh, anti-recursion, and token rotation", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-enroll-e2e-"));
  t.after(async () => fsp.rm(tmpDir, { recursive: true, force: true }));

  const homeDir = path.join(tmpDir, "bridge-home");
  const bareDir = path.join(tmpDir, "repo-a.git");
  const repoADir = path.join(tmpDir, "repo-a");
  const repoBDir = path.join(tmpDir, "repo-b");

  await fsp.mkdir(bareDir, { recursive: true });
  await git(bareDir, ["init", "--bare", "-b", "main"]);
  await git(tmpDir, ["clone", bareDir, repoADir]);
  await git(repoADir, ["config", "user.email", "a@example.com"]);
  await git(repoADir, ["config", "user.name", "A"]);
  await fsp.writeFile(path.join(repoADir, "AGENTS.md"), "# Existing Rules\nKeep me intact.\n");
  await fsp.mkdir(path.join(repoADir, "novels"), { recursive: true });
  await fsp.writeFile(path.join(repoADir, "novels/ch01.md"), "# ch1\n");
  await git(repoADir, ["add", "-A"]);
  await git(repoADir, ["commit", "-m", "init"]);
  await git(repoADir, ["push", "-u", "origin", "main"]);

  await fsp.mkdir(repoBDir, { recursive: true });
  await git(repoBDir, ["init", "-b", "main"]);

  const CLI = path.resolve(__dirname, "../src/cli.js");
  await execFileAsync("node", [CLI, "init", "--home", homeDir]);

  // Run enroll on repo-a (twice to verify idempotent AGENTS.md pointer)
  const enrollArgs = [
    CLI,
    "enroll",
    repoADir,
    "--home",
    homeDir,
    "--id",
    "proj-a",
    "--bridge-url",
    "http://127.0.0.1:19999",
    "--fast-paths",
    "^novels/.*\\.md$",
    "--skip-public-check",
  ];
  await execFileAsync("node", enrollArgs);
  await execFileAsync("node", enrollArgs);

  const agentsText = await fsp.readFile(path.join(repoADir, "AGENTS.md"), "utf8");
  assert.ok(agentsText.includes("# Existing Rules"));
  assert.equal((agentsText.match(/AGY_CLOUD_BRIDGE_START/g) || []).length, 1);
  assert.equal(fs.existsSync(path.join(repoADir, ".agents/rules/cloud-local-bridge.md")), true);
  assert.equal(fs.existsSync(path.join(repoADir, ".agents/skills/cloud-local-handoff/SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(repoADir, ".agy-local")), true);

  const gitignoreText = await fsp.readFile(path.join(repoADir, ".gitignore"), "utf8");
  const markerLines = gitignoreText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l === ".agy-local");
  assert.equal(markerLines.length, 1);

  const enrolledCfg = JSON.parse(await fsp.readFile(path.join(repoADir, ".agents/bridge.json"), "utf8"));
  assert.equal(enrolledCfg.localMarkerFile, ".agy-local");

  const repoScript = path.join(repoADir, ".agents/skills/cloud-local-handoff/scripts/handoff.sh");
  assert.equal(fs.existsSync(repoScript), true);

  // Register a second project proj-b to test cross-project isolation
  await execFileAsync("node", [CLI, "project", "add", "proj-b", "--home", homeDir, "--path", repoBDir]);

  const { loadConfig, loadSecret } = await import("../src/config.js");
  const { config } = await loadConfig({ home: homeDir });
  const globalSecret = loadSecret({ home: homeDir, config });
  const logger = createLogger({ level: "error" });
  const orchestrator = new Orchestrator({ home: homeDir, config, logger });
  await orchestrator.init();

  const server = createBridgeServer({
    orchestrator,
    getSecret: () => globalSecret,
    logger,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await orchestrator.close();
    await new Promise((resolve) => server.close(resolve));
  });

  // Update .agents/bridge.json bridgeUrl via sync-templates so zero-flag health/dispatch hits live port
  await execFileAsync("node", [CLI, "sync-templates", "--home", homeDir, "--id", "proj-a", "--bridge-url", baseUrl]);
  await orchestrator.refreshConfigIfChanged();

  // Commit & push enrolled .agents/ files so local repo working tree is clean for safe-block
  await git(repoADir, ["add", "-A"]);
  await git(repoADir, ["commit", "-m", "chore: enroll agy-cloud-bridge"]);
  await git(repoADir, ["push", "origin", "main"]);
  assert.equal(await git(repoADir, ["status", "--porcelain"]), "");

  // Simulate Antigravity Cloud clone (never contains gitignored .agy-local)
  const cloudCloneDir = path.join(tmpDir, "cloud-clone");
  await git(tmpDir, ["clone", bareDir, cloudCloneDir]);
  assert.equal(fs.existsSync(path.join(cloudCloneDir, ".agy-local")), false);
  const cloudScript = path.join(cloudCloneDir, ".agents/skills/cloud-local-handoff/scripts/handoff.sh");

  // 1. Zero-env-var health & sync dispatch from simulated Cloud clone (no --force-local needed)
  const cleanEnv = { ...process.env };
  delete cleanEnv.AGY_BRIDGE_URL;
  delete cleanEnv.AGY_BRIDGE_SECRET;

  const healthRes = await execFileAsync("bash", [cloudScript, "health"], { cwd: cloudCloneDir, env: cleanEnv });
  assert.equal(JSON.parse(healthRes.stdout).ok, true);

  const syncRes = await execFileAsync(
    "bash",
    [cloudScript, "dispatch", "--mode", "sync", "--task", "zero-env test", "--wait", "20", "--ack", "--json"],
    { cwd: cloudCloneDir, env: cleanEnv },
  );
  const syncJson = JSON.parse(syncRes.stdout);
  assert.equal(syncJson.status, "fast_synced");
  assert.equal(syncJson.projectId, "proj-a");

  // 1b. Local marker guard inside local repoADir (without AGY_BRIDGE_HOME or --force-local) skips cleanly in both runtimes
  const localMarkerSkipPy = await execFileAsync(
    "bash",
    [repoScript, "dispatch", "--mode", "sync", "--task", "should skip by marker", "--json"],
    { cwd: repoADir, env: { ...cleanEnv, AGY_HANDOFF_RUNTIME: "python3" } },
  );
  const localMarkerSkipPyJson = JSON.parse(localMarkerSkipPy.stdout);
  assert.equal(localMarkerSkipPyJson.status, "skipped_local_marker_present");
  assert.equal(localMarkerSkipPyJson.localMarkerFile, ".agy-local");

  const localMarkerSkipNode = await execFileAsync(
    "bash",
    [repoScript, "dispatch", "--mode", "sync", "--task", "should skip by marker node", "--json"],
    { cwd: repoADir, env: { ...cleanEnv, AGY_HANDOFF_RUNTIME: "node" } },
  );
  assert.equal(JSON.parse(localMarkerSkipNode.stdout).status, "skipped_local_marker_present");

  // 2. Anti-recursion: AGY_BRIDGE_LOCAL_SESSION=1 safely skips without hitting server
  const nestedRes = await execFileAsync(
    "bash",
    [cloudScript, "dispatch", "--task", "should skip", "--json"],
    { cwd: cloudCloneDir, env: { ...cleanEnv, AGY_BRIDGE_LOCAL_SESSION: "1" } },
  );
  assert.equal(JSON.parse(nestedRes.stdout).status, "skipped_nested_local_session");

  // 3. Cross-project scope isolation: proj-a token MUST receive 403 when targeting proj-b
  const bridgeCfg = JSON.parse(await fsp.readFile(path.join(repoADir, ".agents/bridge.json"), "utf8"));
  const evilBody = JSON.stringify({ projectId: "proj-b", task: "hijack" });
  const evilHdr = createAuthHeaders({
    secret: bridgeCfg.projectToken,
    projectId: "proj-a",
    method: "POST",
    pathWithQuery: "/api/v1/handoffs",
    rawBody: evilBody,
  });
  const evilResp = await fetch(`${baseUrl}/api/v1/handoffs`, {
    method: "POST",
    headers: { ...evilHdr, "Content-Type": "application/json" },
    body: evilBody,
  });
  assert.equal(evilResp.status, 403);
  const evilJson = await evilResp.json();
  assert.equal(evilJson.code, "FORBIDDEN_PROJECT_SCOPE");

  // 4. Rotate proj-a token -> old token fails (401), new token pulled into cloudCloneDir succeeds
  await execFileAsync("node", [CLI, "project", "rotate-token", "proj-a", "--home", homeDir]);
  await orchestrator.refreshConfigIfChanged();
  await git(repoADir, ["add", ".agents/bridge.json"]);
  await git(repoADir, ["commit", "-m", "chore: rotate bridge token"]);
  await git(repoADir, ["push", "origin", "main"]);
  await git(cloudCloneDir, ["pull", "--ff-only", "origin", "main"]);

  const oldTokenBody = JSON.stringify({ task: "with old token" });
  const oldTokenHdr = createAuthHeaders({
    secret: bridgeCfg.projectToken,
    projectId: "proj-a",
    method: "POST",
    pathWithQuery: "/api/v1/handoffs",
    rawBody: oldTokenBody,
  });
  const oldTokenResp = await fetch(`${baseUrl}/api/v1/handoffs`, {
    method: "POST",
    headers: { ...oldTokenHdr, "Content-Type": "application/json" },
    body: oldTokenBody,
  });
  assert.equal(oldTokenResp.status, 401);

  const rotatedRes = await execFileAsync(
    "bash",
    [cloudScript, "dispatch", "--mode", "sync", "--task", "after rotate", "--wait", "20", "--ack", "--json"],
    { cwd: cloudCloneDir, env: cleanEnv },
  );
  assert.equal(JSON.parse(rotatedRes.stdout).status, "fast_synced");

  // 5. --force-local overrides local marker & host guard in both python3 and node runtimes,
  //    and removing .agy-local falls back cleanly to skipped_already_on_local_host
  const forcePyRes = await execFileAsync(
    "bash",
    [repoScript, "dispatch", "--force-local", "--mode", "sync", "--task", "force py test", "--wait", "20", "--ack", "--json"],
    { cwd: repoADir, env: { ...cleanEnv, AGY_BRIDGE_HOME: homeDir, AGY_HANDOFF_RUNTIME: "python3" } },
  );
  assert.equal(JSON.parse(forcePyRes.stdout).status, "fast_synced");

  const nodeFallbackRes = await execFileAsync(
    "bash",
    [repoScript, "dispatch", "--force-local", "--mode", "sync", "--task", "node fallback test", "--wait", "20", "--ack", "--json"],
    { cwd: repoADir, env: { ...cleanEnv, AGY_BRIDGE_HOME: homeDir, AGY_HANDOFF_RUNTIME: "node" } },
  );
  assert.equal(JSON.parse(nodeFallbackRes.stdout).status, "fast_synced");

  await fsp.rm(path.join(repoADir, ".agy-local"));
  const localHostSkip = await execFileAsync(
    "bash",
    [repoScript, "dispatch", "--mode", "sync", "--task", "should skip on local mac fallback", "--json"],
    { cwd: repoADir, env: { ...cleanEnv, AGY_BRIDGE_HOME: homeDir } },
  );
  assert.equal(JSON.parse(localHostSkip.stdout).status, "skipped_already_on_local_host");
});

test("Multi-repo group handoff: auto sibling discovery, selective sync, cross-repo fix pushback, and cross-group isolation", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-bridge-multirepo-"));
  t.after(async () => fsp.rm(tmpDir, { recursive: true, force: true }));

  const homeDir = path.join(tmpDir, "bridge-home");
  const cloudWorkspace = path.join(tmpDir, "cloud-ws");
  const localWorkspace = path.join(tmpDir, "local-ws");
  const bareRoot = path.join(tmpDir, "bare");
  await fsp.mkdir(cloudWorkspace, { recursive: true });
  await fsp.mkdir(localWorkspace, { recursive: true });
  await fsp.mkdir(bareRoot, { recursive: true });

  async function createRepoPair(name) {
    const bare = path.join(bareRoot, `${name}.git`);
    const cloud = path.join(cloudWorkspace, name);
    const local = path.join(localWorkspace, name);
    await fsp.mkdir(bare, { recursive: true });
    await git(bare, ["init", "--bare", "-b", "main"]);
    await git(bareRoot, ["clone", bare, cloud]);
    await git(cloud, ["config", "user.email", "cloud@example.com"]);
    await git(cloud, ["config", "user.name", "Cloud"]);
    await fsp.writeFile(path.join(cloud, "README.md"), `# ${name}\n`);
    await git(cloud, ["add", "-A"]);
    await git(cloud, ["commit", "-m", `init ${name}`]);
    await git(cloud, ["push", "-u", "origin", "main"]);
    await git(bareRoot, ["clone", bare, local]);
    await git(local, ["config", "user.email", "local@example.com"]);
    await git(local, ["config", "user.name", "Local"]);
    return { bare, cloud, local };
  }

  const svcGo = await createRepoPair("svc-go");
  const svcWeb = await createRepoPair("svc-web");
  const svcDocs = await createRepoPair("svc-docs");
  const otherApp = await createRepoPair("other-app");

  // Mock agy launcher verifies it receives multi-repo manifest, writeRoots for all group repos, and pushes a fix to svc-go
  const mockLauncher = path.join(tmpDir, "mock-multirepo-agy.sh");
  await fsp.writeFile(
    mockLauncher,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "--check" ]]; then
  echo "mock proxy ok"
  exit 0
fi
read -r prompt_line
node -e '
  const fs = require("fs");
  const path = require("path");
  const { execSync } = require("child_process");
  const roots = JSON.parse(process.env.AGY_BRIDGE_GUARD_WRITE_ROOTS);
  const msg = JSON.parse(process.argv[1]);
  const text = msg.text || JSON.stringify(msg);
  if (!text.includes("svc-go") || !text.includes("svc-web") || !text.includes("有变更")) {
    throw new Error("Multi-repo change manifest missing from prompt: " + text);
  }
  const goDir = roots.find((r) => r.endsWith("/svc-go"));
  if (!goDir) throw new Error("svc-go missing from AGY_BRIDGE_GUARD_WRITE_ROOTS: " + JSON.stringify(roots));
  fs.writeFileSync(path.join(goDir, "fix.go"), "package main // fixed locally\\n");
  execSync("git add fix.go && git commit -m \\"fix(go): cross-repo contract fix\\" && git push origin HEAD:main", { cwd: goDir, stdio: "inherit" });
' "$prompt_line"
echo '{"event":"init","conversation_id":"conv-multi-1"}'
echo '{"event":"result","result":{"conversation_id":"conv-multi-1","status":"SUCCESS","response":"多仓联调并修复完成。\\n<<<AGY_RESULT_JSON>>>\\n{\\"status\\":\\"ok\\",\\"summary\\":\\"已完成 svc-go 与 svc-web 联调并推回 svc-go 修复\\",\\"testsPassed\\":true}\\n<<<END_AGY_RESULT_JSON>>>"}}'
`,
    { mode: 0o755 },
  );
  fs.chmodSync(mockLauncher, 0o755);

  const initRes = await initBridge({ home: homeDir });
  const cfg = initRes.config;
  cfg.agy.launcher = mockLauncher;
  cfg.agy.requireProxy = true;
  await saveConfig(cfg, homeDir);

  const orchestrator = new Orchestrator({
    home: homeDir,
    config: cfg,
    logger: createLogger({ level: "error" }),
  });
  await orchestrator.init();
  const server = createBridgeServer({
    orchestrator,
    getSecret: () => "",
    logger: createLogger({ level: "error" }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await orchestrator.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const port = server.address().port;
  const bridgeUrl = `http://127.0.0.1:${port}`;

  const cliPath = path.resolve(__dirname, "../src/cli.js");
  for (const [id, pair, grp] of [
    ["svc-go", svcGo, "demo-group"],
    ["svc-web", svcWeb, "demo-group"],
    ["svc-docs", svcDocs, "demo-group"],
    ["other-app", otherApp, ""],
  ]) {
    const args = [cliPath, "enroll", pair.local, "--id", id, "--bridge-url", bridgeUrl, "--skip-public-check", "--home", homeDir];
    if (grp) args.push("--group", grp);
    await execFileAsync(process.execPath, args);
    await git(pair.local, ["add", ".gitignore", "AGENTS.md", ".agents"]);
    await git(pair.local, ["commit", "-m", `enroll ${id}`]);
    await git(pair.local, ["push", "origin", "main"]);
    await git(pair.cloud, ["pull", "--ff-only", "origin", "main"]);
  }

  // Leave an uncommitted scratch file in local svc-docs (unchanged repo in Cloud) -> must NOT block svc-go + svc-web handoff!
  await fsp.writeFile(path.join(svcDocs.local, "README.md"), "# dirty local note in untouched repo\n");

  // Cloud modifies BOTH svc-go AND svc-web, pushes both
  await fsp.writeFile(path.join(svcGo.cloud, "api.go"), "package main\n");
  await git(svcGo.cloud, ["add", "api.go"]);
  await git(svcGo.cloud, ["commit", "-m", "feat(go): new endpoint"]);
  await git(svcGo.cloud, ["push", "origin", "main"]);

  await fsp.writeFile(path.join(svcWeb.cloud, "ui.ts"), "export const ok = true;\n");
  await git(svcWeb.cloud, ["add", "ui.ts"]);
  await git(svcWeb.cloud, ["commit", "-m", "feat(web): consume endpoint"]);
  await git(svcWeb.cloud, ["push", "origin", "main"]);

  const cleanEnv = { ...process.env };
  delete cleanEnv.AGY_BRIDGE_SECRET;
  delete cleanEnv.AGY_BRIDGE_URL;
  delete cleanEnv.AGY_BRIDGE_LOCAL_SESSION;

  // Dispatch ONCE from cloud svc-web -> auto-discovers sibling svc-go + svc-docs, pulls both changed repos, runs 1 agy, and --pull pulls svc-go fix back to cloud!
  const webScript = path.join(svcWeb.cloud, ".agents/skills/cloud-local-handoff/scripts/handoff.sh");
  const dispatchOut = await execFileAsync(
    "bash",
    [webScript, "dispatch", "--mode", "agent", "--task-type", "preview_and_test", "--task", "联调 svc-go 与 svc-web", "--wait", "30", "--pull", "--ack", "--json"],
    { cwd: svcWeb.cloud, env: { ...cleanEnv, AGY_BRIDGE_HOME: path.join(tmpDir, "empty-cloud-home") } },
  );
  const rec = JSON.parse(dispatchOut.stdout);
  assert.equal(rec.status, "succeeded");
  assert.deepEqual(rec.changedProjects.sort(), ["svc-go", "svc-web"]);
  assert.ok(rec.pushedCommits["svc-go"], "expected local agy fix commit in pushedCommits[svc-go]");
  assert.equal(fs.existsSync(path.join(svcGo.cloud, "fix.go")), true, "expected --pull to pull svc-go fix back into cloud sibling repo");

  // Cross-group isolation: other-app cannot include svc-go via --also-repo
  await assert.rejects(
    execFileAsync(
      "bash",
      [
        path.join(otherApp.cloud, ".agents/skills/cloud-local-handoff/scripts/handoff.sh"),
        "dispatch",
        "--also-repo",
        svcGo.cloud,
        "--mode",
        "sync",
        "--wait",
        "10",
        "--json",
      ],
      { cwd: otherApp.cloud, env: { ...cleanEnv, AGY_BRIDGE_HOME: path.join(tmpDir, "empty-cloud-home") } },
    ),
    /FORBIDDEN_PROJECT_SCOPE/,
  );

  // Verify cloud-sync-gate.sh Stop lifecycle hook:
  const runGateHook = (cwd, env, hookPayload) => {
    const res = spawnSync("bash", ["./hooks/cloud-sync-gate.sh"], {
      cwd,
      env,
      input: JSON.stringify(hookPayload),
      encoding: "utf8",
    });
    assert.equal(res.status, 0, `hook exited ${res.status}: ${res.stderr}`);
    return JSON.parse(res.stdout);
  };

  // 1) Local Mac (.agy-local present) -> immediate {"decision":"stop"} even with dirty files
  const localHookOut = runGateHook(
    path.join(svcDocs.local, ".agents"),
    { ...cleanEnv, AGY_BRIDGE_HOME: homeDir },
    { hookEventName: "Stop", conversationId: "c-local", terminationReason: "NO_TOOL_CALL", fullyIdle: true },
  );
  assert.equal(localHookOut.decision, "stop");

  // 2) Cloud SessionStart snapshots initial HEADs
  const convId = `c-cloud-${Date.now()}`;
  const cloudAgentsDir = path.join(svcWeb.cloud, ".agents");
  const cloudEnv = { ...cleanEnv, AGY_BRIDGE_HOME: path.join(tmpDir, "empty-cloud-home") };
  runGateHook(cloudAgentsDir, cloudEnv, { hookEventName: "SessionStart", conversationId: convId });

  // 3) Cloud dirty file -> Stop hook blocks termination with {"decision":"continue"}
  await fsp.writeFile(path.join(svcGo.cloud, "uncommitted.go"), "package main\n");
  const dirtyHookOut = runGateHook(cloudAgentsDir, cloudEnv, {
    hookEventName: "Stop",
    conversationId: convId,
    terminationReason: "NO_TOOL_CALL",
    fullyIdle: true,
  });
  assert.equal(dirtyHookOut.decision, "continue");
  assert.match(dirtyHookOut.reason, /svc-go/);

  // 4) Cloud async handoff waiting in background (fullyIdle: false) -> allows stop so 0 tokens are spent waiting
  const bgHookOut = runGateHook(cloudAgentsDir, cloudEnv, {
    hookEventName: "Stop",
    conversationId: convId,
    terminationReason: "NO_TOOL_CALL",
    fullyIdle: false,
  });
  assert.equal(bgHookOut.decision, "stop");

  // 5) Cloud commits & pushes svcGo, BEFORE running handoff.sh -> Stop hook still blocks ("已推送但尚未触发本地拉取部署")
  await git(svcGo.cloud, ["add", "uncommitted.go"]);
  await git(svcGo.cloud, ["commit", "-m", "feat(go): pushed without deploy"]);
  await git(svcGo.cloud, ["push", "origin", "main"]);
  const pushedNoDeployOut = runGateHook(cloudAgentsDir, cloudEnv, {
    hookEventName: "Stop",
    conversationId: convId,
    terminationReason: "NO_TOOL_CALL",
    fullyIdle: true,
  });
  assert.equal(pushedNoDeployOut.decision, "continue");
  assert.match(pushedNoDeployOut.reason, /已推送但尚未触发本地拉取部署/);

  // 6) Cloud runs handoff.sh dispatch -> stamps attempted HEADs -> Stop hook now cleanly returns {"decision":"stop"}!
  await execFileAsync(
    "bash",
    [webScript, "dispatch", "--mode", "sync", "--wait", "20", "--ack", "--json"],
    { cwd: svcWeb.cloud, env: cloudEnv },
  );
  const afterDeployOut = runGateHook(cloudAgentsDir, cloudEnv, {
    hookEventName: "Stop",
    conversationId: convId,
    terminationReason: "NO_TOOL_CALL",
    fullyIdle: true,
  });
  assert.equal(afterDeployOut.decision, "stop");
});
