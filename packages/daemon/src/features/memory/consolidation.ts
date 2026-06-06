import {
  classifyMemoryCandidate,
  type MemoryCandidateSourceKind,
  type MemoryConsolidationJob,
  type MemoryObject,
  type MemoryReviewDecision,
  type MemoryReviewOutcome,
  type MemoryReviewState,
  type RunStore,
} from "@ling-stack/core";
import type { ParsedMemoryConsolidationJobRequest } from "./schemas.js";

export interface MemoryConsolidationJobResult {
  readonly job: MemoryConsolidationJob;
  readonly candidates: readonly MemoryObject[];
  readonly decisions: readonly MemoryReviewDecision[];
}

export function runMemoryConsolidationJob(
  store: RunStore,
  input: ParsedMemoryConsolidationJobRequest,
  now: string,
): MemoryConsolidationJobResult {
  const sourceRefs = input.candidate.sourceRefs ?? [];
  const queuedJob = store.createMemoryConsolidationJob(
    {
      kind: input.kind,
      sourceRefs,
      status: "queued",
    },
    now,
  );
  const runningJob = store.updateMemoryConsolidationJob(queuedJob.id, { status: "running" }, now) ?? queuedJob;

  try {
    const policy = store.getMemoryReviewPolicy();
    const sourceScopeType = input.sourceScopeType ?? input.candidate.scopeType;
    const classification = classifyMemoryCandidate({
      policy,
      candidate: {
        ...input.candidate,
        sourceRefs,
      },
      sourceKind: input.sourceKind ?? sourceKindForConsolidationJob(input.kind),
      sourceScopeType,
      targetScopeType: input.candidate.scopeType,
      crossesScopeBoundary: input.crossesScopeBoundary ?? sourceScopeType !== input.candidate.scopeType,
      userExplicitRemember: input.userExplicitRemember ?? false,
      confidence: input.confidence ?? "medium",
    });
    const targetReviewState = reviewStateForConsolidationJob(classification.outcome);
    const memory = store.createMemoryObject(
      {
        ...input.candidate,
        sourceRefs,
        reviewState: targetReviewState,
        enabled: targetReviewState === "candidate",
        sensitivity: classification.targetSensitivity,
        createdBy: input.candidate.createdBy ?? "memory-consolidation-job",
      },
      now,
    );
    const decision = store.recordMemoryReviewDecision(
      {
        memoryId: memory.id,
        outcome: reviewOutcomeForConsolidationJob(classification.outcome),
        mode: classification.mode,
        reasonCode: classification.outcome === "auto-active" ? "consolidation_candidate_only" : classification.reasonCode,
        reason: classification.outcome === "auto-active"
          ? `${classification.reason} Consolidation jobs store candidates first and never silently activate memory.`
          : classification.reason,
        confidence: classification.confidence,
        requiresManualReview: classification.outcome === "manual-review" || classification.outcome === "quarantine",
        quarantineReason: classification.quarantineReason,
        targetReviewState,
        targetSensitivity: classification.targetSensitivity,
        sourceRefs,
        decidedBy: "policy",
      },
      now,
    );
    const succeededJob = store.updateMemoryConsolidationJob(
      runningJob.id,
      {
        status: "succeeded",
        createdCandidateIds: [memory.id],
      },
      now,
    ) ?? runningJob;
    return {
      job: succeededJob,
      candidates: [memory],
      decisions: [decision],
    };
  } catch (error) {
    store.updateMemoryConsolidationJob(
      runningJob.id,
      {
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      },
      now,
    );
    throw error;
  }
}

function sourceKindForConsolidationJob(kind: ParsedMemoryConsolidationJobRequest["kind"]): MemoryCandidateSourceKind {
  switch (kind) {
    case "private_chat_summary":
      return "private_chat";
    case "channel_decision_summary":
      return "channel_decision";
    case "task_run_lesson":
      return "task_run_summary";
    case "workspace_consolidation":
      return "reflection_job";
  }
}

function reviewStateForConsolidationJob(outcome: MemoryReviewOutcome): MemoryReviewState {
  return outcome === "quarantine" ? "disabled" : "candidate";
}

function reviewOutcomeForConsolidationJob(outcome: MemoryReviewOutcome): MemoryReviewOutcome {
  return outcome === "auto-active" ? "auto-candidate" : outcome;
}
