import type {
  ConversationTimelineCommandExecutionItem,
  ConversationTimelineContextCompactionItem,
  ConversationTimelineFileChangeItem,
  ConversationTimelineImageViewItem,
  ConversationTimelineItem,
  ConversationTimelineItemStatus,
  ConversationTimelineOperationPayload,
  ConversationTimelinePlanItem,
  ConversationTimelineSubAgentItem,
  ConversationTimelineToolCallItem,
  ConversationTimelineExplorationItem,
  ConversationTimelineApprovalItem,
  ConversationTimelineDiagnosticItem,
} from "./transcript-item.js";

export interface CanonicalProjectionSourceRef {
  readonly kind: string;
  readonly id: string;
  readonly label?: string;
  readonly path?: string;
  readonly hostTarget?: "open_file" | "open_diff" | "open_artifact" | "open_run";
  readonly capabilityId?: string;
  readonly workspaceId?: string;
  readonly visibility?: "conversation" | "private" | "audit";
}

/** Structural mirror of ConversationItemV1 used by the framework-neutral UI package. */
export interface CanonicalConversationItem {
  readonly id: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId?: string;
  readonly sequence: number;
  readonly kind:
    | "user_message"
    | "assistant_message"
    | "tool_call"
    | "tool_result"
    | "approval_request"
    | "approval_decision"
    | "handoff"
    | "operation_state"
    | "artifact_ref"
    | "system_event";
  readonly status: "pending" | "committed" | "failed";
  readonly actorType: "local_user" | "ling_agent" | "teammate" | "system";
  readonly actorId?: string;
  readonly revision: number;
  readonly payload: unknown;
  readonly domainRefs?: readonly { readonly type: string; readonly id: string; readonly label?: string }[];
}

export interface CanonicalSourceRef {
  readonly kind: string;
  readonly id: string;
  readonly label?: string;
  readonly path?: string;
  readonly hostTarget?: "open_file" | "open_diff" | "open_artifact" | "open_run";
  readonly capabilityId?: string;
  readonly workspaceId?: string;
  readonly visibility?: "conversation" | "private" | "audit";
}

export interface CanonicalCommandEvidence {
  readonly command: string;
  readonly cwd?: string;
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly latestEventSeq: number;
  readonly outputTail?: readonly {
    readonly eventSeq: number;
    readonly stream: "stdout" | "stderr";
    readonly text: string;
    readonly redacted: boolean;
  }[];
  readonly outputTruncated?: boolean;
}

/** Structural subset of ExecutionAction required by the transcript projector. */
export interface CanonicalExecutionAction {
  readonly id: string;
  readonly revision: number;
  readonly workspaceId: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly attemptNumber?: number;
  readonly turnRunRole?: "primary" | "retry" | "resume" | "repair" | "validation";
  readonly workUnitId?: string;
  readonly participantId?: string;
  /** The Host must make the absence of a workflow step explicit. */
  readonly workflowStepId: string | null;
  readonly approvalId?: string;
  readonly toolCallId?: string;
  readonly actionType: string;
  readonly risk?: "low" | "medium" | "high" | "critical";
  readonly status: string;
  readonly title: string;
  readonly summary?: string;
  readonly sourceRefs: readonly CanonicalSourceRef[];
  readonly diagnostics?: readonly {
    readonly code: "late_event" | "stale_event" | "source_conflict";
    readonly message: string;
    readonly sourceRefs: readonly CanonicalSourceRef[];
  }[];
  readonly previewArtifactIds?: readonly string[];
  readonly resultArtifactIds?: readonly string[];
  readonly commandEvidence?: CanonicalCommandEvidence;
}

/** Durable approval projection. It is joined to an action when possible. */
export interface CanonicalApprovalRecord {
  readonly id: string;
  readonly revision: number;
  readonly workspaceId: string;
  readonly threadId?: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly participantId?: string;
  readonly workflowStepId?: string;
  readonly actionId?: string;
  readonly toolCallId?: string;
  readonly anchorItemId?: string;
  readonly title: string;
  readonly summary?: string;
  readonly status: "pending" | "approved" | "denied" | "expired" | "cancelled";
  readonly sourceRefs: readonly CanonicalSourceRef[];
}

/** Host-owned file/diff/image/log evidence. */
export interface CanonicalArtifactRecord {
  readonly id: string;
  readonly revision: number;
  readonly workspaceId: string;
  readonly threadId?: string;
  readonly runId?: string;
  readonly actionId?: string;
  readonly anchorItemId?: string;
  readonly type: "file" | "diff" | "log" | "json" | "markdown" | "image" | "video";
  readonly path: string;
  readonly title?: string;
  readonly contentType?: string;
  readonly width?: number;
  readonly height?: number;
  readonly sourceRefs: readonly CanonicalSourceRef[];
}

export interface CanonicalPlanRecord {
  readonly id: string;
  readonly revision: number;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId?: string;
  readonly anchorItemId: string;
  readonly title?: string;
  readonly steps: readonly {
    readonly id: string;
    readonly text: string;
    readonly status: "pending" | "running" | "completed" | "blocked";
  }[];
  readonly sourceRefs: readonly CanonicalSourceRef[];
}

export interface CanonicalCompactionRecord {
  readonly id: string;
  readonly revision: number;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId?: string;
  readonly anchorItemId: string;
  readonly summary: string;
  readonly compactedTurnCount?: number;
  readonly snapshotRef?: CanonicalSourceRef;
  readonly sourceRefs: readonly CanonicalSourceRef[];
}

/** A parent-anchored participant span; children are already typed facts/messages. */
export interface CanonicalParticipantSpan {
  readonly id: string;
  readonly revision: number;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly anchorItemId: string;
  readonly parentActionId?: string;
  readonly participantId: string;
  readonly label: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly workflowStepId?: string;
  readonly lifecycle: "started" | "running" | "waiting" | "interrupted" | "completed" | "blocked" | "errored";
  readonly sourceRefs: readonly CanonicalSourceRef[];
  readonly childItems: readonly ConversationTimelineItem[];
}

/** Structural mirror of LingTurnRun used to choose the primary/latest run attempt. */
export interface CanonicalTurnRunLink {
  readonly runId: string;
  readonly turnId: string;
  readonly attemptNumber: number;
  readonly role: "primary" | "retry" | "resume" | "repair" | "validation";
}

export interface CanonicalTranscriptScope {
  readonly surface: "normal" | "private" | "channel_root" | "topic" | "branch" | "run_detail" | "child";
  readonly threadId: string;
  readonly workspaceId: string;
  readonly turnId?: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly participantId?: string;
  readonly depth: 0 | 1;
}

export interface CanonicalTranscriptProjectionInput {
  readonly scope: CanonicalTranscriptScope;
  readonly items: readonly CanonicalConversationItem[];
  readonly actions: readonly CanonicalExecutionAction[];
  /** Existing LingTurnRun links; no attempt table is introduced. */
  readonly turnRuns: readonly CanonicalTurnRunLink[];
  readonly approvals?: readonly CanonicalApprovalRecord[];
  readonly artifacts?: readonly CanonicalArtifactRecord[];
  readonly plans?: readonly CanonicalPlanRecord[];
  readonly compactions?: readonly CanonicalCompactionRecord[];
  readonly participantSpans?: readonly CanonicalParticipantSpan[];
  readonly sourceSequence: number;
  readonly sourceRevision: string;
  readonly previousCursor?: { readonly sourceSequence: number; readonly sourceRevision: string };
  /** Adapter diagnostics that are known before the pure projector runs. */
  readonly initialDiagnostics?: readonly CanonicalTranscriptDiagnostic[];
  /** ContextSnapshot-derived segment identity keyed by canonical item id. */
  readonly contextSegmentIdByItemId?: ReadonlyMap<string, string>;
}

/**
 * Merge a durable snapshot or a reconnect replay into the current canonical
 * projector input.  The merge is intentionally record-based: immutable
 * conversation history is unioned, while mutable facts are selected by their
 * numeric revision.  Equal-revision payload conflicts remain in the merged
 * arrays so the projector can fail closed instead of choosing transport order.
 */
export function mergeCanonicalTranscriptInputs(
  current: CanonicalTranscriptProjectionInput | undefined,
  incoming: CanonicalTranscriptProjectionInput,
): CanonicalTranscriptProjectionInput {
  if (!current) return incoming;
  const diagnostics: CanonicalTranscriptDiagnostic[] = [
    ...(current.initialDiagnostics ?? []),
    ...(incoming.initialDiagnostics ?? []),
  ];
  if (!sameScope(current.scope, incoming.scope)) {
    diagnostics.push({
      code: "scope_mismatch",
      sourceRefs: [],
      message: "Cannot merge canonical transcript inputs from different scopes.",
    });
    return { ...current, initialDiagnostics: diagnostics };
  }
  return {
    ...incoming,
    sourceSequence: Math.max(current.sourceSequence, incoming.sourceSequence),
    sourceRevision: selectSourceRevision(current, incoming),
    items: mergeVersionedRecords(current.items, incoming.items, (record) => record.id),
    actions: mergeVersionedRecords(current.actions, incoming.actions, (record) => record.id),
    turnRuns: mergeUniqueRecords(current.turnRuns, incoming.turnRuns, (record) => `${record.runId}:${record.turnId}:${record.attemptNumber}:${record.role}`),
    approvals: mergeVersionedRecords(current.approvals ?? [], incoming.approvals ?? [], (record) => record.id),
    artifacts: mergeVersionedRecords(current.artifacts ?? [], incoming.artifacts ?? [], (record) => record.id),
    plans: mergeVersionedRecords(current.plans ?? [], incoming.plans ?? [], (record) => record.id),
    compactions: mergeVersionedRecords(current.compactions ?? [], incoming.compactions ?? [], (record) => record.id),
    participantSpans: mergeVersionedRecords(current.participantSpans ?? [], incoming.participantSpans ?? [], (record) => record.id),
    contextSegmentIdByItemId: mergeContextSegmentLookups(current.contextSegmentIdByItemId, incoming.contextSegmentIdByItemId),
    initialDiagnostics: diagnostics,
    previousCursor: undefined,
  };
}

export type CanonicalTranscriptDiagnosticCode =
  | "scope_mismatch"
  | "invalid_sequence"
  | "duplicate_sequence"
  | "missing_anchor"
  | "cross_thread_anchor"
  | "missing_lineage"
  | "stale_revision"
  | "stale_event"
  | "late_event"
  | "source_conflict"
  | "owner_conflict"
  | "attempt_order_unknown"
  | "missing_context_source"
  | "nested_depth_exceeded";

export interface CanonicalTranscriptDiagnostic {
  readonly code: CanonicalTranscriptDiagnosticCode;
  readonly sourceRefs: readonly CanonicalProjectionSourceRef[];
  readonly message: string;
}

export interface CanonicalTerminalEvidenceRef {
  readonly actionId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly participantId: string;
  readonly status: "succeeded" | "failed" | "cancelled" | "blocked";
}

export interface CanonicalTranscriptProjection {
  readonly sourceSequence: number;
  readonly sourceRevision: string;
  readonly items: readonly ConversationTimelineItem[];
  /** Valid superseded-attempt items for explicit audit/detail surfaces only. */
  readonly auditItems: readonly ConversationTimelineItem[];
  readonly terminalEvidence: readonly CanonicalTerminalEvidenceRef[];
  readonly diagnostics: readonly CanonicalTranscriptDiagnostic[];
  readonly activeItemId?: string;
  /** Passed through for the display-only batching adapter. */
  readonly contextSegmentIdByItemId?: ReadonlyMap<string, string>;
}

interface AnchoredAction {
  readonly action: CanonicalExecutionAction;
  readonly anchor: CanonicalConversationItem;
  readonly partIndex: number;
}

interface AnchoredActionProjection {
  readonly actions: readonly AnchoredAction[];
  readonly auditActions: readonly AnchoredAction[];
}

interface AttemptSelection {
  readonly primary: readonly AnchoredAction[];
  readonly audit: readonly AnchoredAction[];
}

/**
 * Project canonical Continuity records into the one shared typed timeline.
 * This function is pure: it does not read SQLite, sort by timestamps, or
 * infer facts from assistant text. Invalid records are surfaced as diagnostics
 * or blocked generic rows instead of being silently placed in the transcript.
 */
export function projectCanonicalConversationTimeline(
  input: CanonicalTranscriptProjectionInput,
): CanonicalTranscriptProjection {
  const diagnostics: CanonicalTranscriptDiagnostic[] = [...(input.initialDiagnostics ?? [])];
  if (!validScope(input.scope) || !Number.isSafeInteger(input.sourceSequence) || input.sourceSequence < 0) {
    diagnostics.push({ code: "scope_mismatch", sourceRefs: [], message: "Transcript scope or source sequence is invalid." });
    return emptyProjection(input, diagnostics);
  }
  if (input.previousCursor && input.sourceSequence < input.previousCursor.sourceSequence) {
    diagnostics.push({ code: "stale_revision", sourceRefs: [], message: "Canonical source sequence moved backwards." });
    return emptyProjection(input, diagnostics);
  }
  const itemsById = new Map<string, CanonicalConversationItem>();
  const conflictingSequences = new Set<number>();
  for (const item of input.items) {
    if (!isCanonicalItem(item) || item.workspaceId !== input.scope.workspaceId || item.threadId !== input.scope.threadId) {
      diagnostics.push({ code: "scope_mismatch", sourceRefs: [], message: "Conversation item is outside the requested scope." });
      continue;
    }
    if (!Number.isSafeInteger(item.sequence) || item.sequence < 1 || !Number.isSafeInteger(item.revision) || item.revision < 0) {
      diagnostics.push({ code: "invalid_sequence", sourceRefs: [], message: `Conversation item ${item.id} has an invalid sequence or revision.` });
      continue;
    }
    const previous = itemsById.get(item.id);
    if (previous) {
      if (item.revision > previous.revision) itemsById.set(item.id, item);
      else if (item.revision === previous.revision && item.sequence !== previous.sequence) {
        conflictingSequences.add(item.sequence);
        conflictingSequences.add(previous.sequence);
        diagnostics.push({ code: "owner_conflict", sourceRefs: [conversationItemRef(item.id)], message: `Conversation item ${item.id} has conflicting positions.` });
      } else if (item.revision === previous.revision && stableSerialize(item) !== stableSerialize(previous)) {
        diagnostics.push({ code: "owner_conflict", sourceRefs: [conversationItemRef(item.id)], message: `Conversation item ${item.id} has conflicting equal revisions.` });
        itemsById.delete(item.id);
      } else if (item.revision < previous.revision) {
        diagnostics.push({ code: "stale_revision", sourceRefs: [conversationItemRef(item.id)], message: `Conversation item ${item.id} has a stale revision.` });
      }
      continue;
    }
    const peer = [...itemsById.values()].find((candidate) => candidate.sequence === item.sequence);
    if (peer) {
      conflictingSequences.add(item.sequence);
      diagnostics.push({ code: "duplicate_sequence", sourceRefs: [conversationItemRef(peer.id), conversationItemRef(item.id)], message: `Conversation sequence ${item.sequence} is claimed by multiple items.` });
    }
    itemsById.set(item.id, item);
  }

  const orderedItems = [...itemsById.values()]
    .filter((item) => !conflictingSequences.has(item.sequence))
    .sort((left, right) => left.sequence - right.sequence);
  if (input.sourceSequence < (orderedItems.at(-1)?.sequence ?? 0)) {
    diagnostics.push({ code: "stale_revision", sourceRefs: [], message: "Canonical source sequence is behind the highest item sequence." });
    return emptyProjection(input, diagnostics);
  }
  const actionsById = latestActions(input.actions, diagnostics);
  const anchoredProjection = anchorActions([...actionsById.values()], itemsById, input, diagnostics);
  const anchoredActions = anchoredProjection.actions;
  const actionsByItem = groupAnchoredActions(anchoredActions);
  const actionToolCallIds = new Set(anchoredActions.map(({ action }) => action.toolCallId).filter((value): value is string => Boolean(value)));
  const matchedActionIds = new Set(anchoredActions.map(({ action }) => action.id));
  const projected: ConversationTimelineItem[] = [];
  const supplemental = projectSupplementalEvidence(input, itemsById, actionsByItem, anchoredActions, diagnostics);
  let activeItemId: string | undefined;

  for (const item of orderedItems) {
    const anchored = actionsByItem.get(item.id) ?? [];
    const toolCallId = readStringField(item.payload, "toolCallId");
    const suppressToolEnvelope = (item.kind === "tool_result" || item.kind === "tool_call") &&
      Boolean((toolCallId && actionToolCallIds.has(toolCallId)) || anchored.length > 0);
    if (!suppressToolEnvelope) {
      const message = projectCanonicalMessage(item, input.scope);
      if (message) projected.push(message);
      else if (isFactEnvelope(item)) projected.push(blockedCanonicalItem(item, input.scope, "No verified execution evidence is attached."));
    }
    for (const anchoredAction of anchored) {
      const timelineItem = projectCanonicalAction(anchoredAction, input.scope, diagnostics);
      projected.push(timelineItem);
      if (timelineItem.status === "running" || timelineItem.status === "waiting") activeItemId = timelineItem.id;
    }
    for (const supplementalItem of supplemental.get(item.id) ?? []) {
      projected.push(supplementalItem);
      if (supplementalItem.status === "running" || supplementalItem.status === "waiting") activeItemId = supplementalItem.id;
    }
  }

  // Actions that were validly anchored but filtered by a selected attempt still
  // remain auditable; only the selected attempt is allowed in the main feed.
  for (const action of input.actions) {
    if (!matchedActionIds.has(action.id) && action.threadId === input.scope.threadId && actionInScope(action, input.scope) && action.sourceRefs.some((ref) => ref.kind === "conversation_item")) {
      diagnostics.push({ code: "stale_revision", sourceRefs: sourceRefsForAction(action), message: `Action ${action.id} is not part of the selected canonical attempt.` });
    }
  }

  const auditItems = anchoredProjection.auditActions
    .map((entry) => projectCanonicalAction(entry, input.scope, diagnostics))
    .sort(compareTimelineItems);
  return {
    sourceSequence: input.sourceSequence,
    sourceRevision: input.sourceRevision,
    // The canonical projector deliberately returns atomic items only. Display
    // batching is a separate, reversible projection owned by the shared adapter;
    // completion, fan-in, and TerminalReport consumers must never see a batch.
    items: projected.sort(compareTimelineItems),
    auditItems,
    terminalEvidence: projected.flatMap(terminalEvidenceForTimelineItem),
    diagnostics,
    ...(input.contextSegmentIdByItemId ? { contextSegmentIdByItemId: input.contextSegmentIdByItemId } : {}),
    ...(activeItemId ? { activeItemId } : {}),
  };
}

function actionInScope(action: CanonicalExecutionAction, scope: CanonicalTranscriptScope): boolean {
  return (!scope.runId || action.runId === scope.runId)
    && (!scope.participantId || !action.participantId || action.participantId === scope.participantId);
}

/**
 * Projects non-action evidence that still belongs on the canonical item spine.
 * These records are deliberately supplemental: an action owns its own command,
 * file, and tool row, while an approval, artifact preview, plan, compaction
 * marker, or participant span can have an independent durable owner.
 */
function projectSupplementalEvidence(
  input: CanonicalTranscriptProjectionInput,
  itemsById: ReadonlyMap<string, CanonicalConversationItem>,
  actionsByItem: ReadonlyMap<string, readonly AnchoredAction[]>,
  anchoredActions: readonly AnchoredAction[],
  diagnostics: CanonicalTranscriptDiagnostic[],
): Map<string, ConversationTimelineItem[]> {
  const output = new Map<string, ConversationTimelineItem[]>();
  const actionAnchorById = new Map(anchoredActions.map((entry) => [entry.action.id, entry.anchor]));
  const nextPart = new Map<string, number>();
  for (const entry of anchoredActions) {
    nextPart.set(entry.anchor.id, Math.max(nextPart.get(entry.anchor.id) ?? 0, entry.partIndex + 1));
  }
  const append = (anchor: CanonicalConversationItem, item: ConversationTimelineItem): void => {
    const partIndex = nextPart.get(anchor.id) ?? 1;
    nextPart.set(anchor.id, partIndex + 1);
    output.set(anchor.id, [...(output.get(anchor.id) ?? []), { ...item, threadSequence: anchor.sequence, partIndex }]);
  };
  const resolveAnchor = (
    record: { readonly anchorItemId?: string; readonly actionId?: string; readonly sourceRefs: readonly CanonicalSourceRef[] },
  ): CanonicalConversationItem | undefined => {
    const explicit = record.anchorItemId ? itemsById.get(record.anchorItemId) : undefined;
    if (explicit) return explicit;
    const source = record.sourceRefs.find((ref) => ref.kind === "conversation_item");
    if (source) return itemsById.get(source.id);
    if (record.actionId) return actionAnchorById.get(record.actionId);
    return undefined;
  };
  const inScope = (workspaceId: string, threadId?: string, runId?: string, participantId?: string): boolean =>
    workspaceId === input.scope.workspaceId && (!threadId || threadId === input.scope.threadId) &&
    (!input.scope.runId || runId === input.scope.runId) &&
    (!input.scope.participantId || !participantId || participantId === input.scope.participantId);

  const latestApprovals = latestSupplementalById(input.approvals ?? [], diagnostics, "approval");
  for (const approval of sortSupplementalRecords(latestApprovals.values())) {
    if (!inScope(approval.workspaceId, approval.threadId, approval.runId, approval.participantId)) {
      diagnostics.push({ code: "scope_mismatch", sourceRefs: toSourceRefs(approval.sourceRefs), message: `Approval ${approval.id} belongs to another scope.` });
      continue;
    }
    const anchor = resolveAnchor(approval);
    if (!anchor) {
      diagnostics.push({ code: "missing_anchor", sourceRefs: toSourceRefs(approval.sourceRefs), message: `Approval ${approval.id} has no conversation-item anchor.` });
      continue;
    }
    const ownedByAction = [...(actionsByItem.get(anchor.id) ?? [])].some(({ action }) =>
      action.id === approval.actionId || action.approvalId === approval.id ||
      Boolean(approval.toolCallId && action.toolCallId === approval.toolCallId),
    );
    if (ownedByAction) continue;
    const status = approvalStatus(approval.status);
    const approvalRefs = ensureAnchorRef(approval.sourceRefs, anchor.id);
    if (!approval.runId || !approval.attemptId || !approval.participantId || approvalRefs.length === 0) {
      diagnostics.push({ code: "missing_lineage", sourceRefs: toSourceRefs(approvalRefs), message: `Approval ${approval.id} is missing required run, attempt, participant, or source lineage.` });
      append(anchor, {
        id: `approval:${approval.id}`,
        kind: "diagnostic",
        revision: approval.revision,
        threadSequence: anchor.sequence,
        partIndex: 0,
        status: "blocked",
        turnId: anchor.turnId ?? input.scope.turnId,
        itemId: anchor.id,
        sourceRefs: toSourceRefs(approvalRefs),
        title: "Activity unavailable",
        description: "Approval evidence is missing required execution lineage.",
        summary: "Approval evidence is missing required execution lineage.",
      } satisfies ConversationTimelineDiagnosticItem);
      continue;
    }
    append(anchor, {
      id: `approval:${approval.id}`,
      kind: "approval",
      revision: approval.revision,
      threadSequence: anchor.sequence,
      partIndex: 0,
      status,
      turnId: anchor.turnId ?? input.scope.turnId,
      ...(approval.actionId ? { actionId: approval.actionId } : {}),
      runId: approval.runId,
      attemptId: approval.attemptId,
      participantId: approval.participantId,
      sourceRefs: toSourceRefs(approvalRefs),
      title: approval.title,
      description: approval.summary,
      meta: approval.summary,
      approvalId: approval.id,
      decision: approvalDecision(status),
    } satisfies ConversationTimelineApprovalItem);
  }

  const latestPlans = latestSupplementalById(input.plans ?? [], diagnostics, "plan");
  for (const plan of sortSupplementalRecords(latestPlans.values())) {
    if (!inScope(plan.workspaceId, plan.threadId)) continue;
    const anchor = itemsById.get(plan.anchorItemId);
    if (!anchor) {
      diagnostics.push({ code: "missing_anchor", sourceRefs: toSourceRefs(plan.sourceRefs), message: `Plan ${plan.id} has no conversation-item anchor.` });
      continue;
    }
    append(anchor, {
      id: `plan:${plan.id}`,
      kind: "plan",
      revision: plan.revision,
      threadSequence: anchor.sequence,
      partIndex: 0,
      status: plan.steps.some((step) => step.status === "blocked") ? "blocked" : plan.steps.some((step) => step.status === "running") ? "running" : plan.steps.every((step) => step.status === "completed") ? "succeeded" : "pending",
      turnId: plan.turnId ?? anchor.turnId ?? input.scope.turnId,
      itemId: anchor.id,
      sourceRefs: toSourceRefs(plan.sourceRefs),
      title: plan.title ?? "Plan",
      steps: plan.steps,
    } satisfies ConversationTimelinePlanItem);
  }

  const latestCompactions = latestSupplementalById(input.compactions ?? [], diagnostics, "compaction");
  for (const compaction of sortSupplementalRecords(latestCompactions.values())) {
    if (!inScope(compaction.workspaceId, compaction.threadId)) continue;
    const anchor = itemsById.get(compaction.anchorItemId);
    if (!anchor) {
      diagnostics.push({ code: "missing_anchor", sourceRefs: toSourceRefs(compaction.sourceRefs), message: `Compaction ${compaction.id} has no conversation-item anchor.` });
      continue;
    }
    append(anchor, {
      id: `context-compaction:${compaction.id}`,
      kind: "contextCompaction",
      revision: compaction.revision,
      threadSequence: anchor.sequence,
      partIndex: 0,
      status: "succeeded",
      turnId: compaction.turnId ?? anchor.turnId ?? input.scope.turnId,
      itemId: anchor.id,
      sourceRefs: toSourceRefs(compaction.sourceRefs),
      title: "Context compacted",
      summary: compaction.summary,
      description: compaction.summary,
      compactedTurnCount: compaction.compactedTurnCount,
      snapshotRef: compaction.snapshotRef ? toSourceRefs([compaction.snapshotRef])[0] : undefined,
    } satisfies ConversationTimelineContextCompactionItem);
  }

  const latestSpans = latestSupplementalById(input.participantSpans ?? [], diagnostics, "participant");
  for (const span of sortSupplementalRecords(latestSpans.values())) {
    if (!inScope(span.workspaceId, span.threadId, span.runId, span.participantId)) continue;
    const anchor = itemsById.get(span.anchorItemId);
    if (!anchor) {
      diagnostics.push({ code: "missing_anchor", sourceRefs: toSourceRefs(span.sourceRefs), message: `Participant ${span.participantId} has no parent anchor.` });
      continue;
    }
    const childItems = span.childItems.length > 0
      ? sanitizeVisibleChildTimelineItems(span.childItems)
      : [missingChildEvidenceDiagnostic({
        anchor,
        span,
        turnId: anchor.turnId ?? input.scope.turnId,
      })];
    append(anchor, {
      id: `sub-agent:${span.id}`,
      kind: "subAgentActivity",
      revision: span.revision,
      threadSequence: anchor.sequence,
      partIndex: 0,
      status: participantStatus(span.lifecycle),
      turnId: anchor.turnId ?? input.scope.turnId,
      itemId: anchor.id,
      actionId: span.parentActionId,
      runId: span.runId,
      attemptId: span.attemptId,
      participantId: span.participantId,
      workflowStepId: span.workflowStepId ?? null,
      sourceRefs: toSourceRefs(span.sourceRefs),
      label: span.label,
      lifecycle: span.lifecycle,
      childItems,
    } satisfies ConversationTimelineSubAgentItem);
  }

  const latestArtifacts = latestSupplementalById(input.artifacts ?? [], diagnostics, "artifact");
  for (const artifact of sortSupplementalRecords(latestArtifacts.values())) {
    if (!inScope(artifact.workspaceId, artifact.threadId, artifact.runId)) continue;
    const anchor = resolveAnchor(artifact);
    if (!anchor) {
      diagnostics.push({ code: "missing_anchor", sourceRefs: toSourceRefs(artifact.sourceRefs), message: `Artifact ${artifact.id} has no conversation-item anchor.` });
      continue;
    }
    const linkedAction = artifact.actionId ? anchoredActions.find(({ action }) => action.id === artifact.actionId)?.action :
      anchoredActions.find(({ action }) => action.resultArtifactIds?.includes(artifact.id) || action.previewArtifactIds?.includes(artifact.id))?.action;
    const refs = toSourceRefs([{ kind: "artifact", id: artifact.id, label: artifact.title, path: artifact.path, hostTarget: artifact.type === "diff" ? "open_diff" : "open_artifact" }, ...artifact.sourceRefs]);
    if (artifact.type === "image") {
      const imageRefs = toSourceRefs(refs);
      const imageLineage = linkedAction
        ? operationLineage(linkedAction, imageRefs, anchor, input.scope)
        : undefined;
      if (!imageLineage || !imageRefs.some((ref) => ref.kind === "artifact") || !imageRefs.some((ref) => ref.kind === "run_event")) {
        diagnostics.push({ code: "missing_lineage", sourceRefs: imageRefs, message: `Image artifact ${artifact.id} has no trusted action/run-event lineage.` });
        append(anchor, {
          id: `image:${artifact.id}:blocked`,
          kind: "diagnostic",
          revision: artifact.revision,
          threadSequence: anchor.sequence,
          partIndex: 0,
          status: "blocked",
          turnId: anchor.turnId ?? input.scope.turnId,
          itemId: anchor.id,
          sourceRefs: imageRefs,
          title: "Image unavailable",
          description: "Image evidence is missing a trusted execution lineage.",
          summary: "Image evidence is missing a trusted execution lineage.",
          diagnosticRef: imageRefs.find((ref) => ref.kind === "artifact"),
        } satisfies ConversationTimelineDiagnosticItem);
        continue;
      }
      append(anchor, {
        kind: "imageView",
        ...imageLineage,
        id: `image:${artifact.id}`,
        revision: artifact.revision,
        threadSequence: anchor.sequence,
        partIndex: 0,
        status: "succeeded",
        turnId: anchor.turnId ?? input.scope.turnId,
        itemId: anchor.id,
        sourceRefs: imageRefs,
        title: artifact.title ?? basename(artifact.path),
        description: artifact.title ?? artifact.path,
        artifactRef: refs[0],
        alt: artifact.title ?? basename(artifact.path),
        width: artifact.width,
        height: artifact.height,
      } satisfies ConversationTimelineImageViewItem);
      continue;
    }
    if (!linkedAction) {
      diagnostics.push({ code: "missing_lineage", sourceRefs: refs, message: `Artifact ${artifact.id} is anchored but has no owning action.` });
      append(anchor, {
        id: `artifact:${artifact.id}`,
        kind: "diagnostic",
        revision: artifact.revision,
        threadSequence: anchor.sequence,
        partIndex: 0,
        status: "blocked",
        turnId: anchor.turnId ?? input.scope.turnId,
        itemId: anchor.id,
        sourceRefs: refs,
        title: "Activity unavailable",
        description: "Artifact ownership is missing required execution lineage.",
        summary: "Artifact ownership is missing required execution lineage.",
        diagnosticRef: refs[0],
      } satisfies ConversationTimelineDiagnosticItem);
    }
  }
  return output;
}

function missingChildEvidenceDiagnostic(input: {
  readonly anchor: CanonicalConversationItem;
  readonly span: CanonicalParticipantSpan;
  readonly turnId?: string;
}): ConversationTimelineDiagnosticItem {
  const sourceRefs = toSourceRefs(input.span.sourceRefs);
  return {
    id: `sub-agent:${input.span.id}:blocked`,
    kind: "diagnostic",
    code: "missing_lineage",
    revision: input.span.revision,
    threadSequence: input.anchor.sequence,
    partIndex: 1,
    status: "blocked",
    turnId: input.turnId,
    itemId: input.anchor.id,
    ...(input.span.parentActionId ? { actionId: input.span.parentActionId } : {}),
    ...(input.span.runId ? { runId: input.span.runId } : {}),
    ...(input.span.attemptId ? { attemptId: input.span.attemptId } : {}),
    participantId: input.span.participantId,
    ...(input.span.workflowStepId ? { workflowStepId: input.span.workflowStepId } : {}),
    sourceRefs,
    title: "Activity unavailable",
    description: "No typed child evidence was recorded for this Agent.",
    summary: "No typed child evidence was recorded for this Agent.",
  };
}

/**
 * Participant spans are rendered at depth one.  A nested participant container
 * is retained as a blocked diagnostic with the original lineage rather than
 * being recursively mounted as a third visual timeline.
 */
function sanitizeVisibleChildTimelineItems(
  items: readonly ConversationTimelineItem[],
): readonly ConversationTimelineItem[] {
  return items.map((item) => {
    if (item.kind === "subAgentActivity") return nestedDepthExceededDiagnostic(item);
    if (item.kind === "commandBatch") {
      const commands = item.batch.commands.map((command) => {
        if (!command.leadingItems || command.leadingItems.length === 0) return command;
        return { ...command, leadingItems: sanitizeVisibleChildTimelineItems(command.leadingItems) };
      });
      if (commands.every((command, index) => command === item.batch.commands[index])) return item;
      return { ...item, batch: { ...item.batch, commands } };
    }
    return item;
  });
}

function nestedDepthExceededDiagnostic(
  item: ConversationTimelineSubAgentItem,
): ConversationTimelineDiagnosticItem {
  return {
    id: `diagnostic:nested-depth:${item.id}`,
    kind: "diagnostic",
    code: "nested_depth_exceeded",
    revision: item.revision,
    threadSequence: item.threadSequence,
    partIndex: item.partIndex,
    status: "blocked",
    turnId: item.turnId,
    itemId: item.itemId,
    ...(item.actionId ? { actionId: item.actionId } : {}),
    ...(item.runId ? { runId: item.runId } : {}),
    ...(item.attemptId ? { attemptId: item.attemptId } : {}),
    participantId: item.participantId,
    workflowStepId: item.workflowStepId,
    sourceRefs: item.sourceRefs,
    title: "Nested Agent activity unavailable",
    description: "Nested Agent activity is hidden beyond the visible depth limit.",
    summary: "Nested Agent activity is hidden beyond the visible depth limit.",
    diagnosticRef: item.sourceRefs[0],
  };
}

function latestSupplementalById<T extends { readonly id: string; readonly revision: number; readonly sourceRefs: readonly CanonicalSourceRef[] }>(
  records: readonly T[],
  diagnostics: CanonicalTranscriptDiagnostic[],
  label: string,
): Map<string, T> {
  const latest = new Map<string, T>();
  for (const record of records) {
    if (!record || typeof record.id !== "string" || !Number.isSafeInteger(record.revision) || record.revision < 0) {
      diagnostics.push({ code: "missing_lineage", sourceRefs: [], message: `Malformed ${label} record.` });
      continue;
    }
    const previous = latest.get(record.id);
    if (!previous || record.revision > previous.revision) {
      latest.set(record.id, record);
    } else if (record.revision === previous.revision && stableSerialize(record) !== stableSerialize(previous)) {
      diagnostics.push({ code: "owner_conflict", sourceRefs: toSourceRefs(record.sourceRefs), message: `${label} ${record.id} has conflicting equal revisions.` });
      latest.delete(record.id);
    } else if (record.revision < previous.revision) {
      diagnostics.push({ code: "stale_revision", sourceRefs: toSourceRefs(record.sourceRefs), message: `${label} ${record.id} has a stale revision.` });
    }
  }
  return latest;
}

/**
 * Map insertion order is transport order, not canonical order.  Supplemental
 * records can share one conversation-item anchor, so their insertion order would
 * otherwise change partIndex, DOM order, and the reconstructed snapshot after an
 * SSE reconnect.  Sort only by stable durable identity here; the owning item
 * sequence is applied by `append` below.
 */
function sortSupplementalRecords<T extends { readonly id: string }>(records: Iterable<T>): T[] {
  return [...records].sort((left, right) => left.id.localeCompare(right.id));
}

function approvalStatus(status: CanonicalApprovalRecord["status"]): ConversationTimelineItemStatus {
  if (status === "pending") return "waiting";
  if (status === "approved") return "succeeded";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

function participantStatus(lifecycle: CanonicalParticipantSpan["lifecycle"]): ConversationTimelineItemStatus {
  if (lifecycle === "completed") return "succeeded";
  if (lifecycle === "blocked") return "blocked";
  if (lifecycle === "errored") return "failed";
  if (lifecycle === "waiting") return "waiting";
  if (lifecycle === "interrupted") return "cancelled";
  return lifecycle === "started" ? "pending" : "running";
}

function mergeVersionedRecords<T extends { readonly revision: number }>(
  current: readonly T[],
  incoming: readonly T[],
  keyOf: (record: T) => string,
): readonly T[] {
  const groups = new Map<string, T[]>();
  for (const record of [...current, ...incoming]) {
    const key = keyOf(record);
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  const merged: T[] = [];
  for (const group of groups.values()) {
    const maxRevision = Math.max(...group.map((record) => record.revision));
    const latest = group.filter((record) => record.revision === maxRevision);
    const unique = new Map(latest.map((record) => [stableSerialize(record), record]));
    merged.push(...unique.values());
  }
  return merged.sort((left, right) => keyOf(left).localeCompare(keyOf(right)) || left.revision - right.revision);
}

function mergeUniqueRecords<T>(
  current: readonly T[],
  incoming: readonly T[],
  keyOf: (record: T) => string,
): readonly T[] {
  const byKey = new Map<string, T>();
  for (const record of [...current, ...incoming]) {
    const key = keyOf(record);
    if (!byKey.has(key)) byKey.set(key, record);
  }
  return [...byKey.values()].sort((left, right) => keyOf(left).localeCompare(keyOf(right)));
}

function mergeContextSegmentLookups(
  current: ReadonlyMap<string, string> | undefined,
  incoming: ReadonlyMap<string, string> | undefined,
): ReadonlyMap<string, string> | undefined {
  if (!current && !incoming) return undefined;
  const merged = new Map<string, string>();
  for (const [itemId, segmentId] of current ?? []) merged.set(itemId, segmentId);
  for (const [itemId, segmentId] of incoming ?? []) {
    const previous = merged.get(itemId);
    // A conflicting segment assignment is unsafe for batching. Remove it so
    // the display adapter treats the item as an unknown boundary.
    if (previous && previous !== segmentId) merged.delete(itemId);
    else if (!previous) merged.set(itemId, segmentId);
  }
  return merged;
}

function sameScope(left: CanonicalTranscriptScope, right: CanonicalTranscriptScope): boolean {
  return stableSerialize(left) === stableSerialize(right);
}

function selectSourceRevision(
  current: CanonicalTranscriptProjectionInput,
  incoming: CanonicalTranscriptProjectionInput,
): string {
  const currentRank = inputRevisionRank(current);
  const incomingRank = inputRevisionRank(incoming);
  if (incomingRank !== currentRank) return incomingRank > currentRank ? incoming.sourceRevision : current.sourceRevision;
  if (incoming.sourceSequence !== current.sourceSequence) {
    return incoming.sourceSequence > current.sourceSequence ? incoming.sourceRevision : current.sourceRevision;
  }
  // Aggregate revisions can legitimately change while sourceSequence stays the
  // same (for example, a tool_update).  This tie-break is only for deterministic
  // replay; numeric item/action revisions remain the stale-update authority.
  return incoming.sourceRevision.localeCompare(current.sourceRevision) >= 0
    ? incoming.sourceRevision
    : current.sourceRevision;
}

function inputRevisionRank(input: CanonicalTranscriptProjectionInput): number {
  return Math.max(
    0,
    ...input.items.map((record) => record.revision),
    ...input.actions.map((record) => record.revision),
    ...(input.approvals ?? []).map((record) => record.revision),
    ...(input.artifacts ?? []).map((record) => record.revision),
    ...(input.plans ?? []).map((record) => record.revision),
    ...(input.compactions ?? []).map((record) => record.revision),
    ...(input.participantSpans ?? []).map((record) => record.revision),
  );
}

/** Stable structural encoding used for equality, never for ordering. */
function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`);
  return `{${entries.join(",")}}`;
}

function emptyProjection(input: CanonicalTranscriptProjectionInput, diagnostics: readonly CanonicalTranscriptDiagnostic[]): CanonicalTranscriptProjection {
  return { sourceSequence: input.sourceSequence, sourceRevision: input.sourceRevision, items: [], auditItems: [], terminalEvidence: [], diagnostics };
}

function latestActions(
  actions: readonly CanonicalExecutionAction[],
  diagnostics: CanonicalTranscriptDiagnostic[],
): Map<string, CanonicalExecutionAction> {
  const latest = new Map<string, CanonicalExecutionAction>();
  const conflicts = new Set<string>();
  for (const action of actions) {
    if (!isCanonicalAction(action) || !Number.isSafeInteger(action.revision) || action.revision < 0) {
      diagnostics.push({ code: "missing_lineage", sourceRefs: [], message: "Execution action is malformed." });
      continue;
    }
    for (const diagnostic of action.diagnostics ?? []) {
      diagnostics.push({
        code: diagnostic.code,
        sourceRefs: diagnostic.sourceRefs,
        message: diagnostic.message,
      });
    }
    const previous = latest.get(action.id);
    if (!previous || action.revision > previous.revision) {
      latest.set(action.id, action);
      continue;
    }
    if (action.revision === previous.revision && stableSerialize(action) !== stableSerialize(previous)) {
      diagnostics.push({ code: "owner_conflict", sourceRefs: sourceRefsForAction(action), message: `Action ${action.id} has conflicting equal revisions.` });
      conflicts.add(action.id);
    } else if (action.revision < previous.revision) {
      diagnostics.push({ code: "stale_revision", sourceRefs: sourceRefsForAction(action), message: `Action ${action.id} has a stale revision.` });
    }
  }
  for (const id of conflicts) latest.delete(id);
  return latest;
}

function anchorActions(
  actions: readonly CanonicalExecutionAction[],
  itemsById: ReadonlyMap<string, CanonicalConversationItem>,
  input: CanonicalTranscriptProjectionInput,
  diagnostics: CanonicalTranscriptDiagnostic[],
): AnchoredActionProjection {
  const candidates: AnchoredAction[] = [];
  for (const action of actions) {
    const anchorRefs = action.sourceRefs.filter((ref) => ref.kind === "conversation_item");
    if (anchorRefs.length === 0) {
      diagnostics.push({ code: "missing_anchor", sourceRefs: sourceRefsForAction(action), message: `Action ${action.id} has no conversation-item anchor.` });
      continue;
    }
    if (anchorRefs.length > 1) {
      diagnostics.push({ code: "owner_conflict", sourceRefs: sourceRefsForAction(action), message: `Action ${action.id} points to multiple conversation-item anchors.` });
      continue;
    }
    const anchor = itemsById.get(anchorRefs[0]!.id);
    if (!anchor) {
      diagnostics.push({ code: "cross_thread_anchor", sourceRefs: sourceRefsForAction(action), message: `Action ${action.id} points to a missing or cross-thread anchor.` });
      continue;
    }
    if (action.threadId && action.threadId !== input.scope.threadId) {
      diagnostics.push({ code: "scope_mismatch", sourceRefs: sourceRefsForAction(action), message: `Action ${action.id} belongs to another thread.` });
      continue;
    }
    if (input.scope.runId && action.runId !== input.scope.runId) {
      diagnostics.push({ code: "scope_mismatch", sourceRefs: sourceRefsForAction(action), message: `Action ${action.id} belongs to another run.` });
      continue;
    }
    if (input.scope.participantId && action.participantId && action.participantId !== input.scope.participantId) {
      diagnostics.push({ code: "scope_mismatch", sourceRefs: sourceRefsForAction(action), message: `Action ${action.id} belongs to another participant.` });
      continue;
    }
    candidates.push({ action, anchor, partIndex: 1 });
  }
  const selection = selectLatestAttempt(candidates, input, diagnostics);
  const grouped = new Map<string, AnchoredAction[]>();
  for (const candidate of selection.primary) {
    const list = grouped.get(candidate.anchor.id) ?? [];
    list.push(candidate);
    grouped.set(candidate.anchor.id, list);
  }
  const anchored: AnchoredAction[] = [];
  for (const [itemId, actionsAtAnchor] of grouped) {
    const anchor = itemsById.get(itemId);
    if (!anchor) continue;
    // Revisions are scoped to an action, not to the canonical item. Distinct
    // actions may therefore legitimately start at the same revision; their
    // stable ids provide the deterministic tie-breaker for part placement.
    const ordered = [...actionsAtAnchor].sort((left, right) => left.action.revision - right.action.revision || left.action.id.localeCompare(right.action.id));
    for (let index = 0; index < ordered.length; index += 1) {
      const candidate = ordered[index]!;
      anchored.push({ ...candidate, anchor, partIndex: index + 1 });
    }
  }
  return {
    actions: anchored,
    auditActions: selection.audit,
  };
}

function selectLatestAttempt(
  actions: readonly AnchoredAction[],
  input: CanonicalTranscriptProjectionInput,
  diagnostics: CanonicalTranscriptDiagnostic[],
): AttemptSelection {
  const scoped = input.scope.attemptId
    ? actions.filter(({ action }) => action.attemptId === input.scope.attemptId)
    : [...actions];
  if (input.scope.attemptId) return { primary: scoped, audit: [] };
  const groups = new Map<string, AnchoredAction[]>();
  for (const entry of scoped) {
    const key = entry.action.turnId ?? entry.anchor.turnId ?? input.scope.turnId ?? "thread";
    const list = groups.get(key) ?? [];
    list.push(entry);
    groups.set(key, list);
  }
  const selected: AnchoredAction[] = [];
  const audit: AnchoredAction[] = [];
  const turnRunsByRunId = new Map(input.turnRuns.map((link) => [link.runId, link]));
  for (const entries of groups.values()) {
    const attemptIds = new Set(entries.map(({ action }) => action.attemptId).filter((value): value is string => Boolean(value)));
    const attemptNumbers = entries.map(({ action }) => action.attemptNumber ?? (action.runId ? turnRunsByRunId.get(action.runId)?.attemptNumber : undefined)).filter((value): value is number => Number.isSafeInteger(value));
    if (attemptIds.size > 1 && attemptNumbers.length !== entries.length) {
      diagnostics.push({ code: "attempt_order_unknown", sourceRefs: entries.flatMap(({ action }) => sourceRefsForAction(action)), message: "Multiple attempts are present but their LingTurnRun ordering is unavailable." });
      continue;
    }
    const latestAttempt = attemptNumbers.length > 0 ? Math.max(...attemptNumbers) : undefined;
    for (const entry of entries) {
      const attemptNumber = entry.action.attemptNumber ?? (entry.action.runId ? turnRunsByRunId.get(entry.action.runId)?.attemptNumber : undefined);
      if (latestAttempt === undefined || attemptNumber === latestAttempt) selected.push(entry);
      else audit.push(entry);
    }
  }
  return { primary: selected, audit };
}

function groupAnchoredActions(actions: readonly AnchoredAction[]): Map<string, AnchoredAction[]> {
  const grouped = new Map<string, AnchoredAction[]>();
  for (const action of actions) {
    const list = grouped.get(action.anchor.id) ?? [];
    list.push(action);
    grouped.set(action.anchor.id, list);
  }
  return grouped;
}

function projectCanonicalMessage(item: CanonicalConversationItem, scope: CanonicalTranscriptScope): ConversationTimelineItem | undefined {
  const body = readStringField(item.payload, "body");
  if (!body || (item.kind !== "user_message" && item.kind !== "assistant_message")) return undefined;
  return {
    id: `${item.kind === "user_message" ? "message:user:" : "message:agent:"}${item.id}`,
    kind: item.kind === "user_message" ? "userMessage" : "agentMessage",
    markdown: body,
    phase: item.kind === "assistant_message" && readStringField(item.payload, "deliveryStatus") === "ready" ? "final" : "commentary",
    revision: item.revision,
    threadSequence: item.sequence,
    partIndex: 0,
    status: statusFromCanonicalItem(item),
    turnId: item.turnId ?? scope.turnId,
    itemId: item.id,
    sourceRefs: [conversationItemRef(item.id)],
  };
}

function projectCanonicalAction(
  anchored: AnchoredAction,
  scope: CanonicalTranscriptScope,
  diagnostics: CanonicalTranscriptDiagnostic[],
): ConversationTimelineItem {
  const { action, anchor, partIndex } = anchored;
  const sourceRefs = toSourceRefs(action.sourceRefs);
  const lineage = operationLineage(action, sourceRefs, anchor, scope);
  if (!lineage) {
    diagnostics.push({ code: "missing_lineage", sourceRefs, message: `Action ${action.id} is missing required run, attempt, participant, or source lineage.` });
    return {
      id: `action:${action.id}`,
      kind: "diagnostic",
      revision: action.revision,
      threadSequence: anchor.sequence,
      partIndex,
      status: "blocked",
      turnId: action.turnId ?? anchor.turnId ?? scope.turnId,
      actionId: action.id,
      runId: action.runId,
      attemptId: action.attemptId,
      participantId: action.participantId ?? scope.participantId,
      sourceRefs,
      title: "Activity unavailable",
      description: "Execution evidence is missing required lineage.",
      summary: "Execution evidence is missing required lineage.",
    } satisfies ConversationTimelineDiagnosticItem;
  }

  const base = {
    ...lineage,
    id: `action:${action.id}`,
    revision: action.revision,
    threadSequence: anchor.sequence,
    partIndex,
    turnId: action.turnId ?? anchor.turnId ?? scope.turnId,
  };
  const kind = actionKind(action.actionType);
  const status = statusFromAction(action.status);
  if (kind === "commandExecution") {
    const evidence = action.commandEvidence;
    if (!evidence?.command) return blockedAction(base, "Command evidence is missing the exact command.", diagnostics, sourceRefs);
    return {
      ...base,
      kind,
      status,
      title: action.title || evidence.command,
      description: action.summary,
      meta: action.summary,
      command: evidence.command,
      risk: action.risk ?? "low",
      cwd: evidence.cwd,
      outputTail: (evidence.outputTail ?? []).map((chunk) => ({ eventSeq: chunk.eventSeq, stream: chunk.stream, text: chunk.text, redacted: chunk.redacted })),
      outputTruncated: evidence.outputTruncated ?? false,
      exitCode: evidence.exitCode,
      durationMs: evidence.durationMs,
      signal: evidence.signal,
    } satisfies ConversationTimelineCommandExecutionItem;
  }
  if (kind === "fileChange") {
    const files = sourceRefs.filter((ref) => ref.kind === "file" || ref.kind === "path").map((fileRef) => ({ fileRef, displayName: basename(fileRef.path ?? fileRef.label ?? fileRef.id), change: action.actionType.toLowerCase().includes("write") ? "created" as const : "edited" as const }));
    if (files.length === 0) return blockedAction(base, "File evidence has no trusted file reference.", diagnostics, sourceRefs);
    return { ...base, kind, status, title: action.title, description: action.summary, meta: action.summary, files } satisfies ConversationTimelineFileChangeItem;
  }
  if (kind === "exploration") {
    return { ...base, kind, status, title: action.title, description: action.summary, meta: action.summary, operation: explorationOperation(action.actionType), targets: sourceRefs.filter((ref) => ref.kind === "file" || ref.kind === "path"), resultSummary: action.summary } satisfies ConversationTimelineExplorationItem;
  }
  if (kind === "approval") {
    if (!action.approvalId) {
      diagnostics.push({ code: "missing_lineage", sourceRefs, message: `Approval action ${action.id} is missing its durable approval id.` });
      return blockedAction(base, "Approval evidence is missing its durable approval id.", diagnostics, sourceRefs);
    }
    return { ...base, kind, status, title: action.title, description: action.summary, meta: action.summary, approvalId: action.approvalId, decision: approvalDecision(status) } satisfies ConversationTimelineApprovalItem;
  }
  if (kind === "mcpToolCall" || kind === "dynamicToolCall" || kind === "collabAgentToolCall") {
    return { ...base, kind, status, title: action.title, description: action.summary, meta: action.summary, toolName: action.actionType, inputSummary: action.summary } satisfies ConversationTimelineToolCallItem;
  }
  diagnostics.push({ code: "missing_lineage", sourceRefs, message: `Action ${action.id} has an unsupported action type: ${action.actionType}.` });
  const { workflowStepId, ...genericBase } = base;
  return {
    ...genericBase,
    ...(workflowStepId ? { workflowStepId } : {}),
    kind: "diagnostic",
    status: "blocked",
    title: "Activity unavailable",
    description: `Unsupported action type: ${action.actionType}.`,
    summary: action.summary,
  } satisfies ConversationTimelineDiagnosticItem;
}

function blockedAction(
  base: ConversationTimelineOperationPayload,
  reason: string,
  diagnostics: CanonicalTranscriptDiagnostic[],
  sourceRefs: readonly CanonicalProjectionSourceRef[],
): ConversationTimelineDiagnosticItem {
  diagnostics.push({ code: "missing_lineage", sourceRefs, message: reason });
  const { workflowStepId, ...genericBase } = base;
  return { ...genericBase, ...(workflowStepId ? { workflowStepId } : {}), kind: "diagnostic", status: "blocked", title: "Activity unavailable", description: reason, summary: reason };
}

function blockedCanonicalItem(item: CanonicalConversationItem, scope: CanonicalTranscriptScope, reason: string): ConversationTimelineDiagnosticItem {
  return { id: `item:${item.id}`, kind: "diagnostic", revision: item.revision, threadSequence: item.sequence, partIndex: 0, status: "blocked", turnId: item.turnId ?? scope.turnId, itemId: item.id, sourceRefs: [conversationItemRef(item.id)], title: "Activity unavailable", description: reason, summary: reason };
}

function operationLineage(
  action: CanonicalExecutionAction,
  sourceRefs: readonly CanonicalProjectionSourceRef[],
  anchor: CanonicalConversationItem,
  scope: CanonicalTranscriptScope,
): ConversationTimelineOperationPayload | undefined {
  const participantId = action.participantId ?? scope.participantId;
  const runId = action.runId ?? scope.runId;
  if (!action.id || !runId || !action.attemptId || !participantId || sourceRefs.length === 0 || !sourceRefs.some((ref) => ref.kind === "conversation_item" && ref.id === anchor.id)) return undefined;
  return { id: `action:${action.id}`, revision: action.revision, threadSequence: anchor.sequence, partIndex: 0, actionId: action.id, runId, attemptId: action.attemptId, attemptNumber: action.attemptNumber, turnRunRole: action.turnRunRole, participantId, workUnitId: action.workUnitId, workflowStepId: action.workflowStepId ?? null, approvalId: action.approvalId, toolCallId: action.toolCallId, sourceRefs, title: action.title };
}

function actionKind(actionType: string): "commandExecution" | "fileChange" | "exploration" | "approval" | "mcpToolCall" | "dynamicToolCall" | "collabAgentToolCall" | "diagnostic" {
  const type = actionType.trim().toLowerCase();
  if (["bash", "shell", "run_command", "verify"].includes(type) || type.startsWith("git_")) return "commandExecution";
  if (["write", "edit", "file_write", "file_edit"].includes(type)) return "fileChange";
  if (["read", "grep", "find", "ls", "search"].includes(type)) return "exploration";
  if (["approval", "permission", "permission_request"].includes(type)) return "approval";
  if (["mcp", "mcp_tool_call"].includes(type)) return "mcpToolCall";
  if (["dynamic_tool", "dynamic_tool_call"].includes(type)) return "dynamicToolCall";
  if (["spawn_agent", "delegate_agent", "agent_call", "collab_agent_tool_call"].includes(type)) return "collabAgentToolCall";
  return "diagnostic";
}

function statusFromAction(status: string): ConversationTimelineItemStatus {
  switch (status) {
    case "executing": case "running": return "running";
    case "waiting_for_approval": case "waiting": return "waiting";
    case "succeeded": case "approved": return "succeeded";
    case "failed": case "denied": case "expired": return "failed";
    case "cancelled": return "cancelled";
    case "blocked": return "blocked";
    default: return "pending";
  }
}

function statusFromCanonicalItem(item: CanonicalConversationItem): ConversationTimelineItemStatus {
  if (item.status === "failed") return "failed";
  if (readStringField(item.payload, "deliveryStatus") === "blocked") return "blocked";
  if (readBooleanField(item.payload, "streaming") === true) return "running";
  return item.status === "committed" ? "succeeded" : "pending";
}

function approvalDecision(status: ConversationTimelineItemStatus): ConversationTimelineApprovalItem["decision"] {
  if (status === "succeeded") return "allowed";
  if (status === "failed" || status === "blocked") return "denied";
  if (status === "cancelled") return "cancelled";
  return undefined;
}

function explorationOperation(actionType: string): ConversationTimelineExplorationItem["operation"] {
  const type = actionType.toLowerCase();
  return type === "grep" || type === "find" || type === "ls" || type === "search" ? type : "read";
}

function terminalEvidenceForTimelineItem(item: ConversationTimelineItem): CanonicalTerminalEvidenceRef[] {
  // Only an atomic execution action can satisfy TerminalReport/fan-in.  Approval,
  // artifact, participant, plan, and compaction rows may carry an actionId for
  // lineage, but they are supplemental facts rather than proof that the action
  // reached a terminal Host state.
  if (![
    "commandExecution",
    "fileChange",
    "exploration",
    "mcpToolCall",
    "dynamicToolCall",
    "collabAgentToolCall",
    "diagnostic",
  ].includes(item.kind)) return [];
  if (!("actionId" in item) || !("runId" in item) || !("attemptId" in item) || !("participantId" in item)) return [];
  const status = item.status === "succeeded" || item.status === "failed" || item.status === "cancelled" || item.status === "blocked"
    ? item.status
    : undefined;
  // A lineage-complete blocked diagnostic is terminal evidence of a blocked
  // action. It cannot satisfy success, but fan-in must be able to observe it
  // and stop waiting forever. Diagnostics without complete lineage remain
  // trace-only and produce no terminal evidence.
  if (item.kind === "diagnostic" && status !== "blocked") return [];
  return status && item.actionId && item.runId && item.attemptId && item.participantId
    ? [{ actionId: item.actionId, runId: item.runId, attemptId: item.attemptId, participantId: item.participantId, status }]
    : [];
}

function sourceRefsForAction(action: CanonicalExecutionAction): CanonicalProjectionSourceRef[] {
  return toSourceRefs(action.sourceRefs);
}

function toSourceRefs(refs: readonly CanonicalSourceRef[]): CanonicalProjectionSourceRef[] {
  return refs.filter((ref) => typeof ref?.kind === "string" && typeof ref.id === "string" && ref.id.length > 0).map((ref) => ({
    kind: ref.kind,
    id: ref.id,
    ...(ref.label ? { label: ref.label } : {}),
    ...(ref.path ? { path: ref.path } : {}),
    ...(ref.hostTarget ? { hostTarget: ref.hostTarget } : {}),
    ...(ref.capabilityId ? { capabilityId: ref.capabilityId } : {}),
    ...(ref.workspaceId ? { workspaceId: ref.workspaceId } : {}),
    ...(ref.visibility ? { visibility: ref.visibility } : {}),
  }));
}

function ensureAnchorRef(refs: readonly CanonicalSourceRef[], anchorId: string): readonly CanonicalSourceRef[] {
  return refs.some((ref) => ref.kind === "conversation_item" && ref.id === anchorId)
    ? refs
    : [...refs, { kind: "conversation_item", id: anchorId }];
}

function conversationItemRef(id: string): CanonicalProjectionSourceRef {
  return { kind: "conversation_item", id };
}

function isCanonicalItem(value: unknown): value is CanonicalConversationItem {
  return Boolean(value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string" && typeof (value as { threadId?: unknown }).threadId === "string");
}

function isCanonicalAction(value: unknown): value is CanonicalExecutionAction {
  return Boolean(value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string" && typeof (value as { actionType?: unknown }).actionType === "string" && Array.isArray((value as { sourceRefs?: unknown }).sourceRefs));
}

function validScope(scope: CanonicalTranscriptScope): boolean {
  return Boolean(scope && typeof scope.threadId === "string" && scope.threadId.length > 0 && typeof scope.workspaceId === "string" && scope.workspaceId.length > 0 && (scope.depth === 0 || scope.depth === 1));
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function readBooleanField(value: unknown, key: string): boolean | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "boolean" ? candidate : undefined;
}

function isFactEnvelope(item: CanonicalConversationItem): boolean {
  return item.kind !== "user_message" && item.kind !== "assistant_message";
}

function compareTimelineItems(left: ConversationTimelineItem, right: ConversationTimelineItem): number {
  return left.threadSequence - right.threadSequence || left.partIndex - right.partIndex || left.id.localeCompare(right.id);
}

function basename(value: string): string {
  const normalized = value.replace(/\\/gu, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
}
