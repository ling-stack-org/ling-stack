import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { createDaemonServer } from "../dist/index.js";
import { prepareChannelCreateBody } from "./conversation-model-test-fixture.mjs";
import { ensureGitRepoForChannelPost } from "./git-test-helpers.mjs";

test("runtime permission requests resolve through durable approvals and return continuation grants", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-runtime-permission-"));
  const runner = new PermissionProbeRunner({
    toolCallId: "tool_permission_write",
    requestKind: "core_tool",
    reason: "Need write to complete the requested change.",
    requestedScope: { kind: "core_tool", tools: ["write"] },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    const response = await postRunStream(daemon.url, {
      ...runBody(cwd, "task_permission_write"),
      tools: ["read", "grep", "find", "ls"],
      runtimeToolFeatures: { requestPermissions: true },
    });
    const sse = createSseReader(response);
    const ready = await sse.nextEvent();
    assert.equal(ready.event, "ready");
    const requested = await sse.nextMatching("approval_requested");
    const approvalId = requested.data.data.approvalId;
    assert.equal(requested.data.data.risk, "high");
    assert.match(requested.data.data.title, /Risk review required/);
    assert.match(requested.data.data.description, /Runtime permission expansion requires risk review/);

    const approval = await postJson(`${daemon.url}/approvals/${encodeURIComponent(approvalId)}/approve?cwd=${encodeURIComponent(cwd)}`, {
      reason: "grant write through continuation",
    });
    assert.equal(approval.approval.status, "approved");

    await waitFor(() => runner.decisions.length === 1);
    await sse.cancel();
    assert.equal(runner.decisions.length, 1);
    assert.equal(runner.decisions[0].approved, true);
    assert.equal(runner.decisions[0].approvalId, approvalId);
    assert.equal(runner.decisions[0].grant.id, `runtime_permission_grant:${approvalId}`);
    assert.equal(runner.decisions[0].grant.mode, "continuation");

    const approvals = await getJson(`${daemon.url}/approvals?cwd=${encodeURIComponent(cwd)}&runId=${encodeURIComponent(ready.data.runId)}`);
    assert.equal(approvals.approvals.length, 1);
    assert.equal(approvals.approvals[0].actionType, "runtime_permission_request");
    assert.equal(approvals.approvals[0].risk, "high");
    assert.equal(approvals.approvals[0].payload.type, "runtime_permission_request");
    assert.equal(approvals.approvals[0].payload.currentScope.runnerId, "pi");
    assert.deepEqual(approvals.approvals[0].payload.proposedContinuation.toolDelta, ["write"]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runtime permission requests cannot override workspace deny", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-runtime-permission-deny-"));
  const runner = new PermissionProbeRunner({
    toolCallId: "tool_permission_bash",
    requestKind: "core_tool",
    reason: "Need bash for a local diagnostic.",
    requestedScope: { kind: "core_tool", tools: ["bash"] },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    await patchJson(`${daemon.url}/approval-policy?cwd=${encodeURIComponent(cwd)}`, {
      toolDecisions: { bash: "deny" },
      allowedWritePaths: ["."],
    });
    const { events, runId } = await postRunAndCollectEvents(daemon.url, {
      ...runBody(cwd, "task_permission_bash"),
      runtimeToolFeatures: { requestPermissions: true },
    });

    assert.equal(runner.decisions.length, 1);
    assert.equal(runner.decisions[0].approved, false);
    assert.match(runner.decisions[0].reason, /Workspace policy denied core tool bash/);
    assert.equal(events.some((event) => event.event === "approval_denied"), true);

    const approvals = await getJson(`${daemon.url}/approvals?cwd=${encodeURIComponent(cwd)}&runId=${encodeURIComponent(runId)}`);
    assert.equal(approvals.approvals.length, 1);
    assert.equal(approvals.approvals[0].status, "denied");
    assert.equal(approvals.approvals[0].actionType, "runtime_permission_request");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("plan mode denies runtime permission expansion to mutation tools", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-runtime-permission-plan-mode-"));
  const runner = new PermissionProbeRunner({
    toolCallId: "tool_permission_plan_write",
    requestKind: "core_tool",
    reason: "Need write to implement the accepted change.",
    requestedScope: { kind: "core_tool", tools: ["write"] },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    const { thread } = await createPlanModeThread(daemon.url, cwd);
    const { events, runId } = await postRunAndCollectEvents(daemon.url, {
      ...runBody(cwd, "task_permission_plan_write"),
      threadId: thread.id,
      tools: ["read", "grep", "find", "ls"],
      runtimeToolFeatures: { requestPermissions: true },
    });

    assert.equal(runner.decisions.length, 1);
    assert.equal(runner.decisions[0].approved, false);
    assert.match(runner.decisions[0].reason, /Plan Mode denied expanding runtime permissions/);
    assert.equal(events.some((event) => event.event === "approval_denied"), true);

    const approvals = await getJson(`${daemon.url}/approvals?cwd=${encodeURIComponent(cwd)}&runId=${encodeURIComponent(runId)}`);
    assert.equal(approvals.approvals.length, 1);
    assert.equal(approvals.approvals[0].status, "denied");
    assert.equal(approvals.approvals[0].actionType, "runtime_permission_request");
    assert.deepEqual(approvals.approvals[0].payload.requestedScope.tools, ["write"]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

class PermissionProbeRunner {
  constructor(request) {
    this.request = request;
    this.decisions = [];
  }

  async runTask(options) {
    options.onEvent?.({
      type: "run_start",
      taskId: options.task.id,
      cwd: options.cwd,
      provider: options.provider.provider,
      model: options.provider.model,
    });
    const decision = await options.onPermissionRequired?.({
      ...this.request,
      task: options.task,
      cwd: options.cwd,
    });
    if (decision) {
      this.decisions.push(decision);
      options.onEvent?.({
        type: "tool_end",
        toolCallId: this.request.toolCallId,
        toolName: "request_permission",
        result: {
          approved: decision.approved,
          reason: decision.reason,
          grant: decision.grant,
        },
        isError: false,
      });
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

async function startDaemonForTest(runner) {
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0 }, { runner });
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
      prompt: "Trigger runtime permission probe.",
    },
    provider: {
      provider: "test-provider",
      model: "test-model",
    },
    tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    thinkingLevel: "off",
  };
}

async function postRunStream(baseUrl, body) {
  const response = await fetch(`${baseUrl}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status !== 200) {
    assert.fail(await response.text());
  }
  assert.ok(response.body);
  return response;
}

async function postRunAndCollectEvents(baseUrl, body) {
  const response = await postRunStream(baseUrl, body);
  const text = await response.text();
  const events = parseSseText(text);
  return {
    events,
    runId: events.find((event) => event.event === "ready")?.data.runId,
  };
}

async function getJson(url) {
  const response = await fetch(url);
  const body = await response.json();
  if (response.status < 200 || response.status >= 300) {
    assert.fail(JSON.stringify(body));
  }
  return body;
}

async function postJson(url, body) {
  const preparedBody = await prepareChannelCreateBody(url, body);
  await ensureGitRepoForChannelPost(url, preparedBody);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(preparedBody),
  });
  const json = await response.json();
  if (response.status < 200 || response.status >= 300) {
    assert.fail(JSON.stringify(json));
  }
  return json;
}

async function createPlanModeThread(baseUrl, cwd) {
  const channel = await postJson(`${baseUrl}/channels?cwd=${encodeURIComponent(cwd)}`, {
    name: "Plan Mode Permission Test",
    boundPath: cwd,
  });
  const created = await postJson(`${baseUrl}/threads?cwd=${encodeURIComponent(cwd)}`, {
    kind: "channel_discussion",
    channelId: channel.channel.id,
  });
  await patchJson(`${baseUrl}/threads/${encodeURIComponent(created.thread.id)}/mode?cwd=${encodeURIComponent(cwd)}`, {
    mode: "plan",
  });
  return { channel: channel.channel, thread: created.thread };
}

async function patchJson(url, body) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  if (response.status < 200 || response.status >= 300) {
    assert.fail(JSON.stringify(json));
  }
  return json;
}

function createSseReader(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  return {
    async nextEvent() {
      for (;;) {
        const splitAt = buffer.indexOf("\n\n");
        if (splitAt >= 0) {
          const raw = buffer.slice(0, splitAt);
          buffer = buffer.slice(splitAt + 2);
          const parsed = parseSseEvent(raw);
          if (parsed) {
            return parsed;
          }
          continue;
        }
        if (done) {
          return undefined;
        }
        const chunk = await reader.read();
        done = chunk.done;
        if (chunk.value) {
          buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        }
      }
    },
    async nextMatching(eventName) {
      for (;;) {
        const event = await this.nextEvent();
        if (!event) {
          assert.fail(`SSE event not found: ${eventName}`);
        }
        if (event.event === eventName) {
          return event;
        }
      }
    },
    async collectRemaining() {
      const events = [];
      for (;;) {
        const event = await this.nextEvent();
        if (!event) {
          return events;
        }
        events.push(event);
      }
    },
    async cancel() {
      await reader.cancel();
    },
  };
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("Timed out waiting for condition.");
}

function parseSseText(text) {
  return text
    .split("\n\n")
    .map(parseSseEvent)
    .filter(Boolean);
}

function parseSseEvent(raw) {
  const lines = raw.split("\n").filter(Boolean);
  const event = lines.find((line) => line.startsWith("event: "))?.slice("event: ".length);
  const data = lines
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length))
    .join("\n");
  if (!event) {
    return undefined;
  }
  return { event, data: data ? JSON.parse(data) : undefined };
}
