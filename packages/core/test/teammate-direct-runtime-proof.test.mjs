import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  approvalSideEffectFingerprintV1,
  createApprovalResumeBasisV1,
  createSqliteRunStore,
  DEFAULT_WORKSPACE_ID,
  toRuntimeAttemptFence,
} from "../dist/index.js";

const now = "2026-10-16T08:00:00.000Z";
const later = "2026-10-16T08:01:00.000Z";
const terminalAt = "2026-10-16T08:02:00.000Z";
const engineer = "teammate_builtin_engineer";
const designer = "teammate_builtin_designer";

/** Store-level admission fixture, not a Runner, tool-execution or recovery success claim. */
async function fixture(t, options = {}) {
  const parent = await realpath(tmpdir());
  const cwd = await realpath(await mkdtemp(join(parent, "ling-a28-proof-")));
  const store = createSqliteRunStore(cwd);
  const db = new DatabaseSync(store.paths.databasePath);
  db.exec("PRAGMA busy_timeout=1");
  t.after(async () => {
    db.close();
    store.close();
    assert.equal(dirname(cwd), parent);
    assert.ok(basename(cwd).startsWith("ling-a28-proof-"));
    await rm(cwd, { recursive: true, force: true });
  });
  return { cwd, store, db, ...owner({ cwd, store, db }, options) };
}

/** Freeze native source + canonical Turn/input before constructing any WorkUnit or Run. */
function owner(f, { teammateId = engineer, suffix = "primary", withRun = true, withAttempt = withRun, contextViewId } = {}) {
  const { store, cwd, db } = f;
  const direct = store.getOrCreateTeammateDirectThread(teammateId, now);
  const source = store.createTeammateDirectMessage({ threadId: direct.id, teammateId,
    authorType: "local-user", authorId: "local-user", body: "Read README.md", status: "ready" }, now);
  const reply = store.createTeammateDirectMessage({ threadId: direct.id, teammateId,
    authorType: "ai-teammate", authorId: teammateId, body: "", status: "pending" }, now);
  const thread = store.createLingThread({ kind: "teammate_direct", teammateId,
    title: "Private proof boundary", objective: "Test immutable private execution ownership" }, now);
  const accepted = store.appendTeammateDirectUserTurnWithInputSnapshot({ threadId: thread.id, teammateId,
    itemId: source.id, turnId: `proof-turn-${suffix}`, title: "Read source", userInstruction: source.body,
    idempotencyKey: `proof-input-${suffix}`, domainRefs: [{ type: "message", id: source.id }],
    payload: { body: source.body, format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
    executionInput: { prompt: source.body, systemPrompt: "Use only this private source" },
  }, now);
  const request = { cwd, teammateId, threadId: thread.id, turnId: accepted.turnId,
    teammateDirectInputRef: { id: accepted.inputSnapshot.id, fingerprint: accepted.inputSnapshot.fingerprint },
    ...(contextViewId ? { harnessFeatureSnapshot: { continuations: "enforce" } } : {}),
    sourceMessageId: source.id, linkedMessageId: reply.id,
    task: { id: source.id, title: "Read source", prompt: accepted.inputSnapshot.payload.prompt } };
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "teammate_direct_reply",
    ownerType: "teammate_direct_message", ownerId: source.id, teammateId, taskId: source.id,
    linkedMessageId: reply.id, runnerId: "pi", idempotencyKey: `proof-unit-${suffix}`,
    status: withAttempt ? "running" : "queued", createdByActor: "system", request, now });
  const attempt = withAttempt ? store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: `proof-runtime-${suffix}`, runnerId: "pi", status: "started", now }) : undefined;
  const fence = attempt ? toRuntimeAttemptFence(attempt) : undefined;
  const run = withRun ? store.createRun({ id: `proof-run-${suffix}`, cwd, taskId: source.id,
    teammateId, threadId: thread.id, turnId: accepted.turnId, workUnitId: unit.id,
    providerName: "fixture", providerModel: "fixture", taskSnapshot: request.task,
    providerSnapshot: {}, requestSnapshot: request, contextViewId, createdAt: now }) : undefined;
  if (run) {
    store.linkRunToWorkUnit(run.id, unit.id, now);
    store.markRunStarted(run.id, now);
    assert.equal(store.getLingTurnForRun(run.id).id, accepted.turnId);
    assert.equal(store.listLingTurnRuns(accepted.turnId).filter(link => link.runId === run.id).length, 1);
  }
  assert.equal(store.getTeammateDirectInputSnapshot(accepted.item.id, teammateId).fingerprint, accepted.inputSnapshot.fingerprint);
  const scope = { workspaceId: DEFAULT_WORKSPACE_ID, teammateId, threadId: direct.id, messageId: reply.id };
  const observe = (overrides = {}) => store.getTeammateDirectMessageRuntimeObservation({ ...scope, ...overrides });
  const row = () => db.prepare("SELECT * FROM teammate_direct_messages WHERE id=?").get(reply.id);
  const execute = (expected, sourceFence = fence, body = "owned progress") => store.commitTeammateDirectMessageRuntime({ expected,
    operation: { kind: "execution", fence: sourceFence, patch: { body, status: "pending", linkedRunId: run.id, errorMessage: null } } }, later);
  return { teammateId, direct, source, reply, thread, accepted, request, unit, attempt, fence, run, scope, observe, row, execute };
}

/** Deliberately omit suspension commit: waiting strings alone must never prove a logical wait. */
function enterApprovalWait(f) {
  assert.equal(f.store.transitionRunExecutionStatus({ runId: f.run.id, sourceFence: f.fence,
    expectedStatus: "running", event: "approval_requested", actor: "system", now: later }).ok, true);
  assert.equal(f.store.transitionWorkUnitStatus({ ...f.fence, expectedStatus: "running",
    event: "approval_requested", actor: "system", now: later }).ok, true);
  assert.equal(f.store.updateWorkUnitAttemptStatus({ ...f.fence, status: "waiting_for_approval", now: later }).status, "waiting_for_approval");
}

function activeApproval(f, basisOverrides = {}) {
  const approval = f.store.createExecutionApprovalRequest({ runId: f.run.id, taskId: f.source.id,
    toolCallId: "read-proof", actionType: "read", risk: "low", title: "Read approval", description: "Read README.md",
    payload: { type: "tool_call", toolName: "read", cwd: f.cwd, input: { path: "README.md" } } }, f.fence, now);
  const checkpoint = f.store.getApprovalCheckpointForApproval(approval.id);
  const resumeBasis = createApprovalResumeBasisV1({ approvalId: approval.id, runId: f.run.id,
    workUnitId: f.unit.id, priorAttemptId: f.attempt.id, toolCallId: approval.toolCallId, actionType: approval.actionType,
    sideEffectFingerprint: approvalSideEffectFingerprintV1({ actionType: approval.actionType,
      toolCallId: approval.toolCallId, sideEffect: approval.payload }), ...basisOverrides });
  const updated = f.store.updateApprovalCheckpointStatus(checkpoint.id, { status: "pending", expectedStatus: "pending",
    expectedRevision: checkpoint.revision, resumeBasis }, now);
  assert.ok(updated);
  return { approval, checkpoint: updated };
}

function assertIndeterminateCannotWrite(f) {
  const expected = f.observe();
  assert.equal(expected.state.kind, "indeterminate");
  const before = f.row();
  for (const status of ["pending", "ready", "failed"]) {
    const result = f.store.commitTeammateDirectMessageRuntime({ expected, operation: { kind: "reconcile",
      patch: { body: "not supported by proof", status, linkedRunId: f.run.id, errorMessage: null } } }, terminalAt);
    assert.notEqual(result.kind, "applied");
    assert.notEqual(result.kind, "unchanged");
    assert.deepEqual(f.row(), before);
  }
}

test("A28 canonical private input and full live fence permit initial link and pending progress", async t => {
  const f = await fixture(t);
  const first = f.observe({ runId: f.run.id });
  assert.equal(first.message.linkedRunId, undefined);
  assert.equal(first.state.kind, "active");
  assert.deepEqual(toRuntimeAttemptFence(first.attempt), f.fence);
  assert.equal(f.execute(first).kind, "applied");
  assert.equal(f.row().linked_run_id, f.run.id);
  f.store.appendExecutionEvent(f.run.id, f.fence, "assistant_text_delta", { text: "real durable progress" });
  const next = f.observe();
  assert.ok(next.lastRunEventSeq > first.lastRunEventSeq);
  const applied = f.execute(next, f.fence, "real durable progress");
  assert.equal(applied.kind, "applied");
  assert.equal(f.row().body, "real durable progress");
  assert.equal(f.row().status, "pending");
});

for (const field of ["workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"]) {
  test(`A28 active private callback rejects a foreign ${field} without touching its row`, async t => {
    const f = await fixture(t);
    const expected = f.observe({ runId: f.run.id }), before = f.row();
    const result = f.execute(expected, { ...f.fence, [field]: "foreign-owner" });
    assert.equal(result.kind, "invalid_proof");
    assert.deepEqual(f.row(), before);
  });
}

test("A28 lost Attempt and runtime_suspend text without a suspension commit cannot write or prove waiting", async t => {
  const f = await fixture(t);
  assert.equal(f.execute(f.observe()).kind, "applied");
  const captured = f.observe();
  const lost = f.store.updateWorkUnitAttemptStatus({ ...f.fence, status: "lost", endedAt: later, now: later,
    errorCode: "runtime_suspend", errorMessage: "This is deliberately not a committed approval suspension" });
  assert.equal(lost.status, "lost");
  const before = f.row();
  assert.equal(f.execute(captured).kind, "stale");
  assert.equal(f.execute(f.observe()).kind, "invalid_proof");
  assert.deepEqual(f.row(), before);
  assertIndeterminateCannotWrite(f);
});

test("A28 a real successor claim fences an old callback even with a freshly read observation", async t => {
  const f = await fixture(t);
  assert.equal(f.execute(f.observe()).kind, "applied");
  const captured = f.observe();
  const successor = f.store.createWorkUnitAttempt({ workUnitId: f.unit.id, attemptNumber: 2,
    runtimeInstanceId: "successor-runtime", runnerId: "pi", status: "started", now: later });
  assert.equal(f.store.getWorkUnitAttempt(f.attempt.id).status, "lost");
  assert.equal(f.store.getWorkUnit(f.unit.id).activeAttemptId, successor.id);
  const before = f.row();
  assert.equal(f.execute(captured).kind, "stale");
  assert.equal(f.execute(f.observe()).kind, "invalid_proof");
  assert.deepEqual(f.row(), before);
  assert.equal(f.execute(f.observe(), toRuntimeAttemptFence(successor), "successor owns progress").kind, "applied");
  assert.equal(f.row().body, "successor owns progress");
});

test("A28 real terminal transitions reject execution callbacks and only Host reconciliation closes the message", async t => {
  const f = await fixture(t);
  assert.equal(f.execute(f.observe()).kind, "applied");
  const captured = f.observe();
  assert.equal(f.store.transitionRunExecutionStatus({ runId: f.run.id, sourceFence: f.fence, expectedStatus: "running",
    event: "runner_failed", actor: "runner", now: terminalAt, endedAt: terminalAt, errorMessage: "fixture failure" }).ok, true);
  assert.equal(f.store.transitionWorkUnitAttemptTerminal({ ...f.fence, event: "runner_failed", attemptStatus: "failed",
    runtimeEventType: "work_unit_failed", actor: "system", now: terminalAt, errorCode: "fixture_failure" }), true);
  const terminal = f.observe();
  assert.deepEqual(terminal.state, { kind: "terminal", status: "failed" });
  const before = f.row();
  assert.equal(f.execute(captured).kind, "stale");
  assert.equal(f.execute(terminal).kind, "invalid_proof");
  assert.deepEqual(f.row(), before);
  const closed = f.store.commitTeammateDirectMessageRuntime({ expected: terminal, operation: { kind: "reconcile",
    patch: { body: "fixture failure", status: "failed", errorMessage: "fixture failure", linkedRunId: f.run.id } } }, terminalAt);
  assert.equal(closed.kind, "applied");
  assert.equal(f.row().status, "failed");
  const finalRow = f.row();
  assert.equal(f.execute(f.observe()).kind, "invalid_proof");
  assert.deepEqual(f.row(), finalRow);
});

test("A28 created WorkUnit discovery blocks pre-dispatch blocked writes before writeReady links a Run", async t => {
  const f = await fixture(t, { withRun: false });
  const expected = f.observe(), before = f.row();
  assert.equal(expected.message.linkedRunId, undefined);
  assert.equal(expected.workUnit.id, f.unit.id);
  assert.notEqual(expected.state.kind, "unlinked");
  const result = f.store.commitTeammateDirectMessageRuntime({ expected, operation: { kind: "pre_dispatch",
    patch: { body: "late web progress must not block dispatched ownership", status: "blocked" } } }, later);
  assert.equal(result.kind, "invalid_proof");
  assert.deepEqual(f.row(), before);
});

test("A28 approval waiting strings with no checkpoint remain indeterminate", async t => {
  const f = await fixture(t);
  enterApprovalWait(f);
  assert.equal(f.store.listApprovalCheckpoints({ runId: f.run.id }).length, 0);
  assertIndeterminateCannotWrite(f);
});

test("A28 another private participant's valid active approval is not proof for this Run", async t => {
  const f = await fixture(t);
  const foreign = { cwd: f.cwd, store: f.store, ...owner(f, { teammateId: designer, suffix: "foreign" }) };
  activeApproval(foreign);
  enterApprovalWait(foreign);
  assert.equal(foreign.observe().state.kind, "active", "foreign fixture has real owned approval metadata, not a fake wait");
  enterApprovalWait(f);
  assertIndeterminateCannotWrite(f);
});

test("A28 a well-formed fingerprint cannot authorize an approval basis from a different WorkUnit", async t => {
  const f = await fixture(t);
  activeApproval(f, { workUnitId: "foreign-work-unit" });
  enterApprovalWait(f);
  assertIndeterminateCannotWrite(f);
});

test("A28 corrupt checkpoint JSON withdraws approval proof instead of producing logical waiting", async t => {
  const f = await fixture(t);
  const { checkpoint } = activeApproval(f);
  enterApprovalWait(f);
  assert.equal(f.observe().state.kind, "active", "the uncorrupted source/approval fixture must first be valid");
  // One scoped disposable corruption is adversarial input, never synthetic suspension/recovery evidence.
  f.db.prepare("UPDATE approval_checkpoints SET resume_basis_json=? WHERE id=?").run('{"schemaVersion":1,"fingerprint":"corrupt"}', checkpoint.id);
  assert.equal(f.store.getApprovalCheckpoint(checkpoint.id).resumeBasis, undefined);
  assertIndeterminateCannotWrite(f);
});

for (const withAttempt of [false, true]) {
  test(`A28 durable standalone cancellation reconciles the original native reply (Attempt=${withAttempt})`, async t => {
    const f = await fixture(t, { withRun: false, withAttempt });
    const cancelling = f.store.transitionWorkUnitStatus({ ...(f.fence ?? { workUnitId: f.unit.id }),
      expectedStatus: withAttempt ? "running" : "queued", event: "cancel", actor: "local-user", now: later });
    assert.equal(cancelling.ok, true);
    assert.equal(f.observe().state.kind, "indeterminate", "cancelling is not durable terminal proof");
    if (withAttempt) {
      assert.equal(f.store.transitionWorkUnitAttemptTerminal({ ...f.fence, event: "runner_cancelled", attemptStatus: "cancelled",
        runtimeEventType: "work_unit_cancelled", actor: "system", now: terminalAt }), true);
    } else {
      assert.equal(f.store.transitionWorkUnitStatus({ workUnitId: f.unit.id, expectedStatus: "cancelling", event: "runner_cancelled",
        actor: "system", now: terminalAt, endedAt: terminalAt }).ok, true);
    }
    const expected = f.observe({ workUnitId: f.unit.id });
    assert.equal(expected.run, undefined);
    assert.deepEqual(expected.state, { kind: "terminal", status: "cancelled" });
    const input = { expected, operation: { kind: "reconcile", patch: { body: "Reply stopped", status: "cancelled",
      errorMessage: "Reply stopped", linkedRunId: null } } };
    assert.equal(f.store.commitTeammateDirectMessageRuntime(input, terminalAt).kind, "applied");
    const before = f.row();
    assert.equal(before.status, "cancelled");
    assert.equal(before.linked_run_id, null);
    assert.equal(f.observe().state.kind, "terminal", "read-only native scope discovers the same committed cancellation");
    const replay = f.store.commitTeammateDirectMessageRuntime({ ...input, expected: f.observe({ workUnitId: f.unit.id }) },
      "2026-10-16T08:03:00.000Z");
    assert.equal(replay.kind, "unchanged");
    assert.deepEqual(f.row(), before);
  });
}

const jsonHash = value => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

/**
 * Real Core claim/suspension/terminal transactions, not SDK dispatch/recovery.
 * Replay payloads model only the sealed ownership subprotocol read by Core;
 * the Daemon integration owns validation/execution of complete replay inputs.
 */
async function approvalChainFixture(t, hops = 2) {
  const f = await fixture(t, { contextViewId: "proof-chain-context" });
  assert.equal(f.execute(f.observe()).kind, "applied");
  const { approval, checkpoint: rootCheckpoint } = activeApproval(f);
  enterApprovalWait(f);
  const tick = second => new Date(Date.parse(later) + second * 1_000).toISOString();
  assert.equal(f.store.approveApprovalRequest(approval.id, { reason: "Core chain proof" }, tick(1)).status, "approved");
  const claims = [];
  let source = f.store.getWorkUnitAttempt(f.attempt.id);
  for (let n = 1; n <= hops; n += 1) {
    const checkpoint = f.store.getApprovalCheckpoint(rootCheckpoint.id), at = tick(2 * n);
    const replayBody = { schemaVersion: 1, boundary: "runner-continuation-replay", runId: f.run.id,
      rootRunId: f.run.id, sourceRunId: f.run.id, workUnitId: f.unit.id, sourceWorkUnitId: f.unit.id,
      origin: "approval_resume", contextViewId: f.run.contextViewId, runnerId: "pi", runnerCapabilityRevision: "pi:chain-proof",
      sourceFence: toRuntimeAttemptFence(source),
      priorAttempt: { status: source.status, ...(source.endedAt ? { endedAt: source.endedAt } : {}),
        ...(source.errorCode ? { errorCode: source.errorCode } : {}) },
      approvalEvidence: [{ approvalId: approval.id, decision: "approved", sideEffectFingerprint: rootCheckpoint.resumeBasis.sideEffectFingerprint }] };
    const replay = { ...replayBody, fingerprint: jsonHash(replayBody) };
    const artifact = f.store.createArtifact({ runId: f.run.id, type: "json", path: `proof-chain-${n}.json`,
      contentType: "application/vnd.ling.runner-continuation-replay+json", sealedPayload: replay, createdAt: at });
    const targetId = `proof-chain-attempt-${n + 1}`;
    const claim = f.store.commitApprovalResumeClaim({ checkpointId: checkpoint.id,
      expectedCheckpointStatus: checkpoint.status, expectedCheckpointRevision: checkpoint.revision,
      approvalId: approval.id, runId: f.run.id, workUnitId: f.unit.id,
      expectedActiveAttemptId: source.id, attemptToLoseId: source.id,
      continuationPreparation: { runId: f.run.id, workUnitId: f.unit.id, sourceFence: toRuntimeAttemptFence(source),
        expectedTargetAttemptId: source.id, origin: "approval_resume", strategy: "deterministic_replay", runnerId: "pi",
        runnerCapabilityRevision: "pi:chain-proof", contextViewId: f.run.contextViewId, contextSnapshotArtifactId: artifact.id,
        idempotencyKey: `runner-continuation:${f.run.id}:${source.id}:approval_resume:0:${approval.id}`, generation: 0,
        targetAttempt: { id: targetId, runtimeInstanceId: `proof-chain-runtime-${n + 1}`, runnerId: "pi", effectiveRunnerId: "pi" }, now: at },
      runnerResumeHandle: { kind: "ling_continuation", verified: true, runId: f.run.id, runnerId: "pi", attemptId: targetId,
        payload: { schemaVersion: 1, approvalId: approval.id, resumeBasisFingerprint: rootCheckpoint.resumeBasis.fingerprint } },
      mode: n === 1 ? "activate_waiting" : "replace_running", now: at });
    assert.equal(claim.ok, true, JSON.stringify(claim));
    claims.push({ ...claim, artifact });
    if (n < hops) {
      const suspended = f.store.commitApprovalResumeSuspension({ kind: "resume_pre_dispatch", checkpointId: checkpoint.id,
        expectedCheckpointStatus: "resume_pending", expectedCheckpointRevision: claim.checkpoint.revision,
        approvalId: approval.id, runId: f.run.id, workUnitId: f.unit.id,
        expectedRunStatus: "running", expectedWorkUnitStatus: "running", attemptId: claim.attempt.id,
        cause: "daemon_restart", now: tick(2 * n + 1) });
      assert.equal(suspended.ok, true, JSON.stringify(suspended));
      source = suspended.attempt;
    }
  }
  const last = claims.at(-1), sourceFence = toRuntimeAttemptFence(last.attempt);
  const lease = { continuationId: last.runnerContinuation.id, claimOwner: "proof-chain-host", claimToken: "proof-chain-claim" };
  const claimed = f.store.claimRunnerContinuation({ ...lease, expectedRevision: 0,
    claimExpiresAt: tick(2 * hops + 60), now: tick(2 * hops) });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  const started = f.store.startRunnerContinuation({ ...lease, expectedRevision: claimed.value.revision,
    targetFence: sourceFence, now: tick(2 * hops + 1) });
  assert.equal(started.ok, true, JSON.stringify(started));
  f.store.appendExecutionEvent(f.run.id, sourceFence, "assistant_text_delta", { text: "Durable chain conclusion" });
  const terminal = f.store.commitApprovalResumeTerminal({ kind: "verified_lineage", checkpointId: rootCheckpoint.id,
    expectedCheckpointStatus: "resume_pending", expectedCheckpointRevision: last.checkpoint.revision,
    approvalId: approval.id, runId: f.run.id, workUnitId: f.unit.id, expectedRunStatus: "running", expectedWorkUnitStatus: "running",
    attemptId: last.attempt.id, status: "succeeded", attemptStatus: "succeeded", checkpointStatus: "resumed",
    runnerContinuationTerminal: { ...lease, expectedRevision: started.value.revision, expectedState: "running", targetFence: sourceFence },
    now: tick(2 * hops + 2) });
  assert.equal(terminal.ok, true, JSON.stringify(terminal));
  assert.equal(terminal.checkpoint.resumeBasis.priorAttemptId, f.attempt.id, "the immutable approval root remains A");
  return { ...f, approval, rootCheckpoint, claims, first: claims[0], last, tick };
}

function corruptReplay(f, mutate, updateDigest = true) {
  const artifact = f.store.getArtifact(f.last.artifact.id), replay = structuredClone(artifact.sealedPayload);
  mutate(replay);
  const { fingerprint: _old, ...body } = replay;
  replay.fingerprint = jsonHash(body);
  f.db.prepare("UPDATE artifacts SET sealed_payload_json=?,content_sha256=? WHERE id=?").run(
    JSON.stringify(replay), updateDigest ? jsonHash(replay) : artifact.contentSha256, artifact.id);
}

function duplicatePredecessor(f) {
  const row = f.db.prepare("SELECT * FROM runner_continuations WHERE id=?").get(f.first.runnerContinuation.id);
  row.id = "proof-chain-duplicate";
  row.idempotency_key = `${row.idempotency_key}:duplicate`;
  const keys = Object.keys(row);
  f.db.prepare(`INSERT INTO runner_continuations (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map(key => row[key]));
}

test("A28 terminal approval proof follows A to suspended B to C without rebasing the checkpoint", async t => {
  const f = await approvalChainFixture(t);
  const expected = f.observe();
  assert.deepEqual(expected.state, { kind: "terminal", status: "succeeded" });
  const result = f.store.commitTeammateDirectMessageRuntime({ expected, operation: { kind: "reconcile",
    patch: { body: "Durable chain conclusion", status: "ready", linkedRunId: f.run.id, errorMessage: null } } }, f.tick(7));
  assert.equal(result.kind, "applied");
  assert.equal(f.row().status, "ready");
});

const chainCorruptions = [
  ["missing predecessor", f => f.db.prepare("DELETE FROM runner_continuations WHERE id=?").run(f.first.runnerContinuation.id)],
  ["missing latest continuation", f => f.db.prepare("DELETE FROM runner_continuations WHERE id=?").run(f.last.runnerContinuation.id)],
  ["missing all enforced continuations", f => f.db.prepare("DELETE FROM runner_continuations WHERE run_id=?").run(f.run.id)],
  ["ambiguous predecessor", duplicatePredecessor],
  ["cycle", f => f.db.prepare("UPDATE runner_continuations SET source_attempt_id=? WHERE id=?").run(f.last.attempt.id, f.first.runnerContinuation.id)],
  ["nonconsecutive attempt number", f => f.db.prepare("UPDATE work_unit_attempts SET attempt_number=77 WHERE id=?").run(f.last.attempt.id)],
  ["nonmonotonic fence", f => f.db.prepare("UPDATE work_unit_attempts SET fencing_token='0' WHERE id=?").run(f.last.attempt.id)],
  ["foreign continuation WorkUnit", f => {
    const foreign = owner(f, { teammateId: designer, suffix: "foreign-chain" });
    f.db.prepare("UPDATE runner_continuations SET work_unit_id=? WHERE id=?").run(foreign.unit.id, f.first.runnerContinuation.id);
  }],
  ["foreign continuation Run", f => {
    const foreign = owner(f, { teammateId: designer, suffix: "foreign-chain" });
    f.db.prepare("UPDATE runner_continuations SET run_id=? WHERE id=?").run(foreign.run.id, f.first.runnerContinuation.id);
  }],
  ["foreign sealed source fence", f => corruptReplay(f, replay => { replay.sourceFence.runtimeInstanceId = "foreign-runtime"; })],
  ["foreign approval fingerprint", f => corruptReplay(f, replay => { replay.approvalEvidence[0].sideEffectFingerprint = "foreign-effect"; })],
  ["corrupt artifact digest", f => corruptReplay(f, replay => { replay.sourceRunId = "foreign-run"; }, false)],
  ["missing full-fence suspension audit", f => f.db.prepare("DELETE FROM runtime_events WHERE attempt_id=? AND type='work_unit_stale'").run(f.first.attempt.id)],
  ["missing suspension commit", f => f.db.prepare("DELETE FROM control_plane_events WHERE entity_id=? AND action='run.approval_resume_suspended'").run(f.run.id)],
  ["approval-wait commit cannot impersonate pre-dispatch", f => f.db.prepare("UPDATE control_plane_events SET idempotency_key=replace(idempotency_key,'resume_pre_dispatch','approval_wait') WHERE entity_id=? AND action='run.approval_resume_suspended'").run(f.run.id)],
  ["terminal intermediate continuation", f => f.db.prepare("UPDATE runner_continuations SET state='succeeded' WHERE id=?").run(f.first.runnerContinuation.id)],
  ...[
    ["suspended source tool_start", f => f.first.attempt.id],
    ["malformed tool_start missing", () => undefined],
    ["malformed tool_start null", () => null],
    ["malformed tool_start number", () => 7],
    ["malformed tool_start array", f => [f.first.attempt.id]],
    ["malformed tool_start object", f => ({ id: f.first.attempt.id })],
    ["malformed tool_start empty", () => ""],
    ["malformed tool_start whitespace", () => "   "],
  ].map(([name, attemptId]) => [name, f => {
    const attribution = attemptId(f);
    const data = { toolCallId: "proof-forbidden-effect", toolName: "read",
      ...(attribution === undefined ? {} : { attemptId: attribution }) };
    f.db.prepare("INSERT INTO run_events (id,run_id,seq,ts,type,data_json) SELECT ?,?,MAX(seq)+1,?,'tool_start',? FROM run_events WHERE run_id=?")
      .run("proof-chain-forbidden-start", f.run.id, f.tick(3), JSON.stringify(data), f.run.id);
  }]),
];

for (const [name, corrupt] of chainCorruptions) {
  test(`A28 approval terminal lineage rejects ${name} without touching the native reply`, async t => {
    const f = await approvalChainFixture(t);
    assert.equal(f.observe().state.kind, "terminal", "the real Core transactions first produce a valid ownership chain");
    // Scoped disposable corruption probes proof rejection; it never manufactures a successful recovery.
    corrupt(f);
    assert.equal(f.observe().state.reason, "terminal_continuation_conflict");
    assertIndeterminateCannotWrite(f);
  });
}

test("A28 changing historical chain evidence invalidates an already captured terminal CAS", async t => {
  const f = await approvalChainFixture(t), expected = f.observe(), before = f.row();
  duplicatePredecessor(f);
  const result = f.store.commitTeammateDirectMessageRuntime({ expected, operation: { kind: "reconcile",
    patch: { body: "Durable chain conclusion", status: "ready", linkedRunId: f.run.id, errorMessage: null } } }, f.tick(7));
  assert.equal(result.kind, "stale");
  assert.deepEqual(f.row(), before);
});

test("A28 approval chains exceeding 64 hops fail closed instead of traversing unbounded history", async t => {
  const f = await approvalChainFixture(t, 65);
  assert.equal(f.observe().state.reason, "terminal_continuation_conflict");
  assertIndeterminateCannotWrite(f);
});
