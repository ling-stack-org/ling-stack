import { createWorkflowParticipantAuthorityV1 } from "@ling-stack/contracts";
import { createProposedPlanArtifactId, type ProposedPlanArtifact, type RunStore } from "../../run-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { assertProposedPlanRevision, assertProposedPlanSnapshot, proposedPlanHasAcceptance, ProposedPlanMutationError,
  type ApplyProposedPlanArtifactActionInput, type ProposedPlanArtifactActionResult } from "../../proposed-plan-mutation.js";
import type { SqliteStoreContext } from "./store-context.js";

type Ports = Pick<RunStore, "getLingThread" | "getProposedPlanArtifact" | "upsertProposedPlanArtifact"
  | "createTask" | "createChannelWorkflow" | "createChannelWorkflowStep">;
type ActionPatch = Partial<Pick<ProposedPlanArtifact, "status" | "savedAt" | "archivedAt" | "acceptedAt"
  | "acceptedTaskId" | "convertedAt" | "acceptedWorkflowId" | "acceptedWorkflowStepId" | "supersededByPlanId">>;

/** One synchronous, same-database transaction owns each complete proposed-plan action. */
export class SqliteProposedPlanActionStore {
  constructor(private readonly context: SqliteStoreContext, private readonly ports: Ports) {}

  applyProposedPlanArtifactAction(planId: string, input: ApplyProposedPlanArtifactActionInput, now: string): ProposedPlanArtifactActionResult {
    if (!["accept", "refine", "save", "archive", "convert-workflow"].includes(input.action)) {
      throw new ProposedPlanMutationError("bad_proposed_plan_action", "Unknown proposed-plan action.", 400);
    }
    return this.transaction(planId, () => {
      const thread = this.ports.getLingThread(input.threadId);
      if (!thread || thread.workspaceId !== DEFAULT_WORKSPACE_ID) throw notFound();
      let plan = this.ports.getProposedPlanArtifact(planId);
      if (plan && plan.threadId !== thread.id) throw notFound();
      assertProposedPlanRevision(input.expectedRevision, plan?.revision);
      if (plan && input.plan) assertProposedPlanSnapshot(plan, input.plan);
      if (!plan) {
        if (!input.plan) throw notFound();
        if (input.plan.threadId !== thread.id || input.plan.id !== undefined && input.plan.id !== planId) throw notFound();
        if (input.plan.status !== undefined && input.plan.status !== "draft") {
          throw new ProposedPlanMutationError("proposed_plan_action_owned", "A new action payload must be a draft plan.");
        }
        plan = this.ports.upsertProposedPlanArtifact({ ...input.plan, id: planId, threadId: thread.id }, now);
      }
      if (input.action === "save") return { plan: this.update(plan, { savedAt: now }, now) };
      if (input.action === "archive") return { plan: this.update(plan, { status: "archived", archivedAt: plan.archivedAt ?? now }, now) };
      if (input.action === "refine") return { plan: this.refine(plan, now) };
      if (input.action === "accept" && plan.acceptedTaskId) return { plan, taskId: plan.acceptedTaskId, runId: plan.acceptedRunId };
      if (input.action === "convert-workflow" && plan.acceptedWorkflowId) return { plan, workflowId: plan.acceptedWorkflowId,
        workflowStepId: plan.acceptedWorkflowStepId, runId: plan.acceptedRunId };
      if (plan.status !== "draft" && plan.status !== "accepted") {
        throw new ProposedPlanMutationError("proposed_plan_lifecycle_conflict", "Refine an archived or superseded plan before creating new work.");
      }
      if (!thread.channelId || plan.channelId !== undefined && plan.channelId !== thread.channelId) {
        throw new ProposedPlanMutationError("proposed_plan_channel_required", "Accepting or converting a plan requires its owning channel thread.");
      }
      if (input.action === "accept") {
        const task = this.ports.createTask({ channelId: thread.channelId, title: `Implement accepted plan: ${plan.title}`,
          prompt: [`Implement accepted plan: ${plan.title}`, "", plan.bodyMarkdown, "", `Source proposed plan: ${plan.id}`,
            plan.sourceMessageId ? `Source message: ${plan.sourceMessageId}` : ""].filter(Boolean).join("\n"),
          requestedSkillId: "plan-acceptance" }, now);
        return { plan: this.update(plan, { status: "accepted",
          acceptedAt: plan.acceptedAt ?? now, acceptedTaskId: task.id }, now), taskId: task.id };
      }
      const canonicalPlan = plan;
      const workflowTitle = input.workflowTitle || plan.title;
      const steps = input.workflowSteps?.length ? input.workflowSteps
        : input.workflowStepPreviews?.length ? input.workflowStepPreviews.map(value => value.title) : [plan.bodyMarkdown];
      if (steps.some(step => typeof step !== "string" || !step.trim())) {
        throw new ProposedPlanMutationError("bad_workflow_steps", "Workflow steps must be nonempty strings.", 400);
      }
      const workflow = this.ports.createChannelWorkflow({ channelId: thread.channelId, title: workflowTitle,
        objective: steps.join("\n"), status: "draft", createdBy: input.createdBy || "local-user",
        metadata: { sourceMessageId: plan.sourceMessageId } }, now);
      const createdSteps = steps.map((title, index) => {
        const preview = input.workflowStepPreviews?.[index];
        const ownerId = preview?.ownerId || input.toParticipantId || "local-user";
        return this.ports.createChannelWorkflowStep({ workflowId: workflow.id,
          title: steps.length > 1 ? title : `Implement ${workflowTitle}`,
          prompt: [title, "", `Source proposed plan: ${canonicalPlan.id}`,
            canonicalPlan.sourceMessageId ? `Source message: ${canonicalPlan.sourceMessageId}` : ""].filter(Boolean).join("\n"),
          toParticipantId: ownerId, toParticipantLabel: preview?.ownerLabel || input.toParticipantLabel || "Unassigned",
          participantAuthority: createWorkflowParticipantAuthorityV1({ kind: "workflow_definition", origin: "proposed_plan",
            participantId: ownerId, sourceId: canonicalPlan.id }), status: "queued", metadata: { sourceMessageId: canonicalPlan.sourceMessageId } }, now);
      });
      return { plan: this.update(plan, { status: "accepted",
        acceptedAt: plan.acceptedAt ?? now, convertedAt: plan.convertedAt ?? now,
        acceptedWorkflowId: workflow.id, acceptedWorkflowStepId: createdSteps[0]?.id }, now),
      workflowId: workflow.id, workflowStepId: createdSteps[0]?.id };
    });
  }

  private refine(parent: ProposedPlanArtifact, now: string): ProposedPlanArtifact {
    const group = parent.planGroupId ?? parent.id;
    if (!Number.isSafeInteger(parent.version ?? 1) || (parent.version ?? 1) < 1) {
      throw new ProposedPlanMutationError("proposed_plan_lineage_conflict", "The parent plan has an invalid lineage version.");
    }
    if (parent.supersededByPlanId) {
      const child = this.ports.getProposedPlanArtifact(parent.supersededByPlanId);
      if (!child || child.parentPlanId !== parent.id || child.planGroupId !== group
        || child.threadId !== parent.threadId || child.workspaceId !== parent.workspaceId
        || child.version !== (parent.version ?? 1) + 1) {
        throw new ProposedPlanMutationError("proposed_plan_lineage_conflict", "The existing refined successor has inconsistent lineage.");
      }
      return child;
    }
    const version = (parent.version ?? 1) + 1;
    if (!Number.isSafeInteger(version)) throw new ProposedPlanMutationError("proposed_plan_lineage_conflict", "The plan lineage version cannot advance safely.");
    const child = this.ports.upsertProposedPlanArtifact({ id: createProposedPlanArtifactId(), threadId: parent.threadId,
      channelId: parent.channelId, goalId: parent.goalId, sourceAgentId: parent.sourceAgentId, ownerAgentId: parent.ownerAgentId,
      sourceTurnId: parent.sourceTurnId, sourceMessageId: parent.sourceMessageId, sourceRunId: parent.sourceRunId,
      parentPlanId: parent.id, planGroupId: group, version, title: parent.title, bodyMarkdown: parent.bodyMarkdown, status: "draft" }, now);
    this.update(parent, { supersededByPlanId: child.id,
      ...(parent.status === "draft" && !proposedPlanHasAcceptance(parent) ? { status: "superseded" as const } : {}) }, now);
    return child;
  }

  private update(plan: ProposedPlanArtifact, patch: ActionPatch, now: string): ProposedPlanArtifact {
    const fields = (Object.keys(patch) as (keyof ActionPatch)[]).filter(field => patch[field] !== undefined && patch[field] !== plan[field]);
    if (!fields.length) return plan;
    if (!Number.isSafeInteger(plan.revision) || plan.revision >= Number.MAX_SAFE_INTEGER) {
      throw new ProposedPlanMutationError("proposed_plan_revision_conflict", "The proposed-plan revision cannot advance safely.");
    }
    const result = this.context.database.prepare(`UPDATE ling_thread_proposed_plans
      SET ${fields.map(field => `${actionColumns[field]}=?`).join(",")}, revision=revision+1, updated_at=?
      WHERE workspace_id=? AND id=? AND revision=? AND status=?`)
      .run(...fields.map(field => patch[field] ?? null), now, DEFAULT_WORKSPACE_ID, plan.id, plan.revision, plan.status);
    if (Number(result.changes) !== 1) throw new ProposedPlanMutationError("proposed_plan_revision_conflict", "The proposed-plan action lost its canonical revision.");
    const updated = this.ports.getProposedPlanArtifact(plan.id);
    if (!updated) throw notFound();
    return updated;
  }

  /** SAVEPOINT composes with existing callers; the first write precedes every authoritative read. */
  private transaction<T>(planId: string, operation: () => T): T {
    this.context.database.exec("SAVEPOINT proposed_plan_action");
    try {
      this.context.database.prepare("UPDATE ling_thread_proposed_plans SET revision=revision WHERE workspace_id=? AND id=?")
        .run(DEFAULT_WORKSPACE_ID, planId);
      const result = operation();
      this.context.database.exec("RELEASE proposed_plan_action");
      return result;
    } catch (error) {
      try {
        this.context.database.exec("ROLLBACK TO proposed_plan_action");
        this.context.database.exec("RELEASE proposed_plan_action");
      } catch { /* Never replace the original inserted-row or CAS failure. */ }
      throw error;
    }
  }
}

const actionColumns = { status: "status", savedAt: "saved_at", archivedAt: "archived_at", acceptedAt: "accepted_at",
  acceptedTaskId: "accepted_task_id", convertedAt: "converted_at", acceptedWorkflowId: "accepted_workflow_id",
  acceptedWorkflowStepId: "accepted_workflow_step_id", supersededByPlanId: "superseded_by_plan_id" } as const;
function notFound(): ProposedPlanMutationError {
  return new ProposedPlanMutationError("proposed_plan_not_found", "The proposed plan or its owning thread was not found.", 404);
}
