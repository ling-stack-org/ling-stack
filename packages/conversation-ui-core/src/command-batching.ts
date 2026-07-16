import type {
  ConversationCommandBatch,
  ConversationCommandBatchItem,
  ConversationWorkCellItem,
  ConversationWorkCellRow,
} from "./work-cell-view-model.js";

const MINIMUM_COMMAND_BATCH_SIZE = 3;

export function projectConversationCommandBatches(
  rows: readonly ConversationWorkCellRow[],
  options: { readonly participantScope?: string } = {},
): readonly ConversationWorkCellItem[] {
  const output: ConversationWorkCellItem[] = [];
  let pending: ConversationWorkCellRow[] = [];

  const flush = (): void => {
    if (pending.length === 0) {
      return;
    }
    if (pending.length < MINIMUM_COMMAND_BATCH_SIZE) {
      output.push(...pending.map((row) => ({ kind: "operation" as const, row })));
    } else {
      output.push({
        kind: "command_batch",
        batch: buildCommandBatch(pending, options.participantScope),
      });
    }
    pending = [];
  };

  for (const row of rows) {
    if (!isCommandBatchEligible(row)) {
      flush();
      output.push({ kind: "operation", row });
      continue;
    }
    if (pending.length > 0 && !sameCommandScope(pending[0], row)) {
      flush();
    }
    pending.push(row);
  }
  flush();
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

function sameCommandScope(left: ConversationWorkCellRow, right: ConversationWorkCellRow): boolean {
  const leftCommand = left.commandExecution;
  const rightCommand = right.commandExecution;
  return Boolean(
    leftCommand &&
    rightCommand &&
    leftCommand.runId === rightCommand.runId &&
    leftCommand.workUnitId === rightCommand.workUnitId &&
    leftCommand.workflowStepId === rightCommand.workflowStepId,
  );
}

function buildCommandBatch(
  rows: readonly ConversationWorkCellRow[],
  participantScope = "primary",
): ConversationCommandBatch {
  const commands = rows.map(toCommandBatchItem);
  const first = commands[0];
  if (!first) {
    throw new Error("Command batches require at least one command.");
  }
  const runId = first.row.commandExecution?.runId ?? "run";
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
    commands,
  };
}

function toCommandBatchItem(row: ConversationWorkCellRow): ConversationCommandBatchItem {
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
  };
}

function stableIdPart(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/gu, "-") || "unknown";
}
