import {
  DEFAULT_WORKSPACE_ID,
} from "./workspace-types.js";
import type {
  CreateMemoryObjectInput,
  MemoryCandidateSourceKind,
  MemoryReviewConfidence,
  MemoryReviewMode,
  MemoryReviewOutcome,
  MemoryReviewPolicy,
  MemoryReviewState,
  MemorySensitivity,
  MemorySourceRef,
  MemoryScopeType,
} from "./memory-types.js";

export interface ClassifyMemoryCandidateInput {
  readonly policy: MemoryReviewPolicy;
  readonly candidate: CreateMemoryObjectInput;
  readonly sourceKind: MemoryCandidateSourceKind;
  readonly sourceScopeType: MemoryScopeType;
  readonly targetScopeType: MemoryScopeType;
  readonly crossesScopeBoundary: boolean;
  readonly userExplicitRemember: boolean;
  readonly confidence: MemoryReviewConfidence;
}

export interface MemoryReviewClassification {
  readonly outcome: MemoryReviewOutcome;
  readonly mode: MemoryReviewMode;
  readonly reasonCode: string;
  readonly reason: string;
  readonly confidence: MemoryReviewConfidence;
  readonly requiresManualReview: boolean;
  readonly quarantineReason?: string;
  readonly targetReviewState: MemoryReviewState;
  readonly targetSensitivity: MemorySensitivity;
  readonly sourceRefs: readonly MemorySourceRef[];
}

export function createDefaultMemoryReviewPolicy(workspaceId = DEFAULT_WORKSPACE_ID, updatedAt = new Date(0).toISOString()): MemoryReviewPolicy {
  return {
    workspaceId,
    mode: "balanced",
    autoActiveSameScope: true,
    autoActiveUserExplicit: true,
    requireManualForWorkspace: true,
    requireManualForPersona: true,
    requireManualForCrossScope: true,
    quarantineSecretAdjacent: true,
    updatedAt,
  };
}

export function classifyMemoryCandidate(input: ClassifyMemoryCandidateInput): MemoryReviewClassification {
  const targetSensitivity = input.candidate.sensitivity ?? "normal";
  const sourceRefs = input.candidate.sourceRefs ?? [];
  if (input.policy.quarantineSecretAdjacent && targetSensitivity === "secret-adjacent") {
    return quarantine(input, "secret_adjacent", "Secret-adjacent memory candidates are quarantined before recall.", targetSensitivity, sourceRefs);
  }
  if (containsAuthorityChangingClaim(input.candidate)) {
    return quarantine(
      input,
      "authority_changing_claim",
      "Memory cannot grant tools, approvals, provider access, deploy access, credentials, or external-send authority.",
      targetSensitivity,
      sourceRefs,
    );
  }
  if (input.policy.requireManualForPersona && input.sourceKind === "persona_source") {
    return manualReview(input, "persona_update", "Persona/profile memory changes require manual review.", targetSensitivity, sourceRefs);
  }
  if (input.policy.requireManualForWorkspace && input.targetScopeType === "workspace" && !input.userExplicitRemember) {
    return manualReview(input, "workspace_memory", "Workspace shared memory requires review unless the user explicitly confirmed it.", targetSensitivity, sourceRefs);
  }
  if (input.policy.requireManualForCrossScope && input.crossesScopeBoundary) {
    return manualReview(input, "cross_scope_promotion", "Cross-scope memory promotion requires source inspection.", targetSensitivity, sourceRefs);
  }
  if (input.confidence === "low") {
    return manualReview(input, "low_confidence", "Low-confidence memory candidates require manual review.", targetSensitivity, sourceRefs);
  }
  if (input.userExplicitRemember && input.policy.autoActiveUserExplicit) {
    return autoActive(input, "explicit_remember", "The user explicitly asked Ling to remember this in the current scope.", targetSensitivity, sourceRefs);
  }
  if (input.policy.mode === "conservative") {
    return autoCandidate(input, "conservative_mode", "Conservative mode keeps extracted memory as a candidate.", targetSensitivity, sourceRefs);
  }
  if (input.policy.mode === "fast" && input.policy.autoActiveSameScope && !input.crossesScopeBoundary) {
    return autoActive(input, "fast_same_scope", "Fast mode allows same-scope non-sensitive memory to become active.", targetSensitivity, sourceRefs);
  }
  if (
    input.policy.mode === "balanced" &&
    input.policy.autoActiveSameScope &&
    !input.crossesScopeBoundary &&
    input.targetScopeType !== "workspace" &&
    input.sourceKind === "task_run_summary"
  ) {
    return autoActive(input, "balanced_task_run_summary", "Balanced mode allows low-risk same-scope task/run working memory to become active.", targetSensitivity, sourceRefs);
  }
  return autoCandidate(input, "default_candidate", "Memory candidate is stored for later review or policy-assisted promotion.", targetSensitivity, sourceRefs);
}

function autoActive(
  input: ClassifyMemoryCandidateInput,
  reasonCode: string,
  reason: string,
  targetSensitivity: MemorySensitivity,
  sourceRefs: readonly MemorySourceRef[],
): MemoryReviewClassification {
  return {
    outcome: "auto-active",
    mode: input.policy.mode,
    reasonCode,
    reason,
    confidence: input.confidence,
    requiresManualReview: false,
    targetReviewState: "active",
    targetSensitivity,
    sourceRefs,
  };
}

function autoCandidate(
  input: ClassifyMemoryCandidateInput,
  reasonCode: string,
  reason: string,
  targetSensitivity: MemorySensitivity,
  sourceRefs: readonly MemorySourceRef[],
): MemoryReviewClassification {
  return {
    outcome: "auto-candidate",
    mode: input.policy.mode,
    reasonCode,
    reason,
    confidence: input.confidence,
    requiresManualReview: false,
    targetReviewState: "candidate",
    targetSensitivity,
    sourceRefs,
  };
}

function manualReview(
  input: ClassifyMemoryCandidateInput,
  reasonCode: string,
  reason: string,
  targetSensitivity: MemorySensitivity,
  sourceRefs: readonly MemorySourceRef[],
): MemoryReviewClassification {
  return {
    outcome: "manual-review",
    mode: input.policy.mode,
    reasonCode,
    reason,
    confidence: input.confidence,
    requiresManualReview: true,
    targetReviewState: "candidate",
    targetSensitivity,
    sourceRefs,
  };
}

function quarantine(
  input: ClassifyMemoryCandidateInput,
  reasonCode: string,
  reason: string,
  targetSensitivity: MemorySensitivity,
  sourceRefs: readonly MemorySourceRef[],
): MemoryReviewClassification {
  return {
    outcome: "quarantine",
    mode: input.policy.mode,
    reasonCode,
    reason,
    confidence: input.confidence,
    requiresManualReview: true,
    quarantineReason: reason,
    targetReviewState: "disabled",
    targetSensitivity,
    sourceRefs,
  };
}

function containsAuthorityChangingClaim(candidate: CreateMemoryObjectInput): boolean {
  const text = [
    candidate.title,
    candidate.body,
    ...(candidate.tags ?? []),
    ...(candidate.sourceRefs ?? []).flatMap((ref) => [ref.type, ref.id, ref.label ?? "", ref.url ?? ""]),
  ].join(" ").toLowerCase();
  return (
    /\b(grant|bypass|auto[- ]?approve|pre[- ]?approve|allow)\b.{0,80}\b(tool|approval|permission|provider|deploy|credential|secret|external[- ]?send)\b/.test(text) ||
    /\b(tool|approval|permission|provider|deploy|credential|secret|external[- ]?send)\b.{0,80}\b(granted|bypassed|auto[- ]?approved|pre[- ]?approved|allowed)\b/.test(text)
  );
}
