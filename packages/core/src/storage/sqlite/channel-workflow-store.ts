import type { SQLOutputValue } from "node:sqlite";
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
import { nullableUpdate, readNumber, stringifyJson } from "./helpers.js";
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
          status,
          validation_json,
          created_by,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    const next: WorkflowHandoffIntent = {
      ...existing,
      channelHandoffId,
      toParticipantLabel: nullableUpdate(input.toParticipantLabel, existing.toParticipantLabel),
      reason: input.reason ?? existing.reason,
      requiredInput: input.requiredInput ?? existing.requiredInput,
      expectedOutput: input.expectedOutput ?? existing.expectedOutput,
      riskSummary: nullableUpdate(input.riskSummary, existing.riskSummary),
      sourceRefs,
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

  getChannelWorkflow(id: string): ChannelWorkflow | undefined {
    const row = this.context.database.prepare(channelWorkflowSelectSql("WHERE id = ?")).get(id);
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
    const workflow = this.getChannelWorkflow(input.workflowId);
    if (!workflow) {
      return { ok: false, code: "stale_transition", currentStatus: input.expectedStatus ?? "cancelled" };
    }
    if (input.idempotencyKey) {
      const existing = this.ports.findStateTransitionByIdempotency("workflow", input.workflowId, input.idempotencyKey);
      if (existing) {
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
    const step: ChannelWorkflowStep = {
      id: createChannelWorkflowStepId(),
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
      status: input.status ?? "queued",
      metadata: input.metadata,
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
          status,
          blocker,
          result_summary,
          metadata_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    const next: ChannelWorkflowStep = {
      ...existing,
      sourceHandoffId,
      contextSummaryId,
      taskId,
      runId,
      position: input.position ?? existing.position,
      title: input.title ?? existing.title,
      prompt: input.prompt ?? existing.prompt,
      toParticipantId: input.toParticipantId ?? existing.toParticipantId,
      toParticipantLabel: input.toParticipantLabel ?? existing.toParticipantLabel,
      status: input.status ?? existing.status,
      blocker: nullableUpdate(input.blocker, existing.blocker),
      resultSummary: nullableUpdate(input.resultSummary, existing.resultSummary),
      metadata: nullableUpdate(input.metadata, existing.metadata),
      updatedAt: now,
    };
    this.context.database
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
          to_participant_id = ?,
          to_participant_label = ?,
          status = ?,
          blocker = ?,
          result_summary = ?,
          metadata_json = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.sourceHandoffId ?? null,
        next.contextSummaryId ?? null,
        next.taskId ?? null,
        next.runId ?? null,
        next.position,
        next.title,
        next.prompt,
        next.toParticipantId,
        next.toParticipantLabel,
        next.status,
        next.blocker ?? null,
        next.resultSummary ?? null,
        next.metadata ? stringifyJson(next.metadata) : null,
        next.updatedAt,
        id,
      );
    return this.getChannelWorkflowStep(id);
  }

  transitionChannelWorkflowStepStatus(input: {
    readonly workflowStepId: string;
    readonly expectedStatus?: ChannelWorkflowStepStatus;
    readonly event: WorkflowStepTransitionEvent;
    readonly actor: StateTransitionActor;
    readonly reason?: string;
    readonly idempotencyKey?: string;
    readonly now: string;
    readonly taskId?: string | null;
    readonly runId?: string | null;
    readonly blocker?: string | null;
    readonly resultSummary?: string | null;
  }): TransitionResult<ChannelWorkflowStepStatus> {
    const step = this.getChannelWorkflowStep(input.workflowStepId);
    if (!step) {
      return { ok: false, code: "stale_transition", currentStatus: input.expectedStatus ?? "cancelled" };
    }
    if (input.idempotencyKey) {
      const existing = this.ports.findStateTransitionByIdempotency("workflow_step", input.workflowStepId, input.idempotencyKey);
      if (existing) {
        return { ok: true, from: step.status, to: step.status, duplicate: true };
      }
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
        WHERE id = ? AND status = ?
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
      this.ports.releaseResourceLeasesForWorkflowStep(input.workflowStepId, input.now);
    }
    return result;
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
    value === "channel_brief" ||
    value === "channel_decision" ||
    value === "context_summary" ||
    value === "task" ||
    value === "run" ||
    value === "workflow" ||
    value === "workflow_step" ||
    value === "workflow_handoff_intent" ||
    value === "workflow_selector_decision" ||
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
