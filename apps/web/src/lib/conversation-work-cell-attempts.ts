import type { ExecutionAction, RunArtifact, RunSession } from "../types.js";

export interface ConversationLatestAttemptEvidence {
  readonly runs: readonly [RunSession];
  readonly artifacts: readonly RunArtifact[];
  readonly actions: readonly ExecutionAction[];
}

/**
 * Projects evidence for the current attempt while preserving the full run
 * lineage separately on the work-cell model for diagnostics.
 */
export function projectConversationLatestAttemptEvidence(input: {
  readonly threadId: string;
  readonly latestRun: RunSession;
  readonly attemptCount: number;
  readonly artifactsByRun: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly executionActions: readonly ExecutionAction[];
}): ConversationLatestAttemptEvidence {
  const latestRunIds = new Set([input.latestRun.id]);
  return {
    runs: [input.latestRun],
    artifacts: [input.latestRun.id].flatMap((runId) => input.artifactsByRun[runId] ?? []),
    actions: input.executionActions.filter((action) =>
      action.runId
        ? latestRunIds.has(action.runId)
        // An action without run identity cannot be safely attributed when a
        // retry lineage exists. Fail closed instead of letting legacy,
        // thread-scoped evidence leak across attempts.
        : input.attemptCount === 1 && action.threadId === input.threadId,
    ),
  };
}
