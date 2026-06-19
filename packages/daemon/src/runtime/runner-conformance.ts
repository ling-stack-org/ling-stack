import assert from "node:assert/strict";
import test from "node:test";
import { evaluateLingSandboxReadiness } from "@ling-stack/core";
import type {
  PiRunnerHydratedToolDescriptor,
  PiRunnerProviderConfig,
  PiRunnerResult,
  PiRunnerRunOptions,
  PiRunnerToolHydrationResponse,
} from "@ling-stack/runner-pi";
import type { RunnerAdapter } from "../context.js";

export interface RunnerConformanceFakeOptions {
  readonly failProvider?: boolean;
  readonly artifactSummary?: boolean;
  readonly workspaceBoundaryViolation?: boolean;
  readonly forceUnmaterializedWriteTool?: boolean;
  readonly sandboxReadinessFailure?: boolean;
  readonly forceToolHydration?: boolean;
  readonly hydrationDuplicateRetry?: boolean;
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

  test(`${name}: daemon-hydrated tool schema keeps ask approval intact`, async () => {
    const runner = createRunner({ forceToolHydration: true });
    const events: unknown[] = [];
    const approvals: unknown[] = [];
    const hydrationRequests: unknown[] = [];
    const timeline: string[] = [];

    await runner.runTask({
      ...baseRunOptions(),
      tools: ["write"],
      onEvent: (event) => {
        events.push(event);
        timeline.push(readEventType(event) ?? "unknown");
      },
      onToolHydrationRequest: async (request) => {
        hydrationRequests.push(request);
        timeline.push("hydration_callback");
        return hydratedWriteSurface({
          executionApproval: "ask",
          enabled: true,
        });
      },
      onApprovalRequired: async (request) => {
        approvals.push(request);
        timeline.push("approval_request");
        return { approved: true, approvalId: "approval_hydrated_write" };
      },
    });

    assert.equal(hydrationRequests.length, 1);
    assert.equal(approvals.length, 1);
    assert.equal(readRecord(approvals[0]).toolName, "write");
    assert.equal(timeline.indexOf("tool_hydration_request") < timeline.indexOf("hydration_callback"), true);
    assert.equal(timeline.indexOf("tool_hydration_end") < timeline.indexOf("tool_start"), true);
    assert.equal(timeline.indexOf("approval_request") < timeline.indexOf("tool_end"), true);
    assert.equal(JSON.stringify(events).includes("inputSchema"), false);
    assert.equal(runner.cleanupCount, 1);
  });

  test(`${name}: denied hydrated tools can be described but not executed`, async () => {
    const runner = createRunner({ forceToolHydration: true });
    const events: unknown[] = [];
    const approvals: unknown[] = [];

    await assert.rejects(
      () => runner.runTask({
        ...baseRunOptions(),
        tools: ["write"],
        onEvent: (event) => events.push(event),
        onToolHydrationRequest: async () => hydratedWriteSurface({
          executionApproval: "deny",
          enabled: false,
          disabledReasons: [{ code: "policy_deny", message: "Workspace policy denies write." }],
        }),
        onApprovalRequired: async (request) => {
          approvals.push(request);
          return { approved: true, approvalId: "approval_unexpected" };
        },
      }),
      /hydrated tool execution denied/i,
    );

    assert.equal(approvals.length, 0);
    assert.equal(events.some((event) => readEventType(event) === "tool_hydration_end" && readRecord(event).rejected === false), true);
    assert.equal(events.some((event) => readEventType(event) === "tool_start" && readRecord(event).toolName === "write"), true);
    assert.equal(events.some((event) => readEventType(event) === "tool_end" && readRecord(event).isError === true), true);
    assert.equal(events.some((event) => readEventType(event) === "run_error"), true);
    assert.equal(JSON.stringify(events).includes("approval_unexpected"), false);
    assert.equal(runner.cleanupCount, 1);
  });

  test(`${name}: hydration policy rejection fails closed before approval`, async () => {
    const runner = createRunner({ forceToolHydration: true });
    const events: unknown[] = [];
    const approvals: unknown[] = [];

    await assert.rejects(
      () => runner.runTask({
        ...baseRunOptions(),
        tools: ["write"],
        onEvent: (event) => events.push(event),
        onToolHydrationRequest: async () => ({
          ok: false,
          code: "tool_materialization_denied",
          message: "Workspace policy denied tool hydration.",
          retryable: false,
          generatedAt: "2026-06-19T00:00:00.000Z",
        }),
        onApprovalRequired: async (request) => {
          approvals.push(request);
          return { approved: true, approvalId: "approval_unexpected" };
        },
      }),
      /tool hydration rejected/i,
    );

    assert.equal(approvals.length, 0);
    assert.equal(events.some((event) => readEventType(event) === "tool_hydration_end" && readRecord(event).code === "tool_materialization_denied"), true);
    assert.equal(events.some((event) => readEventType(event) === "tool_start" && readRecord(event).toolName === "write"), false);
    assert.equal(events.some((event) => readEventType(event) === "run_error"), true);
    assert.equal(JSON.stringify(events).includes("approval_unexpected"), false);
    assert.equal(runner.cleanupCount, 1);
  });

  test(`${name}: over-budget hydration rejection exposes no schema and triggers no materialization success`, async () => {
    const runner = createRunner({ forceToolHydration: true });
    const events: unknown[] = [];
    const approvals: unknown[] = [];

    await assert.rejects(
      () => runner.runTask({
        ...baseRunOptions(),
        tools: ["write"],
        onEvent: (event) => events.push(event),
        onToolHydrationRequest: async () => ({
          ok: false,
          code: "tool_materialization_over_budget",
          message: "Tool materialization exceeds the run context budget.",
          retryable: false,
          budget: baseHydrationBudget("over_budget"),
          generatedAt: "2026-06-19T00:00:00.000Z",
        }),
        onApprovalRequired: async (request) => {
          approvals.push(request);
          return { approved: true, approvalId: "approval_unexpected" };
        },
      }),
      /tool hydration rejected/i,
    );

    assert.equal(approvals.length, 0);
    assert.equal(events.filter((event) => readEventType(event) === "tool_hydration_end" && readRecord(event).rejected === false).length, 0);
    assert.equal(events.some((event) => readEventType(event) === "tool_hydration_end" && readRecord(event).code === "tool_materialization_over_budget"), true);
    assert.equal(JSON.stringify(events).includes("inputSchema"), false);
    assert.equal(JSON.stringify(events).includes("approval_unexpected"), false);
    assert.equal(runner.cleanupCount, 1);
  });

  test(`${name}: idempotent hydration retry does not duplicate hydrated surface evidence`, async () => {
    const runner = createRunner({ forceToolHydration: true, hydrationDuplicateRetry: true });
    const events: unknown[] = [];
    let requestCount = 0;

    await runner.runTask({
      ...baseRunOptions(),
      onEvent: (event) => events.push(event),
      onToolHydrationRequest: async () => {
        requestCount += 1;
        return hydratedWriteSurface({
          executionApproval: "ask",
          enabled: true,
        });
      },
    });

    assert.equal(requestCount, 2);
    assert.equal(events.filter((event) => readEventType(event) === "tool_hydration_request").length, 2);
    assert.equal(events.filter((event) => readEventType(event) === "tool_hydration_end" && readRecord(event).rejected === false).length, 1);
    assert.equal(runner.cleanupCount, 1);
  });
}

export function baseRunOptions(): PiRunnerRunOptions {
  return {
    runId: "run_test",
    runnerAttemptId: "attempt_test",
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
      const hydratedTools = await this.maybeHydrateTools(options);
      if (this.options.forceUnmaterializedWriteTool) {
        this.emitUnmaterializedWriteTool(options);
      }
      if (options.tools?.includes("write")) {
        await this.emitWriteTool(options, findHydratedTool(hydratedTools, "write"));
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

  private async maybeHydrateTools(options: PiRunnerRunOptions): Promise<readonly PiRunnerHydratedToolDescriptor[]> {
    if (!this.options.forceToolHydration) {
      return [];
    }
    const first = await this.requestToolHydration(options);
    if (!first.ok) {
      return this.rejectHydration(options, first);
    }
    const hydratedTools = first.tools;
    if (this.options.hydrationDuplicateRetry) {
      const second = await this.requestToolHydration(options, true);
      if (!second.ok) {
        return this.rejectHydration(options, second);
      }
    }
    return hydratedTools;
  }

  private async requestToolHydration(
    options: PiRunnerRunOptions,
    suppressAcceptedEvent = false,
  ): Promise<PiRunnerToolHydrationResponse> {
    const runId = options.runId ?? options.task.id;
    const runnerAttemptId = options.runnerAttemptId ?? "attempt_conformance";
    const request = {
      runId,
      runnerAttemptId,
      scope: { kind: "namespace" as const, namespaceId: "core" },
      reason: "Hydrate write tool schema for this active runner turn.",
      idempotencyKey: `${runId}:${runnerAttemptId}:core`,
      task: options.task,
      cwd: options.cwd,
    };
    options.onEvent?.({
      type: "tool_hydration_request",
      runId,
      runnerAttemptId,
      scope: request.scope,
      idempotencyKeyProvided: true,
    });
    const response = await options.onToolHydrationRequest?.(request);
    if (!response) {
      return {
        ok: false,
        code: "hydration_not_supported",
        message: "Runner tool hydration callback is not configured.",
        retryable: false,
        generatedAt: new Date().toISOString(),
      };
    }
    if (!response.ok) {
      options.onEvent?.({
        type: "tool_hydration_end",
        runId,
        runnerAttemptId,
        rejected: true,
        code: response.code,
      });
      return response;
    }
    if (!suppressAcceptedEvent) {
      options.onEvent?.({
        type: "tool_hydration_end",
        runId,
        runnerAttemptId,
        materializationId: response.materialization.id,
        toolIds: response.materialization.toolIds,
        rejected: false,
      });
    }
    return response;
  }

  private rejectHydration(options: PiRunnerRunOptions, response: Exclude<PiRunnerToolHydrationResponse, { readonly ok: true }>): never {
    options.onEvent?.({ type: "assistant_text_delta", text: `Tool hydration rejected: ${response.code}.` });
    options.onEvent?.({ type: "run_error", taskId: options.task.id, message: `Tool hydration rejected: ${response.code}.` });
    throw new Error(`Tool hydration rejected: ${response.code}.`);
  }

  private async emitWriteTool(options: PiRunnerRunOptions, hydratedTool?: PiRunnerHydratedToolDescriptor): Promise<void> {
    const toolCallId = "tool_write_1";
    options.onEvent?.({ type: "tool_start", toolCallId, toolName: "write", args: { path: "README.md" } });
    if (hydratedTool && (!hydratedTool.enabled || hydratedTool.executionApproval === "deny")) {
      options.onEvent?.({ type: "tool_end", toolCallId, toolName: "write", result: { allowed: false }, isError: true });
      options.onEvent?.({ type: "run_error", taskId: options.task.id, message: "Hydrated tool execution denied." });
      throw new Error("Hydrated tool execution denied.");
    }
    if (hydratedTool?.executionApproval === "allow") {
      options.onEvent?.({ type: "tool_end", toolCallId, toolName: "write", result: { approved: true }, isError: false });
      return;
    }
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

function findHydratedTool(
  tools: readonly PiRunnerHydratedToolDescriptor[],
  name: string,
): PiRunnerHydratedToolDescriptor | undefined {
  return tools.find((tool) => tool.name === name);
}

function hydratedWriteSurface(input: {
  readonly executionApproval: "allow" | "ask" | "deny";
  readonly enabled: boolean;
  readonly disabledReasons?: readonly { readonly code: string; readonly message: string }[];
}): PiRunnerToolHydrationResponse {
  const generatedAt = "2026-06-19T00:00:00.000Z";
  return {
    ok: true,
    materialization: {
      id: "tool_materialization_hydrated_write",
      runId: "run_test",
      namespaceId: "core",
      toolIds: ["core:write"],
      materializedToolCount: 1,
      disabledToolCount: input.enabled ? 0 : 1,
      executionApprovalSummary: {
        allow: input.executionApproval === "allow" ? 1 : 0,
        ask: input.executionApproval === "ask" ? 1 : 0,
        deny: input.executionApproval === "deny" ? 1 : 0,
      },
      budget: baseHydrationBudget("within_budget"),
      generatedAt,
    },
    tools: [{
      id: "core:write",
      namespaceId: "core",
      sourceKind: "core_tool",
      name: "write",
      displayName: "Write",
      description: "Write a file in the workspace.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
      sideEffectLevel: "write",
      defaultApproval: "ask",
      executionApproval: input.executionApproval,
      enabled: input.enabled,
      disabledReasons: input.disabledReasons ?? [],
    }],
    generatedAt,
  };
}

function baseHydrationBudget(decision: "within_budget" | "over_budget") {
  return {
    decision,
    estimatedTokens: decision === "over_budget" ? 2000 : 24,
    inputBudgetTokens: 1024,
    remainingBudgetTokens: decision === "over_budget" ? 0 : 1000,
    overBudgetByTokens: decision === "over_budget" ? 976 : 0,
    requestedToolCount: 1,
    maxMaterializedToolCount: 64,
    mode: "model_estimated" as const,
    tokenizer: "estimated" as const,
  };
}
