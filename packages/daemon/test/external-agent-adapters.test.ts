import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import type { PiRunnerApprovalRequest, PiRunnerEvent, PiRunnerResult, PiRunnerRunOptions } from "@ling-stack/runner-pi";
import { createDefaultRunnerRegistry, type RunnerAdapter, type RunnerToolExecutionConformanceV1 } from "../dist/index.js";
import { startFakeAcpServer } from "./test-support/fake-acp-server.ts";
import { createCodexAppServerAdapter } from "../dist/runtime/adapters/codex-app-server.js";
import { startFakeCodexAppServer } from "./test-support/fake-codex-app-server.ts";
import { createOpenClawAcpAdapter } from "../dist/runtime/adapters/openclaw-acp.js";
import { UnsupportedRunnerError } from "../dist/runtime/runners.js";

test("openclaw-acp adapter executes fake ACP through normalized events with a Host receipt", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-openclaw-acp-adapter-"));
  const artifactRoot = resolve(cwd, "runtime-state", "artifacts");
  const acp = await startFakeAcpServer({
    runResult: {
      taskId: "task_external",
      events: [
        { type: "text_delta", data: { text: "OpenClaw says hello." } },
        {
          type: "artifact",
          data: {
            toolCallId: "artifact_1",
            role: "artifact",
            filename: "../unsafe.txt",
            content: "artifact with sk-test-secret inside",
          },
        },
      ],
      messages: ["OpenClaw says hello."],
    },
  });
  try {
    const adapter = createOpenClawAcpAdapter({
      endpoint: acp.endpoint,
      adapterRevision: "ling-acp/0.1:adapter-v1",
      toolExecutionConformance: readOnlyReceipt("ling-acp/0.1:adapter-v1"),
    });
    const events: PiRunnerEvent[] = [];
    const result = await adapter.runTask({
      ...baseRunOptions(cwd),
      runtimePaths: { artifactsDir: artifactRoot },
      onEvent: (event) => events.push(event),
    });

    const runRequest = acp.requests.find(request => isRecord(request) && request.method === "session/run");
    assert.ok(isRecord(runRequest) && isRecord(runRequest.params));
    assert.equal(runRequest.params.runnerId, "openclaw-acp");
    assert.equal(result.taskId, "task_external");
    assert.deepEqual(events.map((event) => event.type), [
      "run_start",
      "turn_start",
      "assistant_text_delta",
      "tool_end",
      "turn_end",
      "message_end",
      "run_end",
    ]);
    assert.equal(events.find((event) => event.type === "message_end")?.text, "OpenClaw says hello.");
    assert.equal(JSON.stringify(events).includes("sk-test-secret"), false);
    const artifactEvent = events.find((event) => event.type === "tool_end" && event.toolName === "artifact_import");
    assert.ok(artifactEvent?.type === "tool_end");
    assert.ok(isRecord(artifactEvent.result) && typeof artifactEvent.result.path === "string");
    assert.equal(artifactEvent.result.path.startsWith(artifactRoot), true);
    const artifactContent = await readFile(artifactEvent.result.path, "utf8");
    assert.equal(artifactContent.includes("sk-test-secret"), false);
    assert.deepEqual(readMethods(acp.requests), ["initialize", "session/run"]);
  } finally {
    await acp.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("external adapter accepts only requested read-only proposals from its curated receipt", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-openclaw-acp-read-proposal-"));
  const acp = await startFakeAcpServer({
    runResult: {
      taskId: "task_external",
      events: [{
        type: "tool_proposal",
        data: {
          backendToolCallId: "tool_read_1",
          toolName: "read",
          input: { path: "README.md" },
          sideEffect: "workspace_read",
        },
      }],
      messages: [],
    },
  });
  try {
    const adapter = createOpenClawAcpAdapter({
      endpoint: acp.endpoint,
      adapterRevision: "ling-acp/0.1:adapter-v1",
      toolExecutionConformance: readOnlyReceipt("ling-acp/0.1:adapter-v1"),
    });
    const events: PiRunnerEvent[] = [];
    await adapter.runTask({
      ...baseRunOptions(cwd),
      tools: ["read"],
      onEvent: (event) => events.push(event),
    });
    assert.equal(events.some((event) => event.type === "tool_start" && event.toolName === "read"), true);
    assert.equal(events.some((event) => event.type === "tool_end" && event.toolName === "read" && event.isError === false), true);
  } finally {
    await acp.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("external adapter rejects backend side-effect downgrades against the Host receipt", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-openclaw-acp-side-effect-downgrade-"));
  const acp = await startFakeAcpServer({
    runResult: {
      taskId: "task_external",
      events: [{
        type: "tool_proposal",
        data: {
          backendToolCallId: "tool_read_1",
          toolName: "read",
          input: { path: "README.md" },
          sideEffect: "none",
        },
      }],
      messages: [],
    },
  });
  try {
    const adapter = createOpenClawAcpAdapter({
      endpoint: acp.endpoint,
      adapterRevision: "ling-acp/0.1:adapter-v1",
      toolExecutionConformance: readOnlyReceipt("ling-acp/0.1:adapter-v1"),
    });
    await assert.rejects(
      () => adapter.runTask({ ...baseRunOptions(cwd), tools: ["read"] }),
      /side-effect classification mismatch/i,
    );
  } finally {
    await acp.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("external adapter rejects unrequested side-effect proposals without asking for approval", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-openclaw-acp-write-proposal-"));
  const acp = await startFakeAcpServer({
    runResult: {
      taskId: "task_external",
      events: [{
        type: "tool_proposal",
        data: {
          backendToolCallId: "tool_write_1",
          toolName: "write",
          input: { path: "README.md", content: "unsafe" },
          sideEffect: "workspace_write",
        },
      }],
      messages: [],
    },
  });
  try {
    const adapter = createOpenClawAcpAdapter({
      endpoint: acp.endpoint,
      adapterRevision: "ling-acp/0.1:adapter-v1",
      toolExecutionConformance: readOnlyReceipt("ling-acp/0.1:adapter-v1"),
    });
    const approvals: PiRunnerApprovalRequest[] = [];
    await assert.rejects(
      () => adapter.runTask({
        ...baseRunOptions(cwd),
        tools: ["read"],
        onApprovalRequired: async (request) => {
          approvals.push(request);
          return { approved: true, approvalId: "approval_unexpected" };
        },
      }),
      /not requested|not part of the curated surface|native side effects are disabled/i,
    );
    assert.equal(approvals.length, 0);
  } finally {
    await acp.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("external adapter rejects conformance receipts from an older adapter revision", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-openclaw-acp-revision-drift-"));
  const acp = await startFakeAcpServer({
    runResult: {
      taskId: "task_external",
      events: [{
        type: "tool_proposal",
        data: {
          backendToolCallId: "tool_read_1",
          toolName: "read",
          input: { path: "README.md" },
          sideEffect: "workspace_read",
        },
      }],
      messages: [],
    },
  });
  try {
    const adapter = createOpenClawAcpAdapter({
      endpoint: acp.endpoint,
      adapterRevision: "ling-acp/0.1:adapter-v2",
      toolExecutionConformance: readOnlyReceipt("ling-acp/0.1:adapter-v1"),
    });
    await assert.rejects(
      () => adapter.runTask({ ...baseRunOptions(cwd), tools: ["read"] }),
      /revision does not match/i,
    );
  } finally {
    await acp.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("external adapter fails closed when a tool proposal has no Host receipt", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-openclaw-acp-missing-receipt-"));
  const acp = await startFakeAcpServer({
    runResult: {
      taskId: "task_external",
      events: [{
        type: "tool_proposal",
        data: {
          backendToolCallId: "tool_read_1",
          toolName: "read",
          input: { path: "README.md" },
          sideEffect: "workspace_read",
        },
      }],
      messages: [],
    },
  });
  try {
    const adapter = createOpenClawAcpAdapter({ endpoint: acp.endpoint });
    await assert.rejects(
      () => adapter.runTask({ ...baseRunOptions(cwd), tools: ["read"] }),
      /conformance receipt is missing/i,
    );
  } finally {
    await acp.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("external adapter fails closed when an artifact has no Host receipt", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-openclaw-acp-artifact-missing-receipt-"));
  const acp = await startFakeAcpServer({
    runResult: {
      taskId: "task_external",
      events: [{
        type: "artifact",
        data: {
          toolCallId: "artifact_1",
          role: "artifact",
          filename: "result.txt",
          content: "untrusted",
        },
      }],
      messages: [],
    },
  });
  try {
    const adapter = createOpenClawAcpAdapter({ endpoint: acp.endpoint });
    await assert.rejects(
      () => adapter.runTask(baseRunOptions(cwd)),
      /conformance receipt is missing/i,
    );
  } finally {
    await acp.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("external adapter rejects artifact import when its receipt does not verify the boundary", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-openclaw-acp-artifact-unverified-"));
  const acp = await startFakeAcpServer({
    runResult: {
      taskId: "task_external",
      events: [{
        type: "artifact",
        data: {
          toolCallId: "artifact_1",
          role: "artifact",
          filename: "result.txt",
          content: "untrusted",
        },
      }],
      messages: [],
    },
  });
  try {
    const adapter = createOpenClawAcpAdapter({
      endpoint: acp.endpoint,
      adapterRevision: "ling-acp/0.1:adapter-v1",
      toolExecutionConformance: {
        ...readOnlyReceipt("ling-acp/0.1:adapter-v1"),
        artifactImportVerified: false,
      },
    });
    await assert.rejects(
      () => adapter.runTask(baseRunOptions(cwd)),
      /artifact import is not verified/i,
    );
  } finally {
    await acp.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("openclaw-acp adapter fails closed before session run when capabilities are missing", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-openclaw-acp-missing-cap-"));
  const acp = await startFakeAcpServer({ capabilities: { artifacts: false } });
  try {
    const adapter = createOpenClawAcpAdapter({ endpoint: acp.endpoint });
    const events: PiRunnerEvent[] = [];
    await assert.rejects(
      () => adapter.runTask({
        ...baseRunOptions(cwd),
        onEvent: (event) => events.push(event),
      }),
      /capability negotiation failed/i,
    );
    assert.deepEqual(readMethods(acp.requests), ["initialize"]);
    assert.equal(events.some((event) => event.type === "run_error"), true);
  } finally {
    await acp.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("openclaw-acp stops on a backend run_error without publishing a successful run_end", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-openclaw-acp-run-error-"));
  const acp = await startFakeAcpServer({
    runResult: {
      taskId: "task_external",
      events: [{ type: "run_error", data: { taskId: "task_external", message: "Provider message ended with an error." } }],
      messages: [],
    },
  });
  try {
    const adapter = createOpenClawAcpAdapter({ endpoint: acp.endpoint });
    const events: PiRunnerEvent[] = [];
    await assert.rejects(
      () => adapter.runTask({
        ...baseRunOptions(cwd),
        onEvent: (event) => events.push(event),
      }),
      /Provider message ended with an error/,
    );
    assert.deepEqual(events.map((event) => event.type), ["run_start", "turn_start", "run_error"]);
    assert.equal(events.some((event) => event.type === "run_end"), false);
    assert.deepEqual(readMethods(acp.requests), ["initialize", "session/run"]);
  } finally {
    await acp.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("codex-app-server adapter executes fake app-server through dedicated transport", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-codex-app-server-adapter-"));
  const codex = await startFakeCodexAppServer();
  try {
    const adapter = createCodexAppServerAdapter({ baseUrl: codex.baseUrl });
    const events: PiRunnerEvent[] = [];
    const result = await adapter.runTask({
      ...baseRunOptions(cwd),
      onEvent: (event) => events.push(event),
    });

    assert.equal(result.taskId, "task_external");
    assert.equal(events.some((event) => event.type === "assistant_text_delta" && event.text === "Codex app-server fake response."), true);
    assert.deepEqual(readMethods(codex.requests), ["initialize", "session/run"]);
  } finally {
    await codex.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("codex-app-server adapter fails closed before session run on malformed initialize", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-codex-app-server-malformed-"));
  const codex = await startFakeCodexAppServer({ malformedInitializeResponse: true });
  try {
    const adapter = createCodexAppServerAdapter({ baseUrl: codex.baseUrl });
    await assert.rejects(
      () => adapter.runTask(baseRunOptions(cwd)),
      /initialize response is malformed/i,
    );
    assert.deepEqual(readMethods(codex.requests), ["initialize"]);
  } finally {
    await codex.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("retired endpoint registry requests fail without contacting backends or silently falling back to Pi", async () => {
  const acp = await startFakeAcpServer();
  const codex = await startFakeCodexAppServer();
  const pi = new RecordingRunner();
  try {
    const config = {
      runners: {
        openclawAcp: { enabled: true, endpoint: acp.endpoint, readinessPassed: true, conformancePassed: true },
        codexAppServer: { enabled: true, baseUrl: codex.baseUrl, readinessPassed: true, conformancePassed: true },
      },
    };
    const registry = createDefaultRunnerRegistry(pi, config);
    for (const runnerId of ["openclaw-acp", "codex-app-server"]) {
      const runner = registry.get(runnerId);
      assert.ok(runner);
      assert.equal(runner.status, "disabled");
      assert.ok(typeof runner.disabledReason === "string");
      assert.match(runner.disabledReason, /legacy_runner_migration_required/);
      for (const explicitFallbackPolicy of [undefined, "disabled"] as const) {
        assert.throws(() => registry.resolve({ requestedRunnerId: runnerId, explicitFallbackPolicy, tools: ["read"] }),
          error => error instanceof UnsupportedRunnerError && error.requestedRunnerId === runnerId
            && error.fallbackReason.code === "disabled_requested_runner");
      }
      await assert.rejects(() => runner.adapter.runTask(baseRunOptions(tmpdir())), /legacy_runner_migration_required/);
    }
    assert.deepEqual(acp.requests, []);
    assert.deepEqual(codex.requests, []);
    assert.equal(pi.calls, 0);
  } finally {
    await acp.close();
    await codex.close();
  }
});

function baseRunOptions(cwd: string): PiRunnerRunOptions {
  return {
    cwd,
    task: {
      id: "task_external",
      title: "External adapter task",
      prompt: "Use the fake external agent.",
    },
    provider: {
      provider: "test-provider",
      model: "test-model",
      api: "openai-responses",
      apiKey: "sk-test-secret",
    },
    tools: ["read"],
  };
}

function readOnlyReceipt(adapterRevision: string): RunnerToolExecutionConformanceV1 {
  return {
    adapterRevision,
    curatedTools: ["read"],
    toolSideEffects: { read: "workspace_read" },
    allowedSideEffects: ["workspace_read"],
    nativeSideEffectMode: "disabled",
    toolSurfaceCurated: true,
    approvalBridgeVerified: false,
    sandboxBindingVerified: false,
    evidenceCommitVerified: true,
    abortPropagationVerified: true,
    attemptFencingVerified: true,
    workspaceBoundaryVerified: true,
    artifactImportVerified: true,
  };
}

function readMethods(requests: readonly unknown[]) {
  return requests.map((request) => isRecord(request) && typeof request.method === "string" ? request.method : undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class RecordingRunner implements RunnerAdapter {
  calls = 0;

  async runTask(options: PiRunnerRunOptions): Promise<PiRunnerResult> {
    this.calls++;
    return { taskId: options.task.id, events: [], messages: [] };
  }
}
