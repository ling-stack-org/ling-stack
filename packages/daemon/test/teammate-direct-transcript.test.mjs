import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { buildTeammateDirectTranscript } from "../dist/features/teammates/direct-transcript.js";

const now = "2026-09-05T12:00:00.000Z";
const engineer = "teammate_builtin_engineer";
const designer = "teammate_builtin_designer";

test("private transcript is read-only and returns undefined without an owned private Thread", async (t) => {
  const { store, database } = await fixture(t);
  const before = database.prepare("SELECT COUNT(*) AS count FROM ling_threads").get().count;
  assert.equal(buildTeammateDirectTranscript(store, engineer), undefined);
  store.createLingThread({ kind: "conversation", teammateId: engineer, title: "Not private", objective: "No private route bypass" }, now);
  assert.equal(buildTeammateDirectTranscript(store, engineer), undefined);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM ling_threads").get().count, before + 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM conversation_items").get().count, 0);
});

test("private transcript returns real canonical anchors, complete actions and owned runtime evidence", async (t) => {
  const { store, database } = await fixture(t);
  const own = createSource(store, engineer, "own");
  const run = createRun(store, own, "own");
  store.appendEvent(run.id, "tool_start", { toolCallId: "read-1", toolName: "read", args: { path: "README.md" } });
  store.appendEvent(run.id, "tool_end", { toolCallId: "read-1", toolName: "read", result: { content: [{ type: "text", text: "Actual file content" }] } });
  const approval = store.createApprovalRequest({
    runId: run.id, taskId: run.taskId, actionType: "bash", risk: "medium", title: "Test permission", description: "Not an executed command",
    payload: { type: "bash", cwd: store.paths.cwd, command: "node --test", riskFlags: [] },
  }, now);
  const artifact = store.createArtifact({ runId: run.id, type: "file", path: join(store.paths.cwd, "report.md"), title: "Report", createdAt: now });
  const context = store.createConversationContextSnapshot({
    threadId: own.thread.id, segmentId: own.accepted.contextSegmentId, projectionVersion: "private-test-v1",
    throughItemSequence: own.accepted.item.sequence, sourceRefs: [{ type: "conversation_item", id: own.accepted.item.id }],
    policyVersion: "private-test-v1",
  }, now);
  const before = database.prepare("SELECT COUNT(*) AS count FROM conversation_items").get().count;
  const beforeVersion = database.prepare("PRAGMA data_version").get().data_version;
  const result = buildTeammateDirectTranscript(store, engineer);
  assert.equal(result.thread.id, own.thread.id);
  assert.deepEqual(result.conversationItems.map(item => item.id), [own.message.id]);
  assert.equal(result.turns[0].sourceItemId, own.message.id);
  assert.equal(result.runLinks[0].runId, run.id);
  const read = result.executionActions.find(action => action.toolCallId === "read-1");
  assert.ok(read.sourceRefs.some(ref => ref.kind === "conversation_item" && ref.id === own.message.id));
  assert.equal(read.toolEvidence.outputText, "Actual file content");
  assert.equal(read.status, "succeeded");
  assert.deepEqual(result.approvals.map(item => item.id), [approval.id]);
  assert.deepEqual(result.artifacts.map(item => item.id), [artifact.id]);
  assert.deepEqual(result.contextSnapshots.map(item => item.id), [context.id]);
  assert.deepEqual(result.messages, []);
  assert.deepEqual(result.defaults, {});
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM conversation_items").get().count, before);
  assert.equal(database.prepare("PRAGMA data_version").get().data_version, beforeVersion, "projection must not write any SQLite rows");
});

test("private transcript cannot expose another teammate's canonical items or linked runs", async (t) => {
  const { store } = await fixture(t);
  const own = createSource(store, engineer, "engineer");
  const other = createSource(store, designer, "designer");
  const ownRun = createRun(store, own, "engineer");
  const foreignRun = createRun(store, other, "designer");
  for (const run of [ownRun, foreignRun]) {
    store.appendEvent(run.id, "tool_start", { toolCallId: "read", toolName: "read", args: { path: `${run.id}.md` } });
  }
  // Even corrupt same-Thread links cannot override the durable Run owner.
  createRun(store, own, "misowned", designer);
  store.appendConversationItem({
    threadId: own.thread.id, turnId: own.accepted.turnId, kind: "assistant_message", actorType: "teammate", actorId: designer,
    visibility: "agent_private", visibilityOwnerId: designer,
    payload: { body: "Another owner's private note", format: "markdown", streaming: false, deliveryStatus: "ready" },
  }, now);
  const result = buildTeammateDirectTranscript(store, engineer);
  assert.deepEqual(result.runs.map(run => run.id), [ownRun.id]);
  assert.ok(result.executionActions.every(action => action.runId === ownRun.id));
  assert.ok(result.conversationItems.every(item => item.visibilityOwnerId === engineer));
  assert.ok(!JSON.stringify(result).includes(foreignRun.id));
  assert.ok(!JSON.stringify(result).includes("Another owner's private note"));
  assert.equal(buildTeammateDirectTranscript({
    findLingThreadByOwner: () => other.thread,
  }, engineer), undefined);
});

test("private transcript reads canonical item cursors beyond 500 turns and RunEvents beyond 1000", async (t) => {
  const { store } = await fixture(t);
  const own = createSource(store, engineer, "history");
  const run = createRun(store, own, "history");
  store.appendEvent(run.id, "tool_start", { toolCallId: "long-read", toolName: "read", args: { path: "history.md" } });
  for (let index = 0; index < 1000; index++) store.appendEvent(run.id, "tool_update", { toolCallId: "long-read", toolName: "read", partialResult: { text: "Still reading" } });
  store.appendEvent(run.id, "tool_end", { toolCallId: "long-read", toolName: "read", result: { content: [{ type: "text", text: "Full history completed" }] } });
  for (let index = 0; index < 501; index++) {
    store.appendConversationUserTurn({
      threadId: own.thread.id, title: `Follow-up ${index}`, userInstruction: `Follow-up ${index}`, actorId: "local-user",
      payload: { body: `Follow-up ${index}`, format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
      idempotencyKey: `private-history-${index}`,
    }, now);
  }
  const result = buildTeammateDirectTranscript(store, engineer);
  assert.equal(result.conversationItems.length, 502);
  assert.equal(result.turns.length, 502);
  assert.deepEqual(result.conversationItems.map(item => item.sequence), Array.from({ length: 502 }, (_, index) => index + 1));
  assert.ok(result.turns.some(turn => turn.id === own.accepted.turnId));
  assert.equal(result.executionActions[0].toolEvidence.outputText, "Full history completed");
  assert.equal(result.executionActions[0].status, "succeeded");
});

test("private transcript rejects workflow Runs and inconsistent owning Turn links before reading facts", async (t) => {
  const { store } = await fixture(t);
  const own = createSource(store, engineer, "owner-guards");
  const run = createRun(store, own, "owner-guards");
  const turn = store.getLingTurnForRun(run.id);
  for (const overrides of [
    { getRun: () => ({ ...run, workflowStepId: "foreign-workflow-step" }) },
    { getRun: () => ({ ...run, channelId: "foreign-channel" }) },
    { getRun: () => ({ ...run, requestSnapshot: { turnId: "different-turn" } }) },
    { getLingTurnForRun: () => ({ ...turn, id: "different-turn" }) },
    { getLingTurnForRun: () => ({ ...turn, workflowStepId: "foreign-workflow-step" }) },
  ]) {
    const guardedStore = new Proxy(store, { get(target, key) {
      if (key in overrides) return overrides[key];
      if (["listEvents", "listArtifacts", "listApprovalRequests"].includes(key)) return () => assert.fail("must not read unowned Run facts");
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const result = buildTeammateDirectTranscript(guardedStore, engineer);
    assert.deepEqual(result.runLinks, []);
    assert.deepEqual(result.runs, []);
    assert.deepEqual(result.executionActions, []);
  }
});

test("private supersession removes replaced turns, items, runs and actions unless audit is requested", async (t) => {
  const { store } = await fixture(t);
  const own = createSource(store, engineer, "replace");
  const run = createRun(store, own, "replace");
  store.appendEvent(run.id, "tool_start", { toolCallId: "old-read", toolName: "read", args: { path: "old.md" } });
  const empty = { mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] };
  store.commitConversationMessageEdit({
    surface: "teammate_direct", ownerId: engineer, laneId: own.message.threadId, messageId: own.message.id,
    expectedRevision: 1, current: { ...empty, body: own.message.body }, replacement: { ...empty, body: "Changed request" },
    sourceTurnId: own.accepted.turnId, supersededTurnId: own.accepted.turnId, supersededRunIds: [run.id],
    supersededResponseMessageIds: [], idempotencyKey: "private-edit-test",
  }, now);
  const current = buildTeammateDirectTranscript(store, engineer);
  assert.deepEqual(current.turns, []);
  assert.deepEqual(current.conversationItems, []);
  assert.deepEqual(current.runs, []);
  assert.deepEqual(current.executionActions, []);
  const audit = buildTeammateDirectTranscript(store, engineer, { includeSuperseded: true });
  assert.equal(audit.turns[0].id, own.accepted.turnId);
  assert.equal(audit.conversationItems[0].id, own.message.id);
  assert.equal(audit.runs[0].id, run.id);
});

test("private plans retain exact message domain refs after canonical item identity changes", async (t) => {
  const { store } = await fixture(t);
  const own = createSource(store, engineer, "plan-source");
  const replacement = store.appendConversationUserTurn({
    itemId: "canonical-private-edited-item", threadId: own.thread.id, title: "Edited request", userInstruction: "Updated plan",
    supersedesItemId: own.accepted.item.id,
    domainRefs: [{ type: "message", id: own.message.id }],
    payload: { body: "Updated plan", format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
    idempotencyKey: "private-plan-replacement",
  }, now);
  const plan = store.upsertProposedPlanArtifact({
    threadId: own.thread.id, sourceTurnId: replacement.turnId, sourceMessageId: own.message.id,
    ownerAgentId: engineer, title: "Updated plan", bodyMarkdown: "Read then test.",
  }, now);
  store.upsertProposedPlanArtifact({
    threadId: own.thread.id, sourceTurnId: replacement.turnId, sourceMessageId: "unrelated-private-message",
    ownerAgentId: engineer, title: "Unrelated plan", bodyMarkdown: "Must not match by content or time.",
  }, now);
  const result = buildTeammateDirectTranscript(store, engineer);
  assert.deepEqual(result.conversationItems.map(item => item.id), [replacement.item.id]);
  assert.deepEqual(result.plans.map(item => item.id), [plan.id]);
});

function createSource(store, teammateId, id) {
  const lane = store.getOrCreateTeammateDirectThread(teammateId, now);
  const message = store.createTeammateDirectMessage({ threadId: lane.id, teammateId, authorType: "local-user", authorId: "local-user", body: `Source ${id}`, status: "ready" }, now);
  const thread = store.createLingThread({ kind: "teammate_direct", teammateId, title: id, objective: `Private ${id}` }, now);
  const accepted = store.appendConversationUserTurn({
    itemId: message.id, threadId: thread.id, teammateId, title: id, userInstruction: message.body, actorId: message.authorId,
    payload: { body: message.body, format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
    idempotencyKey: `private-source-${id}`,
  }, now);
  return { thread, message, accepted };
}

function createRun(store, source, id, teammateId = source.thread.teammateId) {
  return store.createRun({
    id: `private-run-${id}`, cwd: store.paths.cwd, taskId: source.message.id, threadId: source.thread.id,
    turnId: source.accepted.turnId, teammateId, providerName: "test", providerModel: "test",
    taskSnapshot: { id: source.message.id, title: id, prompt: source.message.body }, providerSnapshot: {}, requestSnapshot: {}, createdAt: now,
  });
}

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-private-transcript-"));
  const store = createSqliteRunStore(cwd);
  const database = new DatabaseSync(store.paths.databasePath);
  t.after(async () => { database.close(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  return { store, database };
}
