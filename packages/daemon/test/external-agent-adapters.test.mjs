import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createDefaultRunnerRegistry } from "../dist/index.js";
import { startFakeAcpServer } from "../dist/runtime/acp/fake-server.js";
import { createCodexAppServerAdapter } from "../dist/runtime/adapters/codex-app-server.js";
import { startFakeCodexAppServer } from "../dist/runtime/adapters/fake-codex-app-server.js";
import { createOpenClawAcpAdapter } from "../dist/runtime/adapters/openclaw-acp.js";

test("openclaw-acp registry selection executes fake ACP through normalized events", async () => {
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
    const registry = createDefaultRunnerRegistry(new RecordingRunner(), {
      runners: {
        openclawAcp: {
          enabled: true,
          endpoint: acp.endpoint,
          readinessPassed: true,
          conformancePassed: true,
        },
      },
    });
    const resolution = registry.resolve({ requestedRunnerId: "openclaw-acp", explicitFallbackPolicy: "disabled" });
    const events = [];
    const result = await resolution.runner.adapter.runTask({
      ...baseRunOptions(cwd),
      runtimePaths: { artifactsDir: artifactRoot },
      onEvent: (event) => events.push(event),
    });

    assert.equal(resolution.effectiveRunnerId, "openclaw-acp");
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
    assert.ok(artifactEvent);
    assert.equal(artifactEvent.result.path.startsWith(artifactRoot), true);
    const artifactContent = await readFile(artifactEvent.result.path, "utf8");
    assert.equal(artifactContent.includes("sk-test-secret"), false);
    assert.deepEqual(readMethods(acp.requests), ["initialize", "session/run"]);
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
    const events = [];
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
    const events = [];
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
    const events = [];
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

function baseRunOptions(cwd) {
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

function readMethods(requests) {
  return requests.map((request) => isRecord(request) && typeof request.method === "string" ? request.method : undefined);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class RecordingRunner {
  async runTask(options) {
    return { taskId: options.task.id, events: [], messages: [] };
  }
}
