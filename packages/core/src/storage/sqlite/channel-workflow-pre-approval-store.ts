import { randomUUID } from "node:crypto";
import type { RunStore } from "../../run-types.js";
import { transitionWorkflow, transitionWorkflowStep } from "../../state-machines.js";
import { createWorkflowPreGateBasis, effectiveWorkflowPreGate, inspectWorkflowPreApproval,
  isWorkflowPreGateExecutionPermitV1, isWorkflowPreGateMarkerV1, workflowStepNewStartMetadata,
  type WorkflowPreGateInspection, type WorkflowStepPreApprovalInput,
  type WorkflowStepPreApprovalResolveInput, type WorkflowStepPreApprovalResult } from "../../workflow-pre-gate.js";
import { workflowStepStartAuthorityBasis, type WorkflowStepStartReadStore } from "../../workflow-step-start-owner.js";
import type { ChannelWorkflow, ChannelWorkflowStep } from "../../workspace-types.js";
import { stringifyJson } from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";

type Ports = WorkflowStepStartReadStore & Pick<RunStore,
  "getApprovalRequest" | "createApprovalRequest" | "recordStateTransitionEvent" | "listChannelWorkflowSteps">;
type CurrentApproval = Extract<WorkflowPreGateInspection, { readonly status: "pending" | "approved" | "blocked" }>;

/** Workflow/Turn approval projection is aggregate: one resolved Step cannot hide another active wait. */
export function workflowHasUnresolvedApprovalWait(
  store: Pick<RunStore, "listChannelWorkflowSteps" | "getRun">,
  workflowId: string,
): boolean {
  return store.listChannelWorkflowSteps({ workflowId, complete: true }).some((step) =>
    step.status === "waiting_for_approval"
    || Boolean(step.runId && store.getRun(step.runId)?.status === "waiting_for_approval"));
}

/** One short SQLite writer: request/marker/states/audit commit together, without network or execution. */
export class SqliteChannelWorkflowPreApprovalStore {
  constructor(private readonly context: SqliteStoreContext, private readonly ports: Ports) {}

  requestChannelWorkflowStepPreApproval(input: WorkflowStepPreApprovalInput): WorkflowStepPreApprovalResult {
    return this.transaction(() => {
      const step = this.ports.getChannelWorkflowStep(input.workflowStepId);
      if (!step || step.status !== input.expected.status || step.taskId !== input.expected.taskId
        || step.runId !== input.expected.runId || step.updatedAt !== input.expected.updatedAt) {
        return { status: "stale", code: "workflow_pre_approval_basis_stale" };
      }
      const workflow = this.ports.getChannelWorkflow(step.workflowId);
      const channel = this.ports.getChannel(step.channelId);
      if (!workflow || !["draft", "ready", "running", "blocked", "waiting_for_approval"].includes(workflow.status)
        || !channel || workflow.channelId !== channel.id
        || !["queued", "claimed", "running", "blocked", "waiting_for_approval"].includes(step.status)
        || step.status === "waiting_for_approval" && step.metadata?.activeGateStage !== "pre"
        || step.status === "running" && Boolean(step.taskId || step.runId)) {
        return { status: "invalid", code: "workflow_pre_approval_start_not_permitted" };
      }
      const expectedProviderPresetId = step.metadata?.providerBinding?.providerPresetId
        ?? step.metadata?.providerPresetId ?? channel.defaultProviderPresetId;
      if (!isWorkflowPreGateExecutionPermitV1(input.executionPermit)) {
        return { status: "invalid", code: "workflow_pre_approval_execution_permit_invalid" };
      }
      const inspection = inspectWorkflowPreApproval(this.ports, step, input.now, input.executionPermit);
      // Without an effective gate, the request is ordinary start input. Its
      // overrides are not approval authority and must retain the established
      // ungated behavior.
      if (inspection.status === "not_required") {
        if (step.status === "waiting_for_approval") return { status: "stale", code: "workflow_pre_approval_basis_stale" };
        return inspection;
      }
      if (input.executionPermit.taskTitle !== step.title
        || input.executionPermit.taskPrompt !== step.prompt
        || input.executionPermit.providerPresetId !== expectedProviderPresetId
        || input.executionPermit.runnerId !== step.metadata?.requestedRunnerId
        || input.executionPermit.assigneeTeammateId !== step.toParticipantId) {
        return { status: "invalid", code: "workflow_pre_approval_execution_permit_invalid" };
      }
      if (inspection.status === "stale") {
        // Explicit admission detects stale state; old callbacks cannot do this retirement.
        // Preserve the old Approval row, clear only the stale active pointer and require another explicit retry.
        if (isCurrentPreAdmission(step)) {
          if (step.status !== "blocked") this.stepTransition(step, "blocked", input.now, inspection.code);
          if (workflow.status === "waiting_for_approval" || workflow.status === "running") {
            this.workflowTransition(workflow, "step_blocked", input.now, inspection.code);
          }
          const { preStepApprovalId, preStepApprovalMarker, activeGateStage, ...metadata } = step.metadata ?? {};
          this.context.database.prepare("UPDATE channel_workflow_steps SET metadata_json=?, blocker=?, updated_at=? WHERE id=?")
            .run(stringifyJson(metadata), "Workflow pre-approval changed; explicitly retry the current definition.", input.now, step.id);
        }
        return inspection;
      }
      if (inspection.status === "pending") {
        return step.status === "waiting_for_approval" && step.metadata?.activeGateStage === "pre"
          ? { status: "duplicate", approval: inspection.approval }
          : { status: "stale", code: "workflow_pre_approval_basis_stale" };
      }
      if (inspection.status === "approved") {
        return this.resolveCurrent(workflow, step, inspection, input.now, "system");
      }
      if (inspection.status === "blocked") {
        return this.resolveCurrent(workflow, step, inspection, input.now, "system");
      }
      const authorityBasis = workflowStepStartAuthorityBasis(this.ports, step);
      if (!authorityBasis) return { status: "stale", code: "workflow_pre_approval_basis_stale" };
      // A blocked previous generation must already be quiescent before requesting a new start cycle.
      const previousRun = step.runId ? this.ports.getRun(step.runId) : undefined;
      if (step.runId && (!previousRun || !["succeeded", "failed", "cancelled"].includes(previousRun.status))) {
        return { status: "invalid", code: "workflow_pre_approval_previous_run_active" };
      }
      const gate = effectiveWorkflowPreGate(step, step.status, workflow.title);
      if (!gate) return { status: "not_required" };
      const basis = createWorkflowPreGateBasis({ startNonce: randomUUID(), authorityBasis,
        requestedStatus: step.status, gateFingerprint: gate.fingerprint, executionPermit: input.executionPermit });
      const approval = this.ports.createApprovalRequest({ workflowStepId: step.id, channelId: step.channelId,
        actionType: "workflow_step", risk: gate.approvalProfile.risk ?? (gate.approvalProfile.mode === "strict" ? "high" : "medium"),
        title: gate.title, description: gate.reason, payload: { type: "workflow_step", gateStage: "pre",
          workflowId: workflow.id, workflowStepId: step.id, templateStepId: step.metadata?.templateStepId,
          title: step.title, approvalMode: gate.approvalProfile.mode,
          requiredForTools: gate.approvalProfile.requiredForTools ?? [],
          requiredForActions: gate.approvalProfile.requiredForActions ?? [], preGateBasis: basis },
        expiresAt: new Date(Date.parse(input.now) + 30 * 60_000).toISOString() }, input.now);
      this.ensureRunning(workflow, step, input.now);
      const metadata = { ...workflowStepNewStartMetadata(step.metadata), activeGateStage: "pre" as const,
        preStepApprovalId: approval.id, preStepApprovalMarker: { basis } };
      this.context.database.prepare(`UPDATE channel_workflow_steps SET task_id=NULL, run_id=NULL,
        metadata_json=?, blocker=?, result_summary=NULL, updated_at=? WHERE id=?`)
        .run(stringifyJson(metadata), `Waiting for approval: ${approval.title}`, input.now, step.id);
      this.stepTransition({ ...step, status: "running" }, "approval_requested", input.now, `approval:${approval.id}`);
      const currentWorkflow = this.ports.getChannelWorkflow(workflow.id)!;
      if (currentWorkflow.status === "running") this.workflowTransition(currentWorkflow, "approval_requested", input.now, `approval:${approval.id}`);
      return { status: "requested", approval };
    });
  }

  /** Read the current exact Approval from Store; a stale event/payload cannot unlock a successor. */
  resolveChannelWorkflowStepPreApproval(input: WorkflowStepPreApprovalResolveInput): WorkflowStepPreApprovalResult {
    return this.transaction(() => {
      const step = this.ports.getChannelWorkflowStep(input.workflowStepId);
      const workflow = step && this.ports.getChannelWorkflow(step.workflowId);
      if (!step || !workflow || step.metadata?.preStepApprovalId !== input.approvalId
        || step.metadata?.preStepApprovalMarker?.consumedByTaskId
        || !["running", "waiting_for_approval", "blocked"].includes(workflow.status)
        || !["running", "waiting_for_approval", "blocked"].includes(step.status)
        || step.taskId || step.runId) return { status: "stale", code: "workflow_pre_approval_basis_stale" };
      const inspection = inspectWorkflowPreApproval(this.ports, step, input.now);
      if (inspection.status === "stale") return inspection;
      if (inspection.status === "not_required" || inspection.status === "required") return { status: "stale", code: "workflow_pre_approval_basis_stale" };
      if (inspection.status === "pending") return { status: "duplicate", approval: inspection.approval };
      return this.resolveCurrent(workflow, step, inspection, input.now, input.actor ?? "system");
    });
  }

  private resolveCurrent(workflow: ChannelWorkflow, step: ChannelWorkflowStep, inspection: CurrentApproval,
    now: string, actor: "system" | "local-user"): WorkflowStepPreApprovalResult {
    if (inspection.status === "pending") return { status: "duplicate", approval: inspection.approval };
    const reason = inspection.status === "blocked"
      ? inspection.approval.decisionReason ?? `Workflow step pre-approval ${inspection.code}.` : `approval:${inspection.approval.id}`;
    if (inspection.status === "approved") {
      if (isApprovedPreAdmissionHolding(step, inspection)) {
        return { status: "approved", approval: inspection.approval };
      }
      if (step.status !== "waiting_for_approval" && (step.status !== "running" || step.metadata?.activeGateStage !== "pre")) {
        return { status: "stale", code: "workflow_pre_approval_basis_stale" };
      }
      if (step.status === "waiting_for_approval") this.stepTransition(step, "approval_approved", now, reason, actor);
      if (workflow.status === "waiting_for_approval" && !workflowHasUnresolvedApprovalWait(this.ports, workflow.id)) {
        this.workflowTransition(workflow, "approval_approved", now, reason, actor);
      }
      const { activeGateStage, ...metadata } = step.metadata ?? {};
      this.context.database.prepare("UPDATE channel_workflow_steps SET metadata_json=?, blocker=NULL, updated_at=? WHERE id=?")
        .run(stringifyJson(metadata), now, step.id);
      return { status: "approved", approval: inspection.approval };
    }
    const policy = step.metadata?.policy?.onApprovalDenied ?? "block_for_user";
    if (step.status === "waiting_for_approval" || step.status === "running") {
      this.stepTransition(step, policy === "fail_workflow" ? "fail" : policy === "cancel_workflow" ? "cancel"
        : policy === "skip_if_optional" ? "skip" : "blocked", now, reason, actor);
      const { activeGateStage, ...metadata } = step.metadata ?? {};
      this.context.database.prepare("UPDATE channel_workflow_steps SET metadata_json=?, blocker=?, result_summary=?, updated_at=? WHERE id=?")
        .run(stringifyJson(metadata), policy === "skip_if_optional" ? null : reason,
          policy === "skip_if_optional" ? reason : null, now, step.id);
      if (policy === "skip_if_optional") {
        if (workflow.status === "waiting_for_approval" && !workflowHasUnresolvedApprovalWait(this.ports, workflow.id)) {
          this.workflowTransition(workflow, "approval_approved", now, reason, actor);
        }
        // Canonical completion owns fan-in/evidence gates. A pre-gate policy
        // may skip this Step, but cannot publish workflow success on its own.
      } else if (policy === "cancel_workflow") this.workflowTransition(workflow, "cancel", now, reason, actor);
      else if (workflow.status !== "blocked" || policy === "fail_workflow") this.workflowTransition(workflow,
        policy === "fail_workflow" ? "step_failed" : "step_blocked", now, reason, actor);
    }
    return { status: "blocked", code: inspection.code, blocker: reason,
      failed: this.ports.getChannelWorkflow(workflow.id)?.status === "failed", approval: inspection.approval };
  }

  private ensureRunning(workflow: ChannelWorkflow, step: ChannelWorkflowStep, now: string): void {
    if (workflow.status === "draft") {
      this.workflowTransition(workflow, "prepare", now);
      this.workflowTransition({ ...workflow, status: "ready" }, "start", now);
    } else if (workflow.status === "ready" || workflow.status === "blocked") this.workflowTransition(workflow, "start", now);
    if (step.status === "queued" || step.status === "blocked") {
      this.stepTransition(step, step.status === "queued" ? "claim" : "resume", now);
      this.stepTransition({ ...step, status: "claimed" }, "start", now);
    } else if (step.status === "claimed") this.stepTransition(step, "start", now);
  }
  private workflowTransition(workflow: ChannelWorkflow, event: Parameters<typeof transitionWorkflow>[0]["event"],
    now: string, reason = "workflow_pre_approval", actor: "system" | "local-user" = "system"): void {
    const result = transitionWorkflow({ entityId: workflow.id, currentStatus: workflow.status, expectedStatus: workflow.status, event, actor });
    if (!result.ok) throw new Error(`Invalid pre-approval workflow transition: ${workflow.status}/${event}`);
    this.context.database.prepare("UPDATE channel_workflows SET status=?, updated_at=? WHERE id=?").run(result.to, now, workflow.id);
    this.ports.recordStateTransitionEvent({ workspaceId: workflow.workspaceId, entityType: "workflow", entityId: workflow.id,
      fromStatus: result.from, toStatus: result.to, event, actor, reason, createdAt: now });
  }
  private stepTransition(step: ChannelWorkflowStep, event: Parameters<typeof transitionWorkflowStep>[0]["event"],
    now: string, reason = "workflow_pre_approval", actor: "system" | "local-user" = "system"): void {
    const result = transitionWorkflowStep({ entityId: step.id, currentStatus: step.status, expectedStatus: step.status, event, actor });
    if (!result.ok) throw new Error(`Invalid pre-approval step transition: ${step.status}/${event}`);
    this.context.database.prepare("UPDATE channel_workflow_steps SET status=?, updated_at=? WHERE id=?").run(result.to, now, step.id);
    this.ports.recordStateTransitionEvent({ workspaceId: step.workspaceId, entityType: "workflow_step", entityId: step.id,
      fromStatus: result.from, toStatus: result.to, event, actor, reason, createdAt: now });
  }
  private transaction<T>(operation: () => T): T {
    this.context.database.exec("BEGIN IMMEDIATE;");
    try { const result = operation(); this.context.database.exec("COMMIT;"); return result; }
    catch (error) {
      try { this.context.database.exec("ROLLBACK;"); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], "Workflow pre-approval transaction and rollback failed"); }
      throw error;
    }
  }
}

function isCurrentPreAdmission(step: ChannelWorkflowStep): boolean {
  const marker = step.metadata?.preStepApprovalMarker;
  const hasUnconsumedMarker = Boolean(step.metadata?.preStepApprovalId
    && isWorkflowPreGateMarkerV1(marker) && !marker.consumedByTaskId);
  return (step.status === "waiting_for_approval" || step.status === "running" || step.status === "blocked")
    && !step.taskId && !step.runId && !step.metadata?.startOwner
    && (step.metadata?.activeGateStage === "pre" || hasUnconsumedMarker);
}

function isApprovedPreAdmissionHolding(
  step: ChannelWorkflowStep,
  inspection: Extract<WorkflowPreGateInspection, { readonly status: "approved" }>,
): boolean {
  const marker = step.metadata?.preStepApprovalMarker;
  return (step.status === "running" || step.status === "blocked") && step.metadata?.activeGateStage === undefined
    && step.metadata?.preStepApprovalId === inspection.approval.id
    && isWorkflowPreGateMarkerV1(marker) && !marker.consumedByTaskId
    && marker.basis.fingerprint === inspection.basis.fingerprint
    && !step.taskId && !step.runId && !step.metadata?.startOwner;
}
