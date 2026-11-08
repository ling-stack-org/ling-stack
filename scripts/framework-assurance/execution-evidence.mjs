import { digest, exactObject, identifier, parseJson, requireCondition, sha256 } from "./manifest.mjs";
import { parseObservation } from "./evidence.mjs";

const INPUT_DIGEST_KEYS = ["suiteBytes", "taskBytes", "ruleBytes", "expectedBytes", "profileBytes", "lockBytes"];
const COMPARISON_KEYS = ["model", "reasoning", "executionStrategy", "node", "platform", "arch"];
const RUN_STATUSES = new Set(["queued", "running", "waiting_for_input", "waiting_for_approval", "succeeded", "failed", "cancelled"]);
const WORK_UNIT_STATUSES = new Set(["queued", "claimed", "running", "waiting_for_approval", "waiting_for_input", "cancelling", "succeeded", "failed", "cancelled", "stale"]);
const ATTEMPT_STATUSES = new Set(["created", "started", "waiting_for_approval", "cancelling", "yielded", "succeeded", "failed", "cancelled", "lost"]);
const TERMINAL_ATTEMPT_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const CLAIM_STATUSES = new Set(["unclaimed", "held", "expired", "terminal_retained"]);
const EFFECT_STATUSES = new Set(["none", "confirmed", "unknown"]);

/**
 * Parse the public portion of a frozen execution observation. This fixture
 * format contains identities and byte digests only; it deliberately has no
 * task input, claim token, resume handle or artifact body.
 */
export function parseExecutionEvidence(value) {
  exactObject(value, ["schemaVersion", "evidenceId", "invocationId", "caseId", "taskIdentity", "sourceCommit",
    "inputDigests", "comparison", "execution", "snapshots", "artifacts", "observedAt", "limitations"], "execution evidence");
  requireCondition(value.schemaVersion === 1, "invalid_manifest", "Unsupported execution evidence schema.");
  for (const key of ["evidenceId", "invocationId", "caseId"]) identifier(value[key], key);
  exactObject(value.taskIdentity, ["suiteId", "suiteVersion", "taskId", "taskVersion"], "execution task identity");
  Object.values(value.taskIdentity).forEach(item => identifier(item, "execution task identity"));
  requireCondition(typeof value.sourceCommit === "string" && /^[a-f0-9]{40}$/.test(value.sourceCommit),
    "invalid_manifest", "Execution evidence source commit must be frozen.");
  exactObject(value.inputDigests, INPUT_DIGEST_KEYS, "execution input digests");
  Object.values(value.inputDigests).forEach(item => digest(item, "execution input digest"));
  exactObject(value.comparison, COMPARISON_KEYS, "execution comparison environment");
  Object.values(value.comparison).forEach(item => identifier(item, "execution comparison value"));

  exactObject(value.execution, ["runId", "workUnitId", "attemptId", "runtimeInstanceId", "fencingToken",
    "runStatus", "workUnitStatus", "attemptStatus", "claimStatus", "effectStatus"], "execution lineage");
  for (const key of ["runId", "workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"]) identifier(value.execution[key], key);
  requireCondition(RUN_STATUSES.has(value.execution.runStatus), "invalid_manifest", "Execution Run status is invalid.");
  requireCondition(WORK_UNIT_STATUSES.has(value.execution.workUnitStatus), "invalid_manifest", "Execution WorkUnit status is invalid.");
  requireCondition(ATTEMPT_STATUSES.has(value.execution.attemptStatus), "invalid_manifest", "Execution Attempt status is invalid.");
  requireCondition(CLAIM_STATUSES.has(value.execution.claimStatus), "invalid_manifest", "Execution claim status is invalid.");
  requireCondition(EFFECT_STATUSES.has(value.execution.effectStatus), "invalid_manifest", "Execution effect status is invalid.");

  exactObject(value.snapshots, ["run", "workUnit", "attempt"], "execution snapshots");
  for (const [name, snapshot] of Object.entries(value.snapshots)) {
    exactObject(snapshot, ["revision", "sha256"], `${name} snapshot`);
    requireCondition(Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0, "invalid_manifest", `${name} snapshot revision is invalid.`);
    digest(snapshot.sha256, `${name} snapshot digest`);
  }
  requireCondition(Array.isArray(value.artifacts) && value.artifacts.length >= 1 && value.artifacts.length <= 100,
    "invalid_manifest", "Execution artifact pins are required.");
  const artifactIds = new Set();
  const artifactRoles = new Set();
  for (const artifact of value.artifacts) {
    exactObject(artifact, ["role", "artifactId", "contentSha256"], "execution artifact pin");
    identifier(artifact.role, "execution artifact role"); identifier(artifact.artifactId, "execution artifact id");
    digest(artifact.contentSha256, "execution artifact digest");
    requireCondition(!artifactIds.has(artifact.artifactId) && !artifactRoles.has(artifact.role),
      "invalid_manifest", "Execution artifact pins must have unique IDs and roles.");
    artifactIds.add(artifact.artifactId); artifactRoles.add(artifact.role);
  }
  requireCondition(isCanonicalTimestamp(value.observedAt), "invalid_manifest", "Execution observedAt must be an ISO-8601 timestamp.");
  requireCondition(Array.isArray(value.limitations) && value.limitations.length >= 1 && value.limitations.length <= 100,
    "invalid_manifest", "Execution evidence limitations are required.");
  value.limitations.forEach(item => identifier(item, "execution limitation"));
  return value;
}

/**
 * Parse the trusted side of an execution comparison. A live Host integration
 * must build this value from independently read Run/Attempt/WorkUnit and
 * artifact records instead of deriving it from candidate evidence.
 */
export function parseExecutionEvidenceBinding(value) {
  exactObject(value, ["schemaVersion", "taskIdentity", "sourceCommit", "inputDigests", "comparison", "execution", "snapshots", "artifacts"], "trusted execution binding");
  requireCondition(value.schemaVersion === 1, "invalid_manifest", "Unsupported trusted execution binding schema.");
  exactObject(value.taskIdentity, ["suiteId", "suiteVersion", "taskId", "taskVersion"], "trusted task identity");
  Object.values(value.taskIdentity).forEach(item => identifier(item, "trusted task identity"));
  requireCondition(typeof value.sourceCommit === "string" && /^[a-f0-9]{40}$/.test(value.sourceCommit),
    "invalid_manifest", "Trusted source commit must be frozen.");
  exactObject(value.inputDigests, INPUT_DIGEST_KEYS, "trusted input digests");
  Object.values(value.inputDigests).forEach(item => digest(item, "trusted input digest"));
  exactObject(value.comparison, COMPARISON_KEYS, "trusted comparison environment");
  Object.values(value.comparison).forEach(item => identifier(item, "trusted comparison value"));
  exactObject(value.execution, ["runId", "workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"], "trusted execution lineage");
  for (const key of ["runId", "workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"]) identifier(value.execution[key], `trusted ${key}`);
  exactObject(value.snapshots, ["run", "workUnit", "attempt"], "trusted execution snapshots");
  for (const [name, snapshot] of Object.entries(value.snapshots)) {
    exactObject(snapshot, ["revision", "sha256"], `trusted ${name} snapshot`);
    requireCondition(Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0, "invalid_manifest", `Trusted ${name} snapshot revision is invalid.`);
    digest(snapshot.sha256, `trusted ${name} snapshot digest`);
  }
  requireCondition(Array.isArray(value.artifacts) && value.artifacts.length >= 1 && value.artifacts.length <= 100,
    "invalid_manifest", "Trusted execution artifact pins are required.");
  const artifactIds = new Set();
  const artifactRoles = new Set();
  for (const artifact of value.artifacts) {
    exactObject(artifact, ["role", "artifactId", "contentSha256"], "trusted execution artifact pin");
    identifier(artifact.role, "trusted execution artifact role"); identifier(artifact.artifactId, "trusted execution artifact id");
    digest(artifact.contentSha256, "trusted execution artifact digest");
    requireCondition(!artifactIds.has(artifact.artifactId) && !artifactRoles.has(artifact.role),
      "invalid_manifest", "Trusted execution artifact pins must have unique IDs and roles.");
    artifactIds.add(artifact.artifactId); artifactRoles.add(artifact.role);
  }
  return structuredClone({
    schemaVersion: 1,
    taskIdentity: value.taskIdentity,
    sourceCommit: value.sourceCommit,
    inputDigests: value.inputDigests,
    comparison: value.comparison,
    execution: value.execution,
    snapshots: value.snapshots,
    artifacts: value.artifacts,
  });
}

/**
 * Adapt a verified fixture into the existing offline observation contract.
 * It never dispatches a Run, reads a Store, or treats fixture evidence as a
 * successful real task; the returned observation remains `not_assessed`.
 */
export function adaptExecutionEvidence(value, { binding, stopReason = "fixture_execution_evidence" } = {}) {
  const evidence = parseExecutionEvidence(value);
  const trusted = parseExecutionEvidenceBinding(binding);
  assertBinding(evidence, trusted);
  requireCondition(evidence.execution.claimStatus === "terminal_retained", "evidence_claim_lost", "Execution evidence does not retain a terminal claim.");
  requireCondition(evidence.execution.effectStatus !== "unknown", "evidence_effect_unknown", "Execution evidence has unknown side effects.");
  requireCondition(TERMINAL_ATTEMPT_STATUSES.has(evidence.execution.attemptStatus),
    evidence.execution.attemptStatus === "lost" ? "evidence_attempt_lost" : "evidence_execution_incomplete",
    "Execution evidence does not identify a completed terminal Attempt.");

  const executionStatus = evidence.execution.attemptStatus === "cancelled" ? "cancelled"
    : evidence.execution.attemptStatus === "failed" ? "failed" : "completed";
  const observation = parseObservation({
    schemaVersion: 1,
    observationId: sha256(`${evidence.invocationId}:${evidence.caseId}:${evidence.taskIdentity.taskId}:${evidence.taskIdentity.taskVersion}`),
    invocationId: evidence.invocationId,
    caseId: evidence.caseId,
    taskIdentity: evidence.taskIdentity,
    sourceCommit: evidence.sourceCommit,
    inputDigests: evidence.inputDigests,
    comparison: evidence.comparison,
    evidenceKind: "fixture_replay",
    executionStatus,
    assessment: "not_assessed",
    stopReason,
    effectStatus: evidence.execution.effectStatus,
    timings: { queueMs: null, executionMs: null, validationMs: null, gradingMs: null },
    usage: [],
    artifacts: evidence.artifacts.map(item => ({ role: item.role, sha256: item.contentSha256 })),
    limitations: [...new Set([...evidence.limitations, "fixture_replay_only", "no_live_run_acceptance"])],
  });
  return {
    observation,
    lineage: {
      runId: evidence.execution.runId,
      workUnitId: evidence.execution.workUnitId,
      attemptId: evidence.execution.attemptId,
      runtimeInstanceId: evidence.execution.runtimeInstanceId,
    },
    observedAt: evidence.observedAt,
  };
}

function assertBinding(evidence, expected) {
  const binding = expected;
  for (const key of ["suiteId", "suiteVersion", "taskId", "taskVersion"]) {
    requireCondition(evidence.taskIdentity[key] === binding.taskIdentity[key], "evidence_input_mismatch", "Execution evidence task identity does not match the trusted input.");
  }
  requireCondition(evidence.sourceCommit === binding.sourceCommit, "evidence_input_mismatch", "Execution evidence source commit does not match the trusted input.");
  for (const key of [...INPUT_DIGEST_KEYS]) requireCondition(evidence.inputDigests[key] === binding.inputDigests[key], "evidence_input_mismatch", "Execution evidence input digest does not match the trusted input.");
  for (const key of [...COMPARISON_KEYS]) requireCondition(evidence.comparison[key] === binding.comparison[key], "evidence_input_mismatch", "Execution evidence comparison environment does not match the trusted input.");
  for (const key of ["runId", "workUnitId"]) {
    requireCondition(evidence.execution[key] === binding.execution[key], "evidence_lineage_mismatch", "Execution evidence is bound to another Run or WorkUnit.");
  }
  for (const key of ["attemptId", "runtimeInstanceId", "fencingToken"]) {
    requireCondition(evidence.execution[key] === binding.execution[key], "evidence_stale_attempt", "Execution evidence belongs to an old Attempt or fence.");
  }
  for (const key of ["run", "workUnit", "attempt"]) {
    requireCondition(evidence.snapshots[key].revision === binding.snapshots[key].revision
      && evidence.snapshots[key].sha256 === binding.snapshots[key].sha256,
    "evidence_snapshot_changed", "Execution input snapshot changed during evidence collection.");
  }
  const actual = new Map(evidence.artifacts.map(item => [item.artifactId, item]));
  for (const expectedArtifact of binding.artifacts) {
    const artifact = actual.get(expectedArtifact.artifactId);
    requireCondition(artifact, "evidence_artifact_missing", "A required execution artifact is missing.");
    requireCondition(artifact.role === expectedArtifact.role && artifact.contentSha256 === expectedArtifact.contentSha256,
      "evidence_artifact_digest_mismatch", "An execution artifact digest does not match its frozen reference.");
  }
  requireCondition(actual.size === binding.artifacts.length, "evidence_artifact_unexpected", "Execution evidence contains an unexpected artifact.");
}

export function loadExecutionEvidence(bytes) {
  return parseExecutionEvidence(parseJson(bytes, "execution evidence fixture"));
}

export function loadExecutionEvidenceBinding(bytes) {
  return parseExecutionEvidenceBinding(parseJson(bytes, "trusted execution binding fixture"));
}

function isCanonicalTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  return new Date(value).toISOString() === value;
}
