import { isAbsolute } from "node:path";
import type { SQLOutputValue } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { parseWorkflowStepExecutionSafety } from "@ling-stack/contracts";
import type { RunStore } from "../../run-types.js";
import type { WorkflowStepAdmissionPlan } from "../../workflow-step-admission.js";
import { inspectWorkflowPreApproval } from "../../workflow-pre-gate.js";
import { isWorkflowStepSafetyPlanV1 } from "../../workflow-safety-plan.js";
import { isWorkflowStepStartOwnerV1, type WorkflowStepStartReadStore } from "../../workflow-step-start-owner.js";
import type { ChannelWorkflow, ChannelWorkflowStep } from "../../workspace-types.js";
import type { SqliteStoreContext } from "./store-context.js";
import { workflowParallelAdmissionAllowed, workflowParallelAttemptAllowed } from "./workflow-parallel-parent-guard.js";

type Ports = WorkflowStepStartReadStore & Pick<RunStore, "getApprovalRequest" | "listChannelWorkflowSteps"
  | "getWorkUnit" | "getWorkUnitAttempt" | "getChannelWorkflowStepStartAdmission">;

/** Caller holds the begin writer lock. Aggregate waiting is not, by itself, permission to start. */
export function workflowStepBeginApprovalPermitted(context: SqliteStoreContext, store: Ports,
  workflow: ChannelWorkflow, candidate: ChannelWorkflowStep, admission: WorkflowStepAdmissionPlan | undefined,
  now: string): boolean {
  const steps = store.listChannelWorkflowSteps({ workflowId: workflow.id, complete: true });
  // Include historical Run/Task approvals and payload-owned/global decisions, not just current step pointers.
  const pending = context.database.prepare(`SELECT approval.id FROM approval_requests AS approval
    WHERE approval.status='pending' AND (
      EXISTS (SELECT 1 FROM channel_workflow_steps AS step WHERE step.workflow_id=? AND (
        step.id=approval.workflow_step_id OR step.task_id=approval.task_id OR step.run_id=approval.run_id
        OR EXISTS (SELECT 1 FROM run_sessions AS run WHERE run.workflow_step_id=step.id
          AND (run.id=approval.run_id OR run.task_id=approval.task_id))))
      OR CASE WHEN json_valid(approval.payload_json) THEN json_extract(approval.payload_json,'$.workflowId') END=?)`)
    .all(workflow.id, workflow.id);
  const waiting = steps.filter(step => step.status === "waiting_for_approval"
    || Boolean(step.runId && store.getRun(step.runId)?.status === "waiting_for_approval"));
  if (workflow.status !== "waiting_for_approval" && waiting.length === 0 && pending.length === 0) return true;
  if (waiting.length === 0) return false;
  const waitingIds = new Set(waiting.map(step => step.id)), visited = new Set<string>();
  const dependencies = [...candidate.metadata?.dependsOnStepIds ?? []];
  while (dependencies.length > 0) {
    const id = dependencies.pop()!;
    if (waitingIds.has(id) || id === candidate.id) return false;
    if (visited.has(id)) continue;
    visited.add(id);
    const dependency = steps.find(step => step.id === id);
    if (!dependency) return false;
    dependencies.push(...dependency.metadata?.dependsOnStepIds ?? []);
  }
  const hasPersistedOwner = context.database.prepare(`SELECT 1 FROM channel_workflow_steps WHERE id=?
    AND json_type(metadata_json,'$.startOwner') IS NOT NULL`);
  const independentPreApprovalWait = waiting.every(step => {
    if (step.taskId !== undefined || step.runId !== undefined || step.metadata?.startOwner
      || hasPersistedOwner.get(step.id) || step.metadata?.activeGateStage !== "pre") return false;
    return inspectWorkflowPreApproval(store, step, now).status === "pending";
  });
  if (independentPreApprovalWait) {
    const localApprovals = new Set(waiting.map(step => inspectWorkflowPreApproval(store, step, now))
      .filter(inspection => inspection.status === "pending")
      .map(inspection => inspection.approval.id));
    if (pending.some(row => typeof row.id !== "string" || !localApprovals.has(row.id))) return false;
    return hasCompleteReadonlyAdmission(store, workflow, candidate, admission);
  }
  return hasCompleteIsolatedWritingAdmission(context, store, workflow, candidate, admission, waiting, pending);
}

function hasCompleteIsolatedWritingAdmission(context: SqliteStoreContext, store: Ports, workflow: ChannelWorkflow,
  candidate: ChannelWorkflowStep, admission: WorkflowStepAdmissionPlan | undefined,
  waiting: readonly ChannelWorkflowStep[], pending: readonly Record<string, SQLOutputValue>[]): boolean {
  const candidatePlan = candidate.metadata?.safetyPlan;
  if (!admission || candidate.metadata?.sideEffectClass !== "workspace_write"
    || !candidate.metadata?.isolationScopePlan || !isWorkflowStepSafetyPlanV1(candidatePlan)
    || candidatePlan.profile !== "pi_host_isolated_files_v1"
    || !workflowParallelAdmissionAllowed(context.database, store, candidate, admission)) return false;

  const waitingApprovalIds = new Set<string>();
  for (const step of waiting) {
    if (step.id === candidate.id || step.status !== "running" || step.metadata?.sideEffectClass !== "workspace_write"
      || !step.metadata?.isolationScopePlan || !isWorkflowStepSafetyPlanV1(step.metadata.safetyPlan)
      || step.metadata.safetyPlan.profile !== "pi_host_isolated_files_v1") return false;
    const owner = step.metadata.startOwner;
    const run = step.runId ? store.getRun(step.runId) : undefined;
    if (!isWorkflowStepStartOwnerV1(owner) || owner.phase !== "linked" || !run || run.status !== "waiting_for_approval"
      || step.taskId !== owner.taskId || step.runId !== run.id || run.workflowStepId !== step.id
      || run.taskId !== owner.taskId || run.channelId !== step.channelId || run.teammateId !== step.toParticipantId) return false;
    const stepAdmission = store.getChannelWorkflowStepStartAdmission(step.id, owner);
    if (!stepAdmission || stepAdmission.status !== "transferred" || !stepAdmission.fence
      || !workflowParallelAdmissionAllowed(context.database, store, step, stepAdmission.plan)
      || !workflowParallelAttemptAllowed(context.database, store, step.workspaceId, stepAdmission.fence)) return false;
    const approvals = pending
      .map(row => typeof row.id === "string" ? store.getApprovalRequest(row.id) : undefined)
      .filter(approval => approval?.status === "pending" && approval.runId === run.id && approval.taskId === run.taskId
        && approval.channelId === step.channelId
        && (approval.actionType === "write" && approval.payload.type === "file_write"
          || approval.actionType === "edit" && approval.payload.type === "file_edit"));
    if (approvals.length !== 1) return false;
    waitingApprovalIds.add(approvals[0]!.id);
  }
  return waitingApprovalIds.size > 0 && pending.length === waitingApprovalIds.size
    && pending.every(row => typeof row.id === "string" && waitingApprovalIds.has(row.id));
}

function hasCompleteReadonlyAdmission(store: Ports, workflow: ChannelWorkflow, step: ChannelWorkflowStep,
  admission: WorkflowStepAdmissionPlan | undefined): boolean {
  const plan = step.metadata?.safetyPlan, channel = store.getChannel(step.channelId);
  if (!admission || !channel || !channel.runtimePolicy.allowReadOnlyParallel
    || !isWorkflowStepSafetyPlanV1(plan) || plan.profile !== "pi_host_readonly_v1"
    || plan.workflowId !== workflow.id || plan.workflowStepId !== step.id
    || !isAbsolute(plan.workspaceRoot) || !isAbsolute(plan.executionRoot)
    || plan.safety.parallelPolicy?.autoParallel !== true
    || step.metadata?.requestedRunnerId !== undefined && step.metadata.requestedRunnerId !== plan.runnerId
    || step.metadata?.requiredTools?.some(tool => !plan.tools.includes(tool))) return false;
  try {
    if (!isDeepStrictEqual(parseWorkflowStepExecutionSafety(step.metadata), plan.safety)) return false;
  } catch { return false; }
  const positive = (value: number) => Number.isSafeInteger(value) && value > 0 ? value : 1;
  const limit = Math.min(4, positive(channel.runtimePolicy.maxConcurrentRuns),
    positive(workflow.metadata?.maxParallelSteps ?? channel.runtimePolicy.maxConcurrentRuns),
    positive(plan.safety.parallelPolicy.maxParallelSiblings ?? 1),
    positive(step.metadata?.maxParallelSiblings ?? plan.safety.parallelPolicy.maxParallelSiblings ?? 1));
  const scopes = [channel.id, `workflow:${workflow.id}`, `workspace:${plan.workspaceRoot}`];
  return scopes.every(scope => admission.entries.some(entry => entry.resourceType === "channel_parallel"
      && entry.resourceKey === scope && entry.limit <= limit))
    && admission.entries.some(entry => entry.resourceType === "runner" && entry.resourceKey === plan.runnerId && entry.limit <= 4)
    && admission.entries.some(entry => entry.resourceType === "provider" && entry.limit <= 4)
    && (plan.safety.parallelPolicy.resourceKeys ?? []).every(key => admission.resourceKeys.includes(key));
}
