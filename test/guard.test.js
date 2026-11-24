import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { evaluateToolCall } from "../bridge/agy-bridge-guard.mjs";

const REPO = "/tmp/fake-repo";
const SCRATCH = "/tmp/fake-run/scratch";

const BASE_ENV = {
  AGY_BRIDGE_GUARD_WRITE_ROOTS: JSON.stringify([REPO, SCRATCH]),
  AGY_BRIDGE_GUARD_DENY: JSON.stringify(["~/.agy-bridge", "~/scripts/proxy.env", "~/.ssh"]),
  AGY_BRIDGE_ALLOW_PUSH: "0",
};

test("Guard blocks sensitive reads, interactive tools, destructive commands, and out-of-scope writes", () => {
  const blockedCalls = [
    { toolCall: { name: "ask_question", args: { questions: [] } } },
    { toolCall: { name: "schedule", args: { Prompt: "hi" } } },
    { toolCall: { name: "read_file", args: { Path: path.join(os.homedir(), "scripts/proxy.env") } } },
    { toolCall: { name: "read_file", args: { Path: path.join(os.homedir(), ".ssh/id_ed25519") } } },
    { toolCall: { name: "read_file", args: { Path: path.join(os.homedir(), ".agy-bridge/secret.env") } } },
    { toolCall: { name: "write_file", args: { Path: "/etc/hosts", Content: "x" } } },
    { toolCall: { name: "edit_file", args: { Path: "/tmp/other-project/a.js" } } },
    { toolCall: { name: "run_command", args: { CommandLine: "env | grep SECRET" } } },
    { toolCall: { name: "run_command", args: { CommandLine: "cat ~/.agy-bridge/secret.env" } } },
    { toolCall: { name: "run_command", args: { CommandLine: "launchctl unload foo.plist" } } },
    { toolCall: { name: "run_command", args: { CommandLine: "git push --force origin main" } } },
    { toolCall: { name: "run_command", args: { CommandLine: "git push origin main" } } },
    { toolCall: { name: "run_command", args: { CommandLine: "rm -rf /" } } },
  ];

  for (const payload of blockedCalls) {
    const res = evaluateToolCall({ cwd: REPO, ...payload }, BASE_ENV);
    assert.equal(res.decision, "deny", `expected deny for ${JSON.stringify(payload)}`);
  }
});

test("Guard allows in-repo edits, scratch writes, tests, and normal git push only when enabled", () => {
  const allowed = [
    { toolCall: { name: "edit_file", args: { Path: path.join(REPO, "web/server.mjs") } } },
    { toolCall: { name: "write_file", args: { Path: path.join(SCRATCH, "debug.log") } } },
    { toolCall: { name: "run_command", args: { CommandLine: "npm test" } } },
  ];

  for (const payload of allowed) {
    const res = evaluateToolCall({ cwd: REPO, ...payload }, BASE_ENV);
    assert.equal(res.decision, "allow", `expected allow for ${JSON.stringify(payload)}: ${res.reason}`);
  }

  const pushEnabled = evaluateToolCall(
    { cwd: REPO, toolCall: { name: "run_command", args: { CommandLine: "git push origin main" } } },
    { ...BASE_ENV, AGY_BRIDGE_ALLOW_PUSH: "1" },
  );
  assert.equal(pushEnabled.decision, "allow");

  const forceStillBlocked = evaluateToolCall(
    { cwd: REPO, toolCall: { name: "run_command", args: { CommandLine: "git push -f origin main" } } },
    { ...BASE_ENV, AGY_BRIDGE_ALLOW_PUSH: "1" },
  );
  assert.equal(forceStillBlocked.decision, "deny");
});
