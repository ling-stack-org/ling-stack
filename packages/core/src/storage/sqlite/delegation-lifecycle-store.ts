import { createHash, randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import type { RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import { toRuntimeAttemptFence } from "../../runtime-supervisor-types.js";
import { delegationDigest, delegationFence, delegationId, delegationInteger, delegationJson, delegationRecord, delegationTimestamp,
  delegationPreparedExecutionJson, delegationPreparedExecutionDigest } from "../../harness/delegation-write-validation.js";
import {
  DelegationLifecycleError, type AppendedDelegationInstruction, type AppendDelegationInstructionInput,
  type ClaimedDelegatedChild, type ClaimDelegatedChildInput, type CommitDelegatedChildStartInput,
  type DelegationChildRuntime, type DelegationLifecycleErrorCode, type DelegationLifecycleStorePorts,
  type DelegationRecoveryClassification, type DelegationRunnerStartObservation,
  type InterruptedDelegatedChildRequest, type InterruptDelegatedChildInput, type ResumeDelegatedChildInput,
  type DelegationPreparedExecution, type DelegationPreparedExecutionV1,
} from "../../harness/delegation-lifecycle-types.js";
import { mapDelegationMessage } from "./delegation-mappers.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";
import { hasDelegationStoppedHandoff } from "./delegation-stopped-handoff.js";
import { assertUserInputDurableQuiescence } from "./user-input-durable-quiescence.js";
import { delegationResultEvidenceRefsV1, type DelegationResultV1 } from "../../delegation-completion-evidence.js";
import { mapDelegationBudgetCharge } from "./delegation-budget-rows.js";
import { redactSecrets } from "../../redaction.js";
import { readSqliteSnapshot } from "./read-snapshot.js";

/**
 * Initial delegated execution lifecycle. No Task or accepted workflow mutation
 * is permitted here. Claiming is not starting; only authenticated acceptance
 * can bind migration 154's child edge. A replayed claim is never redispatched.
 */
export class SqliteDelegationLifecycleStore {
  constructor(private readonly context: SqliteStoreContext, private readonly ports: DelegationLifecycleStorePorts) {}

  getDelegatedChildPreparation(reservationId: string): DelegationPreparedExecution | undefined {
    const id = delegationId(reservationId);
    return readSqliteSnapshot(this.context.database, () => this.readPreparation(this.read(id)));
  }

  commitDelegatedChildPreparation(input: { readonly reservationId: string; readonly sourceFence: RuntimeAttemptFenceV1;
    readonly preparation: unknown; readonly now: string }): DelegationPreparedExecution {
    const request = delegationRecord(input, ["reservationId", "sourceFence", "preparation", "now"]);
    const id = delegationId(request.reservationId), fence = delegationFence(request.sourceFence), now = delegationTimestamp(request.now);
    if (!this.ports.readExecutionPreparation) fail("delegation.authority_invalid");
    // Capture by value outside the mutation. A getter, callback, Proxy or secret
    // cannot be serialized into a supposedly immutable execution plan.
    const payload = JSON.parse(delegationPreparedExecutionJson(this.ports.readExecutionPreparation(request.preparation))) as DelegationPreparedExecutionV1;
    return this.transaction(() => {
      const runtime = this.read(id);
      this.liveReservation(runtime, now);
      if (!runtime.attempt || !sameFence(fence, toRuntimeAttemptFence(runtime.attempt))
        || runtime.attempt.status !== "created" || runtime.attempt.endedAt || runtime.attempt.abortRequestedAt
        || runtime.workUnit.status !== "claimed") fail("delegation.source_attempt_stale");
      this.ports.assertDispatchAuthorityWithinTransaction({ childRunId: runtime.run.id, stepId: runtime.step.id, sourceFence: fence, now });
      this.validatePreparation(runtime, payload);
      const existing = this.readPreparation(runtime);
      if (existing) {
        if (existing.digest !== delegationPreparedExecutionDigest(payload)) fail("delegation.idempotency_conflict");
        return existing;
      }
      if (runtime.step.state !== "spawning" || runtime.attempt.attemptNumber !== 1 || !sameFence(payload.sourceFence, fence)
        || payload.preparedAt < runtime.attempt.createdAt || payload.preparedAt > now) fail("delegation.lifecycle_conflict");
      const json = delegationPreparedExecutionJson(payload), digest = delegationPreparedExecutionDigest(payload);
      const artifact = this.ports.createArtifactWithinTransaction({ runId: runtime.run.id, type: "json", path: "sqlite:delegation-execution",
        contentType: "application/json", sizeBytes: Buffer.byteLength(json, "utf8"), sealedPayload: payload,
        contentSha256: digest, createdAt: now });
      this.assertTransaction();
      this.assertMessageArtifact(artifact.id, runtime.run.id, digest, true);
      // The child was reserved before SDK preflight. Persist its exact model
      // boundary in the same transaction as the immutable preparation, so
      // checkpoint writers never have to reconstruct it from parent text.
      const snapshot = { ...payload.requestSnapshot, runnerExecutionInput: payload.runnerExecutionInput,
        effectivePolicySnapshot: payload.effectivePolicySnapshot };
      const updated = this.context.database.prepare(`UPDATE run_sessions SET request_snapshot_json=?,
        context_view_id=?,context_view_created_at=?,updated_at=? WHERE id=? AND status='queued'
        AND work_unit_id=? AND context_view_id IS NULL`)
        .run(JSON.stringify(snapshot), artifact.id, now, now, runtime.run.id, runtime.workUnit.id);
      if (Number(updated.changes) !== 1) fail("delegation.lifecycle_conflict");
      return { artifactId: artifact.id, digest, payload };
    });
  }

  claimDelegatedChild(input: ClaimDelegatedChildInput): ClaimedDelegatedChild {
    const request = delegationRecord(input, ["reservationId", "expectedStepRevision", "runtimeInstanceId", "now"]);
    const reservationId = delegationId(request.reservationId);
    const revision = delegationInteger(request.expectedStepRevision);
    const runtimeInstanceId = delegationId(request.runtimeInstanceId);
    const now = delegationTimestamp(request.now);
    return this.transaction(() => {
      const runtime = this.read(reservationId);
      this.liveReservation(runtime, now);
      if (runtime.step.state !== "spawning" || runtime.step.childRunId !== undefined || runtime.run.status !== "queued"
        || runtime.run.endedAt || runtime.step.revision !== revision) fail("delegation.lifecycle_conflict");
      if (runtime.attempt) {
        if (runtime.workUnit.status !== "claimed" || runtime.attempt.status !== "created" || runtime.attempt.endedAt
          || runtime.attempt.abortRequestedAt || runtime.attempt.runtimeInstanceId !== runtimeInstanceId) fail("delegation.recovery_required");
        return { ...runtime, attempt: runtime.attempt, replayed: true };
      }
      if (runtime.workUnit.status !== "queued" || runtime.workUnit.attemptCount !== 0) fail("delegation.lifecycle_conflict");
      const runnerId = runtime.workUnit.effectiveRunnerId ?? runtime.workUnit.runnerId;
      if (!runnerId) fail("delegation.authority_invalid");
      const attempt = this.ports.createWorkUnitAttemptWithinTransaction({ workUnitId: runtime.workUnit.id, attemptNumber: 1,
        runtimeInstanceId, runnerId, requestedRunnerId: runtime.workUnit.requestedRunnerId,
        effectiveRunnerId: runnerId, status: "created", now });
      this.assertTransaction();
      this.ports.assertDispatchAuthorityWithinTransaction({ childRunId: runtime.run.id, stepId: runtime.step.id,
        sourceFence: toRuntimeAttemptFence(attempt), now });
      this.assertTransaction();
      const transition = this.ports.transitionWorkUnitStatus({ workUnitId: runtime.workUnit.id, expectedStatus: "queued",
        event: "claim", actor: "system", idempotencyKey: `delegation:${runtime.step.id}:initial-claim`, now,
        activeAttemptId: attempt.id });
      if (!transition.ok) fail("delegation.lifecycle_conflict");
      const after = this.read(reservationId);
      if (after.workUnit.status !== "claimed" || after.attempt?.id !== attempt.id || after.step.state !== "spawning"
        || after.step.childRunId !== undefined || after.run.status !== "queued") fail("delegation.lifecycle_conflict");
      return { ...after, attempt, replayed: false };
    });
  }

  commitDelegatedChildStart(input: CommitDelegatedChildStartInput): ClaimedDelegatedChild {
    const request = delegationRecord(input, ["reservationId", "sourceFence", "observation", "now"]);
    const reservationId = delegationId(request.reservationId), fence = delegationFence(request.sourceFence);
    const now = delegationTimestamp(request.now);
    const observation = startObservation(this.ports.readRunnerStartObservation(request.observation));
    if (!sameFence(fence, observation.sourceFence)) fail("delegation.authority_invalid");
    return this.transaction(() => {
      const runtime = this.read(reservationId), attempt = runtime.attempt;
      if (!attempt || !sameFence(fence, toRuntimeAttemptFence(attempt))) fail("delegation.source_attempt_stale");
      // Acceptance cannot bypass durable preparation. A claimed row without
      // the original sealed input is uncertain, not permission to dispatch.
      if (!this.readPreparation(runtime)) fail("delegation.recovery_required");
      if (observation.childRunId !== runtime.run.id || observation.runnerId !== attempt.effectiveRunnerId
        || observation.observedAt < attempt.createdAt || observation.observedAt > now) fail("delegation.authority_invalid");
      const digest = delegationDigest(observation);
      const prior = this.context.database.prepare(`SELECT data_json FROM runtime_events
        WHERE work_unit_id=? AND attempt_id=? AND runtime_instance_id=? AND fencing_token=? AND type='work_unit_started'
          AND json_extract(data_json,'$.kind')='delegation_runner_start' ORDER BY seq ASC LIMIT 2`)
        .all(fence.workUnitId, fence.attemptId, fence.runtimeInstanceId, fence.fencingToken);
      if (prior.length) {
        if (prior.length !== 1 || typeof prior[0]!.data_json !== "string") fail("delegation.lifecycle_conflict");
        const data = delegationRecord(JSON.parse(prior[0]!.data_json), ["kind", "reservationId", "stepId", "observationDigest"], "delegation.persisted_fact_invalid");
        if (data.reservationId !== reservationId || data.stepId !== runtime.step.id || data.observationDigest !== digest) fail("delegation.idempotency_conflict");
        if (runtime.step.childRunId !== runtime.run.id || runtime.step.state !== "running" || runtime.run.status !== "running"
          || runtime.workUnit.status !== "running" || attempt.status !== "started" || attempt.abortRequestedAt || attempt.endedAt) fail("delegation.lifecycle_conflict");
        return { ...runtime, attempt, replayed: true };
      }
      this.liveReservation(runtime, now);
      const resuming = runtime.step.state === "resuming";
      if ((!resuming && (runtime.step.state !== "spawning" || runtime.step.childRunId !== undefined || runtime.run.status !== "queued"))
        || resuming && (runtime.step.childRunId !== runtime.run.id || runtime.run.status !== "running")
        || runtime.run.endedAt || runtime.workUnit.status !== "claimed" || runtime.workUnit.endedAt
        || attempt.status !== "created" || attempt.endedAt || attempt.abortRequestedAt) fail("delegation.lifecycle_conflict");
      this.ports.assertDispatchAuthorityWithinTransaction({ childRunId: runtime.run.id, stepId: runtime.step.id, sourceFence: fence, now });
      this.assertTransaction();
      const runTransition = resuming ? { ok: true } : this.ports.transitionRunStatus({ runId: runtime.run.id, expectedStatus: "queued", event: "runner_started",
        actor: "system", idempotencyKey: `delegation:${attempt.id}:run-start`, now, startedAt: observation.observedAt });
      const unitTransition = this.ports.transitionWorkUnitStatus({ ...fence, expectedStatus: "claimed", event: "runner_started",
        actor: "system", idempotencyKey: `delegation:${attempt.id}:unit-start`, now, startedAt: observation.observedAt });
      const startedAttempt = this.ports.updateWorkUnitAttemptStatus({ ...fence, status: "started", now, startedAt: observation.observedAt });
      if (!runTransition.ok || !unitTransition.ok || !startedAttempt) fail("delegation.lifecycle_conflict");
      this.assertTransaction();
      const update = this.context.database.prepare(`UPDATE delegation_steps SET state='running',child_run_id=?,revision=revision+1,updated_at=?
        WHERE id=? AND state=? AND ${resuming ? "child_run_id=?" : "child_run_id IS NULL"} AND revision=?`)
        .run(runtime.run.id, now, runtime.step.id, resuming ? "resuming" : "spawning", ...(resuming ? [runtime.run.id] : []), runtime.step.revision);
      if (Number(update.changes) !== 1) fail("delegation.lifecycle_conflict");
      this.ports.appendRuntimeEvent({ ...fence, type: "work_unit_started", actor: "system", ts: now,
        data: { kind: "delegation_runner_start", reservationId, stepId: runtime.step.id, observationDigest: digest } });
      this.assertTransaction();
      const after = this.read(reservationId);
      if (!after.attempt) fail("delegation.lifecycle_conflict");
      return { ...after, attempt: after.attempt, replayed: false };
    });
  }

  requestDelegatedChildInterrupt(input: InterruptDelegatedChildInput): InterruptedDelegatedChildRequest {
    const request = delegationRecord(input, ["reservationId", "parentFence", "callId", "now"]);
    const id = delegationId(request.reservationId), parentFence = delegationFence(request.parentFence);
    const callId = delegationId(request.callId), now = delegationTimestamp(request.now);
    return this.transaction(() => {
      const runtime = this.read(id), key = `delegation-interrupt:${parentFence.attemptId}:${callId}`;
      const prior = this.context.database.prepare("SELECT * FROM delegation_messages WHERE idempotency_key=?").get(key);
      if (prior) {
        const message = mapDelegationMessage(prior as Record<string, SQLOutputValue>);
        if (message.delegationStepId !== runtime.step.id || message.kind !== "control" || message.direction !== "parent_to_child") fail("delegation.idempotency_conflict");
        this.assertMessageArtifact(message.bodyArtifactId, runtime.step.parentRunId, message.digest);
        const payload = delegationRecord(this.ports.getArtifact(message.bodyArtifactId)?.sealedPayload,
          ["schemaVersion", "kind", "parentFence", "sourceFence", "callId", "requestedAt"], "delegation.persisted_fact_invalid");
        if (payload.kind !== "delegation.interrupt.v1" || payload.callId !== callId || !sameFence(delegationFence(payload.parentFence), parentFence)) fail("delegation.idempotency_conflict");
        return { ...runtime, sourceFence: delegationFence(payload.sourceFence), replayed: true };
      }
      this.assertParentOwner(runtime, parentFence);
      if (runtime.reservation.state !== "reserved" || !["running", "waiting"].includes(runtime.step.state)
        || runtime.run.status !== "running" || runtime.workUnit.status !== "running" || runtime.attempt?.status !== "started"
        || runtime.attempt.endedAt || runtime.attempt.abortRequestedAt) fail("delegation.lifecycle_conflict");
      const sourceFence = toRuntimeAttemptFence(runtime.attempt);
      this.insertControl(runtime, key, { schemaVersion: 1, kind: "delegation.interrupt.v1", parentFence, sourceFence, callId, requestedAt: now }, now);
      const transition = this.ports.transitionWorkUnitStatus({ ...sourceFence, expectedStatus: "running", event: "cancel", actor: "system",
        reason: "delegation interruption (logical Run remains open)", idempotencyKey: `${key}:unit`, now });
      if (!transition.ok || !this.ports.updateWorkUnitAttemptStatus({ ...sourceFence, status: "cancelling", abortRequestedAt: now, now })) fail("delegation.lifecycle_conflict");
      this.transitionStep(runtime, "interrupting", now);
      return { ...this.read(id), sourceFence, replayed: false };
    });
  }

  commitDelegatedChildInterrupted(input: { readonly reservationId: string; readonly sourceFence: RuntimeAttemptFenceV1; readonly now: string }): DelegationChildRuntime {
    const request = delegationRecord(input, ["reservationId", "sourceFence", "now"]);
    const id = delegationId(request.reservationId), fence = delegationFence(request.sourceFence), now = delegationTimestamp(request.now);
    return this.transaction(() => {
      const runtime = this.read(id);
      if (!runtime.attempt || !sameFence(fence, toRuntimeAttemptFence(runtime.attempt))) fail("delegation.source_attempt_stale");
      if (runtime.step.state === "interrupted" && runtime.attempt.status === "cancelled" && runtime.workUnit.status === "cancelled") return runtime;
      if (runtime.step.state !== "interrupting" || runtime.run.status !== "running" || runtime.workUnit.status !== "cancelling"
        || runtime.attempt.status !== "cancelling" || !hasDelegationStoppedHandoff(this.context.database, fence, now)) fail("delegation.recovery_required");
      const unit = this.ports.transitionWorkUnitStatus({ ...fence, expectedStatus: "cancelling", event: "runner_cancelled", actor: "system",
        reason: "delegation interruption physically drained", idempotencyKey: `delegation:${fence.attemptId}:stopped`, now, endedAt: now });
      const attempt = this.ports.updateWorkUnitAttemptStatus({ ...fence, status: "cancelled", now, endedAt: now,
        errorCode: "delegation_interrupted", errorMessage: "Physical Attempt stopped; logical delegated Run remains open." });
      if (!unit.ok || !attempt) fail("delegation.lifecycle_conflict");
      this.transitionStep(runtime, "interrupted", now);
      this.ports.appendTerminalRuntimeAudit({ capability: { ...fence, attemptStatus: "cancelled", transitionedAt: now },
        type: "work_unit_cancelled", actor: "system", data: { kind: "delegation_interrupted", stepId: runtime.step.id } });
      this.ports.releaseResourceLeasesForAttempt(fence, now, "delegation-interrupted");
      this.ports.releaseRuntimeSemaphoreSlotsForAttempt(fence, now, "delegation-interrupted");
      this.assertNoActiveResources(fence);
      return this.read(id);
    });
  }

  resumeDelegatedChild(input: ResumeDelegatedChildInput): ClaimedDelegatedChild {
    const request = delegationRecord(input, ["reservationId", "expectedStepRevision", "runtimeInstanceId", "parentFence", "callId", "now"]);
    const id = delegationId(request.reservationId), revision = delegationInteger(request.expectedStepRevision);
    const runtimeInstanceId = delegationId(request.runtimeInstanceId), parentFence = delegationFence(request.parentFence);
    const callId = delegationId(request.callId), now = delegationTimestamp(request.now);
    return this.transaction(() => {
      const runtime = this.read(id);
      const key = `delegation-resume:${parentFence.attemptId}:${callId}`;
      // A response-loss retry is an observation of the immutable control fact,
      // not a new authority check or dispatch. Look it up by call identity across
      // parent Attempts so a replaced fence cannot reuse the same call silently.
      const priors = this.context.database.prepare(`SELECT m.* FROM delegation_messages m
        JOIN artifacts a ON a.id=m.body_artifact_id
        WHERE m.delegation_step_id=? AND m.direction='parent_to_child' AND m.kind='control'
          AND json_extract(a.sealed_payload_json,'$.kind')='delegation.resume.v1'
          AND json_extract(a.sealed_payload_json,'$.callId')=? LIMIT 2`).all(runtime.step.id, callId);
      if (priors.length) {
        if (priors.length !== 1) fail("delegation.idempotency_conflict");
        const message = mapDelegationMessage(priors[0] as Record<string, SQLOutputValue>);
        if (message.idempotencyKey !== key || message.delegationStepId !== runtime.step.id
          || message.direction !== "parent_to_child" || message.kind !== "control") fail("delegation.idempotency_conflict");
        this.assertMessageArtifact(message.bodyArtifactId, runtime.step.parentRunId, message.digest);
        const artifact = this.ports.getArtifact(message.bodyArtifactId);
        const payload = delegationRecord(artifact?.sealedPayload,
          ["schemaVersion", "kind", "parentFence", "expectedStepRevision", "callId", "sourceFence", "targetFence", "requestedAt"],
          "delegation.persisted_fact_invalid");
        const persistedParent = delegationFence(payload.parentFence), sourceFence = delegationFence(payload.sourceFence);
        const targetFence = delegationFence(payload.targetFence), requestedAt = delegationTimestamp(payload.requestedAt,
          "delegation.persisted_fact_invalid");
        if (payload.schemaVersion !== 1 || payload.kind !== "delegation.resume.v1" || payload.callId !== callId
          || payload.expectedStepRevision !== revision || !sameFence(persistedParent, parentFence)
          || requestedAt !== message.createdAt || runtime.step.revision < revision + 1) fail("delegation.idempotency_conflict");
        const sourceAttempt = this.ports.getWorkUnitAttempt(sourceFence.attemptId);
        const targetAttempt = this.ports.getWorkUnitAttempt(targetFence.attemptId);
        if (!sourceAttempt || !targetAttempt || sourceAttempt.workUnitId !== runtime.workUnit.id
          || targetAttempt.workUnitId !== runtime.workUnit.id
          || !sameFence(sourceFence, toRuntimeAttemptFence(sourceAttempt))
          || !sameFence(targetFence, toRuntimeAttemptFence(targetAttempt))
          || sourceAttempt.status !== "cancelled" || sourceAttempt.errorCode !== "delegation_interrupted"
          || !sourceAttempt.abortRequestedAt || !sourceAttempt.endedAt
          || targetAttempt.attemptNumber !== sourceAttempt.attemptNumber + 1
          || targetAttempt.createdAt !== requestedAt || targetAttempt.createdAt < sourceAttempt.endedAt
          || runtime.workUnit.attemptCount < targetAttempt.attemptNumber) fail("delegation.idempotency_conflict");
        return { ...runtime, attempt: targetAttempt, replayed: true };
      }
      this.liveReservation(runtime, now);
      this.assertParentOwner(runtime, parentFence);
      if (runtime.step.state !== "interrupted" || runtime.step.revision !== revision || runtime.run.status !== "running"
        || runtime.run.endedAt || runtime.workUnit.status !== "cancelled" || runtime.attempt?.status !== "cancelled") fail("delegation.lifecycle_conflict");
      const previousFence = toRuntimeAttemptFence(runtime.attempt);
      if (!hasDelegationStoppedHandoff(this.context.database, previousFence, now)) fail("delegation.recovery_required");
      this.assertNoActiveResources(previousFence);
      this.transitionStep(runtime, "resuming", now);
      const queued = this.ports.transitionWorkUnitStatus({ workUnitId: runtime.workUnit.id, expectedStatus: "cancelled", event: "retry",
        actor: "system", idempotencyKey: `delegation:${runtime.step.id}:${revision}:resume-queue`, now, endedAt: null,
        errorCode: null, errorMessage: null });
      if (!queued.ok) fail("delegation.lifecycle_conflict");
      const runnerId = runtime.workUnit.effectiveRunnerId ?? runtime.workUnit.runnerId;
      if (!runnerId) fail("delegation.authority_invalid");
      const attempt = this.ports.createWorkUnitAttemptWithinTransaction({ workUnitId: runtime.workUnit.id,
        attemptNumber: runtime.workUnit.attemptCount + 1, runtimeInstanceId, runnerId,
        requestedRunnerId: runtime.workUnit.requestedRunnerId, effectiveRunnerId: runnerId, status: "created", now });
      this.ports.assertDispatchAuthorityWithinTransaction({ childRunId: runtime.run.id, stepId: runtime.step.id,
        sourceFence: toRuntimeAttemptFence(attempt), now });
      const targetFence = toRuntimeAttemptFence(attempt);
      const payload = { schemaVersion: 1, kind: "delegation.resume.v1", parentFence, expectedStepRevision: revision,
        callId, sourceFence: previousFence, targetFence, requestedAt: now };
      this.insertControl(runtime, key, payload, now);
      const claimed = this.ports.transitionWorkUnitStatus({ workUnitId: runtime.workUnit.id, expectedStatus: "queued", event: "claim", actor: "system",
        idempotencyKey: `delegation:${attempt.id}:resume-claim`, activeAttemptId: attempt.id, now, endedAt: null });
      if (!claimed.ok) fail("delegation.lifecycle_conflict");
      this.assertTransaction();
      return { ...this.read(id), attempt, replayed: false };
    });
  }

  commitDelegatedChildTerminal(input: { readonly reservationId: string; readonly sourceFence: RuntimeAttemptFenceV1; readonly now: string }): DelegationChildRuntime {
    const request = delegationRecord(input, ["reservationId", "sourceFence", "now"]);
    const id = delegationId(request.reservationId), fence = delegationFence(request.sourceFence), now = delegationTimestamp(request.now);
    return this.transaction(() => {
      const runtime = this.read(id), attempt = runtime.attempt;
      if (!attempt || !sameFence(fence, toRuntimeAttemptFence(attempt))) fail("delegation.source_attempt_stale");
      const outcome = runtime.run.status;
      if (!["succeeded", "failed", "cancelled"].includes(outcome) || runtime.workUnit.status !== outcome || attempt.status !== outcome
        || !runtime.run.endedAt || !runtime.workUnit.endedAt || !attempt.endedAt || runtime.reservation.state !== "settled"
        || !runtime.reservation.settlementDigest || !runtime.reservation.settledAt) fail("delegation.recovery_required");
      if (![runtime.run.endedAt, runtime.workUnit.endedAt, attempt.endedAt, runtime.reservation.settledAt]
        .every(value => delegationTimestamp(value) <= now)) fail("delegation.invalid_input");
      const replayed = runtime.step.state === outcome;
      if (!replayed && !["running", "waiting"].includes(runtime.step.state)) fail("delegation.lifecycle_conflict");
      const completion = this.ports.getHostAttemptCompletion({ runId: runtime.run.id, ...fence });
      if (!completion?.drainedAt || !completion.effectCoverage || completion.drainedAt > now) fail("delegation.recovery_required");
      assertUserInputDurableQuiescence(this.context.database, runtime.run.id, fence, Date.parse(now), "exact_attempt");
      const charges = this.context.database.prepare("SELECT * FROM delegation_budget_charges WHERE run_id=? ORDER BY id")
        .all(runtime.run.id).map(row => mapDelegationBudgetCharge(row));
      if (charges.some(charge => charge.reservationId !== runtime.reservation.id || charge.rootRunId !== runtime.step.rootRunId
        || !["measured", "cancelled_before_dispatch"].includes(charge.state))) fail("delegation.recovery_required");
      const payload: DelegationResultV1 = { schemaVersion: 1, kind: "delegation.result.v1", stepId: runtime.step.id,
        reservationId: runtime.reservation.id, rootRunId: runtime.step.rootRunId, parentRunId: runtime.step.parentRunId,
        childRunId: runtime.run.id, sourceFence: fence, outcome: outcome as DelegationResultV1["outcome"],
        settlementDigest: runtime.reservation.settlementDigest,
        evidenceRefs: delegationResultEvidenceRefsV1({ completion, reservation: runtime.reservation, charges }) };
      this.commitResult(runtime, payload, replayed, now);
      if (replayed) return runtime;
      this.transitionStep(runtime, outcome as "succeeded" | "failed" | "cancelled", now);
      return this.read(id);
    });
  }

  appendDelegationInstruction(input: AppendDelegationInstructionInput): AppendedDelegationInstruction {
    const request = delegationRecord(input, ["reservationId", "parentFence", "messageCallId", "text", "now"]);
    const reservationId = delegationId(request.reservationId), fence = delegationFence(request.parentFence);
    const callId = delegationId(request.messageCallId), text = delegationId(request.text), now = delegationTimestamp(request.now);
    return this.transaction(() => {
      const runtime = this.read(reservationId);
      const key = `delegation-message:${fence.attemptId}:${callId}`;
      const payload = { schemaVersion: 1, kind: "delegation.instruction.v1", parentFence: fence, text };
      const digest = delegationDigest(payload);
      const prior = this.context.database.prepare("SELECT * FROM delegation_messages WHERE idempotency_key=?").get(key);
      if (prior) {
        const message = mapDelegationMessage(prior as Record<string, SQLOutputValue>);
        if (message.delegationStepId !== runtime.step.id || message.digest !== digest || message.direction !== "parent_to_child" || message.kind !== "instruction") fail("delegation.idempotency_conflict");
        this.assertMessageArtifact(message.bodyArtifactId, runtime.step.parentRunId, digest);
        return { message, replayed: true };
      }
      this.liveReservation(runtime, now);
      if (!["spawning", "running", "waiting", "interrupted", "resuming"].includes(runtime.step.state)) fail("delegation.lifecycle_conflict");
      const owner = this.context.database.prepare(`SELECT 1 FROM run_sessions r JOIN work_units u ON u.id=r.work_unit_id
        JOIN work_unit_attempts a ON a.id=u.active_attempt_id WHERE r.id=? AND r.status='running' AND r.ended_at IS NULL
          AND u.status='running' AND u.ended_at IS NULL AND u.id=? AND u.linked_run_id=r.id
          AND a.id=? AND a.runtime_instance_id=? AND a.fencing_token=? AND a.status='started'
          AND a.abort_requested_at IS NULL AND a.ended_at IS NULL`)
        .get(runtime.step.parentRunId, fence.workUnitId, fence.attemptId, fence.runtimeInstanceId, fence.fencingToken);
      if (!owner) fail("delegation.source_attempt_stale");
      const json = delegationJson(payload);
      const artifact = this.ports.createArtifactWithinTransaction({ runId: runtime.step.parentRunId, type: "json",
        path: "sqlite:delegation-instruction", contentType: "application/json", sizeBytes: Buffer.byteLength(json, "utf8"),
        sealedPayload: JSON.parse(json), contentSha256: digest, createdAt: now });
      this.assertTransaction();
      this.assertMessageArtifact(artifact.id, runtime.step.parentRunId, digest);
      const messageId = `delegation_message_${randomUUID()}`;
      this.context.database.prepare(`INSERT INTO delegation_messages(id,schema_version,delegation_step_id,direction,kind,body_artifact_id,digest,idempotency_key,created_at)
        VALUES(?,1,?,'parent_to_child','instruction',?,?,?,?)`).run(messageId, runtime.step.id, artifact.id, digest, key, now);
      const row = this.context.database.prepare("SELECT * FROM delegation_messages WHERE id=?").get(messageId);
      if (!row) fail("delegation.lifecycle_conflict");
      return { message: mapDelegationMessage(row as Record<string, SQLOutputValue>), replayed: false };
    });
  }

  /** Bounded restart discovery only. A row is not permission to dispatch or replay an Attempt. */
  listDelegatedRecoveryCandidates(input: import("../../harness/delegation-lifecycle-types.js").ListDelegatedRecoveryCandidatesInput): import("../../harness/delegation-lifecycle-types.js").DelegatedRecoveryCandidatesPage {
    const request = delegationRecord(input, ["cutoffAt", "cursor", "limit"]);
    const cutoffAt = delegationTimestamp(request.cutoffAt);
    const limit = request.limit;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("delegation.invalid_input");
    const cursor = request.cursor === undefined ? undefined : delegationRecord(request.cursor, ["createdAt", "reservationId"]);
    const createdAt = cursor ? delegationTimestamp(cursor.createdAt) : "";
    const reservationId = cursor ? delegationId(cursor.reservationId) : "";
    if (createdAt > cutoffAt) fail("delegation.invalid_input");
    const rows = this.context.database.prepare(`SELECT r.id, r.created_at FROM delegation_budget_reservations r
      JOIN delegation_steps s ON s.id=r.delegation_step_id AND s.root_run_id=r.root_run_id
      WHERE r.created_at<=? AND (r.created_at>? OR (r.created_at=? AND r.id>?))
        AND s.state NOT IN ('succeeded','failed','cancelled','lost')
      ORDER BY r.created_at,r.id LIMIT ?`).all(cutoffAt, createdAt, createdAt, reservationId, limit + 1);
    const page = rows.slice(0, limit), last = page.at(-1);
    return { reservationIds: page.map(row => delegationId(row.id)),
      ...(rows.length > limit && last ? { nextCursor: { createdAt: delegationTimestamp(last.created_at), reservationId: delegationId(last.id) } } : {}) };
  }

  classifyDelegatedChildRecovery(reservationId: string): DelegationRecoveryClassification {
    return this.transaction(() => {
      const runtime = this.read(delegationId(reservationId));
      if (["succeeded", "failed", "cancelled", "lost"].includes(runtime.step.state)) return { kind: "terminal", runtime };
      if (runtime.step.state === "spawning") {
        if (runtime.run.status === "queued" && runtime.workUnit.status === "queued" && !runtime.attempt && runtime.workUnit.attemptCount === 0) return { kind: "queued_unclaimed", runtime };
        // Even `created` could be the crash window after OS/Provider dispatch.
        return { kind: "dispatch_outcome_unknown", runtime };
      }
      if (["running", "waiting", "interrupting", "interrupted", "resuming"].includes(runtime.step.state)) {
        return { kind: runtime.step.state as "running" | "waiting" | "interrupting" | "interrupted" | "resuming", runtime };
      }
      return fail("delegation.lifecycle_conflict");
    });
  }

  private read(reservationId: string): DelegationChildRuntime {
    const reservation = this.ports.getDelegationBudgetReservation(reservationId);
    const step = reservation ? this.ports.getDelegationStep(reservation.delegationStepId) : undefined;
    const run = reservation ? this.ports.getRun(reservation.childRunId) : undefined;
    const workUnit = run?.workUnitId ? this.ports.getWorkUnit(run.workUnitId) : undefined;
    if (!reservation || !step || !run || !workUnit || step.rootRunId !== reservation.rootRunId
      || run.parentRunId !== step.parentRunId || run.id !== reservation.childRunId || workUnit.linkedRunId !== run.id
      || workUnit.ownerType !== "delegation_step" || workUnit.ownerId !== step.id || run.workUnitId !== workUnit.id
      || step.childRunId !== undefined && step.childRunId !== run.id) fail("delegation.lineage_invalid");
    const attempt = workUnit.activeAttemptId ? this.ports.getWorkUnitAttempt(workUnit.activeAttemptId) : undefined;
    if (workUnit.activeAttemptId && (!attempt || attempt.workUnitId !== workUnit.id)) fail("delegation.lineage_invalid");
    return { step, reservation, run, workUnit, ...(attempt ? { attempt } : {}) };
  }
  private readPreparation(runtime: DelegationChildRuntime): DelegationPreparedExecution | undefined {
    const rows = this.context.database.prepare("SELECT id,content_sha256 FROM artifacts WHERE run_id=? AND path='sqlite:delegation-execution' LIMIT 2")
      .all(runtime.run.id);
    if (!rows.length) return undefined;
    if (rows.length !== 1 || typeof rows[0]!.id !== "string" || typeof rows[0]!.content_sha256 !== "string") fail("delegation.lineage_invalid");
    const id = rows[0]!.id as string, digest = rows[0]!.content_sha256 as string;
    this.assertMessageArtifact(id, runtime.run.id, digest, true);
    const payload = this.ports.getArtifact(id)!.sealedPayload as DelegationPreparedExecutionV1;
    this.validatePreparation(runtime, payload);
    return { artifactId: id, digest, payload };
  }
  private validatePreparation(runtime: DelegationChildRuntime, payload: DelegationPreparedExecutionV1): void {
    delegationRecord(payload, ["schemaVersion", "kind", "stepId", "reservationId", "rootRunId", "parentRunId", "childRunId", "sourceFence",
      "runnerId", "requestSnapshot", "runnerExecutionInput", "effectivePolicySnapshot", "preparedAt"], "delegation.persisted_fact_invalid");
    const fence = delegationFence(payload.sourceFence);
    if (payload.schemaVersion !== 1 || payload.kind !== "delegation.execution.v1" || payload.runnerId !== "pi"
      || payload.stepId !== runtime.step.id || payload.reservationId !== runtime.reservation.id || payload.rootRunId !== runtime.step.rootRunId
      || payload.parentRunId !== runtime.step.parentRunId || payload.childRunId !== runtime.run.id
      || fence.workUnitId !== runtime.workUnit.id) fail("delegation.lineage_invalid");
    const original = this.ports.getWorkUnitAttempt(fence.attemptId);
    if (!original || original.attemptNumber !== 1 || !sameFence(fence, toRuntimeAttemptFence(original))) fail("delegation.source_attempt_stale");
    const request = payload.requestSnapshot, execution = payload.runnerExecutionInput;
    delegationJson(request); delegationJson(execution); delegationTimestamp(payload.preparedAt);
    const executionInput = execution.input as Record<string, unknown> | undefined;
    const preparedInput = execution.preparedInput as Record<string, unknown> | undefined;
    if (request.cwd !== runtime.run.cwd || request.parentRunId !== runtime.step.parentRunId || request.teammateId !== runtime.run.teammateId
      || request.workflowStepId !== runtime.run.workflowStepId || request.threadId !== runtime.run.threadId
      || request.providerPresetId !== runtime.run.providerPresetId || request.runnerId !== "pi"
      || delegationDigest(request.task) !== delegationDigest(runtime.run.taskSnapshot)
      || execution.runnerId !== "pi" || executionInput?.cwd !== runtime.run.cwd
      || delegationDigest(executionInput.task) !== delegationDigest(runtime.run.taskSnapshot)
      || preparedInput?.taskId !== runtime.run.taskId || typeof preparedInput.fingerprint !== "string"
      || !/^[a-f0-9]{64}$/.test(preparedInput.fingerprint)
      || delegationJson(redactSecrets({ request, execution, policy: payload.effectivePolicySnapshot }))
        !== delegationJson({ request, execution, policy: payload.effectivePolicySnapshot })) fail("delegation.authority_invalid");
    const provider = executionInput.provider as Record<string, unknown> | undefined;
    if (provider?.provider !== runtime.run.providerName || provider.model !== runtime.run.providerModel
      || request.executionBinding && (request.executionBinding as Record<string, unknown>).kind === "native_profile") fail("delegation.authority_invalid");
  }
  private liveReservation(runtime: DelegationChildRuntime, now: string): void {
    if (runtime.reservation.state !== "reserved") fail("delegation.lifecycle_conflict");
    if (now >= runtime.reservation.deadlineAt) fail("delegation.deadline_exceeded");
    if (now < runtime.reservation.createdAt || now < runtime.step.updatedAt) fail("delegation.invalid_input");
  }
  private assertParentOwner(runtime: DelegationChildRuntime, fence: RuntimeAttemptFenceV1): void {
    if (!this.context.database.prepare(`SELECT 1 FROM run_sessions r JOIN work_units u ON u.id=r.work_unit_id AND u.linked_run_id=r.id
      JOIN work_unit_attempts a ON a.id=u.active_attempt_id WHERE r.id=? AND r.status='running' AND r.ended_at IS NULL
        AND u.status='running' AND u.ended_at IS NULL AND u.id=? AND a.id=? AND a.work_unit_id=u.id
        AND a.runtime_instance_id=? AND a.fencing_token=? AND a.status='started' AND a.abort_requested_at IS NULL AND a.ended_at IS NULL`)
      .get(runtime.step.parentRunId, fence.workUnitId, fence.attemptId, fence.runtimeInstanceId, fence.fencingToken)) fail("delegation.source_attempt_stale");
  }
  private insertControl(runtime: DelegationChildRuntime, key: string, payload: unknown, now: string): void {
    const json = delegationJson(payload), digest = delegationDigest(payload);
    const artifact = this.ports.createArtifactWithinTransaction({ runId: runtime.step.parentRunId, type: "json",
      path: "sqlite:delegation-control", contentType: "application/json", sizeBytes: Buffer.byteLength(json, "utf8"),
      sealedPayload: JSON.parse(json), contentSha256: digest, createdAt: now });
    this.assertTransaction();
    this.assertMessageArtifact(artifact.id, runtime.step.parentRunId, digest);
    this.context.database.prepare(`INSERT INTO delegation_messages(id,schema_version,delegation_step_id,direction,kind,body_artifact_id,digest,idempotency_key,created_at)
      VALUES(?,1,?,'parent_to_child','control',?,?,?,?)`).run(`delegation_message_${randomUUID()}`, runtime.step.id, artifact.id, digest, key, now);
  }
  private transitionStep(runtime: DelegationChildRuntime, state: import("@ling-stack/contracts").DelegationStepState, now: string): void {
    if (now < runtime.step.updatedAt) fail("delegation.invalid_input");
    const terminal = ["succeeded", "failed", "cancelled", "lost"].includes(state);
    const result = this.context.database.prepare(`UPDATE delegation_steps SET state=?,revision=revision+1,updated_at=?,completed_at=?
      WHERE id=? AND state=? AND revision=?`).run(state, now, terminal ? now : null, runtime.step.id, runtime.step.state, runtime.step.revision);
    if (Number(result.changes) !== 1) fail("delegation.lifecycle_conflict");
  }
  private commitResult(runtime: DelegationChildRuntime, payload: DelegationResultV1, replayed: boolean, now: string): void {
    const key = `delegation-result:${runtime.step.id}:${payload.sourceFence.attemptId}`;
    const digest = delegationDigest(payload);
    const prior = this.context.database.prepare(`SELECT * FROM delegation_messages
      WHERE delegation_step_id=? AND (kind='result' OR idempotency_key=?) LIMIT 2`).all(runtime.step.id, key);
    if (prior.length) {
      if (prior.length !== 1 || !replayed) fail("delegation.idempotency_conflict");
      const message = mapDelegationMessage(prior[0]!);
      if (message.direction !== "child_to_parent" || message.kind !== "result" || message.idempotencyKey !== key
        || message.digest !== digest) fail("delegation.idempotency_conflict");
      this.assertMessageArtifact(message.bodyArtifactId, runtime.run.id, digest);
      return;
    }
    // A terminal step without its same-transaction receipt is corruption, not a
    // backfill opportunity after restart. Never invent a result from UI state.
    if (replayed) fail("delegation.recovery_required");
    const json = delegationJson(payload);
    const artifact = this.ports.createArtifactWithinTransaction({ runId: runtime.run.id, type: "json",
      path: "sqlite:delegation-result", contentType: "application/json", sizeBytes: Buffer.byteLength(json, "utf8"),
      sealedPayload: JSON.parse(json), contentSha256: digest, createdAt: now });
    this.assertTransaction();
    this.assertMessageArtifact(artifact.id, runtime.run.id, digest);
    this.context.database.prepare(`INSERT INTO delegation_messages(id,schema_version,delegation_step_id,direction,kind,body_artifact_id,digest,idempotency_key,created_at)
      VALUES(?,1,?,'child_to_parent','result',?,?,?,?)`).run(`delegation_message_${randomUUID()}`, runtime.step.id, artifact.id, digest, key, now);
  }
  private assertNoActiveResources(fence: RuntimeAttemptFenceV1): void {
    for (const table of ["resource_leases", "runtime_semaphore_slots"] as const) {
      if (this.context.database.prepare(`SELECT 1 FROM ${table} WHERE work_unit_id=? AND attempt_id=? AND status='active' LIMIT 1`)
        .get(fence.workUnitId, fence.attemptId)) fail("delegation.recovery_required");
    }
  }
  private assertMessageArtifact(id: string, runId: string, digest: string, prepared = false): void {
    const artifact = this.ports.getArtifact(id);
    const row = this.context.database.prepare("SELECT sealed_payload_json,content_sha256 FROM artifacts WHERE id=? AND run_id=?").get(id, runId);
    if (!artifact || artifact.runId !== runId || !row || typeof row.sealed_payload_json !== "string"
      || row.content_sha256 !== digest || artifact.contentSha256 !== digest
      || createHash("sha256").update(row.sealed_payload_json, "utf8").digest("hex") !== digest
      || (prepared ? delegationPreparedExecutionDigest(artifact.sealedPayload) : delegationDigest(artifact.sealedPayload)) !== digest) fail("delegation.lineage_invalid");
  }
  private transaction<T>(operation: () => T): T {
    this.context.database.exec("BEGIN IMMEDIATE");
    try { const value = operation(); this.assertTransaction(); this.context.database.exec("COMMIT"); return value; }
    catch (error) { rollbackOwnedSqliteTransaction(this.context.database); throw error; }
  }
  private assertTransaction(): void {
    try { this.context.database.exec("BEGIN DEFERRED"); }
    catch (error) { if (error instanceof Error && error.message === "cannot start a transaction within a transaction") return; throw error; }
    this.context.database.exec("ROLLBACK");
    fail("delegation.lifecycle_conflict");
  }
}

function fail(code: DelegationLifecycleErrorCode): never { throw new DelegationLifecycleError(code); }
function sameFence(left: RuntimeAttemptFenceV1, right: RuntimeAttemptFenceV1): boolean { return delegationJson(left) === delegationJson(right); }
function startObservation(value: DelegationRunnerStartObservation): DelegationRunnerStartObservation {
  const row = delegationRecord(value, ["childRunId", "sourceFence", "runnerId", "observationId", "observedAt"], "delegation.authority_invalid");
  return Object.freeze({ childRunId: delegationId(row.childRunId), sourceFence: delegationFence(row.sourceFence),
    runnerId: delegationId(row.runnerId), observationId: delegationId(row.observationId), observedAt: delegationTimestamp(row.observedAt) });
}
