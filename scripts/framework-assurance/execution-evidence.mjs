import { randomUUID } from "node:crypto";
import { digest, exactObject, identifier, parseJson, requireCondition, sha256 } from "./manifest.mjs";
import { parseObservation } from "./evidence.mjs";

const INPUT_DIGEST_KEYS = ["suiteBytes", "taskBytes", "ruleBytes", "expectedBytes", "profileBytes", "lockBytes"];
const COMPARISON_KEYS = ["model", "reasoning", "executionStrategy", "node", "platform", "arch"];
const RUN_STATUSES = new Set(["queued", "running", "waiting_for_input", "waiting_for_approval", "yielded", "succeeded", "failed", "cancelled"]);
const WORK_UNIT_STATUSES = new Set(["queued", "claimed", "running", "waiting_for_approval", "waiting_for_input", "cancelling", "succeeded", "failed", "cancelled", "stale"]);
const ATTEMPT_STATUSES = new Set(["created", "started", "waiting_for_approval", "cancelling", "yielded", "succeeded", "failed", "cancelled", "lost"]);
const TERMINAL_ATTEMPT_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const CLAIM_STATUSES = new Set(["unclaimed", "held", "expired", "terminal_retained"]);
const EFFECT_STATUSES = new Set(["none", "confirmed", "unknown"]);
const STOP_EXECUTION_STATUSES = new Set(["draining", "drained", "unverified"]);
const STOP_EFFECT_STATUSES = new Set(["settled", "pending", "unknown", "unverified"]);
const BUDGET_STATUSES = new Set(["within", "pending", "unknown", "over", "missing", "invalid", "not_applicable"]);
const DIMENSION_STATUSES = new Set(["within", "pending", "unknown", "over", "missing", "invalid", "not_applicable"]);

/** Parse the daemon's read-only live evidence projection before it is joined with frozen task inputs. */
export function parseLiveExecutionEvidenceResponse(value) {
  const baseKeys = ["schemaVersion", "kind", "comparison", "execution", "snapshots", "artifacts", "observedAt", "limitations"];
  const assuranceKeys = ["lifecycle", "completion", "budget", "isolation", "admission"];
  const hasAssurance = assuranceKeys.some(key => Object.hasOwn(value ?? {}, key));
  exactObject(value, hasAssurance ? [...baseKeys, ...assuranceKeys] : baseKeys, "live execution evidence response");
  requireCondition(value.schemaVersion === 1 && value.kind === "live_execution_evidence", "invalid_manifest", "Unsupported live execution evidence response.");
  parseComparison(value.comparison, "live execution comparison");
  parseExecutionLineage(value.execution, "live execution lineage");
  parseSnapshots(value.snapshots, "live execution snapshots");
  parseArtifactPins(value.artifacts, "live execution artifacts");
  if (hasAssurance) {
    parseLifecycle(value.lifecycle);
    parseCompletion(value.completion);
    parseBudget(value.budget);
    parseIsolation(value.isolation);
    parseAdmission(value.admission);
  }
  requireCondition(isCanonicalTimestamp(value.observedAt), "invalid_manifest", "Live execution observedAt must be an ISO-8601 timestamp.");
  requireCondition(Array.isArray(value.limitations) && value.limitations.length >= 1 && value.limitations.length <= 100,
    "invalid_manifest", "Live execution limitations are required.");
  value.limitations.forEach(item => identifier(item, "live execution limitation"));
  return value;
}

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
  for (const artifact of value.artifacts) {
    exactObject(artifact, ["role", "artifactId", "contentSha256"], "execution artifact pin");
    identifier(artifact.role, "execution artifact role"); identifier(artifact.artifactId, "execution artifact id");
    digest(artifact.contentSha256, "execution artifact digest");
    requireCondition(!artifactIds.has(artifact.artifactId),
      "invalid_manifest", "Execution artifact pins must have unique IDs.");
    artifactIds.add(artifact.artifactId);
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
  for (const artifact of value.artifacts) {
    exactObject(artifact, ["role", "artifactId", "contentSha256"], "trusted execution artifact pin");
    identifier(artifact.role, "trusted execution artifact role"); identifier(artifact.artifactId, "trusted execution artifact id");
    digest(artifact.contentSha256, "trusted execution artifact digest");
    requireCondition(!artifactIds.has(artifact.artifactId),
      "invalid_manifest", "Trusted execution artifact pins must have unique IDs.");
    artifactIds.add(artifact.artifactId);
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

/**
 * Read a live Host projection through the existing API client and join it with
 * the frozen task identity. This function has no dispatch or mutation path.
 * @param {{
 *   client: { getRunAssuranceEvidence: (runId: string, cwd: string) => Promise<unknown> },
 *   cwd: string,
 *   runId: string,
 *   taskIdentity: Record<"suiteId" | "suiteVersion" | "taskId" | "taskVersion", string>,
 *   sourceCommit: string,
 *   inputDigests: Record<"suiteBytes" | "taskBytes" | "ruleBytes" | "expectedBytes" | "profileBytes" | "lockBytes", string>,
 *   caseId: string,
 *   invocationId?: string
 * }} [options]
 */
export async function collectLiveExecutionEvidence({
  client,
  cwd,
  runId,
  taskIdentity,
  sourceCommit,
  inputDigests,
  caseId,
  invocationId = randomUUID(),
} = {}) {
  requireCondition(client !== null && typeof client === "object" && typeof client.getRunAssuranceEvidence === "function",
    "live_evidence_client_invalid", "A LingDaemonClient live evidence reader is required.");
  requireCondition(typeof cwd === "string" && cwd.length > 0, "live_evidence_query_invalid", "A workspace cwd is required.");
  identifier(runId, "live evidence Run id");
  identifier(invocationId, "live evidence invocation id");
  identifier(caseId, "live evidence case id");
  validateTaskIdentity(taskIdentity);
  requireCondition(typeof sourceCommit === "string" && /^[a-f0-9]{40}$/.test(sourceCommit), "invalid_manifest", "Live source commit must be frozen.");
  validateInputDigests(inputDigests);

  const source = parseLiveExecutionEvidenceResponse(await client.getRunAssuranceEvidence(runId, cwd));
  requireCondition(source.execution.runId === runId, "evidence_lineage_mismatch", "Live evidence Run does not match the requested Run.");
  const evidence = parseExecutionEvidence({
    schemaVersion: 1,
    evidenceId: sha256(`${invocationId}:${caseId}:${runId}:${source.execution.attemptId}`),
    invocationId,
    caseId,
    taskIdentity,
    sourceCommit,
    inputDigests,
    comparison: source.comparison,
    execution: source.execution,
    snapshots: source.snapshots,
    artifacts: source.artifacts,
    observedAt: source.observedAt,
    limitations: source.limitations,
  });
  const observation = parseObservation({
    schemaVersion: 1,
    observationId: evidence.evidenceId,
    invocationId: evidence.invocationId,
    caseId: evidence.caseId,
    taskIdentity: evidence.taskIdentity,
    sourceCommit: evidence.sourceCommit,
    inputDigests: evidence.inputDigests,
    comparison: evidence.comparison,
    evidenceKind: "live_execution",
    executionStatus: executionStatusFor(evidence.execution.attemptStatus),
    assessment: "not_assessed",
    stopReason: stopReasonFor(evidence.execution),
    effectStatus: evidence.execution.effectStatus,
    timings: { queueMs: null, executionMs: null, validationMs: null, gradingMs: null },
    usage: [],
    artifacts: evidence.artifacts.map(item => ({ role: item.role, sha256: item.contentSha256 })),
    limitations: [...new Set([...evidence.limitations, "live_execution_read_only", "no_evaluation_grade"])],
  }, { allowLive: true });
  return {
    observation,
    source,
    lineage: {
      runId: source.execution.runId,
      workUnitId: source.execution.workUnitId,
      attemptId: source.execution.attemptId,
      runtimeInstanceId: source.execution.runtimeInstanceId,
    },
    observedAt: source.observedAt,
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

function parseComparison(value, label) {
  exactObject(value, COMPARISON_KEYS, label);
  Object.values(value).forEach(item => identifier(item, `${label} value`));
}

function parseExecutionLineage(value, label) {
  exactObject(value, ["runId", "workUnitId", "attemptId", "runtimeInstanceId", "fencingToken",
    "runStatus", "workUnitStatus", "attemptStatus", "claimStatus", "effectStatus"], label);
  for (const key of ["runId", "workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"]) identifier(value[key], key);
  requireCondition(RUN_STATUSES.has(value.runStatus), "invalid_manifest", `${label} Run status is invalid.`);
  requireCondition(WORK_UNIT_STATUSES.has(value.workUnitStatus), "invalid_manifest", `${label} WorkUnit status is invalid.`);
  requireCondition(ATTEMPT_STATUSES.has(value.attemptStatus), "invalid_manifest", `${label} Attempt status is invalid.`);
  requireCondition(CLAIM_STATUSES.has(value.claimStatus), "invalid_manifest", `${label} claim status is invalid.`);
  requireCondition(EFFECT_STATUSES.has(value.effectStatus), "invalid_manifest", `${label} effect status is invalid.`);
}

function parseSnapshots(value, label) {
  exactObject(value, ["run", "workUnit", "attempt"], label);
  for (const [name, snapshot] of Object.entries(value)) {
    exactObject(snapshot, ["revision", "sha256"], `${label} ${name}`);
    requireCondition(Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0, "invalid_manifest", `${label} ${name} revision is invalid.`);
    digest(snapshot.sha256, `${label} ${name} digest`);
  }
}

function parseArtifactPins(value, label) {
  requireCondition(Array.isArray(value) && value.length >= 1 && value.length <= 100, "invalid_manifest", `${label} are required.`);
  const ids = new Set();
  for (const artifact of value) {
    exactObject(artifact, ["role", "artifactId", "contentSha256"], `${label} pin`);
    identifier(artifact.role, `${label} role`); identifier(artifact.artifactId, `${label} id`); digest(artifact.contentSha256, `${label} digest`);
    requireCondition(!ids.has(artifact.artifactId), "invalid_manifest", `${label} IDs must be unique.`);
    ids.add(artifact.artifactId);
  }
}

function parseLifecycle(value) {
  exactObject(value, ["status", "currentAttemptId", "currentGeneration", "attemptCount", "oldAttemptCount", "attempts", "stop"], "live lifecycle");
  identifier(value.currentAttemptId, "live current Attempt");
  requireCondition(Number.isSafeInteger(value.currentGeneration) && value.currentGeneration >= 1
    && Number.isSafeInteger(value.attemptCount) && value.attemptCount >= 1
    && Number.isSafeInteger(value.oldAttemptCount) && value.oldAttemptCount >= 0
    && value.oldAttemptCount < value.attemptCount, "invalid_manifest", "Live lifecycle generations are invalid.");
  requireCondition(["active", "cancelling", "terminal", "draining", "drained", "unverified"].includes(value.status), "invalid_manifest", "Live lifecycle status is invalid.");
  requireCondition(Array.isArray(value.attempts) && value.attempts.length === value.attemptCount && value.attempts.length <= 100,
    "invalid_manifest", "Live lifecycle attempts are invalid.");
  const current = value.attempts.filter(item => item.isCurrent);
  requireCondition(current.length === 1 && current[0].attemptId === value.currentAttemptId, "invalid_manifest", "Live lifecycle current Attempt is invalid.");
  for (const attempt of value.attempts) {
    exactObject(attempt, ["attemptId", "attemptNumber", "runtimeInstanceId", "fencingToken", "status", "isCurrent", "abortRequestedAt", "endedAt", "localExecution", "effects"], "live lifecycle Attempt");
    identifier(attempt.attemptId, "live lifecycle Attempt id"); identifier(attempt.runtimeInstanceId, "live lifecycle runtime id"); identifier(attempt.fencingToken, "live lifecycle fence");
    requireCondition(Number.isSafeInteger(attempt.attemptNumber) && attempt.attemptNumber >= 1 && ATTEMPT_STATUSES.has(attempt.status), "invalid_manifest", "Live lifecycle Attempt is invalid.");
    requireCondition(typeof attempt.isCurrent === "boolean" && (attempt.abortRequestedAt === null || isCanonicalTimestamp(attempt.abortRequestedAt))
      && (attempt.endedAt === null || isCanonicalTimestamp(attempt.endedAt)) && STOP_EXECUTION_STATUSES.has(attempt.localExecution)
      && STOP_EFFECT_STATUSES.has(attempt.effects), "invalid_manifest", "Live lifecycle stop state is invalid.");
  }
  exactObject(value.stop, ["localExecution", "effects", "allAttemptsTerminal", "reusable"], "live lifecycle stop");
  requireCondition(STOP_EXECUTION_STATUSES.has(value.stop.localExecution) && STOP_EFFECT_STATUSES.has(value.stop.effects)
    && typeof value.stop.allAttemptsTerminal === "boolean" && typeof value.stop.reusable === "boolean", "invalid_manifest", "Live lifecycle stop summary is invalid.");
}

function parseCompletion(value) {
  exactObject(value, ["status", "rootRunIds", "fingerprint", "stepCount", "requiredStepCount", "completedStepCount", "steps", "issues", "resultArtifacts"], "live completion");
  requireCondition(["satisfied", "pending", "blocked", "failed", "cancelled", "not_applicable"].includes(value.status)
    && Array.isArray(value.rootRunIds) && value.rootRunIds.length <= 1024 && (value.fingerprint === null || /^[a-zA-Z0-9._-]{1,200}$/.test(value.fingerprint))
    && Number.isSafeInteger(value.stepCount) && value.stepCount >= 0 && Number.isSafeInteger(value.requiredStepCount) && value.requiredStepCount >= 0
    && Number.isSafeInteger(value.completedStepCount) && value.completedStepCount >= 0 && Array.isArray(value.steps) && value.steps.length === value.stepCount
    && Array.isArray(value.issues) && Array.isArray(value.resultArtifacts), "invalid_manifest", "Live completion summary is invalid.");
  value.rootRunIds.forEach(item => identifier(item, "live completion root Run"));
  for (const step of value.steps) {
    exactObject(step, ["stepId", "required", "state", "childRunId", "attemptId", "reservationState", "completionStatus", "resultArtifacts"], "live completion step");
    identifier(step.stepId, "live completion step id"); identifier(step.state, "live completion step state");
    requireCondition(typeof step.required === "boolean" && (step.childRunId === null || typeof step.childRunId === "string")
      && (step.attemptId === null || typeof step.attemptId === "string") && (step.reservationState === null || typeof step.reservationState === "string")
      && ["verified", "pending", "missing", "invalid"].includes(step.completionStatus) && Array.isArray(step.resultArtifacts), "invalid_manifest", "Live completion step is invalid.");
    parseArtifactPinsAllowEmpty(step.resultArtifacts, "live completion result artifacts");
  }
  for (const issue of value.issues) {
    exactObject(issue, ["code", "stepId", "runId", "factFingerprint"], "live completion issue");
    identifier(issue.code, "live completion issue code");
    requireCondition(issue.stepId === null || typeof issue.stepId === "string" && issue.stepId.length > 0,
      "invalid_manifest", "Live completion issue step is invalid.");
    requireCondition(issue.runId === null || typeof issue.runId === "string" && issue.runId.length > 0,
      "invalid_manifest", "Live completion issue Run is invalid.");
    requireCondition(issue.factFingerprint === null || typeof issue.factFingerprint === "string" && issue.factFingerprint.length > 0,
      "invalid_manifest", "Live completion issue fingerprint is invalid.");
  }
  parseArtifactPinsAllowEmpty(value.resultArtifacts, "live completion result artifacts");
}

function parseBudget(value) {
  exactObject(value, ["status", "roots", "reservations", "charges", "usage", "issues", "blockers"], "live budget");
  requireCondition(BUDGET_STATUSES.has(value.status) && Array.isArray(value.roots) && Array.isArray(value.reservations)
    && Array.isArray(value.charges) && Array.isArray(value.issues) && Array.isArray(value.blockers), "invalid_manifest", "Live budget summary is invalid.");
  for (const root of value.roots) {
    exactObject(root, ["runId", "present", "tokenBudget", "costBudgetMicros", "deadlineAt", "chargeCount"], "live budget root");
    identifier(root.runId, "live budget root Run");
    requireCondition(typeof root.present === "boolean" && nullableNonnegativeInteger(root.tokenBudget) && nullableNonnegativeInteger(root.costBudgetMicros)
      && (root.deadlineAt === null || isCanonicalTimestamp(root.deadlineAt)) && Number.isSafeInteger(root.chargeCount) && root.chargeCount >= 0, "invalid_manifest", "Live budget root is invalid.");
  }
  for (const reservation of value.reservations) {
    exactObject(reservation, ["reservationId", "stepId", "state", "tokenReserved", "costReservedMicros", "settledTokenUsage", "settledCostMicros", "failureCode"], "live budget reservation");
    identifier(reservation.reservationId, "live budget reservation id"); identifier(reservation.stepId, "live budget reservation step"); identifier(reservation.state, "live budget reservation state");
    requireCondition(nullableNonnegativeInteger(reservation.tokenReserved) && nullableNonnegativeInteger(reservation.costReservedMicros)
      && nullableNonnegativeInteger(reservation.settledTokenUsage) && nullableNonnegativeInteger(reservation.settledCostMicros)
      && (reservation.failureCode === null || typeof reservation.failureCode === "string"), "invalid_manifest", "Live budget reservation is invalid.");
  }
  for (const charge of value.charges) {
    exactObject(charge, ["chargeId", "reservationId", "runId", "attemptId", "state", "reservedTokens", "reservedCostMicros", "inputTokens", "cachedInputTokens", "outputTokens", "actualCostMicros"], "live budget charge");
    identifier(charge.chargeId, "live budget charge id"); identifier(charge.runId, "live budget charge Run"); identifier(charge.attemptId, "live budget charge Attempt"); identifier(charge.state, "live budget charge state");
    requireCondition((charge.reservationId === null || typeof charge.reservationId === "string")
      && nullableNonnegativeInteger(charge.reservedTokens) && nullableNonnegativeInteger(charge.reservedCostMicros)
      && nullableNonnegativeInteger(charge.inputTokens) && nullableNonnegativeInteger(charge.cachedInputTokens)
      && nullableNonnegativeInteger(charge.outputTokens) && nullableNonnegativeInteger(charge.actualCostMicros), "invalid_manifest", "Live budget charge is invalid.");
  }
  exactObject(value.usage, ["tokenStatus", "costStatus", "tokens", "costMicros", "tokenLimit", "costLimitMicros"], "live budget usage");
  requireCondition(DIMENSION_STATUSES.has(value.usage.tokenStatus) && DIMENSION_STATUSES.has(value.usage.costStatus)
    && nullableNonnegativeInteger(value.usage.tokens) && nullableNonnegativeInteger(value.usage.costMicros)
    && nullableNonnegativeInteger(value.usage.tokenLimit) && nullableNonnegativeInteger(value.usage.costLimitMicros), "invalid_manifest", "Live budget usage is invalid.");
  value.issues.concat(value.blockers).forEach(item => identifier(item, "live budget issue"));
}

function parseIsolation(value) {
  exactObject(value, ["status", "workflowId", "workflowStepId", "selection", "safetyPlan", "binding", "round", "history", "effects", "receipts", "branchResults", "approval", "apply", "blockers"], "live isolation");
  requireCondition(["verified", "pending", "blocked", "not_applicable", "unavailable"].includes(value.status)
    && nullableIdentifier(value.workflowId) && nullableIdentifier(value.workflowStepId) && Array.isArray(value.history)
    && Array.isArray(value.effects) && Array.isArray(value.receipts) && Array.isArray(value.branchResults) && Array.isArray(value.blockers), "invalid_manifest", "Live isolation summary is invalid.");
  if (value.selection !== null) {
    exactObject(value.selection, ["profile", "roundId", "phase"], "live isolation selection");
    identifier(value.selection.profile, "live isolation profile"); identifier(value.selection.roundId, "live isolation round"); identifier(value.selection.phase, "live isolation phase");
  }
  exactObject(value.safetyPlan, ["present", "valid", "profile", "digest", "toolsCount", "writeRootsCount", "networkAccess"], "live isolation safety plan");
  requireCondition(typeof value.safetyPlan.present === "boolean" && typeof value.safetyPlan.valid === "boolean"
    && nullableIdentifier(value.safetyPlan.profile) && nullableIdentifier(value.safetyPlan.digest)
    && Number.isSafeInteger(value.safetyPlan.toolsCount) && value.safetyPlan.toolsCount >= 0
    && Number.isSafeInteger(value.safetyPlan.writeRootsCount) && value.safetyPlan.writeRootsCount >= 0
    && (value.safetyPlan.networkAccess === null || value.safetyPlan.networkAccess === false || value.safetyPlan.networkAccess === "session_policy"), "invalid_manifest", "Live isolation safety plan is invalid.");
  exactObject(value.binding, ["status", "bindingId", "revision", "planDigest", "matchesCurrentFence"], "live isolation binding");
  requireCondition(["current", "stale", "invalid", "missing", "not_checked"].includes(value.binding.status)
    && nullableIdentifier(value.binding.bindingId) && (value.binding.revision === null || Number.isSafeInteger(value.binding.revision) && value.binding.revision >= 0)
    && nullableIdentifier(value.binding.planDigest) && typeof value.binding.matchesCurrentFence === "boolean", "invalid_manifest", "Live isolation binding is invalid.");
  if (value.round !== null) parseIsolationRound(value.round);
  for (const item of value.history) {
    exactObject(item, ["roundId", "generation", "revision", "phase", "reason"], "live isolation history");
    identifier(item.roundId, "live isolation history round"); identifier(item.phase, "live isolation history phase");
    requireCondition(nullableIdentifier(item.reason) && Number.isSafeInteger(item.generation) && item.generation >= 1
      && Number.isSafeInteger(item.revision) && item.revision >= 0, "invalid_manifest", "Live isolation history entry is invalid.");
  }
  for (const effect of value.effects) {
    exactObject(effect, ["effectKey", "kind", "status", "digest", "beforeDigest", "afterDigest", "payloadContentSha256"], "live isolation effect");
    publicEffectKey(effect.effectKey, "live isolation effect key");
    [effect.kind, effect.status].forEach(item => identifier(item, "live isolation effect field"));
    [effect.digest, effect.beforeDigest, effect.afterDigest].forEach(item => workflowDigest(item, "live isolation effect digest"));
    digest(effect.payloadContentSha256, "live isolation effect payload digest");
  }
  for (const receipt of value.receipts) {
    exactObject(receipt, ["receiptId", "intentId", "outcome", "observedDigest", "artifactId", "artifactContentSha256"], "live isolation receipt");
    [receipt.receiptId, receipt.intentId, receipt.outcome, receipt.artifactId].forEach(item => identifier(item, "live isolation receipt field"));
    workflowDigest(receipt.observedDigest, "live isolation receipt observation digest");
    requireCondition(receipt.artifactContentSha256 === "" || /^[a-f0-9]{64}$/.test(receipt.artifactContentSha256), "invalid_manifest", "Live isolation receipt artifact digest is invalid.");
  }
  for (const branch of value.branchResults) {
    exactObject(branch, ["workflowStepId", "status", "packetDigest", "packetContentSha256"], "live isolation branch result");
    identifier(branch.workflowStepId, "live isolation branch step"); identifier(branch.status, "live isolation branch status");
    requireCondition(nullableIdentifier(branch.packetDigest) && nullableDigest(branch.packetContentSha256),
      "invalid_manifest", "Live isolation branch digests are invalid.");
  }
  exactObject(value.approval, ["status", "approvalId", "requestId", "authorityDigest", "basisFingerprint"], "live isolation approval");
  identifier(value.approval.status, "live isolation approval status");
  requireCondition(nullableIdentifier(value.approval.approvalId) && nullableIdentifier(value.approval.requestId)
    && nullableIdentifier(value.approval.authorityDigest) && nullableIdentifier(value.approval.basisFingerprint),
  "invalid_manifest", "Live isolation approval identifiers are invalid.");
  exactObject(value.apply, ["status", "code", "intentPresent"], "live isolation apply");
  requireCondition(identifier(value.apply.status, "live isolation apply status") && (value.apply.code === null || typeof value.apply.code === "string")
    && typeof value.apply.intentPresent === "boolean", "invalid_manifest", "Live isolation apply is invalid.");
  value.blockers.forEach(item => identifier(item, "live isolation blocker"));
}

function parseIsolationRound(value) {
  exactObject(value, ["roundId", "generation", "revision", "phase", "lastConfirmedPhase", "candidate"], "live isolation round");
  identifier(value.roundId, "live isolation round id"); identifier(value.phase, "live isolation round phase"); identifier(value.lastConfirmedPhase, "live isolation confirmed phase");
  requireCondition(Number.isSafeInteger(value.generation) && value.generation >= 1 && Number.isSafeInteger(value.revision) && value.revision >= 0, "invalid_manifest", "Live isolation round revision is invalid.");
  if (value.candidate !== null) {
    exactObject(value.candidate, ["commit", "tree", "packetDigest", "branchResultDigests", "validationDigest"], "live isolation candidate");
    [value.candidate.commit, value.candidate.tree, value.candidate.packetDigest, value.candidate.validationDigest].forEach(item => identifier(item, "live isolation candidate field"));
    requireCondition(Array.isArray(value.candidate.branchResultDigests), "invalid_manifest", "Live isolation candidate branch results are invalid.");
    value.candidate.branchResultDigests.forEach(item => identifier(item, "live isolation candidate branch digest"));
  }
}

function parseAdmission(value) {
  exactObject(value, ["status", "profile", "safetyPlan", "toolBroker", "binding", "blockers"], "live admission");
  requireCondition(["verified", "blocked", "not_applicable", "unavailable"].includes(value.status) && nullableIdentifier(value.profile) && Array.isArray(value.blockers), "invalid_manifest", "Live admission summary is invalid.");
  exactObject(value.safetyPlan, ["present", "valid", "digest"], "live admission safety plan");
  requireCondition(typeof value.safetyPlan.present === "boolean" && typeof value.safetyPlan.valid === "boolean" && nullableIdentifier(value.safetyPlan.digest), "invalid_manifest", "Live admission safety plan is invalid.");
  exactObject(value.toolBroker, ["mode", "required", "satisfies"], "live admission tool broker");
  requireCondition(["off", "shadow", "enforce"].includes(value.toolBroker.mode) && typeof value.toolBroker.required === "boolean" && typeof value.toolBroker.satisfies === "boolean", "invalid_manifest", "Live admission tool broker is invalid.");
  exactObject(value.binding, ["status", "matchesCurrentFence"], "live admission binding");
  requireCondition(typeof value.binding.status === "string" && typeof value.binding.matchesCurrentFence === "boolean", "invalid_manifest", "Live admission binding is invalid.");
  value.blockers.forEach(item => identifier(item, "live admission blocker"));
}

function parseArtifactPinsAllowEmpty(value, label) {
  requireCondition(Array.isArray(value) && value.length <= 100, "invalid_manifest", `${label} are invalid.`);
  if (value.length > 0) parseArtifactPins(value, label);
}

function nullableNonnegativeInteger(value) {
  return value === null || Number.isSafeInteger(value) && value >= 0;
}

function nullableIdentifier(value) {
  return value === null || typeof value === "string" && value.length > 0 && value.length <= 200;
}

function nullableDigest(value) {
  return value === null || /^[a-f0-9]{64}$/.test(value);
}

function publicEffectKey(value, label) {
  requireCondition(typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(value)
    && !value.includes("..") && !value.startsWith("/") && !value.endsWith("/"),
  "invalid_manifest", `${label} must be a bounded public key.`);
  return value;
}

function workflowDigest(value, label) {
  requireCondition(typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9.-]{0,31}_[a-f0-9]{64}$/.test(value),
    "invalid_manifest", `${label} must be a prefixed workflow digest.`);
  return value;
}

function validateTaskIdentity(value) {
  exactObject(value, ["suiteId", "suiteVersion", "taskId", "taskVersion"], "live task identity");
  Object.values(value).forEach(item => identifier(item, "live task identity"));
}

function validateInputDigests(value) {
  exactObject(value, INPUT_DIGEST_KEYS, "live input digests");
  Object.values(value).forEach(item => digest(item, "live input digest"));
}

function executionStatusFor(status) {
  return status === "succeeded" ? "completed" : status === "failed" ? "failed" : status === "cancelled" ? "cancelled"
    : status === "lost" ? "unknown" : "running";
}

function stopReasonFor(execution) {
  if (execution.attemptStatus === "succeeded" && execution.claimStatus === "terminal_retained" && execution.effectStatus === "confirmed") {
    return "live_execution_observed";
  }
  if (execution.effectStatus === "unknown") return "effect_stop_unconfirmed";
  if (execution.attemptStatus === "lost") return "attempt_lost";
  return "live_execution_incomplete";
}

function isCanonicalTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  return new Date(value).toISOString() === value;
}
