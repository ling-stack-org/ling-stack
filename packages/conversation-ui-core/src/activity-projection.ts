import type {
  ConversationActivitySummary,
  ConversationExplorationBatch,
  ConversationOperationExecutionView,
  ConversationOperationSourceRef,
  ConversationWorkCellItem,
  ConversationWorkCellRow,
} from "./work-cell-view-model.js";
import { isCommandBatchEligible, projectConversationCommandBatches } from "./command-batching.js";

const MINIMUM_EXPLORATION_BATCH_SIZE = 3;
const READ_ACTION_TYPES = new Set(["read", "grep", "find", "ls"]);

export function projectConversationActivity(
  rows: readonly ConversationWorkCellRow[],
  options: { readonly participantScope?: string } = {},
): readonly ConversationWorkCellItem[] {
  const output: ConversationWorkCellItem[] = [];
  let pendingCommands: Array<{ readonly row: ConversationWorkCellRow; readonly leadingRows: readonly ConversationWorkCellRow[] }> = [];
  let pendingExplorationRows: ConversationWorkCellRow[] = [];
  let pendingExplorationActions: ConversationWorkCellRow[] = [];
  let leadingRows: ConversationWorkCellRow[] = [];

  const flushCommands = (): void => {
    if (pendingCommands.length === 0) return;
    if (pendingCommands.length >= 3) {
      output.push(...projectConversationCommandBatches(
        pendingCommands.flatMap((entry) => [...entry.leadingRows, entry.row]),
        options,
      ));
    } else {
      for (const entry of pendingCommands) {
        output.push(...entry.leadingRows.map((row) => ({ kind: "operation" as const, row })));
        output.push({ kind: "operation", row: entry.row });
      }
    }
    pendingCommands = [];
  };

  const flushExploration = (): void => {
    if (pendingExplorationRows.length === 0) return;
    if (pendingExplorationActions.length >= MINIMUM_EXPLORATION_BATCH_SIZE) {
      output.push({
        kind: "exploration_batch",
        batch: buildExplorationBatch(pendingExplorationRows, pendingExplorationActions, options.participantScope),
      });
    } else {
      output.push(...pendingExplorationRows.map((row) => ({ kind: "operation" as const, row })));
    }
    pendingExplorationRows = [];
    pendingExplorationActions = [];
  };

  const flushLeading = (): void => {
    if (leadingRows.length === 0) return;
    output.push(...leadingRows.map((row) => ({ kind: "operation" as const, row })));
    leadingRows = [];
  };

  for (const row of rows) {
    if (row.presentation === "note") {
      if (row.operationExecution?.actionId) {
        leadingRows.push(row);
      } else {
        flushCommands();
        flushExploration();
        flushLeading();
        output.push({ kind: "operation", row });
      }
      continue;
    }

    if (isCommandBatchEligible(row)) {
      flushExploration();
      if (pendingCommands.length > 0 && !sameCommandScope(pendingCommands[0]?.row, row)) {
        flushCommands();
      }
      pendingCommands.push({ row, leadingRows });
      leadingRows = [];
      continue;
    }

    if (isExplorationBatchEligible(row)) {
      flushCommands();
      if (pendingExplorationActions.length > 0 && !sameExplorationScope(pendingExplorationActions[0], row)) {
        flushExploration();
      }
      pendingExplorationRows.push(...leadingRows, row);
      pendingExplorationActions.push(row);
      leadingRows = [];
      continue;
    }

    flushCommands();
    flushExploration();
    flushLeading();
    output.push({ kind: "operation", row });
  }

  flushCommands();
  flushExploration();
  flushLeading();
  return output;
}

function sameCommandScope(left: ConversationWorkCellRow | undefined, right: ConversationWorkCellRow): boolean {
  if (!left) return false;
  const leftCommand = left.commandExecution;
  const rightCommand = right.commandExecution;
  const leftOperation = left.operationExecution;
  const rightOperation = right.operationExecution;
  return Boolean(
    leftCommand && rightCommand &&
    leftCommand.runId === rightCommand.runId &&
    (leftCommand.attemptId ?? leftOperation?.attemptId) === (rightCommand.attemptId ?? rightOperation?.attemptId) &&
    (leftCommand.turnRunRole ?? leftOperation?.turnRunRole) === (rightCommand.turnRunRole ?? rightOperation?.turnRunRole) &&
    (leftCommand.participantId ?? leftOperation?.participantId) === (rightCommand.participantId ?? rightOperation?.participantId) &&
    leftCommand.workUnitId === rightCommand.workUnitId &&
    leftCommand.workflowStepId === rightCommand.workflowStepId &&
    (!leftOperation || !rightOperation || (
      leftOperation.runId === rightOperation.runId &&
      leftOperation.attemptId === rightOperation.attemptId &&
      leftOperation.turnRunRole === rightOperation.turnRunRole &&
      leftOperation.participantId === rightOperation.participantId &&
      leftOperation.workUnitId === rightOperation.workUnitId &&
      leftOperation.workflowStepId === rightOperation.workflowStepId
    )),
  );
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
  const childItemIds = actionRows.map((row) => row.id);
  const sourceRefs = uniqueSourceRefs(actionRows.flatMap((row) => row.operationExecution?.sourceRefs ?? []));
  const targetCount = actionRows.reduce((count, row) => {
    const files = uniqueRefs(row.operationExecution?.sourceRefs ?? [], "file");
    return count + (files.length > 0 ? files.length : 1);
  }, 0);
  return {
    id: `exploration-batch:${stableIdPart(participantScope)}:${stableIdPart(first.runId)}:${stableIdPart(first.actionId)}`,
    revision: aggregateRevision(actionRows),
    revisionKey: actionRows.map((row) => {
      const execution = row.operationExecution;
      return `${execution?.actionId ?? row.id}:${execution?.status ?? "unknown"}:${execution?.latestEventSeq ?? 0}:${execution?.updatedAt ?? ""}`;
    }).join("|"),
    actionIds,
    childActionIds: actionIds,
    childItemIds,
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

function aggregateRevision(rows: readonly ConversationWorkCellRow[]): number {
  let total = 0;
  for (const row of rows) {
    const revision = row.operationExecution?.revision ?? row.operationExecution?.latestEventSeq ?? 0;
    if (!Number.isSafeInteger(revision) || revision < 0) continue;
    total = Math.min(Number.MAX_SAFE_INTEGER, total + revision + 1);
  }
  return total;
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
