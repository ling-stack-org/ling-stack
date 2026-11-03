import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createBuiltinAiTeammateId, createSqliteRunStore, resolveRuntimePaths } from "../dist/index.js";

const now = "2026-09-05T12:00:00.000Z";
const later = "2026-09-05T12:01:00.000Z";

for (const kind of ["conversation", "teammate_direct"]) {
  test(`${kind} ingest atomically creates a canonical turn, scoped item and replayable assignment`, async (t) => {
    const { store, thread } = await fixture(t, kind);
    const input = request(thread, "first");
    const first = store.appendConversationUserTurn(input, now);
    assert.equal(first.item.channelId, undefined);
    assert.equal(first.item.visibility, kind === "teammate_direct" ? "agent_private" : "thread_participants");
    assert.equal(first.item.visibilityOwnerId, kind === "teammate_direct" ? thread.teammateId : undefined);
    assert.equal(first.item.actorType, "local_user");
    assert.equal(first.item.sequence, 1);
    const turn = store.getLingTurn(first.turnId);
    assert.equal(turn.sourceItemId, first.item.id);
    assert.equal(turn.teammateId, thread.teammateId);
    assert.equal(turn.createdByActor, "local-user");
    assert.equal(store.getEffectiveTurnContextAssignment(first.turnId).segmentId, first.contextSegmentId);
    assert.equal(store.getContextSegment(first.contextSegmentId).threadId, thread.id);
    assert.deepEqual(store.appendConversationUserTurn(input, later), { ...first, idempotentReplay: true });

    const second = store.appendConversationUserTurn({
      ...request(thread, "second"), sourceTurnId: first.turnId, turnKind: "manual_followup",
    }, later);
    assert.equal(second.item.sequence, 2);
    assert.equal(second.contextSegmentId, first.contextSegmentId);
    assert.equal(store.getLingTurn(second.turnId).sourceTurnId, first.turnId);
    assert.equal(store.listLingTurns({ threadId: thread.id }).length, 2);
  });

  test(`${kind} ingest rejects changed replay identity, actor, source and payload`, async (t) => {
    const { store, thread, database } = await fixture(t, kind);
    const input = request(thread, "identity");
    const first = store.appendConversationUserTurn(input, now);
    const other = store.appendConversationUserTurn(request(thread, "other"), later);
    for (const changed of [
      { actorId: "another-user" },
      { actorType: "system" },
      { teammateId: "another-teammate" },
      { channelId: "invented-channel" },
      { turnKind: "manual_followup" },
      { sourceTurnId: other.turnId },
      { itemId: "another-item" },
      { turnId: "another-turn" },
      { payload: { ...input.payload, body: "Changed message" } },
      { payload: { ...input.payload, mentions: [{ id: "ling_agent", label: "Ling", kind: "ai_teammate" }] } },
    ]) {
      assert.throws(() => store.appendConversationUserTurn({ ...input, ...changed }, later));
    }
    assert.equal(store.getLingThread(thread.id).nextItemSequence, 3);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM turn_context_assignments WHERE turn_id = ?").get(first.turnId).count, 1);
  });

  test(`${kind} ingest rejects foreign thread refs and channel-only dispatch without partial writes`, async (t) => {
    const { store, thread } = await fixture(t, kind);
    const foreignThread = store.createLingThread({
      kind, teammateId: thread.teammateId, title: "Other thread", objective: "Private separation",
    }, now);
    const foreign = store.appendConversationUserTurn(request(foreignThread, "foreign"), now);
    const input = request(thread, "rejected");
    for (const changed of [
      { sourceTurnId: foreign.turnId },
      { payload: { ...input.payload, replyToItemId: foreign.item.id } },
      { payload: { ...input.payload, quotedItemIds: [foreign.item.id] } },
      { dispatch: { schemaVersion: 1, requestAiReply: true } },
      { actorType: "teammate" },
    ]) {
      assert.throws(() => store.appendConversationUserTurn({ ...input, ...changed }, now));
      assert.equal(store.getConversationItem(input.itemId), undefined);
      assert.equal(store.getLingTurn(input.turnId), undefined);
      assert.equal(store.getLingThread(thread.id).nextItemSequence, 1);
    }
  });

  test(`${kind} ingest rolls back turn, item, sequence and segment on assignment failure`, async (t) => {
    const { store, thread, database } = await fixture(t, kind);
    database.exec("CREATE TRIGGER reject_test_assignment BEFORE INSERT ON turn_context_assignments BEGIN SELECT RAISE(ABORT, 'test assignment failure'); END;");
    const input = request(thread, "rollback");
    assert.throws(() => store.appendConversationUserTurn(input, now), /test assignment failure/);
    assert.equal(store.getLingTurn(input.turnId), undefined);
    assert.equal(store.getConversationItem(input.itemId), undefined);
    assert.equal(store.getLingThread(thread.id).nextItemSequence, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM context_segments WHERE thread_id = ?").get(thread.id).count, 0);
    database.exec("DROP TRIGGER reject_test_assignment;");
    assert.equal(store.appendConversationUserTurn(input, later).item.sequence, 1);
  });

  test(`${kind} archived threads allow exact read-only replay but reject new turns`, async (t) => {
    const { store, thread, database } = await fixture(t, kind);
    const input = request(thread, "before-archive");
    const result = store.appendConversationUserTurn(input, now);
    database.prepare("UPDATE ling_threads SET status = 'archived', archived_at = ? WHERE id = ?").run(later, thread.id);
    assert.deepEqual(store.appendConversationUserTurn(input, later), { ...result, idempotentReplay: true });
    assert.throws(() => store.appendConversationUserTurn(request(thread, "after-archive"), later), /thread is archived/);
    assert.equal(store.getLingThread(thread.id).nextItemSequence, 2);
  });
}

test("private system input preserves its source actor and owner on replay", async (t) => {
  const { store, thread } = await fixture(t, "teammate_direct");
  const input = { ...request(thread, "remote"), actorType: "system", actorId: "remote-dispatch" };
  const result = store.appendConversationUserTurn(input, now);
  assert.equal(result.item.actorType, "system");
  assert.equal(result.item.actorId, "remote-dispatch");
  assert.equal(result.item.visibilityOwnerId, thread.teammateId);
  assert.equal(store.getLingTurn(result.turnId).createdByActor, "system");
  assert.equal(store.appendConversationUserTurn(input, later).idempotentReplay, true);
  assert.throws(() => store.appendConversationUserTurn({ ...input, actorType: "local_user" }, later));
});

test("workflow system input inherits durable task and step owners with its own canonical context", async (t) => {
  const { store, thread: parent } = await fixture(t, "conversation");
  const channel = store.createChannel({ name: "Forwarded workflow", boundPath: store.paths.cwd }, now);
  const task = store.createTask({ channelId: channel.id, title: "Child", prompt: "Read accepted input" }, now);
  const workflow = store.createChannelWorkflow({ channelId: channel.id, title: "Workflow", objective: "Forward input", createdBy: "local-user" }, now);
  const step = store.createChannelWorkflowStep({ workflowId: workflow.id, title: "Read", prompt: "Read accepted input",
    toParticipantId: "ling_agent", toParticipantLabel: "Ling" }, now);
  const source = store.appendConversationUserTurn(request(parent, "parent-source"), now);
  const thread = store.createLingThread({ kind: "workflow_step", channelId: channel.id, taskId: task.id,
    workflowId: workflow.id, workflowStepId: step.id, teammateId: "ling_agent", title: "Child", objective: "Forward input" }, now);
  const input = { ...request(thread, "forwarded"), channelId: channel.id, actorType: "system", actorId: "workflow-dispatch",
    turnKind: "workflow_step", domainRefs: [{ type: "conversation_item", id: source.item.id }, { type: "workflow_step", id: step.id }] };
  const created = store.appendConversationUserTurn(input, now);
  const turn = store.getLingTurn(created.turnId);
  assert.equal(turn.taskId, task.id);
  assert.equal(turn.workflowStepId, step.id);
  assert.equal(turn.sourceItemId, created.item.id);
  assert.equal(turn.sourceTurnId, undefined, "cross-thread ancestry belongs in domainRefs, not sourceTurnId");
  assert.equal(turn.createdByActor, "system");
  assert.equal(created.item.actorType, "system");
  assert.equal(created.item.threadId, thread.id);
  assert.notEqual(created.contextSegmentId, source.contextSegmentId);
  assert.equal(store.getContextSegment(created.contextSegmentId).threadId, thread.id);
  assert.equal(store.appendConversationUserTurn(input, later).idempotentReplay, true);
});

test("workflow input generation is read under the canonical transaction and preserves the exact Run prompt", async (t) => {
  const f = await workflowInputFixture(t);
  const readStep = f.store.getChannelWorkflowStep.bind(f.store);
  let guardedReads = 0;
  f.store.getChannelWorkflowStep = (id) => {
    assert.throws(() => f.database.exec("BEGIN IMMEDIATE"), /locked|busy/iu,
      "fresh generation reads must occur while canonical append owns the write lock");
    guardedReads += 1;
    return readStep(id);
  };
  const result = f.store.appendConversationUserTurn(f.input, now);
  assert.ok(guardedReads > 0);
  const turn = f.store.getLingTurn(result.turnId);
  assert.equal(turn.taskId, f.generation.task.id);
  assert.notEqual(turn.userInstruction, f.generation.task.prompt);
  assert.equal(turn.userInstruction, f.input.userInstruction);
  assert.equal(result.item.payload.body, f.input.payload.body);
  assert.equal(result.item.actorType, "system");
  assert.equal(f.store.appendConversationUserTurn(f.input, later).idempotentReplay, true);
});

test("workflow input rejects a replaced start owner atomically without an orphan Turn or sequence", async (t) => {
  const f = await workflowInputFixture(t);
  const step = f.store.getChannelWorkflowStep(f.step.id);
  f.store.updateChannelWorkflowStep(step.id, {
    metadata: { ...step.metadata, startOwner: { ...f.generation.owner, leaseId: "replaced-generation-lease" } },
  }, later);
  const before = f.store.getLingThread(f.thread.id).nextItemSequence;
  assert.throws(() => f.store.appendConversationUserTurn(f.input, later), /generation lineage/iu);
  assert.equal(f.store.getLingTurn(f.input.turnId), undefined);
  assert.equal(f.store.getConversationItem(f.input.itemId), undefined);
  assert.equal(f.store.getLingThread(f.thread.id).nextItemSequence, before);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM context_segments WHERE thread_id = ?").get(f.thread.id).count, 0);
});

test("workflow input retry owns the current Task without rewriting historical Thread or Turn owners", async (t) => {
  const f = await workflowInputFixture(t);
  const first = f.store.appendConversationUserTurn(f.input, now);
  const settled = f.store.settleChannelWorkflowStepStartFailure({ workflowStepId: f.step.id,
    owner: f.generation.owner, leaseId: f.lease.id, blocker: "Prepare a new retry generation", now: later });
  assert.equal(settled.status, "linked", JSON.stringify(settled));
  const generation = beginWorkflowInputGeneration(f, later);
  const input = { ...f.input, ...request(f.thread, "current-generation-retry"),
    channelId: f.channel.id, actorType: "system", actorId: "workflow-dispatch", turnKind: "workflow_step",
    workflowStepStart: { workflowId: f.workflow.id, workflowStepId: f.step.id,
      taskId: generation.task.id, owner: generation.owner } };
  const second = f.store.appendConversationUserTurn(input, later);
  assert.notEqual(second.turnId, first.turnId);
  assert.equal(f.store.getLingTurn(second.turnId).taskId, generation.task.id);
  assert.equal(f.store.getLingTurn(first.turnId).taskId, f.generation.task.id);
  assert.equal(f.store.getLingThread(f.thread.id).taskId, f.generation.task.id);
  assert.equal(f.store.getContextSegment(second.contextSegmentId).threadId, f.thread.id);
  assert.equal(f.store.appendConversationUserTurn(input, later).turnId, second.turnId);
});

test("replay rejects stored visibility and owner divergence instead of returning a widened item", async (t) => {
  const { store, thread, database } = await fixture(t, "teammate_direct");
  const input = request(thread, "visibility");
  store.appendConversationUserTurn(input, now);
  database.prepare("UPDATE conversation_items SET visibility = 'thread_participants', visibility_owner_id = NULL WHERE id = ?").run(input.itemId);
  assert.throws(() => store.appendConversationUserTurn(input, later), /idempotency key belongs to another input/);
  database.prepare("UPDATE conversation_items SET visibility = 'agent_private', visibility_owner_id = 'another-owner' WHERE id = ?").run(input.itemId);
  assert.throws(() => store.appendConversationUserTurn(input, later), /idempotency key belongs to another input/);
});

test("private ingest requires a real owner and rejects incompatible thread kinds", async (t) => {
  const { store } = await fixture(t, "conversation");
  for (const kind of ["teammate_direct", "task", "workflow_step"]) {
    const thread = store.createLingThread({ kind, title: kind, objective: "Must reject unsupported scope" }, now);
    assert.throws(() => store.appendConversationUserTurn(request(thread, kind), now),
      kind === "teammate_direct" ? /no teammate owner/ : /thread kind is not supported/);
    assert.equal(store.getLingThread(thread.id).nextItemSequence, 1);
  }
});

test("replay returns the latest effective assignment, including a provisional reassignment", async (t) => {
  const { store, thread } = await fixture(t, "conversation");
  const input = request(thread, "provisional");
  const first = store.appendConversationUserTurn(input, now);
  const reassigned = store.applyTurnContextAssignment({
    turnId: first.turnId,
    target: { kind: "new", state: "provisional", label: "New topic candidate" },
    status: "provisional", decisionSource: "model_policy", confidence: 0.5,
    evidenceRefs: [{ type: "conversation_item", id: first.item.id }],
    policyVersion: "continuity-v2-segmentation-v1",
  }, later);
  assert.equal(store.appendConversationUserTurn(input, later).contextSegmentId, reassigned.segment.id);
});

function request(thread, id) {
  return {
    threadId: thread.id,
    itemId: `surface-item-${id}`,
    turnId: `surface-turn-${id}`,
    teammateId: thread.teammateId,
    title: id,
    userInstruction: `Message ${id}`,
    actorId: "local-user",
    payload: { body: `Message ${id}`, format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
    idempotencyKey: `surface-request-${id}`,
  };
}

async function fixture(t, kind) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-surface-ingest-"));
  const store = createSqliteRunStore(cwd);
  const database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  t.after(async () => {
    database.close();
    store.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const thread = store.createLingThread({
    kind,
    teammateId: kind === "teammate_direct" ? createBuiltinAiTeammateId("designer") : "ling_agent",
    title: `${kind} ingest`,
    objective: "Canonical conversation scope",
  }, now);
  return { cwd, store, database, thread };
}

async function workflowInputFixture(t) {
  const f = await fixture(t, "conversation");
  f.database.exec("PRAGMA busy_timeout=1");
  f.channel = f.store.createChannel({ name: "Current workflow input", boundPath: f.cwd }, now);
  f.workflow = f.store.createChannelWorkflow({ channelId: f.channel.id, title: "Current workflow", objective: "Canonical input",
    status: "ready", createdBy: "local-user" }, now);
  f.step = f.store.createChannelWorkflowStep({ workflowId: f.workflow.id, title: "Current step", prompt: "Original Task instruction",
    toParticipantId: "ling_agent", toParticipantLabel: "Ling" }, now);
  f.generation = beginWorkflowInputGeneration(f, now);
  f.thread = f.store.createLingThread({ kind: "workflow_step", channelId: f.channel.id,
    workflowId: f.workflow.id, workflowStepId: f.step.id, taskId: f.generation.task.id,
    teammateId: "ling_agent", title: "Stable workflow Thread", objective: "Stable logical step" }, now);
  const base = request(f.thread, "current-generation");
  f.input = { ...base, channelId: f.channel.id, actorType: "system", actorId: "workflow-dispatch", turnKind: "workflow_step",
    userInstruction: "Rendered context pack plus the current Task instruction.",
    payload: { ...base.payload, body: "Rendered context pack plus the current Task instruction." },
    workflowStepStart: { workflowId: f.workflow.id, workflowStepId: f.step.id,
      taskId: f.generation.task.id, owner: f.generation.owner } };
  return f;
}

function beginWorkflowInputGeneration(f, at) {
  const lease = f.store.acquireResourceLease({ workspaceId: f.channel.workspaceId,
    resourceType: "workflow_step", resourceKey: f.step.id, ownerType: "workflow_step", ownerId: f.step.id,
    acquiredAt: at, expiresAt: "2026-09-05T14:00:00.000Z" });
  assert.ok(lease);
  const generation = f.store.beginChannelWorkflowStepStart({ workflowStepId: f.step.id,
    expected: f.store.getChannelWorkflowStep(f.step.id), leaseId: lease.id,
    task: { channelId: f.channel.id, title: "Current Task", prompt: "Original Task instruction", assigneeTeammateId: "ling_agent" },
    now: at });
  assert.equal(generation.status, "begun", JSON.stringify(generation));
  f.lease = lease;
  return generation;
}
