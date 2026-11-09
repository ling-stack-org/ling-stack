import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { approvalSideEffectFingerprintV1, createApprovalResumeBasisV1 } from "../dist/approval-checkpoints.js";
import { captureHostRunCapacityWorkspaceIdentity } from "../dist/host-run-capacity-workspace-identity.js";
import { SqliteRuntimeHostCapacityStore } from "../dist/storage/sqlite/runtime-host-capacity-store.js";
import type { HostAttemptEffectObservation } from "../dist/host-attempt-completion-types.js";
import type { HostRunCapacityReservation } from "../dist/host-run-capacity-types.js";
import { hostCapacityFixture, hostCapacityWorkspace, realNow } from "./support/runtime-host-capacity-fixture.ts";
import { testDatabase } from "./support/sqlite-test-database.ts";

type ReleaseProof = {
  intent: { intentId: string };
  reservation: { token: string };
  source: { fencingToken: string };
  evidence: { dispatchToken: string; revokedAt: string; noHostLifetime: boolean };
  kind: string;
  createdAt: string;
  dispatchedAt?: string;
};

test("an exact first Pi source prepares one frozen durable intent and reopens without execution", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("intent");
  const before = f.executionSnapshot(), record = f.intent(current);
  assert.deepEqual(f.executionSnapshot(), before);
  assert.equal(record.intent.ownerKind, "attempt");
  assert.equal(record.intent.workspaceKey, f.identity.workspaceKey);
  assert.deepEqual(record.source, f.source(current));
  assert.ok(Object.isFrozen(record) && Object.isFrozen(record.source) && Object.isFrozen(record.intent));
  assert.deepEqual(f.intent(current), record);
  f.reopen();
  assert.deepEqual(f.journal.getIntent(record.intent.intentId), record);
  assert.deepEqual(host.host.counts(), { held: 0, released: 0, total: 0 });
});

test("a native profile uses its frozen provider and engine slots for Host admission", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("native-admission", {
    requestOverrides: { executionBinding: { kind: "native_profile", engineId: "kimi-acp", profileId: "fixture", profileRevision: 3 } },
  });
  const prepared = f.journal.prepareExecution({ source: f.source(current), now: f.at(3) });
  assert.ok(prepared.status === "prepared" || prepared.status === "duplicate", JSON.stringify(prepared));
  const reserved = f.bridge.reserveExecution({ source: f.source(current), now: f.at(4) });
  assert.ok(reserved.status === "reserved" || reserved.status === "duplicate", JSON.stringify(reserved));
  assert.equal(reserved.record.intent.authorityDigest, prepared.record.intent.authorityDigest);
  assert.equal(f.localAdmission(current, reserved.record), true);
  assert.equal(f.journal.getIntent(reserved.record.intent.intentId)?.dispatchedAt, f.at(4));
  assert.deepEqual(f.rows("runtime_semaphore_slots").map(row => [row.resource_type, row.resource_key]), [
    ["provider", "native:fixture:3"], ["runner", "kimi-acp"], ["channel_parallel", f.channel.id],
  ]);
});

test("a native Host reservation can be revoked before dispatch without starting the Attempt", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("native-no-dispatch", {
    requestOverrides: { executionBinding: { kind: "native_profile", engineId: "kimi-acp", profileId: "fixture", profileRevision: 1 } },
  });
  const reserved = f.bridge.reserveExecution({ source: f.source(current), now: f.at(3) });
  assert.ok(reserved.status === "reserved" || reserved.status === "duplicate", JSON.stringify(reserved));
  assert.equal(f.journal.prepareNoDispatchRelease({ intentId: reserved.record.intent.intentId, now: f.at(4) }).status, "prepared");
  assert.equal(f.bridge.flushRelease(reserved.record.intent.intentId, f.at(5)), true);
  assert.deepEqual(host.host.counts(), { held: 0, released: 1, total: 1 });
  assert.equal(f.journal.getIntent(reserved.record.intent.intentId)?.dispatchedAt, undefined);
});

test("a native manual resume reuses Host capacity only with the same thread and profile", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host);
  const parent = f.prepare("native-parent", {
    kind: "conversation_run",
    requestOverrides: { executionBinding: { kind: "native_profile", engineId: "kimi-acp", profileId: "fixture", profileRevision: 3 } },
  });
  const child = f.prepare("native-manual-resume", {
    kind: "conversation_run", thread: parent.thread!,
    requestOverrides: {
      executionBinding: { kind: "native_profile", engineId: "kimi-acp", profileId: "fixture", profileRevision: 3 },
      parentRunId: parent.run.id, continuationReason: "manual_resume",
    },
    runOverrides: { parentRunId: parent.run.id, continuationReason: "manual_resume" },
  });
  const prepared = f.journal.prepareExecution({ source: f.source(child), now: f.at(3) });
  assert.ok(prepared.status === "prepared" || prepared.status === "duplicate", JSON.stringify(prepared));
  const reserved = f.bridge.reserveExecution({ source: f.source(child), now: f.at(4) });
  assert.ok(reserved.status === "reserved" || reserved.status === "duplicate", JSON.stringify(reserved));

  const wrongProfile = f.prepare("native-manual-resume-wrong-profile", {
    kind: "conversation_run", thread: parent.thread!,
    requestOverrides: {
      executionBinding: { kind: "native_profile", engineId: "kimi-acp", profileId: "fixture", profileRevision: 4 },
      parentRunId: parent.run.id, continuationReason: "manual_resume",
    },
    runOverrides: { parentRunId: parent.run.id, continuationReason: "manual_resume" },
  });
  assert.equal(f.journal.prepareExecution({ source: f.source(wrongProfile), now: f.at(5) }).status, "changed");
});

test("a native intervention continuation requires its exact source and active intervention", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host);
  const parent = f.prepare("native-intervention-parent", {
    kind: "conversation_run",
    requestOverrides: { executionBinding: { kind: "native_profile", engineId: "kimi-acp", profileId: "fixture", profileRevision: 3 } },
  });
  const intervention = f.store.createRunIntervention({ sourceRunId: parent.run.id, sourceWorkUnitId: parent.unit.id,
    sourceAttemptId: parent.attempt.id, mode: "queue_followup", instruction: "Continue", idempotencyKey: "native-followup" }, f.at(3));
  assert.equal(f.store.updateRunInterventionStatus({ interventionId: intervention.id, expectedStatuses: ["queued"],
    status: "starting_continuation", startedAt: f.at(3), now: f.at(3) } )?.status, "starting_continuation");
  const child = f.prepare("native-intervention-child", {
    kind: "conversation_run", thread: parent.thread!,
    requestOverrides: {
      executionBinding: { kind: "native_profile", engineId: "kimi-acp", profileId: "fixture", profileRevision: 3 },
      parentRunId: parent.run.id, interventionId: intervention.id, continuationReason: "queue_followup",
    },
    runOverrides: { parentRunId: parent.run.id, interventionId: intervention.id, continuationReason: "queue_followup" },
  });
  const prepared = f.journal.prepareExecution({ source: f.source(child), now: f.at(4) });
  assert.ok(prepared.status === "prepared" || prepared.status === "duplicate", JSON.stringify(prepared));

  const wrongMode = f.prepare("native-intervention-wrong-mode", {
    kind: "conversation_run", thread: parent.thread!,
    requestOverrides: {
      executionBinding: { kind: "native_profile", engineId: "kimi-acp", profileId: "fixture", profileRevision: 3 },
      parentRunId: parent.run.id, interventionId: intervention.id, continuationReason: "interrupt_redirect",
    },
    runOverrides: { parentRunId: parent.run.id, interventionId: intervention.id, continuationReason: "interrupt_redirect" },
  });
  assert.equal(f.journal.prepareExecution({ source: f.source(wrongMode), now: f.at(5) }).status, "changed");
});

test("a retry before the durable intent creation time never creates an unattachable Host reservation", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("clock-regression");
  const record = f.intent(current), before = f.journalSnapshot();
  assert.equal(f.bridge.reserveAttempt({ source: f.source(current), now: f.at(2) }).status, "changed");
  assert.deepEqual(f.journalSnapshot(), before);
  assert.deepEqual(host.host.counts(), { held: 0, released: 0, total: 0 });
  assert.equal(f.bridge.reserveAttempt({ source: f.source(current), now: f.at(4) }).status, "reserved");
  assert.equal(f.journal.getIntent(record.intent.intentId)!.reservation!.reservedAt, f.at(4));
  assert.equal(f.bridge.reserveAttempt({ source: f.source(current), now: f.at(3) }).status, "changed");
  assert.equal(host.host.counts().held, 1);
});

for (const field of ["runId", "workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"]) {
  test(`prepare and gate reject a foreign ${field} without changing any resources`, async t => {
    const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare(`wrong-${field}`);
    const wrong = { ...f.source(current), [field]: "foreign-source" }, before = f.journalSnapshot();
    assert.equal(f.journal.prepareAttempt({ source: wrong, now: f.at(3) }).status, "changed");
    assert.deepEqual(f.journalSnapshot(), before);
    const record = f.reserve(current);
    testDatabase(f.store).exec("BEGIN IMMEDIATE");
    try { assert.equal(f.consume(current, record, { source: wrong }), false); }
    finally { testDatabase(f.store).exec("ROLLBACK"); }
    assert.equal(f.journal.getIntent(record.intent.intentId)!.dispatchedAt, undefined);
  });
}

test("the dispatch gate requires an owning transaction and the complete exact local admission group", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("group", { tools: ["read", "write"] });
  const record = f.reserve(current);
  assert.throws(() => f.consume(current, record), /transaction_required/u);
  for (const resource of ["provider", "runner", "channel_parallel", "task", "bound_path"]) {
    assert.equal(f.localAdmission(current, record, { omit: [resource] }), false, resource);
    f.noAdmission(current);
    assert.equal(f.journal.getIntent(record.intent.intentId)!.dispatchedAt, undefined);
  }
  assert.equal(f.localAdmission(current, record), true);
  assert.equal(f.journalFor(f.peer).getIntent(record.intent.intentId)!.dispatchedAt, f.at(4));
  assert.equal(f.rows("resource_leases").length, 2);
  assert.equal(f.rows("runtime_semaphore_slots").length, 3);
});

test("rolled-back resource admission rolls back the gate and committed admission consumes it only once", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("rollback");
  const record = f.reserve(current);
  assert.equal(f.localAdmission(current, record, { rollback: true }), true);
  f.noAdmission(current);
  assert.equal(f.journal.getIntent(record.intent.intentId)!.dispatchedAt, undefined);
  assert.equal(f.localAdmission(current, record), true);
  f.reopen();
  testDatabase(f.store).exec("BEGIN IMMEDIATE");
  try { assert.equal(f.consume(current, record), false); }
  finally { testDatabase(f.store).exec("ROLLBACK"); }
  assert.equal(f.journal.prepareNoDispatchRelease({ intentId: record.intent.intentId, now: realNow() }).status, "changed");
  assert.equal(host.host.counts().held, 1);
});

test("frozen input or current Attempt drift cannot reuse an existing intent", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("drift");
  const record = f.reserve(current), snapshot = testDatabase(f.store).prepare("SELECT request_snapshot_json FROM run_sessions WHERE id=?").get(current.run.id)!;
  assert.ok(typeof snapshot.request_snapshot_json === "string");
  const request: { runnerExecutionInput: { input: { task: { prompt: string } } } } = JSON.parse(snapshot.request_snapshot_json);
  request.runnerExecutionInput.input.task.prompt = "another task";
  testDatabase(f.store).prepare("UPDATE run_sessions SET request_snapshot_json=? WHERE id=?").run(JSON.stringify(request), current.run.id);
  assert.equal(f.journal.prepareAttempt({ source: f.source(current), now: f.at(4) }).status, "changed");
  assert.equal(f.localAdmission(current, record), false);
  f.noAdmission(current);
  assert.equal(host.host.counts().held, 1);
});

test("receipt attachment binds the entire Host reservation but does not grant dispatch after cancellation", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("receipt");
  const record = f.intent(current), result = host.host.reserve({ intent: record.intent, now: f.at(3) });
  assert.equal(result.status, "reserved");
  const reserved = result.reservation;
  for (const wrong of [{ ...reserved, state: "released" }, { ...reserved, token: "wrong" },
    { ...reserved, policyRevision: 0 }, { ...reserved, reservedAt: f.at(2) },
    { ...reserved, intent: { ...reserved.intent, authorityDigest: "f".repeat(64) } }]) {
    assert.equal(f.journal.attachReservation({ intentId: record.intent.intentId, reservation: wrong as HostRunCapacityReservation, now: f.at(4) }).status, "changed");
  }
  f.terminal(current, { started: false });
  const attached = f.journal.attachReservation({ intentId: record.intent.intentId, reservation: reserved, now: realNow() });
  assert.equal(attached.status, "attached");
  testDatabase(f.store).exec("BEGIN IMMEDIATE");
  try { assert.equal(f.consume(current, attached.record, { now: realNow() }), false); }
  finally { testDatabase(f.store).exec("ROLLBACK"); }
});

test("no-dispatch revokes the exact gate and atomically releases local resources before the outbox", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("no-dispatch");
  const record = f.reserve(current), group = f.resources(current, f.at(4));
  assert.ok(f.store.acquireResourceLease(group.leases[0]));
  assert.equal(f.store.acquireRuntimeSemaphoreSlots(group.semaphores).status, "acquired");
  testDatabase(f.store).exec("CREATE TRIGGER host_capacity_release_fault BEFORE UPDATE ON runtime_semaphore_slots BEGIN SELECT RAISE(ABORT,'release fault'); END");
  const before = f.journalSnapshot();
  assert.throws(() => f.journal.prepareNoDispatchRelease({ intentId: record.intent.intentId, now: realNow() }), /release fault/u);
  assert.deepEqual(f.journalSnapshot(), before);
  assert.equal(f.store.listResourceLeases({ status: "active" }).length, 1);
  testDatabase(f.store).exec("DROP TRIGGER host_capacity_release_fault");
  const release = f.journal.prepareNoDispatchRelease({ intentId: record.intent.intentId, now: realNow() });
  assert.equal(release.status, "prepared");
  assert.equal(release.release.kind, "no_dispatch");
  assert.equal(f.store.listResourceLeases({ status: "active" }).length, 0);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 0);
  assert.equal(host.host.counts().held, 1, "the workspace outbox alone never mutates the Host database");
  f.reopen();
  assert.ok(f.journal.getIntent(record.intent.intentId)!.revokedAt);
  assert.deepEqual(f.journal.listPendingReleases(), [release.release]);
  assert.equal(f.journal.prepareAttempt({ source: f.source(current), now: realNow() }).status, "changed");
});

test("logical terminal status, TTL expiry and a pending original lifetime never prove stopped", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("pending");
  const record = f.reserve(current), execution = f.begin(current, record);
  f.terminal(current);
  f.store.expireRuntimeSemaphoreSlots("2099-01-01T00:00:00.000Z");
  f.store.expireResourceLeases("2099-01-01T00:00:00.000Z");
  assert.equal(f.journal.prepareStoppedRelease({ intentId: record.intent.intentId, now: realNow() }).status, "changed");
  assert.equal(f.journal.prepareNoDispatchRelease({ intentId: record.intent.intentId, now: realNow() }).status, "changed");
  assert.equal(host.host.counts().held, 1);
  execution.lifetime.resolve();
  await execution.completion;
  f.store.releaseHostAttemptResources(f.source(current), realNow());
  f.reopen();
  const release = f.journal.prepareStoppedRelease({ intentId: record.intent.intentId, now: realNow() });
  assert.equal(release.status, "prepared");
  assert.equal(release.release.kind, "stopped");
});

for (const coverage of [false, { schemaVersion: 1, toolCallIds: ["unsettled-tool"], settledBuiltinReads: [] }] satisfies HostAttemptEffectObservation[]) {
  test(`a drained original Promise without positive effect coverage retains Host capacity: ${JSON.stringify(coverage)}`, async t => {
    const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("unverified");
    const record = f.reserve(current), execution = f.begin(current, record, { coverage });
    execution.lifetime.resolve();
    assert.ok((await execution.completion).drainedAt);
    f.terminal(current);
    f.store.releaseHostAttemptResources(f.source(current), realNow());
    assert.equal(f.journal.prepareStoppedRelease({ intentId: record.intent.intentId, now: realNow() }).status, "changed");
    assert.equal(host.host.counts().held, 1);
  });
}

test("unknown Host effects remain a veto even with a drained no-tool observation", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("unknown");
  const record = f.reserve(current), execution = f.begin(current, record);
  const ticket = f.store.admitHostOperation({ operationId: "unconfirmed-effect", source: f.source(current),
    kind: "command", toolCallId: "unconfirmed-command", admittedAt: realNow() });
  f.store.settleHostOperation(ticket, { kind: "unknown_outcome", code: "transport_lost", settledAt: realNow() });
  execution.lifetime.resolve();
  await execution.completion;
  f.terminal(current);
  f.store.releaseHostAttemptResources(f.source(current), realNow());
  assert.equal(f.journal.prepareStoppedRelease({ intentId: record.intent.intentId, now: realNow() }).status, "changed");
  assert.equal(host.host.counts().held, 1);
});

test("a drained terminal Attempt retains Host capacity until its pending approval is cancelled", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("pending-approval");
  const record = f.reserve(current), execution = f.begin(current, record), intentId = record.intent.intentId;
  const approval = f.store.createApprovalRequest({ runId: current.run.id, taskId: current.task.id,
    actionType: "bash", risk: "medium", title: "Pending command", description: "Awaiting a decision",
    payload: { type: "bash", command: "echo fixture", cwd: f.cwd, riskFlags: [] } }, realNow());
  execution.lifetime.resolve();
  await execution.completion;
  f.terminal(current);
  f.store.releaseHostAttemptResources(f.source(current), realNow());
  const before = f.journalSnapshot();
  assert.equal(f.journal.prepareStoppedRelease({ intentId, now: realNow() }).status, "changed");
  assert.deepEqual(f.journalSnapshot(), before);
  assert.equal(host.host.counts().held, 1);
  assert.equal(f.store.cancelApprovalRequest(approval.id, {}, realNow())!.status, "cancelled");
  assert.equal(f.journal.prepareStoppedRelease({ intentId, now: realNow() }).status, "prepared");
  assert.equal(f.bridge.flushRelease(intentId, realNow()), true);
});

test("an unanswered required question retains Host capacity despite terminal status and original drain", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host);
  const thread = f.store.createLingThread({ kind: "channel_discussion", channelId: f.channel.id,
    title: "Question source", objective: "Inspect safely" }, f.at(2));
  const current = f.prepare("pending-question", { kind: "conversation_run", thread });
  const turn = f.store.appendConversationUserTurn({ threadId: current.thread!.id, channelId: f.channel.id, title: "Question source",
    userInstruction: "Inspect safely", idempotencyKey: "question-source", payload: { body: "Inspect safely",
      format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, f.at(2));
  f.store.linkRunToLingTurn({ turnId: turn.turnId, runId: current.run.id, now: f.at(2) });
  const record = f.reserve(current), execution = f.begin(current, record), intentId = record.intent.intentId;
  f.store.createUserInputRequest({ sourceRunId: current.run.id, sourceItemId: turn.item.id, sourceFence: current.fence,
    toolCallId: "required-question", idempotencyKey: "required-question", toolInput: { schemaVersion: 1,
      waitMode: "required", questions: [{ questionId: "choice", prompt: "Choose", required: true,
        allowFreeText: true, options: [{ optionId: "yes", label: "Yes" }] }] } }, realNow());
  execution.lifetime.resolve();
  await execution.completion;
  f.terminal(current);
  f.store.releaseHostAttemptResources(f.source(current), realNow());
  const before = f.journalSnapshot();
  assert.equal(f.journal.prepareStoppedRelease({ intentId, now: realNow() }).status, "changed");
  assert.deepEqual(f.journalSnapshot(), before);
  assert.equal(host.host.counts().held, 1);
});

test("a committed required user-input yield releases the unique Host slot only after the original lifetime drains", async t => {
  const host = hostCapacityFixture(t, { maximum: 1 }), f = await hostCapacityWorkspace(t, host);
  const thread = f.store.createLingThread({ kind: "channel_discussion", channelId: f.channel.id,
    title: "Yield source", objective: "Wait for a choice" }, f.at(2));
  const current = f.prepare("yielded-question", { kind: "conversation_run", thread });
  const turn = f.store.appendConversationUserTurn({ threadId: thread.id, channelId: f.channel.id, title: "Yield source",
    userInstruction: "Wait for a choice", idempotencyKey: "yielded-question-source", payload: { body: "Wait for a choice",
      format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, f.at(2));
  f.store.linkRunToLingTurn({ turnId: turn.turnId, runId: current.run.id, now: f.at(2) });
  assert.equal(f.store.transitionTaskStatus({ taskId: current.task.id, expectedStatus: "todo", event: "claim",
    actor: "system", now: f.at(3) }).ok, true);
  assert.equal(f.store.transitionTaskStatus({ taskId: current.task.id, expectedStatus: "claimed", event: "start_run",
    actor: "system", currentRunId: current.run.id, now: f.at(4) }).ok, true);
  const record = f.reserve(current), execution = f.begin(current, record), intentId = record.intent.intentId;
  const request = f.store.createUserInputRequest({ sourceRunId: current.run.id, sourceItemId: turn.item.id, sourceFence: current.fence,
    toolCallId: "required-question", idempotencyKey: "required-question", toolInput: { schemaVersion: 1,
      waitMode: "required", questions: [{ questionId: "choice", prompt: "Choose", required: true,
        allowFreeText: true, options: [{ optionId: "yes", label: "Yes" }] }] } }, f.at(6)).request;
  const stoppedAt = realNow();
  assert.equal(f.store.commitUserInputYield({ threadId: thread.id, requestId: request.requestId, expectedRequestVersion: 1,
    sourceFence: current.fence, quiescence: { kind: "runner_quiesced", runnerId: current.attempt.runnerId,
      stoppedAt, lastRunEventSeq: 0 } }, realNow()).replayed, false);
  execution.lifetime.resolve();
  await execution.completion;
  const release = f.journal.prepareStoppedRelease({ intentId, now: realNow() });
  assert.equal(release.status, "prepared", JSON.stringify(release));
  assert.equal(release.release.kind, "stopped");
  assert.equal(host.host.counts().held, 1);
  assert.equal(f.bridge.flushRelease(intentId, realNow()), true);
  assert.deepEqual(host.host.counts(), { held: 0, released: 1, total: 1 });

  const successor = f.prepare("yielded-question-successor");
  const successorIntent = f.journal.prepareAttempt({ source: f.source(successor), now: realNow() });
  assert.equal(successorIntent.status, "prepared");
  const successorReservation = f.bridge.reserveAttempt({ source: f.source(successor), now: realNow() });
  assert.equal(successorReservation.status, "reserved", JSON.stringify(successorReservation));
});

test("an approval wait suspension releases Host capacity only after its lost Attempt is durably drained", async t => {
  const host = hostCapacityFixture(t, { maximum: 1 }), f = await hostCapacityWorkspace(t, host), current = f.prepare("approval-wait", { tools: ["bash"] });
  assert.equal(f.store.transitionTaskStatus({ taskId: current.task.id, expectedStatus: "todo", event: "claim",
    actor: "system", now: f.at(3) }).ok, true);
  assert.equal(f.store.transitionTaskStatus({ taskId: current.task.id, expectedStatus: "claimed", event: "start_run",
    actor: "system", currentRunId: current.run.id, now: f.at(4) }).ok, true);
  const record = f.reserve(current), execution = f.begin(current, record), source = f.source(current), createdAt = realNow();
  const payload = { type: "bash" as const, cwd: f.cwd, command: "printf approval-wait", riskFlags: [] };
  const approval = f.store.createApprovalRequest({ runId: current.run.id, taskId: current.task.id,
    toolCallId: "approval-wait-tool", actionType: "bash", risk: "medium", title: "Approval wait",
    description: payload.command, payload }, createdAt);
  const initialCheckpoint = f.store.getApprovalCheckpointForApproval(approval.id);
  assert.ok(initialCheckpoint);
  const resumeBasis = createApprovalResumeBasisV1({ approvalId: approval.id, runId: current.run.id,
    workUnitId: current.unit.id, priorAttemptId: current.attempt.id, toolCallId: approval.toolCallId!, actionType: "bash",
    sideEffectFingerprint: approvalSideEffectFingerprintV1({ actionType: "bash", toolCallId: approval.toolCallId!, sideEffect: payload }) });
  const checkpoint = f.store.updateApprovalCheckpointStatus(initialCheckpoint.id, { status: "pending", expectedStatus: "pending",
    expectedRevision: initialCheckpoint.revision, resumeBasis }, createdAt);
  if (!checkpoint || checkpoint.status !== "pending") throw new Error("approval checkpoint did not remain pending");
  const waitingAt = realNow();
  assert.equal(f.store.transitionWorkUnitStatus({ ...source, activeAttemptId: current.attempt.id,
    expectedStatus: "running", event: "approval_requested", actor: "system", now: waitingAt }).ok, true);
  assert.equal(f.store.transitionRunStatus({ runId: current.run.id, expectedStatus: "running", event: "approval_requested",
    actor: "system", now: waitingAt }).ok, true);
  const waitingAttempt = f.store.updateWorkUnitAttemptStatus({ ...source, status: "waiting_for_approval", now: waitingAt });
  assert.ok(waitingAttempt);
  assert.equal(waitingAttempt.status, "waiting_for_approval");
  const suspensionAt = realNow();
  const suspended = f.store.commitApprovalResumeSuspension({ kind: "approval_wait", checkpointId: checkpoint.id,
    expectedCheckpointStatus: checkpoint.status, expectedCheckpointRevision: checkpoint.revision, approvalId: approval.id,
    runId: current.run.id, expectedRunStatus: "waiting_for_approval", workUnitId: current.unit.id,
    expectedWorkUnitStatus: "waiting_for_approval", attemptId: current.attempt.id, cause: "daemon_restart", now: suspensionAt });
  assert.equal(suspended.ok, true, JSON.stringify(suspended));
  assert.equal(suspended.attempt.status, "lost");
  assert.equal(suspended.checkpoint.revision, checkpoint.revision + 1);
  execution.lifetime.resolve();
  await execution.completion;
  f.store.releaseHostAttemptResources(source, realNow());
  const release = f.journal.prepareStoppedRelease({ intentId: record.intent.intentId, now: realNow() });
  assert.equal(release.status, "prepared", JSON.stringify(release));
  assert.equal(release.release.kind, "stopped");
});

test("a replaced database or a credential from another workspace cannot operate the old journal", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("physical");
  const record = f.reserve(current);
  assert.throws(() => new SqliteRuntimeHostCapacityStore({ database: testDatabase(f.store) }, f.store,
    { ...f.identity, workspaceKey: "b".repeat(64) }), /database_identity_changed/u);
  const replacement = join(f.root, "replacement.sqlite");
  copyFileSync(f.paths.databasePath, replacement);
  renameSync(replacement, f.paths.databasePath);
  assert.throws(() => f.journal.getIntent(record.intent.intentId), /database_identity_changed/u);
  const replacementIdentity = captureHostRunCapacityWorkspaceIdentity({ workspaceId: f.workspaceId,
    cwd: f.cwd, databasePath: f.paths.databasePath });
  assert.throws(() => new SqliteRuntimeHostCapacityStore({ database: testDatabase(f.store) }, f.store,
    replacementIdentity), /database_identity_changed/u);
  assert.equal(host.host.counts().held, 1);
});

test("a raw untracked SQLite connection cannot create the Host journal", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), database = new DatabaseSync(f.paths.databasePath);
  t.after(() => database.close());
  assert.throws(() => new SqliteRuntimeHostCapacityStore({ database }, f.store, f.identity), /database_identity_changed/u);
  assert.deepEqual(f.journalSnapshot(), [[], []]);
});

test("outbox proofs bind the exact intent, reservation, source, gate, kind and creation time even if rehashed", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("proof");
  const record = f.reserve(current), intentId = record.intent.intentId;
  assert.equal(f.journal.prepareNoDispatchRelease({ intentId, now: realNow() }).status, "prepared");
  const original = f.rows("runtime_host_capacity_releases")[0];
  assert.ok(typeof original.proof_json === "string");
  const originalProof: ReleaseProof = JSON.parse(original.proof_json);
  const mutations: ((proof: ReleaseProof) => void)[] = [proof => { proof.intent.intentId = "foreign-intent"; },
    proof => { proof.reservation.token = "f".repeat(64); }, proof => { proof.source.fencingToken = "foreign-fence"; },
    proof => { proof.evidence.dispatchToken = "f".repeat(64); }, proof => { proof.kind = "stopped"; },
    proof => { proof.createdAt = f.at(2); }, proof => { proof.evidence.revokedAt = f.at(2); },
    proof => { proof.evidence.noHostLifetime = false; }, proof => { proof.dispatchedAt = f.at(4); }];
  for (const mutate of mutations) {
    const proof = structuredClone(originalProof);
    mutate(proof);
    const json = JSON.stringify(proof), digest = createHash("sha256").update(json).digest("hex");
    testDatabase(f.store).prepare("UPDATE runtime_host_capacity_releases SET proof_json=?,proof_digest=? WHERE intent_id=?")
      .run(json, digest, intentId);
    assert.throws(() => f.journal.getRelease(intentId), /release_invalid/u);
    assert.throws(() => f.bridge.flushRelease(intentId, realNow()), /release_invalid/u);
    assert.equal(host.host.counts().held, 1);
  }
  testDatabase(f.store).prepare("UPDATE runtime_host_capacity_releases SET proof_json=?,proof_digest=? WHERE intent_id=?")
    .run(original.proof_json, original.proof_digest, intentId);
  assert.equal(f.bridge.flushRelease(intentId, realNow()), true);
});

test("stopped release rejects pre-dispatch starts, reversed Attempt times and reversed original Host lifetimes", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("time-order");
  const record = f.reserve(current), execution = f.begin(current, record), intentId = record.intent.intentId;
  execution.lifetime.resolve();
  await execution.completion;
  f.terminal(current);
  f.store.releaseHostAttemptResources(f.source(current), realNow());
  const completion = f.store.getHostAttemptCompletion(f.source(current));
  const change = (sql: string, value: SQLInputValue) => testDatabase(f.store).prepare(sql).run(value, current.attempt.id);
  change("UPDATE work_unit_attempts SET started_at=? WHERE id=?", f.at(2));
  assert.equal(f.journal.prepareStoppedRelease({ intentId, now: realNow() }).status, "changed");
  change("UPDATE work_unit_attempts SET started_at=? WHERE id=?", f.at(5));
  change("UPDATE work_unit_attempts SET ended_at=? WHERE id=?", f.at(4));
  assert.equal(f.journal.prepareStoppedRelease({ intentId, now: realNow() }).status, "changed");
  change("UPDATE work_unit_attempts SET ended_at=? WHERE id=?", realNow());
  for (const invalid of [{ ...completion, registeredAt: f.at(2) }, { ...completion, drainedAt: f.at(3) }]) {
    const ports = new Proxy(f.store, { get(target, key) {
      if (key === "getHostAttemptCompletion") return () => invalid;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const journal = new SqliteRuntimeHostCapacityStore({ database: testDatabase(f.store) }, ports, f.identity);
    assert.equal(journal.prepareStoppedRelease({ intentId, now: realNow() }).status, "changed");
  }
  assert.equal(f.journal.prepareStoppedRelease({ intentId, now: realNow() }).status, "prepared");
  assert.equal(f.bridge.flushRelease(intentId, realNow()), true);
});

test("nested journal and bridge calls never roll back the caller's transaction", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("nested");
  const record = f.reserve(current);
  testDatabase(f.store).exec("BEGIN IMMEDIATE");
  try {
    testDatabase(f.store).prepare("UPDATE tasks SET title='outer transaction' WHERE id=?").run(current.task.id);
    assert.throws(() => f.journal.prepareAttempt({ source: f.source(current), now: realNow() }), /within a transaction/u);
    assert.throws(() => f.bridge.flushRelease(record.intent.intentId, realNow()), /nested_handoff/u);
    assert.equal(testDatabase(f.store).isTransaction, true);
    assert.equal(f.store.getTask(current.task.id)!.title, "outer transaction");
  } finally { testDatabase(f.store).exec("ROLLBACK"); }
  host.host.database.exec("BEGIN IMMEDIATE");
  try {
    assert.throws(() => f.bridge.reserveAttempt({ source: f.source(current), now: realNow() }), /nested_handoff/u);
    assert.equal(host.host.database.isTransaction, true);
  } finally { host.host.database.exec("ROLLBACK"); }
});
