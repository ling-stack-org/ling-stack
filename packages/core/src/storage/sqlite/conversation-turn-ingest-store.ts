import { assertChannelSessionThreadWritable } from "./channel-session-admission.js";
import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import type {
  AppendConversationUserTurnInput,
  AppendConversationUserTurnResult,
  ChannelTurnDispatchRequestV1,
} from "../../conversation-turn-ingest-types.js";
import { isChannelTurnDispatchRequestV1 } from "../../conversation-turn-ingest-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import type { RunStore } from "../../run-types.js";
import {
  classifyWorkflowStepStartOwner,
  workflowStepStartOwnerMatches,
  type WorkflowStepStartReadStore,
} from "../../workflow-step-start-owner.js";
import { defaultRuntimeTimeoutPolicy } from "../../runtime-supervisor-types.js";
import { parseJson, readNullableString, readString, stringifyJson } from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";
import { SqliteConversationItemStore } from "./conversation-item-store.js";

const BOOTSTRAP_SEGMENT_POLICY_VERSION = "continuity-v2-bootstrap-v1";

export class SqliteConversationTurnIngestStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly items: SqliteConversationItemStore,
    private readonly workflowInputs?: WorkflowStepStartReadStore & Pick<RunStore, "getLingThread" | "getLingTurnForRun">,
  ) {}

  appendUserTurn(input: AppendConversationUserTurnInput, now: string): AppendConversationUserTurnResult {
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.appendUserTurnWithinTransaction(input, now);
      this.context.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }
  }

  appendUserTurnWithinTransaction(
    input: AppendConversationUserTurnInput,
    now: string,
  ): AppendConversationUserTurnResult {
    const scope = this.resolveThreadScope(input, now);
    const actorType = input.actorType ?? "local_user";
    if (actorType !== "local_user" && actorType !== "system") {
      throw new Error(`Conversation turn input actor is not supported: ${actorType}`);
    }
    const createdByActor = actorType === "system" ? "system" : "local-user";
    if (scope.channelId) assertChannelSessionThreadWritable(this.context.database, input.threadId);
    const replay = this.items.getConversationItemByIdempotencyKey(input.threadId, input.idempotencyKey);
      if (replay) {
        if (replay.kind !== "user_message" || !replay.turnId || replay.channelId !== input.channelId) {
          throw new Error(`Conversation turn idempotency key belongs to another input: ${input.idempotencyKey}`);
        }
        const replayTurn = this.context.database.prepare(`
          SELECT thread_id, kind, channel_id, task_id, teammate_id, workflow_step_id, external_work_id, title, user_instruction,
                 source_item_id, source_turn_id, intervention_id, created_by_actor
          FROM ling_turns
          WHERE workspace_id = ? AND id = ?
        `).get(DEFAULT_WORKSPACE_ID, replay.turnId) as Record<string, SQLOutputValue> | undefined;
        if (!replayTurn
          || replay.threadId !== input.threadId
          || (input.itemId !== undefined && input.itemId !== replay.id)
          || (input.turnId !== undefined && input.turnId !== replay.turnId)
          || replay.actorId !== input.actorId
          || replay.actorType !== actorType
          || replay.visibility !== scope.visibility
          || replay.visibilityOwnerId !== scope.visibilityOwnerId
          || replay.supersedesItemId !== input.supersedesItemId
          || !sameUserMessagePayload(replay.payload, input.payload)
          || JSON.stringify(replay.domainRefs) !== JSON.stringify(input.domainRefs ?? [])
          || readString(replayTurn, "title") !== input.title
          || readString(replayTurn, "user_instruction") !== input.userInstruction
          || readString(replayTurn, "thread_id") !== input.threadId
          || readString(replayTurn, "kind") !== (input.turnKind ?? "initial_request")
          || readNullableString(replayTurn, "channel_id") !== scope.channelId
          || readNullableString(replayTurn, "task_id") !== scope.taskId
          || readNullableString(replayTurn, "teammate_id") !== scope.teammateId
          || readNullableString(replayTurn, "workflow_step_id") !== scope.workflowStepId
          || readNullableString(replayTurn, "external_work_id") !== scope.externalWorkId
          || readNullableString(replayTurn, "source_turn_id") !== input.sourceTurnId
          || readNullableString(replayTurn, "intervention_id") !== input.interventionId
          || readString(replayTurn, "created_by_actor") !== createdByActor
          || readString(replayTurn, "source_item_id") !== replay.id) {
          throw new Error(`Conversation turn idempotency key belongs to another input: ${input.idempotencyKey}`);
        }
        const assignment = this.context.database.prepare(`
          SELECT segment_id, status
          FROM turn_context_assignments
          WHERE turn_id = ?
          ORDER BY revision DESC
          LIMIT 1
        `).get(replay.turnId) as Record<string, SQLOutputValue> | undefined;
        // Match getEffectiveTurnContextAssignment: a persisted provisional
        // decision is effective too. Never fall back to an older revision.
        if (!assignment || !["committed", "provisional"].includes(readString(assignment, "status"))) {
          throw new Error(`Conversation turn replay is missing its context assignment: ${replay.turnId}`);
        }
        return {
          turnId: replay.turnId,
          item: replay,
          contextSegmentId: readString(assignment, "segment_id"),
          ...(input.dispatch ? {
            dispatchWorkUnitId: this.requireMatchingDispatchWorkUnitId(replay.turnId, input),
          } : {}),
          idempotentReplay: true,
        };
      }

      if (scope.archived) throw new Error(`Ling thread is archived: ${input.threadId}`);
      if (scope.workflowStartPhase === "linked") {
        throw new Error(`Workflow step input generation is already linked: ${input.workflowStepStart!.workflowStepId}`);
      }
      if (input.sourceTurnId) {
        const source = this.context.database.prepare(`
          SELECT thread_id FROM ling_turns WHERE workspace_id = ? AND id = ?
        `).get(DEFAULT_WORKSPACE_ID, input.sourceTurnId) as Record<string, SQLOutputValue> | undefined;
        if (!source || readString(source, "thread_id") !== input.threadId) {
          throw new Error(`Source Ling turn does not belong to thread: ${input.sourceTurnId}`);
        }
      }

      const turnId = input.turnId ?? `turn_${randomUUID()}`;
      const itemId = input.itemId ?? `item_${randomUUID()}`;
      this.context.database.prepare(`
        INSERT INTO ling_turns (
          id, workspace_id, thread_id, kind, status, title, user_instruction,
          channel_id, task_id, teammate_id, workflow_step_id, external_work_id,
          automation_id, source_item_id, source_turn_id, intervention_id,
          active_run_id, last_run_id, created_by_actor, created_at, updated_at,
          completed_at
        ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?,
          ?, NULL, NULL, ?, ?, ?, NULL)
      `).run(
        turnId,
        DEFAULT_WORKSPACE_ID,
        input.threadId,
        input.turnKind ?? "initial_request",
        input.title,
        input.userInstruction,
        scope.channelId ?? null,
        scope.taskId ?? null,
        scope.teammateId ?? null,
        scope.workflowStepId ?? null,
        scope.externalWorkId ?? null,
        itemId,
        input.sourceTurnId ?? null,
        input.interventionId ?? null,
        createdByActor,
        now,
        now,
      );
      const item = this.items.appendConversationItemWithinTransaction({
        id: itemId,
        channelId: input.channelId,
        threadId: input.threadId,
        turnId,
        kind: "user_message",
        status: "committed",
        actorType,
        ...(input.actorId ? { actorId: input.actorId } : {}),
        visibility: scope.visibility,
        ...(scope.visibilityOwnerId ? { visibilityOwnerId: scope.visibilityOwnerId } : {}),
        payload: input.payload,
        domainRefs: input.domainRefs ?? [],
        idempotencyKey: input.idempotencyKey,
        ...(input.supersedesItemId ? { supersedesItemId: input.supersedesItemId } : {}),
      }, now);
      const segmentId = this.resolveOrCreateSegment(turnId, input.threadId, now);
      this.context.database.prepare(`
        INSERT INTO turn_context_assignments (
          id, workspace_id, turn_id, segment_id, status, revision,
          decision_source, confidence, antecedent_turn_id, evidence_refs_json,
          policy_version, supersedes_assignment_id, created_at
        ) VALUES (?, ?, ?, ?, 'committed', 1, 'structural', 1, ?, ?, ?, NULL, ?)
      `).run(
        `assignment_${turnId}`,
        DEFAULT_WORKSPACE_ID,
        turnId,
        segmentId,
        input.sourceTurnId ?? null,
        stringifyJson([
          ...(input.payload.replyToItemId
            ? [{ type: "conversation_item", id: input.payload.replyToItemId }]
            : []),
          ...(input.payload.quotedItemIds ?? []).map((id) => ({ type: "conversation_item", id })),
        ]),
        BOOTSTRAP_SEGMENT_POLICY_VERSION,
        now,
      );
      const dispatchWorkUnitId = input.dispatch ? `work_unit_${randomUUID()}` : undefined;
      if (dispatchWorkUnitId) this.context.database.prepare(`
        INSERT INTO work_units (
          id, workspace_id, kind, owner_type, owner_id, channel_id, task_id,
          teammate_id, provider_preset_id, runner_id, requested_runner_id,
          effective_runner_id, runner_fallback_reason_json, idempotency_key,
          status, priority, attempt_count, active_attempt_id, created_by_client_id,
          created_by_actor, request_json, timeout_policy_json, linked_run_id,
          linked_message_id, linked_media_job_id, linked_external_work_id,
          created_at, updated_at, started_at, ended_at, last_event_at,
          last_heartbeat_at, error_code, error_message
        ) VALUES (?, ?, 'channel_turn_dispatch', 'ling_turn', ?, ?, NULL, NULL, NULL,
          NULL, NULL, NULL, NULL, ?, 'queued', 0, 0, NULL, NULL, 'user', ?, ?, NULL,
          ?, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)
      `).run(
        dispatchWorkUnitId,
        DEFAULT_WORKSPACE_ID,
        turnId,
        scope.channelId ?? null,
        `channel-turn-dispatch:${turnId}`,
        stringifyJson({
          ...input.dispatch,
          sourceTurnId: turnId,
          sourceItemId: item.id,
          channelId: input.channelId,
          threadId: input.threadId,
        }),
        stringifyJson({
          ...defaultRuntimeTimeoutPolicy,
          idleTimeoutMs: 30_000,
          hardTimeoutMs: 120_000,
        }),
        item.id,
        now,
        now,
      );
      if (dispatchWorkUnitId) this.context.database.prepare(`
        INSERT INTO runtime_events (
          id, work_unit_id, attempt_id, seq, ts, type, actor, data_json
        ) VALUES (?, ?, NULL, 1, ?, 'work_unit_created', 'local-user', ?)
      `).run(
        `runtime_event_${randomUUID()}`,
        dispatchWorkUnitId,
        now,
        stringifyJson({
          kind: "channel_turn_dispatch",
          ownerType: "ling_turn",
          ownerId: turnId,
          sourceItemId: item.id,
        }),
      );
      this.onUserMessage?.(input.threadId, input.payload.body);
      return {
        turnId,
        item,
        contextSegmentId: segmentId,
        ...(dispatchWorkUnitId ? { dispatchWorkUnitId } : {}),
        idempotentReplay: false,
      };
  }

  /** Resolve authority from the durable Thread, never from a caller's visibility flag. */
  private resolveThreadScope(input: AppendConversationUserTurnInput, now: string): {
    readonly channelId?: string;
    readonly taskId?: string;
    readonly teammateId?: string;
    readonly workflowStepId?: string;
    readonly externalWorkId?: string;
    readonly visibility: "channel" | "thread_participants" | "agent_private";
    readonly visibilityOwnerId?: string;
    readonly archived: boolean;
    readonly workflowStartPhase?: "preparing" | "linked";
  } {
    const thread = this.context.database.prepare(`
      SELECT kind, channel_id, task_id, teammate_id, workflow_id, workflow_step_id, external_work_id, status, archived_at
      FROM ling_threads WHERE workspace_id = ? AND id = ?
    `).get(DEFAULT_WORKSPACE_ID, input.threadId) as Record<string, SQLOutputValue> | undefined;
    if (!thread) throw new Error(`Ling thread not found: ${input.threadId}`);
    const archived = readString(thread, "status") === "archived" || Boolean(readNullableString(thread, "archived_at"));
    const kind = readString(thread, "kind");
    const channelId = readNullableString(thread, "channel_id");
    const teammateId = readNullableString(thread, "teammate_id");
    const generation = input.workflowStepStart ? this.resolveWorkflowInputGeneration(input, thread, now) : undefined;
    const owners = {
      taskId: generation?.taskId ?? readNullableString(thread, "task_id"),
      workflowStepId: readNullableString(thread, "workflow_step_id"),
      externalWorkId: readNullableString(thread, "external_work_id"),
    };
    if (channelId !== input.channelId) {
      throw new Error(`Ling thread does not belong to channel: ${input.threadId}`);
    }
    if (input.teammateId !== undefined && input.teammateId !== teammateId) {
      throw new Error(`Ling thread does not belong to teammate: ${input.threadId}`);
    }
    if (kind === "conversation" || kind === "teammate_direct") {
      if (channelId || input.dispatch) {
        throw new Error(`Non-channel conversation cannot accept a channel dispatch: ${input.threadId}`);
      }
      if (kind === "teammate_direct" && !teammateId?.trim()) {
        throw new Error(`Private conversation thread has no teammate owner: ${input.threadId}`);
      }
      for (const itemId of [input.payload.replyToItemId, ...(input.payload.quotedItemIds ?? [])]) {
        if (!itemId) continue;
        const referenced = this.items.getEffectiveConversationItem(itemId);
        if (!referenced || referenced.threadId !== input.threadId) {
          throw new Error(`Conversation source item does not belong to thread: ${itemId}`);
        }
      }
      return {
        ...owners,
        teammateId,
        archived,
        visibility: kind === "teammate_direct" ? "agent_private" : "thread_participants",
        ...(kind === "teammate_direct" ? { visibilityOwnerId: teammateId } : {}),
      };
    }
    if (!channelId) throw new Error(`Conversation turn thread kind is not supported: ${kind}`);
    return { ...owners, channelId, teammateId, visibility: "channel", archived,
      ...(generation ? { workflowStartPhase: generation.phase } : {}) };
  }

  /** Retry Tasks own their Turn, not the stable workflow-step Thread's historical Task field. */
  private resolveWorkflowInputGeneration(input: AppendConversationUserTurnInput,
    thread: Record<string, SQLOutputValue>, now: string): { readonly taskId: string; readonly phase: "preparing" | "linked" } {
    const expected = input.workflowStepStart!;
    const store = this.workflowInputs;
    const step = store?.getChannelWorkflowStep(expected.workflowStepId);
    const workflow = step && store?.getChannelWorkflow(step.workflowId);
    const task = store?.getTask(expected.taskId);
    const ownership = step && store && classifyWorkflowStepStartOwner(store, step, now);
    if (!store || !step || !workflow || !task || !ownership || ownership.status === "invalid"
      || readString(thread, "kind") !== "workflow_step" || readString(thread, "status") === "cancelled"
      || input.actorType !== "system" || input.actorId !== "workflow-dispatch" || input.dispatch
      || readNullableString(thread, "workflow_id") !== expected.workflowId
      || readNullableString(thread, "workflow_step_id") !== step.id
      || readNullableString(thread, "channel_id") !== step.channelId
      || readNullableString(thread, "teammate_id") !== step.toParticipantId
      || step.workspaceId !== DEFAULT_WORKSPACE_ID || workflow.workspaceId !== DEFAULT_WORKSPACE_ID
      || task.workspaceId !== DEFAULT_WORKSPACE_ID || expected.workflowId !== workflow.id
      || workflow.id !== step.workflowId || workflow.channelId !== step.channelId
      || step.taskId !== expected.taskId || expected.owner.taskId !== expected.taskId
      || task.channelId !== step.channelId || task.assigneeTeammateId !== step.toParticipantId
      || !["todo", "claimed", "running", "waiting_for_approval"].includes(task.status)
      || !workflowStepStartOwnerMatches(ownership.owner, expected.owner)) {
      throw new Error(`Workflow step input generation lineage is invalid: ${expected.workflowStepId}`);
    }
    const sourceId = step.metadata?.sourceMessageId ?? workflow.metadata?.sourceMessageId;
    if (sourceId) {
      const item = store.getConversationItem(sourceId);
      const turn = item?.turnId ? store.getLingTurn(item.turnId) : undefined;
      const parentThread = item ? store.getLingThread(item.threadId) : undefined;
      if (!item || !turn || !parentThread || item.kind !== "user_message" || item.status !== "committed"
        || item.visibility !== "channel" || item.channelId !== step.channelId || item.workspaceId !== DEFAULT_WORKSPACE_ID
        || turn.workspaceId !== DEFAULT_WORKSPACE_ID || turn.threadId !== item.threadId || turn.sourceItemId !== item.id
        || turn.channelId !== step.channelId || ["cancelled", "superseded"].includes(turn.status)
        || parentThread.workspaceId !== DEFAULT_WORKSPACE_ID || parentThread.channelId !== step.channelId
        || ["archived", "cancelled"].includes(parentThread.status) || Boolean(parentThread.archivedAt)
        || step.metadata?.sourceMessageId !== undefined && step.metadata.sourceMessageId !== item.id
        || workflow.metadata?.sourceMessageId !== undefined && workflow.metadata.sourceMessageId !== item.id
        || workflow.metadata?.sourceTurnId !== undefined && workflow.metadata.sourceTurnId !== turn.id) {
        throw new Error(`Workflow step source lineage is invalid: ${step.id}`);
      }
    } else if (workflow.metadata?.sourceTurnId !== undefined) {
      throw new Error(`Workflow step source lineage is invalid: ${step.id}`);
    }
    if (expected.parentRunId) {
      const previousTurn = store.getLingTurnForRun(expected.parentRunId);
      if (!previousTurn || previousTurn.threadId !== input.threadId || previousTurn.id !== input.sourceTurnId) {
        throw new Error(`Workflow step parent Run has no matching canonical Turn: ${expected.parentRunId}`);
      }
    }
    return { taskId: task.id, phase: ownership.status };
  }

  private requireMatchingDispatchWorkUnitId(
    turnId: string,
    input: AppendConversationUserTurnInput,
  ): string {
    const row = this.context.database.prepare(`
      SELECT id, request_json
      FROM work_units
      WHERE workspace_id = ?
        AND kind = 'channel_turn_dispatch'
        AND owner_type = 'ling_turn'
        AND owner_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(DEFAULT_WORKSPACE_ID, turnId) as Record<string, SQLOutputValue> | undefined;
    const stored = row ? parseJson(readString(row, "request_json")) : undefined;
    if (!row || !input.dispatch || !isChannelTurnDispatchRequestV1(stored)
      || stringifyJson(stableDispatchReplayKey(stored)) !== stringifyJson(stableDispatchReplayKey(input.dispatch))) {
      throw new Error(`Conversation turn idempotency key belongs to another dispatch input: ${input.idempotencyKey}`);
    }
    return readString(row, "id");
  }

  private resolveOrCreateSegment(turnId: string, threadId: string, now: string): string {
    const existing = this.context.database.prepare(`
      SELECT segments.id
      FROM conversation_items source
      CROSS JOIN ling_turns turns ON turns.id = source.turn_id AND turns.source_item_id = source.id
      CROSS JOIN turn_context_assignments assignments ON assignments.turn_id = turns.id
      CROSS JOIN context_segments segments ON segments.id = assignments.segment_id
      WHERE source.workspace_id = ? AND source.thread_id = ?
        AND source.kind = 'user_message' AND source.status = 'committed'
        AND turns.workspace_id = source.workspace_id AND turns.thread_id = source.thread_id
        AND assignments.workspace_id = source.workspace_id
        AND segments.workspace_id = source.workspace_id AND segments.thread_id = source.thread_id
        AND segments.state = 'active'
        AND assignments.status IN ('committed', 'provisional')
        AND NOT EXISTS (
          SELECT 1 FROM turn_context_assignments newer
          WHERE newer.turn_id = assignments.turn_id AND newer.revision > assignments.revision
        )
      -- Repairing the former segment also touches its updated_at. Only an
      -- effective assignment of the latest source supplies its continuation.
      -- CROSS JOIN keeps the indexed source sequence as the outer scan; a late
      -- correction of an older Turn cannot move the current conversation.
      ORDER BY source.sequence DESC
      LIMIT 1
    `).get(DEFAULT_WORKSPACE_ID, threadId) as Record<string, SQLOutputValue> | undefined;
    if (existing) {
      const segmentId = readString(existing, "id");
      this.context.database.prepare(`
        UPDATE context_segments
        SET last_active_turn_id = ?, revision = revision + 1, updated_at = ?
        WHERE id = ?
      `).run(turnId, now, segmentId);
      return segmentId;
    }
    const segmentId = `segment_${randomUUID()}`;
    this.context.database.prepare(`
      INSERT INTO context_segments (
        id, workspace_id, thread_id, state, label, created_from_turn_id,
        last_active_turn_id, merged_into_segment_id, revision, created_at, updated_at
      ) VALUES (?, ?, ?, 'active', NULL, ?, ?, NULL, 1, ?, ?)
    `).run(segmentId, DEFAULT_WORKSPACE_ID, threadId, turnId, turnId, now, now);
    return segmentId;
  }
}

function stableDispatchReplayKey(
  value: NonNullable<AppendConversationUserTurnInput["dispatch"]> | ChannelTurnDispatchRequestV1,
): object {
  return {
    schemaVersion: value.schemaVersion,
    requestAiReply: value.requestAiReply,
    ...(value.requestedProviderPresetId ? { requestedProviderPresetId: value.requestedProviderPresetId } : {}),
    ...(value.requestedTeammateId ? { requestedTeammateId: value.requestedTeammateId } : {}),
    ...(value.explicitContextSegmentId ? { explicitContextSegmentId: value.explicitContextSegmentId } : {}),
    ...(value.surface ? { surface: value.surface } : {}),
    ...(value.replyDisposition ? { replyDisposition: value.replyDisposition } : {}),
  };
}

function sameUserMessagePayload(
  existing: AppendConversationUserTurnInput["payload"],
  requested: AppendConversationUserTurnInput["payload"],
): boolean {
  // Labels are current presentation data (for example a teammate rename), not
  // input identity. Preserve the accepted label while comparing exact ids.
  const existingMentionIds = existing.mentions.map((mention) => [mention.kind, mention.id]);
  const requestedMentionIds = requested.mentions.map((mention) => [mention.kind, mention.id]);
  return existing.body === requested.body
    && existing.format === requested.format
    && JSON.stringify(existingMentionIds) === JSON.stringify(requestedMentionIds)
    && JSON.stringify(existing.attachmentIds) === JSON.stringify(requested.attachmentIds)
    && JSON.stringify(existing.linkPreviewIds) === JSON.stringify(requested.linkPreviewIds)
    && JSON.stringify(existing.fileRefs) === JSON.stringify(requested.fileRefs)
    && existing.replyToItemId === requested.replyToItemId
    && JSON.stringify(existing.quotedItemIds ?? []) === JSON.stringify(requested.quotedItemIds ?? []);
}
