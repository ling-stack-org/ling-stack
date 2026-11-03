import type { SQLOutputValue } from "node:sqlite";
import { parseWorkflowConflictRecoveryRequest, type WorkflowConflictRecovery } from "@ling-stack/contracts";
import type { RunStore } from "../../run-types.js";
import type { WorkflowConflictRecoveryStore } from "../../workflow-conflict-recovery-types.js";
import { workflowIsolationCanonicalJson as json, workflowIsolationDigest as digest,
  workflowIsolationIdentity as identity, workflowIsolationTime as time } from "../../workflow-isolation.js";
import type { SqliteStoreContext } from "./store-context.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { readSqliteSnapshot, readSqliteWithinTransaction } from "./read-snapshot.js";
import { createSqliteWorkflowIsolationStore } from "./workflow-isolation-store.js";
import { createSqliteWorkflowIntegrationCoordinatorStore } from "./workflow-integration-coordinator-store.js";
import { readWorkflowParallelParents, workflowParallelWorkspaceResourcesActive } from "./workflow-parallel-parent-guard.js";
import { hasActiveWorkflowMergeApplyLease } from "./workflow-merge-lease-guard.js";

type Rejection = { readonly status: "invalid" | "stale" | "conflict"; readonly code: string };
class Veto extends Error { constructor(readonly result: Rejection) { super(result.code); } }
function veto(status: Rejection["status"], code: string): never { throw new Veto({ status, code: `workflow_recovery.${code}` }); }
const adapters = new WeakMap<RunStore, WorkflowConflictRecoveryStore>();

export function createSqliteWorkflowConflictRecoveryStore(store: RunStore): WorkflowConflictRecoveryStore {
  const adapter = adapters.get(store);
  if (!adapter) throw new Error("workflow_recovery.store_not_sqlite");
  return adapter;
}

export function registerSqliteWorkflowConflictRecoveryStore(store: RunStore, context: SqliteStoreContext): void {
  if (adapters.has(store)) throw new Error("workflow_recovery.store_already_registered");
  adapters.set(store, new SqliteWorkflowConflictRecoveryStore(store, context));
}

class SqliteWorkflowConflictRecoveryStore implements WorkflowConflictRecoveryStore {
  constructor(private readonly store: RunStore, private readonly context: SqliteStoreContext) {}

  getByPredecessor(workflowId: string): WorkflowConflictRecovery | undefined {
    return readSqliteSnapshot(this.context.database, () => this.read("predecessor_workflow_id", workflowId));
  }
  getBySuccessor(workflowId: string): WorkflowConflictRecovery | undefined {
    return readSqliteSnapshot(this.context.database, () => this.read("successor_workflow_id", workflowId));
  }

  createSuccessor(input: Parameters<WorkflowConflictRecoveryStore["createSuccessor"]>[0]): ReturnType<WorkflowConflictRecoveryStore["createSuccessor"]> {
    const db = this.context.database;
    if (db.isTransaction) return { status: "conflict", code: "workflow_recovery.transaction_owned" };
    if (Object.prototype.toString.call(input.compileSuccessor) === "[object AsyncFunction]")
      return { status: "invalid", code: "workflow_recovery.compiler_must_be_synchronous" };
    db.exec("BEGIN IMMEDIATE");
    try {
      const request = parseWorkflowConflictRecoveryRequest(input.request);
      if (!identity(input.workflowId) || !identity(input.successorRoundId) || !time(input.now)) veto("invalid", "input_invalid");
      const requestDigest = digest({ workflowId: input.workflowId, ...request }, "wfrq1_");
      const prior = this.read("predecessor_workflow_id", input.workflowId);
      if (prior) {
        if (prior.requestDigest !== requestDigest || prior.idempotencyKey !== request.idempotencyKey) veto("conflict", "request_reused");
        db.exec("COMMIT");
        return { status: "duplicate", value: prior };
      }
      const isolation = createSqliteWorkflowIsolationStore(this.store), coordinator = createSqliteWorkflowIntegrationCoordinatorStore(this.store);
      const workflow = this.store.getChannelWorkflow(input.workflowId), round = isolation.getIntegrationRound(request.roundId);
      const selection = isolation.getSelection(input.workflowId);
      if (!workflow || !round || round.inputs.workflowId !== workflow.id || round.generation !== request.generation
        || round.revision !== request.expectedRevision) veto("stale", "predecessor_changed");
      if (!selection || selection.roundId !== round.roundId || selection.phase !== "ready"
        || round.phase !== "conflicted" || round.reason !== "workflow_integration.text_conflict"
        || round.candidate || round.openIntentId || round.outstandingApprovalId || round.inputs.mode !== "candidate_only"
        || round.inputs.optionalFailurePolicy !== "require_success" || round.inputs.parallelExecution?.maxConcurrentSteps !== 2
        || !["blocked", "running"].includes(workflow.status)) veto("conflict", "predecessor_not_recoverable");
      const rounds = coordinator.listRounds.bind(coordinator);
      const authority = readSqliteWithinTransaction(db, () => {
        if (rounds(workflow.id).length !== 1) veto("conflict", "round_inventory_changed");
        const authorized = coordinator.assertAuthority({ roundId: round.roundId, generation: round.generation, now: input.now });
        if (authorized.status !== "authorized") veto("conflict", authorized.code);
        if (coordinator.readPublicationBlocker(workflow.id)) veto("conflict", "journal_unconfirmed");
        return authorized;
      });
      const parents = readWorkflowParallelParents(db), parent = parents.find(value => value.roundId === round.roundId && value.generation === round.generation);
      if (!parent || parent.state !== "held" || parents.some(value => value.state === "held"
        && (value.workspaceId === parent.workspaceId || value.commonDir === parent.commonDir) && value !== parent)
        || workflowParallelWorkspaceResourcesActive(db, parent.workspaceId, true) || hasActiveWorkflowMergeApplyLease(db, parent.workspaceId))
        veto("conflict", "parent_not_quiescent");
      // A conflicted candidate-only round has no merge approval or apply authority to carry forward.
      if (db.prepare(`SELECT 1 FROM workflow_merge_approval_requests approval JOIN workflow_integration_rounds round USING(round_id)
        WHERE round.workflow_id=? LIMIT 1`).get(workflow.id)
        || db.prepare(`SELECT 1 FROM workflow_merge_apply_permits permit JOIN workflow_integration_rounds round USING(round_id)
          WHERE round.workflow_id=? LIMIT 1`).get(workflow.id)) veto("conflict", "merge_authority_present");
      const previous = this.read("successor_workflow_id", workflow.id);
      const sequence = (previous?.sequence ?? 0) + 1;
      if (sequence > 128) veto("conflict", "lineage_limit");
      const steps = this.store.listChannelWorkflowSteps({ workflowId: workflow.id, complete: true });
      if (steps.length !== authority.participants.length) veto("conflict", "step_inventory_changed");
      const compiled = input.compileSuccessor();
      if (compiled && typeof Reflect.get(compiled, "then") === "function") {
        void Promise.resolve(compiled).catch(() => undefined);
        veto("invalid", "compiler_must_be_synchronous");
      }
      const successor = compiled.workflow, freshSteps = this.store.listChannelWorkflowSteps({ workflowId: successor.id, complete: true });
      if (successor.id === workflow.id || successor.channelId !== workflow.channelId || successor.workspaceId !== workflow.workspaceId
        || successor.status !== "ready" || successor.createdBy !== "local-user" || !successor.metadata?.workflowGraphFingerprint
        || !successor.metadata.sourceTurnId || !successor.metadata.sourceMessageId
        || successor.metadata.sourceTurnId === workflow.metadata?.sourceTurnId || successor.metadata.sourceMessageId === workflow.metadata?.sourceMessageId
        || json(this.store.getChannelWorkflow(workflow.id)) !== json(workflow)
        || json(this.store.listChannelWorkflowSteps({ workflowId: workflow.id, complete: true })) !== json(steps)
        || json(isolation.getIntegrationRound(round.roundId)) !== json(round)
        || json(this.store.getChannelWorkflow(successor.id)) !== json(successor)
        || freshSteps.length !== steps.length || freshSteps.length < 2 || freshSteps.length > 128
        || freshSteps.some(step => step.status !== "queued" || step.taskId || step.runId || step.metadata?.startOwner
          || step.metadata?.preStepApprovalId || step.metadata?.safetyPlan || step.metadata?.isolationScopePlan
          || step.metadata?.autoStart !== true || step.metadata?.requestedRunnerId !== "pi"
          || step.metadata?.sideEffectClass !== "workspace_write")
        || db.prepare("SELECT 1 FROM workflow_integration_rounds WHERE workflow_id=? OR round_id=? LIMIT 1").get(successor.id, input.successorRoundId)
        || db.prepare("SELECT 1 FROM run_sessions WHERE workflow_step_id IN (SELECT id FROM channel_workflow_steps WHERE workflow_id=?) LIMIT 1").get(successor.id))
        veto("invalid", "successor_not_fresh");
      const predecessor = { workflowId: workflow.id, roundId: round.roundId, generation: round.generation,
        revision: round.revision, inputsDigest: round.inputsDigest };
      const recovery: WorkflowConflictRecovery = { schemaVersion: 1, recoveryId: digest({ predecessor, requestDigest }, "wfr1_"),
        root: previous?.root ?? { workflowId: workflow.id, roundId: round.roundId, generation: round.generation }, sequence,
        predecessor, successor: { workflowId: successor.id, roundId: input.successorRoundId, generation: 1 },
        idempotencyKey: request.idempotencyKey, repairInstruction: request.repairInstruction, requestDigest,
        authorityDigest: authority.authorityDigest, createdAt: input.now };
      db.prepare(`INSERT INTO workflow_isolation_selections(workflow_id,profile,round_id,phase,created_at,updated_at)
        VALUES(?,'pi_host_isolated_files_v1',?,'planning',?,?)`).run(successor.id, input.successorRoundId, input.now, input.now);
      db.prepare(`INSERT INTO workflow_conflict_recoveries(recovery_id,predecessor_workflow_id,predecessor_round_id,
        predecessor_generation,successor_workflow_id,successor_round_id,successor_generation,idempotency_key,request_digest,
        recovery_json,recovery_digest,created_at) VALUES(?,?,?,?,?,?,1,?,?,?,?,?)`).run(recovery.recoveryId, workflow.id,
          round.roundId, round.generation, successor.id, input.successorRoundId, request.idempotencyKey, requestDigest,
          json(recovery), digest(recovery), input.now);
      // Only the business workflow is retired. The conflicted generation, journals, refs and artifacts stay untouched.
      if (db.prepare("UPDATE channel_workflows SET status='failed',updated_at=? WHERE id=? AND status=? AND updated_at=?")
        .run(input.now, workflow.id, workflow.status, workflow.updatedAt).changes !== 1) veto("stale", "predecessor_changed");
      this.store.recordStateTransitionEvent({ workspaceId: workflow.workspaceId, entityType: "workflow", entityId: workflow.id,
        fromStatus: workflow.status, toStatus: "failed", event: "conflict_recovery_retired", actor: "local-user",
        reason: recovery.recoveryId, createdAt: input.now });
      if (db.prepare(`UPDATE workflow_parallel_parent_fences SET state='released',released_at=?
        WHERE round_id=? AND generation=? AND state='held' AND created_at<=?`).run(input.now, round.roundId, round.generation, input.now).changes !== 1)
        veto("conflict", "parent_changed");
      db.exec("COMMIT");
      return { status: "created", value: recovery };
    } catch (error) {
      rollbackOwnedSqliteTransaction(db);
      if (error instanceof Veto) return error.result;
      throw error;
    }
  }

  private read(column: "predecessor_workflow_id" | "successor_workflow_id", workflowId: string): WorkflowConflictRecovery | undefined {
    if (!identity(workflowId)) veto("invalid", "workflow_identity_invalid");
    const row = this.context.database.prepare(`SELECT * FROM workflow_conflict_recoveries WHERE ${column}=?`).get(workflowId);
    return row ? this.decode(row) : undefined;
  }

  private decode(row: Record<string, SQLOutputValue>): WorkflowConflictRecovery {
    const recovery = JSON.parse(String(row.recovery_json)) as WorkflowConflictRecovery;
    if (recovery.schemaVersion !== 1 || digest(recovery) !== row.recovery_digest || recovery.recoveryId !== row.recovery_id
      || recovery.predecessor.workflowId !== row.predecessor_workflow_id || recovery.predecessor.roundId !== row.predecessor_round_id
      || recovery.predecessor.generation !== row.predecessor_generation || recovery.successor.workflowId !== row.successor_workflow_id
      || recovery.successor.roundId !== row.successor_round_id || recovery.successor.generation !== 1 || row.successor_generation !== 1
      || recovery.idempotencyKey !== row.idempotency_key || recovery.requestDigest !== row.request_digest || recovery.createdAt !== row.created_at
      || !Number.isSafeInteger(recovery.sequence) || recovery.sequence < 1 || recovery.sequence > 128)
      throw new Error("workflow_recovery.lineage_corrupt");
    parseWorkflowConflictRecoveryRequest({ roundId: recovery.predecessor.roundId, generation: recovery.predecessor.generation,
      expectedRevision: recovery.predecessor.revision, idempotencyKey: recovery.idempotencyKey, repairInstruction: recovery.repairInstruction });
    return recovery;
  }
}
