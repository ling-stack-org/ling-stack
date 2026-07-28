import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createLingStackToolHydrationExtension,
  TOOL_HYDRATION_CALL_TOOL_NAME,
  TOOL_HYDRATION_LOAD_TOOL_NAME,
} from "../dist/extensions/tool-hydration.js";

test("tool hydration extension loads schemas and preserves MCP approval", async () => {
  const events = [];
  const approvals = [];
  const mcpCalls = [];
  const registered = new Map();
  createLingStackToolHydrationExtension({
    ...baseOptions(),
    runId: "run_hydrated",
    runnerAttemptId: "attempt_hydrated",
    onEvent: (event) => events.push(event),
    async onToolHydrationRequest(request) {
      assert.deepEqual(request.scope, { kind: "namespace", namespaceId: "mcp:mcp_files" });
      return {
        ok: true,
        materialization: {
          id: "tool_materialization_1",
          runId: request.runId,
          namespaceId: "mcp:mcp_files",
          toolIds: ["mcp:mcp_files:write_file"],
          materializedToolCount: 1,
          disabledToolCount: 0,
          executionApprovalSummary: { allow: 0, ask: 1, deny: 0 },
          budget: baseBudget(),
          generatedAt: "2026-06-19T05:00:00.000Z",
        },
        tools: [{
          id: "mcp:mcp_files:write_file",
          namespaceId: "mcp:mcp_files",
          sourceKind: "mcp_tool",
          name: "write_file",
          displayName: "Write file",
          inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          sideEffectLevel: "write",
          defaultApproval: "ask",
          executionApproval: "ask",
          enabled: true,
          disabledReasons: [],
        }],
        generatedAt: "2026-06-19T05:00:00.000Z",
      };
    },
    async onApprovalRequired(request) {
      approvals.push(request);
      return { approved: true, approvalId: "approval_hydrated" };
    },
    async onMcpToolCall(request) {
      mcpCalls.push(request);
      return {
        content: [{ type: "text", text: "wrote file" }],
        details: { ok: true },
      };
    },
  })({ registerTool: (tool) => registered.set(tool.name, tool) });

  assert.equal(registered.has(TOOL_HYDRATION_LOAD_TOOL_NAME), true);
  assert.equal(registered.has(TOOL_HYDRATION_CALL_TOOL_NAME), true);

  const loadResult = await registered.get(TOOL_HYDRATION_LOAD_TOOL_NAME).execute("tool_load", {
    scopeKind: "namespace",
    namespaceId: "mcp:mcp_files",
    reason: "Need filesystem MCP schema.",
  });
  assert.match(loadResult.content[0].text, /mcp:mcp_files:write_file/);
  assert.equal(events[0].type, "tool_hydration_request");
  assert.equal(events[1].type, "tool_hydration_end");
  assert.equal(events[1].rejected, false);

  const callController = new AbortController();
  const callResult = await registered.get(TOOL_HYDRATION_CALL_TOOL_NAME).execute("tool_call", {
    toolId: "mcp:mcp_files:write_file",
    input: { path: "README.md" },
  }, callController.signal);
  assert.deepEqual(callResult.content, [{ type: "text", text: "wrote file" }]);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].defaultApproval, "ask");
  assert.deepEqual(approvals[0].input, { path: "README.md" });
  assert.equal(mcpCalls.length, 1);
  assert.equal(mcpCalls[0].serverId, "mcp_files");
  assert.equal(mcpCalls[0].rawName, "write_file");
  assert.equal(mcpCalls[0].signal, callController.signal);
});

test("tool hydration discards a successful MCP result after runner cancellation", async () => {
  const registered = new Map();
  const controller = new AbortController();
  const abortReason = new Error("hydrated call cancelled");
  createLingStackToolHydrationExtension({
    ...baseOptions(),
    async onToolHydrationRequest(request) {
      return {
        ok: true,
        materialization: {
          id: "tool_materialization_cancel",
          runId: request.runId,
          namespaceId: "mcp:mcp_files",
          toolIds: ["mcp:mcp_files:read_file"],
          materializedToolCount: 1,
          disabledToolCount: 0,
          executionApprovalSummary: { allow: 1, ask: 0, deny: 0 },
          budget: baseBudget(),
          generatedAt: "2026-07-21T00:00:00.000Z",
        },
        tools: [{
          id: "mcp:mcp_files:read_file",
          namespaceId: "mcp:mcp_files",
          sourceKind: "mcp_tool",
          name: "read_file",
          displayName: "Read file",
          inputSchema: { type: "object" },
          sideEffectLevel: "read",
          defaultApproval: "allow",
          executionApproval: "allow",
          enabled: true,
          disabledReasons: [],
        }],
        generatedAt: "2026-07-21T00:00:00.000Z",
      };
    },
    async onMcpToolCall() {
      controller.abort(abortReason);
      return { content: [{ type: "text", text: "late" }] };
    },
  })({ registerTool: (tool) => registered.set(tool.name, tool) });

  await registered.get(TOOL_HYDRATION_LOAD_TOOL_NAME).execute("tool_load_cancel", {
    scopeKind: "namespace",
    namespaceId: "mcp:mcp_files",
    reason: "Load read tool",
  });
  await assert.rejects(
    registered.get(TOOL_HYDRATION_CALL_TOOL_NAME).execute("tool_call_cancel", {
      toolId: "mcp:mcp_files:read_file",
      input: {},
    }, controller.signal),
    (error) => error === abortReason,
  );
});

test("tool hydration stops after approval when the runner is cancelled", async () => {
  const registered = new Map();
  const controller = new AbortController();
  const abortReason = new Error("hydrated call cancelled during approval");
  let toolCalls = 0;
  createLingStackToolHydrationExtension({
    ...baseOptions(),
    async onToolHydrationRequest(request) {
      return askToolHydrationResponse(request, "tool_materialization_approval_cancel");
    },
    async onApprovalRequired() {
      controller.abort(abortReason);
      return { approved: true, approvalId: "approval_hydrated_cancelled" };
    },
    async onMcpToolCall() {
      toolCalls += 1;
      return { content: [{ type: "text", text: "must not run" }] };
    },
  })({ registerTool: (tool) => registered.set(tool.name, tool) });

  await registered.get(TOOL_HYDRATION_LOAD_TOOL_NAME).execute("tool_load_approval_cancel", {
    scopeKind: "tool",
    toolId: "mcp:mcp_files:write_file",
    reason: "Load write tool",
  });
  await assert.rejects(
    registered.get(TOOL_HYDRATION_CALL_TOOL_NAME).execute("tool_call_approval_cancel", {
      toolId: "mcp:mcp_files:write_file",
      input: {},
    }, controller.signal),
    (error) => error === abortReason,
  );
  assert.equal(toolCalls, 0);
});

test("tool hydration extension rejects hydrated tool calls before load", async () => {
  const registered = new Map();
  createLingStackToolHydrationExtension(baseOptions())({ registerTool: (tool) => registered.set(tool.name, tool) });

  await assert.rejects(
    registered.get(TOOL_HYDRATION_CALL_TOOL_NAME).execute("tool_call", {
      toolId: "mcp:mcp_files:write_file",
      input: {},
    }),
    /was not loaded/,
  );
});

test("tool hydration extension fails closed when approval is missing for ask tools", async () => {
  const registered = new Map();
  createLingStackToolHydrationExtension({
    ...baseOptions(),
    async onToolHydrationRequest(request) {
      return {
        ok: true,
        materialization: {
          id: "tool_materialization_2",
          runId: request.runId,
          namespaceId: "mcp:mcp_files",
          toolIds: ["mcp:mcp_files:write_file"],
          materializedToolCount: 1,
          disabledToolCount: 0,
          executionApprovalSummary: { allow: 0, ask: 1, deny: 0 },
          budget: baseBudget(),
          generatedAt: "2026-06-19T05:00:00.000Z",
        },
        tools: [{
          id: "mcp:mcp_files:write_file",
          namespaceId: "mcp:mcp_files",
          sourceKind: "mcp_tool",
          name: "write_file",
          displayName: "Write file",
          sideEffectLevel: "write",
          defaultApproval: "ask",
          executionApproval: "ask",
          enabled: true,
          disabledReasons: [],
        }],
        generatedAt: "2026-06-19T05:00:00.000Z",
      };
    },
  })({ registerTool: (tool) => registered.set(tool.name, tool) });

  await registered.get(TOOL_HYDRATION_LOAD_TOOL_NAME).execute("tool_load", {
    scopeKind: "tool",
    toolId: "mcp:mcp_files:write_file",
    reason: "Need write schema.",
  });
  await assert.rejects(
    registered.get(TOOL_HYDRATION_CALL_TOOL_NAME).execute("tool_call", {
      toolId: "mcp:mcp_files:write_file",
      input: {},
    }),
    /requires approval/,
  );
});

function baseOptions() {
  return {
    cwd: process.cwd(),
    task: { id: "task", title: "Task", prompt: "Load tools" },
    provider: { provider: "test", model: "test" },
  };
}

function baseBudget() {
  return {
    decision: "within_budget",
    estimatedTokens: 100,
    inputBudgetTokens: 1000,
    remainingBudgetTokens: 900,
    overBudgetByTokens: 0,
    requestedToolCount: 1,
    maxMaterializedToolCount: 64,
    mode: "model_known",
    tokenizer: "openai-compatible",
  };
}

function askToolHydrationResponse(request, id) {
  return {
    ok: true,
    materialization: {
      id,
      runId: request.runId,
      namespaceId: "mcp:mcp_files",
      toolIds: ["mcp:mcp_files:write_file"],
      materializedToolCount: 1,
      disabledToolCount: 0,
      executionApprovalSummary: { allow: 0, ask: 1, deny: 0 },
      budget: baseBudget(),
      generatedAt: "2026-07-21T00:00:00.000Z",
    },
    tools: [{
      id: "mcp:mcp_files:write_file",
      namespaceId: "mcp:mcp_files",
      sourceKind: "mcp_tool",
      name: "write_file",
      displayName: "Write file",
      inputSchema: { type: "object" },
      sideEffectLevel: "write",
      defaultApproval: "ask",
      executionApproval: "ask",
      enabled: true,
      disabledReasons: [],
    }],
    generatedAt: "2026-07-21T00:00:00.000Z",
  };
}
