import crypto from "node:crypto";

export function sha256Hex(input) {
  return crypto.createHash("sha256").update(input ?? "").digest("hex");
}

export function canonicalString({ method, pathWithQuery, timestamp, nonce, rawBody = "" }) {
  return `${String(method || "GET").toUpperCase()}\n${String(pathWithQuery || "/")}\n${String(timestamp || "")}\n${String(nonce || "")}\n${sha256Hex(rawBody)}`;
}

export function signCanonical(secret, canonical) {
  const mac = crypto.createHmac("sha256", String(secret || "")).update(canonical, "utf8").digest("hex");
  return `sha256=${mac}`;
}

export function createAuthHeaders({ secret, projectId = "", method, pathWithQuery, rawBody = "", timestamp, nonce }) {
  const ts = String(timestamp ?? Math.floor(Date.now() / 1000));
  const nc = String(nonce ?? crypto.randomBytes(12).toString("hex"));
  const canonical = canonicalString({ method, pathWithQuery, timestamp: ts, nonce: nc, rawBody });
  const headers = {
    "x-bridge-timestamp": ts,
    "x-bridge-nonce": nc,
    "x-bridge-signature": signCanonical(secret, canonical),
  };
  if (projectId) {
    headers["x-bridge-project"] = String(projectId);
  }
  return headers;
}

function timingSafeSignatureMatch(sig, expected) {
  const sigBuf = Buffer.from(sig, "utf8");
  const expBuf = Buffer.from(expected, "utf8");
  return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
}

export function createAuthVerifier({
  getSecret,
  getProjects,
  replayWindowSec = 300,
  nowFn = () => Math.floor(Date.now() / 1000),
} = {}) {
  const seenNonces = new Map();

  function pruneExpired(now) {
    for (const [k, exp] of seenNonces.entries()) {
      if (exp <= now) seenNonces.delete(k);
    }
  }

  return function verifyRequest({ method, pathWithQuery, headers = {}, rawBody = "" }) {
    const globalSecret = typeof getSecret === "function" ? getSecret() : "";
    const projects = typeof getProjects === "function" ? getProjects() || [] : [];
    const headerProjectId = String(headers["x-bridge-project"] ?? "").trim();

    let scopedProject = null;
    if (headerProjectId) {
      const needle = headerProjectId.toLowerCase();
      scopedProject =
        projects.find((p) => p?.id?.toLowerCase() === needle || p?.name?.toLowerCase() === needle) || null;
    }

    if (!globalSecret && !(scopedProject && scopedProject.token)) {
      return { ok: false, status: 500, code: "SECRET_UNCONFIGURED", message: "服务端未配置鉴权密钥" };
    }

    const tsRaw = String(headers["x-bridge-timestamp"] ?? "").trim();
    const nonce = String(headers["x-bridge-nonce"] ?? "").trim();
    const sig = String(headers["x-bridge-signature"] ?? "").trim();

    if (!tsRaw || !nonce || !sig) {
      return { ok: false, status: 401, code: "AUTH_MISSING_HEADERS", message: "缺少鉴权请求头" };
    }

    if (!/^\d{9,12}$/.test(tsRaw)) {
      return { ok: false, status: 401, code: "AUTH_BAD_TIMESTAMP", message: "时间戳格式非法" };
    }
    if (nonce.length < 8 || nonce.length > 128) {
      return { ok: false, status: 401, code: "AUTH_BAD_NONCE", message: "Nonce 长度不合法" };
    }

    const ts = Number(tsRaw);
    const now = nowFn();
    if (Math.abs(now - ts) > replayWindowSec) {
      return { ok: false, status: 401, code: "AUTH_TIMESTAMP_EXPIRED", message: "请求时间戳超出有效期" };
    }

    if (seenNonces.size > 1000) {
      pruneExpired(now);
    }
    const existingExp = seenNonces.get(nonce);
    if (existingExp && existingExp > now) {
      return { ok: false, status: 401, code: "AUTH_REPLAY_NONCE", message: "检测到重放 Nonce" };
    }

    const canonical = canonicalString({ method, pathWithQuery, timestamp: tsRaw, nonce, rawBody });

    let matchedScope = null;
    if (scopedProject && scopedProject.token) {
      const projExpected = signCanonical(scopedProject.token, canonical);
      if (timingSafeSignatureMatch(sig, projExpected)) {
        matchedScope = { scope: "project", scopedProjectId: scopedProject.id };
      }
    }

    if (!matchedScope && globalSecret) {
      const globalExpected = signCanonical(globalSecret, canonical);
      if (timingSafeSignatureMatch(sig, globalExpected)) {
        matchedScope = { scope: "global", scopedProjectId: null };
      }
    }

    if (!matchedScope) {
      return { ok: false, status: 401, code: "AUTH_BAD_SIGNATURE", message: "HMAC 签名校验失败" };
    }

    seenNonces.set(nonce, now + replayWindowSec);
    return { ok: true, ...matchedScope };
  };
}
