import type { SQLOutputValue } from "node:sqlite";
import {
  createWorkflowParticipantAuthorityV1,
  delegatedStepFinalizationBasisFingerprintV1,
  isConversationContextProjectionMetadata,
  isDelegatedOutcomeV1,
  isDelegatedStepRequirementV1,
  isWorkflowCompletionGateV1,
  isWorkflowParticipantAuthorityV1,
  isWorkflowParticipantProviderBindingV1,
  workflowGraphFingerprintV1,
} from "@ling-stack/contracts";
import type {
  DelegatedEvidenceRefV1,
  DelegatedOutcomeV1,
  WorkflowCompletionGateV1,
} from "@ling-stack/contracts";
import type { RunEventEnvelope, RunStore } from "../../run-types.js";
import { assertDelegationCompletionSatisfied } from "../../delegation-completion-barrier.js";
import {
  buildWorkflowCompletionExpectedReadSet,
  workflowCompletionGateBasisFingerprintV1,
  type WorkflowCompletionEvaluationV1,
} from "../../workflow-completion-read-set.js";
import type { CreateStateTransitionEventInput, StateTransitionEvent } from "../../channel-runtime-types.js";
import {
  transitionWorkflow,
  transitionWorkflowStep,
  type StateTransitionActor,
  type TransitionResult,
  type WorkflowStepTransitionEvent,
  type WorkflowTransitionEvent,
} from "../../state-machines.js";
import {
  DEFAULT_WORKSPACE_ID,
  createChannelWorkflowId,
  createChannelWorkflowStepId,
  createWorkflowHandoffIntentId,
  createWorkflowSelectorDecisionId,
  type ChannelWorkflow,
  type ChannelWorkflowStatus,
  type ChannelWorkflowStep,
  type ChannelWorkflowStepStatus,
  type CreateChannelWorkflowInput,
  type CreateChannelWorkflowStepInput,
  type CreateOrReuseChannelHandoffWorkflowInput,
  type CreateOrReuseChannelHandoffWorkflowResult,
  type CreateWorkflowHandoffIntentInput,
  type CreateWorkflowSelectorDecisionInput,
  type ListChannelWorkflowsOptions,
  type ListChannelWorkflowStepsOptions,
  type ListWorkflowHandoffIntentsOptions,
  type ListWorkflowSelectorDecisionsOptions,
  type UpdateChannelWorkflowInput,
  type UpdateChannelWorkflowStepInput,
  type UpdateWorkflowHandoffIntentInput,
  type UpdateWorkflowSelectorDecisionInput,
  type WorkflowHandoffIntent,
  type WorkflowHandoffIntentStatus,
  type WorkflowHandoffValidation,
  type WorkflowPacketSourceRef,
  type WorkflowSelectorAlternative,
  type WorkflowSelectorDecision,
  type WorkflowSelectorDecisionStatus,
  type WorkflowSelectorTargetKind,
} from "../../workspace-types.js";
import { nullableUpdate, readNumber, rollbackOwnedSqliteTransaction, stringifyJson } from "./helpers.js";
import {
  mapChannelWorkflow,
  mapChannelWorkflowStep,
  mapWorkflowHandoffIntent,
  mapWorkflowSelectorDecision,
} from "./channel-workflow-mappers.js";
import {
  channelWorkflowSelectSql,
  channelWorkflowStepSelectSql,
  workflowHandoffIntentSelectSql,
  workflowSelectorDecisionSelectSql,
} from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";
import { classifyWorkflowStepStartOwner, workflowStepStartOwnerMatches,
  type WorkflowStepStartOwnerV1, type WorkflowStepStartReadStore } from "../../workflow-step-start-owner.js";

type FinalizableDelegatedOutcomeV1 = Exclude<DelegatedOutcomeV1, { readonly kind: "workflow_started" }>;

export interface SqliteChannelWorkflowStorePorts {
  readonly assertChannelExists: (channelId: string) => void;
  readonly assertHandoffInChannel: (channelId: string, handoffId: string) => void;
  readonly assertContextSummaryInChannel: (channelId: string, contextSummaryId: string) => void;
  readonly assertTaskInChannel: (channelId: string, taskId: string) => void;
  readonly assertRunInChannel: (channelId: string, runId: string) => void;
  readonly assertWorkflowCoordinationRefsInChannel: (
    channelId: string,
    refs: {
      readonly workflowId?: string;
      readonly workflowStepId?: string;
      readonly runId?: string;
      readonly messageId?: string;
      readonly handoffId?: string;
    },
  ) => void;
  readonly assertWorkflowSelectorTargetsInChannel: (
    channelId: string,
    input: Pick<CreateWorkflowSelectorDecisionInput, "workflowId" | "selectedWorkflowStepId" | "selectedTeammateId" | "selectedHandoffIntentId">,
  ) => void;
  readonly assertWorkflowPacketSourceRefsInChannel: (channelId: string, sourceRefs: readonly WorkflowPacketSourceRef[]) => void;
  readonly findStateTransitionByIdempotency: (
    entityType: "workflow" | "workflow_step",
    entityId: string,
    idempotencyKey: string,
  ) => StateTransitionEvent | undefined;
  readonly recordStateTransitionEvent: (input: CreateStateTransitionEventInput) => StateTransitionEvent;
  readonly releaseResourceLeasesForWorkflowStep: (workflowStepId: string, releasedAt: string) => number;
  readonly releaseResourceLease: import("../../run-types.js").RunStore["releaseResourceLease"];
  readonly workflowStepStartReadStore: WorkflowStepStartReadStore;
  readonly getChannelIntentDecision: (id: string) => import("../../workspace-types.js").ChannelIntentDecision | undefined;
  readonly getRun: (id: string) => import("../../run-types.js").RunSession | undefined;
  readonly listEvents: (runId: string, options?: import("../../run-types.js").ListRunEventsOptions) => import("../../run-types.js").RunEventEnvelope[];
  readonly countEvents: (runId: string) => number;
  readonly listApprovalRequests: (options?: import("../../approval-types.js").ListApprovalRequestsOptions) => import("../../approval-types.js").ApprovalRequest[];
  readonly getArtifact: (id: string) => import("../../run-types.js").RunArtifact | undefined;
  readonly listArtifacts: (runId: string) => import("../../run-types.js").RunArtifact[];
  readonly getDelegationCompletionEvidence: import("../../run-types.js").RunStore["getDelegationCompletionEvidence"];
}

function completionTarget(
  gateStatus: WorkflowCompletionGateV1["status"],
  currentStatus: ChannelWorkflowStatus,
): ChannelWorkflowStatus | undefined {
  if (gateStatus === "pending") {
    return currentStatus === "running" || currentStatus === "waiting_for_approval"
      ? currentStatus
      : undefined;
  }
  if (gateStatus === "verified") {
    return currentStatus === "running" || currentStatus === "succeeded"
      ? "succeeded"
      : undefined;
  }
  if (gateStatus === "blocked") {
    return currentStatus === "running" || currentStatus === "waiting_for_approval" || currentStatus === "blocked"
      ? "blocked"
      : undefined;
  }
  if (gateStatus === "failed") {
    return currentStatus === "running" || currentStatus === "waiting_for_approval"
      || currentStatus === "blocked" || currentStatus === "failed"
      ? "failed"
      : undefined;
  }
  return currentStatus === "draft" || currentStatus === "ready" || currentStatus === "running"
    || currentStatus === "waiting_for_approval" || currentStatus === "blocked" || currentStatus === "cancelled"
    ? "cancelled"
    : undefined;
}

function completionTransitionEvent(targetStatus: ChannelWorkflowStatus): WorkflowTransitionEvent {
  if (targetStatus === "succeeded") return "all_steps_succeeded";
  if (targetStatus === "blocked") return "step_blocked";
  if (targetStatus === "failed") return "step_failed";
  if (targetStatus === "cancelled") return "cancel";
  throw new Error(`No workflow completion transition event for target status: ${targetStatus}`);
}

export class SqliteChannelWorkflowStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteChannelWorkflowStorePorts,
  ) {}

  createWorkflowHandoffIntent(input: CreateWorkflowHandoffIntentInput, now: string): WorkflowHandoffIntent {
    this.ports.assertChannelExists(input.channelId);
    this.ports.assertWorkflowCoordinationRefsInChannel(input.channelId, {
      workflowId: input.workflowId,
      workflowStepId: input.sourceWorkflowStepId,
      runId: input.sourceRunId,
      messageId: input.sourceMessageId,
      handoffId: input.channelHandoffId,
    });
    this.ports.assertWorkflowPacketSourceRefsInChannel(input.channelId, input.sourceRefs ?? []);
    const intent: WorkflowHandoffIntent = {
      schemaVersion: 1,
      id: createWorkflowHandoffIntentId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      workflowId: input.workflowId,
      sourceWorkflowStepId: input.sourceWorkflowStepId,
      sourceRunId: input.sourceRunId,
      sourceMessageId: input.sourceMessageId,
      channelHandoffId: input.channelHandoffId,
      fromParticipantId: input.fromParticipantId,
      fromParticipantLabel: input.fromParticipantLabel,
      toParticipantId: input.toParticipantId,
      toParticipantLabel: input.toParticipantLabel,
      reason: input.reason,
      requiredInput: input.requiredInput,
      expectedOutput: input.expectedOutput,
      riskSummary: input.riskSummary,
      sourceRefs: [...(input.sourceRefs ?? [])],
      agentContext: input.agentContext,
      status: input.status ?? "proposed",
      validation: input.validation,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    validateWorkflowHandoffIntent(intent);
    this.context.database
      .prepare(`
        INSERT INTO workflow_handoff_intents (
          id,
          workspace_id,
          channel_id,
          workflow_id,
          source_workflow_step_id,
          source_run_id,
          source_message_id,
          channel_handoff_id,
          from_participant_id,
          from_participant_label,
          to_participant_id,
          to_participant_label,
          reason,
          required_input,
          expected_output,
          risk_summary,
          source_refs_json,
          agent_context_json,
          status,
          validation_json,
          created_by,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        intent.id,
        intent.workspaceId,
        intent.channelId,
        intent.workflowId ?? null,
        intent.sourceWorkflowStepId ?? null,
        intent.sourceRunId ?? null,
        intent.sourceMessageId ?? null,
        intent.channelHandoffId ?? null,
        intent.fromParticipantId,
        intent.fromParticipantLabel,
        intent.toParticipantId,
        intent.toParticipantLabel ?? null,
        intent.reason,
        intent.requiredInput,
        intent.expectedOutput,
        intent.riskSummary ?? null,
        stringifyJson(intent.sourceRefs),
        intent.agentContext ? stringifyJson(intent.agentContext) : null,
        intent.status,
        intent.validation ? stringifyJson(intent.validation) : null,
        intent.createdBy,
        intent.createdAt,
        intent.updatedAt,
      );
    const created = this.getWorkflowHandoffIntent(intent.id);
    if (!created) {
      throw new Error(`Failed to create workflow handoff intent: ${intent.id}`);
    }
    return created;
  }

  getWorkflowHandoffIntent(id: string): WorkflowHandoffIntent | undefined {
    const row = this.context.database.prepare(workflowHandoffIntentSelectSql("WHERE id = ?")).get(id);
    return row ? mapWorkflowHandoffIntent(row as Record<string, SQLOutputValue>) : undefined;
  }

  listWorkflowHandoffIntents(options: ListWorkflowHandoffIntentsOptions = {}): WorkflowHandoffIntent[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.workflowId) {
      clauses.push("workflow_id = ?");
      params.push(options.workflowId);
    }
    if (options.channelHandoffId) {
      clauses.push("channel_handoff_id = ?");
      params.push(options.channelHandoffId);
    }
    if (options.sourceWorkflowStepId) {
      clauses.push("source_workflow_step_id = ?");
      params.push(options.sourceWorkflowStepId);
    }
    if (options.sourceRunId) {
      clauses.push("source_run_id = ?");
      params.push(options.sourceRunId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.context.database
      .prepare(`${workflowHandoffIntentSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, rowid DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapWorkflowHandoffIntent(row as Record<string, SQLOutputValue>));
  }

  updateWorkflowHandoffIntent(id: string, input: UpdateWorkflowHandoffIntentInput, now: string): WorkflowHandoffIntent | undefined {
    const existing = this.getWorkflowHandoffIntent(id);
    if (!existing) {
      return undefined;
    }
    const channelHandoffId = nullableUpdate(input.channelHandoffId, existing.channelHandoffId);
    if (channelHandoffId) {
      this.ports.assertHandoffInChannel(existing.channelId, channelHandoffId);
    }
    const sourceRefs = input.sourceRefs ? [...input.sourceRefs] : existing.sourceRefs;
    this.ports.assertWorkflowPacketSourceRefsInChannel(existing.channelId, sourceRefs);
    const agentContext = input.agentContext === null
      ? undefined
      : input.agentContext ?? existing.agentContext;
    const next: WorkflowHandoffIntent = {
      ...existing,
      channelHandoffId,
      toParticipantLabel: nullableUpdate(input.toParticipantLabel, existing.toParticipantLabel),
      reason: input.reason ?? existing.reason,
      requiredInput: input.requiredInput ?? existing.requiredInput,
      expectedOutput: input.expectedOutput ?? existing.expectedOutput,
      riskSummary: nullableUpdate(input.riskSummary, existing.riskSummary),
      sourceRefs,
      agentContext,
      status: input.status ?? existing.status,
      validation: nullableUpdate(input.validation, existing.validation),
      updatedAt: now,
    };
    validateWorkflowHandoffIntent(next);
    this.context.database
      .prepare(`
        UPDATE workflow_handoff_intents
        SET
          channel_handoff_id = ?,
          to_participant_label = ?,
          reason = ?,
          required_input = ?,
          expected_output = ?,
          risk_summary = ?,
          source_refs_json = ?,
          agent_context_json = ?,
          status = ?,
          validation_json = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.channelHandoffId ?? null,
        next.toParticipantLabel ?? null,
        next.reason,
        next.requiredInput,
        next.expectedOutput,
        next.riskSummary ?? null,
        stringifyJson(next.sourceRefs),
        next.agentContext ? stringifyJson(next.agentContext) : null,
        next.status,
        next.validation ? stringifyJson(next.validation) : null,
        next.updatedAt,
        id,
      );
    return this.getWorkflowHandoffIntent(id);
  }

  createWorkflowSelectorDecision(input: CreateWorkflowSelectorDecisionInput, now: string): WorkflowSelectorDecision {
    this.ports.assertChannelExists(input.channelId);
    this.ports.assertWorkflowCoordinationRefsInChannel(input.channelId, {
      workflowId: input.workflowId,
      workflowStepId: input.sourceWorkflowStepId,
    });
    this.ports.assertWorkflowSelectorTargetsInChannel(input.channelId, input);
    this.ports.assertWorkflowPacketSourceRefsInChannel(input.channelId, input.sourceRefs ?? []);
    const decision: WorkflowSelectorDecision = {
      schemaVersion: 1,
      id: createWorkflowSelectorDecisionId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      workflowId: input.workflowId,
      sourceWorkflowStepId: input.sourceWorkflowStepId,
      selectorNodeId: input.selectorNodeId,
      targetKind: input.targetKind,
      selectedWorkflowStepId: input.selectedWorkflowStepId,
      selectedGraphNodeId: input.selectedGraphNodeId,
      selectedTeammateId: input.selectedTeammateId,
      selectedSkillId: input.selectedSkillId,
      selectedHandoffIntentId: input.selectedHandoffIntentId,
      reason: input.reason,
      alternativesConsidered: [...(input.alternativesConsidered ?? [])],
      confidence: input.confidence ?? "medium",
      requiresUserConfirmation: input.requiresUserConfirmation ?? false,
      status: input.status ?? "accepted",
      sourceRefs: [...(input.sourceRefs ?? [])],
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    validateWorkflowSelectorDecision(decision);
    this.context.database
      .prepare(`
        INSERT INTO workflow_selector_decisions (
          id,
          workspace_id,
          channel_id,
          workflow_id,
          source_workflow_step_id,
          selector_node_id,
          target_kind,
          selected_workflow_step_id,
          selected_graph_node_id,
          selected_teammate_id,
          selected_skill_id,
          selected_handoff_intent_id,
          reason,
          alternatives_json,
          confidence,
          requires_user_confirmation,
          status,
          source_refs_json,
          created_by,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        decision.id,
        decision.workspaceId,
        decision.channelId,
        decision.workflowId,
        decision.sourceWorkflowStepId ?? null,
        decision.selectorNodeId ?? null,
        decision.targetKind,
        decision.selectedWorkflowStepId ?? null,
        decision.selectedGraphNodeId ?? null,
        decision.selectedTeammateId ?? null,
        decision.selectedSkillId ?? null,
        decision.selectedHandoffIntentId ?? null,
        decision.reason,
        stringifyJson(decision.alternativesConsidered),
        decision.confidence,
        decision.requiresUserConfirmation ? 1 : 0,
        decision.status,
        stringifyJson(decision.sourceRefs),
        decision.createdBy,
        decision.createdAt,
        decision.updatedAt,
      );
    const created = this.getWorkflowSelectorDecision(decision.id);
    if (!created) {
      throw new Error(`Failed to create workflow selector decision: ${decision.id}`);
    }
    return created;
  }

  getWorkflowSelectorDecision(id: string): WorkflowSelectorDecision | undefined {
    const row = this.context.database.prepare(workflowSelectorDecisionSelectSql("WHERE id = ?")).get(id);
    return row ? mapWorkflowSelectorDecision(row as Record<string, SQLOutputValue>) : undefined;
  }

  listWorkflowSelectorDecisions(options: ListWorkflowSelectorDecisionsOptions = {}): WorkflowSelectorDecision[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.workflowId) {
      clauses.push("workflow_id = ?");
      params.push(options.workflowId);
    }
    if (options.sourceWorkflowStepId) {
      clauses.push("source_workflow_step_id = ?");
      params.push(options.sourceWorkflowStepId);
    }
    if (options.selectedWorkflowStepId) {
      clauses.push("selected_workflow_step_id = ?");
      params.push(options.selectedWorkflowStepId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.context.database
      .prepare(`${workflowSelectorDecisionSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, rowid DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapWorkflowSelectorDecision(row as Record<string, SQLOutputValue>));
  }

  updateWorkflowSelectorDecision(id: string, input: UpdateWorkflowSelectorDecisionInput, now: string): WorkflowSelectorDecision | undefined {
    const existing = this.getWorkflowSelectorDecision(id);
    if (!existing) {
      return undefined;
    }
    const sourceRefs = input.sourceRefs ? [...input.sourceRefs] : existing.sourceRefs;
    this.ports.assertWorkflowPacketSourceRefsInChannel(existing.channelId, sourceRefs);
    const next: WorkflowSelectorDecision = {
      ...existing,
      reason: input.reason ?? existing.reason,
      alternativesConsidered: input.alternativesConsidered ? [...input.alternativesConsidered] : existing.alternativesConsidered,
      confidence: input.confidence ?? existing.confidence,
      requiresUserConfirmation: input.requiresUserConfirmation ?? existing.requiresUserConfirmation,
      status: input.status ?? existing.status,
      sourceRefs,
      updatedAt: now,
    };
    validateWorkflowSelectorDecision(next);
    this.context.database
      .prepare(`
        UPDATE workflow_selector_decisions
        SET
          reason = ?,
          alternatives_json = ?,
          confidence = ?,
          requires_user_confirmation = ?,
          status = ?,
          source_refs_json = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.reason,
        stringifyJson(next.alternativesConsidered),
        next.confidence,
        next.requiresUserConfirmation ? 1 : 0,
        next.status,
        stringifyJson(next.sourceRefs),
        next.updatedAt,
        id,
      );
    return this.getWorkflowSelectorDecision(id);
  }

  createChannelWorkflow(input: CreateChannelWorkflowInput, now: string): ChannelWorkflow {
    this.ports.assertChannelExists(input.channelId);
    if (input.sourceHandoffId) {
      this.ports.assertHandoffInChannel(input.channelId, input.sourceHandoffId);
    }

    const workflow: ChannelWorkflow = {
      id: createChannelWorkflowId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      sourceHandoffId: input.sourceHandoffId,
      title: input.title,
      objective: input.objective,
      status: input.status ?? "draft",
      createdBy: input.createdBy,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    };

    this.context.database
      .prepare(`
        INSERT INTO channel_workflows (
          id,
          workspace_id,
          channel_id,
          source_handoff_id,
          title,
          objective,
          status,
          created_by,
          metadata_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        workflow.id,
        workflow.workspaceId,
        workflow.channelId,
        workflow.sourceHandoffId ?? null,
        workflow.title,
        workflow.objective,
        workflow.status,
        workflow.createdBy,
        workflow.metadata ? stringifyJson(workflow.metadata) : null,
        workflow.createdAt,
        workflow.updatedAt,
      );

    const created = this.getChannelWorkflow(workflow.id);
    if (!created) {
      throw new Error(`Failed to create channel workflow: ${workflow.id}`);
    }
    return created;
  }

  createOrReuseChannelHandoffWorkflow(
    input: CreateOrReuseChannelHandoffWorkflowInput,
    now: string,
  ): CreateOrReuseChannelHandoffWorkflowResult {
    this.context.database.exec("BEGIN IMMEDIATE;");
    try {
      this.ports.assertChannelExists(input.channelId);
      this.ports.assertHandoffInChannel(input.channelId, input.sourceHandoffId);
      const existingWorkflow = this.getChannelWorkflowForHandoff(input.channelId, input.sourceHandoffId);
      if (existingWorkflow) {
        const existingStep = this.listChannelWorkflowSteps({ workflowId: existingWorkflow.id, complete: true })
          .find((step) => step.sourceHandoffId === input.sourceHandoffId)
          ?? this.createChannelWorkflowStep(
            {
              ...input.workflowStep,
              workflowId: existingWorkflow.id,
              sourceHandoffId: input.sourceHandoffId,
            },
            now,
          );
        this.context.database.exec("COMMIT;");
        return { workflow: existingWorkflow, workflowStep: existingStep, reused: true };
      }

      const workflow = this.createChannelWorkflow(
        {
          ...input.workflow,
          channelId: input.channelId,
          sourceHandoffId: input.sourceHandoffId,
        },
        now,
      );
      const workflowStep = this.createChannelWorkflowStep(
        {
          ...input.workflowStep,
          workflowId: workflow.id,
          sourceHandoffId: input.sourceHandoffId,
        },
        now,
      );
      this.context.database.exec("COMMIT;");
      return { workflow, workflowStep, reused: false };
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      throw error;
    }
  }

  getChannelWorkflow(id: string): ChannelWorkflow | undefined {
    const row = this.context.database.prepare(channelWorkflowSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelWorkflow(row as Record<string, SQLOutputValue>) : undefined;
  }

  getChannelWorkflowForHandoff(channelId: string, sourceHandoffId: string): ChannelWorkflow | undefined {
    const row = this.context.database
      .prepare(channelWorkflowSelectSql("WHERE workspace_id = ? AND channel_id = ? AND source_handoff_id = ? LIMIT 1"))
      .get(DEFAULT_WORKSPACE_ID, channelId, sourceHandoffId);
    return row ? mapChannelWorkflow(row as Record<string, SQLOutputValue>) : undefined;
  }

  listChannelWorkflows(options: ListChannelWorkflowsOptions): ChannelWorkflow[] {
    const clauses = ["workspace_id = ?", "channel_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.channelId];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.context.database
      .prepare(`${channelWorkflowSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, rowid DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapChannelWorkflow(row as Record<string, SQLOutputValue>));
  }

  listRecoverableChannelWorkflows(): ChannelWorkflow[] {
    return this.context.database
      .prepare(`${channelWorkflowSelectSql("WHERE workspace_id = ? AND status IN ('running', 'waiting_for_approval', 'blocked')")} ORDER BY updated_at ASC, rowid ASC LIMIT 500`)
      .all(DEFAULT_WORKSPACE_ID)
      .map((row) => mapChannelWorkflow(row as Record<string, SQLOutputValue>));
  }

  updateChannelWorkflow(id: string, input: UpdateChannelWorkflowInput, now: string): ChannelWorkflow | undefined {
    return this.withCompletionTransaction(() => this.updateChannelWorkflowWithinTransaction(id, input, now));
  }

  private updateChannelWorkflowWithinTransaction(id: string, input: UpdateChannelWorkflowInput, now: string): ChannelWorkflow | undefined {
    const existing = this.getChannelWorkflow(id);
    if (!existing) {
      return undefined;
    }
    const next: ChannelWorkflow = {
      ...existing,
      title: input.title ?? existing.title,
      objective: input.objective ?? existing.objective,
      status: input.status ?? existing.status,
      metadata: nullableUpdate(input.metadata, existing.metadata),
      updatedAt: now,
    };
    if (next.status === "succeeded") this.assertDescendantsComplete(id);
    this.context.database
      .prepare(`
        UPDATE channel_workflows
        SET title = ?, objective = ?, status = ?, metadata_json = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(next.title, next.objective, next.status, next.metadata ? stringifyJson(next.metadata) : null, next.updatedAt, id);
    return this.getChannelWorkflow(id);
  }

  transitionChannelWorkflowStatus(input: {
    readonly workflowId: string;
    readonly expectedStatus?: ChannelWorkflowStatus;
    readonly event: WorkflowTransitionEvent;
    readonly actor: StateTransitionActor;
    readonly reason?: string;
    readonly idempotencyKey?: string;
    readonly now: string;
  }): TransitionResult<ChannelWorkflowStatus> {
    return this.withCompletionTransaction(() => this.transitionChannelWorkflowWithinTransaction(input));
  }

  private transitionChannelWorkflowWithinTransaction(input: {
    readonly workflowId: string;
    readonly expectedStatus?: ChannelWorkflowStatus;
    readonly event: WorkflowTransitionEvent;
    readonly actor: StateTransitionActor;
    readonly reason?: string;
    readonly idempotencyKey?: string;
    readonly now: string;
  }): TransitionResult<ChannelWorkflowStatus> {
    const workflow = this.getChannelWorkflow(input.workflowId);
    if (!workflow) {
      return { ok: false, code: "stale_transition", currentStatus: input.expectedStatus ?? "cancelled" };
    }
    if (input.idempotencyKey) {
      const existing = this.ports.findStateTransitionByIdempotency("workflow", input.workflowId, input.idempotencyKey);
      if (existing) {
        if (workflow.status === "succeeded") this.assertDescendantsComplete(workflow.id);
        return { ok: true, from: workflow.status, to: workflow.status, duplicate: true };
      }
    }
    const result = transitionWorkflow({
      entityId: input.workflowId,
      currentStatus: workflow.status,
      expectedStatus: input.expectedStatus,
      event: input.event,
      actor: input.actor,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    });
    if (!result.ok) {
      return result;
    }
    if (result.to === "succeeded") this.assertDescendantsComplete(workflow.id);
    const update = this.context.database
      .prepare("UPDATE channel_workflows SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
      .run(result.to, input.now, input.workflowId, result.from);
    if (Number(update.changes) === 0) {
      const current = this.getChannelWorkflow(input.workflowId);
      return { ok: false, code: "stale_transition", currentStatus: current?.status ?? workflow.status };
    }
    this.ports.recordStateTransitionEvent({
      workspaceId: workflow.workspaceId,
      entityType: "workflow",
      entityId: input.workflowId,
      fromStatus: result.from,
      toStatus: result.to,
      event: input.event,
      actor: input.actor,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.now,
    });
    return result;
  }

  commitChannelWorkflowCompletionEvaluation(input: {
    readonly workflowId: string;
    readonly evaluation: WorkflowCompletionEvaluationV1;
    readonly now: string;
  }): TransitionResult<ChannelWorkflowStatus> {
    const expected = input.evaluation.expectedReadSet;
    const gate = input.evaluation.gate;
    const fallbackStatus = expected.workflow.status as ChannelWorkflowStatus;
    if (!isWorkflowCompletionGateV1(gate) || expected.schemaVersion !== 1
      || input.workflowId !== expected.workflow.id
      || gate.basisFingerprint.trim().length === 0) {
      return { ok: false, code: "invalid_transition", currentStatus: fallbackStatus };
    }
    const workflow = this.getChannelWorkflow(input.workflowId);
    if (!workflow || workflow.status !== fallbackStatus || workflow.updatedAt !== expected.workflow.updatedAt) {
      return { ok: false, code: "stale_transition", currentStatus: workflow?.status ?? fallbackStatus };
    }
    const expectedTarget = completionTarget(gate.status, workflow.status);
    if (!expectedTarget) {
      return { ok: false, code: "invalid_transition", currentStatus: workflow.status };
    }
    this.context.database.exec("BEGIN IMMEDIATE;");
    try {
      const currentWorkflow = this.getChannelWorkflow(input.workflowId);
      const currentSteps = this.listChannelWorkflowSteps({ workflowId: input.workflowId, complete: true });
      if (!currentWorkflow) {
        this.context.database.exec("ROLLBACK;");
        return { ok: false, code: "stale_transition", currentStatus: workflow.status };
      }
      const actual = buildWorkflowCompletionExpectedReadSet({
        store: this.ports,
        workflow: currentWorkflow,
        steps: currentSteps,
        derivedEvidence: expected.derivedEvidence,
      });
      if (actual.canonicalFingerprint !== expected.canonicalFingerprint
        || JSON.stringify(actual) !== JSON.stringify(expected)) {
        this.context.database.exec("ROLLBACK;");
        return { ok: false, code: "stale_transition", currentStatus: currentWorkflow.status };
      }
      if (!isCompletionGateConsistentWithCanonicalState({
        gate,
        workflow: currentWorkflow,
        steps: currentSteps,
        delegations: actual.delegations,
      })) {
        this.context.database.exec("ROLLBACK;");
        return { ok: false, code: "invalid_transition", currentStatus: currentWorkflow.status };
      }
      const currentGate = currentWorkflow.metadata?.completionGate;
      if (currentWorkflow.status === expectedTarget
        && currentGate?.basisFingerprint === gate.basisFingerprint
        && currentGate.status === gate.status) {
        this.context.database.exec("ROLLBACK;");
        return { ok: true, from: currentWorkflow.status, to: currentWorkflow.status, duplicate: true };
      }
      const metadata = { ...currentWorkflow.metadata, completionGate: gate };
      const update = this.context.database.prepare(`
        UPDATE channel_workflows
        SET status = ?, metadata_json = ?, updated_at = ?
        WHERE id = ? AND status = ? AND updated_at = ?
      `).run(
        expectedTarget,
        stringifyJson(metadata),
        input.now,
        input.workflowId,
        workflow.status,
        workflow.updatedAt,
      );
      if (Number(update.changes) === 0) {
        this.context.database.exec("ROLLBACK;");
        return { ok: false, code: "stale_transition", currentStatus: this.getChannelWorkflow(input.workflowId)?.status ?? workflow.status };
      }
      if (expectedTarget !== workflow.status) {
        const event = completionTransitionEvent(expectedTarget);
        this.ports.recordStateTransitionEvent({
          workspaceId: workflow.workspaceId,
          entityType: "workflow",
          entityId: workflow.id,
          fromStatus: workflow.status,
          toStatus: expectedTarget,
          event,
          actor: "system",
          reason: `completion_gate:${gate.basisFingerprint}`,
          idempotencyKey: `completion_gate:${gate.basisFingerprint}`,
          createdAt: input.now,
        });
      }
      this.context.database.exec("COMMIT;");
      return { ok: true, from: workflow.status, to: expectedTarget };
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      throw error;
    }
  }

  commitChannelWorkflowStepFinalization(input: {
    readonly workflowStepId: string;
    readonly expectedTaskId?: string;
    readonly expectedStartOwner?: WorkflowStepStartOwnerV1;
    readonly expectedStatus: "running" | "waiting_for_approval";
    readonly expectedUpdatedAt: string;
    readonly expectedRun:
      | {
          readonly kind: "linked_run";
          readonly id: string;
          readonly status: "succeeded" | "failed" | "cancelled";
          readonly updatedAt: string;
          readonly eventWatermark: { readonly count: number; readonly latestSeq: number };
          readonly artifactIds: readonly string[];
        }
      | { readonly kind: "no_linked_run" };
    readonly expectedApproval?: { readonly id: string; readonly status: import("../../approval-types.js").ApprovalRequest["status"]; readonly resolvedAt?: string };
    readonly finalStatus: "succeeded" | "blocked" | "failed" | "cancelled" | "skipped";
    readonly delegatedOutcome: import("@ling-stack/contracts").DelegatedOutcomeV1;
    readonly delegatedOutcomeBasisFingerprint: string;
    readonly executionVerification?: import("@ling-stack/contracts").WorkflowStepExecutionVerificationV1;
    readonly outputArtifactId?: string;
    readonly resultContextReview?: import("../../workspace-types.js").WorkflowFanInContextReview;
    readonly resultSummary?: string;
    readonly blocker?: string;
    readonly actor: StateTransitionActor;
    readonly reason: string;
    readonly idempotencyKey: string;
    readonly now: string;
  }): TransitionResult<ChannelWorkflowStepStatus> {
    if (!isDelegatedOutcomeV1(input.delegatedOutcome)) {
      return { ok: false, code: "invalid_transition", currentStatus: input.expectedStatus };
    }
    if (input.finalStatus === "succeeded" && input.delegatedOutcome.kind !== "completed") {
      return { ok: false, code: "invalid_transition", currentStatus: input.expectedStatus };
    }
    if (input.finalStatus === "failed" && input.delegatedOutcome.kind !== "failed") {
      return { ok: false, code: "invalid_transition", currentStatus: input.expectedStatus };
    }
    if (input.finalStatus === "cancelled" && input.delegatedOutcome.kind !== "cancelled") {
      return { ok: false, code: "invalid_transition", currentStatus: input.expectedStatus };
    }
    if (input.delegatedOutcome.kind === "workflow_started") {
      return { ok: false, code: "invalid_transition", currentStatus: input.expectedStatus };
    }
    const expectedRunId = input.expectedRun.kind === "linked_run" ? input.expectedRun.id : undefined;
    const step = this.getChannelWorkflowStep(input.workflowStepId);
    if (!step || step.status !== input.expectedStatus || step.updatedAt !== input.expectedUpdatedAt || step.runId !== expectedRunId
      || step.taskId !== input.expectedTaskId) {
      return { ok: false, code: "stale_transition", currentStatus: step?.status ?? input.expectedStatus };
    }
    const workflow = this.getChannelWorkflow(step.workflowId);
    if (!workflow) {
      return { ok: false, code: "invalid_transition", currentStatus: step.status };
    }
    if (input.delegatedOutcome.workflowId !== step.workflowId
      || input.delegatedOutcome.workflowStepId !== step.id
      || input.delegatedOutcome.participantId !== step.toParticipantId
      || input.delegatedOutcome.lineage.runId !== (expectedRunId ?? null)) {
      return { ok: false, code: "invalid_transition", currentStatus: step.status };
    }
    try {
      // Attempt refs are checked against the linked Run/WorkUnit below. The
      // channel validator cannot resolve legacy run-created attempt ids that
      // predate a durable WorkUnit row, so do not make that adapter own the
      // attempt boundary.
      this.ports.assertWorkflowPacketSourceRefsInChannel(
        step.channelId,
        input.delegatedOutcome.lineage.sourceRefs.filter((ref) => ref.type !== "attempt"),
      );
    } catch {
      return { ok: false, code: "invalid_transition", currentStatus: step.status };
    }
    const event = input.finalStatus === "succeeded"
      ? "succeed"
      : input.finalStatus === "blocked"
        ? "blocked"
        : input.finalStatus === "failed"
          ? "fail"
          : input.finalStatus === "cancelled"
            ? "cancel"
            : "skip";
    const transition = transitionWorkflowStep({
      entityId: step.id,
      currentStatus: step.status,
      expectedStatus: input.expectedStatus,
      event,
      actor: input.actor,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    });
    if (!transition.ok) return transition;
    this.context.database.exec("BEGIN IMMEDIATE;");
    try {
      const ownedStep = this.getChannelWorkflowStep(step.id);
      if (!ownedStep || ownedStep.taskId !== input.expectedTaskId || ownedStep.runId !== expectedRunId
        || ownedStep.status !== input.expectedStatus || ownedStep.updatedAt !== input.expectedUpdatedAt
        || input.expectedStartOwner && !workflowStepStartOwnerMatches(ownedStep.metadata?.startOwner, input.expectedStartOwner)) {
        this.context.database.exec("ROLLBACK;");
        return { ok: false, code: "stale_transition", currentStatus: ownedStep?.status ?? step.status };
      }
      if (input.expectedRun.kind === "linked_run") {
        const ownership = classifyWorkflowStepStartOwner(this.ports.workflowStepStartReadStore, ownedStep, input.now, { requireActiveLease: false });
        if (!input.expectedStartOwner || ownership.status !== "linked"
          || !workflowStepStartOwnerMatches(ownership.owner, input.expectedStartOwner)) {
          this.context.database.exec("ROLLBACK;");
          return { ok: false, code: "stale_transition", currentStatus: ownedStep.status };
        }
      } else if (ownedStep.taskId || ownedStep.metadata?.startOwner) {
        // Owned preparation failures use the generation-scoped settlement
        // transaction, never the no-Run semantic-finalization path.
        this.context.database.exec("ROLLBACK;");
        return { ok: false, code: "stale_transition", currentStatus: ownedStep.status };
      }
      let expectedArtifactIds: readonly string[] = [];
      let actualRunEventCount = 0;
      let actualRunLatestSeq = 0;
      if (input.expectedRun.kind === "linked_run") {
        const run = this.context.database.prepare(
          "SELECT status, updated_at, work_unit_id, task_id, workflow_step_id, channel_id, teammate_id FROM run_sessions WHERE id = ?",
        ).get(input.expectedRun.id) as Record<string, SQLOutputValue> | undefined;
        if (!run || run.status !== input.expectedRun.status || run.updated_at !== input.expectedRun.updatedAt
          || run.task_id !== step.taskId || run.workflow_step_id !== step.id
          || run.channel_id !== step.channelId || run.teammate_id !== step.toParticipantId) {
          this.context.database.exec("ROLLBACK;");
          return { ok: false, code: "stale_transition", currentStatus: step.status };
        }
        if (!this.delegatedRunAttemptLineageIsCurrent(
          input.expectedRun.id,
          run.work_unit_id === null || run.work_unit_id === undefined ? undefined : String(run.work_unit_id),
          input.delegatedOutcome.lineage.attemptId,
        )) {
          this.context.database.exec("ROLLBACK;");
          return { ok: false, code: "stale_transition", currentStatus: step.status };
        }
        const eventWatermark = this.context.database.prepare(`
          SELECT COUNT(*) AS count, COALESCE(MAX(seq), 0) AS latest_seq
          FROM run_events WHERE run_id = ?
        `).get(input.expectedRun.id) as Record<string, SQLOutputValue>;
        actualRunEventCount = Number(eventWatermark.count);
        actualRunLatestSeq = Number(eventWatermark.latest_seq);
        if (actualRunEventCount !== input.expectedRun.eventWatermark.count
          || actualRunLatestSeq !== input.expectedRun.eventWatermark.latestSeq) {
          this.context.database.exec("ROLLBACK;");
          return { ok: false, code: "stale_transition", currentStatus: step.status };
        }
        const actualArtifactIds = (this.context.database.prepare(
          "SELECT id FROM artifacts WHERE run_id = ? ORDER BY id ASC",
        ).all(input.expectedRun.id) as Record<string, SQLOutputValue>[]).map((row) => String(row.id));
        expectedArtifactIds = [...input.expectedRun.artifactIds].sort();
        if (JSON.stringify(actualArtifactIds) !== JSON.stringify(expectedArtifactIds)) {
          this.context.database.exec("ROLLBACK;");
          return { ok: false, code: "stale_transition", currentStatus: step.status };
        }
      } else if (input.outputArtifactId || input.executionVerification) {
        this.context.database.exec("ROLLBACK;");
        return { ok: false, code: "invalid_transition", currentStatus: step.status };
      }
      if (input.outputArtifactId && !expectedArtifactIds.includes(input.outputArtifactId)) {
        this.context.database.exec("ROLLBACK;");
        return { ok: false, code: "invalid_transition", currentStatus: step.status };
      }
      if (!this.delegatedOutcomeEvidenceIsCurrent(
        input.delegatedOutcome as FinalizableDelegatedOutcomeV1,
        workflow,
        step,
        expectedRunId,
        input.delegatedOutcome.lineage.attemptId,
        expectedArtifactIds,
      )) {
        this.context.database.exec("ROLLBACK;");
        return { ok: false, code: "invalid_transition", currentStatus: step.status };
      }
      if (input.expectedApproval) {
        const approval = this.context.database.prepare(
          "SELECT status, resolved_at FROM approval_requests WHERE id = ?",
        ).get(input.expectedApproval.id) as Record<string, SQLOutputValue> | undefined;
        if (!approval || approval.status !== input.expectedApproval.status
          || (approval.resolved_at ?? undefined) !== input.expectedApproval.resolvedAt) {
          this.context.database.exec("ROLLBACK;");
          return { ok: false, code: "stale_transition", currentStatus: step.status };
        }
      }
      const canonicalBasisFingerprint = delegatedStepFinalizationBasisFingerprintV1({
        workflowId: workflow.id,
        workflowStepId: step.id,
        stepUpdatedAt: input.expectedUpdatedAt,
        ...(input.expectedRun.kind === "linked_run" ? {
          runId: input.expectedRun.id,
          runStatus: input.expectedRun.status,
          runUpdatedAt: input.expectedRun.updatedAt,
        } : {}),
        runEventCount: actualRunEventCount,
        runLatestSeq: actualRunLatestSeq,
        requirementFingerprint: step.metadata?.delegatedRequirement?.fingerprint,
        approval: input.expectedApproval,
        artifactIds: expectedArtifactIds,
        outcome: input.delegatedOutcome,
        verification: input.executionVerification,
      });
      if (canonicalBasisFingerprint !== input.delegatedOutcomeBasisFingerprint) {
        this.context.database.exec("ROLLBACK;");
        return { ok: false, code: "invalid_transition", currentStatus: step.status };
      }
      const latest = this.context.database.prepare(
        "SELECT status, run_id, updated_at, metadata_json FROM channel_workflow_steps WHERE id = ?",
      ).get(step.id) as Record<string, SQLOutputValue> | undefined;
      if (!latest || latest.status !== input.expectedStatus
        || (latest.run_id ?? undefined) !== expectedRunId
        || latest.updated_at !== input.expectedUpdatedAt) {
        this.context.database.exec("ROLLBACK;");
        return { ok: false, code: "stale_transition", currentStatus: step.status };
      }
      const metadata = {
        ...(step.metadata ?? {}),
        ...(input.executionVerification ? { executionVerification: input.executionVerification } : {}),
        ...(input.outputArtifactId ? {
          outputArtifactId: input.outputArtifactId,
          outputArtifactIds: [...new Set([input.outputArtifactId, ...(step.metadata?.outputArtifactIds ?? []), ...expectedArtifactIds])],
        } : {}),
        ...(input.resultContextReview ? { resultContextReview: input.resultContextReview } : {}),
        delegatedOutcome: input.delegatedOutcome,
        delegatedOutcomeBasisFingerprint: input.delegatedOutcomeBasisFingerprint,
      };
      const runPredicate = input.expectedRun.kind === "linked_run" ? "run_id = ?" : "run_id IS NULL";
      const update = this.context.database.prepare(`
        UPDATE channel_workflow_steps
        SET status = ?, blocker = ?, result_summary = ?, metadata_json = ?, updated_at = ?
        WHERE id = ? AND status = ? AND ${runPredicate} AND updated_at = ?
      `).run(
        transition.to,
        input.blocker ?? null,
        input.resultSummary ?? null,
        stringifyJson(metadata),
        input.now,
        step.id,
        step.status,
        ...(input.expectedRun.kind === "linked_run" ? [input.expectedRun.id] : []),
        input.expectedUpdatedAt,
      );
      if (Number(update.changes) === 0) {
        this.context.database.exec("ROLLBACK;");
        return { ok: false, code: "stale_transition", currentStatus: step.status };
      }
      this.ports.recordStateTransitionEvent({
        workspaceId: step.workspaceId,
        entityType: "workflow_step",
        entityId: step.id,
        fromStatus: transition.from,
        toStatus: transition.to,
        event,
        actor: input.actor,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        createdAt: input.now,
      });
      if (input.expectedStartOwner) this.ports.releaseResourceLease(input.expectedStartOwner.leaseId, "workflow_step", step.id, input.now);
      this.context.database.exec("COMMIT;");
      return transition;
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      throw error;
    }
  }

  private delegatedRunAttemptLineageIsCurrent(
    runId: string,
    workUnitId: string | undefined,
    attemptId: string | null,
  ): boolean {
    if (!attemptId) return false;
    if (workUnitId) {
      const workUnit = this.context.database.prepare(
        "SELECT active_attempt_id, linked_run_id FROM work_units WHERE id = ?",
      ).get(workUnitId) as Record<string, SQLOutputValue> | undefined;
      if (!workUnit || workUnit.active_attempt_id !== attemptId
        || (workUnit.linked_run_id !== null && workUnit.linked_run_id !== runId)) return false;
      const attempt = this.context.database.prepare(
        "SELECT work_unit_id FROM work_unit_attempts WHERE id = ?",
      ).get(attemptId) as Record<string, SQLOutputValue> | undefined;
      return attempt?.work_unit_id === workUnitId;
    }
    const created = this.context.database.prepare(`
      SELECT data_json FROM run_events
      WHERE run_id = ? AND type = 'run_created'
      ORDER BY seq DESC LIMIT 1
    `).get(runId) as Record<string, SQLOutputValue> | undefined;
    if (!created || typeof created.data_json !== "string") return false;
    try {
      const data = JSON.parse(created.data_json) as unknown;
      return Boolean(data && typeof data === "object" && !Array.isArray(data)
        && (data as Record<string, unknown>).attemptId === attemptId);
    } catch {
      return false;
    }
  }

  private delegatedOutcomeEvidenceIsCurrent(
    outcome: FinalizableDelegatedOutcomeV1,
    workflow: ChannelWorkflow,
    step: ChannelWorkflowStep,
    expectedRunId: string | undefined,
    expectedAttemptId: string | null,
    expectedArtifactIds: readonly string[],
  ): boolean {
    if (outcome.kind === "completed") {
      const requirement = step.metadata?.delegatedRequirement;
      const manifest = workflow.metadata?.requiredParticipantManifest;
      if (!isDelegatedStepRequirementV1(requirement)
        || !manifest
        || requirement.workflowId !== workflow.id
        || requirement.workflowStepId !== step.id
        || requirement.participantId !== step.toParticipantId
        || requirement.participantManifestFingerprint !== manifest.fingerprint
        || outcome.evidenceRefs.some((ref) => !requirement.acceptedEvidenceKinds.includes(ref.kind))) {
        return false;
      }
    }
    const expectedArtifacts = new Set(expectedArtifactIds);
    for (const sourceRef of outcome.lineage.sourceRefs) {
      if (sourceRef.type === "workflow" && sourceRef.id !== workflow.id) return false;
      if (sourceRef.type === "workflow_step" && sourceRef.id !== step.id) return false;
      if (sourceRef.type === "run" && sourceRef.id !== (expectedRunId ?? "")) return false;
      if (sourceRef.type === "attempt" && sourceRef.id !== (expectedAttemptId ?? "")) return false;
      if (sourceRef.type === "artifact") {
        if (!expectedRunId || !expectedArtifacts.has(sourceRef.id)) return false;
        const artifact = this.ports.getArtifact(sourceRef.id);
        if (!artifact || artifact.runId !== expectedRunId) return false;
      }
      if (sourceRef.type === "execution_action"
        && (!expectedRunId || !this.executionActionEvidenceIsCurrent(expectedRunId, expectedAttemptId, sourceRef.id))) {
        return false;
      }
      if (sourceRef.type === "approval") {
        const approval = this.findApprovalForExpectedRun(expectedRunId, sourceRef.id);
        if (!approval || (expectedRunId ? approval.runId !== expectedRunId : Boolean(approval.runId))) return false;
      }
    }
    for (const evidenceRef of outcome.evidenceRefs) {
      if (evidenceRef.kind === "conversation_item") continue;
      if (evidenceRef.kind === "workflow_output_packet" || evidenceRef.kind === "artifact") {
        if (!expectedRunId || !expectedArtifacts.has(evidenceRef.id)) return false;
        const artifact = this.ports.getArtifact(evidenceRef.id);
        if (!artifact || artifact.runId !== expectedRunId) return false;
        continue;
      }
      if (!expectedRunId || !this.executionActionEvidenceIsCurrent(expectedRunId, expectedAttemptId, evidenceRef.id)) {
        return false;
      }
    }
    return true;
  }

  private executionActionEvidenceIsCurrent(
    runId: string,
    attemptId: string | null,
    actionId: string,
  ): boolean {
    if (actionId.startsWith("approval:")) {
      const approvalId = actionId.slice("approval:".length);
      if (!approvalId) return false;
      const approval = this.findApprovalForExpectedRun(runId, approvalId);
      if (!approval || approval.status !== "approved" || !approval.toolCallId) return false;
      return this.toolExecutionEvidenceIsCurrent(runId, attemptId, approval.toolCallId);
    }
    if (!actionId.startsWith("tool:")) return false;
    const remainder = actionId.slice("tool:".length);
    const separator = remainder.indexOf(":");
    const actionRunId = separator > 0 ? remainder.slice(0, separator) : "";
    const toolCallId = separator > 0 ? remainder.slice(separator + 1) : "";
    if (actionRunId !== runId || !toolCallId) return false;
    return this.toolExecutionEvidenceIsCurrent(runId, attemptId, toolCallId);
  }

  private toolExecutionEvidenceIsCurrent(
    runId: string,
    attemptId: string | null,
    toolCallId: string,
  ): boolean {
    const events = this.listAllRunEvents(runId);
    let latestToolEvent: RunEventEnvelope | undefined;
    let terminalToolEvent: RunEventEnvelope | undefined;
    let explicitAttemptId: string | undefined;
    for (const event of events) {
      if (event.type !== "tool_start" && event.type !== "tool_update" && event.type !== "tool_end") continue;
      if (!isUnknownRecord(event.data) || event.data.toolCallId !== toolCallId) continue;
      latestToolEvent = event;
      if (event.type === "tool_end") terminalToolEvent = event;
      if (typeof event.data.attemptId === "string" && event.data.attemptId.trim()) {
        explicitAttemptId = event.data.attemptId;
      }
    }
    if (!latestToolEvent || !terminalToolEvent || !isUnknownRecord(terminalToolEvent.data)
      || terminalToolEvent.data.isError === true) return false;
    const actionAttemptId = explicitAttemptId ?? latestRunAttemptIdAtOrBefore(events, latestToolEvent.seq);
    return Boolean(actionAttemptId && actionAttemptId === attemptId);
  }

  private findApprovalForExpectedRun(runId: string | undefined, approvalId: string) {
    return this.ports.listApprovalRequests({
      ...(runId ? { runId } : {}),
      complete: true,
    }).find((approval) => approval.id === approvalId);
  }

  private listAllRunEvents(runId: string): readonly RunEventEnvelope[] {
    const events: RunEventEnvelope[] = [];
    let afterSeq = 0;
    while (true) {
      const page = this.ports.listEvents(runId, { afterSeq, limit: 1000 });
      events.push(...page);
      const latestSeq = page.at(-1)?.seq;
      if (page.length < 1000 || latestSeq === undefined || latestSeq <= afterSeq) return events;
      afterSeq = latestSeq;
    }
  }

  createChannelWorkflowStep(input: CreateChannelWorkflowStepInput, now: string): ChannelWorkflowStep {
    const workflow = this.getChannelWorkflow(input.workflowId);
    if (!workflow) {
      throw new Error(`Channel workflow not found: ${input.workflowId}`);
    }
    if (input.sourceHandoffId) {
      this.ports.assertHandoffInChannel(workflow.channelId, input.sourceHandoffId);
    }
    if (input.contextSummaryId) {
      this.ports.assertContextSummaryInChannel(workflow.channelId, input.contextSummaryId);
    }
    const position = input.position ?? this.nextWorkflowStepPosition(input.workflowId);
    const stepId = createChannelWorkflowStepId();
    const participantAuthority = input.participantAuthority
      ?? createWorkflowParticipantAuthorityV1({
        kind: "channel_selection",
        origin: "manual_channel_step",
        participantId: input.toParticipantId,
        sourceId: stepId,
      });
    if (!isWorkflowParticipantAuthorityV1(participantAuthority)
      || participantAuthority.participantId !== input.toParticipantId) {
      throw new Error(`Invalid participant authority for workflow step ${input.workflowId}`);
    }
    const providerBinding = input.metadata?.providerBinding;
    if (providerBinding !== undefined
      && (!isWorkflowParticipantProviderBindingV1(providerBinding)
        || providerBinding.participantId !== input.toParticipantId)) {
      throw new Error(`Invalid participant provider binding for workflow step ${input.workflowId}`);
    }
    const step: ChannelWorkflowStep = {
      id: stepId,
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: workflow.channelId,
      workflowId: workflow.id,
      sourceHandoffId: input.sourceHandoffId,
      contextSummaryId: input.contextSummaryId,
      position,
      title: input.title,
      prompt: input.prompt,
      toParticipantId: input.toParticipantId,
      toParticipantLabel: input.toParticipantLabel,
      participantAuthority,
      status: input.status ?? "queued",
      metadata: input.metadata
        ? { ...input.metadata, participantAuthority }
        : { participantAuthority },
      createdAt: now,
      updatedAt: now,
    };

    this.context.database
      .prepare(`
        INSERT INTO channel_workflow_steps (
          id,
          workspace_id,
          channel_id,
          workflow_id,
          source_handoff_id,
          context_summary_id,
          task_id,
          run_id,
          position,
          title,
          prompt,
          to_participant_id,
          to_participant_label,
          participant_authority_json,
          status,
          blocker,
          result_summary,
          metadata_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        step.id,
        step.workspaceId,
        step.channelId,
        step.workflowId,
        step.sourceHandoffId ?? null,
        step.contextSummaryId ?? null,
        null,
        null,
        step.position,
        step.title,
        step.prompt,
        step.toParticipantId,
        step.toParticipantLabel,
        stringifyJson(step.participantAuthority),
        step.status,
        null,
        null,
        step.metadata ? stringifyJson(step.metadata) : null,
        step.createdAt,
        step.updatedAt,
      );

    const created = this.getChannelWorkflowStep(step.id);
    if (!created) {
      throw new Error(`Failed to create channel workflow step: ${step.id}`);
    }
    return created;
  }

  getChannelWorkflowStep(id: string): ChannelWorkflowStep | undefined {
    const row = this.context.database.prepare(channelWorkflowStepSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelWorkflowStep(row as Record<string, SQLOutputValue>) : undefined;
  }

  listChannelWorkflowSteps(options: ListChannelWorkflowStepsOptions): ChannelWorkflowStep[] {
    const clauses = ["workspace_id = ?", "workflow_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.workflowId];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.complete) {
      return this.context.database
        .prepare(channelWorkflowStepSelectSql("WHERE " + clauses.join(" AND ") + " ORDER BY position ASC, created_at ASC"))
        .all(...params)
        .map((row) => mapChannelWorkflowStep(row as Record<string, SQLOutputValue>));
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.context.database
      .prepare(`${channelWorkflowStepSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY position ASC, created_at ASC LIMIT ?`)
      .all(...params)
      .map((row) => mapChannelWorkflowStep(row as Record<string, SQLOutputValue>));
  }

  updateChannelWorkflowStep(
    id: string,
    input: UpdateChannelWorkflowStepInput,
    now: string,
  ): ChannelWorkflowStep | undefined {
    const existing = this.getChannelWorkflowStep(id);
    if (!existing) {
      return undefined;
    }
    if (input.expectedStartOwner && (!workflowStepStartOwnerMatches(existing.metadata?.startOwner, input.expectedStartOwner)
      || existing.taskId !== input.expectedStartOwner.taskId
      || input.taskId !== undefined && input.taskId !== existing.taskId
      || input.runId !== undefined && input.runId !== existing.runId)) return undefined;
    const updateRecord = input as unknown as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(updateRecord, "toParticipantId")
      || Object.prototype.hasOwnProperty.call(updateRecord, "toParticipantLabel")) {
      throw new Error(`Workflow participant binding is immutable for workflow step ${id}`);
    }
    const sourceHandoffId = nullableUpdate(input.sourceHandoffId, existing.sourceHandoffId);
    const contextSummaryId = nullableUpdate(input.contextSummaryId, existing.contextSummaryId);
    const taskId = nullableUpdate(input.taskId, existing.taskId);
    const runId = nullableUpdate(input.runId, existing.runId);
    if (sourceHandoffId) {
      this.ports.assertHandoffInChannel(existing.channelId, sourceHandoffId);
    }
    if (contextSummaryId) {
      this.ports.assertContextSummaryInChannel(existing.channelId, contextSummaryId);
    }
    if (taskId) {
      this.ports.assertTaskInChannel(existing.channelId, taskId);
    }
    if (runId) {
      this.ports.assertRunInChannel(existing.channelId, runId);
    }
    if (input.metadata?.participantAuthority
      && (!isWorkflowParticipantAuthorityV1(input.metadata.participantAuthority)
        || input.metadata.participantAuthority.fingerprint !== existing.participantAuthority.fingerprint)) {
      throw new Error(`Workflow participant authority is immutable for workflow step ${id}`);
    }
    const existingProviderBinding = existing.metadata?.providerBinding;
    const requestedProviderBinding = input.metadata?.providerBinding;
    if (requestedProviderBinding !== undefined
      && (!existingProviderBinding
        || !isWorkflowParticipantProviderBindingV1(requestedProviderBinding)
        || JSON.stringify(requestedProviderBinding) !== JSON.stringify(existingProviderBinding))) {
      throw new Error(`Workflow participant provider binding is immutable for workflow step ${id}`);
    }
    const next: ChannelWorkflowStep = {
      ...existing,
      sourceHandoffId,
      contextSummaryId,
      taskId,
      runId,
      position: input.position ?? existing.position,
      title: input.title ?? existing.title,
      prompt: input.prompt ?? existing.prompt,
      status: input.status ?? existing.status,
      blocker: nullableUpdate(input.blocker, existing.blocker),
      resultSummary: nullableUpdate(input.resultSummary, existing.resultSummary),
      metadata: input.metadata === null
        ? (existing.metadata ? {
            ...existing.metadata,
            participantAuthority: existing.participantAuthority,
            ...(existingProviderBinding ? { providerBinding: existingProviderBinding } : {}),
          } : undefined)
        : input.metadata
          ? {
              ...input.metadata,
              participantAuthority: existing.participantAuthority,
              ...(existingProviderBinding ? { providerBinding: existingProviderBinding } : {}),
            }
          : existing.metadata,
      updatedAt: now,
    };
    const update = this.context.database
      .prepare(`
        UPDATE channel_workflow_steps
        SET
          source_handoff_id = ?,
          context_summary_id = ?,
          task_id = ?,
          run_id = ?,
          position = ?,
          title = ?,
          prompt = ?,
          status = ?,
          blocker = ?,
          result_summary = ?,
          metadata_json = ?,
          updated_at = ?
        WHERE id = ? AND task_id IS ? AND run_id IS ? AND updated_at = ?
      `)
      .run(
        next.sourceHandoffId ?? null,
        next.contextSummaryId ?? null,
        next.taskId ?? null,
        next.runId ?? null,
        next.position,
        next.title,
        next.prompt,
        next.status,
        next.blocker ?? null,
        next.resultSummary ?? null,
        next.metadata ? stringifyJson(next.metadata) : null,
        next.updatedAt,
        id,
        existing.taskId ?? null,
        existing.runId ?? null,
        existing.updatedAt,
      );
    if (Number(update.changes) !== 1) return undefined;
    return this.getChannelWorkflowStep(id);
  }

  transitionChannelWorkflowStepStatus(input: Parameters<RunStore["transitionChannelWorkflowStepStatus"]>[0]): TransitionResult<ChannelWorkflowStepStatus> {
    // A savepoint composes with existing approval transactions, and keeps
    // the state, audit and generation-scoped release indivisible to peers.
    this.context.database.exec("SAVEPOINT workflow_step_transition");
    try {
      const result = this.transitionChannelWorkflowStepStatusWithinTransaction(input);
      this.context.database.exec("RELEASE workflow_step_transition");
      return result;
    } catch (error) {
      this.context.database.exec("ROLLBACK TO workflow_step_transition");
      this.context.database.exec("RELEASE workflow_step_transition");
      throw error;
    }
  }

  private transitionChannelWorkflowStepStatusWithinTransaction(input: Parameters<RunStore["transitionChannelWorkflowStepStatus"]>[0]): TransitionResult<ChannelWorkflowStepStatus> {
    const step = this.getChannelWorkflowStep(input.workflowStepId);
    if (!step) {
      return { ok: false, code: "stale_transition", currentStatus: input.expectedStatus ?? "cancelled" };
    }
    if (input.expectedStartOwner && (!workflowStepStartOwnerMatches(step.metadata?.startOwner, input.expectedStartOwner)
      || step.taskId !== input.expectedStartOwner.taskId
      || input.taskId !== undefined && input.taskId !== step.taskId
      || input.runId !== undefined && input.runId !== step.runId)) {
      return { ok: false, code: "stale_transition", currentStatus: step.status };
    }
    if (input.expectedStartOwner) {
      const ownership = classifyWorkflowStepStartOwner(this.ports.workflowStepStartReadStore, step, input.now, { requireActiveLease: false });
      if (ownership.status !== "linked") return { ok: false, code: "stale_transition", currentStatus: step.status };
    }
    if (input.idempotencyKey) {
      const existing = this.ports.findStateTransitionByIdempotency("workflow_step", input.workflowStepId, input.idempotencyKey);
      if (existing) {
        return { ok: true, from: step.status, to: step.status, duplicate: true };
      }
    }
    if (
      input.event === "succeed"
      && (step.metadata?.executionPlan || step.metadata?.delegatedRequirement)
      && (
        step.metadata.executionVerification?.status !== "verified"
        || Boolean(step.metadata.delegatedRequirement) && step.metadata.delegatedOutcome?.kind !== "completed"
      )
    ) {
      return { ok: false, code: "invalid_transition", currentStatus: step.status };
    }
    const result = transitionWorkflowStep({
      entityId: input.workflowStepId,
      currentStatus: step.status,
      expectedStatus: input.expectedStatus,
      event: input.event,
      actor: input.actor,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    });
    if (!result.ok) {
      return result;
    }
    const update = this.context.database
      .prepare(`
        UPDATE channel_workflow_steps
        SET
          status = ?,
          task_id = ?,
          run_id = ?,
          blocker = ?,
          result_summary = ?,
          updated_at = ?
        WHERE id = ? AND status = ? AND task_id IS ? AND run_id IS ? AND updated_at = ?
      `)
      .run(
        result.to,
        input.taskId === undefined ? step.taskId ?? null : input.taskId,
        input.runId === undefined ? step.runId ?? null : input.runId,
        input.blocker === undefined ? step.blocker ?? null : input.blocker,
        input.resultSummary === undefined ? step.resultSummary ?? null : input.resultSummary,
        input.now,
        input.workflowStepId,
        result.from,
        step.taskId ?? null,
        step.runId ?? null,
        step.updatedAt,
      );
    if (Number(update.changes) === 0) {
      const current = this.getChannelWorkflowStep(input.workflowStepId);
      return { ok: false, code: "stale_transition", currentStatus: current?.status ?? step.status };
    }
    this.ports.recordStateTransitionEvent({
      workspaceId: step.workspaceId,
      entityType: "workflow_step",
      entityId: input.workflowStepId,
      fromStatus: result.from,
      toStatus: result.to,
      event: input.event,
      actor: input.actor,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.now,
    });
    if (result.to === "succeeded" || result.to === "failed" || result.to === "skipped" || result.to === "cancelled") {
      if (step.metadata?.startOwner) this.ports.releaseResourceLease(step.metadata.startOwner.leaseId, "workflow_step", step.id, input.now);
      else if (!step.taskId && !step.runId) this.ports.releaseResourceLeasesForWorkflowStep(input.workflowStepId, input.now);
    }
    return result;
  }

  private assertDescendantsComplete(workflowId: string): void {
    const steps = this.listChannelWorkflowSteps({ workflowId, complete: true });
    assertDelegationCompletionSatisfied(this.ports.getDelegationCompletionEvidence({
      rootRunIds: [...new Set(steps.flatMap(step => step.runId ? [step.runId] : []))].sort(),
    }));
  }

  /** Owns an immediate transaction unless an approval/lifecycle caller already owns one. */
  private withCompletionTransaction<T>(write: () => T): T {
    const db = this.context.database;
    let ownsTransaction = true;
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if (!(error instanceof Error)
        || (error as NodeJS.ErrnoException).code !== "ERR_SQLITE_ERROR"
        || error.message !== "cannot start a transaction within a transaction") throw error;
      ownsTransaction = false;
      db.exec("SAVEPOINT workflow_success_delegation_barrier");
    }
    try {
      const result = write();
      db.exec(ownsTransaction ? "COMMIT" : "RELEASE workflow_success_delegation_barrier");
      return result;
    } catch (error) {
      if (ownsTransaction) rollbackOwnedSqliteTransaction(db);
      else {
        db.exec("ROLLBACK TO workflow_success_delegation_barrier");
        db.exec("RELEASE workflow_success_delegation_barrier");
      }
      throw error;
    }
  }

  private nextWorkflowStepPosition(workflowId: string): number {
    const row = this.context.database
      .prepare("SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM channel_workflow_steps WHERE workflow_id = ?")
      .get(workflowId);
    return readNumber(row as Record<string, SQLOutputValue> | undefined, "next_position");
  }
}

function validateWorkflowHandoffIntent(intent: WorkflowHandoffIntent): void {
  validateNonEmptyString(intent.fromParticipantId, "workflow handoff from participant id");
  validateNonEmptyString(intent.fromParticipantLabel, "workflow handoff from participant label");
  validateNonEmptyString(intent.toParticipantId, "workflow handoff target participant id");
  validateNonEmptyString(intent.reason, "workflow handoff reason");
  validateNonEmptyString(intent.requiredInput, "workflow handoff required input");
  validateNonEmptyString(intent.expectedOutput, "workflow handoff expected output");
  if (!isWorkflowHandoffIntentStatusValue(intent.status)) {
    throw new Error("workflow handoff intent status is not supported");
  }
  if (intent.createdBy !== "local-user" && intent.createdBy !== "ai-teammate" && intent.createdBy !== "orchestrator") {
    throw new Error("workflow handoff intent createdBy is not supported");
  }
  validateWorkflowPacketSourceRefs(intent.sourceRefs);
  if (intent.agentContext) {
    validateNonEmptyString(intent.agentContext.sourceItemId, "workflow handoff agent context source item id");
    if (intent.agentContext.consumerTeammateId !== undefined) {
      validateNonEmptyString(intent.agentContext.consumerTeammateId, "workflow handoff agent context consumer teammate id");
    }
    if (
      intent.agentContext.schemaVersion !== 1
      || !isConversationContextProjectionMetadata(intent.agentContext.contextProjection)
    ) {
      throw new Error("workflow handoff agent context projection is invalid");
    }
    validateWorkflowPacketSourceRefs(intent.agentContext.roleEvidenceRefs);
    validateNonEmptyString(intent.agentContext.roleEvidenceFingerprint, "workflow handoff agent context role evidence fingerprint");
  }
  if (intent.validation) {
    const validation = intent.validation;
    if (!Array.isArray(validation.blockers)) {
      throw new Error("workflow handoff validation blockers must be an array");
    }
    validateStringList(validation.blockers, "workflow handoff validation blockers");
  }
}

function validateWorkflowSelectorDecision(decision: WorkflowSelectorDecision): void {
  validateNonEmptyString(decision.reason, "workflow selector decision reason");
  if (!isWorkflowSelectorTargetKindValue(decision.targetKind)) {
    throw new Error("workflow selector target kind is not supported");
  }
  if (!isWorkflowSelectorDecisionStatusValue(decision.status)) {
    throw new Error("workflow selector decision status is not supported");
  }
  if (decision.confidence !== "low" && decision.confidence !== "medium" && decision.confidence !== "high") {
    throw new Error("workflow selector decision confidence is not supported");
  }
  if (decision.createdBy !== "deterministic" && decision.createdBy !== "model" && decision.createdBy !== "local-user") {
    throw new Error("workflow selector decision createdBy is not supported");
  }
  for (const alternative of decision.alternativesConsidered) {
    if (!isWorkflowSelectorTargetKindValue(alternative.targetKind)) {
      throw new Error("workflow selector alternative target kind is not supported");
    }
    validateNonEmptyString(alternative.targetId, "workflow selector alternative target id");
    validateNonEmptyString(alternative.label, "workflow selector alternative label");
    validateNonEmptyString(alternative.reason, "workflow selector alternative reason");
  }
  validateWorkflowPacketSourceRefs(decision.sourceRefs);
}

function validateWorkflowPacketSourceRefs(sourceRefs: readonly WorkflowPacketSourceRef[]): void {
  for (const sourceRef of sourceRefs) {
    if (!isWorkflowPacketSourceRefTypeValue(sourceRef.type)) {
      throw new Error("workflow packet source ref type is not supported");
    }
    validateNonEmptyString(sourceRef.id, "workflow packet source ref id");
  }
}

function isCompletionGateConsistentWithCanonicalState(input: {
  readonly gate: WorkflowCompletionGateV1;
  readonly workflow: ChannelWorkflow;
  readonly steps: readonly ChannelWorkflowStep[];
  readonly delegations: import("../../delegation-completion-evidence.js").DelegationCompletionEvidenceV1;
}): boolean {
  if (input.gate.status === "verified" && input.delegations.status !== "satisfied") return false;
  const manifest = input.workflow.metadata?.requiredParticipantManifest;
  const sourceDecisionId = input.workflow.metadata?.sourceIntentDecisionId;
  const graph = input.workflow.metadata?.workflowGraph;
  if (!manifest || !sourceDecisionId || !graph
    || input.gate.sourceIntentDecisionId !== sourceDecisionId
    || input.gate.participantManifestFingerprint !== manifest.fingerprint
    || input.gate.graphFingerprint !== workflowGraphFingerprintV1(graph)) {
    return false;
  }
  // The source decision is checked by the read-set CAS. The checks below bind
  // every result to the current manifest and materialized step graph.
  const manifestIds = manifest.participants.map((participant) => participant.participantId).sort();
  const resultIds = input.gate.participantResults.map((result) => result.participantId).sort();
  if (JSON.stringify(manifestIds) !== JSON.stringify(resultIds)
    || new Set(resultIds).size !== resultIds.length) return false;

  for (const participant of manifest.participants) {
    const result = input.gate.participantResults.find((candidate) => candidate.participantId === participant.participantId);
    if (!result) return false;
    const ownedSteps = input.steps
      .filter((step) => step.toParticipantId === participant.participantId)
      .sort((left, right) => left.id.localeCompare(right.id));
    const resultStepIds = [...result.workflowStepIds].sort();
    if (JSON.stringify(resultStepIds) !== JSON.stringify(ownedSteps.map((step) => step.id))) return false;
    const expectedEvidenceRefs = uniqueDelegatedEvidenceRefs(ownedSteps);
    if (!sameDelegatedEvidenceRefs(result.evidenceRefs, expectedEvidenceRefs)) return false;
    if (input.gate.status === "verified" && participant.requirement === "required") {
      if (result.status !== "satisfied"
        || ownedSteps.length === 0
        || ownedSteps.some((step) => step.status !== "succeeded" && step.status !== "skipped")
        || ownedSteps.some((step) => step.metadata?.delegatedOutcome?.kind !== "completed")) {
        return false;
      }
    }
  }

  const basisFingerprint = workflowCompletionGateBasisFingerprintV1({
    workflowId: input.workflow.id,
    sourceIntentDecisionId: input.gate.sourceIntentDecisionId,
    manifestFingerprint: manifest.fingerprint,
    graphFingerprint: input.gate.graphFingerprint,
    participantResults: input.gate.participantResults,
    steps: input.steps,
    delegationCompletionFingerprint: input.delegations.steps.length || input.delegations.issues.length ? input.delegations.fingerprint : undefined,
  });
  return basisFingerprint === input.gate.basisFingerprint;
}

function uniqueDelegatedEvidenceRefs(steps: readonly ChannelWorkflowStep[]): readonly DelegatedEvidenceRefV1[] {
  const refs = new Map<string, DelegatedEvidenceRefV1>();
  for (const step of steps) {
    const outcome = step.metadata?.delegatedOutcome;
    if (!outcome || outcome.kind !== "completed") continue;
    for (const ref of outcome.evidenceRefs) refs.set(`${ref.kind}:${ref.id}`, ref);
  }
  return [...refs.values()].sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
}

function sameDelegatedEvidenceRefs(
  left: readonly DelegatedEvidenceRefV1[],
  right: readonly DelegatedEvidenceRefV1[],
): boolean {
  const key = (ref: DelegatedEvidenceRefV1): string => `${ref.kind}:${ref.id}`;
  return JSON.stringify([...left].map(key).sort()) === JSON.stringify([...right].map(key).sort());
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function latestRunAttemptIdAtOrBefore(
  events: readonly RunEventEnvelope[],
  throughSeq: number,
): string | undefined {
  for (const event of [...events].sort((left, right) => right.seq - left.seq)) {
    if (event.seq > throughSeq || event.type !== "run_created" || !isUnknownRecord(event.data)) continue;
    const attemptId = event.data.attemptId;
    if (typeof attemptId === "string" && attemptId.trim()) return attemptId;
  }
  return undefined;
}

function isWorkflowHandoffIntentStatusValue(value: unknown): value is WorkflowHandoffIntentStatus {
  return value === "proposed" || value === "validated" || value === "accepted" || value === "declined" || value === "converted" || value === "failed";
}

function isWorkflowSelectorDecisionStatusValue(value: unknown): value is WorkflowSelectorDecisionStatus {
  return value === "proposed" || value === "accepted" || value === "rejected" || value === "blocked" || value === "superseded";
}

function isWorkflowSelectorTargetKindValue(value: unknown): value is WorkflowSelectorTargetKind {
  return value === "workflow_step" || value === "graph_node" || value === "teammate" || value === "skill" || value === "handoff" || value === "wait";
}

function isWorkflowPacketSourceRefTypeValue(value: unknown): value is WorkflowPacketSourceRef["type"] {
  return (
    value === "channel_message" ||
    value === "conversation_item" ||
    value === "channel_brief" ||
    value === "channel_decision" ||
    value === "context_summary" ||
    value === "task" ||
    value === "run" ||
    value === "attempt" ||
    value === "workflow" ||
    value === "workflow_step" ||
    value === "workflow_handoff_intent" ||
    value === "workflow_selector_decision" ||
    value === "execution_action" ||
    value === "artifact" ||
    value === "approval" ||
    value === "memory"
  );
}

function validateNonEmptyString(value: string, label: string): void {
  if (!value.trim()) {
    throw new Error(`${label} must not be empty`);
  }
}

function validateStringList(value: readonly string[], label: string): void {
  for (const item of value) {
    if (!item.trim()) {
      throw new Error(`${label} must not contain empty strings`);
    }
  }
}
