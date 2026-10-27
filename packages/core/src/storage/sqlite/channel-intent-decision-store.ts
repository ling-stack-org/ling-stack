import type { SQLOutputValue } from "node:sqlite";
import {
  createRequiredParticipantManifestV1,
  channelOperationPlanFingerprintV1,
  isChannelIntentDecisionV2,
  isConversationContextProjectionMetadata,
  type ConversationItemV1,
  type TurnContextAssignment,
} from "@ling-stack/contracts";
import {
  DEFAULT_WORKSPACE_ID,
  createChannelIntentDecisionId,
  type ChannelIntentDecision,
  type CreateChannelIntentDecisionInput,
  type ListChannelIntentDecisionsOptions,
} from "../../workspace-types.js";
import { rollbackOwnedSqliteTransaction, stringifyJson } from "./helpers.js";
import { mapChannelIntentDecision } from "./channel-routing-mappers.js";
import { channelIntentDecisionSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";
import { channelPendingOperationFingerprintV1, type ChannelPendingOperationResolution,
  type ChannelPendingOperationResolved, type ResolveChannelPendingOperationInput } from "../../channel-pending-operation.js";

export interface SqliteChannelIntentDecisionStorePorts {
  readonly assertItemInChannel: (channelId: string, itemId: string) => void;
  readonly assertProposalInChannel: (channelId: string, proposalId: string) => void;
  readonly assertWorkflowInChannel: (channelId: string, workflowId: string) => void;
  readonly hasAiTeammate: (id: string) => boolean;
  readonly getConversationItem: (id: string) => ConversationItemV1 | undefined;
  readonly getEffectiveConversationItem: (id: string) => ConversationItemV1 | undefined;
  readonly getEffectiveTurnContextAssignment: (turnId: string) => TurnContextAssignment | undefined;
  readonly listConversationItemsForSegment: (input: {
    readonly threadId: string; readonly segmentId: string; readonly throughSequence: number; readonly limit: number;
  }) => readonly ConversationItemV1[];
}

export class SqliteChannelIntentDecisionStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteChannelIntentDecisionStorePorts,
  ) {}

  createChannelIntentDecision(input: CreateChannelIntentDecisionInput, now: string): ChannelIntentDecision {
    this.ports.assertItemInChannel(input.channelId, input.sourceItemId);
    const sourceItem = this.ports.getConversationItem(input.sourceItemId);
    if (!sourceItem?.turnId || sourceItem.status !== "committed") {
      throw new Error(`Channel Intent v2 source must be a committed turn item: ${input.sourceItemId}`);
    }
    if (!isConversationContextProjectionMetadata(input.contextProjection)) {
      throw new Error("Channel Intent v2 requires valid context projection metadata.");
    }
    const assignment = this.ports.getEffectiveTurnContextAssignment(sourceItem.turnId);
    if (!assignment) {
      throw new Error(`Channel Intent v2 source turn has no context assignment: ${sourceItem.turnId}`);
    }
    if (
      input.contextProjection.threadId !== sourceItem.threadId
      || input.contextProjection.turnId !== sourceItem.turnId
      || input.contextProjection.segmentId !== assignment.segmentId
      || input.contextProjection.throughItemSequence !== sourceItem.sequence
    ) {
      throw new Error("Channel Intent v2 projection does not match the source turn assignment.");
    }
    this.assertChannelIntentDecisionRefsInChannel(input.channelId, input);
    if ((input.selectedTeammateIds?.length ?? 0) > 0 && !input.participantManifest) {
      throw new Error("Channel Intent v2 selected participants require an explicit participant manifest.");
    }
    const decision: ChannelIntentDecision = {
      schemaVersion: 2,
      id: createChannelIntentDecisionId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      sourceTurnId: sourceItem.turnId,
      sourceItemId: sourceItem.id,
      contextSegmentId: assignment.segmentId,
      contextProjectionVersion: input.contextProjection.projectionVersion,
      action: input.action,
      selectedTeammateIds: input.selectedTeammateIds ?? [],
      participantManifest: input.participantManifest ?? createRequiredParticipantManifestV1([]),
      proposalId: input.proposalId,
      resultItemIds: input.resultItemIds ?? [],
      workflowId: input.workflowId,
      reason: input.reason,
      clarification: input.clarification,
      execution: input.execution,
      status: input.status,
      createdBy: input.createdBy,
      errorCode: input.errorCode,
      createdAt: now,
      updatedAt: now,
    };
    validateChannelIntentDecisionInput(decision);
    const pending = decision.clarification?.pendingOperation;
    if (pending) {
      if (pending.sourceRevision !== sourceItem.revision || pending.fingerprint !== channelPendingOperationFingerprintV1(pending)
        || pending.sourceAssignmentId !== assignment.id || pending.sourceAssignmentRevision !== assignment.revision) {
        throw new Error("channel_pending_operation.draft_identity_invalid");
      }
      this.assertPendingSources(decision);
    }
    this.context.database
      .prepare(`
        INSERT INTO channel_intent_decisions (
          id,
          schema_version,
          workspace_id,
          channel_id,
          source_turn_id,
          source_item_id,
          context_segment_id,
          context_projection_version,
          action,
          selected_teammate_ids_json,
          participant_manifest_json,
          proposal_id,
          result_item_ids_json,
          workflow_id,
          reason,
          clarification_json,
          execution_json,
          status,
          created_by,
          error_code,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        decision.id,
        decision.schemaVersion,
        decision.workspaceId,
        decision.channelId,
        decision.sourceTurnId,
        decision.sourceItemId,
        decision.contextSegmentId,
        decision.contextProjectionVersion,
        decision.action,
        stringifyJson(decision.selectedTeammateIds),
        stringifyJson(decision.participantManifest),
        decision.proposalId ?? null,
        stringifyJson(decision.resultItemIds),
        decision.workflowId ?? null,
        decision.reason,
        decision.clarification ? stringifyJson(decision.clarification) : null,
        decision.execution ? stringifyJson(decision.execution) : null,
        decision.status,
        decision.createdBy,
        decision.errorCode ?? null,
        decision.createdAt,
        decision.updatedAt,
      );
    const created = this.getChannelIntentDecision(decision.id);
    if (!created) {
      throw new Error(`Failed to create channel intent decision: ${decision.id}`);
    }
    return created;
  }

  getChannelIntentDecision(id: string): ChannelIntentDecision | undefined {
    const row = this.context.database.prepare(channelIntentDecisionSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelIntentDecision(row as Record<string, SQLOutputValue>) : undefined;
  }

  getChannelPendingOperationResolution(pendingDecisionId: string): ChannelPendingOperationResolution | undefined {
    const row = this.context.database.prepare(`SELECT pending_decision_id,draft_fingerprint,answer_item_id,
      answer_revision,question_revision,decision_id,created_at FROM channel_pending_operation_resolutions
      WHERE pending_decision_id=?`).get(pendingDecisionId);
    return row ? { pendingDecisionId: String(row.pending_decision_id), draftFingerprint: String(row.draft_fingerprint),
      answerItemId: String(row.answer_item_id), answerRevision: Number(row.answer_revision),
      questionRevision: Number(row.question_revision), decisionId: String(row.decision_id), createdAt: String(row.created_at) } : undefined;
  }

  /** Host-only synchronous publication; it may write a proposal/decision, never start an OS effect. */
  resolveChannelPendingOperation(input: ResolveChannelPendingOperationInput,
    publish: () => ChannelIntentDecision, now: string): ChannelPendingOperationResolved {
    if (Object.prototype.toString.call(publish) === "[object AsyncFunction]") throw new TypeError("Pending operation publication must be synchronous");
    const frozen = { ...input };
    if (!Number.isSafeInteger(frozen.expectedAnswerRevision) || frozen.expectedAnswerRevision < 0
      || !Number.isSafeInteger(frozen.expectedQuestionRevision) || frozen.expectedQuestionRevision < 0
      || !/^[a-f0-9]{64}$/u.test(frozen.expectedDraftFingerprint)
      || !Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now) {
      throw new Error("channel_pending_operation.invalid_resolution");
    }
    const db = this.context.database;
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getChannelPendingOperationResolution(frozen.pendingDecisionId);
      if (existing) {
        const decision = this.getChannelIntentDecision(existing.decisionId);
        if (existing.answerItemId !== frozen.answerItemId || existing.answerRevision !== frozen.expectedAnswerRevision
          || existing.questionRevision !== frozen.expectedQuestionRevision || existing.draftFingerprint !== frozen.expectedDraftFingerprint
          || !decision || decision.sourceItemId !== existing.answerItemId) throw new Error("channel_pending_operation.already_consumed");
        db.exec("COMMIT");
        return { decision, replayed: true };
      }
      const pending = this.getChannelIntentDecision(frozen.pendingDecisionId);
      const draft = pending?.clarification?.pendingOperation;
      const original = pending && this.ports.getEffectiveConversationItem(pending.sourceItemId);
      const answer = this.ports.getEffectiveConversationItem(frozen.answerItemId);
      const question = pending?.resultItemIds.length === 1 && this.ports.getEffectiveConversationItem(pending.resultItemIds[0]!);
      if (!pending || pending.action !== "clarify" || !["accepted", "suppressed"].includes(pending.status) || !draft
        || pending.execution || pending.proposalId || pending.workflowId
        || draft.fingerprint !== frozen.expectedDraftFingerprint || draft.fingerprint !== channelPendingOperationFingerprintV1(draft)
        || !original || original.id !== pending.sourceItemId || original.revision !== draft.sourceRevision
        || original.kind !== "user_message" || original.actorType !== "local_user" || original.status !== "committed"
        || !answer || answer.id !== frozen.answerItemId || answer.kind !== "user_message" || answer.actorType !== "local_user"
        || answer.status !== "committed" || answer.revision !== frozen.expectedAnswerRevision || !answer.turnId
        || !question || question.id !== pending.resultItemIds[0] || question.kind !== "assistant_message"
        || question.status !== "committed" || question.revision !== frozen.expectedQuestionRevision
        || !["ling_agent", "teammate"].includes(question.actorType)
        || question.turnId !== pending.sourceTurnId || question.payload.body !== pending.clarification!.question
        || !question.domainRefs.some(ref => ref.type === "conversation_item" && ref.id === original.id)
        || [original, question, answer].some(item => item.channelId !== pending.channelId || item.threadId !== original.threadId)
        || original.sequence >= question.sequence || question.sequence >= answer.sequence
        || answer.payload.replyToItemId && ![original.id, question.id].includes(answer.payload.replyToItemId)) {
        throw new Error("channel_pending_operation.stale_source");
      }
      const originalAssignment = this.ports.getEffectiveTurnContextAssignment(pending.sourceTurnId);
      const answerAssignment = this.ports.getEffectiveTurnContextAssignment(answer.turnId);
      const prior = [...this.ports.listConversationItemsForSegment({ threadId: answer.threadId,
        segmentId: pending.contextSegmentId, throughSequence: answer.sequence, limit: 500 })]
        .reverse().find(item => item.kind === "user_message" && item.sequence < answer.sequence);
      if (originalAssignment?.segmentId !== pending.contextSegmentId || answerAssignment?.segmentId !== pending.contextSegmentId
        || originalAssignment.id !== draft.sourceAssignmentId || originalAssignment.revision !== draft.sourceAssignmentRevision
        || prior?.id !== original.id || this.listChannelIntentDecisions({ sourceItemId: original.id, limit: 1 })[0]?.id !== pending.id
        || this.listChannelIntentDecisions({ sourceItemId: answer.id, limit: 1 }).length > 0) {
        throw new Error("channel_pending_operation.retired_request");
      }
      this.assertPendingSources(pending);
      const published = publish();
      if (published && typeof Reflect.get(published, "then") === "function") {
        // Do not assimilate an arbitrary thenable: its then() could publish
        // after this transaction has rolled back. Host callbacks are sync-only.
        if (published instanceof Promise) void published.catch(() => undefined);
        throw new TypeError("Pending operation publication must be synchronous");
      }
      const decision = published?.id ? this.getChannelIntentDecision(published.id) : undefined;
      if (!decision || JSON.stringify(decision) !== JSON.stringify(published) || decision.sourceItemId !== answer.id
        || decision.sourceTurnId !== answer.turnId || decision.channelId !== pending.channelId
        || decision.contextSegmentId !== pending.contextSegmentId || !["accepted", "suppressed"].includes(decision.status)) {
        throw new Error("channel_pending_operation.invalid_publication");
      }
      if (decision.action === "execute" || decision.action === "workflow_proposal") {
        if (decision.execution?.bindingVersion !== 1 || decision.participantManifest.fingerprint !== draft.participantManifest.fingerprint
          || JSON.stringify(decision.selectedTeammateIds) !== JSON.stringify(draft.participantManifest.participants.map(item => item.participantId))) {
          throw new Error("channel_pending_operation.changed_frozen_plan");
        }
        const restored = decision.execution.operations.map(operation => {
          if (!draft.slots.some(slot => slot.operationId === operation.id)) return operation;
          const { commandInputScope, ...binding } = operation.binding!;
          const answerRef = binding.sourceRefs.at(-1);
          if (!commandInputScope || commandInputScope.sourceRefs.some(ref => ref.itemId !== answer.id || ref.revision !== answer.revision
            || ref.actorType !== "local_user" || !answer.payload.body.includes(ref.quote))
            || answerRef?.itemId !== answer.id || answerRef.revision !== answer.revision
            || answerRef.actorType !== "local_user" || answerRef.quote !== answer.payload.body) {
            throw new Error("channel_pending_operation.changed_frozen_plan");
          }
          return { ...operation, binding: { ...binding, sourceRefs: binding.sourceRefs.slice(0, -1) } };
        });
        if (draft.slots.some(slot => !decision.execution!.operations.some(operation => operation.id === slot.operationId))
          || channelOperationPlanFingerprintV1(restored) !== draft.execution.fingerprint) {
          throw new Error("channel_pending_operation.changed_frozen_plan");
        }
      }
      db.prepare(`INSERT INTO channel_pending_operation_resolutions(pending_decision_id,draft_fingerprint,
        answer_item_id,answer_revision,question_revision,decision_id,created_at) VALUES(?,?,?,?,?,?,?)`)
        .run(pending.id, draft.fingerprint, answer.id, answer.revision, question.revision, decision.id, now);
      db.exec("COMMIT");
      return { decision, replayed: false };
    } catch (error) {
      rollbackOwnedSqliteTransaction(db);
      throw error;
    }
  }

  private assertPendingSources(decision: ChannelIntentDecision): void {
    const original = this.ports.getConversationItem(decision.sourceItemId)!;
    for (const operation of decision.clarification!.pendingOperation!.execution.operations) {
      const binding = operation.binding!;
      const refs = [...binding.sourceRefs, ...binding.inputRefs.flatMap(ref => ref.sourceRefs),
        ...binding.outputRefs.flatMap(ref => ref.sourceRefs), ...(binding.contentSource?.sourceRefs ?? []),
        ...(binding.workingDirectory?.sourceRefs ?? []), ...(binding.commandInputScope?.sourceRefs ?? []),
        ...(binding.commandGoal?.sourceRefs ?? [])];
      for (const ref of refs) {
        const item = this.ports.getEffectiveConversationItem(ref.itemId);
        if (!item || item.id !== ref.itemId || item.channelId !== decision.channelId || item.status !== "committed"
          || item.threadId !== original.threadId || item.sequence > original.sequence || !item.turnId
          || this.ports.getEffectiveTurnContextAssignment(item.turnId)?.segmentId !== decision.contextSegmentId
          || (item.kind !== "user_message" && item.kind !== "assistant_message") || ref.revision !== item.revision
          || ref.actorType !== item.actorType || !item.payload.body.includes(ref.quote)) {
          throw new Error("channel_pending_operation.stale_draft_source");
        }
      }
    }
  }

  listChannelIntentDecisions(options: ListChannelIntentDecisionsOptions = {}): ChannelIntentDecision[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.sourceItemId) {
      clauses.push("source_item_id = ?");
      params.push(options.sourceItemId);
    }
    if (options.action) {
      clauses.push("action = ?");
      params.push(options.action);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.context.database
      .prepare(`${channelIntentDecisionSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapChannelIntentDecision(row as Record<string, SQLOutputValue>));
  }

  private assertChannelIntentDecisionRefsInChannel(
    channelId: string,
    input: Pick<CreateChannelIntentDecisionInput, "selectedTeammateIds" | "participantManifest" | "proposalId" | "resultItemIds" | "workflowId" | "execution">,
  ): void {
    for (const teammateId of input.selectedTeammateIds ?? []) {
      if (!this.ports.hasAiTeammate(teammateId)) {
        throw new Error(`AI teammate not found: ${teammateId}`);
      }
    }
    for (const participant of input.participantManifest?.participants ?? []) {
      if (!this.ports.hasAiTeammate(participant.participantId)) {
        throw new Error(`AI teammate not found: ${participant.participantId}`);
      }
    }
    if (input.proposalId) {
      this.ports.assertProposalInChannel(channelId, input.proposalId);
    }
    for (const resultItemId of input.resultItemIds ?? []) {
      this.ports.assertItemInChannel(channelId, resultItemId);
    }
    if (input.workflowId) {
      this.ports.assertWorkflowInChannel(channelId, input.workflowId);
    }
    for (const operation of input.execution?.operations ?? []) {
      const targetRef = operation.targetRef;
      if (targetRef && (targetRef.type === "conversation_item" || targetRef.type === "message")) {
        this.ports.assertItemInChannel(channelId, targetRef.id);
      }
    }
  }
}

function validateChannelIntentDecisionInput(decision: ChannelIntentDecision): void {
  if (!isChannelIntentDecisionV2(decision)) {
    throw new Error("Channel Intent v2 decision failed schema validation.");
  }
  if ((decision.action === "execute" || decision.action === "workflow_proposal")
    && decision.participantManifest.participants.length === 0) {
    throw new Error("Executable Channel Intent requires a non-empty participant manifest.");
  }
}
