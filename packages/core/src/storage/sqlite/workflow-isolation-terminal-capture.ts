import type { DatabaseSync } from "node:sqlite";
import type { RunStore } from "../../run-types.js";
import type { RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import { workflowStepStartAuthorityBasis, workflowStepStartOwnerMatches, type WorkflowStepStartReadStore } from "../../workflow-step-start-owner.js";
import type { WorkflowIntegrationRound, WorkflowIsolationExecutionBinding, WorkflowIsolationScopePlanV1,
  WorkflowIsolationTerminalCaptureResult } from "../../workflow-isolation-types.js";
import { workflowIsolationCanonicalJson as json, workflowIsolationDigest as digest, workflowIsolationRecord as record,
  workflowIsolationTime as time, workflowIsolationStepSafetyFingerprint } from "../../workflow-isolation.js";
import { readHarnessRetainedBody } from "./harness-artifact-recovery-pins.js";
import { hostAttemptReadScopeForSource } from "./host-attempt-read-scope.js";
import { assertUserInputDurableQuiescence } from "./user-input-durable-quiescence.js";

export type WorkflowIsolationTerminalCapturePorts = WorkflowStepStartReadStore & Pick<RunStore,
  "getWorkUnit" | "getWorkUnitAttempt" | "getArtifact" | "getChannelWorkflowStepStartAdmission"
  | "getHostAttemptCompletion" | "getDelegationCompletionEvidence">;
const same = (a: unknown, b: unknown): boolean => json(a) === json(b);
const sameFence = (a: RuntimeAttemptFenceV1, b: RuntimeAttemptFenceV1): boolean => a.workUnitId === b.workUnitId
  && a.attemptId === b.attemptId && a.runtimeInstanceId === b.runtimeInstanceId && a.fencingToken === b.fencingToken;
const before = (value: unknown, at: string): value is string => time(value) && value <= at;
const reject = (status: "stale" | "blocked", code: string): WorkflowIsolationTerminalCaptureResult =>
  ({ status, code: `workflow_isolation.terminal_${code}` });

/** Caller owns a synchronous read-only snapshot. No live-owner or resource-release exception is issued here. */
export function readWorkflowIsolationTerminalCapture(database: DatabaseSync, ports: WorkflowIsolationTerminalCapturePorts,
  binding: WorkflowIsolationExecutionBinding, plan: WorkflowIsolationScopePlanV1, round: WorkflowIntegrationRound | undefined,
  now: string): WorkflowIsolationTerminalCaptureResult {
  const fence = binding.fence, owner = binding.startOwner;
  const step = ports.getChannelWorkflowStep(plan.workflowStepId), workflow = ports.getChannelWorkflow(plan.workflowId);
  const task = ports.getTask(owner.taskId), run = ports.getRun(binding.runId), unit = ports.getWorkUnit(fence.workUnitId), attempt = ports.getWorkUnitAttempt(fence.attemptId);
  const scope = database.prepare("SELECT authority_basis FROM workflow_isolation_scope_plans WHERE plan_id=?").get(plan.planId);
  if (!step || !workflow || !task || !run || !unit || !attempt || !scope || !round || round.generation !== plan.generation
    || !same(round.inputs.safetyPins.find(pin => pin.workflowStepId === step.id), { workflowStepId: step.id, fingerprint: plan.safetyFingerprint })
    || round.inputs.workflowId !== plan.workflowId || round.inputs.graphFingerprint !== plan.graphFingerprint
    || step.workflowId !== plan.workflowId || step.workspaceId !== plan.canonicalWorkspaceId || workflow.workspaceId !== plan.canonicalWorkspaceId
    || !same(step.metadata?.isolationScopePlan ?? null, { planId: plan.planId, planDigest: plan.planDigest })
    || !workflowStepStartOwnerMatches(step.metadata?.startOwner, owner) || step.metadata?.startOwner?.phase !== "linked"
    || step.taskId !== task.id || step.runId !== run.id || task.currentRunId !== run.id
    || scope.authority_basis !== owner.authorityBasis || workflowStepStartAuthorityBasis(ports, step) !== scope.authority_basis
    || workflow.metadata?.workflowGraphFingerprint !== plan.graphFingerprint || workflowIsolationStepSafetyFingerprint(step) !== plan.safetyFingerprint)
    return reject("stale", "lineage_changed");
  if ([workflow.status, step.status, task.status, run.status, unit.status, attempt.status].includes("cancelled") || attempt.abortRequestedAt)
    return reject("blocked", "cancellation_unverified");
  if (!["running", "waiting_for_approval", "blocked", "succeeded", "failed"].includes(workflow.status)
    || !["running", "waiting_for_approval", "blocked", "succeeded", "failed"].includes(step.status)
    || task.channelId !== step.channelId || task.assigneeTeammateId !== step.toParticipantId || run.taskId !== task.id
    || run.workflowStepId !== step.id || run.channelId !== step.channelId || run.teammateId !== step.toParticipantId
    || run.cwd !== plan.executionRoot || run.workUnitId !== unit.id || unit.workspaceId !== plan.canonicalWorkspaceId
    || unit.kind !== "task_run" || unit.ownerType !== "task" || unit.ownerId !== task.id || unit.taskId !== task.id
    || unit.channelId !== step.channelId || unit.teammateId !== step.toParticipantId || unit.linkedRunId !== run.id
    || unit.activeAttemptId !== attempt.id || attempt.workUnitId !== unit.id || attempt.runtimeInstanceId !== fence.runtimeInstanceId
    || attempt.fencingToken !== fence.fencingToken
    || !plan.resourcePlan.entries.some(entry => entry.resourceType === "runner" && entry.resourceKey === attempt.effectiveRunnerId))
    return reject("stale", "execution_changed");
  const snapshot = run.requestSnapshot;
  if (!record(snapshot) || !same(snapshot.workflowIsolationPlan ?? null, { planId: plan.planId, planDigest: plan.planDigest }))
    return reject("stale", "run_pin_changed");
  // Expiry is deliberately not evidence. Retain the original lease identity even after real release.
  const lease = database.prepare(`SELECT * FROM resource_leases WHERE id=? AND workspace_id=? AND resource_type='workflow_step'
    AND resource_key=? AND owner_type='workflow_step' AND owner_id=?`).get(owner.leaseId, plan.canonicalWorkspaceId, step.id, step.id);
  if (!lease || database.prepare(`SELECT 1 FROM resource_leases WHERE workspace_id=? AND resource_type='workflow_step'
    AND resource_key=? AND status='active' AND id<>?`).get(plan.canonicalWorkspaceId, step.id, owner.leaseId))
    return reject("stale", "lease_owner_changed");
  const admission = ports.getChannelWorkflowStepStartAdmission(step.id, owner);
  if (!admission || admission.status !== "transferred" || admission.runId !== run.id || !admission.fence
    || !sameFence(admission.fence, fence) || !same(admission.plan, plan.resourcePlan)) return reject("stale", "admission_changed");
  const slots = database.prepare(`SELECT slot.*,entry.resource_type AS planned_type,entry.resource_key AS planned_key
    FROM workflow_step_admission_entries entry JOIN runtime_semaphore_slots slot ON slot.id=entry.slot_id WHERE entry.task_id=?`).all(task.id);
  if (slots.length !== plan.resourcePlan.entries.length + plan.resourcePlan.resourceKeys.length
    || slots.some(slot => !["active", "released"].includes(String(slot.status)) || slot.workspace_id !== plan.canonicalWorkspaceId
      || slot.resource_type !== slot.planned_type || slot.resource_key !== slot.planned_key || slot.owner_type !== "work_unit_attempt"
      || slot.owner_id !== fence.attemptId || slot.work_unit_id !== fence.workUnitId || slot.attempt_id !== fence.attemptId
      || slot.runtime_instance_id !== fence.runtimeInstanceId || slot.fencing_token !== fence.fencingToken)) return reject("stale", "slot_owner_changed");
  if (binding.status !== "ready" || binding.openIntentId || round.openIntentId || database.prepare(`SELECT 1 FROM workflow_isolation_intents
    WHERE writer_binding_id=? AND status<>'confirmed' LIMIT 1`).get(binding.bindingId)) return reject("blocked", "git_effect_unconfirmed");
  const creation = database.prepare(`SELECT receipt.artifact_id FROM workflow_isolation_receipts receipt
    JOIN workflow_isolation_intents intent ON intent.intent_id=receipt.intent_id WHERE receipt.receipt_id=?
      AND receipt.outcome='confirmed' AND intent.status='confirmed' AND intent.kind='worktree_create'
      AND intent.scope_binding_id=? AND intent.writer_binding_id=?`).get(binding.creationReceiptId ?? null, binding.bindingId, binding.bindingId);
  const artifact = creation && ports.getArtifact(String(creation.artifact_id));
  if (!artifact || artifact.runId !== run.id || artifact.sealedPayloadState === "pruned") return reject("blocked", "creation_receipt_unverified");
  try { readHarnessRetainedBody(database, artifact.id); }
  catch { return reject("blocked", "creation_receipt_unverified"); }
  if (run.status !== "succeeded" && run.status !== "failed" || unit.status !== run.status || attempt.status !== run.status
    || !before(run.endedAt, now) || !before(unit.endedAt, now) || !before(attempt.endedAt, now)) return reject("blocked", "not_terminal");
  const source = { runId: run.id, ...fence }, completion = ports.getHostAttemptCompletion(source);
  if (!completion?.drainedAt) return reject("blocked", "host_not_drained");
  if (!completion.effectCoverage || !same(completion.source, source) || !before(completion.registeredAt, completion.drainedAt)
    || !before(completion.drainedAt, now)
    || [run, unit, attempt].some(execution => execution.startedAt !== undefined
      && (!before(execution.startedAt, execution.endedAt!) || !before(execution.startedAt, completion.drainedAt!))))
    return reject("blocked", "effect_coverage_unverified");
  const audits = database.prepare(`SELECT * FROM runtime_events WHERE work_unit_id=? AND attempt_id=? AND runtime_instance_id=?
    AND fencing_token=? AND type IN ('work_unit_succeeded','work_unit_failed','work_unit_cancelled','work_unit_stale') LIMIT 2`)
    .all(fence.workUnitId, fence.attemptId, fence.runtimeInstanceId, fence.fencingToken);
  if (audits.length !== 1 || audits[0]!.type !== (run.status === "succeeded" ? "work_unit_succeeded" : "work_unit_failed")
    || audits[0]!.ts !== attempt.endedAt || !["system", "runner"].includes(String(audits[0]!.actor))) return reject("blocked", "audit_unverified");
  if (database.prepare("SELECT 1 FROM run_terminal_intents WHERE run_id=? AND state='pending'").get(run.id)) return reject("blocked", "intent_pending");
  try { assertUserInputDurableQuiescence(database, run.id, fence, Date.parse(now), hostAttemptReadScopeForSource(database, source)); }
  catch { return reject("blocked", "quiescence_unverified"); }
  if (!closedToolInventory(database, run.id, fence, completion.effectCoverage, completion.drainedAt)) return reject("blocked", "tool_inventory_unverified");
  const descendants = database.prepare(`WITH RECURSIVE tree(id) AS (SELECT ? UNION
    SELECT child.id FROM run_sessions child JOIN tree parent ON child.parent_run_id=parent.id LIMIT 4097)
    SELECT run.id,run.parent_run_id FROM tree JOIN run_sessions run ON run.id=tree.id ORDER BY run.id`).all(run.id);
  if (descendants.length > 4096 || descendants.some(child => child.id === run.parentRunId)) return reject("blocked", "descendants_unverified");
  const evidence = ports.getDelegationCompletionEvidence({ rootRunIds: [run.id] });
  // Optional children must also physically finish. The required-business-outcome verdict alone is insufficient.
  if (evidence.issues.length || evidence.steps.some(child => !["succeeded", "failed", "cancelled"].includes(child.step.state)
    || child.quiescence !== "verified" || !child.hostCompletion?.drainedAt || !child.hostCompletion.effectCoverage
    || !before(child.hostCompletion.drainedAt, now) || !child.childRun || !child.attempt
    || !closedToolInventory(database, child.childRun.id, child.attempt.sourceFence, child.hostCompletion.effectCoverage, child.hostCompletion.drainedAt)
    || database.prepare("SELECT 1 FROM run_terminal_intents WHERE run_id=? AND state='pending'").get(child.childRun.id)
    || child.step.parentRunId === run.id && child.step.parentAttemptId !== fence.attemptId)
    || descendants.some(child => child.id !== run.id && evidence.steps.filter(read => read.childRun?.id === child.id).length !== 1))
    return reject("blocked", "descendants_unverified");
  if (database.prepare(`SELECT 1 FROM delegation_budget_charges WHERE run_id=?
    AND state NOT IN ('measured','cancelled_before_dispatch') LIMIT 1`).get(run.id)) return reject("blocked", "usage_unverified");
  const effects = {
    operations: database.prepare("SELECT * FROM host_operations WHERE run_id=? ORDER BY operation_id").all(run.id),
    tools: database.prepare("SELECT * FROM harness_tool_executions WHERE run_id=? ORDER BY id").all(run.id),
    native: database.prepare("SELECT * FROM native_submissions WHERE run_id=? ORDER BY id").all(run.id),
    events: database.prepare("SELECT * FROM run_events WHERE run_id=? ORDER BY seq").all(run.id),
  };
  const terminal = { outcome: run.status, endedAt: run.endedAt, audit: { seq: Number(audits[0]!.seq), digest: digest(audits[0]) },
    completion, effectDigest: digest(effects), descendantEvidenceFingerprint: evidence.fingerprint };
  return { status: "authorized", binding, plan, terminal, proofDigest: digest({ binding, plan, terminal, run, task, unit, attempt }, "witc1_") };
}

/** SDK inventory plus paired source-bound events. A tool_end or durable status alone is never coverage. */
function closedToolInventory(database: DatabaseSync, runId: string, fence: RuntimeAttemptFenceV1,
  coverage: string, drainedAt: string): boolean {
  if (coverage === "native_journal_v1") return true; // The completion reader verifies its closed native submission inventory.
  const row = database.prepare("SELECT tracked_tool_calls_json FROM host_attempt_completions WHERE attempt_id=?").get(fence.attemptId);
  let ids: readonly unknown[] = [];
  if (coverage === "pi_tracked_tools_v1") {
    try {
      const inventory: unknown = JSON.parse(String(row?.tracked_tool_calls_json));
      if (Array.isArray(inventory)) ids = inventory;
      else if (record(inventory) && Array.isArray(inventory.toolCallIds)) ids = inventory.toolCallIds;
      else return false;
    } catch { return false; }
  }
  const starts = new Map<string, string>(), open = new Set<string>();
  const events = database.prepare("SELECT type,ts,data_json FROM run_events WHERE run_id=? AND type IN ('tool_start','tool_update','tool_end') ORDER BY seq").all(runId);
  for (const event of events) {
    let data: unknown;
    try { data = JSON.parse(String(event.data_json)); } catch { return false; }
    if (!record(data) || data.attemptId !== fence.attemptId || typeof data.toolCallId !== "string" || typeof data.toolName !== "string"
      || !before(event.ts, drainedAt) || !ids.includes(data.toolCallId)) return false;
    if (event.type === "tool_start") {
      if (starts.has(data.toolCallId)) return false;
      starts.set(data.toolCallId, data.toolName); open.add(data.toolCallId);
    } else {
      if (!open.has(data.toolCallId) || starts.get(data.toolCallId) !== data.toolName) return false;
      if (event.type === "tool_end") open.delete(data.toolCallId);
    }
  }
  return !open.size && starts.size === ids.length;
}
