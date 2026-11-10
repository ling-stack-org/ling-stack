import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import { isWorkflowStepSafetyPlanV1 } from "../../workflow-safety-plan.js";
import type { ChannelWorkflowStep } from "../../workspace-types.js";
import { SqliteRuntimeConcurrencyPolicyStore } from "./runtime-concurrency-policy-store.js";
import { readRuntimeDelegationCapacityReservations, sameRuntimeCapacityFence } from "./runtime-delegation-capacity.js";

type RunClass = "readonly" | "workspace_write";
type CapacityConflict = { readonly resourceType: "channel_parallel"; readonly resourceKey: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  try { return record(JSON.parse(value)); } catch { return undefined; }
}

function stepRunClass(step: Pick<ChannelWorkflowStep, "id" | "workflowId" | "metadata">, runnerId?: string): RunClass {
  const plan = step.metadata?.safetyPlan;
  return runnerId === "pi" && isWorkflowStepSafetyPlanV1(plan) && plan.profile === "pi_host_readonly_v1"
    && plan.workflowStepId === step.id && plan.workflowId === step.workflowId ? "readonly" : "workspace_write";
}

/** Missing or legacy Host profile evidence consumes the conservative write class. */
function attemptRunClass(database: DatabaseSync, fence: RuntimeAttemptFenceV1): RunClass {
  const row = database.prepare(`SELECT run.workflow_step_id,run.request_snapshot_json,step.workflow_id,step.metadata_json,
      COALESCE(attempt.effective_runner_id,attempt.runner_id) AS runner_id
    FROM work_unit_attempts AS attempt JOIN work_units AS unit ON unit.id=attempt.work_unit_id
    JOIN run_sessions AS run ON run.id=unit.linked_run_id AND run.work_unit_id=unit.id
    JOIN channel_workflow_steps AS step ON step.id=run.workflow_step_id
    WHERE attempt.work_unit_id=? AND attempt.id=? AND attempt.runtime_instance_id=? AND attempt.fencing_token=?`)
    .get(fence.workUnitId, fence.attemptId, fence.runtimeInstanceId, fence.fencingToken);
  if (!row || row.runner_id !== "pi") return "workspace_write";
  const request = parseRecord(row.request_snapshot_json), metadata = parseRecord(row.metadata_json);
  const snapshot = record(request?.workflowSafetySnapshot), plan = snapshot?.plan;
  return snapshot?.schemaVersion === 1 && request?.workflowStepId === row.workflow_step_id
    && isWorkflowStepSafetyPlanV1(plan) && plan.profile === "pi_host_readonly_v1"
    && plan.workflowStepId === row.workflow_step_id && plan.workflowId === row.workflow_id
    && isDeepStrictEqual(plan, metadata?.safetyPlan) ? "readonly" : "workspace_write";
}

/** Call under the admission writer transaction. Active unknown owners and preparing starts retain capacity. */
export function readRuntimeRunCapacityConflict(database: DatabaseSync, input: {
  readonly workspaceId: string;
  readonly fence?: RuntimeAttemptFenceV1;
  readonly step?: ChannelWorkflowStep;
  readonly stepRunnerId?: string;
  readonly excludePreparingTaskId?: string;
  readonly excludeDelegationRunId?: string;
  readonly now?: string;
}): CapacityConflict | undefined {
  const policy = new SqliteRuntimeConcurrencyPolicyStore({ database }).getRuntimeConcurrencyPolicy(input.workspaceId);
  if (!policy?.enabled) return undefined;
  const owners = database.prepare(`SELECT DISTINCT work_unit_id,attempt_id,runtime_instance_id,fencing_token
    FROM runtime_semaphore_slots WHERE workspace_id=? AND resource_type IN ('provider','runner') AND status='active'`)
    .all(input.workspaceId);
  let total = 0, readonly = 0, writing = 0, retained = false;
  for (const row of owners) {
    const fence = { workUnitId: String(row.work_unit_id), attemptId: String(row.attempt_id),
      runtimeInstanceId: String(row.runtime_instance_id), fencingToken: String(row.fencing_token) };
    if (sameRuntimeCapacityFence(input.fence, fence)) retained = true;
    total++;
    if (attemptRunClass(database, fence) === "readonly") readonly++; else writing++;
  }
  const preparing = database.prepare(`SELECT admission.task_id,step.id,step.workflow_id,step.metadata_json,
      (SELECT CASE WHEN COUNT(*)=1 THEN MIN(entry.resource_key) END FROM workflow_step_admission_entries AS entry
        WHERE entry.task_id=admission.task_id AND entry.resource_type='runner') AS runner_id
    FROM workflow_step_admissions AS admission JOIN channel_workflow_steps AS step ON step.id=admission.workflow_step_id
    WHERE admission.workspace_id=? AND admission.status='preparing' AND EXISTS (
      SELECT 1 FROM workflow_step_admission_entries AS entry WHERE entry.task_id=admission.task_id
        AND entry.resource_type IN ('provider','runner'))`).all(input.workspaceId);
  for (const row of preparing) {
    if (row.task_id === input.excludePreparingTaskId) retained = true;
    total++;
    const metadata = parseRecord(row.metadata_json) as ChannelWorkflowStep["metadata"];
    if (stepRunClass({ id: String(row.id), workflowId: String(row.workflow_id), metadata },
      typeof row.runner_id === "string" ? row.runner_id : undefined) === "readonly") readonly++;
    else writing++;
  }
  for (const reservation of readRuntimeDelegationCapacityReservations(database, input.workspaceId, input.now)) {
    if (reservation.hasExecutionSlot) continue;
    if (reservation.runId === input.excludeDelegationRunId || sameRuntimeCapacityFence(input.fence, reservation.fence)) retained = true;
    total++;
    writing++;
  }
  // An exact slot owner or validated reservation handoff is not a new execution.
  if (retained) return undefined;
  const runClass = input.step ? stepRunClass(input.step, input.stepRunnerId) : input.fence ? attemptRunClass(database, input.fence) : "workspace_write";
  const scope = total >= policy.limits.maxConcurrentRuns ? "runs"
    : runClass === "readonly" && readonly >= policy.limits.maxReadOnlyRuns ? "readonly"
      : runClass === "workspace_write" && writing >= policy.limits.maxWorkspaceWriteRuns ? "workspace_write" : undefined;
  return scope ? { resourceType: "channel_parallel", resourceKey: `runtime:workspace:${input.workspaceId}:${scope}` } : undefined;
}
