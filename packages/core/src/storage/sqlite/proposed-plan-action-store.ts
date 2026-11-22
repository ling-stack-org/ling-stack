import { createWorkflowParticipantAuthorityV1 } from "@ling-stack/contracts";
import { createProposedPlanArtifactId, type ProposedPlanArtifact, type RunStore } from "../../run-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { assertProposedPlanRevision, assertProposedPlanSnapshot, parseProposedPlanStageDecision, planStageBallotKey, proposedPlanHasAcceptance, ProposedPlanMutationError,
  type ApplyProposedPlanArtifactActionInput, type ProposedPlanArtifactActionResult, type ProposedPlanWorkflowStepPreviewInput } from "../../proposed-plan-mutation.js";
import type { SqliteStoreContext } from "./store-context.js";

type Ports = Pick<RunStore, "getLingThread" | "getProposedPlanArtifact" | "upsertProposedPlanArtifact"
  | "createTask" | "createChannelWorkflow" | "createChannelWorkflowStep">;
type ActionPatch = Partial<Pick<ProposedPlanArtifact, "status" | "savedAt" | "archivedAt" | "acceptedAt"
  | "acceptedTaskId" | "convertedAt" | "acceptedWorkflowId" | "acceptedWorkflowStepId" | "supersededByPlanId">>;

/** One synchronous, same-database transaction owns each complete proposed-plan action. */
export class SqliteProposedPlanActionStore {
  constructor(private readonly context: SqliteStoreContext, private readonly ports: Ports,
    private readonly hasWorkItemWorkflowBinding: (workflowId: string) => boolean) {}

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
      if (input.action === "refine") return { plan: this.refine(plan, now, input.refinedDraft) };
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
        const parent = plan.parentPlanId && this.ports.getProposedPlanArtifact(plan.parentPlanId);
        if (parent && parent.supersededByPlanId === plan.id && parent.acceptedWorkflowId
          && this.hasWorkItemWorkflowBinding(parent.acceptedWorkflowId)) {
          throw new ProposedPlanMutationError("work_item_workflow_replan_required",
            "Accept this successor as a Workflow and bind it to the predecessor Work Item.");
        }
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
      const previews = input.workflowStepPreviews ?? [];
      const order = orderWorkflowStages(steps, previews);
      const ballots = planStageBallots(canonicalPlan.id, previews);
      const workflow = this.ports.createChannelWorkflow({ channelId: thread.channelId, title: workflowTitle,
        objective: steps.join("\n"), status: "draft", createdBy: input.createdBy || "local-user",
        metadata: { sourceMessageId: plan.sourceMessageId, sourceProposedPlanId: plan.id } }, now);
      const stepIds = new Map<string, string>();
      let firstStepId: string | undefined;
      for (const index of order) {
        const title = steps[index]!;
        const preview = previews[index];
        const ballot = preview?.stageId ? ballots.get(preview.stageId) : undefined;
        const dependencies = preview?.dependsOnStageIds?.filter(id => !preview.requiredDecision?.ballot?.voterStageIds.includes(id));
        const ownerId = preview?.ownerId || input.toParticipantId || "local-user";
        const step = this.ports.createChannelWorkflowStep({ workflowId: workflow.id, position: index + 1,
          title: steps.length > 1 ? title : `Implement ${workflowTitle}`,
          prompt: [title, "", `Source proposed plan: ${canonicalPlan.id}`,
            canonicalPlan.sourceMessageId ? `Source message: ${canonicalPlan.sourceMessageId}` : "",
            ballot?.prompt].filter(Boolean).join("\n"),
          toParticipantId: ownerId, toParticipantLabel: preview?.ownerLabel || input.toParticipantLabel || "Unassigned",
          participantAuthority: createWorkflowParticipantAuthorityV1({ kind: "workflow_definition", origin: "proposed_plan",
            participantId: ownerId, sourceId: canonicalPlan.id }), status: "queued", metadata: {
              sourceMessageId: canonicalPlan.sourceMessageId,
              ...(preview?.stageId ? { planStageId: preview.stageId } : {}),
              ...(dependencies?.length ? { dependsOnStepIds: dependencies.map(id => stepIds.get(id)!) } : {}),
              ...(preview?.handoffFromStageIds?.length ? { requiredPlanHandoffStepIds: preview.handoffFromStageIds.map(id => stepIds.get(id)!) } : {}),
              ...(preview?.requiredDecision ? { requiredPlanDecision: preview.requiredDecision } : {}),
              ...(preview?.requiredTools ? { requiredTools: preview.requiredTools } : {}),
              ...(ballot ? { planBallotKey: ballot.key, requiredTools: [], policy: {
                onRunFailed: "skip_if_optional", onRunCancelled: "skip_if_optional",
                onApprovalDenied: "skip_if_optional", retryable: false,
              } } : {}),
            } }, now);
        if (preview?.stageId) stepIds.set(preview.stageId, step.id);
        if (index === 0) firstStepId = step.id;
      }
      return { plan: this.update(plan, { status: "accepted",
        acceptedAt: plan.acceptedAt ?? now, convertedAt: plan.convertedAt ?? now,
        acceptedWorkflowId: workflow.id, acceptedWorkflowStepId: firstStepId }, now),
      workflowId: workflow.id, workflowStepId: firstStepId };
    });
  }

  private refine(parent: ProposedPlanArtifact, now: string, draft?: ApplyProposedPlanArtifactActionInput["refinedDraft"]): ProposedPlanArtifact {
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
      if (draft && (draft.title !== child.title || draft.bodyMarkdown !== child.bodyMarkdown)) {
        throw new ProposedPlanMutationError("proposed_plan_revision_conflict", "Review the existing successor before editing its draft.");
      }
      return child;
    }
    const version = (parent.version ?? 1) + 1;
    if (!Number.isSafeInteger(version)) throw new ProposedPlanMutationError("proposed_plan_lineage_conflict", "The plan lineage version cannot advance safely.");
    const child = this.ports.upsertProposedPlanArtifact({ id: createProposedPlanArtifactId(), threadId: parent.threadId,
      channelId: parent.channelId, goalId: parent.goalId, sourceAgentId: parent.sourceAgentId, ownerAgentId: parent.ownerAgentId,
      sourceTurnId: parent.sourceTurnId, sourceMessageId: parent.sourceMessageId, sourceRunId: parent.sourceRunId,
      parentPlanId: parent.id, planGroupId: group, version,
      title: draft?.title ?? parent.title, bodyMarkdown: draft?.bodyMarkdown ?? parent.bodyMarkdown, status: "draft" }, now);
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

function planStageBallots(planId: string, previews: readonly ProposedPlanWorkflowStepPreviewInput[]) {
  const stages = new Map(previews.map(preview => [preview.stageId, preview]));
  const result = new Map<string, { readonly key: string; readonly prompt: string }>();
  const invalid = () => new ProposedPlanMutationError("bad_workflow_stage_ballot",
    "Each ballot needs distinct assigned, tool-free voter stages among the decision stage's prerequisites.", 400);
  for (const preview of previews) {
    const decision = preview.requiredDecision;
    if (!preview.stageId || !decision?.ballot) continue;
    const key = planStageBallotKey(planId, preview.stageId, decision);
    const participantIds = new Set<string>();
    const roster = new Set(decision.ballot.voterStageIds);
    for (const id of roster) {
      const voter = stages.get(id);
      if (!voter?.ownerId || !preview.dependsOnStageIds?.includes(id) || voter.requiredTools?.length
        || voter.requiredDecision || participantIds.has(voter.ownerId) || result.has(id)) throw invalid();
      const predecessors = new Set(voter.dependsOnStageIds);
      for (const predecessor of predecessors) {
        if (roster.has(predecessor)) throw invalid();
        for (const dependency of stages.get(predecessor)?.dependsOnStageIds ?? []) predecessors.add(dependency);
      }
      participantIds.add(voter.ownerId);
      result.set(id, { key, prompt: [
        "Record your independent vote on the accepted Plan decision.", decision.question,
        `Options: ${JSON.stringify(decision.options)}`,
        `Return only JSON with ballotKey "${key}", option (one exact option or null to abstain), and a brief rationale.`,
      ].join("\n") });
    }
  }
  return result;
}

function orderWorkflowStages(titles: readonly string[], previews: readonly ProposedPlanWorkflowStepPreviewInput[]): readonly number[] {
  const positions = titles.map((_, index) => index);
  if (!previews.some(stage => stage.stageId !== undefined || stage.dependsOnStageIds !== undefined
    || stage.requiredDecision !== undefined || stage.handoffFromStageIds !== undefined)) return positions;
  const invalid = (message: string) => new ProposedPlanMutationError("bad_workflow_stage_dependencies", message, 400);
  if (titles.length !== previews.length || titles.length > 50) throw invalid("Provide one preview per stage, up to 50 stages.");
  const stages = new Map<string, number>();
  for (const [index, stage] of previews.entries()) {
    if (!stage.stageId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(stage.stageId) || stages.has(stage.stageId)
      || stage.title !== titles[index]) throw invalid("Workflow stages require unique identifiers and matching titles.");
    if (stage.requiredDecision !== undefined) parseProposedPlanStageDecision(stage.requiredDecision);
    stages.set(stage.stageId, index);
  }
  const ordered = new Set<number>();
  const visiting = new Set<number>();
  const visit = (index: number): void => {
    if (ordered.has(index)) return;
    if (visiting.has(index)) throw invalid("Workflow stage dependencies must be acyclic.");
    visiting.add(index);
    const dependencies = previews[index]?.dependsOnStageIds ?? [];
    const preview = previews[index];
    if (dependencies.length > 20 || new Set(dependencies).size !== dependencies.length) {
      throw invalid("Each stage can depend on up to 20 different stages.");
    }
    if (preview?.handoffFromStageIds !== undefined) {
      const handoffs = preview.handoffFromStageIds;
      if (!Array.isArray(handoffs) || handoffs.length > 20 || new Set(handoffs).size !== handoffs.length
        || handoffs.some(id => !dependencies.includes(id) || preview.requiredDecision?.ballot?.voterStageIds.includes(id))) {
        throw invalid("Handoffs require distinct prerequisite stages that produce implementation evidence.");
      }
    }
    for (const id of dependencies) {
      const dependency = stages.get(id);
      if (dependency === undefined) throw invalid(`Unknown prerequisite stage: ${id}`);
      visit(dependency);
    }
    visiting.delete(index);
    ordered.add(index);
  };
  positions.forEach(visit);
  return [...ordered];
}

const actionColumns = { status: "status", savedAt: "saved_at", archivedAt: "archived_at", acceptedAt: "accepted_at",
  acceptedTaskId: "accepted_task_id", convertedAt: "converted_at", acceptedWorkflowId: "accepted_workflow_id",
  acceptedWorkflowStepId: "accepted_workflow_step_id", supersededByPlanId: "superseded_by_plan_id" } as const;
function notFound(): ProposedPlanMutationError {
  return new ProposedPlanMutationError("proposed_plan_not_found", "The proposed plan or its owning thread was not found.", 404);
}
