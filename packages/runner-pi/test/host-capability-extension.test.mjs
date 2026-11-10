import assert from "node:assert/strict";
import test from "node:test";
import { hostCapabilityToolsFixture as hostCapabilityToolsV1 } from "./support/host-capability-fixture.mjs";
import { createLingStackHostCapabilityExtension } from "../dist/extensions/host-capability.js";

function fixture(overrides = {}) {
  const handlers = new Map(), tools = [], calls = [];
  const options = { cwd: "/fixture", task: { id: "task", title: "Open", prompt: "Open index.html" },
    runId: "run", runnerAttemptId: "attempt", hostCapabilityTools: [hostCapabilityToolsV1[0]],
    onToolBefore: async request => { calls.push(["gate", request]); return { allowed: true }; },
    onApprovalRequired: async request => { calls.push(["approval", request]); return { approved: true, approvalId: "approval" }; },
    onHostCapabilityCall: async request => { calls.push(["execute", request]); return { content: [{ type: "text", text: "Host accepted" }] }; },
    ...overrides };
  createLingStackHostCapabilityExtension(options)({ on: (name, handler) => handlers.set(name, handler), registerTool: tool => tools.push(tool) });
  return { options, tools, calls, handlers, run: signal => tools[0].execute("call", { path: "index.html" }, signal) };
}
test("Host execution is separately approved, re-gated, and receives Host-owned identity", async () => {
  const f = fixture(); await f.run();
  assert.deepEqual(f.calls.map(call => call[0]), ["gate", "approval", "gate", "execute"]);
  assert.equal(f.calls[1][1].defaultApproval, "ask");
  assert.deepEqual(Object.fromEntries(["runId", "attemptId", "toolCallId", "capabilityId", "approvalId"].map(key => [key, f.calls[3][1][key]])), {
    runId: "run", attemptId: "attempt", toolCallId: "call", capabilityId: "host.open_local_target", approvalId: "approval",
  });
  assert.equal(f.calls[3][1].signal instanceof AbortSignal, true);
});
for (const missing of ["runId", "runnerAttemptId", "onToolBefore", "onApprovalRequired", "onHostCapabilityCall"]) {
  test(`Host tool cannot execute without ${missing}`, async () => {
    const f = fixture({ [missing]: undefined });
    await assert.rejects(f.run(), /not connected|identity/);
    assert.equal(f.calls.length, 0);
  });
}
test("Host denial, missing durable approval identity and revoked fence never dispatch", async () => {
  for (const approved of [false, true]) {
    const f = fixture({ onApprovalRequired: async () => ({ approved }) });
    const result = await f.run();
    assert.equal(f.calls.some(call => call[0] === "execute"), false);
    assert.equal(f.handlers.get("tool_result")({ toolCallId: "call", toolName: "host_open_local_target", ...result, isError: false }).isError, true);
  }
  let gates = 0;
  const f = fixture({ onToolBefore: async () => ++gates === 1 ? { allowed: true } : { allowed: false, code: "stale_attempt", reason: "revoked" } });
  await f.run(); assert.equal(gates, 2); assert.equal(f.calls.some(call => call[0] === "execute"), false);
});
test("cancellation during approval, through either signal, stops before the Host effect", async () => {
  for (const source of ["run", "tool"]) {
    const abort = new AbortController();
    const f = fixture({ signal: source === "run" ? abort.signal : undefined,
      onApprovalRequired: async () => { abort.abort(); return { approved: true, approvalId: "approval" }; } });
    await assert.rejects(f.run(source === "tool" ? abort.signal : undefined), { name: "AbortError" });
    assert.equal(f.calls.some(call => call[0] === "execute"), false);
  }
});
test("Host error status reaches the SDK result hook instead of resolved success", async () => {
  const f = fixture({ onHostCapabilityCall: async () => ({ isError: true, content: [{ type: "text", text: "Viewer unavailable" }], details: { code: "unavailable" } }) });
  const result = await f.run();
  assert.equal(f.handlers.get("tool_result")({ toolCallId: "call", toolName: "host_open_local_target", ...result, isError: false }).isError, true);
});
test("Host schema names cannot collide with MCP or be substituted by another capability", () => {
  for (const change of [
    { mcpTools: [{ registeredName: "host_open_local_target" }] },
    { hostCapabilityTools: [], mcpTools: [{ registeredName: "host_open_local_target" }] },
    { hostCapabilityTools: [hostCapabilityToolsV1[0], hostCapabilityToolsV1[0]] },
    { hostCapabilityTools: [{ ...hostCapabilityToolsV1[0], capabilityId: "host.local_network_info" }] },
  ]) assert.throws(() => fixture(change), /Host capability/);
});
