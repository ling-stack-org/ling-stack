import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_WORKSPACE_ID,
  createSqliteRunStore,
} from "../../core/dist/index.js";
import { createDaemonServer } from "../dist/index.js";

test("traces api projects thread evidence from sqlite run records", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-runtime-traces-"));
  const store = createSqliteRunStore(cwd);
  const daemon = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
    defaultWorkspaceCwd: cwd,
  }, {
    runner: new NoopRunner(),
    storeFactory: () => store,
  });

  try {
    await daemon.start();
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const fixture = seedTraceFixture(store, cwd);

    const list = await getJson(`${baseUrl}/traces?cwd=${encodeURIComponent(cwd)}&threadId=thread_trace_1`);
    assert.equal(list.cwd, cwd);
    assert.deepEqual(list.traces.map((trace) => trace.id), ["trace_thread_thread_trace_1"]);
    assert.equal(list.traces[0].subjectKind, "thread");
    assert.equal(list.traces[0].status, "succeeded");

    const detail = await getJson(`${baseUrl}/traces/${encodeURIComponent(list.traces[0].id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(detail.trace.id, "trace_thread_thread_trace_1");
    assert.equal(detail.spans.some((span) => span.kind === "agent_run" && span.refs.runId === "run_trace_1"), true);
    assert.equal(detail.spans.some((span) => span.kind === "tool_call" && span.refs.toolCallId === "tool_trace_1"), true);
    assert.equal(detail.spans.some((span) => span.kind === "approval" && span.refs.approvalId === fixture.approvalId), true);
    assert.equal(detail.spans.some((span) => span.kind === "artifact" && span.refs.artifactId === "artifact_trace_1"), true);
    assert.equal(detail.spans.some((span) => span.kind === "state_transition" && span.refs.stateTransitionId === fixture.transitionId), true);

    const spans = await getJson(`${baseUrl}/traces/${encodeURIComponent(list.traces[0].id)}/spans?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(spans.spans, detail.spans);
    assert.doesNotMatch(JSON.stringify(detail), /trace-api-secret/);
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("traces api can project a run trace without a thread cwd lookup", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-runtime-run-trace-"));
  const store = createSqliteRunStore(cwd);
  const daemon = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
    defaultWorkspaceCwd: cwd,
  }, {
    runner: new NoopRunner(),
    storeFactory: () => store,
  });

  try {
    await daemon.start();
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    seedTraceFixture(store, cwd);

    const detail = await getJson(`${baseUrl}/traces/trace_run_run_trace_1?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(detail.cwd, cwd);
    assert.equal(detail.trace.subjectKind, "run");
    assert.equal(detail.trace.subjectId, "run_trace_1");
    assert.equal(detail.spans.some((span) => span.refs.runId === "run_trace_1"), true);
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

function seedTraceFixture(store, cwd) {
  const thread = store.createLingThread(
    {
      id: "thread_trace_1",
      kind: "task",
      taskId: "task_trace_1",
      title: "Trace fixture",
      objective: "Project durable runtime evidence.",
      status: "succeeded",
    },
    "2026-06-19T00:00:00.000Z",
  );
  store.createRun({
    id: "run_trace_1",
    cwd,
    taskId: "task_trace_1",
    providerName: "test-provider",
    providerModel: "test-model",
    taskSnapshot: {},
    providerSnapshot: {},
    requestSnapshot: {},
    threadId: thread.id,
    workUnitId: "work_unit_trace_1",
    createdAt: "2026-06-19T00:00:01.000Z",
  });
  store.markRunStarted("run_trace_1", "2026-06-19T00:00:02.000Z");
  store.appendEvent("run_trace_1", "tool_start", {
    toolCallId: "tool_trace_1",
    toolName: "bash",
    args: { command: "echo trace-api-secret" },
  });
  store.appendEvent("run_trace_1", "tool_end", {
    toolCallId: "tool_trace_1",
    toolName: "bash",
    result: "trace-api-secret",
    isError: false,
  });
  const approval = store.createApprovalRequest(
    {
      runId: "run_trace_1",
      taskId: "task_trace_1",
      toolCallId: "tool_trace_1",
      actionType: "bash",
      risk: "medium",
      title: "Approve bash command",
      description: "Allow command execution.",
      payload: {
        type: "bash",
        cwd,
        command: "echo trace-api-secret",
        riskFlags: [],
      },
    },
    "2026-06-19T00:00:02.500Z",
  );
  store.approveApprovalRequest(
    approval.id,
    {
      reason: "approved",
      resolvedBy: "local-user",
    },
    "2026-06-19T00:00:03.000Z",
  );
  store.createArtifact({
    id: "artifact_trace_1",
    runId: "run_trace_1",
    type: "log",
    path: `${cwd}/.ling/artifacts/stdout.txt`,
    title: "stdout",
    contentType: "text/plain",
    sizeBytes: 12,
    createdAt: "2026-06-19T00:00:04.000Z",
  });
  const transition = store.recordStateTransitionEvent({
    workspaceId: DEFAULT_WORKSPACE_ID,
    entityType: "run",
    entityId: "run_trace_1",
    fromStatus: "running",
    toStatus: "succeeded",
    event: "runner_succeeded",
    actor: "runner",
    reason: "trace-api-secret",
    idempotencyKey: "transition_trace_1",
    createdAt: "2026-06-19T00:00:05.000Z",
  });
  store.markRunSucceeded("run_trace_1", "2026-06-19T00:00:05.000Z");
  store.updateLingThread(thread.id, { status: "succeeded", lastRunId: "run_trace_1" }, "2026-06-19T00:00:05.000Z");
  return {
    approvalId: approval.id,
    transitionId: transition.id,
  };
}

class NoopRunner {
  async runTask() {
    return { events: [], messages: [] };
  }
}

async function getJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  const body = text.trim() ? JSON.parse(text) : {};
  if (!response.ok) {
    assert.fail(JSON.stringify(body));
  }
  return body;
}
