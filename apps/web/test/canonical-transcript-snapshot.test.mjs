import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteRunStore } from "@ling-stack/core";
import { batchCanonicalTranscriptItems } from "@ling-stack/conversation-ui-core";
import { projectConversationDetailTimeline, resolveConversationContextSnapshots } from "../src/domains/conversations/canonical-transcript-snapshot.ts";
import { mergeConversationDetailSnapshots } from "../src/domains/conversations/conversation-detail-merge.ts";

test("compaction completion survives stale detail replay and follows supersession tombstones", () => {
  const detail = detailFixture();
  const assistant = detail.conversationItems.find(row => row.kind === "assistant_message");
  assistant.domainRefs = [{ type: "run", id: "run-1" }];
  assistant.turnId = "turn-1";
  const record = { id: "compact", revision: 20, workspaceId: "workspace-1", threadId: "thread-1", turnId: "turn-1",
    runId: "run-1", attemptId: "attempt-1", participantId: "ling", anchorItemId: assistant.id,
    eventId: "event-10", eventSequence: 10, status: "running", reason: "threshold", summary: "",
    sourceRefs: [{ kind: "conversation_item", id: assistant.id }, { kind: "run", id: "run-1" },
      { kind: "attempt", id: "attempt-1" }, { kind: "run_event", id: "event-10" }] };
  detail.contextCompactions = [record];
  const settled = { ...detail, contextCompactions: [{ ...record, status: "succeeded", revision: 24 }] };
  const replay = mergeConversationDetailSnapshots(mergeConversationDetailSnapshots(detail, settled), detail);
  assert.equal(replay.contextCompactions[0].status, "succeeded");
  assert.equal(projectConversationDetailTimeline(replay).items.find(row => row.kind === "contextCompaction").status, "succeeded");
  const replaced = mergeConversationDetailSnapshots(replay, { ...settled,
    supersessionTombstones: { turnIds: ["turn-1"], runIds: ["run-1"], responseMessageIds: [] } });
  assert.deepEqual(replaced.contextCompactions, []);
});

test("all conversation detail surfaces preserve report reference privacy", () => {
  for (const kind of ["conversation", "teammate_private", "channel_discussion"]) {
    const detail = detailFixture({ kind });
    const report = {
      id: "privacy-report", workspaceId: "workspace-1", threadId: "thread-1", turnId: "turn-1",
      generation: 1, resultItemId: "privacy-result", status: "committed", language: "en-US",
      source: { kind: "run", id: "run-1" }, evidenceFingerprint: "privacy-fp",
      outcome: { status: "succeeded", title: "Safe title", summary: "Safe summary", corrections: [], sourceRefs: [] },
      changes: [], verification: [], participants: [], artifacts: [], risks: [],
      references: [
        { kind: "file", id: "safe-file", label: "safe-file", visibility: "conversation", sensitivity: "private" },
        { kind: "file", id: "PRIVACY_SENTINEL", label: "PRIVACY_SENTINEL", visibility: "conversation", sensitivity: "secret_adjacent" },
      ],
    };
    detail.terminalReports = [report];
    detail.conversationItems.push({ ...item("privacy-result", 4, "terminal_report", {
      reportId: report.id, generation: 1, sourceKind: "run", sourceId: "run-1",
      evidenceFingerprint: report.evidenceFingerprint, outcomeStatus: "succeeded",
    }), turnId: "turn-1" });
    const result = projectConversationDetailTimeline(detail).items.find((entry) => entry.kind === "terminalReport");
    assert.ok(result);
    assert.doesNotMatch(JSON.stringify(result.references), /PRIVACY_SENTINEL/u);
    assert.equal(result.references.find((ref) => ref.id === "safe-file")?.sensitivity, "private");
  }
});

test("detail adapter feeds the canonical projector from full Continuity history", () => {
  const detail = detailFixture({ kind: "conversation" });
  const projection = projectConversationDetailTimeline(detail);
  assert.equal(projection.items[0].kind, "userMessage");
  assert.equal(projection.items[1].kind, "commandExecution");
  assert.equal(projection.items[2].kind, "agentMessage");
  assert.equal(projection.items[1].runId, "run-1");
  assert.equal(projection.items[1].turnId, "turn-1");
  assert.equal(projection.items[1].attemptNumber, 1);
  assert.equal(projection.items[1].turnRunRole, "primary");
  assert.equal(projection.items[1].sourceRefs.some((ref) => ref.kind === "conversation_item" && ref.id === "tool-1"), true);
});

test("all conversation detail surfaces exclude internal provenance but diagnose visible unanchored artifacts", () => {
  for (const kind of ["conversation", "teammate_direct", "channel_discussion"]) {
    const detail = detailFixture({ kind });
    detail.artifacts = [
      { id: "internal-patch", runId: "run-1", type: "json", path: ".ling-stack/provenance/run-1/forward-plan.json", title: "Workspace forward patch plan", createdAt: detail.thread.createdAt },
      { id: "internal-automation", runId: "run-1", type: "markdown", path: "automation-context/run-1-automation-1.md", title: "Automation context", createdAt: detail.thread.createdAt },
      { id: "internal-import", runId: "run-1", type: "markdown", path: "external-work/work-1/rendered-prompt.md", title: "Rendered workflow prompt", createdAt: detail.thread.createdAt },
      { id: "visible-unanchored", runId: "run-1", type: "file", path: "reports/result.txt", title: "Result", createdAt: detail.thread.createdAt },
    ];
    const projection = projectConversationDetailTimeline(detail);
    for (const id of ["internal-patch", "internal-automation", "internal-import"]) {
      assert.equal(projection.diagnostics.some((diagnostic) => diagnostic.sourceRefs.some((ref) => ref.id === id)), false, `${kind}:${id}`);
    }
    assert.equal(projection.diagnostics.some((diagnostic) => diagnostic.code === "missing_anchor" && diagnostic.sourceRefs.some((ref) => ref.id === "visible-unanchored")), true, kind);
  }
});

test("run-scoped edit diff remains available only through its owning file action", () => {
  for (const kind of ["conversation", "teammate_direct", "channel_discussion"]) {
    const detail = detailFixture({ kind });
    detail.executionActions = [actionFixture("edit-1", "tool-1", {
      actionType: "file_edit", title: "Edit todo.py", commandEvidence: undefined,
      targetRefs: [{ type: "file", path: "todo.py", label: "todo.py" }],
      resultArtifactIds: ["owned-diff"],
    })];
    detail.artifacts = [
      { id: "owned-diff", runId: "run-1", type: "diff", path: "run-1/008-generated-edit-diff-todo.py.diff", title: "Generated edit diff: todo.py", contentType: "text/x-diff", createdAt: detail.thread.createdAt },
      { id: "unowned-diff", runId: "run-1", type: "diff", path: "run-1/009-unowned.diff", title: "Unowned diff", contentType: "text/x-diff", createdAt: detail.thread.createdAt },
    ];
    const projection = projectConversationDetailTimeline(detail);
    const file = projection.items.find((entry) => entry.kind === "fileChange");
    assert.equal(file?.changePreview?.artifactId, "owned-diff", kind);
    assert.equal(file?.sourceRefs.some((ref) => ref.kind === "artifact" && ref.id === "owned-diff" && ref.hostTarget === "open_diff"), true, kind);
    assert.equal(JSON.stringify(projection).includes("unowned-diff"), false, kind);
  }
});

test("detail adapter assigns the local Ling participant when a normal action omits ownership", () => {
  const detail = detailFixture({ kind: "conversation" });
  const action = detail.executionActions[0];
  if (!action) throw new Error("Fixture must include an execution action.");
  delete action.participantId;

  const projection = projectConversationDetailTimeline(detail);
  const command = projection.items.find((entry) => entry.kind === "commandExecution");
  assert.equal(command?.participantId, "ling");
  assert.equal(projection.diagnostics.some((entry) => entry.code === "missing_lineage"), false);
});

test("detail adapter preserves bounded tool results and their event sequence without inventing output", () => {
  for (const kind of ["conversation", "channel_discussion", "teammate_private"]) {
    const detail = detailFixture({ kind });
    const action = detail.executionActions[0];
    Object.assign(action, {
      actionType: "read", title: "read", summary: "src/todo.test.mjs", status: "failed",
      sourceEventSequence: 49,
      targetRefs: [{ type: "file", id: "src/todo.test.mjs", path: "src/todo.test.mjs" }],
      toolEvidence: {
        toolName: "read", inputSummary: "src/todo.test.mjs · offset 1 · limit 400",
        outputText: "ENOENT: no such file or directory\n  src/todo.test.mjs",
        outputTruncated: true, latestEventSeq: 50,
      },
    });
    const result = projectConversationDetailTimeline(detail).items.find((entry) => entry.kind === "exploration");
    assert.equal(result?.resultSummary, action.toolEvidence.outputText);
    assert.equal(result?.inputSummary, action.toolEvidence.inputSummary);
    assert.equal(result?.outputTruncated, true);
    assert.equal(result?.sourceEventSequence, 49);
    assert.equal(result?.targets[0]?.path, "src/todo.test.mjs");

    delete action.toolEvidence;
    const noResult = projectConversationDetailTimeline(detail).items.find((entry) => entry.kind === "exploration");
    assert.equal(noResult?.resultSummary, undefined, `${kind} must not promote input summary to a result`);
  }
});

test("detail adapter supplies immutable context segments to display batching", () => {
  const detail = detailFixture({ kind: "conversation" });
  detail.conversationItems = [
    item("user-1", 1, "user_message", { body: "Inspect", format: "plain_text" }),
    ...[2, 3, 4, 5, 6].map((sequence) => item(`tool-${sequence}`, sequence, "tool_call", { toolCallId: `call-${sequence}`, toolName: "read" })),
  ];
  detail.executionActions = [2, 3, 4, 5, 6].map((sequence) => actionFixture(`read-${sequence}`, `tool-${sequence}`, {
    actionType: "read",
    toolCallId: `call-${sequence}`,
    sourceRefs: [{ kind: "conversation_item", id: `tool-${sequence}` }],
    targetRefs: [{ type: "file", id: `src/file-${sequence}.ts`, path: `src/file-${sequence}.ts` }],
  }));
  detail.contextSnapshots = [
    { id: "snapshot-a", threadId: detail.thread.id, segmentId: "segment-a", projectionVersion: "v1", throughItemSequence: 4, summaryIds: [], sourceRefs: [2, 3, 4].map((sequence) => ({ type: "conversation_item", id: `tool-${sequence}` })), policyVersion: "v1", createdAt: "2026-08-29T00:00:01.000Z" },
    { id: "snapshot-b", threadId: detail.thread.id, segmentId: "segment-b", projectionVersion: "v1", throughItemSequence: 6, summaryIds: [], sourceRefs: [5, 6].map((sequence) => ({ type: "conversation_item", id: `tool-${sequence}` })), policyVersion: "v1", createdAt: "2026-08-29T00:00:02.000Z" },
  ];
  const projection = projectConversationDetailTimeline(detail);
  assert.equal(projection.contextSegmentIdByItemId?.get("tool-2"), "segment-a");
  assert.equal(projection.contextSegmentIdByItemId?.get("tool-5"), "segment-b");
  const display = batchCanonicalTranscriptItems(projection.items, {
    contextSegmentIdByItemId: projection.contextSegmentIdByItemId ?? new Map(),
  });
  assert.deepEqual(display.filter((entry) => entry.kind === "explorationBatch").map((entry) => entry.childActionIds), [["read-2", "read-3", "read-4"]]);
  assert.deepEqual(display.filter((entry) => entry.kind === "exploration").map((entry) => entry.actionId), ["read-5", "read-6"]);
});

test("normal Run reads anchored to the accepted user item batch without inventing tool items", () => {
  const detail = detailFixture();
  detail.conversationItems = [{ ...item("user-1", 1, "user_message", { body: "Inspect", format: "plain_text" }), turnId: "turn-1" }];
  detail.executionActions = [6, 13, 20].map((seq, index) => actionFixture(`read-${index}`, "user-1", {
    actionType: "read", toolCallId: `read-call-${index}`, sourceEventSequence: seq,
    targetRefs: [{ type: "file", id: `file-${index}.md`, path: `file-${index}.md` }],
  }));
  detail.contextSnapshots = [{
    id: "prepared_input:execution:user-1", threadId: detail.thread.id, segmentId: "accepted-segment",
    projectionVersion: "v1", throughItemSequence: 1, summaryIds: [],
    sourceRefs: [{ type: "thread", id: detail.thread.id }, { type: "turn", id: "turn-1" }, { type: "conversation_item", id: "user-1" }],
    policyVersion: "v1", createdAt: detail.thread.createdAt,
  }];
  const projection = projectConversationDetailTimeline(detail);
  const display = batchCanonicalTranscriptItems(projection.items, { contextSegmentIdByItemId: projection.contextSegmentIdByItemId });
  assert.deepEqual(display.find(row => row.kind === "explorationBatch")?.childActionIds, ["read-0", "read-1", "read-2"]);
  assert.equal(projection.items.filter(row => row.kind === "exploration").length, 3, "atomic facts remain intact");
  detail.contextSnapshots = [];
  const missing = projectConversationDetailTimeline(detail);
  assert.equal(batchCanonicalTranscriptItems(missing.items, { contextSegmentIdByItemId: missing.contextSegmentIdByItemId })
    .some(row => row.kind === "explorationBatch"), false, "missing metadata is not inferred from Run identity");
});

test("real frozen private input anchors read action DTOs in the shared reversible batch projection", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-private-batch-test-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const now = "2026-09-30T07:00:00.000Z";
  const teammateId = "teammate_builtin_engineer";
  const thread = store.createLingThread({ kind: "teammate_direct", teammateId, title: "Private", objective: "Read" }, now);
  const accepted = store.appendTeammateDirectUserTurnWithInputSnapshot({ threadId: thread.id, teammateId,
    itemId: "private-source", title: "Read", userInstruction: "Read three files", idempotencyKey: "private-read",
    payload: { body: "Read three files", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
    executionInput: { prompt: "Frozen private history", systemPrompt: "Private owner only" } }, now);
  const run = store.createRun({ id: "private-run", cwd, taskId: accepted.item.id, threadId: thread.id,
    turnId: accepted.turnId, teammateId, providerName: "test", providerModel: "test", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  const { projection: p } = accepted.inputSnapshot;
  const detail = { ...detailFixture(), cwd, thread, turns: [store.getLingTurn(accepted.turnId)], runs: [run],
    runLinks: store.listLingTurnRuns(accepted.turnId), conversationItems: [accepted.item],
    executionActions: [1, 3, 5].map((seq, index) => actionFixture(`private-read-${index}`, accepted.item.id, {
      workspaceId: thread.workspaceId, threadId: thread.id, runId: run.id, participantId: teammateId,
      actionType: "read", toolCallId: `private-call-${index}`, sourceEventSequence: seq,
      targetRefs: [{ type: "file", id: `file-${index}.md`, path: `file-${index}.md` }],
    })),
    contextSnapshots: [{ id: accepted.inputSnapshot.id, threadId: thread.id, segmentId: p.segmentId,
      projectionVersion: p.projectionVersion, throughItemSequence: p.throughItemSequence, summaryIds: p.summaryIds,
      sourceRefs: p.sourceRefs, policyVersion: p.policyVersion, createdAt: now }],
  };
  const projection = projectConversationDetailTimeline(detail);
  const display = batchCanonicalTranscriptItems(projection.items, { contextSegmentIdByItemId: projection.contextSegmentIdByItemId });
  const batch = display.find(row => row.kind === "explorationBatch");
  assert.deepEqual(batch?.childActionIds, ["private-read-0", "private-read-1", "private-read-2"]);
  assert.deepEqual(projection.items.filter(row => row.kind === "exploration").map(row => row.actionId), batch.childActionIds,
    "batch leaves ordered atomic child facts intact for disclosure");
  detail.contextSnapshots = [];
  const missing = projectConversationDetailTimeline(detail);
  assert.equal(batchCanonicalTranscriptItems(missing.items, { contextSegmentIdByItemId: missing.contextSegmentIdByItemId })
    .some(row => row.kind === "explorationBatch"), false);
});

test("context snapshot resolver derives only explicit committed source items", () => {
  const items = [
    item("source-1", 1, "user_message", { body: "one", format: "plain_text" }),
    item("source-2", 2, "user_message", { body: "two", format: "plain_text" }),
    { ...item("pending", 3, "user_message", { body: "pending", format: "plain_text" }), status: "pending", committedAt: undefined },
  ];
  const snapshots = [{
    id: "snapshot-explicit",
    threadId: "thread-1",
    segmentId: "segment-a",
    projectionVersion: "v1",
    throughItemSequence: 2,
    summaryIds: [],
    sourceRefs: [
      { type: "conversation_item", id: "source-2" },
      { type: "conversation_item", id: "missing" },
      { type: "conversation_item", id: "pending" },
      { type: "conversation_item", id: "source-1" },
    ],
    policyVersion: "v1",
    createdAt: "2026-08-29T00:00:01.000Z",
  }];
  const result = resolveConversationContextSnapshots({ threadId: "thread-1", workspaceId: "workspace-1", items, snapshots });
  assert.deepEqual(result.snapshots[0].sourceItemIds, ["source-1", "source-2"]);
  assert.equal(result.snapshots[0].omittedItemCount, 2);
  assert.equal(result.diagnostics.length, 2);
});

test("context snapshot resolver rejects empty refs and cross-thread or invisible sources", () => {
  const visible = item("visible", 1, "user_message", { body: "visible", format: "plain_text" });
  const foreign = { ...visible, id: "foreign", threadId: "other-thread" };
  const snapshot = {
    id: "snapshot-invalid",
    threadId: "thread-1",
    segmentId: "segment-a",
    projectionVersion: "v1",
    throughItemSequence: 2,
    summaryIds: [],
    sourceRefs: [
      { type: "conversation_item", id: "foreign" },
      { type: "conversation_item", id: "visible" },
    ],
    policyVersion: "v1",
    createdAt: "2026-08-29T00:00:01.000Z",
  };
  const result = resolveConversationContextSnapshots({
    threadId: "thread-1",
    workspaceId: "workspace-1",
    items: [visible, foreign],
    snapshots: [snapshot],
    isVisible: (candidate) => candidate.id !== "visible",
  });
  assert.deepEqual(result.snapshots[0].sourceItemIds, []);
  assert.equal(result.diagnostics.length, 2);
  assert.equal(result.diagnostics.every((diagnostic) => diagnostic.code === "missing_context_source"), true);
});

test("detail adapter derives the shared surface policy from LingThread topology", () => {
  assert.equal(projectConversationDetailTimeline(detailFixture({ kind: "teammate_direct" })).items[0].kind, "userMessage");
  assert.equal(projectConversationDetailTimeline(detailFixture({ kind: "channel_discussion" })).diagnostics.length, 0);
  assert.equal(projectConversationDetailTimeline(detailFixture({ kind: "channel_discussion", parentThreadId: "root" })).diagnostics.length, 0);
  assert.equal(projectConversationDetailTimeline(detailFixture({ kind: "channel_discussion", parentThreadId: "root", forkedFromRunId: "run-1" })).diagnostics.length, 0);
});

test("normal, private, channel, topic, and branch keep one typed item grammar", () => {
  const topologies = [
    { kind: "conversation" },
    { kind: "teammate_direct" },
    { kind: "channel_discussion" },
    { kind: "channel_discussion", parentThreadId: "root" },
    { kind: "channel_discussion", parentThreadId: "root", forkedFromRunId: "run-1" },
  ];
  const signatures = topologies.map((thread) => projectConversationDetailTimeline(detailFixture(thread)).items.map((entry) => [entry.kind, entry.id, entry.threadSequence, entry.partIndex, entry.runId ?? ""].join(":")));
  assert.equal(new Set(signatures.map((entries) => entries.join("|"))).size, 1);
});

test("detail adapter projects approvals from checkpoint lineage without assigning command ownership", () => {
  const detail = detailFixture({ kind: "conversation" });
  detail.conversationItems = [
    item("user-1", 1, "user_message", { body: "Inspect", format: "plain_text" }),
    item("tool-unrelated", 2, "tool_call", { toolCallId: "call-unrelated", toolName: "bash" }),
    item("approval-item", 3, "approval_request", { approvalRequestId: "approval-1" }),
    item("artifact-item", 4, "artifact_ref", { artifactId: "image-1" }),
    item("agent-1", 5, "assistant_message", { body: "Done", format: "markdown", streaming: false, deliveryStatus: "ready" }),
  ];
  detail.executionActions = [
    actionFixture("unrelated", "tool-unrelated", { toolCallId: "call-unrelated" }),
    actionFixture("approved-command", "approval-item", { approvalId: "approval-1", toolCallId: "call-approved", status: "failed" }),
    actionFixture("artifact-owner", "artifact-item", { actionType: "read", resultArtifactIds: ["image-1"], sourceRefs: [{ kind: "conversation_item", id: "artifact-item" }, { kind: "run_event", id: "event-image" }] }),
  ];
  detail.approvals = [{
    id: "approval-1", runId: "run-1", toolCallId: "call-approved", actionType: "bash", risk: "medium", title: "Allow command", description: "Run the command", payload: {}, status: "approved", createdAt: detail.thread.createdAt, resolvedAt: detail.thread.updatedAt,
  }];
  detail.approvalCheckpoints = [{
    id: "checkpoint-1", approvalId: "approval-1", runId: "run-1", toolCallId: "call-approved",
    actionType: "bash", risk: "medium", title: "Allow command", description: "Run the command", status: "approved",
    sideEffect: {}, previewArtifactIds: [], resultArtifactIds: [], revision: 4,
    resumeBasis: { schemaVersion: 1, approvalId: "approval-1", runId: "run-1", workUnitId: "work-unit-1", priorAttemptId: "attempt-1", toolCallId: "call-approved", actionType: "bash", sideEffectFingerprint: "side-effect", fingerprint: "resume-basis" },
    createdAt: detail.thread.createdAt, updatedAt: detail.thread.updatedAt, resolvedAt: detail.thread.updatedAt,
  }];
  detail.artifacts = [{ id: "image-1", runId: "run-1", type: "image", path: "artifacts/result.png", title: "Result", contentType: "image/png", createdAt: detail.thread.createdAt }];

  const projection = projectConversationDetailTimeline(detail);
  const approval = projection.items.find((entry) => entry.kind === "approval");
  const image = projection.items.find((entry) => entry.kind === "imageView");
  assert.equal(approval?.actionId, undefined);
  assert.equal(approval?.status, "succeeded");
  assert.equal(approval?.attemptId, "attempt-1");
  assert.equal(projection.items.find((entry) => entry.actionId === "approved-command")?.status, "failed");
  assert.equal(image?.actionId, "artifact-owner");
  assert.equal(image?.itemId, "artifact-item");
  assert.equal(projection.diagnostics.some((entry) => entry.code === "missing_anchor" || entry.code === "owner_conflict"), false);
});

test("normal, private, and channel approvals reuse only their correlated durable action anchor", () => {
  for (const kind of ["conversation", "teammate_direct", "channel_discussion"]) {
    const detail = detailFixture({ kind });
    const participantId = kind === "teammate_direct" ? "engineer" : "ling";
    if (kind === "teammate_direct") detail.runs[0].teammateId = participantId;
    detail.conversationItems = [{ ...detail.conversationItems[0], turnId: "turn-1" }];
    detail.executionActions = [actionFixture("approval:approval-1", "user-1", {
      approvalId: "approval-1", toolCallId: "call-approved", participantId,
      sourceRefs: [{ kind: "approval", id: "approval-1" }, { kind: "conversation_item", id: "user-1" }],
    })];
    detail.approvals = [{
      id: "approval-1", runId: "run-1", toolCallId: "call-approved", actionType: "bash", risk: "medium",
      title: "Allow command", description: "Run the command", payload: {}, status: "approved",
      createdAt: detail.thread.createdAt, resolvedAt: detail.thread.updatedAt,
    }];
    detail.approvalCheckpoints = [{
      id: "checkpoint-1", approvalId: "approval-1", runId: "run-1", toolCallId: "call-approved",
      revision: 2, resumeBasis: { priorAttemptId: "attempt-1" },
    }];

    const projection = projectConversationDetailTimeline(detail);
    const command = projection.items.find((entry) => entry.kind === "commandExecution");
    assert.equal(command?.approvalId, "approval-1", kind);
    assert.equal(command?.runId, "run-1", kind);
    assert.equal(command?.participantId, participantId, kind);
    assert.equal(command?.sourceRefs.some((ref) => ref.kind === "conversation_item" && ref.id === "user-1"), true, kind);
    assert.equal(projection.items.some((entry) => entry.kind === "approval"), false, kind);
    assert.equal(projection.diagnostics.some((entry) => entry.code === "missing_anchor"), false, kind);

    detail.executionActions[0].status = "waiting_for_approval";
    detail.approvals[0].status = "pending";
    const waiting = projectConversationDetailTimeline(detail);
    assert.equal(waiting.items.find((entry) => entry.kind === "commandExecution")?.status, "waiting", kind);
    assert.equal(waiting.items.some((entry) => entry.kind === "approval"), false, kind);
    assert.equal(waiting.diagnostics.some((entry) => entry.code === "missing_anchor"), false, kind);

    // A different approval identity must not borrow this action's anchor.
    detail.executionActions[0].sourceRefs = [{ kind: "approval", id: "approval-other" }, { kind: "conversation_item", id: "user-1" }];
    const rejected = projectConversationDetailTimeline(detail);
    assert.equal(rejected.items.some((entry) => entry.kind === "approval"), false, kind);
    assert.equal(rejected.diagnostics.some((entry) => entry.code === "missing_anchor"), true, kind);
  }
});

test("detail adapter projects durable plan, compaction lineage, and a child Agent into the shared timeline", () => {
  const detail = detailFixture({ kind: "channel_discussion" });
  detail.conversationItems = [
    { ...detail.conversationItems[0], turnId: "turn-1" },
    detail.conversationItems[1],
    { ...item("child-tool", 3, "tool_call", { toolCallId: "child-call", toolName: "bash" }), turnId: "turn-2" },
    { ...item("child-agent", 4, "assistant_message", { body: "I checked the fixture.", format: "markdown", streaming: false, deliveryStatus: "ready" }), turnId: "turn-2", actorType: "teammate", actorId: "qa", domainRefs: [{ type: "run", id: "run-child" }] },
    { ...item("sibling-agent", 5, "assistant_message", { body: "Another Agent on the same turn.", format: "markdown", deliveryStatus: "ready" }), turnId: "turn-2", actorType: "teammate", actorId: "engineer", domainRefs: [{ type: "run", id: "run-sibling" }] },
    { ...item("unowned-agent", 6, "assistant_message", { body: "No Run owner.", format: "markdown", deliveryStatus: "ready" }), turnId: "turn-2" },
  ];
  detail.runLinks = [
    ...detail.runLinks,
    { runId: "run-child", turnId: "turn-2", attemptNumber: 1, role: "primary", createdAt: detail.thread.createdAt },
  ];
  detail.runs = [
    ...detail.runs,
    { id: "run-child", parentRunId: "run-1", teammateId: "qa", threadId: detail.thread.id, taskId: "task-child", status: "succeeded", cwd: detail.cwd, providerName: "test", providerModel: "test", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, eventLogPath: "/tmp/child.log", createdAt: detail.thread.createdAt, updatedAt: detail.thread.updatedAt },
  ];
  detail.executionActions = [
    ...detail.executionActions,
    { ...actionFixture("delegate-1", "tool-1", { actionType: "delegate_agent", status: "succeeded", title: "Delegate QA", summary: "Run QA", sourceRefs: [{ kind: "conversation_item", id: "tool-1" }, { kind: "run", id: "run-child" }] }) },
    { ...actionFixture("child-action", "child-tool", { runId: "run-child", attemptId: "child-attempt", participantId: "qa", toolCallId: "child-call", sourceRefs: [{ kind: "conversation_item", id: "child-tool" }], title: "Run child check" }) },
  ];
  detail.plans = [{ id: "plan-1", workspaceId: detail.thread.workspaceId, threadId: detail.thread.id, sourceMessageId: "user-1", title: "Ship", bodyMarkdown: "- [x] Inspect\n- [ ] Verify", status: "accepted", createdAt: detail.thread.createdAt, updatedAt: detail.thread.updatedAt }];
  detail.compactionCheckpoints = [{ id: "compact-1", workspaceId: detail.thread.workspaceId, threadId: detail.thread.id, sourceTurnId: "turn-1", contextViewId: "snapshot-1", coveredItemSeqFrom: 1, coveredItemSeqTo: 2, coveredTurnIds: ["turn-1"], summaryIds: ["summary-1"], sourceRefs: [{ type: "conversation_item", id: "user-1" }], workspaceProvenanceWatermark: "w1", compactionPolicyVersion: "v1", createdAt: detail.thread.updatedAt }];
  detail.contextSnapshots = [{ id: "snapshot-1", threadId: detail.thread.id, segmentId: "segment-1", projectionVersion: "v1", throughItemSequence: 2, summaryIds: ["summary-1"], sourceRefs: [{ type: "context_summary", id: "summary-1" }, { type: "conversation_item", id: "user-1" }, { type: "conversation_item", id: "tool-1" }], policyVersion: "v1", createdAt: detail.thread.updatedAt }];
  detail.contextSummaries = [{ id: "summary-1", threadId: detail.thread.id, segmentId: "segment-1", scope: "segment", status: "active", version: 1, coveredFromSequence: 1, coveredThroughSequence: 2, objective: "Keep the parser stable", decisions: [], constraints: [], openQuestions: [], activeWorkRefs: [], sourceRefs: [{ type: "conversation_item", id: "user-1" }, { type: "conversation_item", id: "tool-1" }], policyVersion: "v1", createdAt: detail.thread.updatedAt }];

  const projection = projectConversationDetailTimeline(detail);
  assert.equal(projection.diagnostics.length, 0);
  assert.equal(projection.items.some((entry) => entry.kind === "plan"), true);
  assert.equal(projection.items.some((entry) => entry.kind === "contextCompaction"), true);
  assert.equal(projection.items.find((entry) => entry.kind === "contextCompaction")?.summary, "Keep the parser stable");
  const child = projection.items.find((entry) => entry.kind === "subAgentActivity");
  assert.equal(child?.participantId, "qa");
  assert.equal(child?.childItems.some((entry) => entry.kind === "commandExecution"), true);
  assert.equal(child?.childItems.some((entry) => entry.kind === "agentMessage"), true);
  assert.equal(child?.childItems.some((entry) => entry.kind === "diagnostic"), false);
  assert.equal(child?.childItems.some((entry) => entry.itemId === "tool-1"), false);
  assert.deepEqual(child?.childItems.filter((entry) => entry.kind === "agentMessage").map((entry) => [entry.itemId, entry.runId, entry.attemptId, entry.participantId]), [["child-agent", "run-child", "child-attempt", "qa"]]);
});

test("detail adapter fails closed when a plan or delegated run has no explicit anchor", () => {
  const detail = detailFixture({ kind: "conversation" });
  detail.plans = [{ id: "plan-unanchored", workspaceId: detail.thread.workspaceId, threadId: detail.thread.id, title: "Unanchored", bodyMarkdown: "- Verify", status: "draft", createdAt: detail.thread.createdAt, updatedAt: detail.thread.updatedAt }];
  detail.runs = [...detail.runs, { id: "run-child", parentRunId: "run-1", teammateId: "qa", threadId: detail.thread.id, taskId: "task-child", status: "running", cwd: detail.cwd, providerName: "test", providerModel: "test", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, eventLogPath: "/tmp/child.log", createdAt: detail.thread.createdAt, updatedAt: detail.thread.updatedAt }];
  const projection = projectConversationDetailTimeline(detail);
  assert.equal(projection.items.some((entry) => entry.kind === "plan"), false);
  assert.equal(projection.items.some((entry) => entry.kind === "subAgentActivity"), false);
  assert.equal(projection.diagnostics.some((entry) => entry.code === "missing_anchor"), true);
  detail.executionActions.push(actionFixture("unrelated-delegation", "tool-1", { actionType: "delegate_agent" }));
  const genericAction = projectConversationDetailTimeline(detail);
  assert.equal(genericAction.items.some((entry) => entry.kind === "subAgentActivity"), false, "a delegation tool name is not a child Run correlation");
});

test("detail reconnect merge keeps newer actions and durable records from both snapshots", () => {
  const current = detailFixture({ kind: "conversation" });
  current.executionActions = [actionFixture("action-1", "tool-1", { revision: 8, summary: "newer output" })];
  current.conversationItems = [
    item("user-1", 1, "user_message", { body: "Inspect", format: "plain_text" }),
    item("tool-1", 2, "tool_call", { toolCallId: "call-1", toolName: "bash" }),
    item("tool-2", 3, "tool_call", { toolCallId: "call-2", toolName: "bash" }),
  ];
  current.executionActions = [
    actionFixture("action-1", "tool-1", { revision: 8, summary: "newer output" }),
    actionFixture("action-2", "tool-2", { revision: 1, toolCallId: "call-2" }),
  ];
  current.plans = [{ id: "plan-current", workspaceId: current.thread.workspaceId, threadId: current.thread.id, sourceMessageId: "user-1", title: "Current", bodyMarkdown: "- Verify", status: "draft", createdAt: current.thread.createdAt, updatedAt: "2026-08-29T00:00:02.000Z" }];

  const reconnect = detailFixture({ kind: "conversation", updatedAt: "2026-08-29T00:00:03.000Z" });
  reconnect.conversationItems = [
    item("user-1", 1, "user_message", { body: "Inspect", format: "plain_text" }),
    item("tool-1", 2, "tool_call", { toolCallId: "call-1", toolName: "bash" }),
    item("agent-1", 4, "assistant_message", { body: "Done", format: "markdown", streaming: false, deliveryStatus: "ready" }),
  ];
  reconnect.executionActions = [actionFixture("action-1", "tool-1", { revision: 7, summary: "stale reconnect output" })];
  reconnect.plans = [{ id: "plan-reconnect", workspaceId: reconnect.thread.workspaceId, threadId: reconnect.thread.id, sourceMessageId: "user-1", title: "Reconnect", bodyMarkdown: "- Rebuild", status: "accepted", createdAt: reconnect.thread.createdAt, updatedAt: reconnect.thread.updatedAt }];

  const merged = mergeConversationDetailSnapshots(current, reconnect);
  assert.equal(merged.executionActions.find((action) => action.id === "action-1")?.revision, 8);
  assert.equal(merged.executionActions.some((action) => action.id === "action-2"), true);
  assert.equal(merged.conversationItems.some((item) => item.id === "agent-1"), true);
  assert.deepEqual(merged.plans?.map((plan) => plan.id), ["plan-current", "plan-reconnect"]);
  const projection = projectConversationDetailTimeline(merged);
  assert.equal(projection.items.find((entry) => entry.actionId === "action-1")?.revision, 8);
});

test("detail refresh replaces a provisional tool action with its approval-correlated action", () => {
  const beforeApproval = detailFixture({ kind: "conversation" });
  beforeApproval.conversationItems.push(item("tool-2", 4, "tool_call", { toolCallId: "call-2", toolName: "bash" }));
  beforeApproval.executionActions = [
    actionFixture("tool:run-1:call-2", "tool-2", {
      revision: 4, toolCallId: "call-2", status: "running", summary: "Processing",
    }),
    actionFixture("tool:run-other:call-2", "tool-2", {
      runId: "run-other", toolCallId: "call-2", status: "running",
    }),
    actionFixture("tool:run-1:call-other", "tool-2", {
      toolCallId: "call-other", status: "running",
    }),
  ];
  const afterApproval = detailFixture({ kind: "conversation", updatedAt: "2026-08-29T00:00:01.000Z" });
  afterApproval.conversationItems = [...beforeApproval.conversationItems];
  afterApproval.executionActions = [actionFixture("approval:approval-2", "tool-2", {
    approvalId: "approval-2", toolCallId: "call-2", revision: 12,
    status: "succeeded", summary: "Completed",
  })];

  for (const merged of [
    mergeConversationDetailSnapshots(beforeApproval, afterApproval),
    mergeConversationDetailSnapshots(afterApproval, beforeApproval),
  ]) {
    assert.equal(merged.executionActions.some((action) => action.id === "tool:run-1:call-2"), false);
    assert.equal(merged.executionActions.filter((action) => action.runId === "run-1" && action.toolCallId === "call-2").length, 1);
    assert.equal(merged.executionActions.some((action) => action.id === "tool:run-other:call-2"), true);
    assert.equal(merged.executionActions.some((action) => action.id === "tool:run-1:call-other"), true);
    assert.equal(projectConversationDetailTimeline(merged).items.filter((entry) => entry.actionId === "tool:run-1:call-2").length, 0);
  }
});

test("detail reconnect merge is deterministic when snapshots arrive in either order", () => {
  const first = detailFixture({ kind: "conversation" });
  first.executionActions = [actionFixture("action-1", "tool-1", { revision: 2, summary: "first" })];
  const second = detailFixture({ kind: "conversation", updatedAt: "2026-08-29T00:00:02.000Z" });
  second.executionActions = [actionFixture("action-1", "tool-1", { revision: 3, summary: "second" })];
  const forward = projectConversationDetailTimeline(mergeConversationDetailSnapshots(first, second));
  const reverse = projectConversationDetailTimeline(mergeConversationDetailSnapshots(second, first));
  assert.deepEqual(forward.items, reverse.items);
  assert.deepEqual(forward.auditItems, reverse.auditItems);
  assert.deepEqual(forward.terminalEvidence, reverse.terminalEvidence);
});

test("detail reconnect merge keeps edit tombstones authoritative across stale reads without guessing sourceTurnId", () => {
  const old = detailFixture({ kind: "conversation" });
  old.conversationItems = old.conversationItems.map((entry) => ({
    ...entry,
    turnId: "turn-1",
    domainRefs: [{ type: "turn", id: "turn-1" }, { type: "run", id: "run-1" }],
  }));
  old.messages = [
    { id: "conversation-user:turn-1", role: "user", content: "Old prompt", status: "succeeded", threadId: "thread-1", turnId: "turn-1", runId: "run-1", createdAt: old.thread.createdAt, updatedAt: old.thread.updatedAt },
    { id: "conversation-assistant:turn-1", role: "assistant", content: "Old response", status: "succeeded", threadId: "thread-1", turnId: "turn-1", runId: "run-1", createdAt: old.thread.createdAt, updatedAt: old.thread.updatedAt },
  ];
  old.approvals = [{ id: "approval-old", runId: "run-1", actionType: "bash", risk: "low", title: "Old approval", description: "Old", payload: {}, status: "approved", createdAt: old.thread.createdAt }];
  old.interventions = [{ id: "intervention-old", workspaceId: "workspace-1", sourceRunId: "run-1", mode: "queue_followup", status: "started", instruction: "Old followup", requestedBy: "local-user", idempotencyKey: "old", createdAt: old.thread.createdAt, updatedAt: old.thread.updatedAt }];
  old.artifacts = [{ id: "artifact-old", runId: "run-1", type: "log", path: "old.log", createdAt: old.thread.createdAt }];
  old.generatedMedia = [{ mediaJobId: "media-old", runId: "run-1", operation: "image_generate", target: { kind: "provider", id: "provider", displayName: "Provider" }, prompt: "old", status: "succeeded", artifacts: [], createdAt: old.thread.createdAt, updatedAt: old.thread.updatedAt }];

  const replacement = detailFixture({ kind: "conversation", updatedAt: "2026-08-29T00:00:03.000Z" });
  replacement.turns = [
    { ...replacement.turns[0], id: "turn-2", sourceTurnId: "turn-1", title: "Replacement", userInstruction: "Replacement" },
    { ...replacement.turns[0], id: "turn-resume", sourceTurnId: "turn-1", kind: "manual_followup", title: "Resume", userInstruction: "Resume" },
  ];
  replacement.runLinks = [
    { ...replacement.runLinks[0], turnId: "turn-2", runId: "run-2" },
    { ...replacement.runLinks[0], turnId: "turn-resume", runId: "run-resume", role: "resume" },
  ];
  replacement.runs = [
    { ...replacement.runs[0], id: "run-2" },
    { ...replacement.runs[0], id: "run-resume", continuationReason: "manual_resume" },
  ];
  replacement.conversationItems = [
    { ...item("user-2", 4, "user_message", { body: "Replacement", format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] }), turnId: "turn-2", domainRefs: [{ type: "turn", id: "turn-2" }, { type: "run", id: "run-2" }] },
    { ...item("resume-2", 5, "assistant_message", { body: "Resume stays", format: "markdown", streaming: false, deliveryStatus: "ready" }), turnId: "turn-resume", domainRefs: [{ type: "turn", id: "turn-resume" }, { type: "run", id: "run-resume" }] },
  ];
  replacement.executionActions = [actionFixture("action-2", "user-2", { runId: "run-2", sourceRefs: [{ kind: "conversation_item", id: "user-2" }] })];
  replacement.messages = [
    { id: "conversation-user:turn-2", role: "user", content: "Replacement", status: "succeeded", threadId: "thread-1", turnId: "turn-2", runId: "run-2", createdAt: replacement.thread.createdAt, updatedAt: replacement.thread.updatedAt },
    { id: "conversation-assistant:turn-resume", role: "assistant", content: "Resume stays", status: "succeeded", threadId: "thread-1", turnId: "turn-resume", runId: "run-resume", createdAt: replacement.thread.createdAt, updatedAt: replacement.thread.updatedAt },
  ];
  replacement.supersessionTombstones = {
    turnIds: ["turn-1"],
    runIds: ["run-1"],
    responseMessageIds: ["conversation-assistant:turn-1"],
  };

  const merged = mergeConversationDetailSnapshots(old, replacement);
  const staleReplay = mergeConversationDetailSnapshots(merged, old);
  for (const snapshot of [merged, staleReplay]) {
    assert.deepEqual(snapshot.supersessionTombstones, replacement.supersessionTombstones);
    assert.equal(snapshot.turns.some((turn) => turn.id === "turn-1"), false);
    assert.equal(snapshot.runLinks.some((link) => link.turnId === "turn-1" || link.runId === "run-1"), false);
    assert.equal(snapshot.runs.some((run) => run.id === "run-1"), false);
    assert.equal(snapshot.conversationItems.some((entry) => entry.turnId === "turn-1"), false);
    assert.equal(snapshot.executionActions.some((action) => action.id === "action-1"), false);
    assert.equal(snapshot.approvals.some((approval) => approval.id === "approval-old"), false);
    assert.equal(snapshot.interventions.some((intervention) => intervention.id === "intervention-old"), false);
    assert.equal(snapshot.artifacts.some((artifact) => artifact.id === "artifact-old"), false);
    assert.equal(snapshot.generatedMedia.some((media) => media.mediaJobId === "media-old"), false);
    assert.equal(snapshot.messages.some((message) => message.content.startsWith("Old")), false);
    assert.equal(snapshot.turns.some((turn) => turn.id === "turn-resume"), true, "sourceTurnId alone is not an edit tombstone");
    assert.equal(snapshot.runs.some((run) => run.id === "run-resume"), true);
  }
});

test("detail adapter reports omitted durable collections instead of silently projecting an incomplete snapshot", () => {
  const detail = detailFixture({ kind: "conversation" });
  delete detail.plans;
  delete detail.compactionCheckpoints;
  delete detail.contextSnapshots;
  delete detail.contextSummaries;
  const projection = projectConversationDetailTimeline(detail);
  assert.equal(projection.diagnostics.filter((entry) => entry.code === "missing_lineage").length, 4);
});

test("detail adapter does not guess an action anchor from a lone generic item", () => {
  const detail = detailFixture({ kind: "conversation" });
  detail.executionActions = [actionFixture("unanchored", "tool-1", { sourceRefs: [], toolCallId: undefined })];
  const projection = projectConversationDetailTimeline(detail);
  assert.equal(projection.items.some((entry) => entry.actionId === "unanchored"), false);
  assert.equal(projection.diagnostics.some((entry) => entry.code === "missing_anchor"), true);
});
function detailFixture(threadOverrides = {}) {
  const now = "2026-08-29T00:00:00.000Z";
  return {
    cwd: "/tmp/workspace",
    thread: {
      id: "thread-1",
      workspaceId: "workspace-1",
      kind: "conversation",
      title: "Test",
      objective: "Test",
      status: "open",
      conversationMode: { mode: "default" },
      createdAt: now,
      updatedAt: now,
      ...threadOverrides,
    },
    turns: [{ id: "turn-1", threadId: "thread-1", workspaceId: "workspace-1", kind: "initial_request", status: "succeeded", title: "Test", userInstruction: "Inspect", createdByActor: "local-user", createdAt: now, updatedAt: now }],
    runLinks: [{ runId: "run-1", turnId: "turn-1", attemptNumber: 1, role: "primary", createdAt: now }],
    runs: [{ id: "run-1", threadId: "thread-1", taskId: "task-1", status: "succeeded", cwd: "/tmp/workspace", providerName: "test", providerModel: "test", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, eventLogPath: "/tmp/run.log", createdAt: now, updatedAt: now }],
    conversationItems: [
      item("user-1", 1, "user_message", { body: "Inspect", format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] }),
      item("tool-1", 2, "tool_call", { toolCallId: "call-1", toolName: "bash" }),
      item("agent-1", 3, "assistant_message", { body: "Done", format: "markdown", streaming: false, deliveryStatus: "ready" }),
    ],
    supersessionTombstones: { turnIds: [], runIds: [], responseMessageIds: [] },
    executionActions: [{
      id: "action-1", revision: 7, workspaceId: "workspace-1", threadId: "thread-1", runId: "run-1", attemptId: "attempt-1", participantId: "ling", actionType: "bash", risk: "low", status: "succeeded", title: "Run command", summary: "ok", toolCallId: "call-1", targetRefs: [], previewArtifactIds: [], resultArtifactIds: [], sourceRefs: [], commandEvidence: { command: "node -v", latestEventSeq: 7, outputTail: [], outputByteCount: 0, outputTruncated: false }, createdAt: now,
    }],
    approvals: [], approvalCheckpoints: [], interventions: [], terminalReports: [], artifacts: [], plans: [], compactionCheckpoints: [], contextSnapshots: [], contextSummaries: [], messages: [], generatedMedia: [], defaults: {},
  };
}

function item(id, sequence, kind, payload) {
  return { schemaVersion: 1, id, workspaceId: "workspace-1", threadId: "thread-1", sequence, kind, status: "committed", actorType: kind === "user_message" ? "local_user" : "ling_agent", visibility: "channel", payload, domainRefs: [], revision: 1, createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z", committedAt: "2026-08-29T00:00:00.000Z" };
}

function actionFixture(id, anchorItemId, overrides = {}) {
  const now = "2026-08-29T00:00:00.000Z";
  return {
    id,
    revision: id === "unrelated" ? 1 : id === "approval-owner" ? 2 : 3,
    workspaceId: "workspace-1",
    threadId: "thread-1",
    runId: "run-1",
    attemptId: "attempt-1",
    participantId: "ling",
    actionType: "bash",
    risk: "low",
    status: "succeeded",
    title: id,
    summary: id,
    targetRefs: [],
    previewArtifactIds: [],
    resultArtifactIds: [],
    sourceRefs: [{ kind: "conversation_item", id: anchorItemId }],
    commandEvidence: { command: "node -v", latestEventSeq: 1, outputTail: [], outputByteCount: 0, outputTruncated: false },
    createdAt: now,
    ...overrides,
  };
}

test("a delegated child can ask and receive an answer before any tool action", () => {
  const detail = detailFixture();
  const source = { workspaceId: "workspace-1", threadId: "thread-1", turnId: "turn-1", runId: "run-child",
    attemptId: "attempt-child", participantId: "qa", workUnitId: "unit-child", sourceItemId: "user-1" };
  const request = { availability: "available", itemId: "question-child", kind: "user_input_request",
    requestId: "request-child", requestVersion: 1, source, status: "answered", statusRevision: 2,
    waitMode: "required", questions: [{ questionId: "q", prompt: "Child question", required: true,
      allowFreeText: true, options: [] }], createdAt: detail.thread.createdAt, updatedAt: detail.thread.updatedAt };
  const answer = { availability: "available", itemId: "answer-child", kind: "user_input_answer",
    requestId: request.requestId, requestVersion: 1, source, answerId: "accepted-child",
    acceptedAt: detail.thread.updatedAt, answers: [{ questionId: "q", prompt: "Child question", kind: "text", text: "Child answer" }],
    delivery: { status: "pending", revision: 1, updatedAt: detail.thread.updatedAt } };
  detail.userInputs = [request, answer];
  detail.conversationItems.push(...[request, answer].map((record, index) => ({
    ...item(record.itemId, index + 5, record.kind, { requestId: record.requestId, requestVersion: 1,
      ...(record.kind === "user_input_answer" ? { answerId: record.answerId } : {}) }),
    turnId: source.turnId, actorType: record.kind === "user_input_request" ? "teammate" : "local_user",
    actorId: record.kind === "user_input_request" ? "qa" : "user",
  })));
  detail.runs.push({ ...detail.runs[0], id: "run-child", parentRunId: "run-1", teammateId: "qa", status: "yielded" });
  detail.executionActions.push(actionFixture("delegate", "tool-1", {
    actionType: "delegate_agent", sourceRefs: [{ kind: "conversation_item", id: "tool-1" }, { kind: "run", id: "run-child" }],
  }));
  const result = projectConversationDetailTimeline(detail);
  const child = result.items.find(row => row.kind === "subAgentActivity");
  assert.ok(child);
  assert.equal(child.lifecycle, "waiting");
  assert.deepEqual(child.childItems.map(row => row.kind), ["userInputRequest", "userInputAnswer"]);
  assert.ok(child.childItems.every(row => row.runId === "run-child" && row.attemptId === "attempt-child" && row.participantId === "qa"));
  assert.equal(result.items.filter(row => row.kind === "userInputRequest" || row.kind === "userInputAnswer").length, 0);
  const changed = structuredClone(detail);
  changed.userInputs[1].delivery = { ...answer.delivery, status: "claimed", revision: 2 };
  const updatedChild = projectConversationDetailTimeline(changed).items.find(row => row.kind === "subAgentActivity");
  assert.equal(updatedChild.childItems[1].revision, 2);
});
