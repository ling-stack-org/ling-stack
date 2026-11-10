import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApprovalAutoReviewExecutionError,
  executeApprovalAutoReviewModel,
} from "../dist/features/runs/approval-auto-review-executor.js";

const provider = {
  provider: "test-provider",
  model: "test-model",
  apiKey: "never-persist-this",
};

function reviewerInput(runner) {
  return {
    runner,
    provider,
    cwd: "/workspace/project",
    approvalId: "approval-1",
    evidenceFingerprint: "a".repeat(64),
    serializedEvidence: '{"schemaVersion":1}',
  };
}

test("automatic review executor creates an isolated no-tool session", async () => {
  let captured;
  const runner = {
    runTask: async (options) => {
      captured = options;
      options.onEvent?.({
        type: "message_end",
        role: "assistant",
        text: '{"schemaVersion":1,"decision":"approve","reason":"Scoped."}',
      });
      return { taskId: options.task.id, events: [], messages: [] };
    },
  };
  const output = await executeApprovalAutoReviewModel(reviewerInput(runner));
  assert.equal(output, '{"schemaVersion":1,"decision":"approve","reason":"Scoped."}');
  assert.deepEqual(captured.tools, []);
  assert.deepEqual(captured.mcpTools, []);
  assert.deepEqual(captured.hostCapabilityTools, []);
  assert.deepEqual(captured.mediaGenerationTools, []);
  assert.deepEqual(captured.initialToolSurface, { mediaGeneration: false, toolHydration: false });
  assert.equal(captured.thinkingLevel, "off");
  assert.equal(captured.reasoningSummary, "none");
  assert.equal((await captured.onToolBefore({ toolCallId: "tool-1", toolName: "bash", input: {}, cwd: captured.cwd })).allowed, false);
  assert.doesNotMatch(captured.task.prompt, /never-persist-this/);
});

test("automatic review executor fails closed on tool activity, empty output, or multiple assistant results", async () => {
  const toolRunner = {
    runTask: async (options) => {
      options.onEvent?.({ type: "tool_start", toolCallId: "tool-1", toolName: "bash", args: {} });
      options.onEvent?.({ type: "message_end", role: "assistant", text: "{}" });
      return { taskId: options.task.id, events: [], messages: [] };
    },
  };
  await assert.rejects(
    executeApprovalAutoReviewModel(reviewerInput(toolRunner)),
    (error) => error instanceof ApprovalAutoReviewExecutionError && error.code === "tool_activity",
  );

  const emptyRunner = {
    runTask: async (options) => ({ taskId: options.task.id, events: [], messages: [] }),
  };
  await assert.rejects(
    executeApprovalAutoReviewModel(reviewerInput(emptyRunner)),
    (error) => error instanceof ApprovalAutoReviewExecutionError && error.code === "empty_output",
  );

  const multipleRunner = {
    runTask: async (options) => {
      options.onEvent?.({ type: "message_end", role: "assistant", text: "first" });
      options.onEvent?.({ type: "message_end", role: "assistant", text: "second" });
      return { taskId: options.task.id, events: [], messages: [] };
    },
  };
  await assert.rejects(
    executeApprovalAutoReviewModel(reviewerInput(multipleRunner)),
    (error) => error instanceof ApprovalAutoReviewExecutionError && error.code === "multiple_outputs",
  );
});

test("automatic review executor accepts one final assistant message from the result fallback", async () => {
  const runner = {
    runTask: async (options) => ({
      taskId: options.task.id,
      events: [],
      messages: [{ role: "user", content: "evidence" }, { role: "assistant", content: [{ type: "text", text: "{\"schemaVersion\":1}" }] }],
    }),
  };
  assert.equal(await executeApprovalAutoReviewModel(reviewerInput(runner)), '{"schemaVersion":1}');
});
