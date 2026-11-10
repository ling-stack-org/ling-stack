import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createLingTraceId,
  projectLingTrace,
} from "../dist/index.js";

test("runtime trace projection creates deterministic spans from durable records", () => {
  const run = {
    id: "run_1",
    status: "succeeded",
    cwd: "/tmp/project",
    taskId: "task_1",
    providerName: "test-provider",
    providerModel: "test-model",
    taskSnapshot: {},
    providerSnapshot: {},
    requestSnapshot: {},
    eventLogPath: "/tmp/project/.ling/events.jsonl",
    threadId: "thread_1",
    workUnitId: "work_unit_1",
    createdAt: "2026-06-19T00:00:00.000Z",
    startedAt: "2026-06-19T00:00:01.000Z",
    endedAt: "2026-06-19T00:00:05.000Z",
    updatedAt: "2026-06-19T00:00:05.000Z",
  };
  const result = projectLingTrace({
    workspaceId: "workspace_default",
    subjectKind: "thread",
    subjectId: "thread_1",
    title: "Investigate runtime",
    status: "succeeded",
    createdAt: "2026-06-19T00:00:00.000Z",
    updatedAt: "2026-06-19T00:00:05.000Z",
    runs: [run],
    eventsByRunId: {
      run_1: [
        {
          id: "event_1",
          runId: "run_1",
          seq: 1,
          ts: "2026-06-19T00:00:02.000Z",
          type: "tool_start",
          data: {
            toolCallId: "tool_1",
            toolName: "bash",
            args: { command: "echo secret-value" },
          },
        },
        {
          id: "event_2",
          runId: "run_1",
          seq: 2,
          ts: "2026-06-19T00:00:03.000Z",
          type: "tool_end",
          data: {
            toolCallId: "tool_1",
            toolName: "bash",
            result: "secret-value",
            isError: false,
          },
        },
      ],
    },
    artifacts: [
      {
        id: "artifact_1",
        runId: "run_1",
        type: "log",
        path: "/tmp/project/.ling/artifacts/stdout.txt",
        title: "stdout",
        contentType: "text/plain",
        sizeBytes: 12,
        createdAt: "2026-06-19T00:00:04.000Z",
      },
    ],
    executionActions: [
      {
        id: "tool:run_1:tool_1",
        workspaceId: "workspace_default",
        threadId: "thread_1",
        runId: "run_1",
        workUnitId: "work_unit_1",
        approvalId: "approval_1",
        toolCallId: "tool_1",
        actionType: "bash",
        risk: "medium",
        status: "approved",
        title: "Approve bash command",
        summary: "Do not expose raw command text.",
        targetRefs: [],
        previewArtifactIds: [],
        resultArtifactIds: ["artifact_1"],
        createdAt: "2026-06-19T00:00:01.500Z",
        resolvedAt: "2026-06-19T00:00:01.800Z",
        completedAt: "2026-06-19T00:00:01.800Z",
      },
    ],
    approvals: [
      {
        id: "approval_1",
        runId: "run_1",
        toolCallId: "tool_1",
        actionType: "bash",
        risk: "medium",
        title: "Approve bash command",
        description: "Do not expose raw command text.",
        payload: { type: "bash", cwd: "/tmp/project", command: "echo secret-value", riskFlags: [] },
        status: "approved",
        createdAt: "2026-06-19T00:00:01.500Z",
        resolvedAt: "2026-06-19T00:00:01.800Z",
        resolvedBy: "local-user",
        decisionKind: "approve_once",
      },
    ],
    transitions: [
      {
        id: "transition_1",
        workspaceId: "workspace_default",
        entityType: "run",
        entityId: "run_1",
        fromStatus: "running",
        toStatus: "succeeded",
        event: "runner_succeeded",
        actor: "runner",
        reason: "secret-value",
        createdAt: "2026-06-19T00:00:05.000Z",
      },
    ],
    runtimeEventsByWorkUnitId: {
      work_unit_1: [
        {
          id: "runtime_event_1",
          workUnitId: "work_unit_1",
          attemptId: "attempt_1",
          seq: 1,
          ts: "2026-06-19T00:00:01.250Z",
          type: "work_unit_started",
          actor: "system",
          data: { secret: "secret-value" },
        },
      ],
    },
    generatedAt: "2026-06-19T00:00:06.000Z",
  });

  assert.equal(result.trace.id, createLingTraceId("thread", "thread_1"));
  assert.equal(result.trace.status, "succeeded");
  assert.deepEqual(result.spans.map((span) => span.kind), [
    "agent_run",
    "runtime_event",
    "approval",
    "tool_call",
    "artifact",
    "state_transition",
  ]);
  assert.equal(result.spans.find((span) => span.kind === "tool_call")?.refs.toolCallId, "tool_1");
  assert.equal(result.spans.find((span) => span.kind === "artifact")?.refs.artifactId, "artifact_1");
  assert.doesNotMatch(JSON.stringify(result), /secret-value/);
});

test("runtime trace projection tolerates missing optional record groups", () => {
  const result = projectLingTrace({
    workspaceId: "workspace_default",
    subjectKind: "run",
    subjectId: "run_empty",
    runs: [],
    eventsByRunId: {},
    generatedAt: "2026-06-19T00:00:00.000Z",
  });

  assert.equal(result.trace.id, "trace_run_run_empty");
  assert.equal(result.trace.status, "succeeded");
  assert.deepEqual(result.spans, []);
});
