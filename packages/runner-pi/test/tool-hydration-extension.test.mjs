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

  const callResult = await registered.get(TOOL_HYDRATION_CALL_TOOL_NAME).execute("tool_call", {
    toolId: "mcp:mcp_files:write_file",
    input: { path: "README.md" },
  });
  assert.deepEqual(callResult.content, [{ type: "text", text: "wrote file" }]);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].defaultApproval, "ask");
  assert.deepEqual(approvals[0].input, { path: "README.md" });
  assert.equal(mcpCalls.length, 1);
  assert.equal(mcpCalls[0].serverId, "mcp_files");
  assert.equal(mcpCalls[0].rawName, "write_file");
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
