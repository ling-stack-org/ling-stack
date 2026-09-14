import { createHash } from "node:crypto";
import type { RunEvaluationV1 } from "@ling-stack/contracts";
import {
  digestRunEvaluationValue,
  gradeDeterministicRunEvaluation,
  type CreateRunEvaluationGradeInput,
  type RunArtifact,
  type RunStore,
} from "@ling-stack/core";

export type RuleEvaluationStore = Pick<RunStore, "getArtifact" | "createArtifact">;

export class RunEvaluationArtifactError extends Error {
  readonly code = "evaluation.result_invalid" as const;
}

/** Reads only immutable SQLite-sealed JSON and returns a deterministic rule grade. */
export function executeDeterministicRuleEvaluation(input: {
  readonly store: RuleEvaluationStore;
  readonly evaluation: RunEvaluationV1;
  readonly now: string;
}): CreateRunEvaluationGradeInput {
  const suite = requireArtifact(input.store, input.evaluation.suiteArtifactId, input.evaluation.suiteDigest);
  const testCase = requireArtifact(input.store, input.evaluation.caseArtifactId, input.evaluation.caseDigest);
  const baseline = requireArtifact(input.store, input.evaluation.baselineArtifactId, input.evaluation.baselineDigest);
  const candidate = requireArtifact(input.store, input.evaluation.candidateArtifactId, input.evaluation.candidateDigest);
  // The suite body is part of the immutable lineage even though the case owns the
  // executable rule definition. Reading it here catches missing or corrupted lineage.
  void suite.sealedPayload;
  const result = gradeDeterministicRunEvaluation({
    caseDefinition: testCase.sealedPayload,
    baseline: baseline.sealedPayload,
    candidate: candidate.sealedPayload,
  });
  const rationalePayload = {
    schemaVersion: 1,
    evaluationId: input.evaluation.id,
    suiteId: input.evaluation.suiteId,
    suiteVersion: input.evaluation.suiteVersion,
    caseId: input.evaluation.caseId,
    caseVersion: input.evaluation.caseVersion,
    baselineId: input.evaluation.baselineId,
    baselineVersion: input.evaluation.baselineVersion,
    graderId: result.graderId,
    graderVersion: result.graderVersion,
    verdict: result.verdict,
    score: result.score,
    rationale: result.rationale,
  };
  const rationaleDigest = digestRunEvaluationValue(rationalePayload);
  const rationaleArtifactId = `artifact_evaluation_rationale_${rationaleDigest.slice(0, 32)}`;
  const existing = input.store.getArtifact(rationaleArtifactId);
  if (existing) {
    if (existing.runId !== input.evaluation.runId
      || existing.sealedPayload === undefined
      || digestRunEvaluationValue(existing.sealedPayload) !== rationaleDigest) {
      throw new RunEvaluationArtifactError("Evaluation rationale artifact identity conflict.");
    }
  } else {
    input.store.createArtifact({
      id: rationaleArtifactId,
      runId: input.evaluation.runId,
      type: "json",
      path: `.ling-stack/evaluations/${input.evaluation.id}/rule-grade-${rationaleDigest}.json`,
      title: `Rule evaluation ${input.evaluation.caseId}`,
      contentType: "application/json",
      sealedPayload: rationalePayload,
      createdAt: input.now,
    });
  }
  return {
    graderType: "rule",
    graderId: result.graderId,
    graderVersion: result.graderVersion,
    verdict: result.verdict,
    score: result.score,
    ...(result.severity ? { severity: result.severity } : {}),
    rationaleArtifactId,
  };
}

function requireArtifact(
  store: RuleEvaluationStore,
  artifactId: string,
  expectedDigest: string,
): RunArtifact & { readonly sealedPayload: unknown } {
  const artifact = store.getArtifact(artifactId);
  if (!artifact || artifact.sealedPayload === undefined || artifact.contentSha256 !== expectedDigest
    || artifactPayloadDigest(artifact.sealedPayload) !== expectedDigest) {
    throw new RunEvaluationArtifactError(`Evaluation artifact is missing or changed: ${artifactId}`);
  }
  return artifact as RunArtifact & { readonly sealedPayload: unknown };
}

function artifactPayloadDigest(value: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return undefined;
    return createHash("sha256").update(serialized, "utf8").digest("hex");
  } catch {
    return undefined;
  }
}
