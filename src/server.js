import http from "node:http";
import { createAuthVerifier } from "./auth.js";
import { canAccessPeerProject, findProject } from "./config.js";

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

async function readBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const err = new Error("请求体过大");
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createBridgeServer({ orchestrator, getSecret, replayWindowSec = 300, logger }) {
  const startedAt = Date.now();
  const verifyAuth = createAuthVerifier({
    getSecret,
    getProjects: () => orchestrator.config?.projects || [],
    replayWindowSec,
  });

  function assertScopeForRecord(auth, rec) {
    if (auth.scope === "project" && rec && rec.projectId !== auth.scopedProjectId) {
      return false;
    }
    return true;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method || "GET";
      const urlObj = new URL(req.url || "/", "http://127.0.0.1");
      const pathname = urlObj.pathname;
      const pathWithQuery = `${pathname}${urlObj.search}`;

      // 非敏感健康检查（无需鉴权，方便本地/FRP/反代探活）
      if (method === "GET" && pathname === "/api/v1/health") {
        sendJson(res, 200, {
          ok: true,
          service: "agy-cloud-bridge",
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          time: new Date().toISOString(),
        });
        return;
      }

      const rawBody = method === "POST" || method === "PUT" || method === "PATCH" ? await readBody(req) : "";

      await orchestrator.refreshConfigIfChanged?.();

      const auth = verifyAuth({
        method,
        pathWithQuery,
        headers: req.headers,
        rawBody,
      });
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.message, code: auth.code });
        return;
      }

      if (method === "POST" && pathname === "/api/v1/handoffs") {
        let payload = {};
        if (rawBody.trim()) {
          try {
            payload = JSON.parse(rawBody);
          } catch {
            sendJson(res, 400, { error: "JSON 请求体格式错误", code: "BAD_JSON" });
            return;
          }
        }
        if (auth.scope === "project") {
          const reqProj = String(payload.projectId || payload.project || "").trim();
          const reqRepo = String(payload.repoUrl || payload.remoteUrl || "").trim();
          const scopedProj = findProject(orchestrator.config, { projectId: auth.scopedProjectId });
          if (reqProj) {
            const matchedByName = findProject(orchestrator.config, { projectId: reqProj });
            if (!matchedByName || matchedByName.id !== auth.scopedProjectId) {
              sendJson(res, 403, { error: "项目级密钥无权派发其他项目", code: "FORBIDDEN_PROJECT_SCOPE" });
              return;
            }
          }
          if (reqRepo) {
            const matchedByRepo = findProject(orchestrator.config, { repoUrl: reqRepo });
            if (matchedByRepo && matchedByRepo.id !== auth.scopedProjectId) {
              sendJson(res, 403, { error: "项目级密钥无权操作其他项目仓库", code: "FORBIDDEN_PROJECT_SCOPE" });
              return;
            }
            if (!matchedByRepo && scopedProj?.remoteMatch) {
              sendJson(res, 403, { error: "仓库 URL 与当前项目密钥作用域不匹配", code: "FORBIDDEN_PROJECT_SCOPE" });
              return;
            }
          }
          if (Array.isArray(payload.targets)) {
            for (const t of payload.targets) {
              if (!t || typeof t !== "object") continue;
              const targetProj = findProject(orchestrator.config, {
                projectId: t.projectId || t.project,
                repoUrl: t.repoUrl || t.remoteUrl,
              });
              if (!targetProj || !canAccessPeerProject(scopedProj, targetProj)) {
                sendJson(res, 403, { error: "项目级密钥无权协同非同组项目仓库", code: "FORBIDDEN_PROJECT_SCOPE" });
                return;
              }
            }
          }
          payload.projectId = auth.scopedProjectId;
        }
        const { replay, record } = await orchestrator.dispatchHandoff(payload);
        sendJson(res, replay ? 200 : 202, { replay, handoff: record });
        return;
      }

      if (method === "GET" && pathname === "/api/v1/handoffs") {
        const limit = Number(urlObj.searchParams.get("limit") || 30);
        const scopeFilter = auth.scope === "project" ? auth.scopedProjectId : "";
        sendJson(res, 200, { handoffs: orchestrator.listHandoffs(limit, scopeFilter) });
        return;
      }

      if (pathname.startsWith("/api/v1/handoffs/")) {
        const parts = pathname.slice("/api/v1/handoffs/".length).split("/").filter(Boolean);
        const handoffId = parts[0] ? decodeURIComponent(parts[0]) : "";
        if (!handoffId) {
          sendJson(res, 404, { error: "Handoff not found" });
          return;
        }

        if (method === "GET" && parts.length === 1) {
          const rec = orchestrator.getHandoff(handoffId);
          if (!rec) {
            sendJson(res, 404, { error: "Handoff not found", code: "NOT_FOUND" });
            return;
          }
          if (!assertScopeForRecord(auth, rec)) {
            sendJson(res, 403, { error: "无权访问其他项目的协同任务", code: "FORBIDDEN_PROJECT_SCOPE" });
            return;
          }
          sendJson(res, 200, { handoff: rec });
          return;
        }

        if (method === "GET" && parts.length === 2 && parts[1] === "wait") {
          const pre = orchestrator.getHandoff(handoffId);
          if (!pre) {
            sendJson(res, 404, { error: "Handoff not found", code: "NOT_FOUND" });
            return;
          }
          if (!assertScopeForRecord(auth, pre)) {
            sendJson(res, 403, { error: "无权等待其他项目的协同任务", code: "FORBIDDEN_PROJECT_SCOPE" });
            return;
          }
          const timeoutSec = Number(urlObj.searchParams.get("timeout") || 60);
          const rec = await orchestrator.waitForHandoff(handoffId, timeoutSec);
          sendJson(res, 200, { handoff: rec });
          return;
        }

        if (method === "POST" && parts.length === 2 && parts[1] === "ack") {
          const pre = orchestrator.getHandoff(handoffId);
          if (!pre) {
            sendJson(res, 404, { error: "Handoff not found", code: "NOT_FOUND" });
            return;
          }
          if (!assertScopeForRecord(auth, pre)) {
            sendJson(res, 403, { error: "无权清理其他项目的协同任务", code: "FORBIDDEN_PROJECT_SCOPE" });
            return;
          }
          const acked = await orchestrator.ackHandoff(handoffId);
          sendJson(res, 200, { ok: true, handoff: acked.record, purgeSummary: acked.purgeSummary });
          return;
        }

        if (method === "POST" && parts.length === 2 && parts[1] === "cancel") {
          const pre = orchestrator.getHandoff(handoffId);
          if (!pre) {
            sendJson(res, 404, { error: "Handoff not found", code: "NOT_FOUND" });
            return;
          }
          if (!assertScopeForRecord(auth, pre)) {
            sendJson(res, 403, { error: "无权取消其他项目的协同任务", code: "FORBIDDEN_PROJECT_SCOPE" });
            return;
          }
          const cancelled = await orchestrator.cancelHandoff(handoffId);
          sendJson(res, 200, { ok: true, ...cancelled });
          return;
        }
      }

      sendJson(res, 404, { error: "Not Found", code: "NOT_FOUND" });
    } catch (err) {
      const code = Number(err?.statusCode) || 500;
      logger?.warn?.(`HTTP 处理异常（${code}）：${err?.message || err}`);
      sendJson(res, code, { error: err?.message || "Internal Server Error", code: err?.code || "INTERNAL_ERROR" });
    }
  });

  return server;
}
