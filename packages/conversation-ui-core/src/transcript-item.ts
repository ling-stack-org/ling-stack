import type {
  ConversationAgentActivitySpan,
  ConversationOperationSourceRef,
  ConversationWorkCellItem,
  ConversationWorkCellRow,
  ConversationWorkCellRowDetailLine,
  ConversationWorkCellChangePreview,
  ConversationTurnRunRole,
} from "./work-cell-view-model.js";

/**
 * A typed, rebuildable presentation item. This is intentionally separate from the
 * persisted ConversationItem model: it can join execution evidence without becoming a
 * second history authority.
 */
export type ConversationTimelineItemKind =
  | "userMessage"
  | "agentMessage"
  | "reasoning"
  | "plan"
  | "commandExecution"
  | "fileChange"
  | "exploration"
  | "mcpToolCall"
  | "dynamicToolCall"
  | "collabAgentToolCall"
  | "approval"
  | "imageView"
  | "contextCompaction"
  | "subAgentActivity"
  | "diagnostic"
  | "commandBatch"
  | "explorationBatch";

export type ConversationTimelineItemStatus =
  | "pending"
  | "running"
  | "waiting"
  | "blocked"
  | "failed"
  | "cancelled"
  | "succeeded";

export interface ConversationTimelineItemBase {
  readonly id: string;
  readonly kind: ConversationTimelineItemKind;
  readonly revision: number;
  /** Canonical position on the owning LingThread conversation-item spine. */
  readonly threadSequence: number;
  /** Stable sub-position inside one canonical item; zero for atomic items. */
  readonly partIndex: number;
  readonly status?: ConversationTimelineItemStatus;
  readonly turnId?: string;
  readonly itemId?: string;
  readonly actionId?: string;
  readonly approvalId?: string;
  readonly toolCallId?: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly attemptNumber?: number;
  readonly turnRunRole?: ConversationTurnRunRole;
  readonly participantId?: string;
  readonly workUnitId?: string;
  /** Null is an explicit Host assertion that no workflow step exists. */
  readonly workflowStepId?: string | null;
  readonly sourceRefs: readonly ConversationOperationSourceRef[];
}

/**
 * Strict lineage envelope for a fact-producing operation. Message items are
 * allowed to omit these fields because their ConversationItem id is their
 * authority; operation items are not.
 */
export interface ConversationTimelineOperationItemBase
  extends Omit<ConversationTimelineItemBase, "actionId" | "runId" | "attemptId" | "participantId" | "workflowStepId" | "sourceRefs"> {
  readonly actionId: string;
  readonly runId: string;
  /** Every fact-producing operation belongs to exactly one attempt. */
  readonly attemptId: string;
  readonly participantId: string;
  readonly workflowStepId: string | null;
  readonly sourceRefs: readonly ConversationOperationSourceRef[];
}

export interface ConversationTimelineMessageItem extends ConversationTimelineItemBase {
  readonly kind: "userMessage" | "agentMessage";
  readonly markdown: string;
  readonly phase?: "commentary" | "final";
}

/**
 * Renderer-facing activity metadata. The raw WorkCell row is intentionally not
 * part of this contract; it is consumed once by the migration adapter below.
 */
export interface ConversationTimelineActivityPayload extends ConversationTimelineItemBase {
  readonly title: string;
  readonly description?: string;
  readonly meta?: string;
  readonly detailLines?: readonly ConversationWorkCellRowDetailLine[];
}

export interface ConversationTimelineReasoningItem extends ConversationTimelineActivityPayload {
  readonly kind: "reasoning";
  readonly summary: string;
}

export interface ConversationTimelinePlanItem extends ConversationTimelineActivityPayload {
  readonly kind: "plan";
  readonly steps: readonly {
    readonly id: string;
    readonly text: string;
    readonly status: "pending" | "running" | "completed" | "blocked";
  }[];
}

export interface ConversationTimelineOperationPayload extends Omit<ConversationTimelineOperationItemBase, "kind"> {
  readonly title: string;
  readonly description?: string;
  readonly meta?: string;
  readonly detailLines?: readonly ConversationWorkCellRowDetailLine[];
}

export interface ConversationTimelineCommandExecutionItem extends ConversationTimelineOperationPayload {
  readonly kind: "commandExecution";
  readonly command: string;
  readonly risk: "low" | "medium" | "high" | "critical";
  readonly cwd?: string;
  readonly outputTail: readonly {
    readonly eventSeq: number;
    readonly stream: "stdout" | "stderr";
    readonly text: string;
    readonly redacted: boolean;
  }[];
  readonly outputTruncated: boolean;
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly signal?: string;
}

export interface ConversationTimelineFileChangeItem extends ConversationTimelineOperationPayload {
  readonly kind: "fileChange";
  readonly files: readonly {
    readonly fileRef: ConversationOperationSourceRef;
    readonly displayName: string;
    readonly change: "created" | "edited" | "deleted" | "renamed";
    readonly additions?: number;
    readonly deletions?: number;
    readonly diffRef?: ConversationOperationSourceRef;
  }[];
  readonly changePreview?: ConversationWorkCellChangePreview;
}

export interface ConversationTimelineExplorationItem extends ConversationTimelineOperationPayload {
  readonly kind: "exploration";
  readonly operation: "read" | "grep" | "find" | "ls" | "search";
  readonly targets: readonly ConversationOperationSourceRef[];
  readonly resultSummary?: string;
}

export interface ConversationTimelineToolCallItem extends ConversationTimelineOperationPayload {
  readonly kind: "mcpToolCall" | "dynamicToolCall" | "collabAgentToolCall";
  readonly toolName: string;
  readonly providerLabel?: string;
  readonly inputSummary?: string;
  readonly resultSummary?: string;
  readonly detailRef?: ConversationOperationSourceRef;
}

/** Durable system approval. It is not an execution operation and therefore
 * must not invent an action id when the approval is not linked to one. */
export interface ConversationTimelineApprovalItem extends ConversationTimelineActivityPayload {
  readonly kind: "approval";
  readonly approvalId: string;
  readonly actionId?: string;
  readonly decision?: "allowed" | "denied" | "expired" | "cancelled";
}

/** Host-generated image evidence. User-provided images remain ConversationItems. */
export interface ConversationTimelineImageViewItem extends ConversationTimelineOperationPayload {
  readonly kind: "imageView";
  readonly artifactRef?: ConversationOperationSourceRef;
  readonly alt: string;
  readonly width?: number;
  readonly height?: number;
}

export interface ConversationTimelineContextCompactionItem extends ConversationTimelineActivityPayload {
  readonly kind: "contextCompaction";
  readonly summary: string;
  readonly compactedTurnCount?: number;
  readonly snapshotRef?: ConversationOperationSourceRef;
}

export interface ConversationTimelineDiagnosticItem extends ConversationTimelineActivityPayload {
  readonly kind: "diagnostic";
  /** Stable machine-readable reason for a blocked/failed diagnostic row. */
  readonly code?: string;
  readonly summary?: string;
  readonly diagnosticRef?: ConversationOperationSourceRef;
}

export type ConversationTimelineRowItem =
  | ConversationTimelineReasoningItem
  | ConversationTimelinePlanItem
  | ConversationTimelineCommandExecutionItem
  | ConversationTimelineFileChangeItem
  | ConversationTimelineExplorationItem
  | ConversationTimelineToolCallItem
  | ConversationTimelineApprovalItem
  | ConversationTimelineImageViewItem
  | ConversationTimelineContextCompactionItem
  | ConversationTimelineDiagnosticItem;

export interface ConversationTimelineCommandBatchItem extends ConversationTimelineOperationItemBase {
  readonly kind: "commandBatch";
  readonly actionIds: readonly string[];
  /** Stable owner is actionId; these arrays preserve complete atomic membership. */
  readonly childActionIds: readonly string[];
  readonly childItemIds: readonly string[];
  readonly batch: ConversationTimelineCommandBatchPayload;
}

export interface ConversationTimelineCommandBatchPayload {
  readonly id: string;
  readonly revision: number;
  readonly revisionKey: string;
  readonly commandCount: number;
  readonly durationMs?: number;
  readonly defaultExpanded: boolean;
  readonly actionIds: readonly string[];
  readonly childActionIds: readonly string[];
  readonly childItemIds: readonly string[];
  readonly runId: string;
  readonly attemptId: string;
  readonly attemptNumber?: number;
  readonly turnRunRole?: ConversationTurnRunRole;
  readonly participantId: string;
  readonly workUnitId?: string;
  readonly workflowStepId?: string | null;
  readonly sourceRefs: readonly ConversationOperationSourceRef[];
  readonly commands: readonly (ConversationTimelineCommandExecutionItem & {
    readonly leadingItems?: readonly ConversationTimelineItem[];
  })[];
}

export interface ConversationTimelineExplorationBatchItem extends ConversationTimelineOperationItemBase {
  readonly kind: "explorationBatch";
  readonly actionIds: readonly string[];
  readonly childActionIds: readonly string[];
  readonly childItemIds: readonly string[];
  readonly batch: ConversationTimelineExplorationBatchPayload;
}

export interface ConversationTimelineExplorationBatchPayload {
  readonly id: string;
  readonly revision: number;
  readonly revisionKey: string;
  readonly actionIds: readonly string[];
  readonly runId: string;
  readonly attemptId: string;
  readonly attemptNumber?: number;
  readonly turnRunRole?: ConversationTurnRunRole;
  readonly participantId: string;
  readonly workUnitId?: string;
  readonly workflowStepId?: string | null;
  readonly sourceRefs: readonly ConversationOperationSourceRef[];
  readonly operationCount: number;
  readonly targetCount: number;
  readonly defaultExpanded: boolean;
  readonly childActionIds: readonly string[];
  readonly childItemIds: readonly string[];
  readonly children: readonly ConversationTimelineExplorationItem[];
}

export type ConversationTimelineBatchItem =
  | ConversationTimelineCommandBatchItem
  | ConversationTimelineExplorationBatchItem;

export interface ConversationTimelineSubAgentItem extends ConversationTimelineItemBase {
  readonly kind: "subAgentActivity";
  readonly participantId: string;
  readonly runId?: string;
  readonly attemptId?: string;
  /** Explicit null means the Host declared that this participant has no step. */
  readonly workflowStepId: string | null;
  readonly label: string;
  readonly lifecycle: "started" | "running" | "waiting" | "interrupted" | "completed" | "blocked" | "errored";
  readonly childItems: readonly ConversationTimelineItem[];
}

export type ConversationTimelineItem =
  | ConversationTimelineMessageItem
  | ConversationTimelineRowItem
  | ConversationTimelineBatchItem
  | ConversationTimelineSubAgentItem;

export interface ConversationTimelineProjectionOptions {
  readonly turnId?: string;
  readonly participantScope?: string;
}

/**
 * During the migration a caller may still hand us raw rows instead of the
 * `ConversationWorkCellItem` wrapper. Keeping that input boundary defensive is
 * important: a malformed historical row must never take down the transcript.
 */
export type ConversationTimelineInput = ConversationWorkCellItem | ConversationWorkCellRow | ConversationTimelineItem;

/** Converts the existing WorkCell projection to the typed timeline contract. */
export function projectConversationTimelineItems(
  items: readonly ConversationTimelineInput[],
  options: ConversationTimelineProjectionOptions = {},
): readonly ConversationTimelineItem[] {
  return items.map((item, index) => {
    if (isConversationTimelineItem(item)) {
      return item;
    }
    if (isConversationWorkCellItem(item) && item.kind === "command_batch") {
      const batch = item.batch;
      const commands = batch.commands
        .map((command, commandIndex) => projectConversationTimelineRow(command.row, {
          ...options,
          participantScope: batch.participantId ?? options.participantScope,
        }, commandIndex))
        .filter((candidate): candidate is ConversationTimelineCommandExecutionItem => candidate.kind === "commandExecution")
        .map((candidate, commandIndex) => ({
          ...candidate,
          leadingItems: projectConversationTimelineItems(batch.commands[commandIndex]?.leadingRows ?? [], {
            ...options,
            participantScope: batch.participantId ?? options.participantScope,
          }),
        }));
      const firstCommand = commands[0];
      const runId = batch.runId ?? firstCommand?.runId;
      const attemptId = batch.attemptId ?? firstCommand?.attemptId;
      const participantId = batch.participantId ?? firstCommand?.participantId ?? options.participantScope;
      const actionIds = batch.actionIds.length > 0 ? batch.actionIds : commands.map((command) => command.actionId);
      const childActionIds = batch.childActionIds?.length ? batch.childActionIds : actionIds;
      const childItemIds = batch.childItemIds?.length ? batch.childItemIds : commands.map((command) => command.id);
      const sourceRefs = safeSourceRefs(batch.sourceRefs.length > 0
        ? batch.sourceRefs
        : commands.flatMap((command) => command.sourceRefs));
      if (!runId || !attemptId || !participantId || actionIds.length === 0 || commands.length !== batch.commands.length ||
        actionIds.length !== commands.length || childActionIds.length !== commands.length || childItemIds.length !== commands.length || sourceRefs.length === 0 ||
        commands.some((command) => command.runId !== runId || command.attemptId !== attemptId || command.participantId !== participantId)) {
        return blockedBatchActivity(batch.id, options, "Command batch lineage is incomplete.");
      }
      const revision = revisionFromBatch(batch.revision, batch.commands.map((command) => command.row));
      return {
        id: batch.id,
        kind: "commandBatch",
        revision,
        threadSequence: firstCommand?.threadSequence ?? index,
        partIndex: firstCommand?.partIndex ?? 0,
        status: "succeeded",
        turnId: options.turnId,
        runId,
        attemptId,
        attemptNumber: batch.attemptNumber,
        turnRunRole: batch.turnRunRole,
        participantId,
        workUnitId: batch.workUnitId,
        workflowStepId: batch.workflowStepId ?? null,
        actionId: firstCommand?.actionId ?? actionIds[0],
        sourceRefs,
        actionIds,
        childActionIds,
        childItemIds,
        batch: {
          id: batch.id,
          revision,
          revisionKey: batch.revisionKey,
          commandCount: commands.length,
          durationMs: batch.durationMs,
          defaultExpanded: batch.defaultExpanded,
          actionIds,
          runId,
          attemptId,
          attemptNumber: batch.attemptNumber,
          turnRunRole: batch.turnRunRole,
          participantId,
          workUnitId: batch.workUnitId,
          workflowStepId: batch.workflowStepId ?? null,
          sourceRefs,
          childActionIds,
          childItemIds,
          commands,
        },
      } satisfies ConversationTimelineBatchItem;
    }
    if (isConversationWorkCellItem(item) && item.kind === "exploration_batch") {
      const batch = item.batch;
      const children = batch.rows
        .map((row, childIndex) => projectConversationTimelineRow(row, {
          ...options,
          participantScope: batch.participantId ?? options.participantScope,
        }, childIndex))
        .filter((candidate): candidate is ConversationTimelineExplorationItem => candidate.kind === "exploration");
      const firstChild = children[0];
      const runId = batch.runId ?? firstChild?.runId;
      const attemptId = batch.attemptId ?? firstChild?.attemptId;
      const participantId = batch.participantId ?? firstChild?.participantId ?? options.participantScope;
      const actionIds = batch.actionIds.length > 0 ? batch.actionIds : children.map((child) => child.actionId);
      const childActionIds = batch.childActionIds?.length ? batch.childActionIds : actionIds;
      const childItemIds = batch.childItemIds?.length ? batch.childItemIds : children.map((child) => child.id);
      const sourceRefs = safeSourceRefs(batch.sourceRefs.length > 0
        ? batch.sourceRefs
        : children.flatMap((child) => child.sourceRefs));
      if (!runId || !attemptId || !participantId || actionIds.length === 0 || children.length !== batch.rows.length ||
        actionIds.length !== children.length || childActionIds.length !== children.length || childItemIds.length !== children.length || sourceRefs.length === 0 ||
        children.some((child) => child.runId !== runId || child.attemptId !== attemptId || child.participantId !== participantId)) {
        return blockedBatchActivity(batch.id, options, "Exploration batch lineage is incomplete.");
      }
      const revision = revisionFromBatch(batch.revision, batch.rows);
      return {
        id: batch.id,
        kind: "explorationBatch",
        revision,
        threadSequence: firstChild?.threadSequence ?? index,
        partIndex: firstChild?.partIndex ?? 0,
        status: "succeeded",
        turnId: options.turnId,
        runId,
        attemptId,
        attemptNumber: batch.attemptNumber,
        turnRunRole: batch.turnRunRole,
        participantId,
        workUnitId: batch.workUnitId,
        workflowStepId: batch.workflowStepId ?? null,
        actionId: actionIds[0],
        sourceRefs,
        actionIds,
        childActionIds,
        childItemIds,
        batch: {
          id: batch.id,
          revision,
          revisionKey: batch.revisionKey,
          actionIds,
          runId,
          attemptId,
          attemptNumber: batch.attemptNumber,
          turnRunRole: batch.turnRunRole,
          participantId,
          workUnitId: batch.workUnitId,
          workflowStepId: batch.workflowStepId ?? null,
          sourceRefs,
          childActionIds,
          childItemIds,
          operationCount: children.length,
          targetCount: batch.targetCount ?? children.reduce((count, child) => count + child.targets.length, 0),
          defaultExpanded: batch.defaultExpanded,
          children,
        },
      } satisfies ConversationTimelineBatchItem;
    }
    const row = isConversationWorkCellItem(item) ? item.row : item;
    return projectConversationTimelineRow(row, options, index);
  });
}

/** Projects an agent span without creating a second child-agent UI model. */
export function projectConversationSubAgentActivity(
  span: ConversationAgentActivitySpan,
  childItems: readonly ConversationTimelineInput[],
  options: ConversationTimelineProjectionOptions = {},
): ConversationTimelineSubAgentItem {
  const participantId = span.participantId ?? span.id;
  const childItemsProjected = projectConversationTimelineItems(childItems, {
    ...options,
    participantScope: participantId,
  });
  const firstFact = childItemsProjected.find((item) =>
    isOperationKind(item.kind) && typeof item.actionId === "string" && typeof item.runId === "string" &&
    typeof item.participantId === "string",
  );
  const firstFactRunId = firstFact && "runId" in firstFact ? firstFact.runId : undefined;
  const firstFactAttemptId = firstFact && "attemptId" in firstFact ? firstFact.attemptId : undefined;
  const firstFactWorkflowStepId =
    firstFact && "workflowStepId" in firstFact && typeof firstFact.workflowStepId === "string"
      ? firstFact.workflowStepId
      : undefined;
  const firstFactSourceRefs = firstFact?.sourceRefs;
  const projectedChildItems = childItemsProjected.length > 0
    ? sanitizeVisibleChildTimelineItems(childItemsProjected)
    : [missingChildEvidenceDiagnostic({
      span,
      options,
      participantId,
      runId: span.runId ?? firstFactRunId,
      attemptId: span.attemptId ?? firstFactAttemptId,
      workflowStepId: span.workflowStepId ?? firstFactWorkflowStepId ?? null,
      sourceRefs: span.sourceRefs ?? firstFactSourceRefs ?? [],
    })];
  return {
    id: `sub-agent:${span.id}`,
    kind: "subAgentActivity",
    revision: revisionFromSpan(span),
    threadSequence: projectedChildItems[0]?.threadSequence ?? 0,
    partIndex: 0,
    status: statusFromTone(span.tone),
    turnId: options.turnId,
    participantId,
    runId: span.runId ?? firstFactRunId,
    attemptId: span.attemptId ?? firstFactAttemptId,
      workflowStepId: span.workflowStepId ?? firstFactWorkflowStepId ?? null,
    label: span.label,
    lifecycle: lifecycleFromSpan(span),
    sourceRefs: span.sourceRefs ?? firstFactSourceRefs ?? [],
    childItems: projectedChildItems,
  };
}

/**
 * A child timeline is the one visible nesting level.  The input boundary is
 * intentionally defensive because legacy adapters and reconnect payloads can
 * still contain a nested participant container.  Preserve its source refs but
 * replace the third-level container with an explicit blocked diagnostic; this
 * keeps audit/detail navigation possible without creating another visual UI.
 */
function sanitizeVisibleChildTimelineItems(
  items: readonly ConversationTimelineItem[],
): readonly ConversationTimelineItem[] {
  return items.map((item) => {
    if (item.kind === "subAgentActivity") {
      return nestedDepthExceededDiagnostic(item);
    }
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

function missingChildEvidenceDiagnostic(input: {
  readonly span: ConversationAgentActivitySpan;
  readonly options: ConversationTimelineProjectionOptions;
  readonly participantId: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly workflowStepId: string | null;
  readonly sourceRefs: readonly ConversationOperationSourceRef[];
}): ConversationTimelineDiagnosticItem {
  return {
    id: `sub-agent:${input.span.id}:blocked`,
    kind: "diagnostic",
    revision: revisionFromSpan(input.span),
    threadSequence: 0,
    partIndex: 1,
    status: "blocked",
    turnId: input.options.turnId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    participantId: input.participantId,
    workflowStepId: input.workflowStepId,
    sourceRefs: input.sourceRefs,
    title: "Activity unavailable",
    description: "No typed child evidence was recorded for this Agent.",
    summary: "No typed child evidence was recorded for this Agent.",
  };
}

function projectConversationTimelineRow(
  row: ConversationWorkCellRow,
  options: ConversationTimelineProjectionOptions,
  index = 0,
): ConversationTimelineItem {
  if (!isConversationWorkCellRow(row)) {
    return {
      id: `row:invalid:${index}`,
      kind: "diagnostic",
      revision: 0,
      threadSequence: index,
      partIndex: 0,
      status: "blocked",
      turnId: options.turnId,
      participantId: options.participantScope,
      sourceRefs: [],
      title: "Activity unavailable",
      summary: "This activity record could not be read safely.",
    };
  }
  const execution = isExecutionView(row.operationExecution) ? row.operationExecution : undefined;
  const command = isCommandExecutionView(row.commandExecution) ? row.commandExecution : undefined;
  const status = statusFromRow(row);
  const sourceRefs = safeSourceRefs(execution?.sourceRefs ?? command?.sourceRefs);
  const base = {
    id: execution?.actionId ? `action:${execution.actionId}` : `row:${row.id}`,
    revision: revisionFromRow(row),
    threadSequence: index,
    partIndex: 0,
    status,
    turnId: options.turnId,
    actionId: execution?.actionId ?? command?.actionId,
    runId: execution?.runId ?? command?.runId,
    attemptId: execution?.attemptId ?? command?.attemptId,
    attemptNumber: execution?.attemptNumber ?? command?.attemptNumber,
    turnRunRole: execution?.turnRunRole ?? command?.turnRunRole,
    participantId: execution?.participantId ?? command?.participantId ?? options.participantScope,
    workUnitId: execution?.workUnitId ?? command?.workUnitId,
    workflowStepId: execution?.workflowStepId ?? command?.workflowStepId,
    approvalId: execution?.approvalId ?? command?.approvalId,
    toolCallId: execution?.toolCallId ?? command?.toolCallId,
    sourceRefs,
  } satisfies Omit<ConversationTimelineItemBase, "id" | "kind"> & { id: string; revision: number };

  const semanticKind = semanticKindForRow(row, execution, command);
  const requiresOperation = semanticKind === "commandExecution" ||
    semanticKind === "fileChange" ||
    semanticKind === "exploration" ||
    semanticKind === "mcpToolCall" ||
    semanticKind === "dynamicToolCall" ||
    semanticKind === "collabAgentToolCall" ||
    semanticKind === "approval";
  const operationBase = buildOperationBase(base, execution, command, options, sourceRefs);
  if (requiresOperation && !operationBase) {
    // Rows synthesized from a run/artifact summary can still be useful
    // narrative, but they are not execution evidence because they do not
    // carry an action identity and source lineage. Keep those rows visible as
    // generic activity instead of rendering a misleading blocked operation.
    // An explicitly supplied operation payload with incomplete lineage still
    // fails closed below, so malformed execution facts cannot acquire trust.
    if (!execution && !command) {
      return {
        ...base,
        kind: "diagnostic",
        title: row.title,
        description: row.description,
        meta: row.meta,
        detailLines: row.detailLines,
        summary: row.description ?? row.title,
      };
    }
    return blockedActivityForRow(row, options, "Missing action, run, participant, or source lineage.");
  }
  if (semanticKind === "plan") {
    return {
      ...base,
      kind: "plan",
      title: row.title,
      description: row.description,
      meta: row.meta,
      detailLines: row.detailLines,
      steps: [],
    };
  }
  if (row.presentation === "note" && (row.description?.trim() || row.title.trim())) {
    return {
      ...base,
      id: `message:${row.id}`,
      kind: "agentMessage",
      markdown: row.description?.trim() || row.title.trim(),
      phase: status === "succeeded" ? "final" : "commentary",
    };
  }
  if (semanticKind === "commandExecution") {
    const commandText = command?.commandText ?? row.commandText ?? row.title;
    return {
      ...operationBase!,
      kind: "commandExecution",
      title: row.title,
      description: row.description,
      meta: row.meta,
      detailLines: row.detailLines,
      command: commandText,
      risk: command?.risk ?? "low",
      cwd: command?.cwd,
      outputTail: command?.outputTail ?? outputTailFromDetailLines(row.detailLines),
      outputTruncated: command?.outputTruncated ?? false,
      exitCode: command?.exitCode,
      durationMs: command?.durationMs,
      signal: command?.signal,
    };
  }
  if (semanticKind === "fileChange") {
    return {
      ...operationBase!,
      kind: "fileChange",
      title: row.title,
      description: row.description,
      meta: row.meta,
      detailLines: row.detailLines,
      changePreview: row.changePreview,
      files: fileChangePayload(row, execution),
    };
  }
  if (semanticKind === "exploration") {
    const operation = explorationOperation(execution?.actionType, row.kind);
    return {
      ...operationBase!,
      kind: "exploration",
      title: row.title,
      description: row.description,
      meta: row.meta,
      detailLines: row.detailLines,
      operation,
      targets: sourceRefs.filter((ref) => ref.kind === "file" || ref.kind === "path"),
      resultSummary: row.description,
    };
  }
  if (semanticKind === "approval") {
    const approvalId = execution?.approvalId;
    if (!approvalId) {
      return blockedActivityForRow(row, options, "Approval evidence is missing its durable approval id.");
    }
    return {
      ...base,
      kind: "approval",
      title: row.title,
      description: row.description,
      meta: row.meta,
      detailLines: row.detailLines,
      approvalId,
      decision: approvalDecision(status),
    };
  }
  if (semanticKind === "mcpToolCall") {
    return toolCallPayload("mcpToolCall", row, operationBase!, execution);
  }
  if (semanticKind === "dynamicToolCall") {
    return toolCallPayload("dynamicToolCall", row, operationBase!, execution);
  }
  if (semanticKind === "collabAgentToolCall") {
    return toolCallPayload("collabAgentToolCall", row, operationBase!, execution);
  }
  if (semanticKind === "imageView") {
    if (!operationBase) {
      return blockedActivityForRow(row, options, "Image evidence is missing required action lineage.");
    }
    return {
      ...operationBase,
      kind: "imageView",
      title: row.title,
      description: row.description,
      meta: row.meta,
      detailLines: row.detailLines,
      artifactRef: sourceRefs.find((ref) => ref.kind === "artifact"),
      alt: row.title,
    };
  }
  if (semanticKind === "contextCompaction") {
    return {
      ...base,
      kind: "contextCompaction",
      title: row.title,
      description: row.description,
      meta: row.meta,
      detailLines: row.detailLines,
      summary: row.description ?? row.title,
    };
  }
  if (semanticKind === "reasoning") {
    return {
      ...base,
      kind: "reasoning",
      title: row.title,
      description: row.description,
      meta: row.meta,
      detailLines: row.detailLines,
      summary: row.description ?? row.title,
    };
  }
  return {
    ...base,
    kind: "diagnostic",
    title: row.title,
    description: row.description,
    meta: row.meta,
    detailLines: row.detailLines,
    summary: row.description,
  };
}

function buildOperationBase(
  base: Omit<ConversationTimelineItemBase, "id" | "kind"> & { id: string; revision: number },
  execution: NonNullable<ConversationWorkCellRow["operationExecution"]> | undefined,
  command: NonNullable<ConversationWorkCellRow["commandExecution"]> | undefined,
  options: ConversationTimelineProjectionOptions,
  sourceRefs: readonly ConversationOperationSourceRef[],
): ConversationTimelineOperationPayload | undefined {
  const actionId = execution?.actionId ?? command?.actionId;
  const runId = execution?.runId ?? command?.runId;
  // The participant must come from durable lineage or an explicit child scope.
  // A renderer fallback would hide an ownership bug and could credit the wrong agent.
  const participantId = execution?.participantId ?? command?.participantId ?? options.participantScope;
  const attemptId = execution?.attemptId ?? command?.attemptId;
  const workflowStepId = execution?.workflowStepId ?? command?.workflowStepId ?? null;
  if (!actionId?.trim() || !runId?.trim() || !attemptId?.trim() || !participantId?.trim()) {
    return undefined;
  }

  const normalizedRefs = sourceRefs;

  // Every operation needs an owning conversation-item anchor before it can
  // participate in the default transcript. Other refs alone are useful in an
  // audit view, but cannot establish causal placement beside messages.
  if (!normalizedRefs.some((ref) => ref.kind === "conversation_item")) {
    return undefined;
  }

  return {
    ...base,
    actionId,
    runId,
    attemptId,
    participantId,
    workflowStepId,
    sourceRefs: normalizedRefs,
    title: "",
  };
}

function blockedActivityForRow(
  row: ConversationWorkCellRow,
  options: ConversationTimelineProjectionOptions,
  reason: string,
): ConversationTimelineDiagnosticItem {
  const execution = isExecutionView(row.operationExecution) ? row.operationExecution : undefined;
  const command = isCommandExecutionView(row.commandExecution) ? row.commandExecution : undefined;
  const actionId = execution?.actionId ?? command?.actionId;
  const sourceRefs = safeSourceRefs(execution?.sourceRefs ?? command?.sourceRefs);
  return {
    id: actionId ? `action:${actionId}` : `row:invalid:${row.id}`,
    kind: "diagnostic",
    revision: revisionFromRow(row),
    threadSequence: 0,
    partIndex: 0,
    status: "blocked",
    turnId: options.turnId,
    ...(actionId ? { actionId } : {}),
    ...(execution?.runId || command?.runId ? { runId: execution?.runId ?? command?.runId } : {}),
    participantId: execution?.participantId ?? command?.participantId ?? options.participantScope,
    sourceRefs,
    title: "Activity unavailable",
    description: reason,
    summary: reason,
  };
}

function blockedBatchActivity(
  id: string,
  options: ConversationTimelineProjectionOptions,
  reason: string,
): ConversationTimelineDiagnosticItem {
  return {
    id: `batch:${id}`,
    kind: "diagnostic",
    revision: 0,
    threadSequence: 0,
    partIndex: 0,
    status: "blocked",
    turnId: options.turnId,
    participantId: options.participantScope,
    sourceRefs: [],
    title: "Activity unavailable",
    description: reason,
    summary: reason,
  };
}

function fileChangePayload(
  row: ConversationWorkCellRow,
  execution: NonNullable<ConversationWorkCellRow["operationExecution"]> | undefined,
): ConversationTimelineFileChangeItem["files"] {
  const actionType = execution?.actionType?.toLowerCase();
  const change = actionType === "write" || actionType === "file_write" ? "created" : "edited";
  const refs = safeSourceRefs(execution?.sourceRefs).filter((ref) => ref.kind === "file");
  if (refs.length > 0) {
    return refs.map((fileRef) => ({
      fileRef,
      displayName: basename(fileRef.path ?? fileRef.label ?? fileRef.id),
      change,
    }));
  }
  if (row.changePreview?.path) {
    const fileRef: ConversationOperationSourceRef = {
      kind: "file",
      id: row.changePreview.path,
      path: row.changePreview.path,
      label: row.changePreview.path,
    };
    return [{ fileRef, displayName: basename(row.changePreview.path), change }];
  }
  return [];
}

function outputTailFromDetailLines(
  lines: readonly ConversationWorkCellRowDetailLine[] | undefined,
): ConversationTimelineCommandExecutionItem["outputTail"] {
  if (!lines) return [];
  return lines
    .filter((line) => line.kind === "code" && line.text.trim() && !line.text.trim().startsWith("$ "))
    .map((line, index) => ({
      eventSeq: index,
      stream: "stdout" as const,
      text: line.text,
      redacted: false,
    }));
}

function toolCallPayload(
  kind: "mcpToolCall" | "dynamicToolCall" | "collabAgentToolCall",
  row: ConversationWorkCellRow,
  base: ConversationTimelineOperationPayload,
  execution: NonNullable<ConversationWorkCellRow["operationExecution"]> | undefined,
): ConversationTimelineToolCallItem {
  return {
    ...base,
    kind,
    title: row.title,
    description: row.description,
    meta: row.meta,
    detailLines: row.detailLines,
    toolName: execution?.actionType ?? row.title,
    inputSummary: row.description,
    resultSummary: row.meta,
    detailRef: safeSourceRefs(execution?.sourceRefs).find((ref) => ref.kind === "mcp_tool"),
  };
}

function explorationOperation(
  actionType: string | undefined,
  legacyKind: ConversationWorkCellRow["kind"],
): ConversationTimelineExplorationItem["operation"] {
  const normalized = actionType?.toLowerCase();
  if (normalized === "grep" || normalized === "find" || normalized === "ls" || normalized === "search") {
    return normalized;
  }
  if (legacyKind === "search") {
    return "search";
  }
  return "read";
}

function approvalDecision(
  status: ConversationTimelineItemStatus | undefined,
): ConversationTimelineApprovalItem["decision"] {
  if (status === "succeeded") return "allowed";
  if (status === "failed" || status === "blocked") return "denied";
  if (status === "cancelled") return "cancelled";
  return undefined;
}

function basename(value: string): string {
  const normalized = value.trim().replace(/\\/gu, "/");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  return name || normalized || "file";
}

type SemanticRowKind = ConversationTimelineRowItem["kind"];

function semanticKindForRow(
  row: ConversationWorkCellRow,
  execution: NonNullable<ConversationWorkCellRow["operationExecution"]> | undefined,
  command: NonNullable<ConversationWorkCellRow["commandExecution"]> | undefined,
): SemanticRowKind {
  // The action contract is authoritative. `row.kind` is only a legacy fallback.
  const actionType = execution?.actionType?.trim().toLowerCase();
  if (actionType === "plan") return "plan";
  if (actionType === "reasoning" || actionType === "reasoning_summary") return "reasoning";
  if (actionType === "read" || actionType === "grep" || actionType === "find" || actionType === "ls" || actionType === "search") return "exploration";
  if (actionType === "write" || actionType === "edit" || actionType === "file_write" || actionType === "file_edit") return "fileChange";
  if (actionType === "approval" || actionType === "permission" || actionType === "permission_request") return "approval";
  if (actionType === "mcp_tool_call" || actionType === "mcp") return "mcpToolCall";
  if (actionType === "dynamic_tool_call" || actionType === "dynamic_tool") return "dynamicToolCall";
  if (actionType === "collab_agent_tool_call" || actionType === "spawn_agent" || actionType === "delegate_agent" || actionType === "agent_call") return "collabAgentToolCall";
  if (actionType === "image_view" || actionType === "image_viewer" || actionType === "image") return "imageView";
  if (actionType === "context_compaction" || actionType === "compaction") return "contextCompaction";
  if (command || actionType === "bash" || actionType === "shell" || actionType === "run_command" || actionType === "verify" || actionType?.startsWith("git_")) return "commandExecution";

  if (row.kind === "plan") return "plan";
  if (row.kind === "edit") return "fileChange";
  if (row.kind === "read" || row.kind === "search") return "exploration";
  if (row.kind === "approval") return "approval";
  if (row.kind === "run_command" || row.kind === "verify") return "commandExecution";
  return "diagnostic";
}

function statusFromRow(row: ConversationWorkCellRow): ConversationTimelineItemStatus | undefined {
  if (row.tone === "running") return "running";
  if (row.tone === "waiting") return "waiting";
  if (row.tone === "failed") return "failed";
  if (row.tone === "success") return "succeeded";
  const status = row.operationExecution?.status ?? row.commandExecution?.status;
  if (status === "executing" || status === "running") return "running";
  if (status === "waiting_for_approval" || status === "waiting") return "waiting";
  if (status === "blocked") return "blocked";
  if (status === "succeeded") return "succeeded";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return undefined;
}

function revisionFromRow(row: ConversationWorkCellRow): number {
  const revision = row.operationExecution?.revision ?? row.commandExecution?.revision ??
    row.operationExecution?.latestEventSeq ?? row.commandExecution?.latestEventSeq;
  return typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

function revisionFromBatch(revision: number | undefined, rows: readonly ConversationWorkCellRow[]): number {
  if (typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0) return revision;
  let total = 0;
  for (const row of rows) {
    const childRevision = revisionFromRow(row);
    if (!Number.isSafeInteger(childRevision) || childRevision < 0) continue;
    total = Math.min(Number.MAX_SAFE_INTEGER, total + childRevision + 1);
  }
  return total;
}

function revisionFromSpan(span: ConversationAgentActivitySpan): number {
  const revisions = span.rows.flatMap((row) => [row.operationExecution?.revision, row.commandExecution?.revision, row.operationExecution?.latestEventSeq, row.commandExecution?.latestEventSeq])
    .filter((revision): revision is number => typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0);
  return revisions.length > 0 ? Math.max(...revisions) : 0;
}

function statusFromTone(tone: ConversationAgentActivitySpan["tone"]): ConversationTimelineItemStatus | undefined {
  if (tone === "running") return "running";
  if (tone === "waiting") return "waiting";
  if (tone === "failed") return "failed";
  if (tone === "success") return "succeeded";
  return undefined;
}

function lifecycleFromSpan(span: ConversationAgentActivitySpan): ConversationTimelineSubAgentItem["lifecycle"] {
  if (span.tone === "failed") return "errored";
  if (span.tone === "waiting") return "waiting";
  if (span.tone === "running") return "running";
  if (span.tone === "success") return "completed";
  return span.latestRow ? "running" : "started";
}

function isConversationWorkCellItem(value: unknown): value is ConversationWorkCellItem {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { readonly kind?: unknown }).kind;
  return kind === "operation" || kind === "command_batch" || kind === "exploration_batch";
}

export function isConversationTimelineItem(value: unknown): value is ConversationTimelineItem {
  if (!value || typeof value !== "object") return false;
  const candidate = value as {
    readonly id?: unknown;
    readonly revision?: unknown;
    readonly threadSequence?: unknown;
    readonly partIndex?: unknown;
    readonly sourceRefs?: unknown;
    readonly kind?: unknown;
  };
  if (!(typeof candidate.id === "string" &&
    typeof candidate.revision === "number" &&
    typeof candidate.threadSequence === "number" && Number.isSafeInteger(candidate.threadSequence) && candidate.threadSequence >= 0 &&
    typeof candidate.partIndex === "number" && Number.isSafeInteger(candidate.partIndex) && candidate.partIndex >= 0 &&
    Array.isArray(candidate.sourceRefs) &&
    candidate.sourceRefs.every((ref) => Boolean(
      ref && typeof ref === "object" &&
      typeof (ref as { readonly kind?: unknown }).kind === "string" &&
      typeof (ref as { readonly id?: unknown }).id === "string",
    )) &&
    typeof candidate.kind === "string" &&
    TIMELINE_ITEM_KINDS.has(candidate.kind as ConversationTimelineItemKind))) {
    return false;
  }
  const item = value as Record<string, unknown>;
  if (isOperationKind(candidate.kind as ConversationTimelineItemKind) && !isOperationLineage(item)) {
    return false;
  }
  switch (candidate.kind) {
    case "userMessage":
    case "agentMessage":
      return typeof item.markdown === "string";
    case "reasoning":
    case "contextCompaction":
      return typeof item.title === "string" && typeof item.summary === "string";
    case "plan":
      return typeof item.title === "string" && Array.isArray(item.steps) && item.steps.every(isPlanStep);
    case "commandExecution":
      return typeof item.title === "string" &&
        typeof item.command === "string" &&
        Array.isArray(item.outputTail) && item.outputTail.every(isOutputChunk);
    case "fileChange":
      return typeof item.title === "string" && Array.isArray(item.files) && item.files.every(isFileChange);
    case "exploration":
      return typeof item.title === "string" && Array.isArray(item.targets) && item.targets.every(isSourceRef);
    case "mcpToolCall":
    case "dynamicToolCall":
    case "collabAgentToolCall":
      return typeof item.title === "string" && typeof item.toolName === "string";
    case "approval":
      return typeof item.title === "string" && typeof item.approvalId === "string" && item.approvalId.length > 0;
    case "imageView":
      return typeof item.title === "string" && typeof item.alt === "string" && isOperationLineage(item);
    case "diagnostic":
      return typeof item.title === "string";
    case "commandBatch":
      return Array.isArray(item.actionIds) && item.actionIds.every((id) => typeof id === "string" && id.length > 0) &&
        isCommandBatchPayload(item.batch);
    case "explorationBatch":
      return Array.isArray(item.actionIds) && item.actionIds.every((id) => typeof id === "string" && id.length > 0) &&
        isExplorationBatchPayload(item.batch);
    case "subAgentActivity":
      return typeof item.participantId === "string" &&
        typeof item.label === "string" &&
        typeof item.lifecycle === "string" &&
        (item.workflowStepId === null || typeof item.workflowStepId === "string") &&
        Array.isArray(item.childItems) && item.childItems.every(isConversationTimelineItem);
    default:
      return false;
  }
}

function isOperationKind(kind: ConversationTimelineItemKind): boolean {
  return kind === "commandExecution" || kind === "fileChange" || kind === "exploration" ||
    kind === "mcpToolCall" || kind === "dynamicToolCall" || kind === "collabAgentToolCall" ||
    kind === "imageView" || kind === "commandBatch" || kind === "explorationBatch";
}

function isOperationLineage(item: Record<string, unknown>): boolean {
  return typeof item.actionId === "string" && item.actionId.trim().length > 0 &&
    typeof item.runId === "string" && item.runId.trim().length > 0 &&
    typeof item.attemptId === "string" && item.attemptId.trim().length > 0 &&
    typeof item.participantId === "string" && item.participantId.trim().length > 0 &&
    (item.workflowStepId === null || typeof item.workflowStepId === "string") &&
    Array.isArray(item.sourceRefs) && item.sourceRefs.every(isSourceRef);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isSourceRef(value: unknown): value is ConversationOperationSourceRef {
  return isRecord(value) && typeof value.kind === "string" && typeof value.id === "string";
}

function isPlanStep(value: unknown): boolean {
  return isRecord(value) && typeof value.id === "string" && typeof value.text === "string" &&
    (value.status === "pending" || value.status === "running" || value.status === "completed" || value.status === "blocked");
}

function isOutputChunk(value: unknown): boolean {
  return isRecord(value) && Number.isSafeInteger(value.eventSeq) &&
    (value.stream === "stdout" || value.stream === "stderr") &&
    typeof value.text === "string" && typeof value.redacted === "boolean";
}

function isFileChange(value: unknown): boolean {
  return isRecord(value) && isSourceRef(value.fileRef) && typeof value.displayName === "string" &&
    (value.change === "created" || value.change === "edited" || value.change === "deleted" || value.change === "renamed");
}

function isCommandBatchPayload(value: unknown): boolean {
  return isRecord(value) && typeof value.id === "string" && Array.isArray(value.commands) &&
    value.commands.every((command) => isRecord(command) && isConversationTimelineItem({
      ...command,
      kind: "commandExecution",
      sourceRefs: Array.isArray(command.sourceRefs) ? command.sourceRefs : [],
      revision: typeof command.revision === "number" ? command.revision : 0,
    }));
}

function isExplorationBatchPayload(value: unknown): boolean {
  return isRecord(value) && typeof value.id === "string" && Array.isArray(value.children) &&
    value.children.every((child) => isConversationTimelineItem(child));
}

const TIMELINE_ITEM_KINDS = new Set<ConversationTimelineItemKind>([
  "userMessage",
  "agentMessage",
  "reasoning",
  "plan",
  "commandExecution",
  "fileChange",
  "exploration",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "approval",
  "imageView",
  "contextCompaction",
  "subAgentActivity",
  "diagnostic",
  "commandBatch",
  "explorationBatch",
]);

function isConversationWorkCellRow(value: unknown): value is ConversationWorkCellRow {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { readonly id?: unknown; readonly title?: unknown };
  return typeof candidate.id === "string" && typeof candidate.title === "string";
}

function isExecutionView(value: unknown): value is NonNullable<ConversationWorkCellRow["operationExecution"]> {
  return Boolean(value && typeof value === "object" && typeof (value as { readonly actionId?: unknown }).actionId === "string");
}

function isCommandExecutionView(value: unknown): value is NonNullable<ConversationWorkCellRow["commandExecution"]> {
  return Boolean(value && typeof value === "object" && typeof (value as { readonly actionId?: unknown }).actionId === "string");
}

function safeSourceRefs(
  refs: readonly ConversationOperationSourceRef[] | undefined,
): readonly ConversationOperationSourceRef[] {
  if (!Array.isArray(refs)) return [];
  return refs.filter((ref): ref is ConversationOperationSourceRef => Boolean(
    ref && typeof ref === "object" && typeof ref.kind === "string" && typeof ref.id === "string",
  ));
}
