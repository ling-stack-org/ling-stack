import type { DatabaseSync } from "node:sqlite";
import type { RunStore } from "../../run-types.js";
import type { CreateResourceLeaseInput } from "../../channel-runtime-types.js";
import type { AcquireRuntimeSemaphoreSlotInput, RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import type { ChannelWorkflowStep } from "../../workspace-types.js";
import type { WorkflowIntegrationRoundInputsV1, WorkflowIsolationScopePlanV1 } from "../../workflow-isolation-types.js";
import type { WorkflowStepAdmissionPlan } from "../../workflow-step-admission.js";
import { isWorkflowStepSafetyPlanV1 } from "../../workflow-safety-plan.js";
import { isWorkflowStepStartOwnerV1, workflowStepStartAuthorityBasis, workflowStepStartOwnerMatches,
  type WorkflowStepStartReadStore } from "../../workflow-step-start-owner.js";
import { normalizeWorkflowIntegrationRoundInputs, normalizeWorkflowIsolationScopePlan,
  workflowIntegrationRoundInputsDigest, workflowIsolationCanonicalJson as json, workflowIsolationRecord as record,
  workflowIsolationTime as time, workflowIsolationStepSafetyFingerprint, workflowIsolationPathsOverlap } from "../../workflow-isolation.js";

export type WorkflowParallelReadPorts = WorkflowStepStartReadStore & Pick<RunStore, "getWorkUnit" | "getWorkUnitAttempt">;
export interface WorkflowParallelParent {
  readonly roundId: string;
  readonly generation: number;
  readonly workspaceId: string;
  readonly commonDir: string;
  readonly state: "held" | "released";
  readonly inputs: WorkflowIntegrationRoundInputsV1;
}
const table = "workflow_parallel_parent_fences";
const same = (a: unknown, b: unknown) => json(a) === json(b);
const positive = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 1;

/** Feature detection supports real predecessor migration tests; a damaged installed overlay fails closed. */
export function readWorkflowParallelParents(database: DatabaseSync): readonly WorkflowParallelParent[] {
  const object = database.prepare("SELECT type FROM sqlite_master WHERE name=?").get(table);
  if (!object) {
    if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()
      && database.prepare("SELECT 1 FROM schema_migrations WHERE version=210").get()) throw new Error("workflow_parallel.parent_schema_missing");
    return [];
  }
  if (object.type !== "table") throw new Error("workflow_parallel.parent_schema_invalid");
  return database.prepare(`SELECT parent.*,generation.inputs_json,generation.inputs_digest AS actual_digest,round.current_generation
    FROM workflow_parallel_parent_fences parent LEFT JOIN workflow_integration_generations generation
    ON generation.round_id=parent.round_id AND generation.generation=parent.generation
    LEFT JOIN workflow_integration_rounds round ON round.round_id=parent.round_id`).all().map(row => {
    const inputs = normalizeWorkflowIntegrationRoundInputs(JSON.parse(String(row.inputs_json)));
    if (!inputs?.parallelExecution || workflowIntegrationRoundInputsDigest(inputs) !== row.inputs_digest
      || row.actual_digest !== row.inputs_digest || inputs.canonicalWorkspaceId !== row.workspace_id
      || inputs.repositoryIdentity.commonDir !== row.common_dir || !time(row.created_at)
      || row.state !== "held" && row.state !== "released"
      || row.state === "held" && (row.released_at !== null || row.current_generation !== row.generation)
      || row.state === "released" && (!time(row.released_at) || row.released_at < row.created_at))
      throw new Error("workflow_parallel.parent_evidence_invalid");
    return { roundId: String(row.round_id), generation: Number(row.generation), workspaceId: String(row.workspace_id),
      commonDir: String(row.common_dir), state: row.state, inputs };
  });
}

/** Caller owns BEGIN IMMEDIATE, including both this check and generation/fence insertion. */
export function workflowParallelRoundAvailable(database: DatabaseSync, inputs: WorkflowIntegrationRoundInputsV1): boolean {
  if (readWorkflowParallelParents(database).some(parent => parent.state === "held"
    && (parent.workspaceId === inputs.canonicalWorkspaceId || parent.commonDir === inputs.repositoryIdentity.commonDir))) return false;
  if (!inputs.parallelExecution) return true;
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return false;
  return !workflowParallelWorkspaceResourcesActive(database, inputs.canonicalWorkspaceId);
}

export function workflowParallelWorkspaceResourcesActive(database: DatabaseSync, workspaceId: string, allLeases = false): boolean {
  if (database.prepare(`SELECT 1 FROM resource_leases WHERE workspace_id=? AND status='active'
    ${allLeases ? "" : "AND resource_type IN ('workspace','channel','bound_path')"} LIMIT 1`).get(workspaceId)
    || database.prepare("SELECT 1 FROM runtime_semaphore_slots WHERE workspace_id=? AND status='active' LIMIT 1").get(workspaceId)) return true;
  return !!database.prepare(`SELECT 1 FROM workflow_step_admissions admission WHERE workspace_id=? AND
    (status='preparing' OR status='transferred' AND (run_id IS NULL OR EXISTS (
      SELECT 1 FROM workflow_step_admission_entries entry LEFT JOIN runtime_semaphore_slots slot ON slot.id=entry.slot_id
      WHERE entry.task_id=admission.task_id AND (slot.id IS NULL OR slot.status='active'))
      OR EXISTS (SELECT 1 FROM run_sessions run WHERE run.id=admission.run_id
        AND run.status NOT IN ('succeeded','failed','cancelled')))) LIMIT 1`).get(workspaceId);
}

/** New-mode inventory is exact. Existing serial plans intentionally keep their original contract. */
export function workflowParallelScopeValid(ports: WorkflowParallelReadPorts, inputs: WorkflowIntegrationRoundInputsV1,
  plan: WorkflowIsolationScopePlanV1): boolean {
  const policy = inputs.parallelExecution, step = ports.getChannelWorkflowStep(plan.workflowStepId);
  const workflow = step && ports.getChannelWorkflow(step.workflowId), channel = step && ports.getChannel(step.channelId);
  const safety = step?.metadata?.safetyPlan;
  if (!policy || !step || !workflow || !channel || !isWorkflowStepSafetyPlanV1(safety)
    || safety.profile !== "pi_host_isolated_files_v1" || safety.safety.parallelPolicy?.autoParallel !== true
    || step.metadata?.sideEffectClass !== "workspace_write" || step.metadata.parallelPolicy?.autoParallel !== true
    || safety.workflowId !== plan.workflowId || safety.workflowStepId !== step.id || safety.runnerId !== "pi"
    || safety.workspaceRoot !== plan.canonicalWorkspaceRoot || safety.executionRoot !== plan.executionRoot
    || channel.runtimePolicy.writeLockScope !== policy.writeLockScope || channel.boundPath !== plan.canonicalWorkspaceRoot
    || workflow.id !== inputs.workflowId || step.workflowId !== inputs.workflowId || workflow.channelId !== channel.id
    || step.workspaceId !== inputs.canonicalWorkspaceId || workflow.workspaceId !== inputs.canonicalWorkspaceId
    || channel.workspaceId !== inputs.canonicalWorkspaceId || plan.canonicalWorkspaceId !== inputs.canonicalWorkspaceId
    || plan.canonicalWorkspaceRoot !== inputs.canonicalWorkspaceRoot || !same(plan.repositoryIdentity, inputs.repositoryIdentity)
    || !same(plan.target, inputs.target) || plan.baseCommit !== inputs.baseCommit || !same(plan.templatePins, inputs.templatePins)
    || plan.graphFingerprint !== inputs.graphFingerprint || workflow.metadata?.workflowGraphFingerprint !== inputs.graphFingerprint
    || !inputs.participants.some(p => p.workflowStepId === step.id && p.position === step.position)
    || inputs.safetyPins.find(pin => pin.workflowStepId === step.id)?.fingerprint !== plan.safetyFingerprint
    || workflowIsolationStepSafetyFingerprint(step) !== plan.safetyFingerprint
    || workflowIsolationPathsOverlap(inputs.integration.executionRoot, plan.executionRoot)) return false;
  const limit = Math.min(policy.maxConcurrentSteps, positive(channel.runtimePolicy.maxConcurrentRuns),
    positive(workflow.metadata?.maxParallelSteps ?? channel.runtimePolicy.maxConcurrentRuns),
    positive(safety.safety.parallelPolicy?.maxParallelSiblings),
    positive(step.metadata.maxParallelSiblings ?? safety.safety.parallelPolicy?.maxParallelSiblings));
  const expected = [
    { resourceType: "channel_parallel", resourceKey: channel.id, limit },
    { resourceType: "channel_parallel", resourceKey: `workflow:${workflow.id}`, limit },
    { resourceType: "channel_parallel", resourceKey: `workspace:${plan.canonicalWorkspaceRoot}`, limit },
  ];
  const entries = plan.resourcePlan.entries;
  const keys = [...new Set([...(safety.safety.parallelPolicy?.resourceKeys ?? []), `worktree:${plan.executionRoot}`])].sort();
  return entries.length === 5 && expected.every(entry => entries.some(actual => same(actual, entry)))
    && entries.filter(entry => entry.resourceType === "provider" && entry.limit === 4).length === 1
    && entries.filter(entry => entry.resourceType === "runner" && entry.resourceKey === "pi" && entry.limit === 4).length === 1
    && same([...plan.resourcePlan.resourceKeys].sort(), keys);
}

function parallelRequired(database: DatabaseSync, stepId: string): boolean {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_isolation_scope_plans'").get()) return false;
  return !!database.prepare(`SELECT 1 FROM workflow_isolation_scope_plans plan JOIN workflow_integration_generations generation
    ON generation.round_id=plan.round_id AND generation.generation=plan.generation WHERE plan.workflow_step_id=?
    AND (json_valid(generation.inputs_json) IS NOT 1 OR json_type(generation.inputs_json,'$.parallelExecution') IS NOT NULL) LIMIT 1`).get(stepId);
}

function readMemberScope(database: DatabaseSync, ports: WorkflowParallelReadPorts, step: ChannelWorkflowStep):
  { readonly plan: WorkflowIsolationScopePlanV1; readonly authorityBasis: string } | undefined {
  const pin = step.metadata?.isolationScopePlan;
  if (!pin) return undefined;
  const row = database.prepare("SELECT * FROM workflow_isolation_scope_plans WHERE plan_id=?").get(pin.planId);
  const plan = row && normalizeWorkflowIsolationScopePlan(JSON.parse(String(row.plan_json)));
  if (!plan || plan.planId !== row!.plan_id || plan.planDigest !== row!.plan_digest || pin.planDigest !== plan.planDigest
    || plan.workflowId !== row!.workflow_id || plan.workflowStepId !== row!.workflow_step_id
    || plan.canonicalWorkspaceId !== row!.canonical_workspace_id || plan.integrationRoundId !== row!.round_id
    || plan.generation !== row!.generation || plan.stepGeneration !== row!.step_generation
    || plan.executionRoot !== row!.execution_root || plan.worktreeId !== row!.worktree_id
    || plan.branchRef !== row!.branch_ref || plan.repositoryIdentity.commonDir !== row!.common_dir) return undefined;
  const parent = readWorkflowParallelParents(database).find(parent => parent.state === "held"
    && parent.roundId === plan.integrationRoundId && parent.generation === plan.generation);
  if (!parent || parent.workspaceId !== step.workspaceId || !workflowParallelScopeValid(ports, parent.inputs, plan)
    || workflowStepStartAuthorityBasis(ports, step) !== row!.authority_basis) return undefined;
  return { plan, authorityBasis: String(row!.authority_basis) };
}

export function workflowParallelAdmissionAllowed(database: DatabaseSync, ports: WorkflowParallelReadPorts,
  step: ChannelWorkflowStep, admission: WorkflowStepAdmissionPlan | undefined): boolean {
  const held = readWorkflowParallelParents(database).filter(parent => parent.state === "held" && parent.workspaceId === step.workspaceId);
  if (!held.length && !parallelRequired(database, step.id)) return true;
  const member = readMemberScope(database, ports, step);
  return !!member && !!admission && same(member.plan.resourcePlan, admission);
}

function attemptMember(database: DatabaseSync, ports: WorkflowParallelReadPorts, workspaceId: string, fence: RuntimeAttemptFenceV1):
  { readonly plan: WorkflowIsolationScopePlanV1; readonly taskId: string; readonly runId: string;
    readonly status: "preparing" | "transferred" } | undefined {
  const unit = ports.getWorkUnit(fence.workUnitId), attempt = ports.getWorkUnitAttempt(fence.attemptId);
  const run = unit?.linkedRunId ? ports.getRun(unit.linkedRunId) : undefined;
  const step = run?.workflowStepId ? ports.getChannelWorkflowStep(run.workflowStepId) : undefined;
  const member = step && readMemberScope(database, ports, step), owner = step?.metadata?.startOwner;
  const task = run?.taskId ? ports.getTask(run.taskId) : undefined;
  if (!unit || !attempt || !run || !step || !member || !task || !isWorkflowStepStartOwnerV1(owner)
    || unit.workspaceId !== workspaceId || unit.activeAttemptId !== attempt.id || attempt.workUnitId !== unit.id
    || attempt.runtimeInstanceId !== fence.runtimeInstanceId || attempt.fencingToken !== fence.fencingToken || attempt.abortRequestedAt
    || !["created", "started", "waiting_for_approval"].includes(attempt.status) || !["queued", "running", "waiting_for_approval"].includes(run.status)
    || !["running", "waiting_for_approval", "blocked"].includes(ports.getChannelWorkflow(step.workflowId)?.status ?? "")
    || step.status !== "running" || step.taskId !== task.id || owner.taskId !== task.id || owner.authorityBasis !== member.authorityBasis
    || task.channelId !== step.channelId || task.assigneeTeammateId !== step.toParticipantId
    || run.workUnitId !== unit.id || run.channelId !== step.channelId || run.teammateId !== step.toParticipantId
    || run.cwd !== member.plan.executionRoot || unit.kind !== "task_run" || unit.ownerType !== "task" || unit.ownerId !== task.id
    || unit.taskId !== task.id || unit.channelId !== step.channelId || unit.teammateId !== step.toParticipantId
    || attempt.effectiveRunnerId !== "pi" || !record(run.requestSnapshot)
    || !same(run.requestSnapshot.workflowIsolationPlan, { planId: member.plan.planId, planDigest: member.plan.planDigest })
    || (owner.phase === "linked" ? step.runId !== run.id || task.currentRunId !== run.id : !!step.runId || !!task.currentRunId)) return undefined;
  const row = database.prepare(`SELECT * FROM workflow_step_admissions WHERE task_id=? AND workspace_id=? AND workflow_id=?
    AND workflow_step_id=? AND lease_id=? AND authority_basis=?`).get(task.id, workspaceId, step.workflowId, step.id, owner.leaseId, owner.authorityBasis);
  if (!row || row.status !== "preparing" && row.status !== "transferred" || !same(JSON.parse(String(row.plan_json)), member.plan.resourcePlan)
    || row.status === "transferred" && (row.run_id !== run.id || row.work_unit_id !== fence.workUnitId
      || row.attempt_id !== fence.attemptId || row.runtime_instance_id !== fence.runtimeInstanceId || row.fencing_token !== fence.fencingToken)) return undefined;
  const entries = database.prepare("SELECT resource_type,resource_key,capacity_limit FROM workflow_step_admission_entries WHERE task_id=?").all(task.id);
  const expected = [...member.plan.resourcePlan.entries, ...member.plan.resourcePlan.resourceKeys.map(resourceKey =>
    ({ resourceType: "workflow_resource", resourceKey, limit: 1 }))];
  if (entries.length !== expected.length || expected.some(entry => !entries.some(actual => actual.resource_type === entry.resourceType
    && actual.resource_key === entry.resourceKey && actual.capacity_limit === entry.limit))) return undefined;
  return { plan: member.plan, taskId: task.id, runId: run.id, status: row.status };
}

export function workflowParallelAttemptAllowed(database: DatabaseSync, ports: WorkflowParallelReadPorts | undefined,
  workspaceId: string, fence: RuntimeAttemptFenceV1): boolean {
  if (!ports) return !readWorkflowParallelParents(database).some(parent => parent.state === "held" && parent.workspaceId === workspaceId)
    && !hasParallelScopes(database, workspaceId);
  const runId = ports.getWorkUnit(fence.workUnitId)?.linkedRunId, run = runId && ports.getRun(runId);
  if (!readWorkflowParallelParents(database).some(parent => parent.state === "held" && parent.workspaceId === workspaceId)
    && (!run || !run.workflowStepId || !parallelRequired(database, run.workflowStepId))) return true;
  return !!attemptMember(database, ports, workspaceId, fence);
}

/** No generic runtime call may mint extra or unplanned slots under the shared parent. */
export function workflowParallelSlotAllowed(database: DatabaseSync, ports: WorkflowParallelReadPorts | undefined,
  input: AcquireRuntimeSemaphoreSlotInput, preparingTaskId?: string): boolean {
  if (!ports) return workflowParallelAttemptAllowed(database, ports, input.workspaceId, input);
  if (!workflowParallelAttemptAllowed(database, ports, input.workspaceId, input)) return false;
  const member = attemptMember(database, ports, input.workspaceId, input);
  if (!member) return true;
  if (input.ownerType !== "work_unit_attempt" || input.ownerId !== input.attemptId) return false;
  const entry = database.prepare(`SELECT capacity_limit,slot_id FROM workflow_step_admission_entries
    WHERE task_id=? AND resource_type=? AND resource_key=?`).get(member.taskId, input.resourceType, input.resourceKey);
  if (!entry || entry.capacity_limit !== input.limit) return false;
  if (member.status === "preparing") return preparingTaskId === member.taskId && entry.slot_id === null;
  const slot = database.prepare(`SELECT 1 FROM runtime_semaphore_slots WHERE id=? AND status='active' AND workspace_id=?
    AND work_unit_id=? AND attempt_id=? AND runtime_instance_id=? AND fencing_token=? AND owner_type='work_unit_attempt'
    AND owner_id=? AND resource_type=? AND resource_key=?`).get(entry.slot_id!, input.workspaceId, input.workUnitId,
      input.attemptId, input.runtimeInstanceId, input.fencingToken, input.attemptId, input.resourceType, input.resourceKey);
  return !!slot;
}

function hasParallelScopes(database: DatabaseSync, workspaceId: string): boolean {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_isolation_scope_plans'").get()) return false;
  return !!database.prepare(`SELECT 1 FROM workflow_isolation_scope_plans plan JOIN workflow_integration_generations generation
    ON generation.round_id=plan.round_id AND generation.generation=plan.generation WHERE plan.canonical_workspace_id=?
    AND (json_valid(generation.inputs_json) IS NOT 1 OR json_type(generation.inputs_json,'$.parallelExecution') IS NOT NULL) LIMIT 1`).get(workspaceId);
}

/** The original Host acquires the task lease before persisting its Run or creating a binding. */
function preparingLeaseMember(database: DatabaseSync, ports: WorkflowParallelReadPorts,
  input: CreateResourceLeaseInput, fence: RuntimeAttemptFenceV1): boolean {
  if (input.ownerType !== "run" || input.resourceType !== "bound_path" || ports.getRun(input.ownerId)) return false;
  const unit = ports.getWorkUnit(fence.workUnitId), attempt = ports.getWorkUnitAttempt(fence.attemptId);
  const request = unit?.request;
  if (!unit || !attempt || !record(request) || typeof request.workflowStepId !== "string" || !record(request.task)) return false;
  const step = ports.getChannelWorkflowStep(request.workflowStepId), task = unit.taskId && ports.getTask(unit.taskId);
  const member = step && readMemberScope(database, ports, step), owner = step?.metadata?.startOwner;
  if (!step || !task || !member || !isWorkflowStepStartOwnerV1(owner) || owner.phase !== "preparing"
    || !isWorkflowStepStartOwnerV1(request.workflowStartOwner)
    || !workflowStepStartOwnerMatches(request.workflowStartOwner, owner)
    || !same(request.workflowIsolationPlan, { planId: member.plan.planId, planDigest: member.plan.planDigest })
    || unit.workspaceId !== input.workspaceId || unit.linkedRunId || !["queued", "claimed"].includes(unit.status)
    || unit.kind !== "task_run" || unit.ownerType !== "task" || unit.ownerId !== task.id
    || unit.channelId !== step.channelId || unit.teammateId !== step.toParticipantId
    || unit.activeAttemptId !== attempt.id || attempt.workUnitId !== unit.id
    || attempt.runtimeInstanceId !== fence.runtimeInstanceId || attempt.fencingToken !== fence.fencingToken
    || attempt.status !== "created" || attempt.startedAt || attempt.endedAt || attempt.abortRequestedAt
    || attempt.effectiveRunnerId !== "pi" || step.status !== "running" || step.runId || step.taskId !== task.id
    || !["running", "waiting_for_approval", "blocked"].includes(ports.getChannelWorkflow(step.workflowId)?.status ?? "")
    || owner.taskId !== task.id || owner.authorityBasis !== member.authorityBasis
    || task.currentRunId || !["todo", "claimed"].includes(task.status) || task.channelId !== step.channelId
    || task.assigneeTeammateId !== step.toParticipantId || request.task.id !== task.id || request.task.channelId !== step.channelId
    || request.teammateId !== step.toParticipantId || request.cwd !== member.plan.executionRoot
    || request.workspaceCwd !== member.plan.canonicalWorkspaceRoot || request.executionCwd !== member.plan.executionRoot
    || input.resourceKey !== member.plan.executionRoot) return false;
  const admission = database.prepare(`SELECT * FROM workflow_step_admissions WHERE task_id=? AND workspace_id=?
    AND workflow_id=? AND workflow_step_id=? AND lease_id=? AND authority_basis=? AND status='preparing'
    AND run_id IS NULL AND work_unit_id IS NULL AND attempt_id IS NULL AND runtime_instance_id IS NULL AND fencing_token IS NULL`)
    .get(task.id, input.workspaceId, step.workflowId, step.id, owner.leaseId, owner.authorityBasis);
  if (!admission || !same(JSON.parse(String(admission.plan_json)), member.plan.resourcePlan)) return false;
  const entries = database.prepare("SELECT resource_type,resource_key,capacity_limit,slot_id FROM workflow_step_admission_entries WHERE task_id=?").all(task.id);
  const expected = [...member.plan.resourcePlan.entries, ...member.plan.resourcePlan.resourceKeys.map(resourceKey =>
    ({ resourceType: "workflow_resource", resourceKey, limit: 1 }))];
  if (entries.length !== expected.length || entries.some(entry => entry.slot_id !== null)
    || expected.some(entry => !entries.some(actual => actual.resource_type === entry.resourceType
      && actual.resource_key === entry.resourceKey && actual.capacity_limit === entry.limit))) return false;
  const startLease = database.prepare(`SELECT 1 FROM resource_leases WHERE id=? AND workspace_id=? AND resource_type='workflow_step'
    AND resource_key=? AND owner_type='workflow_step' AND owner_id=? AND status='active' AND acquired_at<=? AND expires_at>?`)
    .get(owner.leaseId, input.workspaceId, step.id, step.id, input.acquiredAt, input.acquiredAt);
  // This exact durable lease binds the proposed Run ID; a path or an unlinked caller-supplied ID cannot do so.
  const taskLease = database.prepare(`SELECT 1 FROM resource_leases WHERE workspace_id=? AND resource_type='task' AND resource_key=?
    AND owner_type='run' AND owner_id=? AND work_unit_id=? AND attempt_id=? AND runtime_instance_id=? AND fencing_token=?
    AND status='active' AND acquired_at<=? AND expires_at>?`).get(input.workspaceId, task.id, input.ownerId,
      fence.workUnitId, fence.attemptId, fence.runtimeInstanceId, fence.fencingToken, input.acquiredAt, input.acquiredAt);
  return !!startLease && !!taskLease;
}

type ApplyScope = { readonly roundId: string; readonly generation: number; readonly workspaceId: string;
  readonly targetRoot: string; readonly permitId: string };
const applyScopes = new WeakMap<DatabaseSync, ApplyScope>();

/** Only the verified Core merge-apply transaction can temporarily enter this scope. Not a public authority field. */
export function withWorkflowParallelApplyLease<T>(database: DatabaseSync, scope: ApplyScope, operation: () => T): T {
  if (!database.isTransaction || applyScopes.has(database)) throw new Error("workflow_parallel.apply_transaction_invalid");
  applyScopes.set(database, scope);
  try { return operation(); } finally { applyScopes.delete(database); }
}

export function workflowParallelLeaseAllowed(database: DatabaseSync, ports: WorkflowParallelReadPorts | undefined, input: CreateResourceLeaseInput): boolean {
  if (!["workspace", "channel", "bound_path"].includes(input.resourceType)) return true;
  const held = readWorkflowParallelParents(database).filter(parent => parent.state === "held" && parent.workspaceId === input.workspaceId);
  if (input.ownerType === "system" || input.ownerType === "workflow_step") {
    if (!held.length) return true;
    const apply = applyScopes.get(database);
    return input.ownerType === "system" && !!apply && apply.workspaceId === input.workspaceId
      && input.resourceType === "bound_path" && input.resourceKey === apply.targetRoot && input.ownerId === apply.permitId
      && held.length === 1 && held[0]!.roundId === apply.roundId && held[0]!.generation === apply.generation
      && held[0]!.inputs.target.executionRoot === apply.targetRoot;
  }
  if (typeof input.workUnitId !== "string" || typeof input.attemptId !== "string"
    || typeof input.runtimeInstanceId !== "string" || typeof input.fencingToken !== "string") return false;
  const fence = { workUnitId: input.workUnitId, attemptId: input.attemptId,
    runtimeInstanceId: input.runtimeInstanceId, fencingToken: input.fencingToken };
  if (held.length && ports && preparingLeaseMember(database, ports, input, fence)) return true;
  if (!workflowParallelAttemptAllowed(database, ports, input.workspaceId, fence)) return false;
  if (!ports) return true;
  const member = attemptMember(database, ports, input.workspaceId, fence);
  if (!member) return true;
  return input.resourceType === "bound_path" && input.resourceKey === member.plan.executionRoot
    && (input.ownerType === "run" ? input.ownerId === member.runId : input.ownerId === input.attemptId);
}
