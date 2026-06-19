import assert from "node:assert/strict";
import test from "node:test";
import { evaluateLingSandboxReadiness } from "@ling-stack/core";
import type { PiRunnerProviderConfig, PiRunnerResult, PiRunnerRunOptions } from "@ling-stack/runner-pi";
import type { RunnerAdapter } from "../context.js";

export interface RunnerConformanceFakeOptions {
  readonly failProvider?: boolean;
  readonly artifactSummary?: boolean;
  readonly workspaceBoundaryViolation?: boolean;
  readonly forceUnmaterializedWriteTool?: boolean;
  readonly sandboxReadinessFailure?: boolean;
}

export interface ConformanceRunner extends RunnerAdapter {
  readonly cleanupCount: number;
}

export function runRunnerConformanceSuite(
  name: string,
  createRunner: (options?: RunnerConformanceFakeOptions) => ConformanceRunner,
): void {
  test(`${name}: lifecycle, text, tool, approval, cleanup`, async () => {
    const runner = createRunner();
    const events: unknown[] = [];
    const approvals: unknown[] = [];
    const timeline: string[] = [];
    const result = await runner.runTask({
      ...baseRunOptions(),
      tools: ["read", "write"],
      onEvent: (event) => {
        events.push(event);
        timeline.push(readEventType(event) ?? "unknown");
      },
      onApprovalRequired: async (request) => {
        approvals.push({ type: "approval_request", toolName: readRecord(request).toolName });
        timeline.push("approval_request");
        return { approved: true, approvalId: "approval_test" };
      },
    });

    assert.equal(result.taskId, "task_test");
    assert.deepEqual(events.map((event) => readEventType(event)), [
      "run_start",
      "turn_start",
      "assistant_text_delta",
      "tool_start",
      "tool_end",
      "turn_end",
      "message_end",
      "run_end",
    ]);
    assert.equal(events.filter((event) => readEventType(event) === "run_start").length, 1);
    assert.equal(events.filter((event) => readEventType(event) === "run_end").length, 1);
    assert.equal(result.messages.length, 1);
    assert.equal(approvals.length, 1);
    assert.equal(readRecord(approvals[0]).toolName, "write");
    assertPairedToolEvents(events, "tool_write_1");
    assert.equal(timeline.indexOf("tool_start") < timeline.indexOf("approval_request"), true);
    assert.equal(timeline.indexOf("approval_request") < timeline.indexOf("tool_end"), true);
    assert.equal(runner.cleanupCount, 1);
  });

  test(`${name}: pre-aborted signal is respected`, async () => {
    const runner = createRunner();
    const controller = new AbortController();
    controller.abort();
    const events: unknown[] = [];

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
    const events: unknown[] = [];
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
    assert.equal(events.some((event) => readEventType(event) === "run_start"), true);
    assert.equal(events.some((event) => readEventType(event) === "run_error"), true);
    assert.equal(runner.cleanupCount, 1);
  });

  test(`${name}: provider failure is surfaced without leaking secrets`, async () => {
    const runner = createRunner({ failProvider: true });
    const events: unknown[] = [];
    await assert.rejects(
      () => runner.runTask({
        ...baseRunOptions(),
        provider: { ...baseProvider(), apiKey: "sk-test-secret" },
        onEvent: (event) => events.push(event),
      }),
      /provider failed/i,
    );

    assert.equal(events.some((event) => readEventType(event) === "run_error"), true);
    assert.equal(JSON.stringify(events).includes("sk-test-secret"), false);
    assert.equal(runner.cleanupCount, 1);
  });

  test(`${name}: side-effect approval denial fails closed`, async () => {
    const runner = createRunner();
    const events: unknown[] = [];
    await assert.rejects(
      () => runner.runTask({
        ...baseRunOptions(),
        tools: ["write"],
        onEvent: (event) => events.push(event),
        onApprovalRequired: async () => ({ approved: false, approvalId: "approval_denied" }),
      }),
      /approval denied/i,
    );
    assert.equal(events.some((event) => readEventType(event) === "tool_end" && readRecord(event).isError === true), true);
    assert.equal(events.some((event) => readEventType(event) === "run_error"), true);
    assert.equal(events.some((event) => readEventType(event) === "run_end"), false);
    assert.equal(JSON.stringify(events).includes("approval_denied"), false);
    assert.equal(runner.cleanupCount, 1);
  });

  test(`${name}: unmaterialized side-effect tool attempts fail closed`, async () => {
    const runner = createRunner({ forceUnmaterializedWriteTool: true });
    const events: unknown[] = [];
    const approvals: unknown[] = [];
    await assert.rejects(
      () => runner.runTask({
        ...baseRunOptions(),
        tools: ["read"],
        onEvent: (event) => events.push(event),
        onApprovalRequired: async (request) => {
          approvals.push(request);
          return { approved: true, approvalId: "approval_unexpected" };
        },
      }),
      /not materialized/i,
    );
    assert.equal(approvals.length, 0);
    assert.equal(events.some((event) => readEventType(event) === "tool_start" && readRecord(event).toolName === "write"), true);
    assert.equal(events.some((event) => readEventType(event) === "run_error"), true);
    assert.equal(events.some((event) => readEventType(event) === "run_end"), false);
    assert.equal(runner.cleanupCount, 1);
  });

  test(`${name}: artifact summary is reported without raw secret content`, async () => {
    const runner = createRunner({ artifactSummary: true });
    const events: unknown[] = [];
    await runner.runTask({
      ...baseRunOptions(),
      onEvent: (event) => events.push(event),
    });
    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes("sk-test-secret"), false);
    assert.equal(serialized.includes("artifact_imported"), true);
    assert.equal(runner.cleanupCount, 1);
  });

  test(`${name}: workspace boundary rejection fails closed`, async () => {
    const runner = createRunner({ workspaceBoundaryViolation: true });
    const events: unknown[] = [];
    await assert.rejects(
      () => runner.runTask({
        ...baseRunOptions(),
        onEvent: (event) => events.push(event),
      }),
      /workspace boundary/i,
    );
    assert.equal(events.some((event) => readEventType(event) === "run_error"), true);
    assert.equal(runner.cleanupCount, 1);
  });

  test(`${name}: sandbox readiness failures block execution before side effects`, async () => {
    const runner = createRunner({ sandboxReadinessFailure: true });
    const events: unknown[] = [];
    await assert.rejects(
      () => runner.runTask({
        ...baseRunOptions(),
        tools: ["write"],
        onEvent: (event) => events.push(event),
        onApprovalRequired: async () => ({ approved: true, approvalId: "approval_unexpected" }),
      }),
      /sandbox readiness/i,
    );
    assert.deepEqual(events.map((event) => readEventType(event)), ["run_start", "run_error"]);
    assert.equal(JSON.stringify(events).includes("sk-test-secret"), false);
    assert.equal(runner.cleanupCount, 1);
  });
}

export function baseRunOptions(): PiRunnerRunOptions {
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

export function baseProvider(): PiRunnerProviderConfig {
  return {
    provider: "test",
    model: "test-model",
    api: "openai-responses",
    apiKey: "redacted",
  };
}

export class FakeConformantRunner implements ConformanceRunner {
  readonly options: RunnerConformanceFakeOptions;
  cleanupCount = 0;

  constructor(options: RunnerConformanceFakeOptions = {}) {
    this.options = options;
  }

  async runTask(options: PiRunnerRunOptions): Promise<PiRunnerResult> {
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
      if (this.options.sandboxReadinessFailure) {
        const report = evaluateLingSandboxReadiness({
          profile: {
            schemaVersion: 1,
            id: "unsafe-sandbox",
            displayName: "Unsafe sandbox",
            backendKind: "external",
            capabilities: ["artifact_export", "network_policy"],
            backendVerified: false,
            artifactImportVerified: false,
            networkPolicyVerified: false,
            networkPolicy: { mode: "allowlist", allowedHosts: [] },
            artifactImport: { importRoot: "/tmp/ling-runner-conformance/artifacts", requireRedaction: true },
          },
          manifest: {
            schemaVersion: 1,
            profileId: "unsafe-sandbox",
            workspaceRoot: "/tmp/ling-runner-conformance",
            artifactImportRoots: ["/tmp/unsafe-output"],
            env: { OPENAI_API_KEY: "sk-test-secret" },
          },
        });
        options.onEvent?.({
          type: "run_error",
          taskId: options.task.id,
          message: `Sandbox readiness failed: ${report.blockingReasons.map((blocker) => blocker.code).join(", ")}`,
        });
        throw new Error("Sandbox readiness failed.");
      }
      options.onEvent?.({ type: "turn_start" });
      if (options.signal?.aborted) {
        options.onEvent?.({ type: "run_error", taskId: options.task.id, message: "Run cancelled." });
        throw new Error("Run cancelled.");
      }
      if (this.options.workspaceBoundaryViolation) {
        options.onEvent?.({ type: "run_error", taskId: options.task.id, message: "Workspace boundary rejected." });
        throw new Error("Workspace boundary rejected.");
      }
      if (this.options.failProvider) {
        options.onEvent?.({ type: "run_error", taskId: options.task.id, message: "Provider failed." });
        throw new Error("Provider failed.");
      }
      options.onEvent?.({ type: "assistant_text_delta", text: "Conformant output." });
      if (this.options.forceUnmaterializedWriteTool) {
        this.emitUnmaterializedWriteTool(options);
      }
      if (options.tools?.includes("write")) {
        await this.emitWriteTool(options);
      }
      if (this.options.artifactSummary) {
        options.onEvent?.({
          type: "tool_end",
          toolCallId: "artifact_imported",
          toolName: "artifact_import",
          result: { path: "/tmp/ling-runner-conformance/artifact.txt", bytes: 24 },
          isError: false,
        });
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

  private async emitWriteTool(options: PiRunnerRunOptions): Promise<void> {
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
      options.onEvent?.({ type: "run_error", taskId: options.task.id, message: "Tool approval denied." });
      throw new Error("Tool approval denied.");
    }
    options.onEvent?.({ type: "tool_end", toolCallId, toolName: "write", result: { approvalId: decision.approvalId }, isError: false });
  }

  private emitUnmaterializedWriteTool(options: PiRunnerRunOptions): never {
    const toolCallId = "tool_write_unmaterialized";
    options.onEvent?.({ type: "tool_start", toolCallId, toolName: "write", args: { path: "README.md" } });
    options.onEvent?.({ type: "tool_end", toolCallId, toolName: "write", result: { allowed: false }, isError: true });
    options.onEvent?.({ type: "run_error", taskId: options.task.id, message: "Tool write was not materialized." });
    throw new Error("Tool write was not materialized.");
  }
}

export class FakeExternalAgentRunner extends FakeConformantRunner {}

function readEventType(event: unknown): string | undefined {
  return readRecord(event).type as string | undefined;
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function indexOfEvent(events: readonly unknown[], type: string): number {
  return events.findIndex((event) => readEventType(event) === type);
}

function assertPairedToolEvents(events: readonly unknown[], toolCallId: string): void {
  const starts = events.filter((event) => readEventType(event) === "tool_start" && readRecord(event).toolCallId === toolCallId);
  const ends = events.filter((event) => readEventType(event) === "tool_end" && readRecord(event).toolCallId === toolCallId);
  assert.equal(starts.length, 1);
  assert.equal(ends.length, 1);
  assert.equal(indexOfEvent(events, "tool_start") < indexOfEvent(events, "tool_end"), true);
}
