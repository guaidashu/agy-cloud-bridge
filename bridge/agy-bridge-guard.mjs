#!/usr/bin/env node
/**
 * Antigravity CLI (agy) 云地协同 PreToolUse 安全护栏钩子。
 *
 * 挂载于 `~/.agy-bridge/workspaces/<projectId>/.agents/hooks.json`，不侵入业务仓库。
 * 规则：
 * - 阻断会阻塞无头执行的交互/定时器工具；
 * - 严禁读写凭据与密钥目录（~/.agy-bridge, ~/.ssh, ~/.aws, ~/.gnupg 等及 AGY_BRIDGE_GUARD_DENY）；
 * - 严禁导出敏感环境变量；
 * - 写文件限制在目标仓库（或临时 worktree）与本次 run 的 scratch 目录；
 * - 禁止破坏性系统级控制命令与强制推送（git push --force）；
 * - 当 AGY_BRIDGE_ALLOW_PUSH !== "1" 时禁止 git push。
 */
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const WRITE_TOOLS = new Set([
  "write_to_file",
  "write_file",
  "replace_file_content",
  "multi_replace_file_content",
  "edit_file",
  "edit",
  "sed_file",
  "apply_patch",
  "multi_edit",
  "notebook_edit",
  "create_file",
  "delete_file",
  "generate_image",
]);

const ALWAYS_BLOCKED_TOOLS = new Set([
  "ask_question",
  "ask_user_question",
  "ask_permission",
  "ask_custom_permission",
  "schedule",
  "schedule_create",
  "schedule_edit",
  "delete_knowledge",
]);

const READ_TOOLS = new Set([
  "view_file",
  "read_file",
  "list_dir",
  "grep_search",
  "find_by_name",
  "view_file_outline",
  "view_code_item",
  "read",
  "grep",
  "glob",
  "ls",
]);

const PATH_ARG_KEYS = [
  "AbsolutePath",
  "Path",
  "TargetFile",
  "DirectoryPath",
  "SearchPath",
  "SearchDirectory",
  "Cwd",
  "file_path",
  "path",
  "dir",
  "directory",
  "cwd",
  "root",
];

const DANGEROUS_COMMAND =
  /(^|[\s;&|])(osascript|open|defaults|launchctl|crontab|at|systemsetup|networksetup|spctl|csrutil)\b/;

const FORCE_PUSH_COMMAND = /\bgit\s+push\b[^\n;|&]*(?:--force(?:-with-lease)?|-f\b|--mirror\b)/;
const PLAIN_PUSH_COMMAND = /\bgit\s+push\b/;
const DESTRUCTIVE_RM = /\brm\s+[^\n;|&]*-(?:r|f|rf|fr)\s+(?:\/|~\/?|\$HOME\/?)(?:\s|$|[;|&])/;

function parseList(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return String(value)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
}

function normalizePath(p, baseCwd) {
  const expanded = String(p)
    .replace(/^\$HOME(?=$|\/)/, os.homedir())
    .replace(/^\$\{HOME\}(?=$|\/)/, os.homedir())
    .replace(/^~(?=$|\/)/, os.homedir());
  return path.resolve(baseCwd || process.cwd(), expanded);
}

function isUnder(target, root) {
  const resolvedRoot = path.resolve(root);
  return target === resolvedRoot || target.startsWith(`${resolvedRoot}${path.sep}`);
}

export function evaluateToolCall(payload, env = process.env) {
  const toolCall = payload?.toolCall || {};
  const tool = String(toolCall.name || "").trim();
  const args = toolCall.args && typeof toolCall.args === "object" ? toolCall.args : {};
  const baseCwd = payload?.cwd || process.cwd();

  if (!tool) return { decision: "allow" };

  if (ALWAYS_BLOCKED_TOOLS.has(tool)) {
    return {
      decision: "deny",
      reason: `无头协同会话禁用了 \`${tool}\`：请在结构化结果中直接说明所需决策或阻塞点，禁止阻塞等待确认`,
    };
  }

  const writeRoots = parseList(env.AGY_BRIDGE_GUARD_WRITE_ROOTS).map((p) => normalizePath(p, baseCwd));
  const deniedRoots = parseList(env.AGY_BRIDGE_GUARD_DENY).map((p) => normalizePath(p, baseCwd));
  const allowPush = env.AGY_BRIDGE_ALLOW_PUSH === "1";

  const deniedHit = (target) => deniedRoots.find((root) => isUnder(target, root));
  const allowedWrite = (target) => writeRoots.some((root) => isUnder(target, root));

  const checkDeniedOnly = (raw) => {
    if (typeof raw !== "string" || !raw.trim()) return null;
    if (/[*?]/.test(raw) && !raw.includes("/")) return null;
    const target = normalizePath(raw, baseCwd);
    const blocked = deniedHit(target);
    if (blocked) return `安全护栏：禁止访问敏感路径 \`${blocked}\``;
    return null;
  };

  const checkWritePath = (raw) => {
    if (typeof raw !== "string" || !raw.trim()) return null;
    const target = normalizePath(raw, baseCwd);
    const blocked = deniedHit(target);
    if (blocked) return `安全护栏：禁止写入敏感路径 \`${blocked}\``;
    if (writeRoots.length > 0 && !allowedWrite(target)) {
      return `安全护栏：写操作仅限目标项目目录与本次运行 scratch 目录，禁止写入 \`${target}\``;
    }
    return null;
  };

  // 1. 写/编辑类工具
  if (WRITE_TOOLS.has(tool)) {
    for (const key of PATH_ARG_KEYS) {
      const err = checkWritePath(args[key]);
      if (err) return { decision: "deny", reason: err };
    }
    return { decision: "allow" };
  }

  // 2. 终端命令工具
  if (tool === "run_command" || tool === "bash" || tool === "pwsh") {
    const command = String(args.CommandLine || args.command || args.script || "");
    if (!command.trim()) return { decision: "allow" };

    if (/(^|[;&|]\s*)(env|printenv|export\s+-p)(\s|$)/.test(command)) {
      return { decision: "deny", reason: "安全护栏：禁止导出环境变量（可能包含代理或鉴权密钥）" };
    }
    if (/\$(?:AGY_BRIDGE_SECRET|BRIDGE_SECRET|PROXY_PASS|PROXY_USER|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|GH_TOKEN|OPENAI_API_KEY|GEMINI_API_KEY|ANTHROPIC_API_KEY)\b/.test(command)) {
      return { decision: "deny", reason: "安全护栏：禁止通过敏感环境变量访问密钥" };
    }
    if (/(^|[\s/"'=])\.(ssh|aws|gnupg|kube|docker|codex|agy-bridge)(\/|\s|$)/.test(command)) {
      return { decision: "deny", reason: "安全护栏：禁止访问凭据或网关配置目录" };
    }
    if (/(?:^|[\s/"'=])(?:[^/\s"']+\/)*(?:secret\.env|proxy\.env|\.credentials|\.netrc)(?:[\s"'`;|&]|$)/i.test(command)) {
      return { decision: "deny", reason: "安全护栏：禁止读取代理凭据或鉴权密钥文件" };
    }

    if (args.Cwd) {
      const cwdErr = checkDeniedOnly(args.Cwd);
      if (cwdErr) return { decision: "deny", reason: cwdErr };
    }

    const tokens = command.match(/(?:^|[\s"'=:(])((?:\/|~\/|\$HOME\/|\$\{HOME\}\/)[^\s"'`;|&)]+)/g) || [];
    for (const token of tokens) {
      const raw = token.replace(/^[\s"'=:(]/, "");
      const err = checkDeniedOnly(raw);
      if (err) return { decision: "deny", reason: err };
    }

    if (DANGEROUS_COMMAND.test(command)) {
      return { decision: "deny", reason: "安全护栏：禁止调用系统级控制命令（osascript/launchctl/defaults 等）" };
    }
    if (DESTRUCTIVE_RM.test(command)) {
      return { decision: "deny", reason: "安全护栏：禁止执行高危根目录删除命令" };
    }
    if (FORCE_PUSH_COMMAND.test(command)) {
      return { decision: "deny", reason: "安全护栏：禁止执行强制推送（git push --force / -f / --mirror）" };
    }
    if (!allowPush && PLAIN_PUSH_COMMAND.test(command)) {
      return { decision: "deny", reason: "安全护栏：当前项目配置 allowGitPush=false，禁止执行 git push" };
    }

    return { decision: "allow" };
  }

  // 3. 读类工具
  if (READ_TOOLS.has(tool)) {
    for (const key of PATH_ARG_KEYS) {
      const err = checkDeniedOnly(args[key]);
      if (err) return { decision: "deny", reason: err };
    }
    return { decision: "allow" };
  }

  return { decision: "allow" };
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  let payload = {};
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = {};
    }
  }
  const decision = evaluateToolCall(payload, process.env);
  process.stdout.write(`${JSON.stringify(decision)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stdout.write(`${JSON.stringify({ decision: "deny", reason: `护栏执行异常：${err?.message || err}` })}\n`);
  });
}
