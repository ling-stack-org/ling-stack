import assert from "node:assert/strict";
import test from "node:test";
import { createLingStackMcpProxyExtension } from "../dist/extensions/mcp-proxy.js";

test("MCP proxy forwards the runner execution signal to the daemon call handler", async () => {
  const registered = [];
  const requests = [];
  createLingStackMcpProxyExtension({
    task: { id: "task_mcp_signal", title: "MCP signal", prompt: "test" },
    cwd: "/tmp/ling-mcp-signal",
    mcpTools: [{
      registeredName: "mcp_files_read_file",
      serverId: "mcp_files",
      rawName: "read_file",
      displayName: "Read file",
      inputSchema: { type: "object" },
      sideEffectLevel: "read",
      defaultApproval: "allow",
    }],
    async onMcpToolCall(request) {
      requests.push(request);
      return { content: [{ type: "text", text: "ok" }] };
    },
  })({ on() {}, registerTool: (tool) => registered.push(tool) });

  const controller = new AbortController();
  const result = await registered[0].execute(
    "tool_call_signal",
    { path: "README.md" },
    controller.signal,
  );

  assert.deepEqual(result.content, [{ type: "text", text: "ok" }]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].signal, controller.signal);
});

test("MCP proxy discards a successful daemon result after runner cancellation", async () => {
  const registered = [];
  const controller = new AbortController();
  const abortReason = new Error("runner cancelled");
  createLingStackMcpProxyExtension({
    task: { id: "task_mcp_late_cancel", title: "MCP late cancel", prompt: "test" },
    cwd: "/tmp/ling-mcp-late-cancel",
    mcpTools: [{
      registeredName: "mcp_files_read_file",
      serverId: "mcp_files",
      rawName: "read_file",
      displayName: "Read file",
      inputSchema: { type: "object" },
      sideEffectLevel: "read",
      defaultApproval: "allow",
    }],
    async onMcpToolCall() {
      controller.abort(abortReason);
      return { content: [{ type: "text", text: "late" }] };
    },
  })({ on() {}, registerTool: (tool) => registered.push(tool) });

  await assert.rejects(
    registered[0].execute("tool_call_late_cancel", {}, controller.signal),
    (error) => error === abortReason,
  );
});

test("MCP proxy stops after approval when the runner is cancelled", async () => {
  const registered = [];
  const controller = new AbortController();
  const abortReason = new Error("runner cancelled during approval");
  let toolCalls = 0;
  createLingStackMcpProxyExtension({
    task: { id: "task_mcp_approval_cancel", title: "MCP approval cancel", prompt: "test" },
    cwd: "/tmp/ling-mcp-approval-cancel",
    mcpTools: [{
      registeredName: "mcp_files_write_file",
      serverId: "mcp_files",
      rawName: "write_file",
      displayName: "Write file",
      inputSchema: { type: "object" },
      sideEffectLevel: "write",
      defaultApproval: "ask",
    }],
    async onApprovalRequired() {
      controller.abort(abortReason);
      return { approved: true, approvalId: "approval_cancelled" };
    },
    async onMcpToolCall() {
      toolCalls += 1;
      return { content: [{ type: "text", text: "must not run" }] };
    },
  })({ on() {}, registerTool: (tool) => registered.push(tool) });

  await assert.rejects(
    registered[0].execute("tool_call_approval_cancel", {}, controller.signal),
    (error) => error === abortReason,
  );
  assert.equal(toolCalls, 0);
});
