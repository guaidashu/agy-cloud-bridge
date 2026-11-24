import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** 展开 `~` 与相对路径，统一成绝对路径。 */
export function expandPath(input, base = process.cwd()) {
  if (!input) return "";
  let value = String(input).trim();
  if (value === "~") value = os.homedir();
  else if (value.startsWith("~/")) value = path.join(os.homedir(), value.slice(2));
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(base, value);
}

export async function ensureDir(dir, mode) {
  await fsp.mkdir(dir, { recursive: true, ...(mode ? { mode } : {}) });
  return dir;
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") return fallback;
    throw new Error(`读取 JSON 失败：${file}：${err.message}`);
  }
}

export async function writeFileAtomic(file, content, mode) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  await fsp.writeFile(tmp, content, { encoding: "utf8", ...(mode ? { mode } : {}) });
  if (mode) {
    await fsp.chmod(tmp, mode).catch(() => {});
  }
  await fsp.rename(tmp, file);
}

export async function writeJsonAtomic(file, value, mode) {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export function readTextIfExists(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const seconds = Math.round(ms / 100) / 10;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.round(seconds % 60)}s`;
}

export function errorSummary(err) {
  const message = err?.message ? String(err.message) : String(err ?? "未知错误");
  return message.replace(/\s+/g, " ").slice(0, 400);
}

export function shortId(prefix = "") {
  const raw = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return prefix ? `${prefix}-${raw}` : raw;
}

/**
 * 归一化 Git 远端 URL（支持 SSH / HTTPS / git:// 与 owner/repo 简写）
 * 例：`git@github.com:owner/my-private-repo.git` → `github.com/owner/my-private-repo`
 */
export function normalizeGitRemote(rawUrl) {
  let s = String(rawUrl || "").trim();
  if (!s) return "";
  s = s.replace(/\.git$/i, "").replace(/\/+$/, "");

  // scp 风格：git@github.com:owner/repo
  const scpMatch = /^[^@\s]+@([^:\s]+):(.+)$/.exec(s);
  if (scpMatch && !/^[a-z]+:\/\//i.test(s)) {
    const host = scpMatch[1].toLowerCase();
    const repoPath = scpMatch[2].replace(/^\/+/, "").toLowerCase();
    return `${host}/${repoPath}`;
  }

  // URL 风格：https://user@github.com:443/owner/repo 或 ssh://git@host:22/owner/repo
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      const parsed = new URL(s);
      const host = parsed.hostname.toLowerCase();
      const repoPath = parsed.pathname.replace(/^\/+/, "").toLowerCase();
      return host && repoPath ? `${host}/${repoPath}` : "";
    } catch {
      return s.toLowerCase();
    }
  }

  return s.replace(/^\/+/, "").toLowerCase();
}

export function matchesGlob(value, pattern) {
  const rawVal = String(value ?? "");
  const rawPat = String(pattern ?? "").trim();
  if (!rawPat) return false;
  const regexSrc = rawPat
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${regexSrc}$`).test(rawVal);
}

export class Semaphore {
  constructor(limit = 2) {
    this.limit = Math.max(1, Number(limit) || 1);
    this.active = 0;
    this.waiters = [];
  }

  async acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    await new Promise((resolve) => this.waiters.push(resolve));
    this.active += 1;
    return () => this.release();
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) next();
  }
}
