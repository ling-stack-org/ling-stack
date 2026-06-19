import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { createDaemonServer } from "../dist/index.js";

test("run orchestrator injects daemon-hydrated tool schema handler only after Pi gates pass", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-runner-hydration-"));
  const runner = new ToolHydrationProbeRunner();
  const daemon = await startDaemonForTest(runner, {
    runners: {
      pi: {
        toolHydration: {
          enabled: true,
          conformancePassed: true,
        },
      },
    },
  });
  try {
    const { runId } = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_runner_hydration"));
    assert.ok(runId);
    assert.equal(runner.hydrationResponses.length, 1);
    const response = runner.hydrationResponses[0];
    assert.equal(response.ok, true);
    assert.equal(response.materialization.runId, runId);
    assert.equal(response.materialization.namespaceId, "core");
    assert.equal(response.tools.some((tool) => tool.id === "core:read"), true);
    assert.equal(runner.runs[0].runId, runId);
    assert.equal(typeof runner.runs[0].runnerAttemptId, "string");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("run orchestrator does not inject tool hydration before Pi gates pass", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-runner-hydration-disabled-"));
  const runner = new ToolHydrationProbeRunner();
  const daemon = await startDaemonForTest(runner, {
    runners: {
      pi: {
        toolHydration: {
          enabled: true,
        },
      },
    },
  });
  try {
    await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_runner_hydration_disabled"));
    assert.equal(runner.hydrationResponses.length, 0);
    assert.equal(runner.runs[0].onToolHydrationRequest, undefined);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("run orchestrator blocks platform-native sandbox binding when readiness is not verified", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-platform-native-binding-blocked-"));
  const runner = new ToolHydrationProbeRunner();
  const daemon = await startDaemonForTest(runner, {
    runners: {
      pi: {
        sandboxBinding: {
          enabled: true,
        },
      },
    },
  });
  try {
    const response = await postRunExpectError(daemon.url, runBody(cwd, "task_platform_native_blocked"));
    assert.equal(response.status, 409);
    assert.equal(response.body.error, "sandbox_not_ready");
    assert.match(response.body.message, /sandbox_backend_unverified/);
    assert.equal(runner.runs.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

class ToolHydrationProbeRunner {
  constructor() {
    this.runs = [];
    this.hydrationResponses = [];
  }

  async runTask(options) {
    this.runs.push(options);
    options.onEvent?.({
      type: "run_start",
      taskId: options.task.id,
      cwd: options.cwd,
      provider: options.provider.provider,
      model: options.provider.model,
    });
    if (options.onToolHydrationRequest) {
      const response = await options.onToolHydrationRequest({
        runId: options.runId,
        runnerAttemptId: options.runnerAttemptId,
        scope: { kind: "namespace", namespaceId: "core" },
        reason: "Need core tool schema.",
        idempotencyKey: `${options.runId}:${options.runnerAttemptId}:core`,
        task: options.task,
        cwd: options.cwd,
      });
      this.hydrationResponses.push(response);
    }
    options.onEvent?.({
      type: "run_end",
      taskId: options.task.id,
      messageCount: 1,
    });
    return {
      taskId: options.task.id,
      events: [],
      messages: [{ role: "assistant", content: "done" }],
    };
  }
}

async function startDaemonForTest(runner, config = {}) {
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, ...config }, { runner });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => daemon.stop(),
  };
}

function runBody(cwd, taskId) {
  return {
    cwd,
    task: {
      id: taskId,
      title: taskId,
      prompt: "Trigger runner hydration probe.",
    },
    provider: {
      provider: "test-provider",
      model: "test-model",
    },
    tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    thinkingLevel: "off",
  };
}

async function postRunAndCollectEvents(baseUrl, body) {
  const response = await fetch(`${baseUrl}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status !== 200) {
    assert.fail(await response.text());
  }
  const text = await response.text();
  const events = parseSseText(text);
  return {
    events,
    runId: events.find((event) => event.event === "ready")?.data.runId,
  };
}

async function postRunExpectError(baseUrl, body) {
  const response = await fetch(`${baseUrl}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.trim() ? JSON.parse(text) : {},
  };
}

function parseSseText(text) {
  return text
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map(parseSseEvent)
    .filter(Boolean);
}

function parseSseEvent(chunk) {
  const lines = chunk.split("\n");
  const eventLine = lines.find((line) => line.startsWith("event: "));
  const dataLine = lines.find((line) => line.startsWith("data: "));
  if (!eventLine || !dataLine) {
    return undefined;
  }
  return {
    event: eventLine.slice("event: ".length),
    data: JSON.parse(dataLine.slice("data: ".length)),
  };
}
