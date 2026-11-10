import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import { hostCapabilityToolsV1 } from "@ling-stack/contracts";
import { capturePreparedRunnerInput, readPreparedRunnerInput, restorePreparedRunnerOptions } from "../dist/features/runs/prepared-runner-input.js";
import { classifyToolAction, classifyApprovalActionType } from "../dist/features/runs/action-classifier.js";
import { hostCapabilityApprovalPayload } from "../dist/features/runs/host-capability-action.js";

test("Host actions have independent capability/file targets, never command or MCP facts", () => {
  const request = { toolName: "host_open_local_target", input: { path: "index.html" }, cwd: "/fixture" };
  const payload = hostCapabilityApprovalPayload(request);
  assert.equal(payload.type, "host_capability");
  assert.equal(classifyApprovalActionType(request.toolName, payload), "host_capability");
  const action = classifyToolAction({ toolName: request.toolName, args: request.input, toolCallId: "call", run: { id: "run", cwd: "/fixture" } });
  assert.equal(action.actionType, "host_capability");
  assert.ok(action.targetRefs.some(ref => ref.type === "file" && ref.path === "index.html"));
  assert.ok(action.targetRefs.some(ref => ref.type === "host_capability" && ref.id === "host.open_local_target"));
  assert.equal(action.targetRefs.some(ref => ref.type === "command"), false);
  assert.equal(action.targetRefs.some(ref => ref.type === "mcp_tool"), false);
  const invalid = classifyToolAction({ ...request, args: { path: "../secret" }, toolCallId: "invalid", run: { id: "run", cwd: "/fixture" } });
  assert.equal(invalid.actionType, "host_capability");
  assert.equal(invalid.targetRefs.some(ref => ref.type === "file"), false);
  assert.throws(() => hostCapabilityApprovalPayload({ ...request, toolName: "host_unknown" }));
});
test("Host input survives preparation while revocation and schema substitution fail closed", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-host-prepared-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const options = { cwd, agentDir: join(cwd, "agent"), tools: [], hostCapabilityTools: [hostCapabilityToolsV1[0]],
    task: { id: "host-task", title: "Host fixture", prompt: "Display index.html" },
    provider: { provider: "host-fixture", model: "fixture", baseUrl: "https://fixture.invalid/v1", api: "openai-completions", reasoning: false } };
  const preparedInput = await new PiRunnerAdapter().prepareTaskInput(options);
  const saved = capturePreparedRunnerInput({ runnerId: "pi", options, preparedInput });
  assert.deepEqual(saved.input.hostCapabilityTools, options.hostCapabilityTools);
  assert.deepEqual(restorePreparedRunnerOptions(saved, options).hostCapabilityTools, options.hostCapabilityTools);
  assert.throws(() => restorePreparedRunnerOptions(saved, { ...options, hostCapabilityTools: [] }), /revoked/);
  const changed = [{ ...hostCapabilityToolsV1[0], inputSchema: { type: "object" } }];
  assert.throws(() => restorePreparedRunnerOptions(saved, { ...options, hostCapabilityTools: changed }), /revoked/);
  assert.throws(() => readPreparedRunnerInput({ ...saved, input: { ...saved.input, hostCapabilityTools: changed } }, options), /Host capability/);
  const without = { ...options, hostCapabilityTools: undefined };
  const empty = capturePreparedRunnerInput({ runnerId: "pi", options: without, preparedInput: await new PiRunnerAdapter().prepareTaskInput(without) });
  assert.deepEqual(restorePreparedRunnerOptions(empty, options).hostCapabilityTools, [], "new capabilities cannot enter frozen execution input");
  assert.equal(JSON.stringify(saved).includes("onHostCapabilityCall"), false);
});
