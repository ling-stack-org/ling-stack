import type { GoalEvidenceRef } from "./run-types.js";

export interface GoalAcceptanceCriterion {
  readonly id: string;
  readonly description: string;
  readonly kind: "run_succeeded" | "workflow_succeeded" | "artifact";
  readonly contentSha256?: string;
  readonly evidenceId?: string;
}
export interface GoalAcceptanceEvidence {
  readonly criterionId: string;
  readonly evidence: GoalEvidenceRef;
}
export interface GoalSupervisionPolicy {
  readonly maxContinuations: number;
  readonly maxNoEvidenceContinuations: number;
  readonly autoContinue: boolean;
  readonly retryFailedRuns: boolean;
  readonly autoComplete: boolean;
  readonly maxTimeSeconds?: number;
}
export const defaultGoalSupervisionPolicy: GoalSupervisionPolicy = {
  maxContinuations: 3, maxNoEvidenceContinuations: 2, autoContinue: true, retryFailedRuns: false, autoComplete: false,
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("goal_spec_invalid");
  return value as Record<string, unknown>;
}
export function parseGoalSupervisionPolicy(value: unknown): GoalSupervisionPolicy {
  const input = record(value);
  const result = { ...defaultGoalSupervisionPolicy, ...input };
  if (Object.keys(input).some(key => !["maxContinuations", "maxNoEvidenceContinuations", "autoContinue", "retryFailedRuns", "autoComplete", "maxTimeSeconds"].includes(key))
    || !Number.isSafeInteger(result.maxContinuations) || result.maxContinuations < 1 || result.maxContinuations > 1000
    || !Number.isSafeInteger(result.maxNoEvidenceContinuations) || result.maxNoEvidenceContinuations < 1 || result.maxNoEvidenceContinuations > 10
    || typeof result.autoContinue !== "boolean" || typeof result.retryFailedRuns !== "boolean" || typeof result.autoComplete !== "boolean"
    || result.maxTimeSeconds !== undefined && (!Number.isSafeInteger(result.maxTimeSeconds) || result.maxTimeSeconds < 1 || result.maxTimeSeconds > 2_592_000)) throw new Error("goal_supervision_policy_invalid");
  return result;
}
export function parseGoalAcceptanceCriteria(value: unknown): GoalAcceptanceCriterion[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("goal_acceptance_criteria_invalid");
  const ids = new Set<string>();
  return value.map(item => {
    const criterion = record(item);
    if (Object.keys(criterion).some(key => !["id", "description", "kind", "contentSha256", "evidenceId"].includes(key))
      || typeof criterion.id !== "string" || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(criterion.id) || ids.has(criterion.id)
      || typeof criterion.description !== "string" || !criterion.description.trim() || criterion.description.length > 2000
      || !["run_succeeded", "workflow_succeeded", "artifact"].includes(String(criterion.kind))
      || criterion.evidenceId !== undefined && (typeof criterion.evidenceId !== "string" || !criterion.evidenceId.trim() || criterion.evidenceId.length > 200)
      || criterion.contentSha256 !== undefined && (criterion.kind !== "artifact" || typeof criterion.contentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(criterion.contentSha256)))
      throw new Error("goal_acceptance_criteria_invalid");
    ids.add(criterion.id);
    return { id: criterion.id, description: criterion.description.trim(), kind: criterion.kind as GoalAcceptanceCriterion["kind"],
      ...(criterion.evidenceId === undefined ? {} : { evidenceId: criterion.evidenceId as string }),
      ...(criterion.contentSha256 === undefined ? {} : { contentSha256: criterion.contentSha256 as string }) };
  });
}
export function parseGoalAcceptanceEvidence(value: unknown): GoalAcceptanceEvidence[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("goal_acceptance_evidence_invalid");
  const ids = new Set<string>();
  return value.map(item => {
    const entry = record(item), evidence = record(entry.evidence);
    if (Object.keys(entry).some(key => !["criterionId", "evidence"].includes(key))
      || Object.keys(evidence).some(key => !["kind", "id"].includes(key))
      || typeof entry.criterionId !== "string" || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(entry.criterionId) || ids.has(entry.criterionId)
      || !["run", "artifact", "workflow"].includes(String(evidence.kind)) || typeof evidence.id !== "string" || !evidence.id || evidence.id.length > 200) throw new Error("goal_acceptance_evidence_invalid");
    ids.add(entry.criterionId);
    return { criterionId: entry.criterionId, evidence: { kind: evidence.kind, id: evidence.id } as GoalEvidenceRef };
  });
}
