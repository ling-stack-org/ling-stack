import { isDeepStrictEqual } from "node:util";
import { createNodeRerunHostAdmissionPlanV1, parseNodeRerunIntent, projectNodeRerunGenerationV1,
  type NodeRerunGenerationProjectionV1, type NodeRerunPreparedTargetV1 } from "@ling-stack/contracts";
import type { PrepareNodeRerunTargetInput, PrepareNodeRerunTargetResult } from "../../node-rerun-store-types.js";
import type { DispatchNodeRerunTargetInput, DispatchNodeRerunTargetResult } from "../../node-rerun-store-types.js";
import { createRunId, type CreateRunInput, type RunStore } from "../../run-types.js";
import { createTaskId } from "../../workspace-types.js";
import { createWorkUnitId, toRuntimeAttemptFence } from "../../runtime-supervisor-types.js";
import type { SqliteRuntimeWorkUnitStore } from "./runtime-work-unit-store.js";
import type { SqliteRunSessionStore } from "./run-session-store.js";
import type { SqliteStoreContext } from "./store-context.js";
import { isCanonicalTimestamp, readNodeRerunApprovalBasis } from "./node-rerun-approval-authority.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { readSqliteSnapshot, readSqliteWithinTransaction, withSqliteSnapshotParentTransaction } from "./read-snapshot.js";
import { readReboundNodeRerunExecution, rerunDigest, rerunRecord } from "./node-rerun-target-input.js";
import type { SqliteRuntimeHostCapacityStore } from "./runtime-host-capacity-store.js";

type Ports = Pick<RunStore, "getNodeRerunIntent" | "getApprovalRequest" | "getRun" | "getWorkUnit" | "getWorkUnitAttempt"
  | "getRuntimeConcurrencyPolicy" | "getChannel" | "getTask" | "createTask" | "transitionTaskStatus"
  | "transitionWorkUnitStatus" | "appendRuntimeEvent">;

/** Owns one atomic preparation and consent consumption; never acquires execution resources or dispatches. */
export class SqliteNodeRerunTargetStore {
  constructor(private readonly context: SqliteStoreContext, private readonly ports: Ports,
    private readonly runs: SqliteRunSessionStore, private readonly units: SqliteRuntimeWorkUnitStore,
    private readonly workspaceCwd: string,
    private readonly hostCapacity?: (workspaceId: string) => Pick<SqliteRuntimeHostCapacityStore,
      "consumeNodeRerunDispatchGateWithinTransaction">) {}

  getNodeRerunTarget(recordId: string): NodeRerunPreparedTargetV1 | undefined {
    return readSqliteSnapshot(this.context.database, () => this.readTarget(recordId));
  }

  getNodeRerunGeneration(recordId: string): NodeRerunGenerationProjectionV1 | undefined {
    return readSqliteSnapshot(this.context.database, () => {
      const target = this.readTarget(recordId);
      if (!target) return undefined;
      const record = this.ports.getNodeRerunIntent(recordId);
      if (!record) throw new Error("node_rerun_target.binding_corrupt");
      return projectNodeRerunGenerationV1({ record, target });
    });
  }

  prepareNodeRerunTarget(input: PrepareNodeRerunTargetInput): PrepareNodeRerunTargetResult {
    if (!isCanonicalTimestamp(input.now) || typeof input.runtimeInstanceId !== "string" || !input.runtimeInstanceId.trim())
      throw new TypeError("node_rerun_target.invalid_input");
    const db = this.context.database;
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.prepareWithinTransaction(input);
      db.exec("COMMIT");
      return result;
    } catch (error) { rollbackOwnedSqliteTransaction(db); throw error; }
  }

  /**
   * Consume the dedicated Host gate and claim the prepared target atomically.
   * This is deliberately separate from the ordinary runtime queue, whose
   * source validator rejects node-rerun WorkUnits.
   */
  dispatchNodeRerunTarget(input: DispatchNodeRerunTargetInput): DispatchNodeRerunTargetResult {
    if (!isCanonicalTimestamp(input.now) || !input.recordId.trim()
      || !input.hostCapacity.intentId.trim() || !input.hostCapacity.dispatchToken.trim()) {
      throw new TypeError("node_rerun_target.dispatch_invalid_input");
    }
    const db = this.context.database;
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = withSqliteSnapshotParentTransaction(db, () => {
        const target = this.readTarget(input.recordId);
        if (!target || !this.hostCapacity) return { status: "changed" } as const;
        const run = this.ports.getRun(target.runId);
        const unit = this.ports.getWorkUnit(target.fence.workUnitId);
        const attempt = this.ports.getWorkUnitAttempt(target.fence.attemptId);
        const task = this.ports.getTask(target.taskId);
        if (!run || !unit || !attempt || !task || run.status !== "queued" || unit.status !== "queued"
          || attempt.status !== "created" || task.status !== "todo" || run.endedAt || unit.endedAt || attempt.endedAt
          || attempt.abortRequestedAt || unit.activeAttemptId !== attempt.id || run.workUnitId !== unit.id
          || unit.linkedRunId !== run.id || unit.ownerType !== "node_rerun_intent" || unit.ownerId !== input.recordId
          || !isCanonicalTimestamp(run.createdAt) || run.createdAt > input.now) return { status: "changed" } as const;
        const consumed = this.hostCapacity(target.workspaceId).consumeNodeRerunDispatchGateWithinTransaction({
          intentId: input.hostCapacity.intentId,
          token: input.hostCapacity.dispatchToken,
          source: { runId: target.runId, ...target.fence },
          now: input.now,
        });
        if (!consumed) return { status: "changed" } as const;
        const taskClaim = this.ports.transitionTaskStatus({ taskId: task.id, expectedStatus: "todo", event: "claim",
          actor: "system", reason: `run:${run.id}`, currentRunId: run.id, now: input.now });
        if (!taskClaim.ok) return { status: "changed" } as const;
        const unitClaim = this.ports.transitionWorkUnitStatus({ workUnitId: unit.id, attemptId: attempt.id,
          activeAttemptId: attempt.id, runtimeInstanceId: attempt.runtimeInstanceId, fencingToken: attempt.fencingToken,
          expectedStatus: "queued", event: "claim", actor: "system", now: input.now });
        if (!unitClaim.ok) return { status: "changed" } as const;
        this.ports.appendRuntimeEvent({ workUnitId: unit.id, attemptId: attempt.id,
          runtimeInstanceId: attempt.runtimeInstanceId, fencingToken: attempt.fencingToken,
          type: "work_unit_claimed", actor: "system", ts: input.now, data: { runId: run.id } });
        const dispatched = this.readTarget(input.recordId);
        if (!dispatched) throw new Error("node_rerun_target.dispatch_receipt_missing");
        return { status: "admitted", target: dispatched } as const;
      });
      db.exec(result.status === "admitted" ? "COMMIT" : "ROLLBACK");
      return result;
    } catch (error) {
      rollbackOwnedSqliteTransaction(db);
      throw error;
    }
  }

  private prepareWithinTransaction(input: PrepareNodeRerunTargetInput): PrepareNodeRerunTargetResult {
    const db = this.context.database;
    const record = this.ports.getNodeRerunIntent(input.recordId);
    if (!record) return { status: "blocked", code: "node_rerun_intent_not_found" };
    const existing = this.readTarget(record.id);
    if (existing) return { status: "duplicate", target: existing };
    const binding = db.prepare("SELECT approval_id FROM node_rerun_approval_requests WHERE intent_id=?").get(record.id);
    const approval = typeof binding?.approval_id === "string" ? this.ports.getApprovalRequest(binding.approval_id) : undefined;
    if (!approval) return { status: "blocked", code: "node_rerun_approval_unavailable" };
    const basis = readNodeRerunApprovalBasis(db, approval, id => this.ports.getNodeRerunIntent(id));
    if (!basis || approval.status !== "approved" || approval.resolvedBy !== "local-user" || approval.decisionKind !== "approve_once"
      || !approval.resolvedAt || !isCanonicalTimestamp(approval.resolvedAt) || approval.decisionRuleId !== undefined
      || basis.createdAt > approval.resolvedAt || approval.resolvedAt > input.now || basis.expiresAt <= input.now)
      return { status: "blocked", code: "node_rerun_approval_unavailable" };
    const runtime = this.ports.getRuntimeConcurrencyPolicy(record.workspaceId);
    if (!runtime || runtime.runtimeInstanceId !== input.runtimeInstanceId)
      return { status: "blocked", code: "node_rerun_runtime_changed" };
    const observation = readSqliteWithinTransaction(db, () => input.revalidate(parseNodeRerunIntent(record.intent)));
    if (!observation.observed || observation.admission.decision !== "eligible_for_host_admission")
      return { status: "blocked", code: "node_rerun_admission_blocked" };
    const plan = createNodeRerunHostAdmissionPlanV1({ intent: record.intent, ...observation, observed: observation.observed });
    if (plan.planFingerprint !== record.planFingerprint || plan.currentPolicyFingerprint !== record.policyFingerprint)
      return { status: "blocked", code: "node_rerun_plan_stale" };
    if (db.prepare("SELECT 1 FROM node_rerun_targets WHERE workspace_id=? AND source_attempt_id=? AND source_node_id=? AND released_at IS NULL")
      .get(record.workspaceId, record.intent.source.attemptId, record.intent.source.nodeId))
      return { status: "blocked", code: "node_rerun_generation_active" };
    const source = this.ports.getRun(record.intent.source.runId);
    const sourceAttempt = this.ports.getWorkUnitAttempt(record.intent.source.attemptId);
    const channel = this.ports.getChannel(basis.channelId);
    if (!source || !sourceAttempt || sourceAttempt.workUnitId !== source.workUnitId || sourceAttempt.effectiveRunnerId !== "pi"
      || source.channelId !== basis.channelId || !channel || channel.workspaceId !== record.workspaceId || channel.status !== "active")
      return { status: "blocked", code: "node_rerun_source_unavailable" };
    const taskId = createTaskId(), runId = createRunId(), workUnitId = createWorkUnitId();
    const rawExecution = readSqliteWithinTransaction(db, () => input.prepareExecution(structuredClone(source), taskId));
    const execution = readSqliteWithinTransaction(db, () => readReboundNodeRerunExecution(source, taskId, rawExecution));
    if (!execution || this.ports.getTask(taskId)) return { status: "blocked", code: "node_rerun_input_unavailable" };
    const task = this.ports.createTask({ id: taskId, channelId: source.channelId, title: execution.task.title, prompt: execution.task.prompt,
      requestedSkillId: source.selectedSkillId }, input.now);
    if (task.id !== taskId) throw new Error("node_rerun_target.task_identity_mismatch");
    const lineage = { recordId: record.id, generationId: basis.generationId, approvalId: approval.id, basisFingerprint: basis.fingerprint };
    const requestSnapshot = { cwd: source.cwd, workspaceCwd: this.workspaceCwd, executionCwd: source.cwd,
      task: execution.task, teammateId: source.teammateId, threadId: source.threadId, parentRunId: source.id,
      providerPresetId: source.providerPresetId, skipMemoryRecall: true,
      authorizationMode: execution.effectivePolicySnapshot.authorizationMode, permissionMode: execution.effectivePolicySnapshot.mode,
      workspaceAccessMode: execution.effectivePolicySnapshot.workspaceAccessMode,
      effectivePolicySnapshot: execution.effectivePolicySnapshot, runnerExecutionInput: execution.runnerExecutionInput,
      nodeRerunTarget: lineage };
    const frozen = JSON.parse(JSON.stringify({ id: runId, cwd: source.cwd, taskId, channelId: source.channelId,
      teammateId: source.teammateId, threadId: source.threadId, workUnitId, parentRunId: source.id,
      providerPresetId: source.providerPresetId, providerName: source.providerName, providerModel: source.providerModel,
      selectedSkillId: source.selectedSkillId, taskSnapshot: execution.task, providerSnapshot: source.providerSnapshot,
      requestSnapshot, createdAt: input.now })) as CreateRunInput;
    this.units.createWorkUnit({ id: workUnitId, workspaceId: record.workspaceId, kind: "task_run",
      ownerType: "node_rerun_intent", ownerId: record.id, taskId, channelId: source.channelId, teammateId: source.teammateId,
      providerPresetId: source.providerPresetId, runnerId: "pi", effectiveRunnerId: "pi", idempotencyKey: basis.generationId,
      status: "queued", createdByActor: "user", request: frozen.requestSnapshot, now: input.now });
    const attempt = this.units.createWorkUnitAttemptWithinTransaction({ workUnitId, attemptNumber: 1,
      runtimeInstanceId: input.runtimeInstanceId, runnerId: "pi", effectiveRunnerId: "pi", providerPresetId: source.providerPresetId, now: input.now });
    this.runs.createRunWithinTransaction(frozen);
    if (this.units.updateLinkedRunId(workUnitId, runId, input.now) !== 1) throw new Error("node_rerun_target.run_binding_missing");
    const inserted = db.prepare(`INSERT INTO node_rerun_targets
      (intent_id,workspace_id,approval_id,generation_id,basis_sha256,source_run_id,source_attempt_id,source_node_id,
       run_id,task_id,work_unit_id,attempt_id,runtime_instance_id,fencing_token,execution_json,execution_sha256,prepared_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(record.id, record.workspaceId, approval.id, basis.generationId, basis.fingerprint,
        source.id, record.intent.source.attemptId, record.intent.source.nodeId, runId, taskId, workUnitId, attempt.id,
        attempt.runtimeInstanceId, attempt.fencingToken, JSON.stringify(frozen), rerunDigest(frozen), input.now);
    const target = this.readTarget(record.id);
    if (inserted.changes !== 1 || !target) throw new Error("node_rerun_target.commit_receipt_missing");
    return { status: "created", target };
  }

  private readTarget(recordId: string): NodeRerunPreparedTargetV1 | undefined {
    const row = this.context.database.prepare("SELECT * FROM node_rerun_targets WHERE intent_id=?").get(recordId);
    if (!row) return undefined;
    const record = this.ports.getNodeRerunIntent(recordId);
    const consent = this.context.database.prepare("SELECT * FROM node_rerun_approval_requests WHERE intent_id=?").get(recordId);
    const run = this.ports.getRun(String(row.run_id)), unit = this.ports.getWorkUnit(String(row.work_unit_id));
    const task = this.ports.getTask(String(row.task_id));
    const attempt = this.ports.getWorkUnitAttempt(String(row.attempt_id));
    const frozen = JSON.parse(String(row.execution_json)) as CreateRunInput;
    const request = rerunRecord(frozen.requestSnapshot) ? frozen.requestSnapshot : undefined;
    if (!record || !run || !unit || !task || !attempt || !consent || consent.approval_id !== row.approval_id
      || consent.generation_id !== row.generation_id || consent.basis_sha256 !== row.basis_sha256 || row.workspace_id !== record.workspaceId
      || row.source_run_id !== record.intent.source.runId || row.source_attempt_id !== record.intent.source.attemptId
      || row.source_node_id !== record.intent.source.nodeId || row.execution_sha256 !== rerunDigest(frozen)
      || JSON.stringify(frozen) !== row.execution_json || !isCanonicalTimestamp(String(row.prepared_at))
      || frozen.id !== run.id || frozen.workUnitId !== unit.id || frozen.taskId !== row.task_id || frozen.taskId !== run.taskId
      || task.id !== run.taskId || task.channelId !== run.channelId || task.title !== (frozen.taskSnapshot as { title?: unknown }).title
      || task.prompt !== (frozen.taskSnapshot as { prompt?: unknown }).prompt
      || task.currentRunId !== undefined && task.currentRunId !== run.id
      || run.parentRunId !== row.source_run_id || frozen.parentRunId !== run.parentRunId
      || run.workflowStepId !== undefined || frozen.workflowStepId !== undefined || frozen.turnId !== undefined
      || run.continuationReason !== undefined || run.interventionId !== undefined
      || frozen.cwd !== run.cwd || frozen.channelId !== run.channelId || frozen.teammateId !== run.teammateId
      || frozen.threadId !== run.threadId || frozen.providerName !== run.providerName || frozen.providerModel !== run.providerModel
      || frozen.providerPresetId !== run.providerPresetId || frozen.selectedSkillId !== run.selectedSkillId
      || frozen.createdAt !== run.createdAt || frozen.createdAt !== row.prepared_at
      || !isDeepStrictEqual(frozen.taskSnapshot, run.taskSnapshot) || !isDeepStrictEqual(frozen.providerSnapshot, run.providerSnapshot)
      || !isDeepStrictEqual(frozen.requestSnapshot, run.requestSnapshot) || !isDeepStrictEqual(unit.request, run.requestSnapshot)
      || !request || !isDeepStrictEqual(request.nodeRerunTarget, { recordId, generationId: row.generation_id,
        approvalId: row.approval_id, basisFingerprint: row.basis_sha256 })
      || unit.workspaceId !== record.workspaceId || unit.ownerType !== "node_rerun_intent" || unit.ownerId !== recordId
      || unit.kind !== "task_run" || unit.linkedRunId !== run.id || run.workUnitId !== unit.id || unit.taskId !== run.taskId
      || unit.channelId !== run.channelId || unit.teammateId !== run.teammateId || unit.providerPresetId !== run.providerPresetId
      || unit.runnerId !== "pi" || unit.effectiveRunnerId !== "pi" || unit.attemptCount !== 1
      || unit.idempotencyKey !== row.generation_id || unit.activeAttemptId !== attempt.id || attempt.workUnitId !== unit.id
      || attempt.attemptNumber !== 1 || attempt.effectiveRunnerId !== "pi" || attempt.runnerId !== "pi"
      || attempt.providerPresetId !== run.providerPresetId || attempt.runtimeInstanceId !== row.runtime_instance_id
      || attempt.fencingToken !== row.fencing_token) throw new Error("node_rerun_target.binding_corrupt");
    return { schemaVersion: 1, kind: "node_rerun_prepared_target", recordId, workspaceId: record.workspaceId,
      generationId: String(row.generation_id), approvalId: String(row.approval_id), source: record.intent.source,
      runId: run.id, taskId: run.taskId, fence: toRuntimeAttemptFence(attempt), frozenExecutionDigest: String(row.execution_sha256),
      preparedAt: String(row.prepared_at), executionAuthorized: false };
  }
}
