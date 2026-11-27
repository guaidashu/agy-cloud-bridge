import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildAgyArgs, extractStructuredResult, resolveAgyRunner, runAgy } from "../src/agy-runner.js";

test("resolveAgyRunner refuses direct agy fallback when requireProxy=true and launcher missing", () => {
  assert.throws(
    () => resolveAgyRunner({ agy: { requireProxy: true, launcher: "" } }),
    /requireProxy=true/,
  );
  assert.throws(
    () => resolveAgyRunner({ agy: { requireProxy: true, launcher: "/nonexistent/agy-proxy-launcher.sh" } }),
    /不存在/,
  );
});

test("resolveAgyRunner supports direct binary mode when requireProxy=false", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-direct-test-"));
  t.after(async () => fsp.rm(tmpDir, { recursive: true, force: true }));
  const fakeBin = path.join(tmpDir, "agy");
  await fsp.writeFile(fakeBin, "#!/usr/bin/env bash\necho ok\n", { mode: 0o755 });
  const runner = resolveAgyRunner({ agy: { requireProxy: false, launcher: "", binary: fakeBin } });
  assert.equal(runner.kind, "direct");
  assert.equal(runner.command, fakeBin);
});

test("buildAgyArgs omits --sandbox by default and includes it only when enabled", () => {
  const defaultArgs = buildAgyArgs(
    { agy: { dangerouslySkipPermissions: true, timeoutMs: 60000 } },
    { runnerKind: "launcher", conversationId: "conv-abc", repoPaths: ["/repo/a", "/tmp/scratch"] },
  );
  assert.equal(defaultArgs[0], "--");
  assert.equal(defaultArgs.includes("--sandbox"), false);
  assert.equal(defaultArgs.includes("--sandbox=false"), true);
  assert.ok(defaultArgs.includes("--conversation"));
  assert.ok(defaultArgs.includes("--dangerously-skip-permissions"));

  const sandboxedArgs = buildAgyArgs(
    { agy: { sandbox: true, dangerouslySkipPermissions: true, timeoutMs: 60000 } },
    { runnerKind: "launcher", conversationId: "conv-abc", repoPaths: ["/repo/a"] },
  );
  assert.ok(sandboxedArgs.includes("--sandbox"));

  const projectOverrideOff = buildAgyArgs(
    { agy: { sandbox: true } },
    { runnerKind: "direct", sandbox: false },
  );
  assert.equal(projectOverrideOff.includes("--sandbox"), false);
  assert.equal(projectOverrideOff.includes("--sandbox=false"), true);
});

test("runAgy marks print-timeout exitCode=0 without result event as timedOut instead of false succeeded", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-timeout-test-"));
  t.after(async () => fsp.rm(tmpDir, { recursive: true, force: true }));

  const mockBin = path.join(tmpDir, "mock-agy-cutoff.sh");
  await fsp.writeFile(
    mockBin,
    `#!/usr/bin/env bash
read -r line
echo '{"event":"init","conversation_id":"conv-cutoff"}'
echo '{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"正在后台执行构建，等待完成..."}}'
sleep 1.7
exit 0
`,
    { mode: 0o755 },
  );
  fs.chmodSync(mockBin, 0o755);

  const res = await runAgy({
    config: {
      agy: {
        requireProxy: false,
        binary: mockBin,
        sandbox: false,
        timeoutMs: 4000,
      },
    },
    cwd: tmpDir,
    task: "preview build",
  });
  // Duration 1.7s < 4s => not near 4s timeout? Let's also test near-timeout cutoff:
  assert.equal(res.conversationId, "conv-cutoff");

  const mockCutoff = path.join(tmpDir, "mock-agy-print-timeout.sh");
  await fsp.writeFile(
    mockCutoff,
    `#!/usr/bin/env bash
read -r line
echo '{"event":"init","conversation_id":"conv-pt"}'
echo '{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"正在后台执行构建，等待完成..."}}'
sleep 4.1
exit 0
`,
    { mode: 0o755 },
  );
  fs.chmodSync(mockCutoff, 0o755);

  const cutoffRes = await runAgy({
    config: {
      agy: {
        requireProxy: false,
        binary: mockCutoff,
        sandbox: false,
        timeoutMs: 6000,
      },
    },
    cwd: tmpDir,
    task: "preview build slow",
  });
  assert.equal(cutoffRes.ok, false);
  assert.equal(cutoffRes.timedOut, true);
  assert.equal(cutoffRes.reason?.kind, "timeout");
});

test("extractStructuredResult parses JSON between AGY_RESULT_JSON markers", () => {
  const sample = `一切正常！\n\n<<<AGY_RESULT_JSON>>>\n\`\`\`json\n{"status":"ok","summary":"已重启并验证","testsPassed":true}\n\`\`\`\n<<<END_AGY_RESULT_JSON>>>`;
  const parsed = extractStructuredResult(sample);
  assert.equal(parsed?.status, "ok");
  assert.equal(parsed?.testsPassed, true);
});

test("runAgy executes through mock proxy launcher and parses stream-json events", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-runner-test-"));
  t.after(async () => fsp.rm(tmpDir, { recursive: true, force: true }));

  const mockLauncher = path.join(tmpDir, "mock-launcher.sh");
  await fsp.writeFile(
    mockLauncher,
    `#!/usr/bin/env bash
set -euo pipefail
# Verify -- separator was passed by runner
if [[ "\${1:-}" != "--" ]]; then
  echo "missing -- separator" >&2
  exit 2
fi
read -r line
echo "代理 HTTPS 连通性检查通过"
echo '{"event":"init","conversation_id":"conv-999"}'
echo '{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"已检查。"}}'
echo '{"event":"result","result":{"conversation_id":"conv-999","status":"SUCCESS","response":"已检查。\\n<<<AGY_RESULT_JSON>>>\\n{\\"status\\":\\"ok\\",\\"summary\\":\\"本地验证通过\\"} \\n<<<END_AGY_RESULT_JSON>>>"}}'
`,
    { mode: 0o755 },
  );
  fs.chmodSync(mockLauncher, 0o755);

  const res = await runAgy({
    config: {
      agy: {
        requireProxy: true,
        launcher: mockLauncher,
        sandbox: true,
        dangerouslySkipPermissions: true,
        timeoutMs: 30000,
      },
    },
    cwd: tmpDir,
    task: "check server",
  });

  assert.equal(res.ok, true);
  assert.equal(res.conversationId, "conv-999");
  assert.equal(res.structured?.status, "ok");
  assert.equal(res.structured?.summary, "本地验证通过");
});
