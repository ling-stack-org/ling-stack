import { createHash } from "node:crypto";
import { RUN_EVALUATION_GRADER_TYPES, RUN_EVALUATION_SEVERITIES, RUN_EVALUATION_VERDICTS,
  type RunEvaluationGradeV1, type RunEvaluationV1 } from "@ling-stack/contracts";
import { digestRunEvaluationGrade, digestRunEvaluationValue, runEvaluationIdempotencyKey,
  type RunArtifact, type RunEvaluationIdentityInput } from "@ling-stack/core";
import { buildShadowPromotionReport, type ShadowPromotionCase, type ShadowPromotionFrozenGrader } from "./promotion-report.js";
import { SHADOW_STORAGE_COST_FIELDS, type ShadowPromotionArtifactRef, type ShadowPromotionCorpusRow,
  type ShadowPromotionGradeRef, type ShadowPromotionStorageReadPorts, type ShadowStorageDiagnostic,
  type ShadowStorageDiagnosticCode, type StoredShadowPromotionRequest, type StoredShadowPromotionResult } from "./storage-projection-contract.js";
import { projectionArray, projectionDigest, projectionEvaluationKey, projectionField, projectionIdentity,
  projectionRecord, validateProjectionArtifactRef, validateProjectionJson, validateProjectionManifest,
  validateStoredProjectionRequest } from "./storage-projection-validation.js";

const IDENTITY_FIELDS = ["rootRunId", "runId", "suiteId", "suiteVersion", "suiteArtifactId", "suiteDigest",
  "caseId", "caseVersion", "caseArtifactId", "caseDigest", "baselineId", "baselineVersion",
  "baselineArtifactId", "baselineDigest", "candidateArtifactId", "candidateDigest"] as const;
const GRADE_FIELDS = ["schemaVersion", "id", "evaluationId", "graderType", "graderId", "graderVersion", "verdict",
  "score", "severity", "rationaleArtifactId", "rawOutputArtifactId", ...SHADOW_STORAGE_COST_FIELDS,
  "adjudicationStatus", "gradeDigest", "createdAt"] as const;
const GRADE_OPTIONAL = ["score", "severity", "rationaleArtifactId", "rawOutputArtifactId", ...SHADOW_STORAGE_COST_FIELDS, "adjudicationStatus"];
const OBSERVATION_FIELDS = ["schemaVersion", "kind", "evaluationId", "evaluationKey", "frozenGraderDigest",
  "invocationId", "providerRequestId", "verdict", "severity", ...SHADOW_STORAGE_COST_FIELDS] as const;

class ProjectionRefusal extends Error {
  constructor(readonly code: ShadowStorageDiagnosticCode) { super(code); }
}

/**
 * Projects pinned SQLite facts without selecting latest results or granting execution authority.
 * Claimed human/invocation identities remain diagnostics until independent trusted producers exist.
 * Any missing/corrupt member refuses the whole corpus; request shape errors throw before any read.
 * Artifact caps apply after the existing Core getter parses one row, not to that SQL parse itself.
 */
export function projectStoredShadowPromotionReport(
  ports: ShadowPromotionStorageReadPorts,
  request: StoredShadowPromotionRequest,
): StoredShadowPromotionResult {
  validateStoredProjectionRequest(request);
  const diagnostics: ShadowStorageDiagnostic[] = [];
  const costs = emptyCosts();
  const artifacts = new Map<string, RunArtifact>();
  const runs = new Map<string, string>();
  const evaluations = new Map<string, string>();
  let artifactBytes = 0, currentEvaluation: string | undefined;
  let modelCount = 0, humanCount = 0, observationCount = 0;
  const observationIds = new Set<string>(), invocationIds = new Set<string>(), requestIds = new Set<string>();
  const cases: ShadowPromotionCase[] = [];

  function checked<T>(code: ShadowStorageDiagnosticCode, read: () => T): T {
    try { return read(); } catch (error) {
      if (error instanceof ProjectionRefusal) throw error;
      throw new ProjectionRefusal(code);
    }
  }
  function diagnostic(code: ShadowStorageDiagnosticCode): void {
    diagnostics.push({ code, ...(currentEvaluation ? { evaluationId: currentEvaluation } : {}) });
  }
  function artifact(ref: ShadowPromotionArtifactRef, owners: readonly string[]): RunArtifact {
    let value = artifacts.get(ref.artifactId);
    if (!value) {
      value = checked("read_failed", () => ports.getArtifact(ref.artifactId));
      if (!value) refuse("artifact_missing");
      validateArtifact(value, ref, owners);
      artifactBytes += Buffer.byteLength(JSON.stringify(value.sealedPayload), "utf8");
      if (artifactBytes > 16 * 1_048_576) refuse("artifact_invalid");
      artifacts.set(ref.artifactId, value);
    } else validateArtifact(value, ref, owners);
    return value;
  }
  function readRun(id: string) {
    const run = checked("read_failed", () => ports.getRun(id));
    if (!run) refuse("lineage_invalid");
    const snapshot = checked("lineage_invalid", () => runSnapshot(run));
    if (run.id !== id) refuse("lineage_invalid");
    const previous = runs.get(id);
    if (previous && previous !== snapshot) refuse("snapshot_changed");
    runs.set(id, snapshot);
    return run;
  }
  function verifyLineage(evaluation: RunEvaluationV1): void {
    let run = readRun(evaluation.runId);
    if (!["succeeded", "failed", "cancelled"].includes(run.status)) refuse("lineage_invalid");
    const visited = new Set<string>();
    for (let depth = 0; ; depth += 1) {
      if (depth > 100 || visited.has(run.id)) refuse("lineage_invalid");
      visited.add(run.id);
      if (!run.parentRunId) {
        if (run.id !== request.rootRunId || run.id !== evaluation.rootRunId) refuse("lineage_invalid");
        return;
      }
      run = readRun(run.parentRunId);
    }
  }
  function readGrade(ref: ShadowPromotionGradeRef, evaluation: RunEvaluationV1, type: "model" | "human", frozen: ShadowPromotionFrozenGrader): RunEvaluationGradeV1 {
    const grade = checked("read_failed", () => ports.getRunEvaluationGrade(ref.gradeId));
    if (!grade) refuse("grade_missing");
    checked("grade_invalid", () => {
      const record = projectionRecord(grade, GRADE_FIELDS, GRADE_OPTIONAL);
      for (const key of ["id", "evaluationId", "graderId", "graderVersion", "createdAt"]) projectionIdentity(record[key]);
      for (const key of ["rationaleArtifactId", "rawOutputArtifactId", "adjudicationStatus"])
        if (record[key] !== undefined) projectionIdentity(record[key]);
      if (record.schemaVersion !== 1 || !(RUN_EVALUATION_GRADER_TYPES as readonly unknown[]).includes(record.graderType)) refuse("grade_invalid");
      decision(record); money(record);
      if (record.score !== undefined && (typeof record.score !== "number" || !Number.isFinite(record.score) || record.score < 0 || record.score > 1)) refuse("grade_invalid");
      projectionDigest(record.gradeDigest);
      if (grade.id !== ref.gradeId || grade.evaluationId !== evaluation.id || grade.graderType !== type
        || grade.gradeDigest !== ref.gradeDigest || digestRunEvaluationGrade(evaluation.id, grade) !== ref.gradeDigest
        || (type === "model" && (grade.graderId !== frozen.graderId || grade.graderVersion !== frozen.graderVersion))) refuse("grade_invalid");
    });
    for (const [field, pin] of [["rawOutputArtifactId", ref.rawOutputArtifact], ["rationaleArtifactId", ref.rationaleArtifact]] as const) {
      if ((grade[field] === undefined) !== (pin === undefined) || (pin && grade[field] !== pin.artifactId)) refuse("grade_invalid");
      if (pin) artifact(pin, [evaluation.runId, evaluation.rootRunId]);
    }
    return grade;
  }
  function observations(ref: ShadowPromotionGradeRef, evaluation: RunEvaluationV1, frozenDigest: string): void {
    if (!ref.rawOutputArtifact) { diagnostic("observation_manifest_missing"); return; }
    const payload = artifact(ref.rawOutputArtifact, [evaluation.runId, evaluation.rootRunId]).sealedPayload;
    checked("observation_invalid", () => {
      const batch = projectionRecord(payload, ["schemaVersion", "kind", "evaluationId", "evaluationKey", "frozenGraderDigest", "observations"]);
      if (batch.schemaVersion !== 1 || batch.kind !== "shadow_model_observations"
        || batch.evaluationId !== evaluation.id || batch.evaluationKey !== evaluation.idempotencyKey
        || batch.frozenGraderDigest !== frozenDigest) refuse("observation_invalid");
      const refs = projectionArray(batch.observations, 64);
      if (observationCount + refs.length > 10_000) refuse("observation_invalid");
      for (const value of refs) {
        validateProjectionArtifactRef(value);
        if (observationIds.has(value.artifactId)) refuse("observation_invalid");
        observationIds.add(value.artifactId);
        const item = projectionRecord(artifact(value, [evaluation.runId]).sealedPayload, OBSERVATION_FIELDS,
          ["severity", ...SHADOW_STORAGE_COST_FIELDS]);
        if (item.schemaVersion !== 1 || item.kind !== "shadow_model_observation" || item.evaluationId !== evaluation.id
          || item.evaluationKey !== evaluation.idempotencyKey || item.frozenGraderDigest !== frozenDigest) refuse("observation_invalid");
        projectionIdentity(item.invocationId); projectionIdentity(item.providerRequestId);
        if (invocationIds.has(item.invocationId) || requestIds.has(item.providerRequestId)) refuse("observation_invalid");
        invocationIds.add(item.invocationId); requestIds.add(item.providerRequestId);
        decision(item, "observation_invalid"); money(item, "observation_invalid");
        observationCount += 1;
        for (const key of SHADOW_STORAGE_COST_FIELDS) {
          const value = item[key] as number | undefined;
          const summary = costs[key];
          if (value === undefined) summary.missingCount += 1;
          else {
            const sum = (summary.sum ?? 0) + value;
            if (!Number.isSafeInteger(sum)) refuse("observation_invalid");
            summary.sum = sum; summary.knownCount += 1;
          }
        }
      }
    });
    diagnostic("invocation_source_unavailable");
  }

  try {
    const root = readRun(request.rootRunId);
    if (root.parentRunId) refuse("lineage_invalid");
    const payload = artifact(request.manifestArtifact, [request.rootRunId]).sealedPayload;
    checked("manifest_invalid", () => validateProjectionManifest(payload));
    // Assertion outside the generic checked callback preserves its validated type.
    validateProjectionManifest(payload);
    if (payload.rootRunId !== request.rootRunId) refuse("manifest_invalid");
    const frozen = checked("frozen_invalid", () => {
      const value = artifact(payload.frozenGraderArtifact, [request.rootRunId]).sealedPayload as ShadowPromotionFrozenGrader;
      buildShadowPromotionReport({ schemaVersion: 1, evidenceKind: "projected-evidence", frozenGrader: value,
        frozenGraderDigest: payload.frozenGraderDigest, cases: [] });
      return value;
    });
    for (const row of payload.cases) {
      currentEvaluation = row.evaluationId;
      const evaluation = checked("read_failed", () => ports.getRunEvaluation(row.evaluationId));
      if (!evaluation) refuse("evaluation_missing");
      if (checked("evaluation_invalid", () => projectionField(evaluation, "state")) !== "completed"
        || !checked("evaluation_invalid", () => projectionField(evaluation, "completedAt"))) refuse("evaluation_incomplete");
      checked("evaluation_invalid", () => validateEvaluation(evaluation, row, request.rootRunId));
      evaluations.set(evaluation.id, evaluationSnapshot(evaluation));
      verifyLineage(evaluation);
      for (const prefix of ["suite", "case", "baseline", "candidate"] as const)
        artifact({ artifactId: evaluation[`${prefix}ArtifactId`], contentSha256: evaluation[`${prefix}Digest`] },
          prefix === "candidate" ? [evaluation.runId] : [evaluation.runId, evaluation.rootRunId]);
      if (row.modelGrade) {
        readGrade(row.modelGrade, evaluation, "model", frozen); modelCount += 1;
        observations(row.modelGrade, evaluation, payload.frozenGraderDigest);
      } else diagnostic("model_grade_missing");
      if (row.humanGrade) {
        readGrade(row.humanGrade, evaluation, "human", frozen); humanCount += 1;
        diagnostic("human_source_unavailable");
      } else diagnostic("human_grade_missing");
      cases.push({ suiteId: evaluation.suiteId, suiteVersion: evaluation.suiteVersion, suiteDigest: evaluation.suiteDigest,
        caseId: evaluation.caseId, caseVersion: evaluation.caseVersion, caseDigest: evaluation.caseDigest,
        baselineId: evaluation.baselineId, baselineVersion: evaluation.baselineVersion, baselineDigest: evaluation.baselineDigest,
        candidateDigest: evaluation.candidateDigest, evaluationId: evaluation.id, evaluationState: "completed", observations: [] });
    }
    currentEvaluation = undefined;
    // No SQLite snapshot transaction is claimed. Reject drift observed across this bounded read.
    for (const [id, snapshot] of runs) {
      const value = checked("read_failed", () => ports.getRun(id));
      if (!value || checked("snapshot_changed", () => runSnapshot(value)) !== snapshot) refuse("snapshot_changed");
    }
    for (const [id, snapshot] of evaluations) {
      const value = checked("read_failed", () => ports.getRunEvaluation(id));
      if (!value || checked("snapshot_changed", () => evaluationSnapshot(value)) !== snapshot) refuse("snapshot_changed");
    }
    for (const [id, previous] of artifacts) {
      const value = checked("read_failed", () => ports.getArtifact(id));
      if (!value) refuse("snapshot_changed");
      validateArtifact(value, { artifactId: id, contentSha256: previous.contentSha256! }, [previous.runId!]);
    }
    const report = checked("evaluation_invalid", () => buildShadowPromotionReport({ schemaVersion: 1, evidenceKind: "projected-evidence",
      frozenGrader: frozen, frozenGraderDigest: payload.frozenGraderDigest, cases }));
    return { authority: "report-only", assessment: "not_assessed", enforcementAuthorized: false, report,
      manifestDigest: request.manifestArtifact.contentSha256, verifiedCaseCount: cases.length,
      declaredModelGradeCount: modelCount, declaredHumanGradeCount: humanCount, declaredObservationCount: observationCount,
      declaredCosts: costs, diagnostics };
  } catch (error) {
    diagnostic(error instanceof ProjectionRefusal ? error.code : "read_failed");
    return { authority: "report-only", assessment: "not_assessed", enforcementAuthorized: false, report: null,
      manifestDigest: request.manifestArtifact.contentSha256, verifiedCaseCount: 0,
      declaredModelGradeCount: 0, declaredHumanGradeCount: 0, declaredObservationCount: 0,
      declaredCosts: emptyCosts(), diagnostics };
  }
}

function validateEvaluation(evaluation: RunEvaluationV1, row: ShadowPromotionCorpusRow, rootRunId: string): void {
  if (projectionField(evaluation, "schemaVersion") !== 1 || projectionField(evaluation, "id") !== row.evaluationId
    || projectionField(evaluation, "rootRunId") !== rootRunId) refuse("evaluation_invalid");
  const identity = Object.fromEntries(IDENTITY_FIELDS.map((key) => {
    const value = projectionField(evaluation, key);
    key.endsWith("Digest") ? projectionDigest(value) : projectionIdentity(value);
    return [key, value];
  })) as unknown as RunEvaluationIdentityInput;
  projectionEvaluationKey(evaluation.idempotencyKey);
  if (runEvaluationIdempotencyKey(identity) !== row.evaluationKey || evaluation.idempotencyKey !== row.evaluationKey) refuse("evaluation_invalid");
}

function validateArtifact(value: RunArtifact, ref: ShadowPromotionArtifactRef, owners: readonly string[]): void {
  try {
    if (projectionField(value, "id") !== ref.artifactId || !owners.includes(projectionField(value, "runId") as string)
      || optionalField(value, "mediaJobId") !== undefined || optionalField(value, "externalWorkId") !== undefined
      || projectionField(value, "contentSha256") !== ref.contentSha256) refuse("artifact_invalid");
    const payload = projectionField(value, "sealedPayload"); validateProjectionJson(payload);
    const json = JSON.stringify(payload);
    if (Buffer.byteLength(json, "utf8") > 1_048_576
      || createHash("sha256").update(json, "utf8").digest("hex") !== ref.contentSha256) refuse("artifact_invalid");
  } catch { refuse("artifact_invalid"); }
}

function runSnapshot(run: ReturnType<ShadowPromotionStorageReadPorts["getRun"]>): string {
  if (!run) refuse("lineage_invalid");
  const id = projectionField(run, "id"), status = projectionField(run, "status");
  projectionIdentity(id); projectionIdentity(status);
  const parent = optionalField(run, "parentRunId");
  if (parent !== undefined) projectionIdentity(parent);
  return digestRunEvaluationValue({ id, status, parentRunId: parent ?? null });
}

function evaluationSnapshot(evaluation: RunEvaluationV1): string {
  return digestRunEvaluationValue({ identity: Object.fromEntries(IDENTITY_FIELDS.map((key) => [key, projectionField(evaluation, key)])),
    id: projectionField(evaluation, "id"), state: projectionField(evaluation, "state"),
    revision: projectionField(evaluation, "revision"), completedAt: projectionField(evaluation, "completedAt"),
    idempotencyKey: projectionField(evaluation, "idempotencyKey") });
}

function decision(value: Record<string, unknown>, code: ShadowStorageDiagnosticCode = "grade_invalid"): void {
  if (!(RUN_EVALUATION_VERDICTS as readonly unknown[]).includes(value.verdict)
    || (value.severity !== undefined && !(RUN_EVALUATION_SEVERITIES as readonly unknown[]).includes(value.severity))) refuse(code);
}

function money(value: Record<string, unknown>, code: ShadowStorageDiagnosticCode = "grade_invalid"): void {
  for (const field of SHADOW_STORAGE_COST_FIELDS) {
    const cost = value[field];
    if (cost !== undefined && (typeof cost !== "number" || !Number.isSafeInteger(cost) || cost < 0)) refuse(code);
  }
}

function optionalField(value: object, field: string): unknown {
  if (Object.hasOwn(value, field)) return projectionField(value, field);
  if (field in value) refuse("manifest_invalid");
  return undefined;
}

function emptyCosts() {
  return Object.fromEntries(SHADOW_STORAGE_COST_FIELDS.map((field) => [field, { knownCount: 0, missingCount: 0, sum: null as number | null }])) as
    Record<(typeof SHADOW_STORAGE_COST_FIELDS)[number], { knownCount: number; missingCount: number; sum: number | null }>;
}
function refuse(code: ShadowStorageDiagnosticCode): never { throw new ProjectionRefusal(code); }
