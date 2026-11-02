import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import test from "node:test";
import * as core from "../dist/index.js";
import { channelOperationPlanFingerprintV1, createRequiredParticipantManifestV1, isChannelIntentPendingOperationV1 } from "../../contracts/dist/index.js";
import { applyChannelPendingOperationMigration, CHANNEL_PENDING_OPERATION_MIGRATION_VERSION } from "../dist/storage/sqlite/channel-pending-operation-migration.js";
import { appendChannelItemFixture } from "./channel-conversation-fixture.mjs";

const fingerprint = value => {
  const canonical = item => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)])) : item;
  const { fingerprint: _fingerprint, ...snapshot } = value;
  return createHash("sha256").update(JSON.stringify(canonical(snapshot))).digest("hex");
};

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-channel-pending-resolution-"));
  let store = core.createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const now = "2026-10-27T08:00:00.000Z";
  const channel = store.createChannel({ name: "Pending plan only", boundPath: cwd, allowedTools: ["read", "bash"] }, now);
  const original = appendChannelItemFixture(store, { channelId: channel.id, authorType: "local-user",
    body: "@QA 仅运行 node project/validate.mjs，不写文件、不联网。" }, now);
  const source = store.getConversationItem(original.id);
  const assignment = store.getEffectiveTurnContextAssignment(source.turnId);
  const projection = item => ({ threadId: item.threadId, turnId: item.turnId,
    segmentId: assignment.segmentId, throughItemSequence: item.sequence,
    projectionVersion: "pending-test-projection", sourceStateFingerprint: "pending-test-state",
    summaryIds: [], sourceRefs: [{ type: "conversation_item", id: item.id }],
    policyVersion: "continuity-v2", visibilityFingerprint: "pending-test-channel" });
  const sourceRef = { itemId: original.id, revision: source.revision, actorType: "local_user", quote: original.body };
  const operations = [{ id: "validate", kind: "run_command", targetKind: "command", required: true, dependsOn: [],
    targetRef: { type: "operation", id: `${original.id}:validate`, label: "node project/validate.mjs" },
    commandMatchPolicy: { kind: "exact_command", command: "node project/validate.mjs" },
    binding: { schemaVersion: 1, ownerParticipantId: "teammate_builtin_qa", ownerSelection: "explicit",
      inputRefs: [{ path: "project/validate.mjs", sourceRefs: [sourceRef] }], outputRefs: [], sourceRefs: [sourceRef],
      effectScope: { readPaths: ["project/validate.mjs"], writePaths: [], exactCommands: ["node project/validate.mjs"],
        allowEnvironmentAccess: false, allowNetworkAccess: false } } }];
  const pending = { schemaVersion: 1, sourceRevision: source.revision,
    sourceAssignmentId: assignment.id, sourceAssignmentRevision: assignment.revision,
    authorityFingerprint: "a".repeat(64),
    execution: { bindingVersion: 1, operations, fingerprint: channelOperationPlanFingerprintV1(operations) },
    participantManifest: createRequiredParticipantManifestV1([{ participantId: "teammate_builtin_qa", role: "qa",
      requirement: "required", expectedOutcome: "execution", requiredOperationIds: ["validate"], requestedBy: "structured_mention" }]),
    slots: [{ operationId: "validate", field: "project_input_root" }] };
  pending.fingerprint = fingerprint(pending);
  const question = appendChannelItemFixture(store, { channelId: channel.id, authorType: "ai-teammate", authorId: "ling_agent",
    body: "本次 Node 项目的依赖目录是什么？", replyToItemId: original.id }, now);
  const createDecision = (item, input) => store.createChannelIntentDecision({ channelId: channel.id, sourceItemId: item.id,
    contextProjection: projection(store.getConversationItem(item.id)), reason: "Isolated pending-plan regression",
    status: "accepted", createdBy: "model_policy", ...input }, now);
  const decision = createDecision(original, { action: "clarify", resultItemIds: [question.id],
    clarification: { missingFields: ["projectInputRoot"], question: question.body, pendingOperation: pending } });
  const answer = appendChannelItemFixture(store, { channelId: channel.id, authorType: "local-user",
    body: "确认，项目依赖目录仅限 project，不写文件。", replyToItemId: question.id }, now);
  const input = () => ({ pendingDecisionId: decision.id, expectedDraftFingerprint: pending.fingerprint,
    answerItemId: answer.id, expectedAnswerRevision: store.getConversationItem(answer.id).revision,
    expectedQuestionRevision: store.getConversationItem(question.id).revision });
  return { cwd, channel, original, question, decision, answer, pending, input, now, createDecision,
    projection, get store() { return store; },
    publish: () => createDecision(answer, { action: "reply" }),
    reopen() { store.close(); store = core.createSqliteRunStore(cwd); } };
}

test("a pending plan is persisted without Runs, tasks, proposals or tool authority", async t => {
  const f = await fixture(t);
  assert.equal(typeof core.channelPendingOperationFingerprintV1, "function");
  assert.equal(core.channelPendingOperationFingerprintV1(f.pending), f.pending.fingerprint);
  f.reopen();
  assert.deepEqual(f.store.getChannelIntentDecision(f.decision.id).clarification.pendingOperation, f.pending);
  assert.equal(f.store.listRuns({ channelId: f.channel.id }).length, 0);
  assert.equal(f.store.listTasks({ channelId: f.channel.id }).length, 0);
  assert.equal(f.store.listChannelExecutionProposals({ channelId: f.channel.id }).length, 0);
});

test("answer consumption and its decision commit once, including replay after reopen", async t => {
  const f = await fixture(t); let calls = 0;
  const first = f.store.resolveChannelPendingOperation(f.input(), () => { calls += 1; return f.publish(); }, f.now);
  assert.equal(first.replayed, false);
  f.reopen();
  const second = f.store.resolveChannelPendingOperation(f.input(), () => { calls += 1; throw new Error("must not rerun"); }, f.now);
  assert.equal(second.replayed, true); assert.equal(second.decision.id, first.decision.id); assert.equal(calls, 1);
  assert.equal(f.store.getChannelPendingOperationResolution(f.decision.id).decisionId, first.decision.id);
});

test("a publication failure rolls back the decision and leaves the original pending item unconsumed", async t => {
  const f = await fixture(t); const failure = new Error("injected decision publication failure");
  assert.throws(() => f.store.resolveChannelPendingOperation(f.input(), () => { f.publish(); throw failure; }, f.now), error => error === failure);
  assert.equal(f.store.getChannelPendingOperationResolution(f.decision.id), undefined);
  assert.deepEqual(f.store.listChannelIntentDecisions({ sourceItemId: f.answer.id }), []);
  assert.equal(f.store.resolveChannelPendingOperation(f.input(), f.publish, f.now).replayed, false);
});

for (const [label, mutate] of [
  ["stale draft", input => { input.expectedDraftFingerprint = "b".repeat(64); }],
  ["stale answer", input => { input.expectedAnswerRevision += 1; }],
  ["stale question", input => { input.expectedQuestionRevision += 1; }],
]) test(`${label} is refused before publication`, async t => {
  const f = await fixture(t), input = f.input(); mutate(input); let calls = 0;
  assert.throws(() => f.store.resolveChannelPendingOperation(input, () => { calls += 1; return f.publish(); }, f.now), /pending_operation/u);
  assert.equal(calls, 0); assert.equal(f.store.getChannelPendingOperationResolution(f.decision.id), undefined);
});

test("a different later answer cannot consume the same pending request again", async t => {
  const f = await fixture(t);
  f.store.resolveChannelPendingOperation(f.input(), f.publish, f.now);
  const other = appendChannelItemFixture(f.store, { channelId: f.channel.id, authorType: "local-user", body: "另一个回答" }, f.now);
  assert.throws(() => f.store.resolveChannelPendingOperation({ ...f.input(), answerItemId: other.id,
    expectedAnswerRevision: f.store.getConversationItem(other.id).revision }, f.publish, f.now), /pending_operation/u);
});

test("an intervening user request retires the earlier pending continuation", async t => {
  const f = await fixture(t);
  const other = appendChannelItemFixture(f.store, { channelId: f.channel.id, authorType: "local-user", body: "不要继续，先讨论别的。" }, f.now);
  assert.throws(() => f.store.resolveChannelPendingOperation({ ...f.input(), answerItemId: other.id,
    expectedAnswerRevision: f.store.getConversationItem(other.id).revision }, f.publish, f.now), /pending_operation/u);
});

test("asynchronous publication is refused without consuming the pending request", async t => {
  const f = await fixture(t);
  assert.throws(() => f.store.resolveChannelPendingOperation(f.input(), async () => f.publish(), f.now), /synchronous/u);
  assert.equal(f.store.getChannelPendingOperationResolution(f.decision.id), undefined);
});

test("an already answered current turn cannot consume a pending request", async t => {
  const f = await fixture(t);
  f.publish(); let calls = 0;
  assert.throws(() => f.store.resolveChannelPendingOperation(f.input(), () => { calls += 1; return f.publish(); }, f.now), /pending_operation/u);
  assert.equal(calls, 0);
});

for (const target of ["original", "question"]) test(`a superseded ${target} retires the pending request`, async t => {
  const f = await fixture(t), item = f.store.getConversationItem(f[target].id);
  f.store.appendConversationItem({ channelId: item.channelId, threadId: item.threadId, turnId: item.turnId,
    kind: item.kind, status: "committed", actorType: item.actorType, actorId: item.actorId, visibility: item.visibility,
    payload: item.payload, domainRefs: item.domainRefs, supersedesItemId: item.id }, f.now);
  let calls = 0;
  assert.throws(() => f.store.resolveChannelPendingOperation(f.input(), () => { calls += 1; return f.publish(); }, f.now), /pending_operation/u);
  assert.equal(calls, 0);
});

test("a new decision supersedes the earlier pending request", async t => {
  const f = await fixture(t);
  f.createDecision(f.original, { action: "reply" });
  assert.throws(() => f.store.resolveChannelPendingOperation(f.input(), f.publish, f.now), /retired_request/u);
});

test("cross-thread and cross-channel answers cannot resolve the pending request", async t => {
  const f = await fixture(t);
  const topic = appendChannelItemFixture(f.store, { channelId: f.channel.id, authorType: "local-user",
    body: "确认 topic", topicAnchorItemId: f.original.id }, f.now);
  const channel = f.store.createChannel({ name: "Other channel", boundPath: f.cwd }, f.now);
  const other = appendChannelItemFixture(f.store, { channelId: channel.id, authorType: "local-user", body: "确认 other channel" }, f.now);
  for (const item of [topic, other]) {
    assert.throws(() => f.store.resolveChannelPendingOperation({ ...f.input(), answerItemId: item.id,
      expectedAnswerRevision: f.store.getConversationItem(item.id).revision }, f.publish, f.now), /stale_source/u);
  }
});

test("moving the answer to a new context segment retires the pending request", async t => {
  const f = await fixture(t);
  f.store.applyTurnContextAssignment({ turnId: f.store.getConversationItem(f.answer.id).turnId,
    target: { kind: "new", state: "active" }, status: "committed", decisionSource: "user", policyVersion: "pending-test" }, f.now);
  assert.throws(() => f.store.resolveChannelPendingOperation(f.input(), f.publish, f.now), /retired_request/u);
});

test("moving the original away and back does not revive its old assignment version", async t => {
  const f = await fixture(t), source = f.store.getConversationItem(f.original.id);
  f.store.applyTurnContextAssignment({ turnId: source.turnId, target: { kind: "new", state: "active" },
    status: "committed", decisionSource: "user", policyVersion: "pending-test" }, f.now);
  f.store.applyTurnContextAssignment({ turnId: source.turnId, target: { kind: "existing", segmentId: f.decision.contextSegmentId },
    status: "committed", decisionSource: "user", policyVersion: "pending-test" }, f.now);
  assert.throws(() => f.store.resolveChannelPendingOperation(f.input(), f.publish, f.now), /retired_request/u);
});

test("pending contracts reject unknown fields, unbound plans and unsupported or duplicate slots", async t => {
  const f = await fixture(t);
  assert.equal(isChannelIntentPendingOperationV1(f.pending), true);
  for (const mutate of [
    p => { p.verified = true; }, p => { delete p.sourceAssignmentId; }, p => { p.sourceAssignmentRevision = -1; },
    p => { p.execution.bindingVersion = 2; }, p => { p.execution.operations[0].binding = undefined; },
    p => { p.slots[0].field = "command"; }, p => { p.slots[0].operationId = "foreign"; },
    p => { p.slots.push({ ...p.slots[0] }); }, p => { p.slots[0].owner = "ling_agent"; },
  ]) {
    const pending = structuredClone(f.pending); mutate(pending);
    assert.equal(isChannelIntentPendingOperationV1(pending), false);
  }
});

for (const change of ["none", "command", "participant"]) test(`Core ${change === "none" ? "accepts only a slot fill" : `rejects a replaced ${change}`} at publication`, async t => {
  const f = await fixture(t), execution = structuredClone(f.pending.execution), operation = execution.operations[0];
  const answer = f.store.getConversationItem(f.answer.id);
  operation.binding.sourceRefs.push({ itemId: answer.id, revision: answer.revision, actorType: "local_user", quote: answer.payload.body });
  operation.binding.commandInputScope = { kind: "node_module_closure_v1", projectRoot: "project",
    sourceRefs: [{ itemId: answer.id, revision: answer.revision, actorType: "local_user", quote: "project" }] };
  if (change === "command") {
    operation.commandMatchPolicy.command = "node project/validate.mjs --invented";
    operation.binding.effectScope.exactCommands = [operation.commandMatchPolicy.command];
  }
  execution.fingerprint = channelOperationPlanFingerprintV1(execution.operations);
  const publish = () => f.createDecision(f.answer, { action: "execute", selectedTeammateIds: ["teammate_builtin_qa"], execution,
    participantManifest: createRequiredParticipantManifestV1([{ participantId: "teammate_builtin_qa", role: "qa",
      requirement: "required", expectedOutcome: "execution", requiredOperationIds: ["validate"], requestedBy: "structured_mention",
      ...(change === "participant" ? { role: "custom" } : {}) }]) });
  if (change !== "none") {
    assert.throws(() => f.store.resolveChannelPendingOperation(f.input(), publish, f.now), /pending_operation/u);
    assert.deepEqual(f.store.listChannelIntentDecisions({ sourceItemId: f.answer.id }), []);
    assert.equal(f.store.getChannelPendingOperationResolution(f.decision.id), undefined);
  } else assert.equal(f.store.resolveChannelPendingOperation(f.input(), publish, f.now).replayed, false);
});

for (const reopen of [false, true]) test(`a ${reopen ? "recovered" : "current"} pending slot cannot inherit a new policy scope`, async t => {
  const f = await fixture(t);
  if (reopen) f.reopen();
  const execution = structuredClone(f.pending.execution), operation = execution.operations[0];
  const answer = f.store.getConversationItem(f.answer.id), original = f.store.getConversationItem(f.original.id);
  operation.binding.sourceRefs.push({ itemId: answer.id, revision: answer.revision, actorType: "local_user", quote: answer.payload.body });
  operation.binding.commandInputScope = { kind: "node_module_closure_v1", projectRoot: ".", sourceRefs: [],
    policyAuthority: { kind: "channel_effective_policy_v1", channelId: f.channel.id, workspaceId: f.decision.workspaceId,
      participantId: operation.binding.ownerParticipantId, operationId: operation.id,
      sourceItemId: original.id, sourceRevision: original.revision, workspaceCwd: f.cwd, executionCwd: f.cwd,
      workspaceRootIdentity: { device: "1", inode: "2" }, executionRootIdentity: { device: "1", inode: "2" },
      channelUpdatedAt: f.now, workspacePolicyUpdatedAt: f.now, policyFingerprint: "a".repeat(64) } };
  execution.fingerprint = channelOperationPlanFingerprintV1(execution.operations);
  const publish = () => f.createDecision(f.answer, { action: "execute", selectedTeammateIds: ["teammate_builtin_qa"],
    execution, participantManifest: f.pending.participantManifest });
  assert.throws(() => f.store.resolveChannelPendingOperation(f.input(), publish, f.now), /changed_frozen_plan/u);
  assert.deepEqual(f.store.listChannelIntentDecisions({ sourceItemId: f.answer.id }), []);
  assert.equal(f.store.getChannelPendingOperationResolution(f.decision.id), undefined);
  assert.equal(f.store.listRuns({ channelId: f.channel.id }).length, 0);
});

test("a pending snapshot cannot borrow a later answer as its original source", async t => {
  const f = await fixture(t), pending = structuredClone(f.pending), answer = f.store.getConversationItem(f.answer.id);
  pending.execution.operations[0].binding.sourceRefs = [{ itemId: answer.id, revision: answer.revision,
    actorType: "local_user", quote: answer.payload.body }];
  pending.execution.fingerprint = channelOperationPlanFingerprintV1(pending.execution.operations);
  pending.fingerprint = fingerprint(pending);
  assert.throws(() => f.createDecision(f.original, { action: "clarify", resultItemIds: [f.question.id],
    clarification: { missingFields: ["projectInputRoot"], question: f.question.body, pendingOperation: pending } }), /stale_draft_source/u);
});

test("an invalid publication and a synchronous thenable are rolled back", async t => {
  const f = await fixture(t); let thenCalls = 0;
  for (const publish of [
    () => f.createDecision(f.original, { action: "reply" }),
    () => ({ ...f.publish(), reason: "not the stored decision" }),
    () => ({ then: resolve => { thenCalls += 1; resolve(f.publish()); } }),
  ]) {
    assert.throws(() => f.store.resolveChannelPendingOperation(f.input(), publish, f.now), /invalid_publication|synchronous/u);
    assert.equal(f.store.getChannelPendingOperationResolution(f.decision.id), undefined);
    assert.deepEqual(f.store.listChannelIntentDecisions({ sourceItemId: f.answer.id }), []);
  }
  await new Promise(setImmediate);
  assert.equal(thenCalls, 0);
  assert.deepEqual(f.store.listChannelIntentDecisions({ sourceItemId: f.answer.id }), []);
});

test("a proposal and decision both roll back when publication fails", async t => {
  const f = await fixture(t);
  assert.throws(() => f.store.resolveChannelPendingOperation(f.input(), () => {
    f.store.createChannelExecutionProposal({ channelId: f.channel.id, sourceMessageId: f.answer.id,
      proposedByTeammateId: "teammate_builtin_qa", assigneeTeammateId: "teammate_builtin_qa", title: "Not dispatched",
      prompt: "Not dispatched", acceptanceCriteria: ["No tools"], collaborationSteps: [], requiredTools: [],
      riskSummary: "Temporary atomicity fixture", status: "draft" }, f.now);
    f.publish(); throw new Error("proposal rollback probe");
  }, f.now), /proposal rollback probe/u);
  assert.deepEqual(f.store.listChannelExecutionProposals({ channelId: f.channel.id }), []);
  assert.deepEqual(f.store.listChannelIntentDecisions({ sourceItemId: f.answer.id }), []);
});

test("eight concurrent Store connections publish exactly one decision", { timeout: 30_000 }, async t => {
  const f = await fixture(t), barrier = new SharedArrayBuffer(4), gate = new Int32Array(barrier), workers = [];
  const storedAnswer = f.store.getConversationItem(f.answer.id);
  const publication = { channelId: f.channel.id, sourceItemId: f.answer.id, contextProjection: f.projection(storedAnswer),
    action: "reply", status: "accepted", reason: "Concurrent pending resolution", createdBy: "model_policy" };
  t.after(async () => { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0); await Promise.all(workers.map(worker => worker.terminate())); });
  let ready = 0;
  const results = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
    const worker = new Worker(`const {parentPort,workerData}=require("node:worker_threads");
      (async()=>{const {createSqliteRunStore}=await import(workerData.coreUrl);const store=createSqliteRunStore(workerData.cwd);
      try{const gate=new Int32Array(workerData.barrier);parentPort.postMessage({ready:true});Atomics.wait(gate,0,0);
      let calls=0;const result=store.resolveChannelPendingOperation(workerData.input,()=>{calls++;return store.createChannelIntentDecision(workerData.publication,workerData.now)},workerData.now);
      parentPort.postMessage({id:result.decision.id,replayed:result.replayed,calls});}finally{store.close()}})().catch(e=>{throw e});`,
      { eval: true, workerData: { coreUrl: new URL("../dist/index.js", import.meta.url).href, cwd: f.cwd,
        input: f.input(), now: f.now, publication, barrier } });
    workers.push(worker); worker.on("error", reject);
    worker.on("message", message => {
      if (message.ready) { if (++ready === 8) { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0); } }
      else resolve(message);
    });
    worker.on("exit", code => { if (code) reject(new Error(`pending worker exit ${code}`)); });
  })));
  assert.equal(new Set(results.map(result => result.id)).size, 1);
  assert.equal(results.filter(result => !result.replayed).length, 1);
  assert.equal(results.reduce((sum, result) => sum + result.calls, 0), 1);
  assert.equal(f.store.listChannelIntentDecisions({ sourceItemId: f.answer.id }).length, 1);
});

for (const mode of ["reopen", "marker conflict", "schema conflict", "missing table"]) test(`pending migration: ${mode}`, t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL); INSERT INTO schema_migrations VALUES(190,'conversation_empty_fork_boundary')");
  const context = { database: db, hasMigration: version => Boolean(db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)),
    recordMigration: (version, name) => db.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(version, name) };
  assert.notEqual(CHANNEL_PENDING_OPERATION_MIGRATION_VERSION, 190);
  applyChannelPendingOperationMigration(context);
  if (mode === "marker conflict") db.prepare("UPDATE schema_migrations SET name='unrelated' WHERE version=?").run(CHANNEL_PENDING_OPERATION_MIGRATION_VERSION);
  if (mode === "schema conflict") db.exec("ALTER TABLE channel_pending_operation_resolutions ADD COLUMN unexpected TEXT");
  if (mode === "missing table") db.exec("DROP TABLE channel_pending_operation_resolutions");
  if (mode === "reopen") {
    applyChannelPendingOperationMigration(context);
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } else assert.throws(() => applyChannelPendingOperationMigration(context), /migration_(marker_conflict|schema_conflict|table_missing)/u);
  assert.equal(db.prepare("SELECT name FROM schema_migrations WHERE version=190").get().name, "conversation_empty_fork_boundary");
});

for (const consumed of [false, true]) test(`explicit channel deletion preserves its lifecycle with ${consumed ? "consumed" : "unconsumed"} pending data`, async t => {
  const f = await fixture(t);
  if (consumed) f.store.resolveChannelPendingOperation(f.input(), f.publish, f.now);
  assert.equal(f.store.deleteChannel(f.channel.id), true);
  assert.equal(f.store.getChannelIntentDecision(f.decision.id), undefined);
  assert.equal(f.store.getChannelPendingOperationResolution(f.decision.id), undefined);
});

test("the pending ledger is created after a legacy nullable manifest is rebuilt and survives reopen", async t => {
  const f = await fixture(t);
  f.store.close();
  const databasePath = core.resolveRuntimePaths(f.cwd).databasePath;
  const db = new DatabaseSync(databasePath);
  try {
    // Model the pre-191 draft schema that migration 114 already repairs.
    db.exec("DROP TABLE channel_pending_operation_resolutions; DELETE FROM schema_migrations WHERE version=191");
    const parentSql = db.prepare("SELECT sql FROM sqlite_master WHERE name='channel_intent_decisions'").get().sql;
    assert.match(parentSql, /participant_manifest_json TEXT NOT NULL/u);
    db.exec(parentSql.replace("CREATE TABLE channel_intent_decisions", "CREATE TABLE pending_fixture_manifest_nullable")
      .replace("participant_manifest_json TEXT NOT NULL", "participant_manifest_json TEXT"));
    db.exec(`INSERT INTO pending_fixture_manifest_nullable SELECT * FROM channel_intent_decisions;
      DROP TABLE channel_intent_decisions;
      ALTER TABLE pending_fixture_manifest_nullable RENAME TO channel_intent_decisions`);
  } finally { db.close(); }
  f.reopen();
  const upgraded = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const parents = upgraded.prepare("PRAGMA foreign_key_list(channel_pending_operation_resolutions)").all()
      .filter(row => row.from === "pending_decision_id" || row.from === "decision_id").map(row => row.table);
    assert.deepEqual(parents, ["channel_intent_decisions", "channel_intent_decisions"]);
    assert.deepEqual(upgraded.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { upgraded.close(); }
  f.reopen();
  assert.equal(f.store.resolveChannelPendingOperation(f.input(), f.publish, f.now).replayed, false);
  f.reopen();
  assert.equal(f.store.resolveChannelPendingOperation(f.input(), () => { throw new Error("must not republish"); }, f.now).replayed, true);
});
