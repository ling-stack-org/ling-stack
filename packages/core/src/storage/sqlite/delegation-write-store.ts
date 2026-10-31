import { randomUUID, createHash } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import { resolveDelegationChildBudget, resolveDelegationPriceForBudget, quoteDelegationTokenCostMicros, type DelegationEffectiveBudget, type DelegationTokenPriceSnapshot } from "../../harness/delegation-authority.js";
import {
  type DelegationAuthorityCapture, type DelegationBudgetCharge, type DelegationBudgetReservation,
  type DelegationExecutionAuthority, type DelegationRootBudgetRecord, type DelegationWriteStorePorts,
  type PrepareDelegatedChildInput, type PreparedDelegatedChild, type ReserveDelegationModelInvocationInput,
} from "../../harness/delegation-write-types.js";
import {
  assertDelegationAuthoritySubset, delegationAuthority, delegationBudget, delegationCapture, delegationDigest,
  delegationFence, delegationId, delegationInteger, delegationJson, delegationRecord, delegationTimestamp,
  delegationWriteFail as fail, providerKey,
} from "../../harness/delegation-write-validation.js";
import type { RunSession } from "../../run-types.js";
import type { RuntimeAttemptFenceV1, WorkUnit } from "../../runtime-supervisor-types.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { mapDelegationBudgetCharge, mapDelegationBudgetReservation, mapDelegationRootBudget, type DelegationBudgetRow } from "./delegation-budget-rows.js";
import { resolveRunAncestry, RunAncestryError } from "./run-ancestry.js";
import type { SqliteStoreContext } from "./store-context.js";
import { harnessArtifactOwnerHolder, syncHarnessArtifactOwnerPins } from "./harness-artifact-recovery-pins.js";
import { assertNoPendingRunTerminalIntent } from "./run-terminal-intent-store.js";
import { assertNoRunSuspensionAdmission } from "./run-suspension-store.js";
import { assertRootSuspensionStartAdmission } from "./run-suspension-start-records.js";
import { assertDelegatedSuspensionParentStartAdmission, assertDelegatedSuspensionStartAdmission } from "./run-suspension-delegated-records.js";

interface Allocation { readonly root: DelegationRootBudgetRecord; readonly reservation?: DelegationBudgetReservation; readonly authority: DelegationExecutionAuthority; readonly run: RunSession; readonly unit: WorkUnit }
interface Usage { readonly tokens: bigint; readonly cost: bigint; readonly costKnown: boolean; readonly closed: boolean }

/**
 * Internal Host-only writer. Constructor ports are custody, not request data.
 * Every capacity decision, artifact pin and child identity commits in the same
 * SQLite write transaction. It does not start a Runner or enable delegation.
 */
export class SqliteDelegationWriteStore {
  constructor(private readonly context: SqliteStoreContext, private readonly ports: DelegationWriteStorePorts) {}

  getRootDelegationBudget(rootRunId: string): DelegationRootBudgetRecord | undefined {
    const row = this.row("delegation_root_budgets", "root_run_id=?", [delegationId(rootRunId)]);
    return row ? mapDelegationRootBudget(row) : undefined;
  }
  getDelegationBudgetReservation(id: string): DelegationBudgetReservation | undefined {
    const row = this.row("delegation_budget_reservations", "id=?", [delegationId(id)]);
    return row ? mapDelegationBudgetReservation(row) : undefined;
  }
  getDelegationBudgetCharge(id: string): DelegationBudgetCharge | undefined {
    const row = this.row("delegation_budget_charges", "id=?", [delegationId(id)]);
    return row ? mapDelegationBudgetCharge(row) : undefined;
  }

  /** Original Host activation composition only. A stopped source is not a generic admission phase. */
  assertRootSuspensionAuthorityWithinTransaction(input: {
    readonly runId: string; readonly sourceFence: RuntimeAttemptFenceV1; readonly runnerId: string; readonly now: string;
  }, readRecoveryAuthority: (runId: string, sourceFence: RuntimeAttemptFenceV1) => DelegationExecutionAuthority): DelegationRootBudgetRecord | undefined {
    this.assertTransaction();
    const root = this.getRootDelegationBudget(input.runId), run = this.ports.getRun(input.runId);
    const unit = run?.workUnitId ? this.ports.getWorkUnit(run.workUnitId) : undefined;
    if (!run || !unit || run.parentRunId) fail("delegation.lineage_invalid");
    const current = delegationAuthority(readRecoveryAuthority(run.id, input.sourceFence));
    if (!current.runnerIds.includes(input.runnerId) || !current.providers.some(provider =>
      provider.providerId === run.providerName && provider.model === run.providerModel)) fail("delegation.authority_invalid");
    this.assertScope(run, unit, current);
    if (!root) { this.assertTransaction(); return undefined; }
    if (root.rootRunId !== run.id) fail("delegation.lineage_invalid");
    if (input.now < root.frozenAt || input.now >= root.deadlineAt) fail("delegation.deadline_exceeded");
    const frozen = this.readAuthorityArtifact(root.authorityArtifactId, root.rootRunId, root.authorityDigest);
    if (delegationJson(current) !== delegationJson(frozen)) fail("delegation.authority_invalid");
    this.readRootPrice(root);
    if (this.context.database.prepare(`SELECT 1 FROM delegation_budget_charges WHERE root_run_id=?
      AND state NOT IN ('measured','cancelled_before_dispatch') LIMIT 1`).get(run.id)
      || this.context.database.prepare("SELECT 1 FROM delegation_budget_reservations WHERE root_run_id=? AND state='unresolved' LIMIT 1").get(run.id)) fail("delegation.settlement_incomplete");
    this.assertCapacity({ root, authority: current, run, unit }, 0, 0);
    this.assertTransaction();
    return root;
  }

  /** Original186 receiver: source authority is rebuilt independently, never borrowed from a stopped live owner. */
  assertDelegatedSuspensionAuthorityWithinTransaction(input: {
    readonly runId: string; readonly sourceFence: RuntimeAttemptFenceV1; readonly now: string;
  }, readAuthority: (runId: string, fence: RuntimeAttemptFenceV1) => DelegationExecutionAuthority): DelegationRootBudgetRecord {
    this.assertTransaction();
    const run = this.ports.getRun(input.runId), unit = run?.workUnitId ? this.ports.getWorkUnit(run.workUnitId) : undefined;
    const row = this.row("delegation_budget_reservations", "child_run_id=?", [input.runId]);
    const reservation = row ? mapDelegationBudgetReservation(row) : undefined;
    const step = reservation ? this.row("delegation_steps", "id=?", [reservation.delegationStepId]) : undefined;
    const root = reservation ? this.getRootDelegationBudget(reservation.rootRunId) : undefined;
    if (!run?.parentRunId || !unit || !reservation || !step || !root || reservation.state !== "reserved"
      || step.parent_run_id !== run.parentRunId || step.child_run_id !== run.id || step.root_run_id !== root.rootRunId
      || unit.ownerType !== "delegation_step" || unit.ownerId !== step.id) fail("delegation.lineage_invalid");
    if (input.now < root.frozenAt || input.now >= root.deadlineAt || input.now >= reservation.deadlineAt) fail("delegation.deadline_exceeded");
    this.assertRootOpenForSpawn(root.rootRunId);
    const authority = this.readStepAuthority(step), current = delegationAuthority(readAuthority(run.id, input.sourceFence));
    assertDelegationAuthoritySubset(current, authority); assertDelegationAuthoritySubset(authority, current);
    if (current.authoritySetId !== authority.authoritySetId || !current.runnerIds.includes(unit.effectiveRunnerId ?? unit.runnerId ?? "")
      || !current.providers.some(provider => provider.providerId === run.providerName && provider.model === run.providerModel)) fail("delegation.authority_invalid");
    const ancestry = resolveRunAncestry({ getRun: this.ports.getRun,
      getWorkspaceId: value => value.workUnitId ? this.ports.getWorkUnit(value.workUnitId)?.workspaceId : undefined },
      { leafRunId: run.id, expectedRootRunId: root.rootRunId, expectedWorkspaceId: authority.workspaceId });
    this.assertScope(run, unit, current, ancestry.entries.map(value => value.id));
    assertDelegationAuthoritySubset(this.readAuthorityArtifact(root.authorityArtifactId, root.rootRunId, root.authorityDigest), authority);
    this.readRootPrice(root);
    // Parent/sibling model requests can already be in flight after their real
    // SDK ACK. Their current-owner reservations still count at full capacity;
    // unlike unknown or retired-source usage they do not need to settle before
    // another child ACK. Never waive a charge on the child being activated.
    if (this.context.database.prepare(`SELECT 1 FROM delegation_budget_charges c
      WHERE c.root_run_id=? AND c.state NOT IN ('measured','cancelled_before_dispatch')
        AND (c.state<>'reserved' OR c.run_id=? OR NOT EXISTS (
          SELECT 1 FROM run_sessions r
          JOIN work_units u ON u.id=r.work_unit_id AND u.linked_run_id=r.id
          JOIN work_unit_attempts a ON a.id=u.active_attempt_id AND a.work_unit_id=u.id
          WHERE r.id=c.run_id AND a.id=c.attempt_id AND r.status='running'
            AND u.status='running' AND a.status='started'
            AND r.ended_at IS NULL AND u.ended_at IS NULL AND a.ended_at IS NULL
            AND a.abort_requested_at IS NULL)) LIMIT 1`).get(root.rootRunId, run.id)
      || this.context.database.prepare("SELECT 1 FROM delegation_budget_reservations WHERE root_run_id=? AND state='unresolved' LIMIT 1").get(root.rootRunId)) fail("delegation.settlement_incomplete");
    this.assertCapacity({ root, reservation, authority, run, unit }, 0, 0);
    return root;
  }

  /** Internal lifecycle joined capability. It cannot create a transaction or dispatch. */
  assertDelegatedChildDispatchAuthorityWithinTransaction(input: {
    readonly childRunId: string; readonly stepId: string; readonly sourceFence: RuntimeAttemptFenceV1; readonly now: string;
  }): void {
    this.assertTransaction();
    const request = delegationRecord(input, ["childRunId", "stepId", "sourceFence", "now"]);
    const childRunId = delegationId(request.childRunId), stepId = delegationId(request.stepId);
    assertNoPendingRunTerminalIntent(this.context, childRunId);
    assertNoRunSuspensionAdmission(this.context, childRunId);
    assertRootSuspensionStartAdmission(this.context.database, childRunId);
    // A created child's physical dispatch precedes its own ACK; ancestors must
    // already have their actual ACK. Model/spawn effects use the full gate.
    assertDelegatedSuspensionParentStartAdmission(this.context.database, childRunId);
    const sourceFence = delegationFence(request.sourceFence), now = delegationTimestamp(request.now);
    const row = this.row("delegation_budget_reservations", "child_run_id=? AND delegation_step_id=?", [childRunId, stepId]);
    if (!row) fail("delegation.lineage_invalid");
    const reservation = mapDelegationBudgetReservation(row);
    const step = this.row("delegation_steps", "id=?", [stepId]);
    const run = this.ports.getRun(childRunId), unit = run?.workUnitId ? this.ports.getWorkUnit(run.workUnitId) : undefined;
    if (!step || !run || !unit || step.root_run_id !== reservation.rootRunId || step.parent_run_id !== run.parentRunId
      || !["spawning", "running", "resuming"].includes(String(step.state))
      || step.child_run_id !== null && step.child_run_id !== childRunId || reservation.state !== "reserved"
      || unit.ownerType !== "delegation_step" || unit.ownerId !== stepId || run.workUnitId !== sourceFence.workUnitId
      || unit.linkedRunId !== childRunId || unit.activeAttemptId !== sourceFence.attemptId) fail("delegation.lineage_invalid");
    const owner = this.context.database.prepare(`SELECT 1 FROM work_unit_attempts WHERE id=? AND work_unit_id=?
      AND runtime_instance_id=? AND fencing_token=? AND status='created' AND ended_at IS NULL AND abort_requested_at IS NULL`)
      .get(sourceFence.attemptId, sourceFence.workUnitId, sourceFence.runtimeInstanceId, sourceFence.fencingToken);
    if (!owner) fail("delegation.source_attempt_stale");
    const root = this.getRootDelegationBudget(reservation.rootRunId);
    if (!root || now < root.frozenAt || now >= root.deadlineAt || now >= reservation.deadlineAt) fail("delegation.deadline_exceeded");
    const authority = this.readStepAuthority(step);
    const rootAuthority = this.readAuthorityArtifact(root.authorityArtifactId, root.rootRunId, root.authorityDigest);
    this.readRootPrice(root);
    assertDelegationAuthoritySubset(rootAuthority, authority);
    let ancestry;
    try { ancestry = resolveRunAncestry({ getRun: this.ports.getRun,
      getWorkspaceId: value => value.workUnitId ? this.ports.getWorkUnit(value.workUnitId)?.workspaceId : undefined },
    { leafRunId: childRunId, expectedRootRunId: root.rootRunId, expectedWorkspaceId: authority.workspaceId }); }
    catch (error) { if (error instanceof RunAncestryError) fail("delegation.lineage_invalid"); throw error; }
    this.assertScope(run, unit, authority, ancestry.entries.map(value => value.id));
    const current = delegationAuthority(this.ports.readCurrentAuthority(childRunId, sourceFence));
    assertDelegationAuthoritySubset(current, authority);
    if (authority.authoritySetId !== current.authoritySetId || !authority.runnerIds.includes(unit.effectiveRunnerId ?? unit.runnerId ?? "")) fail("delegation.authority_invalid");
    this.assertTransaction();
  }

  freezeRootDelegationBudget(input: { readonly runId: string; readonly sourceFence: RuntimeAttemptFenceV1; readonly capture: unknown; readonly now: string }): DelegationRootBudgetRecord {
    const request = delegationRecord(input, ["runId", "sourceFence", "capture", "now"]);
    const runId = delegationId(request.runId);
    const fence = delegationFence(request.sourceFence);
    const now = delegationTimestamp(request.now);
    const capture = this.capture(request.capture, runId, fence);
    if (capture.rootRunId !== runId) fail("delegation.lineage_invalid");
    const payload = { kind: "delegation.authority.v1", capture };
    return this.transaction(() => {
      const existing = this.getRootDelegationBudget(runId);
      if (existing) {
        this.readArtifact(existing.authorityArtifactId, runId, existing.authorityDigest);
        if (existing.authorityDigest !== delegationDigest(payload)) fail("delegation.root_budget_conflict");
        this.readRootPrice(existing);
        return existing;
      }
      this.assertOwner(runId, fence, "admission");
      assertNoRunSuspensionAdmission(this.context, runId);
      const run = this.ports.getRun(runId);
      const unit = run?.workUnitId ? this.ports.getWorkUnit(run.workUnitId) : undefined;
      if (!run || !unit || run.parentRunId !== undefined) fail("delegation.lineage_invalid");
      this.assertScope(run, unit, capture.authority);
      this.currentSubset(capture, runId, fence);
      const hardTimeoutMs = delegationInteger(unit.timeoutPolicy.hardTimeoutMs);
      const duration = Math.min(hardTimeoutMs, capture.budget?.wallTimeBudgetMs ?? hardTimeoutMs);
      if (!duration || !Number.isSafeInteger(Date.parse(now) + duration)) fail("delegation.deadline_exceeded");
      const deadline = new Date(Date.parse(now) + duration);
      if (!Number.isFinite(deadline.getTime())) fail("delegation.deadline_exceeded");
      const authority = this.artifact(runId, payload, now);
      const price = capture.price === undefined ? undefined : this.artifact(runId, capture.price, now);
      this.insert("delegation_root_budgets", {
        root_run_id: runId, schema_version: 1, authority_artifact_id: authority.id, authority_digest: authority.digest,
        price_artifact_id: price?.id ?? null, price_digest: price?.digest ?? null,
        token_budget: capture.budget?.tokenBudget ?? null, cost_budget_micros: capture.budget?.costBudgetMicros ?? null,
        deadline_at: deadline.toISOString(), frozen_at: now, created_at: now,
      });
      const created = this.getRootDelegationBudget(runId);
      if (!created) fail("delegation.persisted_fact_invalid");
      syncHarnessArtifactOwnerPins(this.context.database, { holder: harnessArtifactOwnerHolder("delegation_root", runId),
        artifactIds: [created.authorityArtifactId, ...(created.priceArtifactId ? [created.priceArtifactId] : [])], keep: true, now });
      return created;
    });
  }

  prepareDelegatedChild(input: PrepareDelegatedChildInput): PreparedDelegatedChild {
    const request = delegationRecord(input, ["parentRunId", "sourceFence", "spawnCallId", "objective", "requestedBudget", "required", "capture", "now"]);
    const parentRunId = delegationId(request.parentRunId);
    const sourceFence = delegationFence(request.sourceFence);
    const spawnCallId = delegationId(request.spawnCallId);
    const objective = delegationId(request.objective);
    const requestedBudget = delegationBudget(request.requestedBudget);
    const now = delegationTimestamp(request.now);
    if (typeof request.required !== "boolean") fail("delegation.invalid_input");
    const required = request.required;
    const capture = this.capture(request.capture, parentRunId, sourceFence);
    const requestDigest = delegationDigest({ parentRunId, sourceFence, spawnCallId, objective, requestedBudget, required, capture });
    return this.transaction(() => {
      // Response-loss replay precedes the live parent gate. Never reserve twice.
      const step = this.row("delegation_steps", "parent_attempt_id=? AND spawn_call_id=?", [sourceFence.attemptId, spawnCallId]);
      if (step) {
        const reservationRow = this.row("delegation_budget_reservations", "delegation_step_id=?", [step.id]);
        if (!reservationRow) fail("delegation.persisted_fact_invalid");
        const reservation = mapDelegationBudgetReservation(reservationRow);
        if (reservation.requestDigest !== requestDigest || step.parent_run_id !== parentRunId || step.root_run_id !== capture.rootRunId) fail("delegation.idempotency_conflict");
        this.readStepAuthority(step);
        const storedObjective = this.readArtifact(delegationId(step.objective_artifact_id, "delegation.persisted_fact_invalid"), parentRunId);
        if (delegationDigest(storedObjective) !== delegationDigest({ schemaVersion: 1, objective })) fail("delegation.persisted_fact_invalid");
        const childRun = this.ports.getRun(reservation.childRunId);
        const childWorkUnit = childRun?.workUnitId ? this.ports.getWorkUnit(childRun.workUnitId) : undefined;
        if (!childRun || !childWorkUnit || childRun.parentRunId !== parentRunId || childWorkUnit.linkedRunId !== childRun.id) fail("delegation.persisted_fact_invalid");
        this.pinStepArtifacts(step, now);
        return { stepId: String(step.id), reservation, childRun, childWorkUnit, replayed: true };
      }
      this.assertOwner(parentRunId, sourceFence, "running");
      const allocation = this.allocation(parentRunId, capture);
      this.assertRootOpenForSpawn(allocation.root.rootRunId);
      assertNoPendingRunTerminalIntent(this.context, parentRunId);
      assertNoRunSuspensionAdmission(this.context, parentRunId);
      this.currentSubset(capture, parentRunId, sourceFence);
      assertDelegationAuthoritySubset(allocation.authority, capture.authority);
      const parentBudget = this.effectiveParentBudget(allocation);
      const rootBudget = this.rootBudgetSnapshot(allocation.root);
      const hostBudget = resolveDelegationChildBudget({ root: rootBudget, parent: parentBudget, requested: capture.budget ?? {}, now });
      const effective = resolveDelegationChildBudget({ root: rootBudget, parent: hostBudget, requested: requestedBudget, now });
      this.selectPrice(allocation.root, capture, effective.costBudgetMicros);
      this.assertCapacity(allocation, effective.tokenBudget, effective.costBudgetMicros);
      const parentStep = allocation.reservation ? this.row("delegation_steps", "id=?", [allocation.reservation.delegationStepId]) : undefined;
      const depth = parentStep ? delegationInteger(parentStep.depth) + 1 : 1;
      if (depth > Math.min(allocation.authority.maxDepth, capture.authority.maxDepth)) fail("delegation.depth_exceeded");
      const stepId = `delegation_${randomUUID()}`;
      const childRunId = `run_${randomUUID()}`;
      const childWorkUnitId = `work_${randomUUID()}`;
      const reservationId = `delegation_reservation_${randomUUID()}`;
      const key = `delegation:${sourceFence.attemptId}:${spawnCallId}`;
      const objectiveArtifact = this.artifact(parentRunId, { schemaVersion: 1, objective }, now);
      const pins = this.authorityArtifacts(parentRunId, capture, now);
      const childWorkUnit = this.ports.createWorkUnitWithinTransaction({ id: childWorkUnitId,
        workspaceId: allocation.unit.workspaceId, kind: "task_run", ownerType: "delegation_step", ownerId: stepId,
        channelId: allocation.run.channelId, taskId: allocation.run.taskId, teammateId: capture.authority.participantId,
        runnerId: capture.runnerId, requestedRunnerId: capture.runnerId, effectiveRunnerId: capture.runnerId,
        idempotencyKey: key, status: "queued", createdByActor: "system",
        request: { schemaVersion: 1, kind: "delegated_child", objective, parentRunId, delegationStepId: stepId,
          authorityArtifactId: pins.permission.id, deadlineAt: effective.deadlineAt },
        timeoutPolicy: { ...allocation.unit.timeoutPolicy, hardTimeoutMs: effective.wallTimeBudgetMs }, now });
      this.assertTransaction();
      const childRun = this.ports.createRunWithinTransaction({ id: childRunId, cwd: allocation.run.cwd,
        taskId: allocation.run.taskId, channelId: allocation.run.channelId, teammateId: capture.authority.participantId,
        workflowStepId: allocation.run.workflowStepId, providerName: capture.provider.providerId,
        providerPresetId: allocation.run.providerPresetId, providerModel: capture.provider.model, providerSnapshot: { ...capture.provider },
        taskSnapshot: { id: allocation.run.taskId, channelId: allocation.run.channelId, title: objective, prompt: objective },
        requestSnapshot: { schemaVersion: 1, kind: "delegated_child", objective, delegationStepId: stepId,
          authorityArtifactId: pins.permission.id, deadlineAt: effective.deadlineAt },
        threadId: allocation.run.threadId, workUnitId: childWorkUnit.id, parentRunId, createdAt: now });
      this.assertTransaction();
      if (this.ports.linkWorkUnitRunWithinTransaction(childWorkUnit.id, childRun.id, now) !== 1) fail("delegation.persisted_fact_invalid");
      this.assertTransaction();
      this.insert("delegation_steps", { id: stepId, schema_version: 1, root_run_id: allocation.root.rootRunId,
        parent_run_id: parentRunId, parent_attempt_id: sourceFence.attemptId, workflow_id: capture.authority.workflowId ?? null,
        workflow_step_id: capture.authority.workflowStepId ?? null, parent_delegation_step_id: parentStep?.id ?? null,
        child_run_id: null, spawn_call_id: spawnCallId, objective_artifact_id: objectiveArtifact.id, required: required ? 1 : 0,
        state: "spawning", depth, permission_snapshot_artifact_id: pins.permission.id, tool_allowlist_artifact_id: pins.tools.id,
        workspace_scope_artifact_id: pins.workspace.id, provider_policy_artifact_id: pins.provider.id,
        token_budget: effective.tokenBudget ?? null, cost_budget_micros: effective.costBudgetMicros ?? null,
        wall_time_budget_ms: effective.wallTimeBudgetMs, idempotency_key: key, revision: 0, failure_code: null,
        created_at: now, updated_at: now, completed_at: null });
      this.insert("delegation_budget_reservations", { id: reservationId, schema_version: 1,
        root_run_id: allocation.root.rootRunId, delegation_step_id: stepId, parent_reservation_id: allocation.reservation?.id ?? null,
        child_run_id: childRun.id, request_digest: requestDigest, token_reserved: effective.tokenBudget ?? null,
        cost_reserved_micros: effective.costBudgetMicros ?? null, deadline_at: effective.deadlineAt,
        state: "reserved", settled_token_usage: null, settled_cost_micros: null, settlement_digest: null, failure_code: null,
        idempotency_key: key, revision: 0, created_at: now, updated_at: now, settled_at: null });
      const reservation = this.getDelegationBudgetReservation(reservationId);
      const linked = this.ports.getWorkUnit(childWorkUnit.id);
      if (!reservation || !linked || linked.linkedRunId !== childRun.id) fail("delegation.persisted_fact_invalid");
      this.pinStepArtifacts(this.row("delegation_steps", "id=?", [stepId])!, now);
      return { stepId, reservation, childRun, childWorkUnit: linked, replayed: false };
    });
  }

  reserveModelInvocation(input: ReserveDelegationModelInvocationInput): DelegationBudgetCharge {
    const request = delegationRecord(input, ["runId", "sourceFence", "invocationId", "reservedTokens", "reservedCostMicros", "capture", "now"]);
    const runId = delegationId(request.runId);
    const fence = delegationFence(request.sourceFence);
    const invocationId = delegationId(request.invocationId);
    const reservedTokens = request.reservedTokens === undefined ? undefined : delegationInteger(request.reservedTokens);
    const reservedCostMicros = request.reservedCostMicros === undefined ? undefined : delegationInteger(request.reservedCostMicros);
    const now = delegationTimestamp(request.now);
    const capture = this.capture(request.capture, runId, fence);
    const requestDigest = delegationDigest({ runId, fence, invocationId, reservedTokens, reservedCostMicros, capture });
    return this.transaction(() => {
      const existing = this.row("delegation_budget_charges", "run_id=? AND attempt_id=? AND invocation_id=?", [runId, fence.attemptId, invocationId]);
      if (existing) {
        const charge = mapDelegationBudgetCharge(existing);
        if (charge.requestDigest !== requestDigest) fail("delegation.idempotency_conflict");
        return charge;
      }
      this.assertOwner(runId, fence, "running");
      assertNoRunSuspensionAdmission(this.context, runId);
      const allocation = this.allocation(runId, capture);
      this.currentSubset(capture, runId, fence);
      assertDelegationAuthoritySubset(allocation.authority, capture.authority);
      const parentBudget = resolveDelegationChildBudget({ root: this.rootBudgetSnapshot(allocation.root),
        parent: this.effectiveParentBudget(allocation), requested: capture.budget ?? {}, now });
      if (parentBudget.tokenBudget !== undefined && reservedTokens === undefined || parentBudget.costBudgetMicros !== undefined && reservedCostMicros === undefined) fail("delegation.invalid_input");
      if (parentBudget.tokenBudget !== undefined && reservedTokens! > parentBudget.tokenBudget
        || parentBudget.costBudgetMicros !== undefined && reservedCostMicros! > parentBudget.costBudgetMicros) fail("delegation.budget_exhausted");
      const price = this.selectPrice(allocation.root, capture, reservedCostMicros ?? parentBudget.costBudgetMicros);
      this.assertCapacity(allocation, reservedTokens, reservedCostMicros);
      const id = `delegation_charge_${randomUUID()}`;
      this.insert("delegation_budget_charges", { id, schema_version: 1, root_run_id: allocation.root.rootRunId,
        reservation_id: allocation.reservation?.id ?? null, run_id: runId, attempt_id: fence.attemptId, invocation_id: invocationId,
        request_digest: requestDigest, price_artifact_id: price ? allocation.root.priceArtifactId! : null,
        price_digest: price ? allocation.root.priceDigest! : null, reserved_tokens: reservedTokens ?? null,
        reserved_cost_micros: reservedCostMicros ?? null, input_tokens: null, cached_input_tokens: null,
        output_tokens: null, actual_cost_micros: null, state: "reserved", idempotency_key: `delegation-charge:${fence.attemptId}:${invocationId}`,
        revision: 0, created_at: now, updated_at: now, settled_at: null });
      const charge = this.getDelegationBudgetCharge(id);
      if (!charge) fail("delegation.persisted_fact_invalid");
      return charge;
    });
  }

  settleModelInvocation(input: { readonly chargeId: string; readonly receipt: unknown; readonly now: string }): DelegationBudgetCharge {
    const request = delegationRecord(input, ["chargeId", "receipt", "now"]);
    const id = delegationId(request.chargeId);
    const now = delegationTimestamp(request.now);
    const rawReceipt = this.ports.readUsageReceipt(request.receipt);
    const receipt = delegationRecord(rawReceipt, ["kind", "runId", "attemptId", "invocationId", "inputTokens", "cachedInputTokens", "outputTokens"], "delegation.authority_invalid");
    if (!["measured", "cancelled_before_dispatch", "unknown"].includes(receipt.kind as string)) fail("delegation.authority_invalid");
    for (const field of ["runId", "attemptId", "invocationId"]) delegationId(receipt[field], "delegation.authority_invalid");
    return this.transaction(() => {
      const charge = this.getDelegationBudgetCharge(id);
      if (!charge) fail("delegation.invalid_input");
      if (receipt.runId !== charge.runId || receipt.attemptId !== charge.attemptId || receipt.invocationId !== charge.invocationId) fail("delegation.lineage_invalid");
      if (now < charge.createdAt || now < charge.updatedAt) fail("delegation.invalid_input");
      const state = receipt.kind === "unknown" ? "unresolved" : receipt.kind as "measured" | "cancelled_before_dispatch";
      const inputTokens = state === "measured" ? delegationInteger(receipt.inputTokens, "delegation.authority_invalid") : undefined;
      const cachedInputTokens = state === "measured" ? delegationInteger(receipt.cachedInputTokens, "delegation.authority_invalid") : undefined;
      const outputTokens = state === "measured" ? delegationInteger(receipt.outputTokens, "delegation.authority_invalid") : undefined;
      if (state !== "measured" && [receipt.inputTokens, receipt.cachedInputTokens, receipt.outputTokens].some(value => value !== undefined)
        || inputTokens !== undefined && (cachedInputTokens! > inputTokens || !Number.isSafeInteger(inputTokens + outputTokens!))) fail("delegation.authority_invalid");
      const root = this.getRootDelegationBudget(charge.rootRunId);
      if (!root) fail("delegation.persisted_fact_invalid");
      const price = charge.priceArtifactId ? this.readPriceArtifact(charge.priceArtifactId, root.rootRunId, charge.priceDigest!) : undefined;
      const actualCostMicros = state === "measured" && price ? quoteDelegationTokenCostMicros({ price, currency: price.currency,
        scope: price.scope, usage: { inputTokens: inputTokens!, cachedInputTokens: cachedInputTokens!, outputTokens: outputTokens! } }) : undefined;
      if (["measured", "cancelled_before_dispatch"].includes(charge.state)) {
        if (charge.state !== state || charge.inputTokens !== inputTokens || charge.cachedInputTokens !== cachedInputTokens
          || charge.outputTokens !== outputTokens || charge.actualCostMicros !== actualCostMicros) fail("delegation.settlement_conflict");
        return charge;
      }
      if (charge.state === "unresolved" && state === "unresolved") return charge;
      this.context.database.prepare(`UPDATE delegation_budget_charges SET state=?,input_tokens=?,cached_input_tokens=?,output_tokens=?,actual_cost_micros=?,revision=revision+1,updated_at=?,settled_at=? WHERE id=? AND revision=?`)
        .run(state, inputTokens ?? null, cachedInputTokens ?? null, outputTokens ?? null, actualCostMicros ?? null, now,
          state === "unresolved" ? null : now, id, charge.revision);
      return this.getDelegationBudgetCharge(id)!;
    });
  }

  settleDelegatedChild(input: { readonly reservationId: string; readonly receipt: unknown; readonly now: string }): DelegationBudgetReservation {
    return this.transaction(() => this.settleDelegatedChildWithinTransaction(input));
  }

  /** Private composition joins the terminal-intent transaction; never commits its caller. */
  settleDelegatedChildWithinTransaction(input: Parameters<SqliteDelegationWriteStore["settleDelegatedChild"]>[0]): DelegationBudgetReservation {
    this.assertTransaction();
    const request = delegationRecord(input, ["reservationId", "receipt", "now"]);
    const id = delegationId(request.reservationId);
    const now = delegationTimestamp(request.now);
    const receipt = delegationRecord(this.ports.readChildReceipt(request.receipt), ["kind", "childRunId", "sourceFence"], "delegation.authority_invalid");
    if (!["verified_usage", "no_dispatch", "unknown"].includes(receipt.kind as string)) fail("delegation.authority_invalid");
    const childRunId = delegationId(receipt.childRunId, "delegation.authority_invalid");
    const sourceFence = receipt.sourceFence === undefined ? undefined : delegationFence(receipt.sourceFence);
    if (receipt.kind === "verified_usage" && sourceFence === undefined || receipt.kind === "no_dispatch" && sourceFence !== undefined) fail("delegation.authority_invalid");
    const settlementDigest = delegationDigest({ kind: receipt.kind, childRunId, sourceFence });
    return (() => {
      const reservation = this.getDelegationBudgetReservation(id);
      if (!reservation) fail("delegation.invalid_input");
      if (reservation.childRunId !== childRunId) fail("delegation.lineage_invalid");
      if (now < reservation.updatedAt) fail("delegation.invalid_input");
      const state = receipt.kind === "verified_usage" ? "settled" : receipt.kind === "no_dispatch" ? "released" : "unresolved";
      if (["settled", "released"].includes(reservation.state)) {
        if (state !== reservation.state || reservation.settlementDigest !== settlementDigest) fail("delegation.settlement_conflict");
        return reservation;
      }
      if (state === "unresolved" && reservation.state === "unresolved") return reservation;
      let usage: Usage | undefined;
      if (state !== "unresolved") {
        const run = this.ports.getRun(childRunId);
        const unit = run?.workUnitId ? this.ports.getWorkUnit(run.workUnitId) : undefined;
        if (!run || !unit) fail("delegation.persisted_fact_invalid");
        usage = this.usage(reservation.rootRunId, id);
        if (state === "released") {
          if (run.status !== "queued" || unit.status !== "queued" || unit.activeAttemptId !== undefined || unit.attemptCount !== 0
            || this.row("delegation_budget_charges", "reservation_id=?", [id]) || this.row("delegation_budget_reservations", "parent_reservation_id=?", [id])) fail("delegation.settlement_incomplete");
          usage = { tokens: 0n, cost: 0n, costKnown: true, closed: true };
        } else {
          if (!["succeeded", "failed", "cancelled"].includes(run.status) || !run.endedAt
            || !["succeeded", "failed", "cancelled"].includes(unit.status) || !unit.endedAt || !usage.closed) fail("delegation.settlement_incomplete");
          if (!this.context.database.prepare(`SELECT 1 FROM work_unit_attempts a WHERE a.id=? AND a.id=? AND a.work_unit_id=?
            AND a.runtime_instance_id=? AND a.fencing_token=? AND a.ended_at IS NOT NULL AND a.status IN ('succeeded','failed','cancelled')`)
            .get(sourceFence!.attemptId, unit.activeAttemptId ?? null, unit.id, sourceFence!.runtimeInstanceId, sourceFence!.fencingToken)
            || sourceFence!.workUnitId !== unit.id) fail("delegation.source_attempt_stale");
        }
      }
      this.context.database.prepare(`UPDATE delegation_budget_reservations SET state=?,settled_token_usage=?,settled_cost_micros=?,settlement_digest=?,failure_code=?,revision=revision+1,updated_at=?,settled_at=? WHERE id=? AND revision=?`)
        .run(state, usage ? this.safeNumber(usage.tokens) : null, usage?.costKnown ? this.safeNumber(usage.cost) : null,
          state === "unresolved" ? null : settlementDigest, state === "unresolved" ? "delegation.usage_unknown" : null,
          now, state === "unresolved" ? null : now, id, reservation.revision);
      return this.getDelegationBudgetReservation(id)!;
    })();
  }

  private pinStepArtifacts(step: DelegationBudgetRow, now: string): void {
    // Child settlement alone is not parent consumption. Keep required-child recovery
    // through terminal receipt until an explicit parent-consumed authority seam exists.
    syncHarnessArtifactOwnerPins(this.context.database, { holder: harnessArtifactOwnerHolder("delegation_step", String(step.id)),
      artifactIds: ["objective_artifact_id", "permission_snapshot_artifact_id", "tool_allowlist_artifact_id",
        "workspace_scope_artifact_id", "provider_policy_artifact_id"].map(key => delegationId(step[key], "delegation.persisted_fact_invalid")), keep: true, now });
  }
  private capture(value: unknown, runId: string, fence: RuntimeAttemptFenceV1): DelegationAuthorityCapture {
    const capture = delegationCapture(this.ports.readCapture(value));
    if (capture.runId !== runId || delegationJson(capture.sourceFence) !== delegationJson(fence)) fail("delegation.authority_invalid");
    return capture;
  }
  private currentSubset(capture: DelegationAuthorityCapture, runId: string, fence: RuntimeAttemptFenceV1): void {
    const current = delegationAuthority(this.ports.readCurrentAuthority(runId, fence));
    assertDelegationAuthoritySubset(current, capture.authority);
    if (current.authoritySetId !== capture.authority.authoritySetId) fail("delegation.authority_invalid");
    this.assertTransaction();
  }
  private assertOwner(runId: string, fence: RuntimeAttemptFenceV1, phase: "admission" | "running"): void {
    const expected = phase === "admission" ? ["queued", "claimed", "created"] : ["running", "running", "started"];
    const row = this.context.database.prepare(`SELECT r.status AS run_status,u.status AS unit_status,a.status AS attempt_status
      FROM run_sessions r JOIN work_units u ON u.id=r.work_unit_id JOIN work_unit_attempts a ON a.id=u.active_attempt_id
      WHERE r.id=? AND r.work_unit_id=? AND u.linked_run_id=r.id AND a.id=? AND a.work_unit_id=u.id
        AND a.runtime_instance_id=? AND a.fencing_token=? AND a.abort_requested_at IS NULL
        AND r.ended_at IS NULL AND u.ended_at IS NULL AND a.ended_at IS NULL`)
      .get(runId, fence.workUnitId, fence.attemptId, fence.runtimeInstanceId, fence.fencingToken);
    if (!row) fail("delegation.source_attempt_stale");
    if (row.run_status !== expected[0] || row.unit_status !== expected[1] || row.attempt_status !== expected[2]) fail("delegation.parent_not_running");
  }
  private allocation(runId: string, capture: DelegationAuthorityCapture): Allocation {
    let ancestry;
    try {
      ancestry = resolveRunAncestry({ getRun: this.ports.getRun, getWorkspaceId: run => run.workUnitId ? this.ports.getWorkUnit(run.workUnitId)?.workspaceId : undefined },
        { leafRunId: runId, expectedRootRunId: capture.rootRunId, expectedWorkspaceId: capture.authority.workspaceId });
    } catch (error) {
      if (error instanceof RunAncestryError) fail(error.code === "run_ancestry.cycle" ? "delegation.cycle_detected" : error.code === "run_ancestry.depth_exceeded" ? "delegation.depth_exceeded" : "delegation.lineage_invalid");
      throw error;
    }
    // Preserve the domain's lineage diagnosis before checking additional
    // suspension latches. Both checks still precede any allocation/write.
    assertRootSuspensionStartAdmission(this.context.database, runId);
    assertDelegatedSuspensionStartAdmission(this.context.database, runId);
    const root = this.getRootDelegationBudget(ancestry.rootRunId);
    if (!root) fail("delegation.root_budget_missing");
    const rootAuthority = this.readAuthorityArtifact(root.authorityArtifactId, root.rootRunId, root.authorityDigest);
    this.readRootPrice(root);
    const run = this.ports.getRun(runId);
    const unit = run?.workUnitId ? this.ports.getWorkUnit(run.workUnitId) : undefined;
    if (!run || !unit) fail("delegation.lineage_invalid");
    this.assertScope(run, unit, capture.authority, ancestry.entries.map(entry => entry.id));
    if (capture.authority.authoritySetId !== rootAuthority.authoritySetId) fail("delegation.authority_invalid");
    assertDelegationAuthoritySubset(rootAuthority, capture.authority);
    if (runId === root.rootRunId) return { root, authority: rootAuthority, run, unit };
    const row = this.row("delegation_budget_reservations", "child_run_id=?", [runId]);
    if (!row) fail("delegation.lineage_invalid");
    const reservation = mapDelegationBudgetReservation(row);
    const step = this.row("delegation_steps", "id=?", [reservation.delegationStepId]);
    if (!step || reservation.rootRunId !== root.rootRunId || reservation.state !== "reserved" || step.state !== "running"
      || step.child_run_id !== runId || step.parent_run_id !== run.parentRunId) fail("delegation.lineage_invalid");
    const authority = this.readStepAuthority(step);
    return { root, reservation, authority, run, unit };
  }
  private assertScope(run: RunSession, unit: WorkUnit, authority: DelegationExecutionAuthority, ancestorIds: readonly string[] = [run.id]): void {
    if (unit.workspaceId !== authority.workspaceId || run.channelId !== authority.channelId || run.workflowStepId !== authority.workflowStepId
      || run.workUnitId !== unit.id || unit.linkedRunId !== run.id) fail("delegation.workflow_lineage_invalid");
    if (authority.workflowStepId) {
      const step = this.context.database.prepare(`SELECT s.run_id FROM channel_workflow_steps s JOIN channel_workflows w ON w.id=s.workflow_id
        WHERE s.id=? AND s.workflow_id=? AND s.workspace_id=? AND s.channel_id=? AND w.workspace_id=s.workspace_id AND w.channel_id=s.channel_id`)
        .get(authority.workflowStepId, authority.workflowId!, authority.workspaceId, authority.channelId ?? null);
      if (!step || typeof step.run_id !== "string" || !ancestorIds.includes(step.run_id)) fail("delegation.workflow_lineage_invalid");
    } else if (authority.workflowId) fail("delegation.workflow_lineage_invalid");
  }
  private assertRootOpenForSpawn(rootRunId: string): void {
    assertRootSuspensionStartAdmission(this.context.database, rootRunId);
    assertDelegatedSuspensionStartAdmission(this.context.database, rootRunId);
    assertNoPendingRunTerminalIntent(this.context, rootRunId);
    // Existing optional children may outlive the root. They must not add new
    // required work after its success/read-set was committed. BEGIN IMMEDIATE
    // serializes this admission with root terminalization, not a stale port read.
    const root = this.context.database.prepare(`SELECT 1 FROM run_sessions r
      JOIN work_units u ON u.id=r.work_unit_id AND u.linked_run_id=r.id
      JOIN work_unit_attempts a ON a.id=u.active_attempt_id AND a.work_unit_id=u.id
      WHERE r.id=? AND r.parent_run_id IS NULL AND r.status IN ('running','waiting_for_approval')
        AND u.status IN ('running','waiting_for_approval','waiting_for_input')
        AND a.status IN ('started','waiting_for_approval')
        AND r.ended_at IS NULL AND u.ended_at IS NULL AND a.ended_at IS NULL AND a.abort_requested_at IS NULL`)
      .get(rootRunId);
    if (!root) fail("delegation.parent_not_running");
  }
  private effectiveParentBudget(allocation: Allocation): Omit<DelegationEffectiveBudget, "wallTimeBudgetMs"> {
    const reservation = allocation.reservation;
    return { rootRunId: allocation.root.rootRunId, deadlineAt: reservation?.deadlineAt ?? allocation.root.deadlineAt,
      tokenBudget: reservation ? reservation.tokenReserved : allocation.root.tokenBudget,
      costBudgetMicros: reservation ? reservation.costReservedMicros : allocation.root.costBudgetMicros };
  }
  private rootBudgetSnapshot(root: DelegationRootBudgetRecord): import("../../harness/delegation-authority.js").DelegationRootBudgetSnapshot {
    // Persistence pins are not fields of the pure budget contract. Never pass
    // the wider row object through a validator that intentionally rejects extras.
    return { rootRunId: root.rootRunId, frozenAt: root.frozenAt, deadlineAt: root.deadlineAt,
      ...(root.tokenBudget === undefined ? {} : { tokenBudget: root.tokenBudget }),
      ...(root.costBudgetMicros === undefined ? {} : { costBudgetMicros: root.costBudgetMicros }) };
  }
  private assertCapacity(allocation: Allocation, tokens: number | undefined, cost: number | undefined): void {
    const budget = this.effectiveParentBudget(allocation);
    const used = this.usage(allocation.root.rootRunId, allocation.reservation?.id);
    if (budget.tokenBudget !== undefined && (tokens === undefined || used.tokens + BigInt(tokens) > BigInt(budget.tokenBudget))
      || budget.costBudgetMicros !== undefined && (cost === undefined || !used.costKnown || used.cost + BigInt(cost) > BigInt(budget.costBudgetMicros))) fail("delegation.budget_exhausted");
    // Descendants already count at full allocation in their ancestors, so the
    // new request must not be added a second time. Actual adapter overruns can
    // nevertheless exhaust an intermediate allocation while the root still has
    // room: validate every ancestor, not just the leaf and the root.
    let reservation = allocation.reservation;
    const visited = new Set<string>();
    while (reservation) {
      if (visited.has(reservation.id) || visited.size >= 100) fail("delegation.persisted_fact_invalid");
      visited.add(reservation.id);
      const child = this.ports.getRun(reservation.childRunId);
      if (!child || reservation.rootRunId !== allocation.root.rootRunId || reservation.state !== "reserved") fail("delegation.lineage_invalid");
      if (reservation.parentReservationId === undefined) {
        if (child.parentRunId !== allocation.root.rootRunId) fail("delegation.lineage_invalid");
        break;
      }
      const parent = this.getDelegationBudgetReservation(reservation.parentReservationId);
      if (!parent || parent.childRunId !== child.parentRunId || parent.rootRunId !== allocation.root.rootRunId
        || parent.state !== "reserved") fail("delegation.lineage_invalid");
      const ancestorUsed = this.usage(allocation.root.rootRunId, parent.id);
      if (parent.tokenReserved !== undefined && ancestorUsed.tokens > BigInt(parent.tokenReserved)
        || parent.costReservedMicros !== undefined && (!ancestorUsed.costKnown || ancestorUsed.cost > BigInt(parent.costReservedMicros))) fail("delegation.budget_exhausted");
      reservation = parent;
    }
    if (allocation.reservation) {
      const rootUsed = this.usage(allocation.root.rootRunId);
      if (allocation.root.tokenBudget !== undefined && rootUsed.tokens > BigInt(allocation.root.tokenBudget)
        || allocation.root.costBudgetMicros !== undefined && (!rootUsed.costKnown || rootUsed.cost > BigInt(allocation.root.costBudgetMicros))) fail("delegation.budget_exhausted");
    }
  }

  /** Do not double-count nested reservations; conservatively propagate overruns. */
  private usage(rootRunId: string, allocationId?: string): Usage {
    const reservations = this.rows("delegation_budget_reservations", "root_run_id=?", [rootRunId]).map(mapDelegationBudgetReservation);
    const charges = this.rows("delegation_budget_charges", "root_run_id=?", [rootRunId]).map(mapDelegationBudgetCharge);
    const visited = new Set<string>();
    const sum = (id: string | undefined, depth: number): Usage => {
      if (depth > 100 || id !== undefined && visited.has(id)) fail("delegation.persisted_fact_invalid");
      if (id !== undefined) visited.add(id);
      let tokens = 0n; let cost = 0n; let costKnown = true; let closed = true;
      for (const charge of charges.filter(row => row.reservationId === id)) {
        if (charge.state === "cancelled_before_dispatch") continue;
        const measured = charge.state === "measured";
        tokens += BigInt(measured ? charge.inputTokens! + charge.outputTokens! : charge.reservedTokens ?? 0);
        cost += BigInt(measured ? charge.actualCostMicros ?? 0 : charge.reservedCostMicros ?? 0);
        costKnown &&= measured ? charge.actualCostMicros !== undefined : charge.reservedCostMicros !== undefined;
        closed &&= measured;
      }
      for (const reservation of reservations.filter(row => row.parentReservationId === id)) {
        if (reservation.state === "released") continue;
        const actual = sum(reservation.id, depth + 1);
        if (reservation.state === "settled") {
          if (!actual.closed || BigInt(reservation.settledTokenUsage!) < actual.tokens
            || reservation.settledCostMicros !== undefined && BigInt(reservation.settledCostMicros) < actual.cost) fail("delegation.persisted_fact_invalid");
          tokens += BigInt(reservation.settledTokenUsage!);
          cost += BigInt(reservation.settledCostMicros ?? 0);
          costKnown &&= reservation.settledCostMicros !== undefined;
        } else {
          const reservedTokens = BigInt(reservation.tokenReserved ?? 0);
          const reservedCost = BigInt(reservation.costReservedMicros ?? 0);
          tokens += actual.tokens > reservedTokens ? actual.tokens : reservedTokens;
          cost += actual.cost > reservedCost ? actual.cost : reservedCost;
          costKnown &&= reservation.costReservedMicros !== undefined;
          closed = false;
        }
      }
      return { tokens, cost, costKnown, closed };
    };
    const result = sum(allocationId, 0);
    // Refuse orphan/cyclic allocations even when they would otherwise evade a sum.
    if (allocationId === undefined && visited.size !== reservations.filter(row => row.state !== "released").length) fail("delegation.persisted_fact_invalid");
    return result;
  }
  private selectPrice(root: DelegationRootBudgetRecord, capture: DelegationAuthorityCapture, costBudgetMicros?: number): DelegationTokenPriceSnapshot | undefined {
    const stored = this.readRootPrice(root);
    if (capture.price && (!stored || delegationDigest(capture.price) !== delegationDigest(stored))) fail("delegation.price_scope_conflict");
    return resolveDelegationPriceForBudget({ costBudgetMicros, currency: capture.currency, scope: capture.provider,
      price: stored && providerKey(stored.scope) === providerKey(capture.provider) ? stored : undefined });
  }
  private readRootPrice(root: DelegationRootBudgetRecord): DelegationTokenPriceSnapshot | undefined {
    return root.priceArtifactId ? this.readPriceArtifact(root.priceArtifactId, root.rootRunId, root.priceDigest!) : undefined;
  }
  private readPriceArtifact(id: string, rootRunId: string, digest: string): DelegationTokenPriceSnapshot {
    const value = this.readArtifact(id, rootRunId, digest);
    const record = delegationRecord(value, ["schemaVersion", "version", "currency", "scope", "inputMicrosPerMillionTokens", "cachedInputMicrosPerMillionTokens", "outputMicrosPerMillionTokens"], "delegation.persisted_fact_invalid");
    return resolveDelegationPriceForBudget({ price: value as DelegationTokenPriceSnapshot,
      currency: String(record.currency), scope: record.scope as DelegationTokenPriceSnapshot["scope"] })!;
  }
  private readAuthorityArtifact(id: string, owner: string, digest?: string): DelegationExecutionAuthority {
    const payload = delegationRecord(this.readArtifact(id, owner, digest), ["kind", "capture"], "delegation.persisted_fact_invalid");
    if (payload.kind !== "delegation.authority.v1") fail("delegation.persisted_fact_invalid");
    return delegationCapture(payload.capture).authority;
  }
  private readStepAuthority(step: DelegationBudgetRow): DelegationExecutionAuthority {
    const permissionId = delegationId(step.permission_snapshot_artifact_id, "delegation.persisted_fact_invalid");
    const owner = delegationId(step.parent_run_id, "delegation.persisted_fact_invalid");
    const authority = this.readAuthorityArtifact(permissionId, owner);
    const expected = this.authorityPayloads({ authority } as DelegationAuthorityCapture);
    for (const [field, kind] of [["tool_allowlist_artifact_id", "tools"], ["workspace_scope_artifact_id", "workspace"], ["provider_policy_artifact_id", "provider"]] as const) {
      const value = this.readArtifact(delegationId(step[field], "delegation.persisted_fact_invalid"), owner);
      if (delegationDigest(value) !== delegationDigest(expected[kind])) fail("delegation.persisted_fact_invalid");
    }
    return authority;
  }
  private authorityPayloads(capture: DelegationAuthorityCapture): Record<"tools" | "workspace" | "provider", unknown> {
    const a = capture.authority;
    const identity = { authoritySetId: a.authoritySetId, sourceRevision: a.sourceRevision };
    return { tools: { kind: "delegation.tools.v1", ...identity, tools: a.tools, toolDecisions: a.toolDecisions },
      workspace: { kind: "delegation.workspace.v1", ...identity, workspaceId: a.workspaceId, roots: a.workspaceRoots },
      provider: { kind: "delegation.provider.v1", ...identity, providers: a.providers, networkScopes: a.networkScopes, secretRefs: a.secretRefs } };
  }
  private authorityArtifacts(owner: string, capture: DelegationAuthorityCapture, now: string): Record<"permission" | "tools" | "workspace" | "provider", { readonly id: string; readonly digest: string }> {
    const payloads = this.authorityPayloads(capture);
    return { permission: this.artifact(owner, { kind: "delegation.authority.v1", capture }, now),
      tools: this.artifact(owner, payloads.tools, now), workspace: this.artifact(owner, payloads.workspace, now),
      provider: this.artifact(owner, payloads.provider, now) };
  }
  private artifact(owner: string, value: unknown, now: string): { readonly id: string; readonly digest: string } {
    const json = delegationJson(value);
    const digest = createHash("sha256").update(json, "utf8").digest("hex");
    const artifact = this.ports.createArtifactWithinTransaction({ runId: owner, type: "json", path: "sqlite:delegation-authority",
      contentType: "application/json", sizeBytes: Buffer.byteLength(json, "utf8"), sealedPayload: JSON.parse(json), contentSha256: digest, createdAt: now });
    this.assertTransaction();
    this.readArtifact(artifact.id, owner, digest);
    return { id: artifact.id, digest };
  }
  private readArtifact(id: string, owner: string, digest?: string): unknown {
    const artifact = this.ports.getArtifact(id);
    if (!artifact || artifact.runId !== owner || artifact.sealedPayload === undefined || !artifact.contentSha256) fail("delegation.persisted_fact_invalid");
    // Compare actual stored JSON bytes too, not only an already-parsed object.
    const row = this.context.database.prepare("SELECT sealed_payload_json,content_sha256 FROM artifacts WHERE id=? AND run_id=?").get(id, owner);
    if (!row || typeof row.sealed_payload_json !== "string" || typeof row.content_sha256 !== "string") fail("delegation.persisted_fact_invalid");
    const actual = createHash("sha256").update(row.sealed_payload_json, "utf8").digest("hex");
    if (actual !== row.content_sha256 || actual !== artifact.contentSha256 || digest !== undefined && actual !== digest
      || delegationDigest(artifact.sealedPayload) !== actual) fail("delegation.persisted_fact_invalid");
    return artifact.sealedPayload;
  }
  private transaction<T>(operation: () => T): T {
    this.context.database.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.assertTransaction(); this.context.database.exec("COMMIT"); return result; }
    catch (error) { rollbackOwnedSqliteTransaction(this.context.database); throw error; }
  }
  private assertTransaction(): void {
    try { this.context.database.exec("BEGIN DEFERRED"); }
    catch (error) {
      if (error instanceof Error && error.message === "cannot start a transaction within a transaction") return;
      throw error;
    }
    this.context.database.exec("ROLLBACK");
    fail("delegation.persisted_fact_invalid");
  }
  private insert(table: string, fields: Record<string, SQLInputValue>): void {
    this.assertTransaction();
    this.context.database.prepare(`INSERT INTO ${table}(${Object.keys(fields).join(",")}) VALUES(${Object.keys(fields).map(() => "?").join(",")})`).run(...Object.values(fields));
  }
  private row(table: string, where: string, parameters: readonly SQLInputValue[]): DelegationBudgetRow | undefined {
    return this.context.database.prepare(`SELECT * FROM ${table} WHERE ${where}`).get(...parameters) as DelegationBudgetRow | undefined;
  }
  private rows(table: string, where: string, parameters: readonly SQLInputValue[]): DelegationBudgetRow[] {
    const statement = this.context.database.prepare(`SELECT * FROM ${table} WHERE ${where} LIMIT 10001`);
    statement.setReadBigInts(true);
    const rows = statement.all(...parameters) as DelegationBudgetRow[];
    if (rows.length > 10_000) fail("delegation.persisted_fact_invalid");
    return rows;
  }
  private safeNumber(value: bigint): number {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) fail("delegation.persisted_fact_invalid");
    return Number(value);
  }
}
