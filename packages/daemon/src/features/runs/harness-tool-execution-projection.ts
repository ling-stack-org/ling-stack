import type {
  ExecutionActionSourceRef,
  ExecutionActionStatus,
  HarnessToolExecutionStore,
} from "@ling-stack/core";
import type { HarnessToolExecutionV1 } from "@ling-stack/contracts";

interface OptionalHarnessToolExecutionStore {
  readonly listHarnessToolExecutions?: HarnessToolExecutionStore["listHarnessToolExecutions"];
}

export interface HarnessToolExecutionActionProjection {
  readonly execution: HarnessToolExecutionV1;
  readonly status: ExecutionActionStatus;
  readonly resultArtifactIds: readonly string[];
  readonly sourceRefs: readonly ExecutionActionSourceRef[];
  readonly summary?: string;
}

export function listHarnessToolExecutionsForProjection(
  store: object,
  runId: string,
): readonly HarnessToolExecutionV1[] {
  const list = (store as OptionalHarnessToolExecutionStore).listHarnessToolExecutions;
  return typeof list === "function" ? list.call(store, runId) : [];
}

/**
 * Fold the authoritative ToolExecution row into the rebuildable action view.
 * Narrow test doubles may omit the new store facet; the production SQLite
 * RunStore always supplies it.
 */
export function deriveHarnessToolExecutionActionProjection(input: {
  readonly store: object;
  readonly runId: string;
  readonly toolCallId: string;
  readonly attemptId?: string;
}): HarnessToolExecutionActionProjection | undefined {
  const candidates = listHarnessToolExecutionsForProjection(input.store, input.runId)
    .filter((execution) => execution.toolCallId === input.toolCallId);
  const exactAttempt = input.attemptId
    ? candidates.filter((execution) => execution.attemptId === input.attemptId)
    : [];
  const execution = [...(exactAttempt.length > 0 ? exactAttempt : candidates)]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)
      || right.createdAt.localeCompare(left.createdAt)
      || right.id.localeCompare(left.id))[0];
  if (!execution) return undefined;
  return {
    execution,
    status: executionActionStatusFromHarnessToolExecution(execution),
    resultArtifactIds: execution.evidenceArtifactIds,
    sourceRefs: [
      { kind: "harness_tool_execution", id: execution.id, label: execution.state },
      ...(execution.supersedesExecutionId
        ? [{ kind: "harness_tool_execution" as const, id: execution.supersedesExecutionId, label: "superseded" }]
        : []),
    ],
    summary: executionSummary(execution),
  };
}

export function executionActionStatusFromHarnessToolExecution(
  execution: HarnessToolExecutionV1,
): ExecutionActionStatus {
  switch (execution.state) {
    case "proposed":
    case "prepared":
      return "proposed";
    case "approval_pending":
      return "waiting_for_approval";
    case "approved":
      return "approved";
    case "claimed":
    case "executing":
    case "committing_evidence":
      return "executing";
    case "succeeded":
      return "succeeded";
    case "denied":
      return "denied";
    case "cancelled":
      return "cancelled";
    case "failed":
    case "superseded":
    case "unknown_outcome":
      return "failed";
  }
  return "failed";
}

function executionSummary(execution: HarnessToolExecutionV1): string | undefined {
  if (execution.state === "unknown_outcome") {
    return "Command outcome could not be confirmed. Automatic retry is blocked until the Host evidence is reconciled.";
  }
  if (execution.state === "superseded") {
    return "This pre-effect tool execution was replaced by a successor Attempt.";
  }
  if (execution.failureCode === "tool.stale_attempt") {
    return "Tool execution was rejected because its Attempt fence is stale.";
  }
  return undefined;
}
