#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { checkAgyRunner } from "./agy-runner.js";
import {
  addProject,
  configPath,
  findProject,
  generateProjectToken,
  initBridge,
  loadConfig,
  loadSecret,
  normalizeLocalMarkerFile,
  removeProject,
  resolveHome,
  rotateProjectToken,
  saveConfig,
  secretPath,
  slugify,
  validateConfig,
} from "./config.js";
import { inspectRepo } from "./git-sync.js";
import { createLogger } from "./logger.js";
import { Orchestrator } from "./orchestrator.js";
import { createBridgeServer } from "./server.js";
import { checkGithubRepoPublic, writeRepoBridgeFiles } from "./templates.js";
import { expandPath } from "./util.js";

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eqIdx = arg.indexOf("=");
    if (eqIdx !== -1) {
      flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { positionals, flags };
}

function printUsage() {
  console.log(`agy-cloud-bridge — 通用云端 ⇄ 本地 Antigravity (agy) 协同网关

用法:
  node src/cli.js init [--force] [--runs-dir <dir>] [--worktrees-dir <dir>]
  node src/cli.js start
  node src/cli.js doctor [--skip-proxy]
  node src/cli.js enroll <repoPath> [--id <id>] [--name <name>] [--group <group>] [--bridge-url <https://...>] [--channel http|git-ref] [--remote <owner/repo>] [--branches "main,feat/*"] [--fast-paths "regex1,regex2"] [--local-marker <relPath>] [--dirty-policy safe-block|worktree] [--allow-push] [--no-push] [--context "..."] [--rotate-token] [--allow-public-repo]
  node src/cli.js sync-templates [--id <id>] [--bridge-url <https://...>] [--channel http|git-ref] [--local-marker <relPath>]
  node src/cli.js project add <id> --path <repoPath> [--local-marker <relPath>] [...]
  node src/cli.js project rotate-token <id>
  node src/cli.js project list
  node src/cli.js project rm <id>
  node src/cli.js status
  node src/cli.js cleanup [--hours 24]
`);
}

async function cmdInit(flags) {
  const home = resolveHome(flags.home);
  const res = await initBridge({ home, force: Boolean(flags.force) });
  let updated = false;
  if (flags["runs-dir"] !== undefined) {
    res.config.runtime.runsDir = String(flags["runs-dir"] || "").trim();
    updated = true;
  }
  if (flags["worktrees-dir"] !== undefined) {
    res.config.runtime.worktreesDir = String(flags["worktrees-dir"] || "").trim();
    updated = true;
  }
  if (updated) {
    await saveConfig(res.config, home);
  }
  console.log(`状态目录: ${res.home}`);
  console.log(`配置文件: ${res.configFile} (${res.configCreated ? "已新建" : "已保留"})`);
  console.log(`鉴权密钥: ${res.secretFile} (${res.secretCreated ? "已生成 600 权限密钥" : "已保留"})`);
  if (res.config.runtime.runsDir) console.log(`临时运行目录 (runsDir): ${expandPath(res.config.runtime.runsDir)}`);
  if (res.config.runtime.worktreesDir) console.log(`临时工作树目录 (worktreesDir): ${expandPath(res.config.runtime.worktreesDir)}`);
}

async function cmdProject(subArgs, flags) {
  const sub = subArgs[0];
  const { home, config } = await loadConfig({ home: flags.home });

  if (sub === "list") {
    if (config.projects.length === 0) {
      console.log("暂未登记任何项目。使用 `project add` 添加。");
      return;
    }
    for (const p of config.projects) {
      console.log(`- ${p.id} (${p.name})${p.group ? ` [group=${p.group}]` : ""}`);
      console.log(`  path: ${p.repoPath}`);
      console.log(`  remoteMatch: ${p.remoteMatch || "-"} | branches: ${p.allowedBranches.join(", ")} | dirtyPolicy: ${p.dirtyPolicy} | allowGitPush: ${p.allowGitPush} | token: ${p.token ? "已配置(masked)" : "未配置"}`);
      if (p.fastPaths.length) console.log(`  fastPaths: ${p.fastPaths.join(", ")}`);
    }
    return;
  }

  if (sub === "rotate-token") {
    const id = subArgs[1];
    if (!id) throw new Error("用法: project rotate-token <id>");
    const project = rotateProjectToken(config, id);
    await saveConfig(config, home);
    const bridgeJsonFile = path.join(project.repoPath, ".agents", "bridge.json");
    if (fs.existsSync(bridgeJsonFile)) {
      let existingUrl = "";
      try {
        existingUrl = JSON.parse(fs.readFileSync(bridgeJsonFile, "utf8"))?.bridgeUrl || "";
      } catch {
        existingUrl = "";
      }
      const bridgeUrl = String(config.server?.publicUrl || existingUrl || "").replace(/\/+$/, "");
      await writeRepoBridgeFiles({ repoPath: project.repoPath, bridgeUrl, project });
      console.log(`已轮换项目 ${project.id} 独立令牌并同步更新 ${bridgeJsonFile}`);
    } else {
      console.log(`已轮换项目 ${project.id} 独立令牌（未发现 .agents/bridge.json，请运行 enroll 注入）`);
    }
    return;
  }

  if (sub === "add") {
    const id = subArgs[1] || flags.id;
    const repoPath = flags.path || flags["repo-path"];
    if (!id || !repoPath) {
      throw new Error("用法: project add <id> --path <绝对仓库路径>");
    }
    const repoInfo = await inspectRepo(repoPath).catch(() => null);
    const allowedBranches = flags.branches
      ? String(flags.branches).split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    const fastPaths = flags["fast-paths"]
      ? String(flags["fast-paths"]).split(",").map((s) => s.trim()).filter(Boolean)
      : [];

    const project = addProject(config, {
      id,
      name: flags.name || id,
      group: flags.group || "",
      repoPath,
      remoteMatch: flags.remote || repoInfo?.remoteUrl || "",
      allowedBranches,
      dirtyPolicy: flags["dirty-policy"] || "safe-block",
      allowGitPush: flags["no-push"] ? false : true,
      sandbox: flags["no-sandbox"] ? false : flags.sandbox ? true : null,
      maxRounds: flags["max-rounds"] ? Number(flags["max-rounds"]) : 5,
      fastPaths,
      localMarkerFile: flags["local-marker"] !== undefined ? normalizeLocalMarkerFile(flags["local-marker"]) : undefined,
      localContext: flags.context || "",
    });
    await saveConfig(config, home);
    console.log(`已登记项目: ${project.id} -> ${project.repoPath}`);
    return;
  }

  if (sub === "rm" || sub === "remove") {
    const id = subArgs[1];
    if (!id) throw new Error("用法: project rm <id>");
    const removed = removeProject(config, id);
    await saveConfig(config, home);
    console.log(`已移除项目: ${removed.id}`);
    return;
  }

  throw new Error(`未知 project 子命令: ${sub || "(空)"}`);
}

async function cmdEnroll(subArgs, flags) {
  const rawRepoPath = subArgs[0] || flags.path;
  if (!rawRepoPath) {
    throw new Error("用法: enroll <repoPath> [--bridge-url https://...]");
  }
  const repoPath = expandPath(rawRepoPath);
  const home = resolveHome(flags.home);
  if (!fs.existsSync(configPath(home))) {
    await initBridge({ home });
  }
  const { config } = await loadConfig({ home });

  const repoInfo = await inspectRepo(repoPath);
  if (!repoInfo.exists || !repoInfo.isGit) {
    throw new Error(`目标目录不存在或不是 Git 仓库：${repoPath}`);
  }

  const remoteCandidate = flags.remote || repoInfo.remoteUrl || "";
  if (!flags["allow-public-repo"] && !flags["skip-public-check"] && remoteCandidate) {
    const pub = await checkGithubRepoPublic(remoteCandidate);
    if (pub.checked && pub.isPublic) {
      throw new Error(
        `检测到目标仓库为公开仓库（GitHub 返回 HTTP 200），为防密钥泄露已拒绝将 projectToken 写入 .agents/bridge.json。若确认需继续，请显式追加 --allow-public-repo。`,
      );
    }
  }

  const requestedId = slugify(flags.id || path.basename(repoPath));
  let project =
    findProject(config, { projectId: requestedId }) ||
    config.projects.find((p) => path.resolve(p.repoPath) === path.resolve(repoPath)) ||
    null;

  const allowedBranches = flags.branches
    ? String(flags.branches).split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  const fastPaths =
    flags["fast-paths"] !== undefined
      ? String(flags["fast-paths"]).split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;

  if (project) {
    if (flags.name) project.name = String(flags.name);
    if (flags.group !== undefined) project.group = slugify(flags.group);
    if (flags.remote || (!project.remoteMatch && remoteCandidate)) project.remoteMatch = remoteCandidate;
    if (allowedBranches) project.allowedBranches = allowedBranches;
    if (flags.channel === "http" || flags.channel === "git-ref") project.defaultChannel = flags.channel;
    if (flags["dirty-policy"]) project.dirtyPolicy = flags["dirty-policy"];
    if (flags["no-push"]) project.allowGitPush = false;
    else if (flags["allow-push"]) project.allowGitPush = true;
    if (flags["no-sandbox"]) project.sandbox = false;
    else if (flags.sandbox) project.sandbox = true;
    if (flags["max-rounds"]) project.maxRounds = Math.max(1, Number(flags["max-rounds"]));
    if (fastPaths !== undefined) project.fastPaths = fastPaths;
    if (flags["local-marker"] !== undefined) project.localMarkerFile = normalizeLocalMarkerFile(flags["local-marker"]);
    if (flags.context !== undefined) project.localContext = String(flags.context);
    if (!project.token || flags["rotate-token"]) {
      project.token = generateProjectToken();
    }
  } else {
    project = addProject(config, {
      id: requestedId,
      name: flags.name || requestedId,
      group: flags.group || "",
      repoPath,
      remoteMatch: remoteCandidate,
      allowedBranches,
      defaultChannel: flags.channel === "git-ref" ? "git-ref" : "http",
      dirtyPolicy: flags["dirty-policy"] || "safe-block",
      allowGitPush: flags["no-push"] ? false : true,
      sandbox: flags["no-sandbox"] ? false : flags.sandbox ? true : null,
      maxRounds: flags["max-rounds"] ? Number(flags["max-rounds"]) : 5,
      fastPaths: fastPaths || [],
      localMarkerFile: flags["local-marker"] !== undefined ? normalizeLocalMarkerFile(flags["local-marker"]) : undefined,
      localContext: flags.context || "",
    });
  }

  const bridgeUrl = String(flags["bridge-url"] || config.server?.publicUrl || "").replace(/\/+$/, "");
  if (flags["bridge-url"]) {
    config.server.publicUrl = bridgeUrl;
  }
  if (project.defaultChannel === "git-ref") {
    config.gitWatcher.enabled = true;
  }

  await saveConfig(config, home);
  const written = await writeRepoBridgeFiles({ repoPath: project.repoPath, bridgeUrl, project });

  console.log(`已接入项目: ${project.id} (${project.repoPath})`);
  console.log(
    `通道: ${project.defaultChannel} | 网关域名: ${bridgeUrl || "(未设置，仅 git-ref 通道或稍后通过 sync-templates --bridge-url 补充)"} | 独立项目令牌: 已写入 .agents/bridge.json（不回显明文）`,
  );
  if (!bridgeUrl && project.defaultChannel !== "git-ref") {
    console.log(
      `[提示] 当前未设置公网网关地址：若使用 HTTPS 通道，请执行 \`node src/cli.js sync-templates --id ${project.id} --bridge-url https://<your-domain>\`；若无需服务器可改用 \`--channel git-ref\`。`,
    );
  }
  console.log(`注入文件:`);
  console.log(`  - ${written.bridgeJsonPath}`);
  console.log(`  - ${written.hooksJsonPath}`);
  console.log(`  - ${written.hookScriptDstPath}`);
  console.log(`  - ${written.rulePath}`);
  console.log(`  - ${written.skillPath}`);
  console.log(`  - ${written.scriptDstPath}`);
  console.log(`  - ${written.agentsMdPath}`);
  console.log(`  - ${written.gitignorePath}`);
  console.log(`  - ${written.localMarkerPath}`);
}

async function cmdSyncTemplates(flags) {
  const home = resolveHome(flags.home);
  const { config } = await loadConfig({ home });
  const bridgeUrl = String(flags["bridge-url"] || config.server?.publicUrl || "").replace(/\/+$/, "");
  if (flags["bridge-url"]) {
    config.server.publicUrl = bridgeUrl;
  }

  const targets = flags.id
    ? [findProject(config, { projectId: flags.id })].filter(Boolean)
    : config.projects;

  if (targets.length === 0) {
    throw new Error(flags.id ? `未找到项目：${flags.id}` : "当前没有已登记的项目");
  }

  for (const project of targets) {
    if (!project.token) project.token = generateProjectToken();
    if (flags.channel === "http" || flags.channel === "git-ref") {
      project.defaultChannel = flags.channel;
      if (flags.channel === "git-ref") config.gitWatcher.enabled = true;
    }
    if (flags["local-marker"] !== undefined) {
      project.localMarkerFile = normalizeLocalMarkerFile(flags["local-marker"]);
    }
    await writeRepoBridgeFiles({ repoPath: project.repoPath, bridgeUrl, project });
    console.log(`已同步模板与配置: ${project.id} -> ${project.repoPath}`);
  }
  await saveConfig(config, home);
}

async function cmdDoctor(flags) {
  const home = resolveHome(flags.home);
  const { config } = await loadConfig({ home });
  let hasError = false;

  const { errors, warnings } = validateConfig(config);
  for (const w of warnings) console.log(`[WARN] ${w}`);
  for (const e of errors) {
    console.log(`[ERR]  ${e}`);
    hasError = true;
  }

  const secFile = secretPath(home);
  const secretVal = loadSecret({ home, config });
  if (!secretVal) {
    console.log(`[ERR]  未检测到鉴权密钥 (${secFile})`);
    hasError = true;
  } else {
    const st = fs.statSync(secFile);
    const mode = st.mode & 0o777;
    console.log(`[OK]   鉴权密钥就绪 (${secFile}, mode=${mode.toString(8)}, len=${secretVal.length})`);
  }

  const resolvedRunsDir = config.runtime?.runsDir ? expandPath(config.runtime.runsDir) : path.join(home, "runs");
  const resolvedWorktreesDir = config.runtime?.worktreesDir
    ? expandPath(config.runtime.worktreesDir)
    : path.join(home, "worktrees");
  console.log(`[OK]   临时目录: runsDir=${resolvedRunsDir} | worktreesDir=${resolvedWorktreesDir}`);

  if (!flags["skip-proxy"]) {
    try {
      const runnerCheck = await checkAgyRunner(config);
      const label = runnerCheck.runner.kind === "launcher" ? "出口代理与 agy" : "本机 agy CLI";
      if (runnerCheck.ok) {
        console.log(`[OK]   ${label} 校验通过 (${runnerCheck.runner.command}): ${runnerCheck.detail}`);
      } else {
        console.log(`[ERR]  ${label} 校验失败 (${runnerCheck.runner.command}): ${runnerCheck.detail}`);
        hasError = true;
      }
    } catch (err) {
      console.log(`[ERR]  agy 执行入口解析失败: ${err?.message || err}`);
      hasError = true;
    }
  }

  for (const p of config.projects) {
    const info = await inspectRepo(p.repoPath, p.gitEnv);
    if (!info.exists || !info.isGit) {
      console.log(`[ERR]  项目 ${p.id} 仓库不可用: ${p.repoPath}`);
      hasError = true;
    } else {
      const bridgeFile = path.join(p.repoPath, ".agents", "bridge.json");
      let tokenState = p.token ? "local-token:ok" : "local-token:missing";
      if (fs.existsSync(bridgeFile)) {
        try {
          const bj = JSON.parse(fs.readFileSync(bridgeFile, "utf8"));
          tokenState += bj.projectToken === p.token ? ",repo-bridge:synced" : ",repo-bridge:mismatch";
        } catch {
          tokenState += ",repo-bridge:invalid";
        }
      } else {
        tokenState += ",repo-bridge:not-enrolled";
      }
      const markerRel = p.localMarkerFile || ".agy-local";
      const hasMarker = fs.existsSync(path.join(p.repoPath, markerRel));
      tokenState += `,local-marker:${hasMarker ? "ok" : "missing"}`;
      console.log(
        `[OK]   项目 ${p.id}${p.group ? ` [group:${p.group}]` : ""}: branch=${info.branch} head=${info.head.slice(0, 8)} dirty=${info.dirtyFiles.length} (${tokenState})`,
      );
      if (!hasMarker) {
        console.log(`[WARN] 项目 ${p.id} 缺少本地标记文件 ${markerRel}，建议运行 node src/cli.js sync-templates --id ${p.id} 自动补全`);
      }
    }
  }

  if (config.server?.publicUrl) {
    console.log(`[OK]   公网 HTTPS 入口已配置: ${config.server.publicUrl}`);
  } else if (config.gitWatcher?.enabled) {
    console.log(`[OK]   已启用零服务器 git-ref 协作监听（intervalSec=${config.gitWatcher.intervalSec}）`);
  } else {
    console.log(`[WARN] 尚未配置 server.publicUrl，且未启用 gitWatcher（请配合 Cloudflare Tunnel / FRP 配置公网域名，或启用 git-ref 通道）`);
  }

  if (hasError) process.exitCode = 1;
}

async function cmdStart(flags) {
  const home = resolveHome(flags.home);
  const { config } = await loadConfig({ home });
  const { errors } = validateConfig(config);
  if (errors.length > 0) {
    throw new Error(`配置校验失败：\n${errors.join("\n")}`);
  }
  const secret = loadSecret({ home, config });
  if (!secret) {
    throw new Error(`缺少鉴权密钥，请先执行 init 或检查 ${secretPath(home)}`);
  }

  const logger = createLogger({});
  const orchestrator = new Orchestrator({ home, config, logger });
  await orchestrator.init();

  const server = createBridgeServer({
    orchestrator,
    getSecret: () => loadSecret({ home, config: orchestrator.config }),
    replayWindowSec: config.server?.replayWindowSec || 300,
    logger,
  });

  const host = String(process.env.HOST || config.server?.host || "127.0.0.1");
  const port = Number(process.env.PORT || config.server?.port || 3190);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  logger.info(`agy-cloud-bridge 已启动：http://${host}:${port}（状态目录 ${home}）`);

  const shutdown = async (sig) => {
    logger.info(`收到 ${sig}，正在优雅退出...`);
    await orchestrator.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref?.();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function cmdStatus(flags) {
  const home = resolveHome(flags.home);
  const { config } = await loadConfig({ home });
  const port = Number(process.env.PORT || config.server?.port || 3190);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
    const data = await res.json();
    console.log(`服务状态: 运行中 (http://127.0.0.1:${port}) -> ${JSON.stringify(data)}`);
  } catch {
    console.log(`服务状态: 未运行 (http://127.0.0.1:${port})`);
    process.exitCode = 1;
  }
}

async function cmdCleanup(flags) {
  const home = resolveHome(flags.home);
  const { config } = await loadConfig({ home });
  if (flags.hours !== undefined) {
    config.cleanup.retentionHours = Number(flags.hours);
  }
  const logger = createLogger({});
  const orchestrator = new Orchestrator({ home, config, logger });
  await orchestrator.init();
  const count = await orchestrator.runSweep();
  await orchestrator.close();
  console.log(`清理完成：共回收 ${count} 条过期运行目录。`);
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const cmd = positionals[0];

  if (!cmd || cmd === "help" || flags.help) {
    printUsage();
    return;
  }
  if (cmd === "init") return cmdInit(flags);
  if (cmd === "enroll") return cmdEnroll(positionals.slice(1), flags);
  if (cmd === "sync-templates") return cmdSyncTemplates(flags);
  if (cmd === "project") return cmdProject(positionals.slice(1), flags);
  if (cmd === "doctor") return cmdDoctor(flags);
  if (cmd === "start") return cmdStart(flags);
  if (cmd === "status") return cmdStatus(flags);
  if (cmd === "cleanup") return cmdCleanup(flags);

  throw new Error(`未知命令: ${cmd}`);
}

main().catch((err) => {
  console.error(`[ERROR] ${err?.message || err}`);
  process.exit(1);
});
