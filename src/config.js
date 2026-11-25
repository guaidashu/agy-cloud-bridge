import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG } from "./defaults.js";
import {
  ensureDir,
  expandPath,
  matchesGlob,
  normalizeGitRemote,
  readJson,
  writeFileAtomic,
  writeJsonAtomic,
} from "./util.js";

export const CONFIG_FILENAME = "config.json";
export const SECRET_FILENAME = "secret.env";
export const DEFAULT_LOCAL_MARKER = ".agy-local";

export function normalizeLocalMarkerFile(value) {
  const raw = String(value ?? "").trim().replace(/\\/g, "/");
  if (!raw) return DEFAULT_LOCAL_MARKER;
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || raw.startsWith("~")) {
    throw new Error('localMarkerFile 不合法：不能包含 ".." 或绝对路径');
  }
  let cleaned = raw.replace(/^(\.\/)+/, "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!cleaned || cleaned === ".") return DEFAULT_LOCAL_MARKER;
  const segments = cleaned.split("/").filter(Boolean);
  if (segments.includes("..")) {
    throw new Error('localMarkerFile 不合法：不能包含 ".." 或绝对路径');
  }
  return segments.join("/");
}

export function resolveHome(explicit) {
  return expandPath(explicit || process.env.AGY_BRIDGE_HOME || "~/.agy-bridge");
}

export function configPath(home) {
  return path.join(home, CONFIG_FILENAME);
}

export function secretPath(home) {
  return path.join(home, SECRET_FILENAME);
}

function mergeSection(defaults, value) {
  if (value === undefined || value === null) return structuredClone(defaults);
  if (Array.isArray(defaults)) return Array.isArray(value) ? value : structuredClone(defaults);
  if (typeof defaults !== "object") return value;
  const merged = structuredClone(defaults);
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    merged[key] = key in merged ? mergeSection(merged[key], item) : item;
  }
  return merged;
}

export function generateProjectToken() {
  return `proj_${crypto.randomBytes(24).toString("hex")}`;
}

export function normalizeProject(project = {}) {
  return {
    id: String(project.id || "").trim(),
    name: String(project.name || project.id || "").trim(),
    group: slugify(project.group || ""),
    repoPath: project.repoPath ? expandPath(project.repoPath) : "",
    remoteMatch: String(project.remoteMatch || "").trim(),
    token: String(project.token || "").trim(),
    allowedBranches:
      Array.isArray(project.allowedBranches) && project.allowedBranches.length > 0
        ? project.allowedBranches.map(String).filter(Boolean)
        : ["main", "feat/*", "collab/*"],
    defaultChannel: project.defaultChannel === "git-ref" ? "git-ref" : "http",
    dirtyPolicy: project.dirtyPolicy === "worktree" ? "worktree" : "safe-block",
    allowGitPush: project.allowGitPush !== false,
    sandbox: typeof project.sandbox === "boolean" ? project.sandbox : null,
    maxRounds: Math.max(1, Number(project.maxRounds) || 5),
    fastPaths: Array.isArray(project.fastPaths) ? project.fastPaths.map(String).filter(Boolean) : [],
    localMarkerFile: normalizeLocalMarkerFile(project.localMarkerFile),
    localContext: String(project.localContext || ""),
    extraReadRoots: Array.isArray(project.extraReadRoots) ? project.extraReadRoots.map(String).filter(Boolean) : [],
    gitEnv: project.gitEnv && typeof project.gitEnv === "object" ? project.gitEnv : {},
  };
}

export function normalizeConfig(raw = {}) {
  const merged = mergeSection(DEFAULT_CONFIG, raw);
  merged.projects = Array.isArray(merged.projects) ? merged.projects.map(normalizeProject) : [];
  return merged;
}

export function parseSecretEnv(content, varName = "AGY_BRIDGE_SECRET") {
  for (const line of String(content || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Z0-9_]+)\s*=\s*["']?([^"'\s#]+)["']?/.exec(trimmed);
    if (match && match[1] === varName) {
      return match[2];
    }
  }
  return "";
}

export function loadSecret({ home, config } = {}) {
  const dir = resolveHome(home || config?.runtime?.home);
  const envName = config?.server?.secretEnv || "AGY_BRIDGE_SECRET";
  if (process.env[envName] && process.env[envName].trim()) {
    return process.env[envName].trim();
  }
  try {
    const raw = fs.readFileSync(secretPath(dir), "utf8");
    return parseSecretEnv(raw, envName);
  } catch {
    return "";
  }
}

export async function initBridge({ home, force = false } = {}) {
  const dir = resolveHome(home);
  await ensureDir(dir, 0o700);
  await ensureDir(path.join(dir, "logs"));
  await ensureDir(path.join(dir, "runs"));
  await ensureDir(path.join(dir, "workspaces"));
  await ensureDir(path.join(dir, "worktrees"));

  const secFile = secretPath(dir);
  let secretCreated = false;
  if (force || !fs.existsSync(secFile)) {
    const generated = crypto.randomBytes(32).toString("hex");
    await writeFileAtomic(secFile, `AGY_BRIDGE_SECRET=${generated}\n`, 0o600);
    secretCreated = true;
  } else {
    await fs.promises.chmod(secFile, 0o600).catch(() => {});
  }

  const cfgFile = configPath(dir);
  let configCreated = false;
  let config;
  if (!force) {
    const existing = await readJson(cfgFile, null).catch(() => null);
    if (existing) {
      config = normalizeConfig(existing);
    }
  }
  if (!config) {
    config = normalizeConfig({
      ...structuredClone(DEFAULT_CONFIG),
      runtime: { ...DEFAULT_CONFIG.runtime, home: dir },
    });
    await writeJsonAtomic(cfgFile, config, 0o600);
    configCreated = true;
  } else {
    await fs.promises.chmod(cfgFile, 0o600).catch(() => {});
  }

  return { home: dir, configFile: cfgFile, secretFile: secFile, configCreated, secretCreated, config };
}

export async function loadConfig({ home } = {}) {
  const dir = resolveHome(home);
  const file = configPath(dir);
  const raw = await readJson(file, null);
  if (!raw) {
    const err = new Error(`配置文件不存在：${file}\n请先执行：node src/cli.js init`);
    err.code = "CONFIG_MISSING";
    throw err;
  }
  const config = normalizeConfig(raw);
  config.runtime.home = dir;
  return { home: dir, file, config };
}

export async function saveConfig(config, home) {
  const dir = resolveHome(home || config.runtime?.home);
  await writeJsonAtomic(configPath(dir), normalizeConfig(config), 0o600);
}

export function slugify(input) {
  return String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function isBranchAllowed(branch, allowedBranches = ["main"]) {
  const b = String(branch || "").trim();
  if (!b) return false;
  return allowedBranches.some((pat) => matchesGlob(b, pat));
}

export function findProject(config, { projectId, repoUrl } = {}) {
  const list = Array.isArray(config?.projects) ? config.projects : [];
  if (projectId) {
    const needle = String(projectId).trim().toLowerCase();
    const byId = list.find((p) => p.id.toLowerCase() === needle || p.name.toLowerCase() === needle);
    if (byId) return byId;
  }
  if (repoUrl) {
    const normTarget = normalizeGitRemote(repoUrl);
    if (normTarget) {
      const byRemote = list.find((p) => {
        if (!p.remoteMatch) return false;
        const normPat = normalizeGitRemote(p.remoteMatch);
        if (!normPat) return false;
        return normTarget === normPat || normTarget.endsWith(`/${normPat}`) || normPat.endsWith(`/${normTarget}`);
      });
      if (byRemote) return byRemote;
    }
  }
  return null;
}

export function findGroupPeers(config, primaryProject) {
  const g = String(primaryProject?.group || "").trim();
  if (!g) return [];
  return (Array.isArray(config?.projects) ? config.projects : []).filter(
    (p) => p.id !== primaryProject.id && String(p.group || "").trim() === g,
  );
}

export function canAccessPeerProject(scopedProject, targetProject) {
  if (!scopedProject || !targetProject) return false;
  if (scopedProject.id === targetProject.id) return true;
  const g = String(scopedProject.group || "").trim();
  return Boolean(g) && g === String(targetProject.group || "").trim();
}

export function addProject(config, input) {
  const id = slugify(input.id || path.basename(input.repoPath || ""));
  if (!id) throw new Error("项目 id 不能为空");
  if (config.projects.some((p) => p.id.toLowerCase() === id)) {
    throw new Error(`项目已存在：${id}`);
  }
  const repoPath = expandPath(input.repoPath || "");
  if (!repoPath || !path.isAbsolute(repoPath)) {
    throw new Error("repoPath 必须是有效的本地绝对路径");
  }
  const project = normalizeProject({
    ...input,
    id,
    name: input.name || id,
    repoPath,
    token: input.token || generateProjectToken(),
  });
  config.projects.push(project);
  return project;
}

export function rotateProjectToken(config, id) {
  const project = findProject(config, { projectId: id });
  if (!project) throw new Error(`项目不存在：${id}`);
  project.token = generateProjectToken();
  return project;
}

export function removeProject(config, id) {
  const needle = String(id || "").trim().toLowerCase();
  const idx = config.projects.findIndex((p) => p.id.toLowerCase() === needle);
  if (idx === -1) throw new Error(`项目不存在：${id}`);
  const [removed] = config.projects.splice(idx, 1);
  return removed;
}

const VALID_EFFORTS = new Set(["", "low", "medium", "high", "xhigh", "max"]);
const VALID_MODES = new Set(["", "plan", "accept-edits", "auto"]);

export function validateConfig(config) {
  const errors = [];
  const warnings = [];
  if (!config?.server?.port || Number(config.server.port) <= 0 || Number(config.server.port) > 65535) {
    errors.push(`server.port 不合法：${config?.server?.port}`);
  }
  if (config?.agy?.requireProxy === true && !config?.agy?.launcher) {
    errors.push("已开启 agy.requireProxy=true 但未配置 agy.launcher（必须提供出口代理启动器脚本路径）");
  }
  if (!VALID_EFFORTS.has(config?.agy?.effort || "")) {
    errors.push(`agy.effort 不合法：${config?.agy?.effort}`);
  }
  if (!VALID_MODES.has(config?.agy?.mode || "")) {
    errors.push(`agy.mode 不合法：${config?.agy?.mode}`);
  }
  const ids = new Set();
  for (const p of config.projects || []) {
    if (!p.id) errors.push("存在缺少 id 的项目");
    if (ids.has(p.id)) errors.push(`项目 id 重复：${p.id}`);
    ids.add(p.id);
    if (!path.isAbsolute(p.repoPath || "")) {
      errors.push(`项目 ${p.id} 的 repoPath 必须是绝对路径`);
    }
    if (!["safe-block", "worktree"].includes(p.dirtyPolicy)) {
      errors.push(`项目 ${p.id} 的 dirtyPolicy 只能是 safe-block 或 worktree`);
    }
  }
  return { errors, warnings };
}
