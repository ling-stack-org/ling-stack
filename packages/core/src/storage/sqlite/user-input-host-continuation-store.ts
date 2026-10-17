import type { RunStore } from "../../run-types.js";
import type { UserInputContinuationSeed } from "../../user-input-continuation-types.js";
import type { AcknowledgeUserInputContinuation, AdmitUserInputContinuation, UserInputContinuationBinding,
  UserInputContinuationExecutionPlan, UserInputContinuationReceipt, UserInputRunnerAcceptance } from "../../user-input-host-continuation-types.js";
import { UserInputStoreError } from "../../user-input-store-types.js";
import { toRuntimeAttemptFence } from "../../runtime-supervisor-types.js";
import type { SqliteStoreContext } from "./store-context.js";
import type { SqliteRunSessionStore } from "./run-session-store.js";
import type { SqliteRuntimeWorkUnitStore } from "./runtime-work-unit-store.js";
import type { SqliteControlPlaneStore } from "./control-plane-store.js";
import type { SqliteUserInputDeliveryStore } from "./user-input-delivery-store.js";
import type { SqliteUserInputPreparationStore } from "./user-input-preparation-store.js";
import { readSqliteSnapshot, readSqliteWithinTransaction } from "./read-snapshot.js";
import { readUserInputDelivery, validDeliveryKey, validDeliveryRevision } from "./user-input-delivery-records.js";
import { userInputTimestamp } from "./user-input-records.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { makeUserInputContinuationRecord, readUserInputContinuationRecord, insertUserInputContinuationRecord,
  userInputContinuationRef as ref, sameUserInputValue as same, requireUserInputRecordKeys, userInputEnvelopeKeys } from "./user-input-continuation-envelope.js";

type Ports = Pick<RunStore, "getRun" | "getTask" | "getWorkUnit" | "getWorkUnitAttempt" | "getLingTurnForRun" | "getLingThread"
  | "getUserInputRequest" | "getConversationItem" | "getUserInputWait" | "listLingTurnRuns" | "getChannelWorkflowStep" | "getChannelWorkflow"
  | "transitionRunStatus" | "transitionWorkUnitStatus" | "updateWorkUnitAttemptStatus" | "transitionTaskStatus"
  | "transitionChannelWorkflowStepStatus" | "reconcileLingTurnStatus" | "updateLingThread">;

/** Atomic physical binding and receiver ACK. Never resolves policy, leases, models or executor lifecycle. */
export class SqliteUserInputHostContinuationStore {
  constructor(private readonly context: SqliteStoreContext, private readonly ports: Ports,
    private readonly deliveries: SqliteUserInputDeliveryStore, private readonly preparation: SqliteUserInputPreparationStore,
    private readonly runs: SqliteRunSessionStore, private readonly units: SqliteRuntimeWorkUnitStore,
    private readonly events: SqliteControlPlaneStore) {}

  getBinding(threadId: string, deliveryId: string): UserInputContinuationBinding | undefined {
    return readSqliteSnapshot(this.context.database, () => {
      const seed = this.preparation.seedWithinTransaction(threadId, deliveryId);
      return seed ? this.readBinding(seed) : undefined;
    });
  }
  getReceipt(threadId: string, deliveryId: string): UserInputContinuationReceipt | undefined {
    return readSqliteSnapshot(this.context.database, () => this.readReceiptWithinTransaction(threadId, deliveryId));
  }
  /** Shared with transcript hydration, which already owns its read transaction. */
  readReceiptWithinTransaction(threadId: string, deliveryId: string): UserInputContinuationReceipt | undefined {
    const seed = this.preparation.seedWithinTransaction(threadId, deliveryId);
    if (!seed) return undefined;
    const receipt = readUserInputContinuationRecord<UserInputContinuationReceipt>(this.context, seed, "receipt");
    if (!receipt) return undefined;
    const binding = this.readBinding(seed);
    const bound = readUserInputDelivery(this.context, this.ports, threadId, deliveryId);
    const wait = this.ports.getUserInputWait(threadId, seed.request.requestId);
    requireUserInputRecordKeys(receipt, [...userInputEnvelopeKeys, "bindingRef", "acceptance"]);
    if (!binding || !bound || !wait || bound.delivery.status !== "applied" || wait.status !== "resumed"
      || bound.delivery.revision !== binding.deliveryRevision + 1 || wait.revision !== binding.waitRevision + 1
      || bound.delivery.updatedAt !== receipt.createdAt || !same(receipt.bindingRef, ref(binding))
      || !same(receipt.acceptance, this.acceptance(seed, binding))
      || userInputTimestamp(receipt.createdAt) < userInputTimestamp(binding.createdAt)) throw new UserInputStoreError("invalid_record");
    return receipt;
  }

  admit(input: AdmitUserInputContinuation, now: string): UserInputContinuationBinding {
    return this.transaction(now, () => {
      const captured = readSqliteWithinTransaction(this.context.database, () => JSON.parse(JSON.stringify(input)) as AdmitUserInputContinuation);
      if (!validDeliveryKey(captured.runtimeInstanceId)) throw new UserInputStoreError("invalid_input");
      const bound = this.deliveries.assertContinuationClaim(captured, now);
      const seed = this.preparation.seedWithinTransaction(captured.threadId, captured.deliveryId);
      if (!seed) throw new UserInputStoreError("invalid_record");
      const prepared = this.preparation.readWithinTransaction(seed, "execution");
      if (!prepared || !same(captured.executionRef, ref(prepared))) throw new UserInputStoreError("source_conflict");
      if (userInputTimestamp(now) < userInputTimestamp(prepared.createdAt)) throw new UserInputStoreError("delivery_conflict");
      if (this.readBinding(seed)) throw new UserInputStoreError("delivery_conflict");
      const plan = prepared.payload as UserInputContinuationExecutionPlan, source = seed.source;
      const unit = this.ports.getWorkUnit(source.fence.workUnitId)!;
      const wait = this.ports.getUserInputWait(source.threadId, seed.request.requestId)!;
      if (!Number.isSafeInteger(unit.attemptCount + 1) || !validDeliveryRevision(wait.revision + 1)
        || !validDeliveryRevision(bound.delivery.revision + 1)) throw new UserInputStoreError("invalid_record");
      const attempt = this.units.createWorkUnitAttemptWithinTransaction({ workUnitId: unit.id, attemptNumber: unit.attemptCount + 1,
        runtimeInstanceId: captured.runtimeInstanceId, runnerId: plan.runnerId, effectiveRunnerId: plan.runnerId,
        providerPresetId: plan.providerPresetId, now });
      const fence = toRuntimeAttemptFence(attempt);
      this.runs.createRunWithinTransaction({ id: seed.successorRunId, cwd: source.cwd, taskId: source.taskBinding.taskId,
        channelId: source.channelId, teammateId: source.participantId, workflowStepId: source.workflowStepId,
        threadId: source.threadId, turnId: source.turnId, turnRunRole: "resume", workUnitId: unit.id,
        parentRunId: source.runId, continuationReason: "user_input_answer", providerName: plan.providerName,
        providerModel: plan.providerModel, providerPresetId: plan.providerPresetId, selectedSkillId: plan.selectedSkillId,
        taskSnapshot: plan.taskSnapshot, providerSnapshot: plan.providerSnapshot,
        requestSnapshot: this.requestSnapshot(seed, prepared), createdAt: now });
      requireChange(this.context.database.prepare("UPDATE work_units SET linked_run_id=?,updated_at=? WHERE id=?"
        + " AND linked_run_id=? AND active_attempt_id=? AND status='waiting_for_input'")
        .run(seed.successorRunId, now, unit.id, source.runId, attempt.id).changes);
      const transition = { actor: "system" as const, now, event: "user_input_answered" as const,
        reason: "user_input_continuation", idempotencyKey: "user-input-admission:" + seed.deliveryId };
      requireTransition(this.ports.transitionWorkUnitStatus({ ...transition, ...fence, expectedStatus: "waiting_for_input",
        activeAttemptId: attempt.id, endedAt: null, errorCode: null, errorMessage: null }));
      if (source.taskBinding.kind === "stored_task") requireTransition(this.ports.transitionTaskStatus({ ...transition,
        taskId: source.taskBinding.taskId, expectedStatus: "waiting_for_input", currentRunId: seed.successorRunId }));
      if (source.workflowStepId) requireTransition(this.ports.transitionChannelWorkflowStepStatus({ ...transition,
        workflowStepId: source.workflowStepId, expectedStatus: "waiting_for_input", runId: seed.successorRunId, blocker: null }));
      requireChange(this.context.database.prepare("UPDATE user_input_requests SET wait_status='resuming',wait_revision=wait_revision+1,"
        + " updated_at=? WHERE request_id=? AND wait_status='waiting' AND wait_revision=?").run(now, seed.request.requestId, wait.revision).changes);
      requireChange(this.context.database.prepare("UPDATE user_input_deliveries SET status_revision=status_revision+1,updated_at=?"
        + " WHERE delivery_id=? AND status='claimed' AND status_revision=?").run(now, seed.deliveryId, bound.delivery.revision).changes);
      const binding = makeUserInputContinuationRecord<UserInputContinuationBinding>(this.context, seed, "binding", {
        executionRef: ref(prepared), runId: seed.successorRunId, fence,
        deliveryRevision: bound.delivery.revision + 1, waitRevision: wait.revision + 1,
      }, now);
      insertUserInputContinuationRecord(this.context, seed, binding);
      this.reconcile(seed, binding.runId, now);
      this.invalidate(seed, binding, "resuming", binding.waitRevision, binding.deliveryRevision, now);
      return this.readBinding(seed)!;
    });
  }

  acknowledge(input: AcknowledgeUserInputContinuation, now: string): { receipt: UserInputContinuationReceipt; replayed: boolean } {
    return this.transaction(now, () => {
      const captured = readSqliteWithinTransaction(this.context.database, () => JSON.parse(JSON.stringify(input)) as AcknowledgeUserInputContinuation);
      const bound = readUserInputDelivery(this.context, this.ports, captured.threadId, captured.deliveryId);
      if (!bound) throw new UserInputStoreError("not_found");
      const seed = this.preparation.seedWithinTransaction(captured.threadId, captured.deliveryId);
      if (!seed) throw new UserInputStoreError("invalid_record");
      const binding = this.readBinding(seed);
      if (!binding || !same(captured.bindingRef, ref(binding)) || !same(captured.sourceFence, binding.fence)
        || !same(captured.receipt, this.acceptance(seed, binding))) throw new UserInputStoreError("source_conflict");
      const prior = this.readReceiptWithinTransaction(captured.threadId, captured.deliveryId);
      if (prior) return { receipt: prior, replayed: true };
      const wait = this.ports.getUserInputWait(seed.source.threadId, seed.request.requestId);
      if (bound.delivery.status === "applied") throw new UserInputStoreError("invalid_record");
      if (bound.delivery.status !== "claimed" || bound.delivery.revision !== binding.deliveryRevision
        || !wait || wait.status !== "resuming" || wait.revision !== binding.waitRevision
        || userInputTimestamp(now) < userInputTimestamp(bound.delivery.updatedAt)) throw new UserInputStoreError("delivery_conflict");
      this.assertCurrentReceiver(seed, binding, "prepared");
      this.startCurrentReceiver(seed, binding, now);
      this.assertCurrentReceiver(seed, binding, "running");
      const receipt = makeUserInputContinuationRecord<UserInputContinuationReceipt>(this.context, seed, "receipt",
        { bindingRef: ref(binding), acceptance: captured.receipt }, now);
      insertUserInputContinuationRecord(this.context, seed, receipt);
      requireChange(this.context.database.prepare("UPDATE user_input_deliveries SET status='applied',status_revision=status_revision+1,updated_at=?,"
        + "claim_owner_id=NULL,claim_token=NULL,claim_expires_at=NULL,retry_at=NULL,last_error_code=NULL"
        + " WHERE delivery_id=? AND status='claimed' AND status_revision=?").run(now, seed.deliveryId, binding.deliveryRevision).changes);
      requireChange(this.context.database.prepare("UPDATE user_input_requests SET wait_status='resumed',wait_revision=wait_revision+1,updated_at=?"
        + " WHERE request_id=? AND wait_status='resuming' AND wait_revision=?").run(now, seed.request.requestId, binding.waitRevision).changes);
      this.reconcile(seed, binding.runId, now);
      this.invalidate(seed, binding, "resumed", binding.waitRevision + 1, binding.deliveryRevision + 1, now);
      return { receipt: this.readReceiptWithinTransaction(seed.source.threadId, seed.deliveryId)!, replayed: false };
    });
  }

  private readBinding(seed: UserInputContinuationSeed): UserInputContinuationBinding | undefined {
    const binding = readUserInputContinuationRecord<UserInputContinuationBinding>(this.context, seed, "binding");
    if (!binding) {
      if (this.ports.getRun(seed.successorRunId)) throw new UserInputStoreError("invalid_record");
      return undefined;
    }
    requireUserInputRecordKeys(binding, [...userInputEnvelopeKeys, "executionRef", "runId", "fence", "deliveryRevision", "waitRevision"]);
    const prepared = this.preparation.readWithinTransaction(seed, "execution");
    if (!prepared || !same(binding.executionRef, ref(prepared)) || binding.runId !== seed.successorRunId
      || !validDeliveryRevision(binding.deliveryRevision) || !validDeliveryRevision(binding.waitRevision)
      || !binding.fence || binding.fence.workUnitId !== seed.source.fence.workUnitId
      || binding.fence.attemptId === seed.source.fence.attemptId
      || userInputTimestamp(binding.createdAt) < userInputTimestamp(prepared.createdAt)) throw new UserInputStoreError("invalid_record");
    const run = this.ports.getRun(binding.runId), attempt = this.ports.getWorkUnitAttempt(binding.fence.attemptId);
    const turn = this.ports.getLingTurnForRun(binding.runId), plan = prepared.payload as UserInputContinuationExecutionPlan, s = seed.source;
    if (!run || !attempt || !same(toRuntimeAttemptFence(attempt), binding.fence) || attempt.runnerId !== plan.runnerId
      || attempt.providerPresetId !== plan.providerPresetId || !turn || turn.id !== s.turnId
      || !this.ports.listLingTurnRuns(s.turnId).some(link => link.runId === run.id && link.role === "resume")
      || run.cwd !== s.cwd || run.taskId !== s.taskBinding.taskId || run.threadId !== s.threadId || run.workUnitId !== binding.fence.workUnitId
      || run.channelId !== s.channelId || run.teammateId !== s.participantId || run.workflowStepId !== s.workflowStepId
      || run.parentRunId !== s.runId || run.continuationReason !== "user_input_answer"
      || run.providerName !== plan.providerName || run.providerModel !== plan.providerModel || run.providerPresetId !== plan.providerPresetId
      || run.selectedSkillId !== plan.selectedSkillId || !same(run.taskSnapshot, plan.taskSnapshot)
      || !same(run.providerSnapshot, plan.providerSnapshot) || !same(run.requestSnapshot, this.requestSnapshot(seed, prepared))) {
      throw new UserInputStoreError("invalid_record");
    }
    return binding;
  }
  private requestSnapshot(seed: UserInputContinuationSeed, prepared: import("../../user-input-host-continuation-types.js").UserInputContinuationPreparation) {
    const plan = prepared.payload as UserInputContinuationExecutionPlan;
    return { ...plan.runRequestSnapshot,
      userInputContinuation: { seedRef: ref(seed), requestRef: prepared.parentRef, executionRef: ref(prepared) } };
  }
  private acceptance(seed: UserInputContinuationSeed, binding: UserInputContinuationBinding): UserInputRunnerAcceptance {
    const plan = this.preparation.readWithinTransaction(seed, "execution")!.payload as UserInputContinuationExecutionPlan;
    return { schemaVersion: 1, boundary: "pi-session-ready", runId: binding.runId, attemptId: binding.fence.attemptId,
      taskId: seed.source.taskBinding.taskId, preparedInputFingerprint: plan.preparedInputFingerprint };
  }
  private assertCurrentReceiver(seed: UserInputContinuationSeed, binding: UserInputContinuationBinding,
    phase: "prepared" | "running"): void {
    const s = seed.source, fence = binding.fence;
    const run = this.ports.getRun(binding.runId), unit = this.ports.getWorkUnit(fence.workUnitId);
    const attempt = this.ports.getWorkUnitAttempt(fence.attemptId), thread = this.ports.getLingThread(s.threadId);
    const turn = this.ports.getLingTurnForRun(binding.runId), task = this.ports.getTask(s.taskBinding.taskId);
    if (!run || run.status !== (phase === "prepared" ? "queued" : "running")
      || !unit || unit.status !== (phase === "prepared" ? "claimed" : "running") || unit.endedAt
      || unit.workspaceId !== s.workspaceId || unit.channelId !== undefined && unit.channelId !== s.channelId
      || unit.teammateId !== undefined && unit.teammateId !== s.participantId
      || unit.activeAttemptId !== fence.attemptId || unit.linkedRunId !== binding.runId
      || !attempt || attempt.status !== (phase === "prepared" ? "created" : "started")
      || attempt.endedAt || !same(toRuntimeAttemptFence(attempt), fence)
      || !thread || thread.status === "archived" || thread.archivedAt || !turn
      || thread.workspaceId !== s.workspaceId || turn.workspaceId !== s.workspaceId || turn.threadId !== s.threadId
      || ["cancelled", "superseded", "succeeded", "failed"].includes(turn.status)
      || (s.taskBinding.kind === "stored_task" ? !task
        || task.status !== (phase === "prepared" ? "claimed" : "running") || task.currentRunId !== binding.runId : !!task)) {
      throw new UserInputStoreError("source_conflict");
    }
    if (s.workflowStepId) {
      const step = this.ports.getChannelWorkflowStep(s.workflowStepId), workflow = step ? this.ports.getChannelWorkflow(step.workflowId) : undefined;
      if (!step || step.status !== (phase === "prepared" ? "claimed" : "running")
        || step.runId !== binding.runId || step.toParticipantId !== s.participantId
        || step.workspaceId !== s.workspaceId || step.channelId !== s.channelId || !workflow || workflow.workspaceId !== s.workspaceId
        || workflow.channelId !== s.channelId || !["running", "waiting_for_input"].includes(workflow.status)) {
        throw new UserInputStoreError("source_conflict");
      }
    }
  }
  private startCurrentReceiver(seed: UserInputContinuationSeed, binding: UserInputContinuationBinding, now: string): void {
    const s = seed.source, fence = binding.fence;
    if (!this.ports.updateWorkUnitAttemptStatus({ ...fence, status: "started", startedAt: now,
      lastHeartbeatAt: now, now })) throw new UserInputStoreError("source_conflict");
    requireTransition(this.ports.transitionRunStatus({ runId: binding.runId, expectedStatus: "queued",
      event: "runner_started", actor: "runner", now, startedAt: now }));
    requireTransition(this.ports.transitionWorkUnitStatus({ ...fence, expectedStatus: "claimed",
      event: "runner_started", actor: "runner", now, activeAttemptId: fence.attemptId,
      startedAt: now, lastHeartbeatAt: now }));
    if (s.taskBinding.kind === "stored_task") requireTransition(this.ports.transitionTaskStatus({
      taskId: s.taskBinding.taskId, expectedStatus: "claimed", event: "start_run", actor: "system",
      currentRunId: binding.runId, now }));
    if (s.workflowStepId) requireTransition(this.ports.transitionChannelWorkflowStepStatus({
      workflowStepId: s.workflowStepId, expectedStatus: "claimed", event: "start", actor: "system",
      runId: binding.runId, now }));
  }
  private reconcile(seed: UserInputContinuationSeed, runId: string, now: string): void {
    this.ports.reconcileLingTurnStatus(seed.source.turnId, now);
    const active = this.context.database.prepare("SELECT id,status FROM run_sessions WHERE thread_id=?"
      + " AND status IN ('queued','running','waiting_for_approval')"
      + " ORDER BY CASE WHEN status='waiting_for_approval' THEN 0 ELSE 1 END,updated_at DESC,id DESC LIMIT 1").get(seed.source.threadId);
    this.ports.updateLingThread(seed.source.threadId, { status: active?.status === "waiting_for_approval" ? "waiting_for_approval" : "running",
      activeRunId: active ? String(active.id) : runId, lastRunId: runId }, now);
  }
  private invalidate(seed: UserInputContinuationSeed, binding: UserInputContinuationBinding, action: "resuming" | "resumed",
    waitRevision: number, deliveryRevision: number, now: string): void {
    for (const [entityType, entityId, revision] of [["user_input_wait", seed.request.requestId, waitRevision],
      ["user_input_delivery", seed.deliveryId, deliveryRevision]] as const) this.events.appendControlPlaneEventWithinTransaction({
      workspaceId: seed.source.workspaceId, cwd: seed.source.cwd, domain: "runs", entityType, entityId,
      action: entityType === "user_input_delivery" ? action === "resumed" ? "applied" : "claimed" : action,
      idempotencyKey: "user-input-continuation:" + entityType + ":" + entityId + ":" + revision,
      data: { threadId: seed.source.threadId, turnId: seed.source.turnId, requestId: seed.request.requestId,
        deliveryId: seed.deliveryId, runId: binding.runId, attemptId: binding.fence.attemptId, bindingId: binding.id,
        revision, waitRevision, deliveryRevision } }, now);
  }
  private transaction<T>(now: string, operation: () => T): T {
    userInputTimestamp(now);
    this.context.database.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.context.database.exec("COMMIT"); return result; }
    catch (error) { rollbackOwnedSqliteTransaction(this.context.database); throw error; }
  }
}
function requireTransition(result: { readonly ok: boolean }): void {
  if (!result.ok) throw new UserInputStoreError("source_conflict");
}
function requireChange(changes: number | bigint): void {
  if (Number(changes) !== 1) throw new UserInputStoreError("source_conflict");
}
