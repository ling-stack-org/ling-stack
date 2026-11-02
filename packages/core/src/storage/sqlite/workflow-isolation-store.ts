import type { SQLOutputValue } from "node:sqlite";
import { createHash } from "node:crypto";
import type { RunStore } from "../../run-types.js";
import { redactSecrets } from "../../redaction.js";
import type { RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import { isWorkflowStepSafetyPlanV1 } from "../../workflow-safety-plan.js";
import { isWorkflowStepStartOwnerV1, workflowStepStartAuthorityBasis, workflowStepStartOwnerMatches } from "../../workflow-step-start-owner.js";
import type { WorkflowIsolationStore, WorkflowIsolationScopePlanV1, WorkflowIsolationExecutionBinding,
  WorkflowIsolationWriter, WorkflowIntegrationRound, WorkflowIntegrationRoundInputsV1,
  WorkflowIsolationMutationResult, WorkflowIsolationGitIdentity, WorkflowIsolationLocation,
  WorkflowIsolationJournalScope, WorkflowIsolationIntent, WorkflowIsolationReceipt,
  BindWorkflowIsolationExecutionInput, AdvanceWorkflowIntegrationRoundInput,
  RecordWorkflowIsolationIntentInput, RecordWorkflowIsolationReceiptInput, SealWorkflowIsolationPreparedExecutionInput } from "../../workflow-isolation-types.js";
import { workflowIsolationCanonicalJson as json, workflowIsolationDigest as digest,
  workflowIsolationIdentity as identity, workflowIsolationRevision as revision, workflowIsolationTime as time,
  workflowIsolationRecord as record, workflowIsolationPathsOverlap as overlaps,
  normalizeWorkflowIntegrationRoundInputs, workflowIntegrationRoundInputsDigest,
  normalizeWorkflowIsolationScopePlan, workflowIsolationStepSafetyFingerprint,
  normalizeWorkflowIsolationGitIdentity, normalizeWorkflowIntegrationCandidate,
  canTransitionWorkflowIntegrationRound } from "../../workflow-isolation.js";
import type { SqliteStoreContext } from "./store-context.js";
import { rollbackOwnedSqliteTransaction, stringifyJson } from "./helpers.js";
import { readSqliteSnapshot } from "./read-snapshot.js";
import { readWorkflowIsolationTerminalCapture, workflowIsolationBindingStopped,
  type WorkflowIsolationTerminalCapturePorts } from "./workflow-isolation-terminal-capture.js";
import { SqliteWorkflowIsolationResultsStore } from "./workflow-isolation-results-store.js";
import { readWorkflowParallelParents, workflowParallelRoundAvailable, workflowParallelScopeValid,
  workflowParallelAttemptAllowed, workflowParallelWorkspaceResourcesActive } from "./workflow-parallel-parent-guard.js";
import { readWorkflowIntegrationCompletionBlocker, readWorkflowIntegrationPublicationBlocker } from "./workflow-integration-completion.js";
import { hasActiveWorkflowMergeApplyLease } from "./workflow-merge-lease-guard.js";
import { readWorkflowIsolationSelection } from "./workflow-isolation-selection.js";

type Ports = WorkflowIsolationTerminalCapturePorts & Pick<RunStore, "listChannelWorkflowSteps">;
type Row = Record<string, SQLOutputValue>;
type Rejection = { readonly status: "invalid" | "stale" | "conflict"; readonly code: string };
class Veto extends Error {
  constructor(readonly result: Rejection) { super(result.code); }
}
function veto(status: Rejection["status"], code: string): never { throw new Veto({ status, code: `workflow_isolation.${code}` }); }
const same = (left: unknown, right: unknown): boolean => json(left) === json(right);
const sameFence = (a: RuntimeAttemptFenceV1, b: RuntimeAttemptFenceV1): boolean => a.workUnitId === b.workUnitId
  && a.attemptId === b.attemptId && a.runtimeInstanceId === b.runtimeInstanceId && a.fencingToken === b.fencingToken;
const validFence = (value: RuntimeAttemptFenceV1): boolean => !!value && [value.workUnitId, value.attemptId,
  value.runtimeInstanceId].every(identity) && typeof value.fencingToken === "string" && /^[1-9][0-9]*$/u.test(value.fencingToken);
const writerFence = (writer: WorkflowIsolationWriter): RuntimeAttemptFenceV1 => ({ workUnitId: writer.workUnitId,
  attemptId: writer.attemptId, runtimeInstanceId: writer.runtimeInstanceId, fencingToken: writer.fencingToken });
function preparedTaskProjection(value: unknown): { readonly id: string; readonly title: string; readonly prompt: string; readonly channelId?: string } | undefined {
  if (!record(value) || typeof value.id !== "string" || typeof value.title !== "string" || typeof value.prompt !== "string"
    || value.channelId !== undefined && typeof value.channelId !== "string") return undefined;
  return { id: value.id, title: value.title, prompt: value.prompt,
    ...(value.channelId === undefined ? {} : { channelId: value.channelId }) };
}
const adapters = new WeakMap<RunStore, WorkflowIsolationStore>();

/** Host-internal composition. The public RunStore never exposes its SQLite handle. */
export function createSqliteWorkflowIsolationStore(store: RunStore): WorkflowIsolationStore {
  const adapter = adapters.get(store);
  if (!adapter) throw new Error("workflow_isolation.store_not_sqlite");
  return adapter;
}

/** Called only by SqliteRunStore construction; deliberately omitted from the Core barrel. */
export function registerSqliteWorkflowIsolationStore(store: RunStore, context: SqliteStoreContext,
  ports: Ports, canonicalWorkspaceRoot: string): void {
  if (adapters.has(store)) throw new Error("workflow_isolation.store_already_registered");
  adapters.set(store, new SqliteWorkflowIsolationStore(context, ports, canonicalWorkspaceRoot));
}

class SqliteWorkflowIsolationStore implements WorkflowIsolationStore {
  private readonly results: SqliteWorkflowIsolationResultsStore;
  constructor(private readonly context: SqliteStoreContext, private readonly ports: Ports,
    private readonly canonicalWorkspaceRoot: string) {
    this.results = new SqliteWorkflowIsolationResultsStore(context, ports, this, canonicalWorkspaceRoot);
  }

  getSelection(workflowId: string): ReturnType<WorkflowIsolationStore["getSelection"]> {
    return readWorkflowIsolationSelection(this.context.database, workflowId);
  }

  beginSelection(input: Parameters<WorkflowIsolationStore["beginSelection"]>[0]): ReturnType<WorkflowIsolationStore["beginSelection"]> {
    return this.transaction(() => {
      this.validateTime(input.now);
      if (!identity(input.workflowId) || !identity(input.roundId)) veto("invalid", "selection_input_invalid");
      const prior = this.getSelection(input.workflowId);
      if (prior) return { status: "duplicate", value: prior };
      const workflow = this.ports.getChannelWorkflow(input.workflowId);
      const steps = this.ports.listChannelWorkflowSteps({ workflowId: input.workflowId, complete: true });
      if (!workflow || workflow.status !== "ready" || !workflow.metadata?.workflowGraphFingerprint
        || steps.length < 2 || steps.length > 128 || steps.some(step => step.status !== "queued"
          || step.taskId || step.runId || step.metadata?.startOwner || step.metadata?.preStepApprovalId
          || step.metadata?.safetyPlan || step.metadata?.isolationScopePlan || step.metadata?.sideEffectClass !== "workspace_write")
        || this.context.database.prepare("SELECT 1 FROM workflow_integration_rounds WHERE workflow_id=? LIMIT 1").get(input.workflowId)
        || this.context.database.prepare(`SELECT 1 FROM run_sessions WHERE workflow_step_id IN
          (SELECT id FROM channel_workflow_steps WHERE workflow_id=?) LIMIT 1`).get(input.workflowId))
        veto("stale", "selection_already_started");
      this.context.database.prepare(`INSERT INTO workflow_isolation_selections
        (workflow_id,profile,round_id,phase,created_at,updated_at) VALUES(?,'pi_host_isolated_files_v1',?,'planning',?,?)`)
        .run(input.workflowId, input.roundId, input.now, input.now);
      return { status: "created", value: this.getSelection(input.workflowId)! };
    });
  }

  freezePlan(input: Parameters<WorkflowIsolationStore["freezePlan"]>[0]): ReturnType<WorkflowIsolationStore["freezePlan"]> {
    return this.transaction(() => {
      this.validateTime(input.now);
      const workflow = this.ports.getChannelWorkflow(input.expectedWorkflow.id);
      const channel = this.ports.getChannel(input.expectedChannel.id);
      const steps = this.ports.listChannelWorkflowSteps({ workflowId: input.expectedWorkflow.id, complete: true });
      if (!workflow || !channel || !same(workflow, input.expectedWorkflow) || !same(channel, input.expectedChannel)
        || !same(steps, input.expectedSteps) || input.inputs.workflowId !== workflow.id)
        veto("stale", "planning_snapshot_changed");
      const selection = this.getSelection(workflow.id);
      if (selection && (selection.roundId !== input.roundId || !input.inputs.parallelExecution
        || input.inputs.mode !== "candidate_only" || input.inputs.optionalFailurePolicy !== "require_success"
        || input.inputs.parallelExecution.maxConcurrentSteps !== 2)) veto("invalid", "selection_plan_mismatch");
      const ids = input.inputs.participants.map(participant => participant.workflowStepId);
      if (selection && (steps.length !== ids.length || steps.some(step => !ids.includes(step.id)))
        || input.safetyPlans.length !== ids.length || input.plans.length !== ids.length
        || new Set(ids).size !== ids.length || new Set(input.safetyPlans.map(plan => plan.workflowStepId)).size !== ids.length
        || new Set(input.plans.map(plan => plan.workflowStepId)).size !== ids.length
        || input.plans.some(plan => !ids.includes(plan.workflowStepId))
        || input.safetyPlans.some(plan => !ids.includes(plan.workflowStepId))) veto("invalid", "planning_members_invalid");
      for (const safetyPlan of input.safetyPlans) {
        const step = steps.find(step => step.id === safetyPlan.workflowStepId);
        if (!step || step.taskId || step.runId || step.metadata?.startOwner
          || !["queued", "waiting_for_approval"].includes(step.status)
          || !isWorkflowStepSafetyPlanV1(safetyPlan) || safetyPlan.workflowId !== workflow.id
          || safetyPlan.profile !== "pi_host_isolated_files_v1"
          || step.metadata?.safetyPlan && !same(step.metadata.safetyPlan, safetyPlan)) veto("stale", "planning_step_changed");
        // Metadata contains independently signed plans whose serialized field order must be retained.
        if (!step.metadata?.safetyPlan) this.context.database.prepare("UPDATE channel_workflow_steps SET metadata_json=?,updated_at=? WHERE id=?")
          .run(stringifyJson({ ...step.metadata, safetyPlan }), input.now, step.id);
      }
      const requireValue = <T>(result: WorkflowIsolationMutationResult<T>): T => {
        if ("value" in result) return result.value;
        throw new Veto(result);
      };
      const round = requireValue(this.createIntegrationRoundWithinTransaction({ roundId: input.roundId, inputs: input.inputs, now: input.now }));
      for (const plan of input.plans) {
        if (plan.integrationRoundId !== round.roundId || plan.generation !== round.generation) veto("invalid", "planning_round_mismatch");
        requireValue(this.createScopePlanWithinTransaction({ plan, now: input.now }));
        const step = this.ports.getChannelWorkflowStep(plan.workflowStepId)!;
        const pin = { planId: plan.planId, planDigest: plan.planDigest };
        if (!step.metadata?.isolationScopePlan) this.context.database.prepare("UPDATE channel_workflow_steps SET metadata_json=?,updated_at=? WHERE id=?")
          .run(stringifyJson({ ...step.metadata, isolationScopePlan: pin }), input.now, step.id);
      }
      if (selection?.phase === "planning") this.changed(this.context.database.prepare(`UPDATE workflow_isolation_selections
        SET phase='ready',updated_at=? WHERE workflow_id=? AND round_id=? AND phase='planning'`)
        .run(input.now, workflow.id, round.roundId));
      return { status: "created", value: { round, plans: input.plans } };
    });
  }

  recordTerminalResultIntent(input: Parameters<WorkflowIsolationStore["recordTerminalResultIntent"]>[0]): ReturnType<WorkflowIsolationStore["recordTerminalResultIntent"]> {
    return this.results.recordTerminalResultIntent(input);
  }
  getTerminalResultIntent(bindingId: string): ReturnType<WorkflowIsolationStore["getTerminalResultIntent"]> {
    return this.results.getTerminalResultIntent(bindingId);
  }
  recordTerminalResultReceipt(input: Parameters<WorkflowIsolationStore["recordTerminalResultReceipt"]>[0]): ReturnType<WorkflowIsolationStore["recordTerminalResultReceipt"]> {
    return this.results.recordTerminalResultReceipt(input);
  }
  getTerminalResultReceipt(receiptId: string): ReturnType<WorkflowIsolationStore["getTerminalResultReceipt"]> {
    return this.results.getTerminalResultReceipt(receiptId);
  }
  resumeTerminalResultStep(input: Parameters<WorkflowIsolationStore["resumeTerminalResultStep"]>[0]): ReturnType<WorkflowIsolationStore["resumeTerminalResultStep"]> {
    return this.results.resumeTerminalResultStep(input);
  }

  createIntegrationRound(input: Parameters<WorkflowIsolationStore["createIntegrationRound"]>[0]): WorkflowIsolationMutationResult<WorkflowIntegrationRound> {
    return this.transaction(() => this.createIntegrationRoundWithinTransaction(input));
  }

  private createIntegrationRoundWithinTransaction(input: Parameters<WorkflowIsolationStore["createIntegrationRound"]>[0]): WorkflowIsolationMutationResult<WorkflowIntegrationRound> {
      this.validateTime(input.now);
      const inputs = normalizeWorkflowIntegrationRoundInputs(input.inputs);
      if (!identity(input.roundId) || !inputs) veto("invalid", "round_inputs_invalid");
      this.validateRoundInputs(inputs);
      const existing = this.getIntegrationRound(input.roundId, 1);
      if (existing) {
        if (!same(existing.inputs, inputs)) veto("conflict", "round_id_reused");
        return { status: "duplicate", value: existing };
      }
      if (!workflowParallelRoundAvailable(this.context.database, inputs)
        || inputs.parallelExecution && hasActiveWorkflowMergeApplyLease(this.context.database, inputs.canonicalWorkspaceId))
        veto("conflict", "parallel_parent_busy");
      this.assertLocationAvailable(inputs.integration, inputs.repositoryIdentity.commonDir);
      this.context.database.prepare(`INSERT INTO workflow_integration_rounds(round_id,workflow_id,current_generation,created_at)
        VALUES (?,?,1,?)`).run(input.roundId, inputs.workflowId, input.now);
      this.insertGeneration(input.roundId, 1, inputs, input.now);
      if (inputs.parallelExecution) this.context.database.prepare(`INSERT INTO workflow_parallel_parent_fences
        (round_id,generation,workspace_id,common_dir,inputs_digest,state,created_at) VALUES(?,1,?,?,?,'held',?)`)
        .run(input.roundId, inputs.canonicalWorkspaceId, inputs.repositoryIdentity.commonDir, workflowIntegrationRoundInputsDigest(inputs), input.now);
      return { status: "created", value: this.getIntegrationRound(input.roundId)! };
  }

  reconcileParallelParentFence(input: Parameters<WorkflowIsolationStore["reconcileParallelParentFence"]>[0]): ReturnType<WorkflowIsolationStore["reconcileParallelParentFence"]> {
    const retained = (code: string) => ({ status: "retained" as const, code: `workflow_parallel.${code}` });
    if (!identity(input.roundId) || !revision(input.generation) || input.generation < 1 || !time(input.now)) return retained("reconcile_input_invalid");
    // Never finish a caller transaction or mutate business workflow state on a release veto.
    if (this.context.database.isTransaction) return retained("reconcile_transaction_owned");
    let began = false;
    try {
      this.context.database.exec("BEGIN IMMEDIATE"); began = true;
      const parents = readWorkflowParallelParents(this.context.database), round = this.getIntegrationRound(input.roundId, input.generation);
      let result: ReturnType<WorkflowIsolationStore["reconcileParallelParentFence"]>;
      if (!round) result = retained("round_unknown");
      else if (!round.inputs.parallelExecution) result = { status: "not_required" };
      else {
        const parent = parents.find(parent => parent.roundId === input.roundId && parent.generation === input.generation);
        const workflow = this.ports.getChannelWorkflow(round.inputs.workflowId);
        const stopped = workflow?.status === "cancelled" || workflow?.status === "failed";
        if (!parent) result = retained("parent_unknown");
        else if (parent.state === "released") result = { status: "released" };
        else if (!workflow || workflow.status !== "succeeded" && !stopped) result = retained("workflow_not_terminal");
        else if (workflowParallelWorkspaceResourcesActive(this.context.database, parent.workspaceId, true)
          || this.context.database.prepare(`SELECT 1 FROM channel_workflow_steps WHERE workflow_id=?
            AND status NOT IN ('succeeded','failed','cancelled','skipped') LIMIT 1`).get(workflow.id)) result = retained("resources_not_stopped");
        else if (this.getIntegrationRound(round.roundId)?.generation !== input.generation || round.openIntentId
          || (stopped ? !["preparing", "collecting", "integrating", "verifying", "awaiting_approval", "applied", "failed"].includes(round.phase)
            || !!round.outstandingApprovalId
            : round.inputs.mode === "candidate_only" ? round.phase !== "awaiting_approval" || !round.candidate : round.phase !== "applied"))
          result = retained("round_not_completed");
        else if (readWorkflowIntegrationPublicationBlocker(this.context.database, workflow.id)
          || !stopped && readWorkflowIntegrationCompletionBlocker(this.context.database, workflow.id, input.now))
          result = retained("completion_unverified");
        else {
          const plans = this.context.database.prepare("SELECT plan_id FROM workflow_isolation_scope_plans WHERE workflow_id=?").all(workflow.id);
          let verified = stopped || plans.length >= round.inputs.participants.length;
          for (const row of plans) {
            const plan = this.getScopePlan(String(row.plan_id))!;
            const raw = this.context.database.prepare("SELECT binding_id FROM workflow_isolation_bindings WHERE plan_id=?").get(plan.planId);
            const binding = raw && this.getExecutionBinding(String(raw.binding_id));
            if (!binding && stopped && this.parallelStepNeverStarted(plan.workflowStepId)) continue;
            if (!binding || !(stopped
              ? workflowIsolationBindingStopped(this.context.database, this.ports, binding, plan,
                this.getIntegrationRound(plan.integrationRoundId, plan.generation), input.now)
              : readWorkflowIsolationTerminalCapture(this.context.database, this.ports, binding, plan,
                this.getIntegrationRound(plan.integrationRoundId, plan.generation), input.now).status === "authorized")) { verified = false; break; }
          }
          if (stopped) {
            for (const participant of round.inputs.participants) {
              if (!plans.some(row => this.getScopePlan(String(row.plan_id))!.workflowStepId === participant.workflowStepId)
                && !this.parallelStepNeverStarted(participant.workflowStepId)) verified = false;
            }
          }
          if (!verified) result = retained("original_bindings_unverified");
          else {
            this.changed(this.context.database.prepare(`UPDATE workflow_parallel_parent_fences SET state='released',released_at=?
              WHERE round_id=? AND generation=? AND state='held' AND created_at<=?`).run(input.now, input.roundId, input.generation, input.now));
            result = { status: "released" };
          }
        }
      }
      this.context.database.exec("COMMIT");
      return result;
    } catch {
      if (began) rollbackOwnedSqliteTransaction(this.context.database);
      return retained("reconcile_evidence_unknown");
    }
  }

  private parallelStepNeverStarted(stepId: string): boolean {
    const step = this.ports.getChannelWorkflowStep(stepId);
    return !!step && ["cancelled", "skipped"].includes(step.status) && !step.taskId && !step.runId && !step.metadata?.startOwner
      && !this.context.database.prepare("SELECT 1 FROM workflow_step_admissions WHERE workflow_step_id=? LIMIT 1").get(stepId)
      && !this.context.database.prepare("SELECT 1 FROM run_sessions WHERE workflow_step_id=? LIMIT 1").get(stepId)
      && !this.context.database.prepare(`SELECT 1 FROM work_units WHERE json_valid(request_json) IS NOT 1
        OR json_extract(request_json,'$.workflowStepId')=? LIMIT 1`).get(stepId);
  }

  getIntegrationRound(roundId: string, generation?: number): WorkflowIntegrationRound | undefined {
    const row = generation === undefined
      ? this.context.database.prepare(`SELECT generation.* FROM workflow_integration_generations AS generation
          JOIN workflow_integration_rounds AS round ON round.round_id=generation.round_id
          AND round.current_generation=generation.generation WHERE round.round_id=?`).get(roundId)
      : this.context.database.prepare("SELECT * FROM workflow_integration_generations WHERE round_id=? AND generation=?").get(roundId, generation);
    if (!row) return undefined;
    const inputs = normalizeWorkflowIntegrationRoundInputs(JSON.parse(String(row.inputs_json)));
    if (!inputs || workflowIntegrationRoundInputsDigest(inputs) !== row.inputs_digest) throw new Error("workflow_isolation.round_corrupt");
    const candidate = row.candidate_json === null ? undefined
      : normalizeWorkflowIntegrationCandidate(JSON.parse(String(row.candidate_json)), inputs.repositoryIdentity.objectFormat);
    if (row.candidate_json !== null && !candidate) throw new Error("workflow_isolation.candidate_corrupt");
    return { roundId: String(row.round_id), generation: Number(row.generation), revision: Number(row.revision), inputs,
      inputsDigest: String(row.inputs_digest), phase: row.phase as WorkflowIntegrationRound["phase"],
      lastConfirmedPhase: row.last_confirmed_phase as WorkflowIntegrationRound["phase"],
      ...(row.writer_binding_id === null ? {} : { writerBindingId: String(row.writer_binding_id) }),
      ...(row.open_intent_id === null ? {} : { openIntentId: String(row.open_intent_id) }),
      ...(candidate ? { candidate } : {}),
      ...(row.outstanding_approval_id === null ? {} : { outstandingApprovalId: String(row.outstanding_approval_id) }),
      ...(row.reason === null ? {} : { reason: String(row.reason) }), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
  }

  createScopePlan(input: Parameters<WorkflowIsolationStore["createScopePlan"]>[0]): WorkflowIsolationMutationResult<WorkflowIsolationScopePlanV1> {
    return this.transaction(() => this.createScopePlanWithinTransaction(input));
  }

  private createScopePlanWithinTransaction(input: Parameters<WorkflowIsolationStore["createScopePlan"]>[0]): WorkflowIsolationMutationResult<WorkflowIsolationScopePlanV1> {
      this.validateTime(input.now);
      const plan = normalizeWorkflowIsolationScopePlan(input.plan);
      if (!plan) veto("invalid", "scope_plan_invalid");
      const round = this.getIntegrationRound(plan.integrationRoundId);
      if (!round || round.generation !== plan.generation) veto("stale", "generation_changed");
      this.validateRoundInputs(round.inputs);
      const parents = readWorkflowParallelParents(this.context.database);
      if (parents.some(parent => parent.state === "held" && (parent.workspaceId === plan.canonicalWorkspaceId
        || parent.commonDir === plan.repositoryIdentity.commonDir) && (parent.roundId !== round.roundId || parent.generation !== round.generation))
        || round.inputs.parallelExecution && !parents.some(parent => parent.state === "held" && parent.roundId === round.roundId && parent.generation === round.generation))
        veto("conflict", "parallel_parent_busy");
      const step = this.ports.getChannelWorkflowStep(plan.workflowStepId);
      if (!step || step.workflowId !== plan.workflowId || step.workspaceId !== plan.canonicalWorkspaceId
        || !same({ workflowId: plan.workflowId, canonicalWorkspaceId: plan.canonicalWorkspaceId,
          canonicalWorkspaceRoot: plan.canonicalWorkspaceRoot, repositoryIdentity: plan.repositoryIdentity,
          target: plan.target, baseCommit: plan.baseCommit, graphFingerprint: plan.graphFingerprint, templatePins: plan.templatePins },
        { workflowId: round.inputs.workflowId, canonicalWorkspaceId: round.inputs.canonicalWorkspaceId,
          canonicalWorkspaceRoot: round.inputs.canonicalWorkspaceRoot, repositoryIdentity: round.inputs.repositoryIdentity,
          target: round.inputs.target, baseCommit: round.inputs.baseCommit, graphFingerprint: round.inputs.graphFingerprint,
          templatePins: round.inputs.templatePins })
        || !round.inputs.participants.some(p => p.workflowStepId === step.id && p.position === step.position)
        || round.inputs.safetyPins.find(pin => pin.workflowStepId === step.id)?.fingerprint !== plan.safetyFingerprint
        || workflowIsolationStepSafetyFingerprint(step) !== plan.safetyFingerprint) veto("invalid", "scope_round_mismatch");
      const safety = step.metadata?.safetyPlan;
      if (!isWorkflowStepSafetyPlanV1(safety) || safety.workflowId !== plan.workflowId || safety.workflowStepId !== plan.workflowStepId
        || safety.workspaceRoot !== plan.canonicalWorkspaceRoot || safety.executionRoot !== plan.executionRoot
        || !plan.resourcePlan.entries.some(e => e.resourceType === "runner" && e.resourceKey === safety.runnerId)
        || !plan.resourcePlan.entries.some(e => e.resourceType === "channel_parallel" && e.resourceKey === step.channelId)
        || !round.inputs.parallelExecution && !plan.resourcePlan.resourceKeys.includes(`workflow:${plan.workflowId}`)
        || safety.safety.parallelPolicy?.resourceKeys?.some(key => !plan.resourcePlan.resourceKeys.includes(key))
        || !round.inputs.parallelExecution && !plan.resourcePlan.resourceKeys.some(key => key.startsWith("workspace:"))
        || round.inputs.parallelExecution && !workflowParallelScopeValid(this.ports, round.inputs, plan)) veto("invalid", "scope_safety_plan_mismatch");
      const pin = { planId: plan.planId, planDigest: plan.planDigest };
      if (step.metadata?.isolationScopePlan && !same(step.metadata.isolationScopePlan, pin)) veto("stale", "scope_pin_changed");
      // Approval/start will see this exact pin after the Host persists it. It is excluded from the safety digest.
      const basis = workflowStepStartAuthorityBasis(this.ports, { ...step, metadata: { ...step.metadata, isolationScopePlan: pin } });
      if (!basis) veto("invalid", "scope_authority_missing");
      const existing = this.planRow(plan.planId);
      if (existing) {
        if (!same(this.getScopePlan(plan.planId), plan) || existing.authority_basis !== basis) veto("conflict", "plan_id_reused");
        return { status: "duplicate", value: plan };
      }
      if (!["preparing", "collecting"].includes(round.phase) || round.openIntentId || step.taskId || step.runId
        || !["queued", "waiting_for_approval"].includes(step.status)) veto("stale", "scope_creation_started");
      if (this.context.database.prepare("SELECT 1 FROM workflow_isolation_scope_plans WHERE workflow_step_id=? AND step_generation=?")
        .get(step.id, plan.stepGeneration)) veto("conflict", "step_generation_reused");
      this.assertLocationAvailable(plan, plan.repositoryIdentity.commonDir);
      this.context.database.prepare(`INSERT INTO workflow_isolation_scope_plans(plan_id,plan_digest,workflow_id,workflow_step_id,
        canonical_workspace_id,round_id,generation,step_generation,common_dir,execution_root,worktree_id,branch_ref,authority_basis,plan_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(plan.planId, plan.planDigest, plan.workflowId, plan.workflowStepId,
        plan.canonicalWorkspaceId, plan.integrationRoundId, plan.generation, plan.stepGeneration,
        plan.repositoryIdentity.commonDir, plan.executionRoot, plan.worktreeId, plan.branchRef, basis, json(plan), input.now);
      return { status: "created", value: plan };
  }

  getScopePlan(planId: string): WorkflowIsolationScopePlanV1 | undefined {
    const row = this.planRow(planId);
    if (!row) return undefined;
    const plan = normalizeWorkflowIsolationScopePlan(JSON.parse(String(row.plan_json)));
    if (!plan || plan.planId !== row.plan_id || plan.planDigest !== row.plan_digest || plan.workflowId !== row.workflow_id
      || plan.workflowStepId !== row.workflow_step_id || plan.canonicalWorkspaceId !== row.canonical_workspace_id
      || plan.integrationRoundId !== row.round_id || plan.generation !== row.generation || plan.stepGeneration !== row.step_generation
      || plan.repositoryIdentity.commonDir !== row.common_dir || plan.executionRoot !== row.execution_root
      || plan.worktreeId !== row.worktree_id || plan.branchRef !== row.branch_ref) throw new Error("workflow_isolation.plan_corrupt");
    return plan;
  }

  bindExecution(input: BindWorkflowIsolationExecutionInput): WorkflowIsolationMutationResult<WorkflowIsolationExecutionBinding> {
    return this.transaction(() => {
      this.validateTime(input.now);
      if (!identity(input.bindingId) || !identity(input.runId) || !isWorkflowStepStartOwnerV1(input.startOwner)
        || !validFence(input.fence)) veto("invalid", "binding_input_invalid");
      const plan = this.getScopePlan(input.planId);
      if (!plan || plan.planDigest !== input.planDigest) veto("invalid", "binding_plan_mismatch");
      const proposed: WorkflowIsolationExecutionBinding = { bindingId: input.bindingId, revision: 0, planId: plan.planId,
        planDigest: plan.planDigest, startOwner: input.startOwner, runId: input.runId, fence: writerFence({ bindingId: input.bindingId, ...input.fence }),
        location: { executionRoot: plan.executionRoot, worktreeId: plan.worktreeId, branchRef: plan.branchRef },
        status: "planned", createdAt: input.now, updatedAt: input.now };
      const existing = this.getExecutionBinding(input.bindingId);
      this.validateLineage(existing ?? proposed, plan, input.now, true);
      if (existing) {
        if (existing.planId !== plan.planId || existing.planDigest !== plan.planDigest) veto("conflict", "binding_id_reused");
        if (existing.runId !== input.runId || !sameFence(existing.fence, input.fence)
          || !workflowStepStartOwnerMatches(existing.startOwner, input.startOwner)) veto("stale", "binding_fence_changed");
        return { status: "duplicate", value: existing };
      }
      if (this.context.database.prepare("SELECT 1 FROM workflow_isolation_bindings WHERE plan_id=? OR attempt_id=?")
        .get(plan.planId, input.fence.attemptId)) veto("conflict", "binding_identity_retained");
      const run = this.ports.getRun(input.runId)!, unit = this.ports.getWorkUnit(input.fence.workUnitId)!, attempt = this.ports.getWorkUnitAttempt(input.fence.attemptId)!;
      if (run.status !== "queued" || run.startedAt || run.endedAt || !["queued", "claimed"].includes(unit.status)
        || unit.startedAt || unit.endedAt || unit.lastHeartbeatAt || attempt.status !== "created" || attempt.startedAt
        || attempt.endedAt || attempt.abortRequestedAt || attempt.lastHeartbeatAt) veto("stale", "binding_already_dispatched");
      this.context.database.prepare(`INSERT INTO workflow_isolation_bindings(binding_id,revision,plan_id,task_id,lease_id,authority_basis,
        start_owner_json,run_id,work_unit_id,attempt_id,runtime_instance_id,fencing_token,status,created_at,updated_at)
        VALUES (?,0,?,?,?,?,?,?,?,?,?,?,'planned',?,?)`).run(input.bindingId, plan.planId, input.startOwner.taskId,
        input.startOwner.leaseId, input.startOwner.authorityBasis, json(input.startOwner), input.runId,
        input.fence.workUnitId, input.fence.attemptId, input.fence.runtimeInstanceId, input.fence.fencingToken, input.now, input.now);
      return { status: "created", value: this.getExecutionBinding(input.bindingId)! };
    });
  }

  getExecutionBinding(bindingId: string): WorkflowIsolationExecutionBinding | undefined {
    const row = this.context.database.prepare("SELECT * FROM workflow_isolation_bindings WHERE binding_id=?").get(bindingId);
    if (!row) return undefined;
    const plan = this.getScopePlan(String(row.plan_id)), owner: unknown = JSON.parse(String(row.start_owner_json));
    if (!plan || !isWorkflowStepStartOwnerV1(owner) || owner.taskId !== row.task_id || owner.leaseId !== row.lease_id
      || owner.authorityBasis !== row.authority_basis) throw new Error("workflow_isolation.binding_corrupt");
    return { bindingId, revision: Number(row.revision), planId: plan.planId, planDigest: plan.planDigest,
      startOwner: owner, runId: String(row.run_id), fence: { workUnitId: String(row.work_unit_id), attemptId: String(row.attempt_id),
        runtimeInstanceId: String(row.runtime_instance_id), fencingToken: String(row.fencing_token) },
      location: { executionRoot: plan.executionRoot, worktreeId: plan.worktreeId, branchRef: plan.branchRef },
      status: row.status as WorkflowIsolationExecutionBinding["status"],
      ...(row.creation_receipt_id === null ? {} : { creationReceiptId: String(row.creation_receipt_id) }),
      ...(row.open_intent_id === null ? {} : { openIntentId: String(row.open_intent_id) }),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
  }

  assertExecutionBinding(input: Parameters<WorkflowIsolationStore["assertExecutionBinding"]>[0]): ReturnType<WorkflowIsolationStore["assertExecutionBinding"]> {
    try {
      const { binding, plan } = this.currentWriter(input.writer, input.now, input.requireReady !== false);
      return { status: "current", binding, plan };
    } catch (error) {
      if (error instanceof Veto) return { status: error.result.status === "invalid" ? "invalid" : "stale", code: error.result.code };
      throw error;
    }
  }

  assertTerminalCapture(input: Parameters<WorkflowIsolationStore["assertTerminalCapture"]>[0]): ReturnType<WorkflowIsolationStore["assertTerminalCapture"]> {
    return readSqliteSnapshot(this.context.database, () => {
      try {
        this.validateTime(input.now);
        if (!input.writer || !identity(input.writer.bindingId) || !validFence(input.writer)) veto("invalid", "writer_invalid");
        const binding = this.getExecutionBinding(input.writer.bindingId), plan = binding && this.getScopePlan(binding.planId);
        if (!binding || !plan || !sameFence(binding.fence, input.writer) || plan.canonicalWorkspaceRoot !== this.canonicalWorkspaceRoot)
          veto("stale", "writer_fence_changed");
        this.expectRevision(binding.revision, input.expectedRevision);
        return readWorkflowIsolationTerminalCapture(this.context.database, this.ports, binding, plan,
          this.getIntegrationRound(plan.integrationRoundId), input.now);
      } catch (error) {
        if (error instanceof Veto) return { status: error.result.status === "invalid" ? "invalid" as const : "stale" as const, code: error.result.code };
        throw error;
      }
    });
  }

  // Journal and phase methods share short owned transactions; Git I/O is always outside this object.
  markExecutionReady(input: Parameters<WorkflowIsolationStore["markExecutionReady"]>[0]): WorkflowIsolationMutationResult<WorkflowIsolationExecutionBinding> {
    return this.transaction(() => {
      const { binding } = this.currentWriter(input.writer, input.now, false);
      const command = this.command<WorkflowIsolationExecutionBinding>("ready", input.commandId, input, input.writer);
      if (command) return { status: "duplicate", value: command };
      this.expectRevision(binding.revision, input.expectedRevision);
      if (binding.status !== "planned" || binding.openIntentId) veto("conflict", "binding_not_settled");
      const receipt = this.getReceipt(input.creationReceiptId), intent = receipt && this.getIntent(receipt.intentId);
      if (!receipt || receipt.outcome !== "confirmed" || !intent || intent.kind !== "worktree_create"
        || intent.status !== "confirmed" || intent.scope.type !== "binding" || intent.scope.bindingId !== binding.bindingId
        || !same(intent.writer, input.writer)) veto("invalid", "creation_receipt_mismatch");
      this.changed(this.context.database.prepare(`UPDATE workflow_isolation_bindings SET status='ready',creation_receipt_id=?,
        revision=revision+1,updated_at=? WHERE binding_id=? AND revision=? AND status='planned' AND open_intent_id IS NULL`)
        .run(receipt.receiptId, input.now, binding.bindingId, input.expectedRevision));
      const value = this.getExecutionBinding(binding.bindingId)!;
      this.saveCommand("ready", input.commandId, input, input.writer, value, input.now);
      return { status: "updated", value };
    });
  }

  sealPreparedExecution(input: SealWorkflowIsolationPreparedExecutionInput): WorkflowIsolationMutationResult<WorkflowIsolationExecutionBinding> {
    return this.transaction(() => {
      const { binding, plan } = this.currentWriter(input.writer, input.now, false);
      if (binding.status !== "ready" || binding.openIntentId) veto("stale", "execution_not_ready");
      const run = this.ports.getRun(binding.runId)!, unit = this.ports.getWorkUnit(binding.fence.workUnitId)!, attempt = this.ports.getWorkUnitAttempt(binding.fence.attemptId)!;
      if (run.status !== "queued" || run.startedAt || run.endedAt || !["queued", "claimed"].includes(unit.status)
        || unit.startedAt || unit.endedAt || unit.lastHeartbeatAt || attempt.status !== "created" || attempt.startedAt
        || attempt.endedAt || attempt.abortRequestedAt || attempt.lastHeartbeatAt || attempt.effectiveRunnerId !== "pi") veto("stale", "preparation_already_started");
      if (this.context.database.prepare(`SELECT 1 FROM host_operations WHERE attempt_id=?
        UNION ALL SELECT 1 FROM harness_tool_executions WHERE attempt_id=?
        UNION ALL SELECT 1 FROM native_submissions WHERE attempt_id=?
        UNION ALL SELECT 1 FROM runtime_heartbeats WHERE attempt_id=?
        UNION ALL SELECT 1 FROM host_attempt_completions WHERE attempt_id=?
        UNION ALL SELECT 1 FROM run_events WHERE run_id=? AND type IN ('tool_start','tool_end','host_command_prepared','host_command_settled') LIMIT 1`)
        .get(attempt.id, attempt.id, attempt.id, attempt.id, attempt.id, run.id)) veto("stale", "preparation_already_started");
      const snapshot = run.requestSnapshot, request = unit.request, payload = input.runnerExecutionInput;
      if (!record(snapshot) || !record(request) || !record(payload) || payload.schemaVersion !== 1 || payload.runnerId !== "pi"
        || typeof payload.toolHydrationEnabled !== "boolean" || !record(payload.input) || !record(payload.input.task)
        || payload.input.cwd !== plan.executionRoot || payload.input.task.id !== run.taskId || !record(payload.input.provider)
        || payload.input.provider.provider !== run.providerName || payload.input.provider.model !== run.providerModel
        || "apiKey" in payload.input.provider || "headers" in payload.input.provider
        || !same(redactSecrets(payload), payload) || !record(payload.preparedInput)
        || payload.preparedInput.schemaVersion !== 1 || payload.preparedInput.boundary !== "pi-model-context"
        || payload.preparedInput.taskId !== run.taskId || !Array.isArray(payload.preparedInput.tools)
        || !Array.isArray(payload.input.tools)) veto("invalid", "prepared_input_invalid");
      const task = preparedTaskProjection(record(snapshot.task) ? snapshot.task : run.taskSnapshot);
      if (!task || task.id !== run.taskId || !same(preparedTaskProjection(payload.input.task) ?? null, task)
        || request.task !== undefined && !same(preparedTaskProjection(request.task) ?? null, task)
        || snapshot.cwd !== undefined && snapshot.cwd !== plan.executionRoot
        || request.cwd !== undefined && request.cwd !== plan.executionRoot) veto("invalid", "prepared_task_mismatch");
      const safety = this.ports.getChannelWorkflowStep(plan.workflowStepId)!.metadata!.safetyPlan!;
      const allowedTools: readonly unknown[] = safety.tools, tools = payload.input.tools;
      if (tools.some(tool => !allowedTools.includes(tool))
        || new Set(tools).size !== tools.length
        || payload.preparedInput.tools.some(tool => !record(tool) || typeof tool.name !== "string"
          || ["read", "grep", "find", "ls", "write", "edit", "bash"].includes(tool.name)
            && !tools.includes(tool.name))) veto("invalid", "prepared_tools_widened");
      const { fingerprint, ...body } = payload.preparedInput;
      if (typeof fingerprint !== "string" || fingerprint !== createHash("sha256").update(JSON.stringify(body)).digest("hex")) veto("invalid", "prepared_fingerprint_invalid");
      // Validate JSON without canonicalizing the SDK evidence: its fingerprint includes field order.
      json(payload);
      if (!revision(input.expectedRevision)) veto("invalid", "revision_invalid");
      const runInput = snapshot.runnerExecutionInput, unitInput = request.runnerExecutionInput;
      if (runInput !== undefined || unitInput !== undefined) {
        if (!same(runInput ?? null, payload) || !same(unitInput ?? null, payload)) veto("conflict", "prepared_input_already_sealed");
        return { status: "duplicate", value: binding };
      }
      this.expectRevision(binding.revision, input.expectedRevision);
      const runRow = this.context.database.prepare("SELECT request_snapshot_json FROM run_sessions WHERE id=?").get(run.id)!;
      const unitRow = this.context.database.prepare("SELECT request_json FROM work_units WHERE id=?").get(unit.id)!;
      this.changed(this.context.database.prepare(`UPDATE run_sessions SET request_snapshot_json=?,updated_at=?
        WHERE id=? AND status='queued' AND started_at IS NULL AND ended_at IS NULL AND request_snapshot_json=?`)
        .run(JSON.stringify({ ...snapshot, runnerExecutionInput: payload }), input.now, run.id, runRow.request_snapshot_json!));
      this.changed(this.context.database.prepare(`UPDATE work_units SET request_json=?,updated_at=?
        WHERE id=? AND active_attempt_id=? AND request_json=? AND started_at IS NULL AND ended_at IS NULL`)
        .run(JSON.stringify({ ...request, runnerExecutionInput: payload }), input.now, unit.id, attempt.id, unitRow.request_json!));
      this.changed(this.context.database.prepare(`UPDATE workflow_isolation_bindings SET revision=revision+1,updated_at=?
        WHERE binding_id=? AND revision=? AND status='ready' AND open_intent_id IS NULL`)
        .run(input.now, binding.bindingId, input.expectedRevision));
      return { status: "updated", value: this.getExecutionBinding(binding.bindingId)! };
    });
  }

  beginIntegrationRoundGeneration(input: Parameters<WorkflowIsolationStore["beginIntegrationRoundGeneration"]>[0]): WorkflowIsolationMutationResult<WorkflowIntegrationRound> {
    return this.transaction(() => {
      const { plan } = this.currentWriter(input.writer, input.now, true, false);
      const command = this.command<WorkflowIntegrationRound>("generation", input.commandId, input, input.writer);
      if (command) return { status: "duplicate", value: command };
      const round = this.getIntegrationRound(input.roundId), inputs = normalizeWorkflowIntegrationRoundInputs(input.inputs);
      if (!round || round.generation !== input.expectedGeneration || plan.integrationRoundId !== round.roundId
        || plan.generation !== round.generation || round.writerBindingId !== input.writer.bindingId) veto("stale", "generation_changed");
      this.expectRevision(round.revision, input.expectedRevision);
      if (!inputs || inputs.workflowId !== round.inputs.workflowId || inputs.canonicalWorkspaceId !== round.inputs.canonicalWorkspaceId
        || inputs.canonicalWorkspaceRoot !== round.inputs.canonicalWorkspaceRoot || !same(inputs.repositoryIdentity, round.inputs.repositoryIdentity)
        || inputs.graphFingerprint !== round.inputs.graphFingerprint || inputs.mode !== round.inputs.mode
        || !same(inputs.parallelExecution ?? null, round.inputs.parallelExecution ?? null)
        || !same(inputs.participants, round.inputs.participants) || !same(inputs.mergeOrder, round.inputs.mergeOrder)
        || !same(inputs.validationRequirements, round.inputs.validationRequirements)
        || inputs.optionalFailurePolicy !== round.inputs.optionalFailurePolicy) veto("invalid", "generation_inputs_mismatch");
      if (round.inputs.parallelExecution) veto("conflict", "parallel_generation_requires_new_round");
      if (!workflowParallelRoundAvailable(this.context.database, inputs)) veto("conflict", "parallel_parent_busy");
      this.validateRoundInputs(inputs);
      if (!["failed", "conflicted", "blocked"].includes(round.phase) || this.hasPendingRound(round.roundId, round.generation)) veto("conflict", "generation_effects_unconfirmed");
      this.assertLocationAvailable(inputs.integration, inputs.repositoryIdentity.commonDir);
      this.insertGeneration(round.roundId, round.generation + 1, inputs, input.now);
      this.changed(this.context.database.prepare(`UPDATE workflow_integration_rounds SET current_generation=current_generation+1
        WHERE round_id=? AND current_generation=?`).run(round.roundId, input.expectedGeneration));
      const value = this.getIntegrationRound(round.roundId)!;
      this.saveCommand("generation", input.commandId, input, input.writer, value, input.now);
      return { status: "created", value };
    });
  }

  advanceIntegrationRound(input: AdvanceWorkflowIntegrationRoundInput): WorkflowIsolationMutationResult<WorkflowIntegrationRound> {
    return this.transaction(() => {
      const { plan } = this.currentWriter(input.writer, input.now, true);
      if (input.to === "applying" || input.to === "applied" || input.approvalId !== undefined) veto("invalid", "merge_permit_not_implemented");
      const command = this.command<WorkflowIntegrationRound>("advance", input.commandId, input, input.writer);
      if (command) return { status: "duplicate", value: command };
      const round = this.currentRound(input.roundId, input.generation, plan, input.writer);
      this.expectRevision(round.revision, input.expectedRevision);
      if (round.phase !== input.from || !canTransitionWorkflowIntegrationRound(input.from, input.to)) veto("stale", "phase_changed");
      if (this.hasPendingRound(round.roundId, round.generation)) veto("conflict", "round_effects_unconfirmed");
      if (input.reason !== undefined && !identity(input.reason)) veto("invalid", "reason_invalid");
      if (["failed", "conflicted", "blocked"].includes(input.to) && !identity(input.reason)) veto("invalid", "reason_required");
      const receipts = this.roundReceipts(round, input.receiptIds ?? []);
      if (input.to === "collecting") {
        const rows = this.context.database.prepare(`SELECT plan.plan_id,binding.status FROM workflow_isolation_scope_plans AS plan
          LEFT JOIN workflow_isolation_bindings AS binding ON binding.plan_id=plan.plan_id WHERE plan.round_id=? AND plan.generation=?`)
          .all(round.roundId, round.generation);
        if (rows.length !== round.inputs.participants.length || rows.some(row => row.status !== "ready")) veto("conflict", "participants_not_ready");
      }
      if (input.to === "integrating" && !receipts.some(r => this.getIntent(r.intentId)?.kind === "integration_create")) veto("invalid", "integration_receipt_required");
      const candidate = input.candidate === undefined ? undefined : normalizeWorkflowIntegrationCandidate(input.candidate, round.inputs.repositoryIdentity.objectFormat);
      if (input.candidate !== undefined && !candidate) veto("invalid", "candidate_invalid");
      if (candidate && input.to !== "awaiting_approval") veto("invalid", "candidate_phase_invalid");
      if (input.to === "awaiting_approval" && (!candidate || !receipts.some(r => {
        const intent = this.getIntent(r.intentId);
        return intent?.kind === "candidate_verify" && r.observed.headCommit === candidate.commit && r.observed.tree === candidate.tree;
      }))) veto("invalid", "candidate_receipt_required");
      if (input.to === "verifying") {
        const merged = this.context.database.prepare(`SELECT COUNT(*) AS count FROM workflow_isolation_intents
          WHERE round_id=? AND generation=? AND kind='integrate_branch' AND status='confirmed'`).get(round.roundId, round.generation)!;
        if (Number(merged.count) !== round.inputs.mergeOrder.length) veto("invalid", "integration_incomplete");
      }
      const lastConfirmed = ["blocked", "failed", "conflicted"].includes(input.to) ? round.lastConfirmedPhase : input.to;
      this.changed(this.context.database.prepare(`UPDATE workflow_integration_generations SET phase=?,last_confirmed_phase=?,
        writer_binding_id=COALESCE(writer_binding_id,?),candidate_json=COALESCE(candidate_json,?),reason=?,revision=revision+1,updated_at=?
        WHERE round_id=? AND generation=? AND revision=? AND phase=? AND open_intent_id IS NULL`)
        .run(input.to, lastConfirmed, input.writer.bindingId, candidate ? json(candidate) : null, input.reason ?? null,
          input.now, round.roundId, round.generation, input.expectedRevision, input.from));
      const value = this.getIntegrationRound(round.roundId)!;
      this.saveCommand("advance", input.commandId, input, input.writer, value, input.now);
      return { status: "updated", value };
    });
  }

  recordIntent(input: RecordWorkflowIsolationIntentInput): WorkflowIsolationMutationResult<WorkflowIsolationIntent> {
    return this.transaction(() => {
      const { binding, plan } = this.currentWriter(input.writer, input.now, false);
      if (input.kind !== "worktree_create" && binding.status !== "ready") veto("stale", "execution_not_ready");
      if (input.kind === "target_apply") veto("invalid", "merge_permit_not_implemented");
      if (!identity(input.intentId) || !identity(input.commandId)) veto("invalid", "intent_identity_invalid");
      const payload = this.intentPayload(input), intentDigest = digest(payload);
      const existing = this.getIntent(input.intentId);
      const byCommand = this.context.database.prepare("SELECT intent_id FROM workflow_isolation_intents WHERE command_id=?").get(input.commandId);
      if (existing || byCommand) {
        if (!existing || byCommand?.intent_id !== existing.intentId || existing.digest !== intentDigest) veto("conflict", "intent_command_reused");
        return { status: "duplicate", value: existing };
      }
      const scope = this.journalScope(input.scope, binding, plan, input.writer);
      this.expectRevision(scope.revision, input.expectedRevision);
      if (scope.openIntentId) veto("conflict", "effect_unconfirmed");
      const before = normalizeWorkflowIsolationGitIdentity(input.before), after = normalizeWorkflowIsolationGitIdentity(input.after);
      if (!before || !after) veto("invalid", "git_identity_invalid");
      this.validateEffect(input, before, after, binding, plan, scope);
      this.context.database.prepare(`INSERT INTO workflow_isolation_intents(intent_id,command_id,intent_digest,scope_type,scope_binding_id,
        round_id,generation,scope_revision,writer_binding_id,work_unit_id,attempt_id,runtime_instance_id,fencing_token,kind,before_json,after_json,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)`).run(input.intentId, input.commandId, intentDigest, input.scope.type,
        input.scope.type === "binding" ? input.scope.bindingId : null, input.scope.type === "round" ? input.scope.roundId : null,
        input.scope.type === "round" ? input.scope.generation : null, input.expectedRevision, input.writer.bindingId,
        input.writer.workUnitId, input.writer.attemptId, input.writer.runtimeInstanceId, input.writer.fencingToken,
        input.kind, json(before), json(after), input.now);
      this.updateScope(input.scope, input.expectedRevision, input.intentId, input.writer, input.now);
      return { status: "created", value: this.getIntent(input.intentId)! };
    });
  }

  getIntent(intentId: string): WorkflowIsolationIntent | undefined {
    const row = this.context.database.prepare("SELECT * FROM workflow_isolation_intents WHERE intent_id=?").get(intentId);
    if (!row) return undefined;
    const before = normalizeWorkflowIsolationGitIdentity(JSON.parse(String(row.before_json)));
    const after = normalizeWorkflowIsolationGitIdentity(JSON.parse(String(row.after_json)));
    if (!before || !after) throw new Error("workflow_isolation.intent_corrupt");
    const value: WorkflowIsolationIntent = { intentId: String(row.intent_id), commandId: String(row.command_id), digest: String(row.intent_digest),
      scope: row.scope_type === "binding" ? { type: "binding", bindingId: String(row.scope_binding_id) }
        : { type: "round", roundId: String(row.round_id), generation: Number(row.generation) }, scopeRevision: Number(row.scope_revision),
      writer: { bindingId: String(row.writer_binding_id), workUnitId: String(row.work_unit_id), attemptId: String(row.attempt_id),
        runtimeInstanceId: String(row.runtime_instance_id), fencingToken: String(row.fencing_token) },
      kind: row.kind as WorkflowIsolationIntent["kind"], before, after,
      status: row.status as WorkflowIsolationIntent["status"], createdAt: String(row.created_at) };
    if (value.digest !== digest(this.intentPayload({ ...value, expectedRevision: value.scopeRevision }))) throw new Error("workflow_isolation.intent_digest_corrupt");
    return value;
  }

  recordReceipt(input: RecordWorkflowIsolationReceiptInput): WorkflowIsolationMutationResult<WorkflowIsolationReceipt> {
    return this.transaction(() => {
      const { binding, plan } = this.currentWriter(input.writer, input.now, false);
      if (!identity(input.receiptId) || !identity(input.artifactId) || !["confirmed", "blocked", "effect_unknown"].includes(input.outcome)) veto("invalid", "receipt_input_invalid");
      const intent = this.getIntent(input.intentId), observed = normalizeWorkflowIsolationGitIdentity(input.observed);
      if (!intent || !same(intent.writer, input.writer) || !observed) veto("stale", "receipt_intent_mismatch");
      if (intent.kind === "target_apply") veto("invalid", "target_apply_receipt_requires_permit");
      const receiptDigest = digest(this.receiptPayload(input));
      const existing = this.getReceipt(input.receiptId);
      if (existing) {
        if (existing.digest !== receiptDigest) veto("conflict", "receipt_id_reused");
        return { status: "duplicate", value: existing };
      }
      const scope = this.journalScope(intent.scope, binding, plan, input.writer);
      this.expectRevision(scope.revision, input.expectedRevision);
      if (scope.openIntentId !== intent.intentId || intent.status === "confirmed") veto("stale", "receipt_effect_changed");
      const artifact = this.ports.getArtifact(input.artifactId);
      if (!artifact || artifact.runId !== binding.runId || !artifact.contentSha256 || artifact.sealedPayloadState === "pruned"
        || artifact.sealedPayload === undefined) veto("invalid", "receipt_artifact_mismatch");
      if (input.outcome === "confirmed" && !same(observed, intent.after)) veto("invalid", "receipt_after_mismatch");
      if (!sameLocation(observed, intent.after) || observed.commonDir !== plan.repositoryIdentity.commonDir) veto("invalid", "receipt_location_mismatch");
      this.context.database.prepare(`INSERT INTO workflow_isolation_receipts(receipt_id,intent_id,receipt_digest,scope_revision,outcome,observed_json,artifact_id,created_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(input.receiptId, intent.intentId, receiptDigest, input.expectedRevision, input.outcome,
        json(observed), input.artifactId, input.now);
      this.changed(this.context.database.prepare("UPDATE workflow_isolation_intents SET status=? WHERE intent_id=? AND status<>'confirmed'")
        .run(input.outcome, intent.intentId));
      this.updateScope(intent.scope, input.expectedRevision, input.outcome === "confirmed" ? null : intent.intentId, input.writer, input.now);
      return { status: "created", value: this.getReceipt(input.receiptId)! };
    });
  }

  getReceipt(receiptId: string): WorkflowIsolationReceipt | undefined {
    const row = this.context.database.prepare("SELECT * FROM workflow_isolation_receipts WHERE receipt_id=?").get(receiptId);
    if (!row) return undefined;
    const observed = normalizeWorkflowIsolationGitIdentity(JSON.parse(String(row.observed_json)));
    const intent = this.getIntent(String(row.intent_id));
    if (!observed || !intent) throw new Error("workflow_isolation.receipt_corrupt");
    const value: WorkflowIsolationReceipt = { receiptId, intentId: intent.intentId, digest: String(row.receipt_digest),
      outcome: row.outcome as WorkflowIsolationReceipt["outcome"], observed, artifactId: String(row.artifact_id), createdAt: String(row.created_at) };
    if (value.digest !== digest(this.receiptPayload({ ...value, expectedRevision: Number(row.scope_revision), writer: intent.writer }))) throw new Error("workflow_isolation.receipt_digest_corrupt");
    return value;
  }

  listPendingIntents(input: Parameters<WorkflowIsolationStore["listPendingIntents"]>[0] = {}): readonly WorkflowIsolationIntent[] {
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("workflow_isolation.query_limit_invalid");
    return this.context.database.prepare(`SELECT intent.intent_id FROM workflow_isolation_intents AS intent
      JOIN workflow_isolation_bindings AS binding ON binding.binding_id=intent.writer_binding_id
      JOIN workflow_isolation_scope_plans AS plan ON plan.plan_id=binding.plan_id
      WHERE intent.status<>'confirmed' AND (? IS NULL OR plan.round_id=?) AND (? IS NULL OR intent.writer_binding_id=?)
      ORDER BY intent.created_at,intent.intent_id LIMIT ?`).all(input.roundId ?? null, input.roundId ?? null,
        input.bindingId ?? null, input.bindingId ?? null, limit).map(row => this.getIntent(String(row.intent_id))!);
  }

  private validateRoundInputs(inputs: WorkflowIntegrationRoundInputsV1): void {
    const workflow = this.ports.getChannelWorkflow(inputs.workflowId), channel = workflow && this.ports.getChannel(workflow.channelId);
    if (!workflow || !channel || workflow.workspaceId !== inputs.canonicalWorkspaceId || channel.workspaceId !== inputs.canonicalWorkspaceId
      || inputs.canonicalWorkspaceRoot !== this.canonicalWorkspaceRoot || !["ready", "running", "waiting_for_approval", "blocked"].includes(workflow.status)
      || workflow.metadata?.workflowGraphFingerprint !== inputs.graphFingerprint) veto("stale", "round_workflow_changed");
    if (inputs.parallelExecution && (channel.runtimePolicy.writeLockScope !== "boundPath"
      || channel.boundPath !== inputs.canonicalWorkspaceRoot)) veto("stale", "parallel_channel_policy_changed");
    for (const participant of inputs.participants) {
      const step = this.ports.getChannelWorkflowStep(participant.workflowStepId);
      if (!step || step.workflowId !== workflow.id || step.workspaceId !== inputs.canonicalWorkspaceId || step.channelId !== channel.id
        || step.position !== participant.position || workflowIsolationStepSafetyFingerprint(step)
          !== inputs.safetyPins.find(pin => pin.workflowStepId === step.id)?.fingerprint) veto("stale", "round_participant_changed");
    }
  }

  private validateLineage(binding: WorkflowIsolationExecutionBinding, plan: WorkflowIsolationScopePlanV1, now: string, currentGeneration: boolean): void {
    const step = this.ports.getChannelWorkflowStep(plan.workflowStepId), workflow = this.ports.getChannelWorkflow(plan.workflowId);
    const task = this.ports.getTask(binding.startOwner.taskId), run = this.ports.getRun(binding.runId);
    const unit = this.ports.getWorkUnit(binding.fence.workUnitId), attempt = this.ports.getWorkUnitAttempt(binding.fence.attemptId);
    const row = this.planRow(plan.planId), round = this.getIntegrationRound(plan.integrationRoundId);
    if (!step || !workflow || !task || !run || !unit || !attempt || !row || !round
      || currentGeneration && round.generation !== plan.generation || step.workflowId !== plan.workflowId
      || step.workspaceId !== plan.canonicalWorkspaceId || workflow.workspaceId !== plan.canonicalWorkspaceId
      || !["running", "waiting_for_approval", "blocked"].includes(workflow.status)
      || !["running", "waiting_for_approval", "succeeded", "failed", "blocked"].includes(step.status)
      || !same(step.metadata?.isolationScopePlan ?? null, { planId: plan.planId, planDigest: plan.planDigest })
      || !workflowStepStartOwnerMatches(step.metadata?.startOwner, binding.startOwner) || step.taskId !== task.id
      || row.authority_basis !== binding.startOwner.authorityBasis || workflowStepStartAuthorityBasis(this.ports, step) !== row.authority_basis
      || workflow.metadata?.workflowGraphFingerprint !== plan.graphFingerprint
      || workflowIsolationStepSafetyFingerprint(step) !== plan.safetyFingerprint) veto("stale", "start_owner_changed");
    const owner = step.metadata!.startOwner!;
    if (owner.phase === "linked" ? step.runId !== run.id || task.currentRunId !== run.id
      : step.runId !== undefined || task.currentRunId !== undefined) veto("stale", "start_phase_changed");
    if (task.channelId !== step.channelId || task.assigneeTeammateId !== step.toParticipantId || run.taskId !== task.id
      || run.workflowStepId !== step.id || run.channelId !== step.channelId || run.teammateId !== step.toParticipantId
      || run.workUnitId !== unit.id || run.cwd !== plan.executionRoot || unit.workspaceId !== plan.canonicalWorkspaceId
      || unit.kind !== "task_run" || unit.ownerType !== "task" || unit.ownerId !== task.id || unit.taskId !== task.id
      || unit.channelId !== step.channelId || unit.teammateId !== step.toParticipantId || unit.linkedRunId !== run.id
      || unit.activeAttemptId !== attempt.id || attempt.workUnitId !== unit.id || attempt.runtimeInstanceId !== binding.fence.runtimeInstanceId
      || attempt.fencingToken !== binding.fence.fencingToken || attempt.status === "lost" || attempt.abortRequestedAt
      || !plan.resourcePlan.entries.some(entry => entry.resourceType === "runner" && entry.resourceKey === attempt.effectiveRunnerId)) veto("stale", "execution_fence_changed");
    const lease = this.context.database.prepare(`SELECT 1 FROM resource_leases WHERE id=? AND workspace_id=?
      AND resource_type='workflow_step' AND resource_key=? AND owner_type='workflow_step' AND owner_id=? AND status='active' AND expires_at>?`)
      .get(owner.leaseId, plan.canonicalWorkspaceId, step.id, step.id, now);
    if (!lease) veto("stale", "start_lease_changed");
    const snapshot = run.requestSnapshot;
    if (record(snapshot) && snapshot.workflowIsolationPlan !== undefined
      && !same(snapshot.workflowIsolationPlan, { planId: plan.planId, planDigest: plan.planDigest })) veto("invalid", "run_plan_pin_mismatch");
    const admission = this.ports.getChannelWorkflowStepStartAdmission(step.id, owner);
    if (!admission || admission.status === "released" || !same(admission.plan, plan.resourcePlan)
      || admission.status === "transferred" && (admission.runId !== run.id || !admission.fence || !sameFence(admission.fence, binding.fence))) veto("stale", "admission_plan_changed");
    if (!workflowParallelAttemptAllowed(this.context.database, this.ports, plan.canonicalWorkspaceId, binding.fence)) veto("stale", "parallel_parent_changed");
  }

  private currentWriter(writer: WorkflowIsolationWriter, now: string, requireReady: boolean, currentGeneration = true):
    { binding: WorkflowIsolationExecutionBinding; plan: WorkflowIsolationScopePlanV1 } {
    this.validateTime(now);
    if (!writer || !identity(writer.bindingId) || !validFence(writer)) veto("invalid", "writer_invalid");
    const binding = this.getExecutionBinding(writer.bindingId), plan = binding && this.getScopePlan(binding.planId);
    if (!binding || !plan || !sameFence(binding.fence, writer)) veto("stale", "writer_fence_changed");
    this.validateLineage(binding, plan, now, currentGeneration);
    if (binding.status === "blocked" || requireReady && (binding.status !== "ready" || binding.openIntentId)) veto("stale", "execution_not_ready");
    if (requireReady) {
      const admission = this.ports.getChannelWorkflowStepStartAdmission(plan.workflowStepId, binding.startOwner);
      if (!admission || admission.status !== "transferred" || admission.runId !== binding.runId
        || !admission.fence || !sameFence(admission.fence, binding.fence)) veto("stale", "admission_not_transferred");
      const slots = this.context.database.prepare(`SELECT slot.*,entry.resource_type AS planned_resource_type,entry.resource_key AS planned_resource_key
        FROM workflow_step_admission_entries AS entry
        JOIN runtime_semaphore_slots AS slot ON slot.id=entry.slot_id WHERE entry.task_id=?`).all(binding.startOwner.taskId);
      if (slots.length !== plan.resourcePlan.entries.length + plan.resourcePlan.resourceKeys.length
        || slots.some(slot => slot.status !== "active" || slot.workspace_id !== plan.canonicalWorkspaceId
          || slot.resource_type !== slot.planned_resource_type || slot.resource_key !== slot.planned_resource_key
          || slot.owner_type !== "work_unit_attempt" || slot.owner_id !== binding.fence.attemptId
          || slot.work_unit_id !== binding.fence.workUnitId || slot.attempt_id !== binding.fence.attemptId
          || slot.runtime_instance_id !== binding.fence.runtimeInstanceId || slot.fencing_token !== binding.fence.fencingToken)) veto("stale", "admission_slots_changed");
    }
    return { binding, plan };
  }

  private currentRound(roundId: string, generation: number, plan: WorkflowIsolationScopePlanV1, writer: WorkflowIsolationWriter): WorkflowIntegrationRound {
    const round = this.getIntegrationRound(roundId);
    if (!round || round.generation !== generation || plan.integrationRoundId !== roundId || plan.generation !== generation
      || round.writerBindingId && round.writerBindingId !== writer.bindingId) veto("stale", "round_writer_changed");
    return round;
  }

  private journalScope(scope: WorkflowIsolationJournalScope, binding: WorkflowIsolationExecutionBinding,
    plan: WorkflowIsolationScopePlanV1, writer: WorkflowIsolationWriter): WorkflowIsolationExecutionBinding | WorkflowIntegrationRound {
    if (scope?.type === "binding" && scope.bindingId === binding.bindingId) return binding;
    if (scope?.type === "round") return this.currentRound(scope.roundId, scope.generation, plan, writer);
    return veto("invalid", "journal_scope_mismatch");
  }

  private validateEffect(input: RecordWorkflowIsolationIntentInput, before: WorkflowIsolationGitIdentity, after: WorkflowIsolationGitIdentity,
    binding: WorkflowIsolationExecutionBinding, plan: WorkflowIsolationScopePlanV1, scope: WorkflowIsolationExecutionBinding | WorkflowIntegrationRound): void {
    const round = "roundId" in scope ? scope : undefined;
    const location = round ? round.inputs.integration : binding.location;
    if (!sameLocation(before, location) || !sameLocation(after, location) || before.commonDir !== plan.repositoryIdentity.commonDir
      || after.commonDir !== before.commonDir || !after.exists || !this.gitFormatMatches(before, plan) || !this.gitFormatMatches(after, plan)) veto("invalid", "effect_location_mismatch");
    const creating = input.kind === "worktree_create" || input.kind === "integration_create";
    if (round ? !["integration_create", "integrate_branch", "candidate_verify"].includes(input.kind)
      : !["worktree_create", "branch_capture"].includes(input.kind)) veto("invalid", "effect_scope_kind_mismatch");
    if (creating) {
      if (before.exists || before.headCommit !== null || after.headCommit !== plan.baseCommit
        || round && round.phase !== "collecting" || !round && binding.status !== "planned"
        || this.latestConfirmed(input.scope)) veto("invalid", "creation_identity_mismatch");
    } else {
      const previous = this.latestConfirmed(input.scope);
      if (!before.exists || !previous || !same(previous.observed, before)) veto("stale", "effect_before_changed");
      if (round && (input.kind === "integrate_branch" ? round.phase !== "integrating" : round.phase !== "verifying")) veto("stale", "effect_phase_changed");
      if (input.kind === "candidate_verify" && !same(before, after)) veto("invalid", "verification_changes_identity");
    }
  }

  private latestConfirmed(scope: WorkflowIsolationJournalScope): WorkflowIsolationReceipt | undefined {
    const row = scope.type === "binding"
      ? this.context.database.prepare(`SELECT receipt.receipt_id FROM workflow_isolation_receipts AS receipt
        JOIN workflow_isolation_intents AS intent ON intent.intent_id=receipt.intent_id WHERE intent.scope_binding_id=? AND receipt.outcome='confirmed'
        ORDER BY receipt.scope_revision DESC LIMIT 1`).get(scope.bindingId)
      : this.context.database.prepare(`SELECT receipt.receipt_id FROM workflow_isolation_receipts AS receipt
        JOIN workflow_isolation_intents AS intent ON intent.intent_id=receipt.intent_id WHERE intent.round_id=? AND intent.generation=? AND receipt.outcome='confirmed'
        ORDER BY receipt.scope_revision DESC LIMIT 1`).get(scope.roundId, scope.generation);
    return row ? this.getReceipt(String(row.receipt_id)) : undefined;
  }

  private gitFormatMatches(value: WorkflowIsolationGitIdentity, plan: WorkflowIsolationScopePlanV1): boolean {
    const length = plan.repositoryIdentity.objectFormat === "sha1" ? 40 : 64;
    return (value.headCommit === null || value.headCommit.length === length) && (value.tree === undefined || value.tree.length === length);
  }

  private updateScope(scope: WorkflowIsolationJournalScope, expectedRevision: number, openIntentId: string | null, writer: WorkflowIsolationWriter, now: string): void {
    const change = scope.type === "binding"
      ? this.context.database.prepare(`UPDATE workflow_isolation_bindings SET open_intent_id=?,revision=revision+1,updated_at=?
          WHERE binding_id=? AND revision=?`).run(openIntentId, now, scope.bindingId, expectedRevision)
      : this.context.database.prepare(`UPDATE workflow_integration_generations SET open_intent_id=?,writer_binding_id=COALESCE(writer_binding_id,?),
          revision=revision+1,updated_at=? WHERE round_id=? AND generation=? AND revision=? AND (writer_binding_id IS NULL OR writer_binding_id=?)`)
        .run(openIntentId, writer.bindingId, now, scope.roundId, scope.generation, expectedRevision, writer.bindingId);
    this.changed(change);
  }

  private roundReceipts(round: WorkflowIntegrationRound, receiptIds: readonly string[]): WorkflowIsolationReceipt[] {
    if (!Array.isArray(receiptIds) || receiptIds.length > 128 || new Set(receiptIds).size !== receiptIds.length) veto("invalid", "round_receipts_invalid");
    return receiptIds.map(id => {
      const receipt = this.getReceipt(id), intent = receipt && this.getIntent(receipt.intentId);
      if (!receipt || receipt.outcome !== "confirmed" || !intent || intent.status !== "confirmed" || intent.scope.type !== "round"
        || intent.scope.roundId !== round.roundId || intent.scope.generation !== round.generation) veto("invalid", "round_receipt_mismatch");
      return receipt;
    });
  }

  private hasPendingRound(roundId: string, generation: number): boolean {
    return !!this.context.database.prepare(`SELECT 1 FROM workflow_isolation_intents AS intent
      JOIN workflow_isolation_bindings AS binding ON binding.binding_id=intent.writer_binding_id
      JOIN workflow_isolation_scope_plans AS plan ON plan.plan_id=binding.plan_id
      WHERE plan.round_id=? AND plan.generation=? AND intent.status<>'confirmed' LIMIT 1`).get(roundId, generation);
  }

  private assertLocationAvailable(location: WorkflowIsolationLocation, commonDir: string): void {
    const locations = this.context.database.prepare("SELECT execution_root,worktree_id,branch_ref,common_dir FROM workflow_isolation_scope_plans").all();
    for (const row of this.context.database.prepare("SELECT inputs_json FROM workflow_integration_generations").all()) {
      const inputs = normalizeWorkflowIntegrationRoundInputs(JSON.parse(String(row.inputs_json)));
      if (!inputs) throw new Error("workflow_isolation.round_corrupt");
      locations.push({ execution_root: inputs.integration.executionRoot, worktree_id: inputs.integration.worktreeId,
        branch_ref: inputs.integration.branchRef, common_dir: inputs.repositoryIdentity.commonDir });
    }
    if (locations.some(other => overlaps(String(other.execution_root), location.executionRoot) || other.worktree_id === location.worktreeId
      || other.common_dir === commonDir && other.branch_ref === location.branchRef)) veto("conflict", "location_retained");
  }

  private insertGeneration(roundId: string, generation: number, inputs: WorkflowIntegrationRoundInputsV1, now: string): void {
    this.context.database.prepare(`INSERT INTO workflow_integration_generations(round_id,generation,revision,inputs_json,inputs_digest,
      phase,last_confirmed_phase,created_at,updated_at) VALUES (?,?,0,?,?,'preparing','preparing',?,?)`)
      .run(roundId, generation, json(inputs), workflowIntegrationRoundInputsDigest(inputs), now, now);
  }
  private planRow(planId: string): Row | undefined {
    return this.context.database.prepare("SELECT * FROM workflow_isolation_scope_plans WHERE plan_id=?").get(planId);
  }
  private validateTime(now: string): void { if (!time(now)) veto("invalid", "time_invalid"); }
  private expectRevision(actual: number, expected: number): void {
    if (!revision(expected)) veto("invalid", "revision_invalid");
    if (actual !== expected) veto("stale", "revision_changed");
  }
  private changed(result: { readonly changes: number | bigint }): void {
    if (Number(result.changes) !== 1) veto("stale", "cas_changed");
  }
  private intentPayload(input: Pick<RecordWorkflowIsolationIntentInput, "intentId" | "commandId" | "scope" | "expectedRevision" | "writer" | "kind" | "before" | "after">): unknown {
    return { intentId: input.intentId, commandId: input.commandId, scope: input.scope, expectedRevision: input.expectedRevision,
      writer: input.writer, kind: input.kind, before: normalizeWorkflowIsolationGitIdentity(input.before), after: normalizeWorkflowIsolationGitIdentity(input.after) };
  }
  private receiptPayload(input: Omit<RecordWorkflowIsolationReceiptInput, "now">): unknown {
    return { receiptId: input.receiptId, intentId: input.intentId, expectedRevision: input.expectedRevision,
      writer: input.writer, outcome: input.outcome, observed: normalizeWorkflowIsolationGitIdentity(input.observed), artifactId: input.artifactId };
  }
  private commandPayload(input: unknown): string {
    if (!record(input)) veto("invalid", "command_invalid");
    const { now: _now, ...payload } = input;
    return digest(payload);
  }
  private command<T>(kind: string, commandId: string, input: unknown, writer: WorkflowIsolationWriter): T | undefined {
    if (!identity(commandId)) veto("invalid", "command_identity_invalid");
    const row = this.context.database.prepare("SELECT * FROM workflow_isolation_commands WHERE command_kind=? AND command_id=?").get(kind, commandId);
    if (!row) return undefined;
    if (row.payload_digest !== this.commandPayload(input) || row.writer_binding_id !== writer.bindingId) veto("conflict", "command_id_reused");
    return JSON.parse(String(row.result_json)) as T;
  }
  private saveCommand(kind: string, commandId: string, input: unknown, writer: WorkflowIsolationWriter, value: unknown, now: string): void {
    this.context.database.prepare(`INSERT INTO workflow_isolation_commands(command_kind,command_id,payload_digest,writer_binding_id,result_json,created_at)
      VALUES (?,?,?,?,?,?)`).run(kind, commandId, this.commandPayload(input), writer.bindingId, json(value), now);
  }
  private transaction<T>(operation: () => WorkflowIsolationMutationResult<T>): WorkflowIsolationMutationResult<T> {
    // BEGIN stays outside try: a nested caller transaction is never adopted or rolled back.
    this.context.database.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.context.database.exec("COMMIT"); return result; }
    catch (error) { rollbackOwnedSqliteTransaction(this.context.database); if (error instanceof Veto) return error.result; throw error; }
  }
}

function sameLocation(a: WorkflowIsolationLocation, b: WorkflowIsolationLocation): boolean {
  return a.executionRoot === b.executionRoot && a.worktreeId === b.worktreeId && a.branchRef === b.branchRef;
}
