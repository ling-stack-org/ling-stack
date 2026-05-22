import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { createSqliteRunStore } from "../../core/dist/index.js";
import { createDaemonServer } from "../dist/index.js";

test("bash=allow lets the runner continue without creating an approval request", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-policy-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_bash_allow",
    toolName: "bash",
    input: { command: "echo ok" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    await patchPolicy(daemon.url, cwd, { toolDecisions: { bash: "allow" } });
    const { events, runId } = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_bash_allow"));

    assert.equal(runner.decisions.length, 1);
    assert.deepEqual(runner.decisions[0], {
      approved: true,
      reason: "Ling Stack policy allowed bash.",
    });
    assert.equal(events.some((event) => event.event === "approval_requested"), false);
    assert.deepEqual(await listApprovals(daemon.url, cwd, runId), []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("bash=deny records an immediately denied approval request", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-policy-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_bash_deny",
    toolName: "bash",
    input: { command: "echo blocked" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    await patchPolicy(daemon.url, cwd, { toolDecisions: { bash: "deny" } });
    const { events, runId } = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_bash_deny"));
    const approvals = await listApprovals(daemon.url, cwd, runId);

    assert.equal(runner.decisions.length, 1);
    assert.equal(runner.decisions[0].approved, false);
    assert.match(runner.decisions[0].reason, /policy denied bash/);
    assert.deepEqual(events.filter((event) => event.event.startsWith("approval_")).map((event) => event.event), [
      "approval_requested",
      "approval_denied",
    ]);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].status, "denied");
    assert.equal(approvals[0].actionType, "bash");
    assert.match(approvals[0].decisionReason, /policy denied bash/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("bash=ask pauses the run until the approval is resolved", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-policy-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_bash_ask",
    toolName: "bash",
    input: { command: "echo approve-me" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    await patchPolicy(daemon.url, cwd, { toolDecisions: { bash: "ask" } });
    const response = await postRunStream(daemon.url, runBody(cwd, "task_bash_ask"));
    const sse = createSseReader(response);
    const ready = await sse.nextEvent();
    assert.equal(ready.event, "ready");
    const runId = ready.data.runId;

    const requested = await waitForSseEvent(sse, "approval_requested");
    const approvalId = requested.data.data.approvalId;
    const waitingRun = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(waitingRun.status, "waiting_for_approval");

    const resolved = await postJson(`${daemon.url}/approvals/${encodeURIComponent(approvalId)}/approve?cwd=${encodeURIComponent(cwd)}`, {
      reason: "test approval",
    });
    assert.equal(resolved.approval.status, "approved");

    const remaining = await sse.collectRemaining();
    assert.equal(runner.decisions.length, 1);
    assert.deepEqual(runner.decisions[0], {
      approved: true,
      approvalId,
      reason: "test approval",
    });
    assert.equal(remaining.some((event) => event.event === "approval_approved"), true);
    assert.equal(remaining.some((event) => event.event === "result"), true);
    const finalRun = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(finalRun.status, "succeeded");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("write=deny blocks file writes through the run approval chain", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-policy-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_write_deny",
    toolName: "write",
    input: { path: "docs/out.txt", content: "blocked" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    await patchPolicy(daemon.url, cwd, { toolDecisions: { write: "deny" } });
    const { runId } = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_write_deny"));
    const approvals = await listApprovals(daemon.url, cwd, runId);

    assert.equal(runner.decisions.length, 1);
    assert.equal(runner.decisions[0].approved, false);
    assert.match(runner.decisions[0].reason, /policy denied write/);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].status, "denied");
    assert.equal(approvals[0].actionType, "write");
    assert.equal(approvals[0].payload.path, "docs/out.txt");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("write outside allowed paths is denied even when write is allowed", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-policy-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_write_outside",
    toolName: "write",
    input: { path: "src/out.txt", content: "outside" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    await patchPolicy(daemon.url, cwd, {
      toolDecisions: { write: "allow" },
      allowedWritePaths: ["docs"],
    });
    const { runId } = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_write_outside"));
    const approvals = await listApprovals(daemon.url, cwd, runId);
    const pending = await getJson(`${daemon.url}/approvals?cwd=${encodeURIComponent(cwd)}&status=pending&runId=${encodeURIComponent(runId)}`);

    assert.equal(runner.decisions.length, 1);
    assert.equal(runner.decisions[0].approved, false);
    assert.match(runner.decisions[0].reason, /outside allowed write paths/);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].status, "denied");
    assert.equal(approvals[0].payload.path, "src/out.txt");
    assert.deepEqual(pending.approvals, []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider check persists last check result", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-provider-"));
  const daemon = await startDaemonForTest(new ApprovalProbeRunner({
    toolCallId: "tool_unused",
    toolName: "bash",
    input: { command: "echo unused" },
  }));
  try {
    const created = await postJson(`${daemon.url}/providers?cwd=${encodeURIComponent(cwd)}`, {
      kind: "jimeng",
      displayName: "Jimeng Image",
      providerId: "jimeng",
      model: "jimeng-image",
      api: "media-job",
      capabilities: ["image_generate"],
      input: ["text", "image"],
      authHeader: false,
      enabled: true,
    });
    const providerId = created.provider.id;

    const checkResult = await postJson(`${daemon.url}/providers/${encodeURIComponent(providerId)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(checkResult.ok, true);
    assert.equal(checkResult.code, "static_check");

    const fetched = await getJson(`${daemon.url}/providers/${encodeURIComponent(providerId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(fetched.provider.lastCheck.ok, true);
    assert.equal(fetched.provider.lastCheck.code, "static_check");
    assert.equal(fetched.provider.lastCheck.checkedAt, checkResult.checkedAt);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider preset run requires successful daemon preflight", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-provider-run-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_preflight_ready",
    toolName: "read",
    input: { path: "README.md" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    const created = await createStaticChatProvider(daemon.url, cwd, {
      displayName: "GLM Static",
      providerId: "glm-static",
    });
    const providerId = created.provider.id;

    const blocked = await postRunExpectError(daemon.url, providerRunBody(cwd, "task_provider_unchecked", providerId));
    assert.equal(blocked.status, 400);
    assert.equal(blocked.body.error, "provider_preflight_failed");
    assert.match(blocked.body.message, /provider has not been checked/);
    assert.equal(runner.runs.length, 0);

    const checkResult = await postJson(`${daemon.url}/providers/${encodeURIComponent(providerId)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(checkResult.ok, true);

    const { runId } = await postRunAndCollectEvents(daemon.url, providerRunBody(cwd, "task_provider_ready", providerId));
    assert.ok(runId);
    assert.equal(runner.runs.length, 1);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("failed provider checks block daemon preset runs unless skipped", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-provider-run-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_preflight_failed",
    toolName: "read",
    input: { path: "README.md" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    const created = await createStaticChatProvider(daemon.url, cwd, {
      kind: "openai-compatible",
      displayName: "Broken Relay",
      providerId: "broken-relay",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:9/v1",
    });
    const providerId = created.provider.id;
    const checkResult = await postJson(`${daemon.url}/providers/${encodeURIComponent(providerId)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(checkResult.ok, false);

    const blocked = await postRunExpectError(daemon.url, providerRunBody(cwd, "task_provider_failed", providerId));
    assert.equal(blocked.status, 400);
    assert.equal(blocked.body.error, "provider_preflight_failed");
    assert.match(blocked.body.message, /provider check failed/);
    assert.equal(runner.runs.length, 0);

    const { runId } = await postRunAndCollectEvents(
      daemon.url,
      providerRunBody(cwd, "task_provider_skip_preflight", providerId, { skipProviderPreflight: true }),
    );
    assert.ok(runId);
    assert.equal(runner.runs.length, 1);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("artifact APIs list metadata and serve content from the artifacts root", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-artifacts-"));
  const runner = new ApprovalProbeRunner({
    toolCallId: "tool_artifact_read",
    toolName: "read",
    input: { path: "README.md" },
  });
  const daemon = await startDaemonForTest(runner);
  try {
    const { runId } = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_artifact_api"));
    assert.ok(runId);

    const store = createSqliteRunStore(cwd);
    try {
      const artifactDir = resolve(store.paths.artifactsDir, runId);
      await mkdir(artifactDir, { recursive: true });
      await writeFile(resolve(artifactDir, "evidence.md"), "# Evidence\n\nRun artifact content.\n", "utf8");
      store.createArtifact({
        id: "artifact_api_markdown",
        runId,
        type: "markdown",
        path: `${runId}/evidence.md`,
        title: "Evidence Markdown",
        contentType: "text/markdown; charset=utf-8",
        sizeBytes: 33,
        createdAt: "2026-05-22T00:00:00.000Z",
      });
      store.createArtifact({
        id: "artifact_api_outside",
        runId,
        type: "log",
        path: resolve(cwd, "outside.log"),
        title: "Outside log",
        createdAt: "2026-05-22T00:00:01.000Z",
      });
    } finally {
      store.close();
    }

    const listed = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}/artifacts?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.runId, runId);
    assert.equal(listed.artifacts.length, 2);
    assert.equal(listed.artifacts[0].id, "artifact_api_markdown");
    assert.equal(listed.artifacts[0].title, "Evidence Markdown");

    const metadata = await getJson(`${daemon.url}/artifacts/artifact_api_markdown?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(metadata.artifact.runId, runId);
    assert.equal(metadata.artifact.type, "markdown");

    const content = await fetch(`${daemon.url}/artifacts/artifact_api_markdown/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(content.status, 200);
    assert.equal(content.headers.get("content-type"), "text/markdown; charset=utf-8");
    assert.equal(await content.text(), "# Evidence\n\nRun artifact content.\n");

    const outside = await fetch(`${daemon.url}/artifacts/artifact_api_outside/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(outside.status, 403);
    assert.equal((await outside.json()).error, "artifact_outside_root");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

class ApprovalProbeRunner {
  constructor(request) {
    this.request = request;
    this.decisions = [];
    this.runs = [];
  }

  async runTask(options) {
    this.runs.push({
      cwd: options.cwd,
      provider: options.provider.provider,
      model: options.provider.model,
      taskId: options.task.id,
    });
    options.onEvent?.({
      type: "run_start",
      taskId: options.task.id,
      cwd: options.cwd,
      provider: options.provider.provider,
      model: options.provider.model,
    });

    const decision = await options.onApprovalRequired?.({
      ...this.request,
      task: options.task,
      cwd: options.cwd,
    });
    if (decision) {
      this.decisions.push(decision);
      options.onEvent?.({
        type: "tool_end",
        toolCallId: this.request.toolCallId,
        toolName: this.request.toolName,
        result: { approved: decision.approved, reason: decision.reason },
        isError: !decision.approved,
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
      prompt: "Trigger approval probe.",
    },
    provider: {
      provider: "test-provider",
      model: "test-model",
    },
    tools: ["bash", "write"],
    thinkingLevel: "off",
  };
}

function providerRunBody(cwd, taskId, providerPresetId, overrides = {}) {
  return {
    cwd,
    task: {
      id: taskId,
      title: taskId,
      prompt: "Trigger provider preset run.",
    },
    providerPresetId,
    tools: ["read"],
    thinkingLevel: "off",
    ...overrides,
  };
}

async function createStaticChatProvider(baseUrl, cwd, overrides = {}) {
  return await postJson(`${baseUrl}/providers?cwd=${encodeURIComponent(cwd)}`, {
    kind: "glm",
    displayName: "Static Chat",
    providerId: "static-chat",
    model: "static-model",
    api: "google-generative-ai",
    capabilities: ["chat"],
    input: ["text"],
    authHeader: false,
    enabled: true,
    ...overrides,
  });
}

async function patchPolicy(baseUrl, cwd, body) {
  return await patchJson(`${baseUrl}/approval-policy?cwd=${encodeURIComponent(cwd)}`, body);
}

async function listApprovals(baseUrl, cwd, runId) {
  const response = await getJson(`${baseUrl}/approvals?cwd=${encodeURIComponent(cwd)}&runId=${encodeURIComponent(runId)}`);
  return response.approvals;
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

async function postRunExpectError(baseUrl, body) {
  const response = await fetch(`${baseUrl}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.notEqual(response.status, 200, text);
  return {
    status: response.status,
    body: text.trim() ? JSON.parse(text) : {},
  };
}

async function getJson(url) {
  const response = await fetch(url);
  return await readJsonResponse(response);
}

async function patchJson(url, body) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await readJsonResponse(response);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await readJsonResponse(response);
}

async function readJsonResponse(response) {
  const text = await response.text();
  assert.ok(response.ok, text);
  return text.trim() ? JSON.parse(text) : {};
}

function createSseReader(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  return {
    async nextEvent() {
      for (;;) {
        const block = takeNextSseBlock();
        if (block !== undefined) {
          const event = parseSseBlock(block);
          if (event) {
            return event;
          }
          continue;
        }

        const { done, value } = await withTimeout(reader.read(), 5_000, "Timed out waiting for SSE event.");
        if (done) {
          buffer += decoder.decode();
          const finalBlock = buffer.trim() ? buffer : undefined;
          buffer = "";
          return finalBlock ? parseSseBlock(finalBlock) : undefined;
        }
        buffer += decoder.decode(value, { stream: true });
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
  };

  function takeNextSseBlock() {
    const match = /\r?\n\r?\n/.exec(buffer);
    if (!match) {
      return undefined;
    }
    const block = buffer.slice(0, match.index);
    buffer = buffer.slice(match.index + match[0].length);
    return block;
  }
}

async function waitForSseEvent(reader, eventName) {
  for (;;) {
    const event = await reader.nextEvent();
    assert.ok(event, `SSE stream ended before ${eventName}`);
    if (event.event === eventName) {
      return event;
    }
  }
}

function parseSseText(text) {
  return text
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map(parseSseBlock)
    .filter(Boolean);
}

function parseSseBlock(block) {
  let event = "message";
  const dataLines = [];
  for (const rawLine of block.split(/\r?\n/)) {
    if (rawLine.startsWith("event:")) {
      event = rawLine.slice("event:".length).trim();
      continue;
    }
    if (rawLine.startsWith("data:")) {
      dataLines.push(rawLine.slice("data:".length).trimStart());
    }
  }
  if (dataLines.length === 0) {
    return undefined;
  }
  return {
    event,
    data: JSON.parse(dataLines.join("\n")),
  };
}

function withTimeout(promise, timeoutMs, message) {
  let timeout;
  return Promise.race([
    promise.finally(() => {
      clearTimeout(timeout);
    }),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]);
}
