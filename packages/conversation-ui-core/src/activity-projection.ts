import type {
  ConversationActivitySummary,
  ConversationExplorationBatch,
  ConversationOperationExecutionView,
  ConversationOperationSourceRef,
  ConversationWorkCellItem,
  ConversationWorkCellRow,
} from "./work-cell-view-model.js";
import { projectConversationCommandBatches } from "./command-batching.js";

const MINIMUM_EXPLORATION_BATCH_SIZE = 3;
const READ_ACTION_TYPES = new Set(["read", "grep", "find", "ls"]);

export function projectConversationActivity(
  rows: readonly ConversationWorkCellRow[],
  options: { readonly participantScope?: string } = {},
): readonly ConversationWorkCellItem[] {
  const commandItems = projectConversationCommandBatches(rows, options);
  const output: ConversationWorkCellItem[] = [];
  let nonCommandRows: ConversationWorkCellRow[] = [];

  const flushNonCommandRows = (): void => {
    if (nonCommandRows.length === 0) {
      return;
    }
    output.push(...projectConversationExplorationBatches(nonCommandRows, options));
    nonCommandRows = [];
  };

  for (const item of commandItems) {
    if (item.kind === "command_batch") {
      flushNonCommandRows();
      output.push(item);
      continue;
    }
    if (item.kind === "operation" && item.row.commandExecution) {
      flushNonCommandRows();
      output.push(item);
      continue;
    }
    if (item.kind === "operation") {
      nonCommandRows.push(item.row);
    }
  }
  flushNonCommandRows();
  return output;
}

export function projectConversationExplorationBatches(
  rows: readonly ConversationWorkCellRow[],
  options: { readonly participantScope?: string } = {},
): readonly ConversationWorkCellItem[] {
  const output: ConversationWorkCellItem[] = [];
  let pendingRows: ConversationWorkCellRow[] = [];
  let pendingActions: ConversationWorkCellRow[] = [];
  let leadingRows: ConversationWorkCellRow[] = [];

  const flush = (): void => {
    if (pendingRows.length === 0) {
      return;
    }
    if (pendingActions.length < MINIMUM_EXPLORATION_BATCH_SIZE) {
      output.push(...pendingRows.map((row) => ({ kind: "operation" as const, row })));
    } else {
      output.push({
        kind: "exploration_batch",
        batch: buildExplorationBatch(pendingRows, pendingActions, options.participantScope),
      });
    }
    pendingRows = [];
    pendingActions = [];
  };

  const flushLeadingRows = (): void => {
    if (leadingRows.length === 0) {
      return;
    }
    output.push(...leadingRows.map((row) => ({ kind: "operation" as const, row })));
    leadingRows = [];
  };

  for (const row of rows) {
    const execution = row.operationExecution;
    if (row.presentation === "note") {
      if (execution?.actionId) {
        leadingRows.push(row);
      } else {
        flush();
        flushLeadingRows();
        output.push({ kind: "operation", row });
      }
      continue;
    }

    if (!isExplorationBatchEligible(row)) {
      flush();
      flushLeadingRows();
      output.push({ kind: "operation", row });
      continue;
    }

    if (pendingActions.length > 0 && !sameExplorationScope(pendingActions[0], row)) {
      flush();
    }
    pendingRows.push(...leadingRows, row);
    pendingActions.push(row);
    leadingRows = [];
  }

  flush();
  flushLeadingRows();
  return output;
}

export function isExplorationBatchEligible(row: ConversationWorkCellRow): boolean {
  const execution = row.operationExecution;
  return Boolean(
    row.presentation !== "note" &&
    execution?.actionId &&
    execution.runId &&
    execution.attemptId &&
    !execution.approvalId &&
    execution.turnRunRole &&
    execution.sourceRefs.length > 0 &&
    READ_ACTION_TYPES.has(execution.actionType) &&
    execution.status === "succeeded",
  );
}

export function summarizeConversationActivity(
  rows: readonly ConversationWorkCellRow[],
): ConversationActivitySummary {
  const seen = new Set<string>();
  let editedFileCount = 0;
  let editedItemCount = 0;
  let readItemCount = 0;
  let commandCount = 0;

  for (const row of rows) {
    if (row.presentation === "note") {
      continue;
    }
    const execution = row.operationExecution;
    if (!execution?.actionId || seen.has(execution.actionId) || execution.status !== "succeeded") {
      continue;
    }
    seen.add(execution.actionId);

    if (execution.actionType === "write" || execution.actionType === "edit") {
      editedItemCount += 1;
      const files = uniqueRefs(execution.sourceRefs, "file");
      editedFileCount += files.length;
      continue;
    }
    if (READ_ACTION_TYPES.has(execution.actionType)) {
      const files = uniqueRefs(execution.sourceRefs, "file");
      readItemCount += files.length > 0 ? files.length : 1;
      continue;
    }
    if (execution.actionType === "bash" && row.commandExecution?.risk === "low") {
      commandCount += 1;
    }
  }

  return {
    editedFileCount,
    editedItemCount,
    readItemCount,
    commandCount,
    hasStructuredActions: editedItemCount > 0 || readItemCount > 0 || commandCount > 0,
  };
}

function sameExplorationScope(left: ConversationWorkCellRow, right: ConversationWorkCellRow): boolean {
  const leftExecution = left.operationExecution;
  const rightExecution = right.operationExecution;
  if (!leftExecution || !rightExecution) {
    return false;
  }
  return leftExecution.runId === rightExecution.runId &&
    leftExecution.attemptId === rightExecution.attemptId &&
    leftExecution.turnRunRole === rightExecution.turnRunRole &&
    leftExecution.participantId === rightExecution.participantId &&
    leftExecution.workUnitId === rightExecution.workUnitId &&
    leftExecution.workflowStepId === rightExecution.workflowStepId;
}

function buildExplorationBatch(
  rows: readonly ConversationWorkCellRow[],
  actionRows: readonly ConversationWorkCellRow[],
  participantScope = "primary",
): ConversationExplorationBatch {
  const first = actionRows[0]?.operationExecution;
  if (!first?.runId) {
    throw new Error("Exploration batches require a run identity.");
  }
  const actionIds = actionRows.map((row) => row.operationExecution?.actionId).filter((id): id is string => Boolean(id));
  const sourceRefs = uniqueSourceRefs(actionRows.flatMap((row) => row.operationExecution?.sourceRefs ?? []));
  const targetCount = actionRows.reduce((count, row) => {
    const files = uniqueRefs(row.operationExecution?.sourceRefs ?? [], "file");
    return count + (files.length > 0 ? files.length : 1);
  }, 0);
  return {
    id: `exploration-batch:${stableIdPart(participantScope)}:${stableIdPart(first.runId)}:${stableIdPart(first.actionId)}`,
    revisionKey: actionRows.map((row) => {
      const execution = row.operationExecution;
      return `${execution?.actionId ?? row.id}:${execution?.status ?? "unknown"}:${execution?.latestEventSeq ?? 0}:${execution?.updatedAt ?? ""}`;
    }).join("|"),
    actionIds,
    runId: first.runId,
    attemptId: first.attemptId,
    turnRunRole: first.turnRunRole,
    participantId: first.participantId,
    workUnitId: first.workUnitId,
    workflowStepId: first.workflowStepId,
    sourceRefs,
    operationCount: actionRows.length,
    targetCount,
    defaultExpanded: false,
    rows,
  };
}

function uniqueRefs(
  refs: readonly ConversationOperationSourceRef[],
  kind: string,
): readonly ConversationOperationSourceRef[] {
  return uniqueSourceRefs(refs.filter((ref) => ref.kind === kind));
}

function uniqueSourceRefs(refs: readonly ConversationOperationSourceRef[]): readonly ConversationOperationSourceRef[] {
  const seen = new Set<string>();
  const unique: ConversationOperationSourceRef[] = [];
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(ref);
  }
  return unique;
}

function stableIdPart(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/gu, "-") || "unknown";
}
