import { execFile, spawn as nodeSpawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import { expandPath } from "./util.js";

const execFileAsync = promisify(execFile);
const DEFAULT_AGY_BIN = path.join(os.homedir(), ".local", "bin", "agy");

function resolveAgyBinaryOptional(config = {}) {
  if (config.agy?.binary) return expandPath(config.agy.binary);
  if (process.env.AGY_CLI) return expandPath(process.env.AGY_CLI);
  if (fs.existsSync(DEFAULT_AGY_BIN)) return DEFAULT_AGY_BIN;
  return "";
}

export function resolveAgyBinary(config = {}) {
  if (config.agy?.binary) {
    const configured = expandPath(config.agy.binary);
    if (!fs.existsSync(configured)) throw new Error(`agy.binary 不存在：${configured}`);
    return configured;
  }
  if (process.env.AGY_CLI) {
    const fromEnv = expandPath(process.env.AGY_CLI);
    if (fs.existsSync(fromEnv)) return fromEnv;
    throw new Error(`AGY_CLI 指向的文件不存在：${fromEnv}`);
  }
  if (fs.existsSync(DEFAULT_AGY_BIN)) return DEFAULT_AGY_BIN;
  const which = spawnSync("which", ["agy"], { encoding: "utf8" });
  const found = which.status === 0 ? which.stdout.trim() : "";
  if (found) return found;
  throw new Error("找不到 agy 命令：请确认 Antigravity CLI 已安装，或在 config.json 设置 agy.binary");
}

/**
 * 解析 agy 执行入口：
 * - 若配置了 `agy.launcher`，则通过代理/包装脚本执行；
 * - 若 `agy.requireProxy === true`，则强制要求 `agy.launcher` 存在且可执行，缺失时直接报错拒跑（Fail-Closed）；
 * - 否则默认直接调用本机 `agy` CLI。
 */
export function resolveAgyRunner(config = {}) {
  const requireProxy = config.agy?.requireProxy === true;
  const launcherRaw = String(config.agy?.launcher || "").trim();

  if (launcherRaw) {
    const launcher = expandPath(launcherRaw);
    if (fs.existsSync(launcher)) {
      return { kind: "launcher", command: launcher, binary: resolveAgyBinaryOptional(config) };
    }
    throw new Error(`出口代理启动器 agy.launcher 不存在：${launcher}`);
  }

  if (requireProxy) {
    throw new Error(
      "当前已开启 agy.requireProxy=true，必须配置 agy.launcher（例如 ~/scripts/agy-proxy-launcher.sh），禁止直连运行 agy",
    );
  }

  const binary = resolveAgyBinary(config);
  return { kind: "direct", command: binary, binary };
}

export function buildAgyArgs(
  config,
  {
    runnerKind = "launcher",
    conversationId = "",
    repoPaths = [],
    mode,
    model,
    effort,
    sandbox,
    dangerouslySkipPermissions,
    timeoutMs,
  } = {},
) {
  const agyCfg = config.agy || {};
  const cliArgs = ["--input-format", "stream-json", "--output-format", "stream-json"];

  const effectiveMode = mode !== undefined ? mode : agyCfg.mode || "";
  if (effectiveMode) cliArgs.push("--mode", effectiveMode);

  const effectiveModel = model !== undefined ? model : agyCfg.model || "";
  if (effectiveModel) cliArgs.push("--model", effectiveModel);

  const effectiveEffort = effort !== undefined ? effort : agyCfg.effort || "";
  if (effectiveEffort) cliArgs.push("--effort", effectiveEffort);

  const useSandbox = typeof sandbox === "boolean" ? sandbox : agyCfg.sandbox === true;
  if (useSandbox) cliArgs.push("--sandbox");

  const skipPerms =
    dangerouslySkipPermissions !== undefined ? dangerouslySkipPermissions : agyCfg.dangerouslySkipPermissions === true;
  if (skipPerms) cliArgs.push("--dangerously-skip-permissions");

  if (conversationId) cliArgs.push("--conversation", conversationId);

  for (const repoPath of repoPaths) {
    if (repoPath) cliArgs.push("--add-dir", repoPath);
  }

  const effectiveTimeoutMs = Number(timeoutMs ?? agyCfg.timeoutMs ?? 0);
  if (effectiveTimeoutMs > 0) {
    const seconds = Math.max(5, Math.ceil(effectiveTimeoutMs / 1000));
    cliArgs.push("--print-timeout", `${seconds}s`);
  }

  if (Array.isArray(agyCfg.extraArgs) && agyCfg.extraArgs.length) {
    cliArgs.push(...agyCfg.extraArgs);
  }

  return runnerKind === "launcher" ? ["--", ...cliArgs] : cliArgs;
}

export function parseAgyEventLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || !trimmed.startsWith("{")) return null;
  try {
    const value = JSON.parse(trimmed);
    if (!value || typeof value !== "object" || typeof value.event !== "string") return null;
    return value;
  } catch {
    return null;
  }
}

export function normalizeAgyEvent(raw) {
  if (!raw || typeof raw !== "object") return null;

  if (raw.event === "init") {
    return {
      type: "init",
      conversationId: raw.conversation_id || raw.init?.conversation_id || "",
      cwd: raw.init?.cwd || "",
      permissionMode: raw.init?.permission_mode || "",
    };
  }

  if (raw.event === "step_update" && raw.step_update) {
    const step = raw.step_update;
    const conversationId = step.conversation_id || raw.conversation_id || "";

    if (step.step_type === "agent_response") {
      if (typeof step.text_delta === "string" && step.text_delta.length > 0) {
        return {
          type: "text_delta",
          conversationId,
          stepIndex: step.step_index,
          delta: step.text_delta,
        };
      }
      if (step.state === "ACTIVE") {
        return { type: "thinking", conversationId, stepIndex: step.step_index };
      }
      return null;
    }

    if (step.step_type === "tool") {
      const toolName = step.tool_name || step.tool_info?.name || "tool";
      const parameters = step.tool_info?.parameters || {};
      if (step.state === "ACTIVE") {
        return { type: "tool_start", conversationId, stepIndex: step.step_index, tool: toolName, input: parameters };
      }
      if (step.state === "DONE") {
        const output = String(step.tool_info?.output || "");
        const hasError = Boolean(step.error) || /Command exited with code [1-9]|Operation not permitted|denied/i.test(output);
        return { type: "tool_done", conversationId, stepIndex: step.step_index, tool: toolName, ok: !hasError };
      }
    }
    return null;
  }

  if (raw.event === "result" && raw.result) {
    const res = raw.result;
    return {
      type: "result",
      conversationId: res.conversation_id || raw.conversation_id || "",
      status: res.status || "",
      response: typeof res.response === "string" ? res.response : "",
      error: res.error || "",
      durationSeconds: res.duration_seconds || 0,
      usage: res.usage || null,
    };
  }

  return null;
}

export function extractStructuredResult(text) {
  const source = String(text || "");
  const markerMatch = /<<<AGY_RESULT_JSON>>>\s*([\s\S]*?)\s*<<<END_AGY_RESULT_JSON>>>/.exec(source);
  if (!markerMatch) return null;

  let jsonCandidate = markerMatch[1].trim();
  const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(jsonCandidate);
  if (fenceMatch) jsonCandidate = fenceMatch[1].trim();

  try {
    const parsed = JSON.parse(jsonCandidate);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export async function checkAgyRunner(config) {
  const runner = resolveAgyRunner(config);
  if (runner.kind === "launcher") {
    try {
      const { stdout, stderr } = await execFileAsync(runner.command, ["--check"], {
        timeout: 30000,
        env: { ...process.env, ...(runner.binary ? { AGY_CLI: runner.binary } : {}) },
      });
      const detail = `${stdout || ""}\n${stderr || ""}`.trim().split("\n").filter(Boolean).slice(-2).join(" | ");
      return { ok: true, runner, detail: detail || "代理连通性检查通过" };
    } catch (err) {
      const detail = `${err.stdout || ""}\n${err.stderr || ""}`.trim() || err.message;
      return { ok: false, runner, detail };
    }
  }
  const res = spawnSync(runner.command, ["--help"], { encoding: "utf8", timeout: 15000 });
  return { ok: res.status === 0, runner, detail: res.status === 0 ? runner.command : (res.stderr || "").trim() };
}

function killTree(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already exited */
    }
  }
}

export function runAgy({
  config,
  cwd,
  task,
  conversationId = "",
  repoPaths = [],
  mode,
  model,
  effort,
  sandbox,
  dangerouslySkipPermissions,
  extraEnv,
  signal,
  onEvent,
  logger,
  spawnImpl = nodeSpawn,
}) {
  const runner = resolveAgyRunner(config);
  const timeoutMs = Number(config.agy?.timeoutMs) > 0 ? Number(config.agy.timeoutMs) : 0;
  const args = buildAgyArgs(config, {
    runnerKind: runner.kind,
    conversationId,
    repoPaths,
    mode,
    model,
    effort,
    sandbox,
    dangerouslySkipPermissions,
    timeoutMs,
  });

  const env = {
    ...process.env,
    ...(runner.binary ? { AGY_CLI: runner.binary } : {}),
    ...(config.agy?.env || {}),
    ...(extraEnv || {}),
  };

  const startedAt = Date.now();
  const result = {
    ok: false,
    command: runner.command,
    runnerKind: runner.kind,
    args,
    conversationId: conversationId || "",
    text: "",
    streamedText: "",
    structured: null,
    status: "",
    reason: null,
    exitCode: null,
    signal: null,
    timedOut: false,
    aborted: false,
    durationMs: 0,
    stderr: "",
    error: "",
    usage: null,
  };

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(runner.command, args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (err) {
      result.error = err?.message || String(err);
      result.durationMs = Date.now() - startedAt;
      resolve(result);
      return;
    }

    let stderrTail = "";
    let settled = false;
    let timer = null;

    const finish = (extra = {}) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener?.("abort", onAbort);
      result.durationMs = Date.now() - startedAt;
      result.stderr = stderrTail.slice(-8000);
      Object.assign(result, extra);
      resolve(result);
    };

    const onAbort = () => {
      result.aborted = true;
      killTree(child, "SIGTERM");
      setTimeout(() => killTree(child, "SIGKILL"), 4000).unref?.();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        result.timedOut = true;
        logger?.warn?.(`agy 执行超时（${timeoutMs}ms），终止进程组`);
        killTree(child, "SIGTERM");
        setTimeout(() => killTree(child, "SIGKILL"), 4000).unref?.();
      }, timeoutMs + 15000);
      timer.unref?.();
    }

    child.on("error", (err) => {
      result.error = err?.message || String(err);
      finish({ ok: false });
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-16000);
    });

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const raw = parseAgyEventLine(line);
      if (!raw) return;
      const event = normalizeAgyEvent(raw);
      if (!event) return;

      if (event.conversationId) result.conversationId = event.conversationId;
      if (event.type === "text_delta") result.streamedText += event.delta;
      if (event.type === "result") {
        result.status = event.status;
        if (event.response) result.text = event.response;
        if (event.error) result.error = event.error;
        if (event.usage) result.usage = event.usage;
      }

      try {
        onEvent?.(event, raw);
      } catch (err) {
        logger?.warn?.(`事件回调异常：${err?.message || err}`);
      }
    });

    child.on("close", (code, sig) => {
      rl.close();
      const elapsedMs = Date.now() - startedAt;
      result.exitCode = code;
      result.signal = sig;
      if (!result.text && result.streamedText) result.text = result.streamedText;
      result.structured = extractStructuredResult(result.text);

      // 当传入 --print-timeout 时，agy 内部超时截断可能以 exitCode=0 退出且不发送最终 result 事件（status=""）。
      // 此时严禁因存在半截 streamedText 误判为 succeeded，必须标记为 timeout。
      if (
        !result.timedOut &&
        !result.aborted &&
        timeoutMs > 0 &&
        !result.status &&
        !result.structured &&
        elapsedMs >= Math.max(4000, timeoutMs - 2500)
      ) {
        result.timedOut = true;
        result.error = result.error || `agy 执行达到超时上限（${Math.round(timeoutMs / 1000)}s）被中断`;
      }

      if (result.timedOut) {
        result.reason = { kind: "timeout" };
        if (!result.error) {
          result.error = `agy 执行达到超时上限（${Math.round(timeoutMs / 1000)}s）被中断`;
        }
      } else if (result.aborted) {
        result.reason = { kind: "aborted" };
      } else if (code === 0 && (result.status === "SUCCESS" || (!result.status && result.text.trim()))) {
        result.reason = { kind: "completed" };
      } else {
        const fallbackMsg =
          code === 0 && !result.status && !result.text.trim()
            ? "agy 未返回有效结果事件即提前退出（可能因沙盒限制、会话异常或超时中断）"
            : `agy 退出码 ${code}`;
        result.reason = {
          kind: "error",
          error: {
            code: result.status || `EXIT_${code ?? "NULL"}`,
            message: result.error || stderrTail.split("\n").filter(Boolean).slice(-2).join(" | ") || fallbackMsg,
          },
        };
      }

      result.ok = code === 0 && result.reason?.kind === "completed" && Boolean(result.text.trim());
      finish();
    });

    const payload = `${JSON.stringify({ event: "user", message: { content: String(task ?? "") } })}\n`;
    child.stdin.on("error", () => {});
    child.stdin.end(payload);
  });
}
