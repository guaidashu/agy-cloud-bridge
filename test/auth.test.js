import assert from "node:assert/strict";
import test from "node:test";
import { createAuthHeaders, createAuthVerifier } from "../src/auth.js";
import { createRedactor } from "../src/redact.js";

const SECRET = "test-bridge-secret-0123456789abcdef0123456789abcdef";

test("Auth verifier accepts valid HMAC request and rejects tampered/replayed/expired requests", () => {
  let fakeNow = 1_700_000_000;
  const verify = createAuthVerifier({
    getSecret: () => SECRET,
    replayWindowSec: 300,
    nowFn: () => fakeNow,
  });

  const body = JSON.stringify({ projectId: "demo", task: "hello" });
  const headers = createAuthHeaders({
    secret: SECRET,
    method: "POST",
    pathWithQuery: "/api/v1/handoffs",
    rawBody: body,
    timestamp: String(fakeNow),
    nonce: "nonce-12345678",
  });

  const okRes = verify({
    method: "POST",
    pathWithQuery: "/api/v1/handoffs",
    headers,
    rawBody: body,
  });
  assert.equal(okRes.ok, true);

  // 1. Replay same nonce must fail
  const replayRes = verify({
    method: "POST",
    pathWithQuery: "/api/v1/handoffs",
    headers,
    rawBody: body,
  });
  assert.equal(replayRes.ok, false);
  assert.equal(replayRes.code, "AUTH_REPLAY_NONCE");

  // 2. Tampered body must fail
  const hdr2 = createAuthHeaders({
    secret: SECRET,
    method: "POST",
    pathWithQuery: "/api/v1/handoffs",
    rawBody: body,
    timestamp: String(fakeNow),
    nonce: "nonce-22345678",
  });
  const tamperRes = verify({
    method: "POST",
    pathWithQuery: "/api/v1/handoffs",
    headers: hdr2,
    rawBody: JSON.stringify({ projectId: "demo", task: "evil" }),
  });
  assert.equal(tamperRes.ok, false);
  assert.equal(tamperRes.code, "AUTH_BAD_SIGNATURE");

  // 3. Wrong path must fail
  const wrongPath = verify({
    method: "POST",
    pathWithQuery: "/api/v1/handoffs/x/ack",
    headers: hdr2,
    rawBody: body,
  });
  assert.equal(wrongPath.ok, false);
  assert.equal(wrongPath.code, "AUTH_BAD_SIGNATURE");

  // 4. Expired timestamp must fail
  const oldTs = String(fakeNow - 600);
  const expiredHdr = createAuthHeaders({
    secret: SECRET,
    method: "GET",
    pathWithQuery: "/api/v1/handoffs",
    rawBody: "",
    timestamp: oldTs,
    nonce: "nonce-32345678",
  });
  const expiredRes = verify({
    method: "GET",
    pathWithQuery: "/api/v1/handoffs",
    headers: expiredHdr,
    rawBody: "",
  });
  assert.equal(expiredRes.ok, false);
  assert.equal(expiredRes.code, "AUTH_TIMESTAMP_EXPIRED");

  // 5. Missing headers fail cleanly
  const missing = verify({ method: "GET", pathWithQuery: "/api/v1/handoffs", headers: {}, rawBody: "" });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "AUTH_MISSING_HEADERS");
});

test("Auth verifier supports per-project scoped tokens and redactor masks proj_ tokens", () => {
  const projToken = "proj_0123456789abcdef0123456789abcdef0123456789abcdef";
  const verify = createAuthVerifier({
    getSecret: () => SECRET,
    getProjects: () => [{ id: "novel", name: "Novel", token: projToken }],
    replayWindowSec: 300,
    nowFn: () => 1_700_000_000,
  });

  const body = JSON.stringify({ task: "sync" });
  const headers = createAuthHeaders({
    secret: projToken,
    projectId: "novel",
    method: "POST",
    pathWithQuery: "/api/v1/handoffs",
    rawBody: body,
    timestamp: "1700000000",
    nonce: "nonce-proj-1234",
  });

  const res = verify({ method: "POST", pathWithQuery: "/api/v1/handoffs", headers, rawBody: body });
  assert.equal(res.ok, true);
  assert.equal(res.scope, "project");
  assert.equal(res.scopedProjectId, "novel");

  // Missing x-bridge-project with projToken must fail (cannot bypass global secret)
  const noHeader = { ...headers };
  delete noHeader["x-bridge-project"];
  noHeader["x-bridge-nonce"] = "nonce-proj-5678";
  const failRes = verify({ method: "POST", pathWithQuery: "/api/v1/handoffs", headers: noHeader, rawBody: body });
  assert.equal(failRes.ok, false);

  const redact = createRedactor({ config: { projects: [{ id: "novel", token: projToken }] } });
  const masked = redact(`leaked ${projToken} here`).text;
  assert.ok(!masked.includes(projToken));
  assert.ok(masked.includes("«已脱敏»"));
});
