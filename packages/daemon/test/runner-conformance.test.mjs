import assert from "node:assert/strict";
import test from "node:test";

runRunnerConformanceSuite("fake-conformant-runner", (options) => new FakeConformantRunner(options));

function runRunnerConformanceSuite(name, createRunner) {
  test(`${name}: lifecycle, text, tool, approval, cleanup`, async () => {
    const runner = createRunner();
    const events = [];
    const approvals = [];
    const result = await runner.runTask({
      ...baseRunOptions(),
      tools: ["read", "write"],
      onEvent: (event) => events.push(event),
      onApprovalRequired: async (request) => {
        approvals.push(request);
        return { approved: true, approvalId: "approval_test" };
      },
    });

    assert.equal(result.taskId, "task_test");
    assert.deepEqual(events.map((event) => event.type), [
      "run_start",
      "turn_start",
      "assistant_text_delta",
      "tool_start",
      "tool_end",
      "turn_end",
      "message_end",
      "run_end",
    ]);
    assert.equal(events.filter((event) => event.type === "run_start").length, 1);
    assert.equal(events.filter((event) => event.type === "run_end").length, 1);
    assert.equal(result.messages.length, 1);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].toolName, "write");
    assert.equal(runner.cleanupCount, 1);
  });

  test(`${name}: pre-aborted signal is respected`, async () => {
    const runner = createRunner();
    const controller = new AbortController();
    controller.abort();
    const events = [];

    await assert.rejects(
      () => runner.runTask({
        ...baseRunOptions(),
        signal: controller.signal,
        onEvent: (event) => events.push(event),
      }),
      /aborted/i,
    );
    assert.deepEqual(events, []);
    assert.equal(runner.cleanupCount, 1);
  });

  test(`${name}: abort during run returns a normalized cancellation`, async () => {
    const runner = createRunner();
    const controller = new AbortController();
    const events = [];
    const promise = runner.runTask({
      ...baseRunOptions(),
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "turn_start") {
          controller.abort();
        }
      },
    });

    await assert.rejects(() => promise, /cancelled/i);
    assert.equal(events.some((event) => event.type === "run_start"), true);
    assert.equal(events.some((event) => event.type === "run_error"), true);
    assert.equal(runner.cleanupCount, 1);
  });

  test(`${name}: provider failure is surfaced without leaking secrets`, async () => {
    const runner = createRunner({ failProvider: true });
    const events = [];
    await assert.rejects(
      () => runner.runTask({
        ...baseRunOptions(),
        provider: { ...baseProvider(), apiKey: "sk-test-secret" },
        onEvent: (event) => events.push(event),
      }),
      /provider failed/i,
    );

    assert.equal(events.some((event) => event.type === "run_error"), true);
    assert.equal(JSON.stringify(events).includes("sk-test-secret"), false);
    assert.equal(runner.cleanupCount, 1);
  });
}

function baseRunOptions() {
  return {
    cwd: "/tmp/ling-runner-conformance",
    task: {
      id: "task_test",
      title: "Runner conformance",
      prompt: "Prove normalized runner behavior.",
    },
    provider: baseProvider(),
  };
}

function baseProvider() {
  return {
    provider: "test",
    model: "test-model",
    api: "openai-responses",
    apiKey: "redacted",
  };
}

class FakeConformantRunner {
  constructor(options = {}) {
    this.options = options;
    this.cleanupCount = 0;
  }

  async runTask(options) {
    try {
      if (options.signal?.aborted) {
        throw new Error("Run aborted before start.");
      }
      options.onEvent?.({
        type: "run_start",
        taskId: options.task.id,
        cwd: options.cwd,
        provider: options.provider.provider,
        model: options.provider.model,
      });
      options.onEvent?.({ type: "turn_start" });
      if (options.signal?.aborted) {
        options.onEvent?.({ type: "run_error", taskId: options.task.id, message: "Run cancelled." });
        throw new Error("Run cancelled.");
      }
      if (this.options.failProvider) {
        options.onEvent?.({ type: "run_error", taskId: options.task.id, message: "Provider failed." });
        throw new Error("Provider failed.");
      }
      options.onEvent?.({ type: "assistant_text_delta", text: "Conformant output." });
      if (options.tools?.includes("write")) {
        const toolCallId = "tool_write_1";
        options.onEvent?.({ type: "tool_start", toolCallId, toolName: "write", args: { path: "README.md" } });
        const decision = await options.onApprovalRequired?.({
          toolCallId,
          toolName: "write",
          input: { path: "README.md" },
          task: options.task,
          cwd: options.cwd,
          defaultApproval: "ask",
        });
        if (!decision?.approved) {
          options.onEvent?.({ type: "tool_end", toolCallId, toolName: "write", result: { approved: false }, isError: true });
          throw new Error("Tool approval denied.");
        }
        options.onEvent?.({ type: "tool_end", toolCallId, toolName: "write", result: { approvalId: decision.approvalId }, isError: false });
      }
      options.onEvent?.({ type: "turn_end" });
      options.onEvent?.({ type: "message_end", role: "assistant" });
      options.onEvent?.({ type: "run_end", taskId: options.task.id, messageCount: 1 });
      return {
        taskId: options.task.id,
        events: [],
        messages: ["Conformant output."],
      };
    } finally {
      this.cleanupCount += 1;
    }
  }
}
