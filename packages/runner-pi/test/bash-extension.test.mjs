import assert from "node:assert/strict";
import { test } from "node:test";
import { createLingStackApprovalExtension } from "../dist/extensions/approval.js";
import { createLingStackBashToolExtension } from "../dist/extensions/bash.js";

test("unified exec bash extension returns daemon handled results", async () => {
  const registered = [];
  createLingStackBashToolExtension({
    ...baseOptions(),
    runtimeToolFeatures: { unifiedExec: true },
    async onApprovalRequired(request) {
      assert.equal(request.toolName, "bash");
      assert.equal(request.toolCallId, "tool_bash");
      assert.deepEqual(request.input, { command: "echo handled" });
      return {
        approved: true,
        handledResult: {
          content: [{ type: "text", text: "Command exited 0 in 12ms." }],
          details: { unifiedExec: { status: "succeeded" } },
        },
      };
    },
  })({ registerTool: (tool) => registered.push(tool) });

  assert.equal(registered.length, 1);
  const result = await registered[0].execute("tool_bash", { command: "echo handled" });
  assert.deepEqual(result.content, [{ type: "text", text: "Command exited 0 in 12ms." }]);
  assert.deepEqual(result.details, { unifiedExec: { status: "succeeded" } });
});

test("unified exec bash extension preserves daemon handled error results", async () => {
  const registered = [];
  createLingStackBashToolExtension({
    ...baseOptions(),
    runtimeToolFeatures: { unifiedExec: true },
    onApprovalRequired: () => ({
      approved: true,
      handledResult: {
        content: [{ type: "text", text: "Command exited 2 in 8ms." }],
        details: { unifiedExec: { status: "failed", exitCode: 2 } },
        isError: true,
      },
    }),
  })({ registerTool: (tool) => registered.push(tool) });

  const result = await registered[0].execute("tool_bash_failed", { command: "exit 2" });
  assert.deepEqual(result.content, [{ type: "text", text: "Command exited 2 in 8ms." }]);
  assert.deepEqual(result.details, { unifiedExec: { status: "failed", exitCode: 2 } });
  assert.equal(result.isError, true);
});

test("unified exec bash extension returns daemon handled denial results", async () => {
  const registered = [];
  createLingStackBashToolExtension({
    ...baseOptions(),
    runtimeToolFeatures: { unifiedExec: true },
    onApprovalRequired: () => ({
      approved: false,
      reason: "policy denied bash",
      handledResult: {
        content: [{ type: "text", text: "Ling Stack policy denied bash." }],
        details: { unifiedExec: { status: "failed", denied: true } },
        isError: true,
      },
    }),
  })({ registerTool: (tool) => registered.push(tool) });

  const result = await registered[0].execute("tool_bash_denied", { command: "rm -rf out" });
  assert.equal(result.content[0].text, "Ling Stack policy denied bash.");
  assert.deepEqual(result.details, { unifiedExec: { status: "failed", denied: true } });
  assert.equal(result.isError, true);
});

test("unified exec bash extension fails closed without handled result", async () => {
  const registered = [];
  createLingStackBashToolExtension({
    ...baseOptions(),
    runtimeToolFeatures: { unifiedExec: true },
    onApprovalRequired: () => ({ approved: true }),
  })({ registerTool: (tool) => registered.push(tool) });

  await assert.rejects(
    registered[0].execute("tool_bash_missing", { command: "echo missing" }),
    /approved bash without a handled result/,
  );
});

test("approval listener skips bash when unified exec owns the tool", async () => {
  let handler;
  createLingStackApprovalExtension({
    ...baseOptions(),
    runtimeToolFeatures: { unifiedExec: true },
    onApprovalRequired: () => {
      throw new Error("approval listener should not handle bash");
    },
  })({ on: (_event, nextHandler) => { handler = nextHandler; } });

  const result = await handler({ toolName: "bash", toolCallId: "tool_bash", input: { command: "echo ok" } });
  assert.equal(result, undefined);
});

function baseOptions() {
  return {
    cwd: process.cwd(),
    task: { id: "task", title: "Task", prompt: "Run bash" },
    provider: { provider: "test", model: "test" },
  };
}
