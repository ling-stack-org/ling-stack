import { createHash } from "node:crypto";
import type { RunEvaluationGradeV1, RunEvaluationV1 } from "@ling-stack/contracts";
import { digestRunEvaluationGrade, digestRunEvaluationValue, runEvaluationIdempotencyKey,
  type RunArtifact, type RunEvaluationIdentityInput, type RunSession } from "@ling-stack/core";
import type { AssuranceEvaluationAssociationRequest, AssuranceEvaluationReadPorts, FrozenInputKey,
  HostAssociationSource } from "../../src/features/harness/evaluations/assurance-association-contract.js";

export const associationNow = "2026-11-11T00:00:00.000Z";
export const associationSha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const reference = (path: string, content: Uint8Array) => ({ path, sha256: associationSha256(content), mediaType: "application/json" });

export function assuranceAssociationFixture() {
  const runId = "run-association", rootRunId = "root-association", sourceCommit = "b".repeat(40);
  const taskIdentity = { suiteId: "suite-association", suiteVersion: "1", taskId: "T01", taskVersion: "1" };
  const rule = { graderId: "rule-association", graderVersion: "1", rule: { type: "contains", value: "expected" } };
  const expected = { expected: "expected" };
  const ruleBytes = bytes(rule), expectedBytes = bytes(expected);
  const profileBytes = bytes({ schemaVersion: 1, profileId: "profile-association", profileVersion: "1" });
  const lockBytes = Buffer.from("lockfileVersion: '9.0'\n");
  const taskBytes = bytes({ schemaVersion: 1, taskId: taskIdentity.taskId, taskVersion: taskIdentity.taskVersion,
    source: { commit: sourceCommit, lockSha256: associationSha256(lockBytes) },
    ruleCase: reference("cases/T01/rule.json", ruleBytes), expected: reference("cases/T01/expected.json", expectedBytes),
    validationProfile: { id: "profile-association", version: "1", artifact: reference("cases/T01/profile.json", profileBytes) } });
  const suite = { schemaVersion: 1, suiteId: taskIdentity.suiteId, suiteVersion: taskIdentity.suiteVersion,
    tasks: [{ taskId: taskIdentity.taskId, taskVersion: taskIdentity.taskVersion, task: reference("cases/T01/task.json", taskBytes) }] };
  const bundle: Record<FrozenInputKey, Uint8Array> = { suiteBytes: bytes(suite), taskBytes, ruleBytes, expectedBytes, profileBytes, lockBytes };
  const inputDigests = Object.fromEntries(Object.entries(bundle).map(([key, value]) => [key, associationSha256(value)])) as Record<FrozenInputKey, string>;
  const artifacts = new Map<string, RunArtifact>();
  function artifact(id: string, payload: unknown, owner = rootRunId): RunArtifact {
    const value = { id, runId: owner, type: "json" as const, path: `${id}.json`, createdAt: associationNow,
      sealedPayload: payload, contentSha256: associationSha256(JSON.stringify(payload)) };
    artifacts.set(id, value);
    return value;
  }
  const suiteArtifact = artifact("suite-artifact", suite), caseArtifact = artifact("case-artifact", rule);
  const baseline = artifact("baseline-artifact", expected), candidate = artifact("candidate-artifact", { actual: "PRIVATE_CANDIDATE_BODY" }, runId);
  const identity: RunEvaluationIdentityInput = {
    rootRunId, runId, suiteId: taskIdentity.suiteId, suiteVersion: taskIdentity.suiteVersion,
    suiteArtifactId: suiteArtifact.id, suiteDigest: suiteArtifact.contentSha256!,
    caseId: "evaluation-case", caseVersion: "2", caseArtifactId: caseArtifact.id, caseDigest: caseArtifact.contentSha256!,
    baselineId: "evaluation-baseline", baselineVersion: "3", baselineArtifactId: baseline.id, baselineDigest: baseline.contentSha256!,
    candidateArtifactId: candidate.id, candidateDigest: candidate.contentSha256!,
  };
  const evaluation: RunEvaluationV1 = { ...identity, schemaVersion: 1, id: "evaluation-association",
    idempotencyKey: runEvaluationIdempotencyKey(identity), state: "completed", revision: 3,
    createdAt: associationNow, updatedAt: associationNow, completedAt: associationNow,
    claimOwner: undefined, claimToken: undefined, claimExpiresAt: undefined, nextAttemptAt: undefined, failureCode: undefined };
  const gradeInput = { graderType: "rule" as const, graderId: rule.graderId, graderVersion: rule.graderVersion, verdict: "pass" as const, score: 1 };
  const grade: RunEvaluationGradeV1 = { ...gradeInput, schemaVersion: 1, id: "grade-association", evaluationId: evaluation.id,
    gradeDigest: digestRunEvaluationGrade(evaluation.id, gradeInput), createdAt: associationNow, severity: undefined,
    rawOutputArtifactId: undefined, rationaleArtifactId: undefined, costInputTokens: undefined, costOutputTokens: undefined,
    costAmountMicros: undefined, latencyMs: undefined, adjudicationStatus: undefined };
  const host: HostAssociationSource = {
    comparison: { model: "fixture", reasoning: "none", executionStrategy: "fixture", node: process.versions.node,
      platform: process.platform, arch: process.arch },
    execution: { runId, workUnitId: "unit-association", attemptId: "attempt-association", runtimeInstanceId: "runtime-association",
      fencingToken: "fence-association", runStatus: "succeeded", workUnitStatus: "succeeded", attemptStatus: "succeeded",
      claimStatus: "terminal_retained", effectStatus: "none" },
    snapshots: { run: { revision: 1, sha256: associationSha256("run") }, workUnit: { revision: 1, sha256: associationSha256("unit") },
      attempt: { revision: 1, sha256: associationSha256("attempt") } },
    artifacts: [{ role: "json-0", artifactId: candidate.id, contentSha256: candidate.contentSha256! }],
  };
  const mapping = { schemaVersion: 1 as const, kind: "assurance_evaluation_mapping" as const,
    definitionEncoding: "json_parse_stringify_v1" as const, taskIdentity, observationCaseId: "case-correct", sourceCommit,
    inputDigests, evaluationIdentity: identity, candidate: host.artifacts[0] };
  const request: AssuranceEvaluationAssociationRequest = structuredClone({ schemaVersion: 1,
    observation: { observationId: "observation-association", invocationId: "invocation-association", caseId: mapping.observationCaseId,
      taskIdentity, sourceCommit, inputDigests, comparison: host.comparison, evidenceKind: "fixture_replay", assessment: "not_assessed" },
    source: host, evaluationId: evaluation.id, evaluationKey: evaluation.idempotencyKey, mapping,
    mappingDigest: digestRunEvaluationValue(mapping), gradePins: [{ gradeId: grade.id, gradeDigest: grade.gradeDigest,
      graderType: grade.graderType, graderId: grade.graderId, graderVersion: grade.graderVersion }] });
  const runs = new Map<string, Pick<RunSession, "id" | "status" | "parentRunId">>([
    [runId, { id: runId, status: "succeeded", parentRunId: rootRunId }], [rootRunId, { id: rootRunId, status: "succeeded" }],
  ]);
  const ports: AssuranceEvaluationReadPorts = Object.freeze({
    getRun: (id: string) => runs.get(id), getRunEvaluation: (id: string) => id === evaluation.id ? evaluation : undefined,
    getRunEvaluationGrade: (id: string) => id === grade.id ? grade : undefined,
    getArtifact: (id: string) => artifacts.get(id), getCurrentHostSource: () => host,
    getFrozenInput: (key: FrozenInputKey) => bundle[key],
  });
  return { request, ports, bundle, host, identity, evaluation, grade, artifacts, runs, artifact,
    repin() { Object.assign(request, { mappingDigest: digestRunEvaluationValue(request.mapping) }); },
    repinGrade() {
      const gradeDigest = digestRunEvaluationGrade(evaluation.id, grade);
      Object.assign(grade, { gradeDigest }); Object.assign(request.gradePins[0], { gradeDigest });
    } };
}
