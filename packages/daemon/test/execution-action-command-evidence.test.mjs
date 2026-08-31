import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveExecutionActionCommandEvidence,
  executionActionStatusFromCommandEvidence,
} from "../dist/features/runs/execution-action-command-evidence.js";
import { appendExecutionActionInvalidation } from "../dist/features/runs/execution-action-invalidation.js";
import { listExecutionActions } from "../dist/features/runs/execution-actions.js";

test("active command evidence folds tool updates into a bounded redacted tail", () => {
  const start = event(1, "tool_start", {
    toolCallId: "tool-live",
    toolName: "bash",
    args: { command: "pnpm test", cwd: "/repo" },
  });
  const updates = Array.from({ length: 80 }, (_, index) => event(index + 2, "tool_update", {
    toolCallId: "tool-live",
    toolName: "bash",
    partialResult: {
      toolCallId: "tool-live",
      stream: index % 2 === 0 ? "stdout" : "stderr",
      sequence: index + 1,
      text: `\u001b[31mline-${index}-${"x".repeat(160)}\u001b[0m\n`,
      byteCount: 180,
      redacted: index === 0,
      truncated: false,
      ts: `2026-07-13T00:00:${String(index).padStart(2, "0")}.000Z`,
    },
  }));

  const evidence = deriveExecutionActionCommandEvidence({
    events: [start, ...updates],
    toolCallId: "tool-live",
    start,
  });

  assert.ok(evidence);
  assert.equal(evidence.command, "pnpm test");
  assert.equal(evidence.cwd, "/repo");
  assert.equal(evidence.latestEventSeq, 81);
  assert.equal(evidence.completedAt, undefined);
  assert.equal(evidence.exitCode, undefined);
  assert.equal(executionActionStatusFromCommandEvidence(evidence), undefined);
  assert.equal(evidence.outputTail.length <= 64, true);
  const output = evidence.outputTail.map((chunk) => chunk.text).join("");
  assert.equal(Buffer.byteLength(output, "utf8") <= 8 * 1024, true);
  assert.equal(output.split(/\r?\n/u).length <= 41, true);
  assert.doesNotMatch(output, /\u001b/u);
  assert.match(output, /line-79/u);
  assert.doesNotMatch(output, /line-0-/u);
  assert.equal(evidence.outputTruncated, true);
});

test("execution action projection reads command completion after the first event page", () => {
  const runId = "run-paged";
  const toolCallId = "tool-paged";
  const start = event(1, "tool_start", {
    toolCallId,
    toolName: "bash",
    args: { command: "pnpm test", cwd: "/repo" },
  }, runId);
  const filler = Array.from({ length: 999 }, (_, index) => event(index + 2, "assistant_text_delta", {
    text: `filler-${index}`,
  }, runId));
  const update = event(1001, "tool_update", {
    toolCallId,
    toolName: "bash",
    partialResult: {
      toolCallId,
      stream: "stdout",
      sequence: 1,
      text: "final output\n",
      byteCount: 13,
      redacted: false,
      truncated: false,
      ts: "2026-07-13T00:16:41.000Z",
    },
  }, runId);
  const end = event(1002, "tool_end", {
    toolCallId,
    toolName: "bash",
    isError: false,
    result: {
      details: {
        unifiedExec: {
          status: "succeeded",
          cwd: "/repo",
          command: { kind: "shell", command: "pnpm test", shell: "bash" },
          startedAt: start.ts,
          endedAt: "2026-07-13T00:16:42.000Z",
          durationMs: 1000,
          exitCode: 0,
          timedOut: false,
          cancelled: false,
          stdout: { byteCount: 13, lineCount: 1, preview: "final output\n", truncated: false },
          stderr: { byteCount: 0, lineCount: 0, preview: "", truncated: false },
          artifacts: [],
        },
      },
    },
  }, runId);
  const events = [start, ...filler, update, end];
  const run = {
    id: runId,
    taskId: "task-paged",
    threadId: "thread-paged",
    workUnitId: "work-unit-paged",
    teammateId: "participant-engineer",
    workflowStepId: "workflow-step-paged",
    cwd: "/repo",
    status: "succeeded",
    createdAt: start.ts,
    updatedAt: end.ts,
  };
  const store = {
    getRun: (id) => id === runId ? run : undefined,
    listRuns: () => [run],
    listApprovalRequests: () => [],
    listEvents: (id, options = {}) => id === runId
      ? events.filter((entry) => entry.seq > (options.afterSeq ?? 0)).slice(0, options.limit ?? 200)
      : [],
  };

  const actions = listExecutionActions(store, { runId, limit: 100 });

  assert.equal(actions.length, 1);
  assert.equal(actions[0].status, "succeeded");
  assert.equal(actions[0].risk, "low");
  assert.equal(actions[0].commandEvidence.latestEventSeq, 1002);
  assert.equal(actions[0].commandEvidence.exitCode, 0);
  assert.equal(actions[0].revision, 1002);
  assert.equal(actions[0].participantId, "participant-engineer");
  assert.equal(actions[0].workflowStepId, "workflow-step-paged");
  assert.deepEqual(actions[0].sourceRefs.slice(0, 6), [
    { kind: "execution_action", id: actions[0].id },
    { kind: "run", id: runId },
    { kind: "work_unit", id: "work-unit-paged" },
    { kind: "participant", id: "participant-engineer" },
    { kind: "workflow_step", id: "workflow-step-paged" },
    { kind: "tool_call", id: toolCallId },
  ]);
  assert.ok(actions[0].sourceRefs.some((ref) =>
    ref.kind === "command" && ref.id === "pnpm test" && ref.label === "pnpm test"));
  assert.ok(actions[0].sourceRefs.some((ref) => ref.kind === "task" && ref.id === "task-paged"));
  assert.deepEqual(
    actions[0].sourceRefs.filter((ref) => ref.kind === "run_event").map((ref) => ref.id),
    ["event-1", "event-1001", "event-1002"],
  );
  assert.match(actions[0].commandEvidence.outputTail.map((chunk) => chunk.text).join(""), /final output/u);
});

test("execution action carries a same-thread ConversationItem anchor when the store has one", () => {
  const runId = "run-conversation-anchor";
  const toolCallId = "tool-conversation-anchor";
  const turnId = "turn-conversation-anchor";
  const item = {
    id: "conversation-user:turn-conversation-anchor",
    threadId: "thread-conversation-anchor",
    turnId,
    kind: "user_message",
    sequence: 7,
    domainRefs: [{ type: "turn", id: turnId }],
  };
  const run = {
    id: runId,
    taskId: "task-conversation-anchor",
    threadId: item.threadId,
    workUnitId: "work-unit-conversation-anchor",
    teammateId: "participant-engineer",
    cwd: "/repo",
    status: "succeeded",
    createdAt: "2026-07-13T00:00:01.000Z",
    updatedAt: "2026-07-13T00:00:03.000Z",
  };
  const events = [
    event(1, "run_created", { attemptId: "attempt-conversation-anchor" }, runId),
    event(2, "tool_start", {
      toolCallId,
      toolName: "bash",
      args: { command: "printf anchored" },
    }, runId),
    event(3, "tool_end", {
      toolCallId,
      toolName: "bash",
      isError: false,
      result: { content: [{ type: "text", text: "anchored\n" }] },
    }, runId),
  ];
  const store = {
    getRun: (id) => id === runId ? run : undefined,
    getLingTurnForRun: (id) => id === runId ? {
      id: turnId,
      threadId: item.threadId,
      sourceItemId: item.id,
    } : undefined,
    getConversationItem: (id) => id === item.id ? item : undefined,
    listRuns: () => [run],
    listApprovalRequests: () => [],
    listEvents: (id) => id === runId ? events : [],
  };

  const actions = listExecutionActions(store, { runId, complete: true });

  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0].sourceRefs.at(-1), {
    kind: "conversation_item",
    id: item.id,
    label: "sequence:7",
  });
});

test("execution action identity keeps the tool attempt over the run fallback", () => {
  const runId = "run-attempt-lineage";
  const toolCallId = "tool-attempt-lineage";
  const events = [
    event(4, "tool_end", {
      toolCallId,
      toolName: "bash",
      attemptId: "attempt-tool",
      result: { content: [{ type: "text", text: "done\n" }] },
      isError: false,
    }, runId),
    event(1, "run_created", { attemptId: "attempt-run" }, runId),
    event(3, "tool_update", {
      toolCallId,
      toolName: "bash",
      attemptId: "attempt-stale",
      partialResult: { content: [{ type: "text", text: "stale\n" }] },
    }, runId),
    event(2, "tool_start", {
      toolCallId,
      toolName: "bash",
      args: { command: "printf done" },
    }, runId),
  ];
  const run = {
    id: runId,
    taskId: "task-attempt-lineage",
    threadId: "thread-attempt-lineage",
    workUnitId: "work-unit-attempt-lineage",
    cwd: "/repo",
    status: "succeeded",
    createdAt: events[1].ts,
    updatedAt: events[0].ts,
  };
  const store = {
    getRun: (id) => id === runId ? run : undefined,
    listRuns: () => [run],
    listApprovalRequests: () => [],
    listEvents: (id) => id === runId ? events : [],
  };

  const actions = listExecutionActions(store, { runId, limit: 100 });

  assert.equal(actions.length, 1);
  assert.equal(actions[0].id, `tool:${runId}:${toolCallId}`);
  assert.equal(actions[0].attemptId, "attempt-tool");
  assert.equal(actions[0].revision, 4);
  assert.equal(actions[0].commandEvidence.latestEventSeq, 4);
  assert.ok(actions[0].sourceRefs.some((ref) => ref.kind === "attempt" && ref.id === "attempt-tool"));
  assert.equal(actions[0].updatedAt, events[0].ts);
});

test("legacy Pi bash success normalizes exit zero and keeps one final cumulative output", () => {
  const start = event(1, "tool_start", {
    toolCallId: "tool-legacy-success",
    toolName: "bash",
    args: { command: "node continuity-v2-node.js" },
  });
  const firstUpdate = event(2, "tool_update", {
    toolCallId: "tool-legacy-success",
    toolName: "bash",
    partialResult: { content: [{ type: "text", text: "CONTINUITY" }] },
  });
  const secondUpdate = event(3, "tool_update", {
    toolCallId: "tool-legacy-success",
    toolName: "bash",
    partialResult: { content: [{ type: "text", text: "CONTINUITY_V2_NODE_OK\n" }] },
  });
  const end = event(4, "tool_end", {
    toolCallId: "tool-legacy-success",
    toolName: "bash",
    result: { content: [{ type: "text", text: "\u001b[32mCONTINUITY_V2_NODE_OK\u001b[0m\n" }] },
    isError: false,
  });

  const evidence = deriveExecutionActionCommandEvidence({
    events: [start, firstUpdate, secondUpdate, end],
    toolCallId: "tool-legacy-success",
    start,
    end,
  });

  assert.ok(evidence);
  assert.equal(evidence.outcome, "succeeded");
  assert.equal(evidence.exitCode, 0);
  assert.equal(executionActionStatusFromCommandEvidence(evidence), "succeeded");
  assert.equal(evidence.outputTail.length, 1);
  assert.equal(evidence.outputTail[0].text, "CONTINUITY_V2_NODE_OK\n");
  assert.equal(evidence.outputByteCount, Buffer.byteLength("CONTINUITY_V2_NODE_OK\n", "utf8"));
});

test("active legacy Pi bash keeps only the latest cumulative update", () => {
  const start = event(1, "tool_start", {
    toolCallId: "tool-legacy-active",
    toolName: "bash",
    args: { command: "pnpm test" },
  });
  const updates = [
    event(2, "tool_update", {
      toolCallId: "tool-legacy-active",
      toolName: "bash",
      partialResult: { content: [{ type: "text", text: "one\n" }] },
    }),
    event(3, "tool_update", {
      toolCallId: "tool-legacy-active",
      toolName: "bash",
      partialResult: { content: [{ type: "text", text: "one\ntwo\n" }] },
    }),
  ];

  const evidence = deriveExecutionActionCommandEvidence({
    events: [start, ...updates],
    toolCallId: "tool-legacy-active",
    start,
  });

  assert.ok(evidence);
  assert.equal(evidence.outcome, undefined);
  assert.equal(evidence.outputTail.length, 1);
  assert.equal(evidence.outputTail[0].text, "one\ntwo\n");
  assert.doesNotMatch(evidence.outputTail[0].text, /one\none/u);
});

test("legacy Pi failure keeps an unknown exit code", () => {
  const start = event(1, "tool_start", {
    toolCallId: "tool-legacy-failure",
    toolName: "bash",
    args: { command: "node missing.js" },
  });
  const end = event(2, "tool_end", {
    toolCallId: "tool-legacy-failure",
    toolName: "bash",
    result: { content: [{ type: "text", text: "failed\n" }] },
    isError: true,
  });

  const evidence = deriveExecutionActionCommandEvidence({
    events: [start, end],
    toolCallId: "tool-legacy-failure",
    start,
    end,
  });

  assert.ok(evidence);
  assert.equal(evidence.outcome, "failed");
  assert.equal(evidence.exitCode, undefined);
  assert.equal(executionActionStatusFromCommandEvidence(evidence), "failed");
  assert.equal(evidence.outputTail[0].text, "failed\n");
});

test("incomplete unified exec success does not borrow legacy Pi exit zero", () => {
  const start = event(1, "tool_start", {
    toolCallId: "tool-unified-incomplete",
    toolName: "bash",
    args: { command: "node app.js" },
  });
  const end = event(2, "tool_end", {
    toolCallId: "tool-unified-incomplete",
    toolName: "bash",
    isError: false,
    result: {
      content: [{ type: "text", text: "must not become legacy output\n" }],
      details: {
        unifiedExec: {
          status: "succeeded",
          cwd: "/repo",
          command: { command: "node app.js" },
          startedAt: start.ts,
          endedAt: "2026-07-13T00:00:02.000Z",
          durationMs: 1000,
          timedOut: false,
          cancelled: false,
          stdout: { byteCount: 0, lineCount: 0, preview: "", truncated: false },
          stderr: { byteCount: 0, lineCount: 0, preview: "", truncated: false },
          artifacts: [],
        },
      },
    },
  });

  const evidence = deriveExecutionActionCommandEvidence({
    events: [start, end],
    toolCallId: "tool-unified-incomplete",
    start,
    end,
  });

  assert.ok(evidence);
  assert.equal(evidence.outcome, "succeeded");
  assert.equal(evidence.exitCode, undefined);
  assert.equal(executionActionStatusFromCommandEvidence(evidence), "failed");
  assert.deepEqual(evidence.outputTail, []);
});

test("the first durable tool end fences later updates and duplicate terminal events", () => {
  const start = event(1, "tool_start", {
    toolCallId: "tool-reordered",
    toolName: "bash",
    args: { command: "printf latest" },
  });
  const staleUpdate = event(2, "tool_update", {
    toolCallId: "tool-reordered",
    toolName: "bash",
    partialResult: { content: [{ type: "text", text: "stale\n" }] },
  });
  const latestUpdate = event(4, "tool_update", {
    toolCallId: "tool-reordered",
    toolName: "bash",
    partialResult: { content: [{ type: "text", text: "latest\n" }] },
  });
  const staleEnd = event(3, "tool_end", {
    toolCallId: "tool-reordered",
    toolName: "bash",
    result: { content: [{ type: "text", text: "stale-end\n" }] },
    isError: true,
  });
  const latestEnd = event(5, "tool_end", {
    toolCallId: "tool-reordered",
    toolName: "bash",
    result: { content: [{ type: "text", text: "latest-end\n" }] },
    isError: false,
  });

  const evidence = deriveExecutionActionCommandEvidence({
    events: [latestEnd, latestUpdate, staleEnd, staleUpdate, start],
    toolCallId: "tool-reordered",
    start,
    end: staleEnd,
  });

  assert.ok(evidence);
  assert.equal(evidence.latestEventSeq, 3);
  assert.equal(evidence.outcome, "failed");
  assert.equal(evidence.exitCode, undefined);
  assert.equal(evidence.outputTail[0].text, "stale-end\n");
});

test("late lifecycle events remain diagnostics and cannot reopen a terminal action", () => {
  const start = event(1, "tool_start", {
    toolCallId: "tool-late-diagnostic",
    toolName: "bash",
    args: { command: "printf done" },
  });
  const end = event(2, "tool_end", {
    toolCallId: "tool-late-diagnostic",
    toolName: "bash",
    result: { content: [{ type: "text", text: "done\n" }] },
    isError: false,
  });
  const lateUpdate = event(3, "tool_update", {
    toolCallId: "tool-late-diagnostic",
    toolName: "bash",
    partialResult: { content: [{ type: "text", text: "must not appear\n" }] },
  });
  const lateEnd = event(4, "tool_end", {
    toolCallId: "tool-late-diagnostic",
    toolName: "bash",
    result: { content: [{ type: "text", text: "late-end\n" }] },
    isError: true,
  });
  const run = {
    id: "run-late-diagnostic",
    taskId: "task-late-diagnostic",
    threadId: "thread-late-diagnostic",
    cwd: "/repo",
    status: "succeeded",
    createdAt: start.ts,
    updatedAt: end.ts,
  };
  const store = {
    getRun: (id) => id === run.id ? run : undefined,
    listRuns: () => [run],
    listApprovalRequests: () => [],
    listEvents: (id) => id === run.id ? [start, end, lateUpdate, lateEnd] : [],
  };

  const action = listExecutionActions(store, { runId: run.id, complete: true })[0];
  assert.equal(action.status, "succeeded");
  assert.deepEqual(
    action.sourceRefs.filter((ref) => ref.kind === "run_event").map((ref) => ref.id),
    [start.id, end.id],
  );
  assert.deepEqual(
    action.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.sourceRefs[0].id]),
    [["late_event", lateUpdate.id], ["late_event", lateEnd.id]],
  );
});

test("updates persisted before the accepted start are stale, not command output", () => {
  const staleUpdate = event(1, "tool_update", {
    toolCallId: "tool-before-start",
    toolName: "bash",
    partialResult: { content: [{ type: "text", text: "stale\n" }] },
  });
  const start = event(2, "tool_start", {
    toolCallId: "tool-before-start",
    toolName: "bash",
    args: { command: "printf current" },
  });
  const evidence = deriveExecutionActionCommandEvidence({
    events: [staleUpdate, start],
    toolCallId: "tool-before-start",
    start,
  });
  assert.ok(evidence);
  assert.deepEqual(evidence.outputTail, []);
});

test("execution action invalidation publishes every accepted tool revision", () => {
  const published = [];
  const persisted = [];
  const store = {
    appendControlPlaneEvent(input, now) {
      const value = { seq: persisted.length + 1, ts: now, ...input, data: input.data ?? {} };
      persisted.push(value);
      return value;
    },
  };
  const hub = { publish: (value) => published.push(value) };
  const update = event(7, "tool_update", {
    toolCallId: "tool-live-invalidation",
    toolName: "bash",
    partialResult: { stream: "stdout", text: "live\n" },
  }, "run-live-invalidation");

  appendExecutionActionInvalidation({ store, hub, cwd: "/repo", event: update });
  appendExecutionActionInvalidation({
    store,
    hub,
    cwd: "/repo",
    event: event(8, "assistant_text_delta", { text: "not an action" }, "run-live-invalidation"),
  });

  assert.equal(persisted.length, 1);
  assert.equal(published.length, 1);
  assert.equal(published[0].domain, "runs");
  assert.equal(published[0].entityType, "execution_action");
  assert.equal(published[0].entityId, "tool:run-live-invalidation:tool-live-invalidation");
  assert.equal(published[0].action, "execution_action.revised");
  assert.deepEqual(published[0].data, {
    runId: "run-live-invalidation",
    toolCallId: "tool-live-invalidation",
    runEventType: "tool_update",
    actionRevision: 7,
  });
  assert.equal(
    published[0].idempotencyKey,
    "execution-action-revision:tool:run-live-invalidation:tool-live-invalidation:7",
  );
});

test("approval action keeps stable lineage and changes revision when resolved", () => {
  const runId = "run-approval-lineage";
  const approvalId = "approval-lineage";
  const run = {
    id: runId,
    taskId: "task-approval-lineage",
    threadId: "thread-approval-lineage",
    workUnitId: "work-unit-approval-lineage",
    teammateId: "participant-qa",
    workflowStepId: "workflow-step-approval-lineage",
    cwd: "/repo",
    status: "waiting_for_approval",
    createdAt: "2026-07-13T00:00:01.000Z",
    updatedAt: "2026-07-13T00:00:02.000Z",
  };
  const baseApproval = {
    id: approvalId,
    runId,
    taskId: run.taskId,
    workflowStepId: run.workflowStepId,
    toolCallId: "tool-approval-lineage",
    actionType: "bash",
    risk: "medium",
    title: "Approve focused check",
    description: "pnpm test --filter parser",
    payload: { type: "bash", cwd: "/repo", command: "pnpm test --filter parser", riskFlags: [] },
    createdAt: "2026-07-13T00:00:01.000Z",
    status: "pending",
  };
  const store = {
    getRun: (id) => id === runId ? run : undefined,
    listRuns: () => [run],
    listApprovalRequests: () => [baseApproval],
    listArtifacts: () => [],
    listEvents: (id) => id === runId ? [event(1, "run_created", { attemptId: "attempt-approval-lineage" }, runId)] : [],
  };

  const pending = listExecutionActions(store, { runId, complete: true });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, `approval:${approvalId}`);
  assert.equal(pending[0].status, "waiting_for_approval");
  assert.equal(pending[0].revision > 0, true);
  assert.deepEqual(pending[0].sourceRefs.slice(0, 8), [
    { kind: "execution_action", id: `approval:${approvalId}` },
    { kind: "run", id: runId },
    { kind: "work_unit", id: run.workUnitId },
    { kind: "attempt", id: "attempt-approval-lineage" },
    { kind: "participant", id: run.teammateId },
    { kind: "workflow_step", id: run.workflowStepId },
    { kind: "approval", id: approvalId },
    { kind: "tool_call", id: baseApproval.toolCallId },
  ]);
  assert.ok(pending[0].sourceRefs.some((ref) => ref.kind === "command" && ref.id === "pnpm test --filter parser"));

  const resolved = listExecutionActions({
    ...store,
    listApprovalRequests: () => [{ ...baseApproval, status: "denied", resolvedAt: "2026-07-13T00:00:03.000Z" }],
  }, { runId, complete: true });
  assert.equal(resolved[0].status, "denied");
  assert.ok(resolved[0].revision > pending[0].revision);
  assert.ok(resolved[0].sourceRefs.some((ref) => ref.kind === "approval" && ref.id === approvalId));
});

test("merged approval and tool action advances revision for every durable tool update", () => {
  const runId = "run-approval-tool-revision";
  const approvalId = "approval-tool-revision";
  const toolCallId = "tool-approval-tool-revision";
  const run = {
    id: runId,
    taskId: "task-approval-tool-revision",
    threadId: "thread-approval-tool-revision",
    cwd: "/repo",
    status: "running",
    createdAt: "2026-07-13T00:00:01.000Z",
    updatedAt: "2026-07-13T00:00:04.000Z",
  };
  const approval = {
    id: approvalId,
    runId,
    taskId: run.taskId,
    toolCallId,
    actionType: "bash",
    risk: "medium",
    title: "Approve focused check",
    description: "pnpm test",
    payload: { type: "bash", cwd: "/repo", command: "pnpm test", riskFlags: [] },
    createdAt: "2026-07-13T00:00:01.000Z",
    resolvedAt: "2026-07-13T00:00:02.000Z",
    status: "approved",
  };
  const baseEvents = [
    event(1, "run_created", { attemptId: "attempt-approval-tool-revision" }, runId),
    event(2, "tool_start", { toolCallId, toolName: "bash", args: { command: "pnpm test", cwd: "/repo" } }, runId),
  ];
  const store = {
    getRun: (id) => id === runId ? run : undefined,
    listRuns: () => [run],
    listApprovalRequests: () => [approval],
    listArtifacts: () => [],
    listEvents: () => baseEvents,
  };

  const started = listExecutionActions(store, { runId, complete: true });
  const updated = listExecutionActions({
    ...store,
    listEvents: () => [...baseEvents, event(3, "tool_update", {
      toolCallId,
      toolName: "bash",
      partialResult: {
        toolCallId,
        stream: "stdout",
        sequence: 1,
        text: "still running\n",
        byteCount: 14,
        redacted: false,
        truncated: false,
        ts: "2026-07-13T00:00:03.000Z",
      },
    }, runId)],
  }, { runId, complete: true });

  assert.equal(started.length, 1);
  assert.equal(updated.length, 1);
  assert.ok(updated[0].revision > started[0].revision);
  assert.deepEqual(
    started[0].sourceRefs.filter((ref) => ref.kind === "run_event").map((ref) => ref.id),
    ["event-2"],
  );
  assert.deepEqual(
    updated[0].sourceRefs.filter((ref) => ref.kind === "run_event").map((ref) => ref.id),
    ["event-2", "event-3"],
  );
  assert.match(updated[0].commandEvidence.outputTail.map((chunk) => chunk.text).join(""), /still running/u);
});

test("lifecycle evidence excludes events that precede the accepted tool start", () => {
  const runId = "run-lifecycle-boundary";
  const toolCallId = "tool-lifecycle-boundary";
  const events = [
    event(1, "tool_end", {
      toolCallId,
      toolName: "bash",
      isError: false,
      result: { content: [{ type: "text", text: "stale end\n" }] },
    }, runId),
    event(2, "tool_update", {
      toolCallId,
      toolName: "bash",
      partialResult: { content: [{ type: "text", text: "stale update\n" }] },
    }, runId),
    event(3, "tool_start", {
      toolCallId,
      toolName: "bash",
      args: { command: "printf accepted", cwd: "/repo" },
    }, runId),
    event(4, "tool_update", {
      toolCallId,
      toolName: "bash",
      partialResult: { content: [{ type: "text", text: "accepted output\n" }] },
    }, runId),
    event(5, "tool_end", {
      toolCallId,
      toolName: "bash",
      isError: false,
      result: { content: [{ type: "text", text: "accepted output\n" }] },
    }, runId),
  ];
  const run = {
    id: runId,
    taskId: "task-lifecycle-boundary",
    threadId: "thread-lifecycle-boundary",
    cwd: "/repo",
    status: "succeeded",
    createdAt: events[2].ts,
    updatedAt: events[4].ts,
  };
  const store = {
    getRun: (id) => id === runId ? run : undefined,
    listRuns: () => [run],
    listApprovalRequests: () => [],
    listEvents: (id) => id === runId ? events : [],
  };

  const actions = listExecutionActions(store, { runId, complete: true });

  assert.equal(actions.length, 1);
  assert.equal(actions[0].status, "succeeded");
  assert.deepEqual(
    actions[0].sourceRefs.filter((ref) => ref.kind === "run_event").map((ref) => ref.id),
    ["event-3", "event-4", "event-5"],
  );
  assert.deepEqual(
    actions[0].diagnostics?.flatMap((diagnostic) => diagnostic.sourceRefs.map((ref) => ref.id)),
    ["event-1", "event-2"],
  );
  assert.match(actions[0].commandEvidence.outputTail.map((chunk) => chunk.text).join(""), /accepted output/u);
  assert.doesNotMatch(actions[0].commandEvidence.outputTail.map((chunk) => chunk.text).join(""), /stale/u);
});

test("same-sequence lifecycle events choose a stable id and retain the loser as a conflict", () => {
  const runId = "run-same-sequence-lifecycle";
  const toolCallId = "tool-same-sequence-lifecycle";
  const startB = {
    ...event(1, "tool_start", {
      toolCallId,
      toolName: "bash",
      args: { command: "printf stable" },
    }, runId),
    id: "event-start-b",
  };
  const startA = {
    ...startB,
    id: "event-start-a",
  };
  const end = event(2, "tool_end", {
    toolCallId,
    toolName: "bash",
    isError: false,
    result: { content: [{ type: "text", text: "stable\n" }] },
  }, runId);
  const run = {
    id: runId,
    taskId: "task-same-sequence-lifecycle",
    threadId: "thread-same-sequence-lifecycle",
    cwd: "/repo",
    status: "succeeded",
    createdAt: startA.ts,
    updatedAt: end.ts,
  };
  const store = {
    getRun: (id) => id === runId ? run : undefined,
    listRuns: () => [run],
    listApprovalRequests: () => [],
    listEvents: (id) => id === runId ? [startB, end, startA] : [],
  };

  const action = listExecutionActions(store, { runId, complete: true })[0];

  assert.equal(action.status, "succeeded");
  assert.deepEqual(
    action.sourceRefs.filter((ref) => ref.kind === "run_event").map((ref) => ref.id),
    ["event-start-a", end.id],
  );
  assert.deepEqual(
    action.diagnostics?.map((diagnostic) => [diagnostic.code, diagnostic.sourceRefs[0].id]),
    [["source_conflict", "event-start-b"]],
  );
});

function event(seq, type, data, runId = "run-live") {
  return {
    id: `event-${seq}`,
    runId,
    seq,
    ts: `2026-07-13T00:00:${String(seq).padStart(2, "0")}.000Z`,
    type,
    data,
  };
}
