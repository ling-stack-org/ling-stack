import type {
  ConversationCommandBatch,
  ConversationCommandBatchItem,
  ConversationOperationSourceRef,
  ConversationWorkCellItem,
  ConversationWorkCellRow,
} from "./work-cell-view-model.js";

const MINIMUM_COMMAND_BATCH_SIZE = 3;

export function projectConversationCommandBatches(
  rows: readonly ConversationWorkCellRow[],
  options: { readonly participantScope?: string } = {},
): readonly ConversationWorkCellItem[] {
  const output: ConversationWorkCellItem[] = [];
  let pending: Array<{ readonly row: ConversationWorkCellRow; readonly leadingRows: readonly ConversationWorkCellRow[] }> = [];
  let leadingRows: ConversationWorkCellRow[] = [];

  const flush = (): void => {
    if (pending.length === 0) {
      return;
    }
    if (pending.length < MINIMUM_COMMAND_BATCH_SIZE) {
      for (const entry of pending) {
        output.push(...entry.leadingRows.map((row) => ({ kind: "operation" as const, row })));
        output.push({ kind: "operation", row: entry.row });
      }
    } else {
      output.push({
        kind: "command_batch",
        batch: buildCommandBatch(pending, options.participantScope),
      });
    }
    pending = [];
  };

  for (const row of rows) {
    if (row.presentation === "note") {
      if (row.operationExecution?.actionId) {
        leadingRows.push(row);
      } else {
        flush();
        output.push(...leadingRows.map((leadingRow) => ({ kind: "operation" as const, row: leadingRow })));
        leadingRows = [];
        output.push({ kind: "operation", row });
      }
      continue;
    }
    if (!isCommandBatchEligible(row)) {
      flush();
      output.push(...leadingRows.map((leadingRow) => ({ kind: "operation" as const, row: leadingRow })));
      leadingRows = [];
      output.push({ kind: "operation", row });
      continue;
    }
    if (pending.length > 0 && !sameCommandScope(pending[0]?.row, row)) {
      flush();
    }
    pending.push({ row, leadingRows });
    leadingRows = [];
  }
  flush();
  output.push(...leadingRows.map((row) => ({ kind: "operation" as const, row })));
  return output;
}

export function isCommandBatchEligible(row: ConversationWorkCellRow): boolean {
  const command = row.commandExecution;
  return Boolean(
    command &&
    row.presentation === "shell" &&
    Boolean(command.runId) &&
    Boolean(command.toolCallId) &&
    command.actionType === "bash" &&
    command.risk === "low" &&
    command.status === "succeeded" &&
    command.exitCode === 0,
  );
}

function sameCommandScope(left: ConversationWorkCellRow | undefined, right: ConversationWorkCellRow): boolean {
  if (!left) {
    return false;
  }
  const leftCommand = left.commandExecution;
  const rightCommand = right.commandExecution;
  const leftOperation = left.operationExecution;
  const rightOperation = right.operationExecution;
  return Boolean(
    leftCommand &&
    rightCommand &&
    leftCommand.runId === rightCommand.runId &&
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

function buildCommandBatch(
  entries: readonly { readonly row: ConversationWorkCellRow; readonly leadingRows: readonly ConversationWorkCellRow[] }[],
  participantScope = "primary",
): ConversationCommandBatch {
  const commands = entries.map((entry) => toCommandBatchItem(entry.row, entry.leadingRows));
  const first = commands[0];
  if (!first) {
    throw new Error("Command batches require at least one command.");
  }
  const runId = first.row.commandExecution?.runId ?? "run";
  const operation = first.row.operationExecution;
  const durationValues = commands.map((command) => command.durationMs);
  const durationMs = durationValues.every((value): value is number => value !== undefined)
    ? durationValues.reduce((sum, value) => sum + value, 0)
    : undefined;
  return {
    id: `command-batch:${stableIdPart(participantScope)}:${stableIdPart(runId)}:${stableIdPart(first.actionId)}`,
    revisionKey: commands.map((command) => {
      const evidence = command.row.commandExecution;
      return `${command.actionId}:${command.status}:${evidence?.latestEventSeq ?? 0}`;
    }).join("|"),
    commandCount: commands.length,
    durationMs,
    defaultExpanded: false,
    actionIds: commands.map((command) => command.actionId),
    runId: operation?.runId ?? runId,
    attemptId: operation?.attemptId,
    turnRunRole: operation?.turnRunRole,
    participantId: operation?.participantId,
    workUnitId: operation?.workUnitId ?? first.row.commandExecution?.workUnitId,
    workflowStepId: operation?.workflowStepId ?? first.row.commandExecution?.workflowStepId,
    sourceRefs: uniqueSourceRefs(commands.flatMap((command) => command.row.operationExecution?.sourceRefs ?? [])),
    commands,
  };
}

function toCommandBatchItem(row: ConversationWorkCellRow, leadingRows: readonly ConversationWorkCellRow[] = []): ConversationCommandBatchItem {
  const command = row.commandExecution;
  if (!command) {
    throw new Error("Command batch rows require command execution metadata.");
  }
  return {
    id: `command:${command.actionId}`,
    actionId: command.actionId,
    row,
    commandText: command.commandText,
    status: command.status,
    exitCode: command.exitCode,
    durationMs: command.durationMs,
    outputTruncated: command.outputTruncated,
    stdoutArtifactId: command.stdoutArtifactId,
    stderrArtifactId: command.stderrArtifactId,
    leadingRows,
  };
}

function uniqueSourceRefs(refs: readonly ConversationOperationSourceRef[]): readonly ConversationOperationSourceRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function stableIdPart(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/gu, "-") || "unknown";
}
