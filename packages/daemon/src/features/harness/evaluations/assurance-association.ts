import { createHash } from "node:crypto";
import { RUN_EVALUATION_GRADER_TYPES, RUN_EVALUATION_SEVERITIES, RUN_EVALUATION_STATES,
  RUN_EVALUATION_VERDICTS, type RunEvaluationGradeV1, type RunEvaluationV1 } from "@ling-stack/contracts";
import { digestRunEvaluationGrade, digestRunEvaluationValue, runEvaluationIdempotencyKey,
  type RunArtifact, type RunEvaluationIdentityInput } from "@ling-stack/core";
import { isPrivateHostRecoveryArtifact } from "../../runs/public-artifacts.js";
import { ASSOCIATION_IDENTITY_FIELDS, type AssociationCode, type AssuranceEvaluationAssociationRequest,
  type AssuranceEvaluationAssociationResult, type AssuranceEvaluationReadPorts, type GradePin,
  type HostAssociationSource } from "./assurance-association-contract.js";
import { AssociationRefusal, refuseAssociation, validateAssociationHostSource, validateAssociationRequest,
  validateFrozenAssociationInputs } from "./assurance-association-validation.js";
import { projectionDigest, projectionField, projectionIdentity, projectionRecord,
  validateProjectionJson } from "./storage-projection-validation.js";

const COST_FIELDS = ["costInputTokens", "costOutputTokens", "costAmountMicros", "latencyMs"] as const;
const GRADE_OPTIONAL = ["score", "severity", "rationaleArtifactId", "rawOutputArtifactId", ...COST_FIELDS, "adjudicationStatus"];
const GRADE_FIELDS = ["schemaVersion", "id", "evaluationId", "graderType", "graderId", "graderVersion", "verdict",
  ...GRADE_OPTIONAL, "gradeDigest", "createdAt"];
const ARTIFACT_OPTIONAL = ["runId", "mediaJobId", "externalWorkId", "title", "contentType", "sizeBytes",
  "sealedPayload", "sealedPayloadState", "contentSha256"];
const ARTIFACT_FIELDS = ["id", "type", "path", "createdAt", ...ARTIFACT_OPTIONAL];
const EVALUATION_OPTIONAL = ["claimOwner", "claimToken", "claimExpiresAt", "nextAttemptAt", "failureCode",
  "failureDetailArtifactId", "completedAt"];
const EVALUATION_FIELDS = ["schemaVersion", "id", "idempotencyKey", "state", "revision", "createdAt", "updatedAt",
  ...ASSOCIATION_IDENTITY_FIELDS, ...EVALUATION_OPTIONAL];

/** Exact, bounded reads of one evaluation; matching Run facts never attest Attempt provenance. */
export function projectAssuranceEvaluationAssociation(
  ports: AssuranceEvaluationReadPorts,
  input: AssuranceEvaluationAssociationRequest,
): AssuranceEvaluationAssociationResult {
  let observationId: string | null = null, mappingDigest: string | null = null;
  let summary: AssuranceEvaluationAssociationResult["evaluation"] = null;
  try {
    validateAssociationRequest(input);
    const request = structuredClone(input);
    observationId = request.observation.observationId;
    mappingDigest = request.mappingDigest;
    const identity = request.mapping.evaluationIdentity;
    if (identity.runId !== request.source.execution.runId) refuseAssociation("association.lineage_mismatch");
    const frozen = validateFrozenAssociationInputs(ports, request);
    const source = currentSource(ports, identity.runId);
    compareSource(request.source, source);
    const sourceSnapshot = sourceFingerprint(source);
    const runs = new Map<string, string>(), artifacts = new Map<string, string>(), grades = new Map<string, string>();
    let artifactBytes = 0;

    const evaluation = read("association.read_failed", () => ports.getRunEvaluation(request.evaluationId));
    if (!evaluation) refuseAssociation("association.evaluation_missing");
    const evaluationSnapshot = checked("association.evaluation_identity_mismatch", () => {
      projectionRecord(evaluation, EVALUATION_FIELDS, EVALUATION_OPTIONAL);
      for (const key of ["id", "idempotencyKey", "state", "createdAt", "updatedAt"] as const) projectionIdentity(evaluation[key]);
      if (evaluation.schemaVersion !== 1 || evaluation.id !== request.evaluationId
        || !RUN_EVALUATION_STATES.includes(evaluation.state) || !Number.isSafeInteger(evaluation.revision) || evaluation.revision < 0
        || !timestamp(evaluation.createdAt) || !timestamp(evaluation.updatedAt)
        || (evaluation.completedAt !== undefined && !timestamp(evaluation.completedAt))) refuseAssociation("association.evaluation_identity_mismatch");
      const actual = Object.fromEntries(ASSOCIATION_IDENTITY_FIELDS.map(key => [key, projectionField(evaluation, key)])) as unknown as RunEvaluationIdentityInput;
      if (ASSOCIATION_IDENTITY_FIELDS.some(key => actual[key] !== identity[key])
        || evaluation.idempotencyKey !== request.evaluationKey
        || runEvaluationIdempotencyKey(actual) !== request.evaluationKey) refuseAssociation("association.evaluation_identity_mismatch");
      return rowFingerprint(evaluation, EVALUATION_FIELDS, EVALUATION_OPTIONAL);
    });

    let runId: string | undefined = evaluation.runId;
    for (let depth = 0; runId !== undefined; depth += 1) {
      if (depth > 100 || runs.has(runId)) refuseAssociation("association.lineage_mismatch");
      const run = read("association.read_failed", () => ports.getRun(runId!));
      if (!run) refuseAssociation("association.lineage_mismatch");
      const snapshot = runFingerprint(run);
      if (run.id !== runId || (depth === 0 && !["succeeded", "failed", "cancelled"].includes(run.status))) refuseAssociation("association.lineage_mismatch");
      runs.set(runId, snapshot);
      if (run.parentRunId === undefined && run.id !== identity.rootRunId) refuseAssociation("association.lineage_mismatch");
      runId = run.parentRunId;
    }
    summary = { id: evaluation.id, runId: evaluation.runId, rootRunId: evaluation.rootRunId,
      state: evaluation.state, revision: evaluation.revision, evaluationKey: evaluation.idempotencyKey };
    if (evaluation.state !== "completed") return associationFailure("association.evaluation_incomplete", observationId, mappingDigest, summary);
    if (!evaluation.completedAt) refuseAssociation("association.evaluation_identity_mismatch");

    function artifact(id: string, digest: string, owners: readonly string[]): RunArtifact {
      const value = read("association.read_failed", () => ports.getArtifact(id));
      if (!value) refuseAssociation("association.artifact_missing");
      checked("association.artifact_invalid", () => projectionRecord(value, ARTIFACT_FIELDS, ARTIFACT_OPTIONAL));
      if (value.sealedPayloadState === "pruned" || value.sealedPayload === undefined) refuseAssociation("association.artifact_missing");
      const snapshot = checked("association.artifact_invalid", () => {
        projectionRecord(value, ARTIFACT_FIELDS, ARTIFACT_OPTIONAL);
        if (value.id !== id || !value.runId || !owners.includes(value.runId) || value.mediaJobId !== undefined
          || value.externalWorkId !== undefined || isPrivateHostRecoveryArtifact(value) || value.contentSha256 !== digest) refuseAssociation("association.artifact_invalid");
        projectionDigest(value.contentSha256);
        validateProjectionJson(value.sealedPayload);
        const bytes = JSON.stringify(value.sealedPayload);
        if (Buffer.byteLength(bytes, "utf8") > 1_048_576 || sha256(bytes) !== digest) refuseAssociation("association.artifact_invalid");
        if (!artifacts.has(id)) artifactBytes += Buffer.byteLength(bytes, "utf8");
        if (artifactBytes > 16 * 1_048_576) refuseAssociation("association.artifact_invalid");
        return digestRunEvaluationValue({ id: value.id, runId: value.runId, contentSha256: value.contentSha256,
          contentType: value.contentType ?? null, sealedPayload: value.sealedPayload });
      });
      if (artifacts.has(id) && artifacts.get(id) !== snapshot) refuseAssociation("association.snapshot_changed");
      artifacts.set(id, snapshot);
      return value;
    }

    for (const [prefix, definition] of [["suite", frozen.suite], ["case", frozen.rule], ["baseline", frozen.expected]] as const) {
      const id = identity[`${prefix}ArtifactId`], digest = identity[`${prefix}Digest`];
      if (sha256(JSON.stringify(definition)) !== digest) refuseAssociation("association.mapping_mismatch");
      artifact(id, digest, [identity.runId, identity.rootRunId]);
    }
    const candidate = request.mapping.candidate;
    if (candidate.artifactId !== identity.candidateArtifactId || candidate.contentSha256 !== identity.candidateDigest
      || !source.artifacts.some(pin => pin.role === candidate.role && pin.artifactId === candidate.artifactId
        && pin.contentSha256 === candidate.contentSha256)) refuseAssociation("association.mapping_mismatch");
    for (const pin of source.artifacts) artifact(pin.artifactId, pin.contentSha256, [identity.runId]);
    artifact(candidate.artifactId, candidate.contentSha256, [identity.runId]);

    const selected: AssuranceEvaluationAssociationResult["grades"][number][] = [];
    for (const pin of request.gradePins) {
      const grade = read("association.read_failed", () => ports.getRunEvaluationGrade(pin.gradeId));
      if (!grade) refuseAssociation("association.grade_missing");
      grades.set(pin.gradeId, gradeFingerprint(grade, pin, evaluation.id));
      for (const field of ["rawOutputArtifact", "rationaleArtifact"] as const) {
        const ref = pin[field];
        if (ref) artifact(ref.artifactId, ref.contentSha256, [identity.runId, identity.rootRunId]);
      }
      selected.push({ gradeId: grade.id, gradeDigest: grade.gradeDigest, graderType: grade.graderType,
        graderId: grade.graderId, graderVersion: grade.graderVersion, verdict: grade.verdict,
        score: grade.score ?? null, severity: grade.severity ?? null });
    }

    checked("association.snapshot_changed", () => {
      if (sourceFingerprint(currentSource(ports, identity.runId)) !== sourceSnapshot) refuseAssociation("association.snapshot_changed");
      for (const [id, snapshot] of runs) {
        const run = ports.getRun(id);
        if (!run || runFingerprint(run) !== snapshot) refuseAssociation("association.snapshot_changed");
      }
      const currentEvaluation = ports.getRunEvaluation(request.evaluationId);
      if (!currentEvaluation || rowFingerprint(currentEvaluation, EVALUATION_FIELDS, EVALUATION_OPTIONAL) !== evaluationSnapshot)
        refuseAssociation("association.snapshot_changed");
      for (const pin of request.gradePins) {
        const grade = ports.getRunEvaluationGrade(pin.gradeId);
        if (!grade || gradeFingerprint(grade, pin, evaluation.id) !== grades.get(pin.gradeId)) refuseAssociation("association.snapshot_changed");
      }
      for (const pin of source.artifacts) artifact(pin.artifactId, pin.contentSha256, [identity.runId]);
      for (const prefix of ["suite", "case", "baseline"] as const) artifact(identity[`${prefix}ArtifactId`], identity[`${prefix}Digest`], [identity.runId, identity.rootRunId]);
      for (const pin of request.gradePins) for (const ref of [pin.rawOutputArtifact, pin.rationaleArtifact]) {
        if (ref) artifact(ref.artifactId, ref.contentSha256, [identity.runId, identity.rootRunId]);
      }
    });
    return { ...associationFailure("association.attempt_binding_unavailable", observationId, mappingDigest, summary),
      status: "matched", binding: { run: "matched", frozenInputs: "matched", candidateArtifact: "matched" }, grades: selected,
      diagnostics: [{ code: "association.attempt_binding_unavailable" }, ...(request.gradePins.length ? [] : [{ code: "association.grades_not_selected" as const }])] };
  } catch (error) {
    return associationFailure(error instanceof AssociationRefusal ? error.code : "association.read_failed", observationId, mappingDigest, summary);
  }
}

/** Construct a sanitized refusal; identity arguments must already have passed validation. */
export function associationFailure(
  code: AssociationCode,
  observationId: string | null = null,
  mappingDigest: string | null = null,
  evaluation: AssuranceEvaluationAssociationResult["evaluation"] = null,
): AssuranceEvaluationAssociationResult {
  const unavailable: readonly AssociationCode[] = ["association.workspace_uninitialized", "association.read_failed", "association.host_source_unavailable",
    "association.frozen_input_missing", "association.evaluation_missing", "association.artifact_missing", "association.grade_missing"];
  return { schemaVersion: 1, kind: "assurance_evaluation_association", authority: "report-only", assessment: "not_assessed",
    enforcementAuthorized: false, status: code === "association.evaluation_incomplete" ? "incomplete" : unavailable.includes(code) ? "unavailable" : "invalid",
    observationId, mappingDigest, evaluation, binding: { run: "unavailable", frozenInputs: "unavailable", candidateArtifact: "unavailable" },
    attemptBinding: { status: "unavailable", code: "association.attempt_binding_unavailable" }, grades: [],
    diagnostics: [{ code }, ...(code === "association.attempt_binding_unavailable" ? [] : [{ code: "association.attempt_binding_unavailable" as const }])],
    limitations: ["read_only", "no_execution_authority", "attempt_artifact_binding_unavailable", "mapping_declaration_only",
      "invocation_source_unavailable", "human_source_unavailable", "host_binary_source_unavailable"] };
}

function currentSource(ports: AssuranceEvaluationReadPorts, runId: string): HostAssociationSource {
  const value = read("association.host_source_unavailable", () => ports.getCurrentHostSource(runId));
  if (!value) refuseAssociation("association.host_source_unavailable");
  checked("association.host_source_unavailable", () => validateAssociationHostSource(value));
  return structuredClone(value);
}

function compareSource(expected: HostAssociationSource, actual: HostAssociationSource): void {
  for (const key of ["runId", "workUnitId"] as const)
    if (expected.execution[key] !== actual.execution[key]) refuseAssociation("association.lineage_mismatch");
  for (const key of ["attemptId", "runtimeInstanceId", "fencingToken"] as const)
    if (expected.execution[key] !== actual.execution[key]) refuseAssociation("association.stale_attempt");
  if (sourceFingerprint(expected) !== sourceFingerprint(actual)) refuseAssociation("association.snapshot_changed");
}

function sourceFingerprint(source: HostAssociationSource): string {
  return digestRunEvaluationValue({ ...source, artifacts: [...source.artifacts].sort((a, b) => a.artifactId.localeCompare(b.artifactId)) });
}

function runFingerprint(run: NonNullable<ReturnType<AssuranceEvaluationReadPorts["getRun"]>>): string {
  return checked("association.lineage_mismatch", () => {
    projectionRecord(run, ["id", "status", "parentRunId"], ["parentRunId"]);
    projectionIdentity(run.id); projectionIdentity(run.status);
    if (run.parentRunId !== undefined) projectionIdentity(run.parentRunId);
    return digestRunEvaluationValue({ id: run.id, status: run.status, parentRunId: run.parentRunId ?? null });
  });
}

function gradeFingerprint(grade: RunEvaluationGradeV1, pin: GradePin, evaluationId: string): string {
  return checked("association.grade_invalid", () => {
    projectionRecord(grade, GRADE_FIELDS, GRADE_OPTIONAL);
    for (const key of ["id", "evaluationId", "graderId", "graderVersion", "createdAt"] as const) projectionIdentity(grade[key]);
    for (const key of ["rationaleArtifactId", "rawOutputArtifactId", "adjudicationStatus"] as const)
      if (grade[key] !== undefined) projectionIdentity(grade[key]);
    if (grade.schemaVersion !== 1 || grade.id !== pin.gradeId || grade.evaluationId !== evaluationId
      || !RUN_EVALUATION_GRADER_TYPES.includes(grade.graderType) || grade.graderType !== pin.graderType
      || grade.graderId !== pin.graderId || grade.graderVersion !== pin.graderVersion
      || !RUN_EVALUATION_VERDICTS.includes(grade.verdict) || !timestamp(grade.createdAt)
      || (grade.severity !== undefined && !RUN_EVALUATION_SEVERITIES.includes(grade.severity))
      || (grade.score !== undefined && (!Number.isFinite(grade.score) || grade.score < 0 || grade.score > 1))) refuseAssociation("association.grade_invalid");
    for (const field of COST_FIELDS) if (grade[field] !== undefined && (!Number.isSafeInteger(grade[field]) || grade[field]! < 0)) refuseAssociation("association.grade_invalid");
    projectionDigest(grade.gradeDigest);
    if (grade.gradeDigest !== pin.gradeDigest || digestRunEvaluationGrade(evaluationId, grade) !== pin.gradeDigest) refuseAssociation("association.grade_invalid");
    for (const [field, ref] of [["rawOutputArtifactId", pin.rawOutputArtifact], ["rationaleArtifactId", pin.rationaleArtifact]] as const)
      if ((grade[field] === undefined) !== (ref === undefined) || (ref && grade[field] !== ref.artifactId)) refuseAssociation("association.grade_invalid");
    return rowFingerprint(grade, GRADE_FIELDS, GRADE_OPTIONAL);
  });
}

function rowFingerprint(value: object, fields: readonly string[], optional: readonly string[]): string {
  const row = projectionRecord(value, fields, optional);
  const normalized = Object.fromEntries(fields.map(key => [key, row[key] ?? null]));
  validateProjectionJson(normalized);
  return digestRunEvaluationValue(normalized);
}

function checked<T>(code: AssociationCode, fn: () => T): T {
  try { return fn(); } catch { refuseAssociation(code); }
}
function read<T>(code: AssociationCode, fn: () => T): T { return checked(code, fn); }
function timestamp(value: string): boolean { const date = new Date(value); return Number.isFinite(date.getTime()) && date.toISOString() === value; }
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
