import { exactObject, identifier, requireCondition, sha256 } from "./manifest.mjs";

const DIAGNOSTIC_KINDS = ["continuation", "tool_execution", "evaluation", "delegation"];
const DIAGNOSTIC_STATUSES = ["available", "run_unlinked", "run_missing", "lineage_mismatch"];
const LEASE_STATUSES = ["unclaimed", "held", "expired", "terminal_retained"];
const PROJECTION_STATES = ["stale", "rebuilding", "ready", "failed"];
const CONTINUATION_STATES = ["requested", "prepared", "claimed", "running", "recovery_pending", "succeeded", "failed", "cancelled", "superseded"];
const TOOL_EXECUTION_STATES = ["proposed", "prepared", "approval_pending", "approved", "claimed", "executing", "committing_evidence", "succeeded", "denied", "failed", "cancelled", "superseded", "unknown_outcome"];
const EVALUATION_STATES = ["queued", "claimed", "grading", "completed", "failed", "cancelled"];
const DELEGATION_STATES = ["planned", "spawning", "running", "waiting", "interrupting", "interrupted", "resuming", "succeeded", "failed", "cancelled", "lost"];
const PROJECTION_DOMAINS = [...DIAGNOSTIC_KINDS];
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const MAX_PAGES = 1000;

/**
 * Validate one response from the existing GET /work-units/:id/harness
 * contract. The response is treated as untrusted input and is copied through
 * explicit field allowlists before it enters an assurance report.
 */
export function parseHarnessDiagnosticsResponse(value, { cwd, workUnitId, runId, requestedCursor } = {}) {
  closedObject(value, ["schemaVersion", "cwd", "workUnitId", "status", "observedAt", "items", "projectionCheckpoints"],
    ["runId", "nextCursor"], "harness diagnostics response");
  requireCondition(value.schemaVersion === 1, "diagnostics_invalid_response", "Harness diagnostics schema is unsupported.");
  requireCondition(typeof cwd === "string" && value.cwd === cwd, "diagnostics_scope_mismatch", "Harness diagnostics cwd does not match the requested workspace.");
  requireCondition(value.workUnitId === workUnitId && identifier(value.workUnitId), "diagnostics_scope_mismatch", "Harness diagnostics WorkUnit does not match the requested scope.");
  requireCondition(DIAGNOSTIC_STATUSES.includes(value.status), "diagnostics_invalid_response", "Harness diagnostics status is invalid.");
  requireCondition(canonicalTimestamp(value.observedAt), "diagnostics_invalid_response", "Harness diagnostics observedAt is invalid.");
  requireCondition(Array.isArray(value.items) && value.items.length <= MAX_PAGE_SIZE, "diagnostics_invalid_response", "Harness diagnostics page is too large.");
  requireCondition(Array.isArray(value.projectionCheckpoints), "diagnostics_invalid_response", "Harness diagnostics projection checkpoints are invalid.");

  if (value.status === "available") {
    requireCondition(identifier(value.runId) && value.runId === runId, "diagnostics_scope_mismatch", "Harness diagnostics Run does not match the requested scope.");
    requireCondition(value.projectionCheckpoints.length === PROJECTION_DOMAINS.length, "diagnostics_invalid_response", "Harness diagnostics projection domains are incomplete.");
    const checkpoints = value.projectionCheckpoints.map(parseProjectionCheckpoint);
    requireCondition(new Set(checkpoints.map(item => item.domain)).size === PROJECTION_DOMAINS.length
      && PROJECTION_DOMAINS.every(domain => checkpoints.some(item => item.domain === domain)),
    "diagnostics_invalid_response", "Harness diagnostics projection domains are duplicated or unknown.");
    const items = value.items.map(item => parseObservation(item, { runId, workUnitId }));
    const nextCursor = value.nextCursor === undefined ? undefined : parseCursor(value.nextCursor, { runId, workUnitId });
    if (nextCursor) {
      const last = items.at(-1)?.record;
      requireCondition(last && nextCursor.createdAt === last.createdAt && nextCursor.kind === last.kind && nextCursor.id === last.id,
        "diagnostics_invalid_response", "Harness diagnostics cursor is not bound to the last row.");
      if (requestedCursor) requireCondition(!sameCursor(nextCursor, requestedCursor), "diagnostics_pagination_stalled", "Harness diagnostics cursor did not advance.");
    }
    return {
      schemaVersion: 1,
      cwd: value.cwd,
      workUnitId: value.workUnitId,
      runId: value.runId,
      status: value.status,
      observedAt: value.observedAt,
      items,
      projectionCheckpoints: checkpoints,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  requireCondition(value.items.length === 0 && value.projectionCheckpoints.length === 0 && value.nextCursor === undefined,
    "diagnostics_invalid_response", "Unavailable harness diagnostics must not contain rows or a cursor.");
  if (value.status === "run_unlinked") {
    requireCondition(value.runId === undefined, "diagnostics_invalid_response", "Unlinked diagnostics must not invent a Run identity.");
  } else if (value.runId !== undefined) {
    requireCondition(identifier(value.runId) && value.runId === runId, "diagnostics_scope_mismatch", "Unavailable diagnostics Run does not match the requested scope.");
  }
  return {
    schemaVersion: 1,
    cwd: value.cwd,
    workUnitId: value.workUnitId,
    ...(value.runId === undefined ? {} : { runId: value.runId }),
    status: value.status,
    observedAt: value.observedAt,
    items: [],
    projectionCheckpoints: [],
  };
}

/**
 * Read every page through the supplied existing diagnostic client and produce
 * a bounded, read-only report. The callback is the only execution boundary;
 * this module never initializes a Store, reconciles a WorkUnit, retries or
 * dispatches a Run.
 */
export async function readHarnessDiagnosticsReport({
  cwd,
  workUnitId,
  runId,
  read,
  assurance,
  limit = DEFAULT_PAGE_SIZE,
  maxPages = MAX_PAGES,
  now = () => new Date().toISOString(),
} = {}) {
  requireCondition(typeof cwd === "string" && cwd.length > 0, "diagnostics_invalid_query", "A workspace cwd is required.");
  identifier(workUnitId, "diagnostics WorkUnit id");
  identifier(runId, "diagnostics Run id");
  requireCondition(typeof read === "function", "diagnostics_invalid_query", "A read-only diagnostics callback is required.");
  requireCondition(Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_PAGE_SIZE, "diagnostics_invalid_query", "Diagnostics page size must be between 1 and 500.");
  requireCondition(Number.isSafeInteger(maxPages) && maxPages >= 1 && maxPages <= MAX_PAGES, "diagnostics_invalid_query", "Diagnostics page budget is invalid.");

  const pages = [];
  const observations = [];
  const identities = new Set();
  let cursor;
  let status;
  let observedAt;
  let responseRunId;
  let projectionCheckpoints = [];

  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const query = cursor ? { limit, cursor } : { limit };
    let response;
    try {
      response = await read(cwd, workUnitId, query);
    } catch (error) {
      const unavailableStatus = diagnosticsErrorStatus(error);
      if (!unavailableStatus) throw error;
      return buildUnavailableReport({ cwd, workUnitId, runId, status: unavailableStatus, observedAt: now(), assurance });
    }
    const parsed = parseHarnessDiagnosticsResponse(response, { cwd, workUnitId, runId, requestedCursor: cursor });
    status = parsed.status;
    observedAt = parsed.observedAt;
    responseRunId = parsed.runId;
    pages.push({
      page: pageNumber + 1,
      observedAt: parsed.observedAt,
      itemCount: parsed.items.length,
      ...(cursor ? { requestedCursor: cursor } : {}),
      ...(parsed.nextCursor ? { nextCursor: parsed.nextCursor } : {}),
    });
    if (parsed.status !== "available") break;

    projectionCheckpoints = parsed.projectionCheckpoints;
    for (const item of parsed.items) {
      const identity = `${item.record.kind}:${item.record.id}`;
      requireCondition(!identities.has(identity), "diagnostics_duplicate_record", "Harness diagnostics pagination returned a duplicate record.");
      identities.add(identity);
      observations.push(item);
    }
    if (!parsed.nextCursor) break;
    cursor = parsed.nextCursor;
  }

  requireCondition(pages.length < maxPages || !cursor, "diagnostics_page_limit", "Harness diagnostics exceeded the read-only page budget.");
  const linked = assurance === undefined ? undefined : linkAssuranceReport(assurance, { runId, workUnitId });
  const unavailable = status !== "available";
  const limitations = ["read_only", "no_execution_authority", "per_page_observation_only"];
  if (unavailable) limitations.push("diagnostics_unavailable");
  return {
    schemaVersion: 1,
    kind: "harness_diagnostics_report",
    cwdSha256: sha256(cwd),
    workUnitId,
    ...(responseRunId === undefined ? {} : { runId: responseRunId }),
    status,
    observedAt,
    pageCount: pages.length,
    pages,
    items: observations,
    projectionCheckpoints,
    ...(linked ? { assurance: linked } : {}),
    limitations,
  };
}

/**
 * Compose the report adapter with the public read-only API client endpoint.
 * The caller owns the client and transport; this helper never creates a
 * client, Store, daemon connection, or execution authority.
 */
export function readHarnessDiagnosticsReportFromClient({
  client,
  cwd,
  workUnitId,
  runId,
  assurance,
  limit,
  maxPages,
  now,
} = {}) {
  requireCondition(client !== null && typeof client === "object"
    && typeof client.getWorkUnitHarnessDiagnostics === "function",
  "diagnostics_invalid_query", "A LingDaemonClient diagnostics reader is required.");
  return readHarnessDiagnosticsReport({
    cwd,
    workUnitId,
    runId,
    assurance,
    limit,
    maxPages,
    now,
    read: (requestedCwd, requestedWorkUnitId, query) =>
      client.getWorkUnitHarnessDiagnostics(requestedCwd, requestedWorkUnitId, query),
  });
}

function buildUnavailableReport({ cwd, workUnitId, runId, status, observedAt, assurance }) {
  requireCondition(canonicalTimestamp(observedAt), "diagnostics_invalid_response", "Unavailable diagnostics timestamp is invalid.");
  const linked = assurance === undefined ? undefined : linkAssuranceReport(assurance, { runId, workUnitId });
  return {
    schemaVersion: 1,
    kind: "harness_diagnostics_report",
    cwdSha256: sha256(cwd),
    workUnitId,
    runId,
    status,
    observedAt,
    pageCount: 0,
    pages: [],
    items: [],
    projectionCheckpoints: [],
    ...(linked ? { assurance: linked } : {}),
    limitations: ["read_only", "no_execution_authority", "diagnostics_unavailable"],
  };
}

function diagnosticsErrorStatus(error) {
  switch (error?.code) {
    case "harness_workspace_uninitialized": return "workspace_uninitialized";
    case "work_unit_not_found": return "not_found";
    case "harness_diagnostics_invalid_query": return "invalid_query";
    case "harness_diagnostics_unavailable": return "unavailable";
    default: return error instanceof TypeError ? "unavailable" : undefined;
  }
}

/** Keep only the stable, non-secret identity fields needed to join an F3 report. */
export function linkAssuranceReport(value, { runId, workUnitId } = {}) {
  closedObject(value, ["observation", "lineage", "observedAt"], [], "assurance execution result");
  exactObject(value.lineage, ["runId", "workUnitId", "attemptId", "runtimeInstanceId"], "assurance lineage");
  requireCondition(value.lineage.runId === runId && value.lineage.workUnitId === workUnitId,
    "diagnostics_lineage_mismatch", "Assurance evidence and Harness diagnostics do not share Run/WorkUnit lineage.");
  const observation = value.observation;
  closedObject(observation, ["schemaVersion", "observationId", "invocationId", "caseId", "taskIdentity", "evidenceKind", "executionStatus", "assessment", "effectStatus"],
    ["sourceCommit", "inputDigests", "comparison", "stopReason", "timings", "usage", "artifacts", "limitations"], "assurance observation");
  requireCondition(observation.schemaVersion === 1, "diagnostics_invalid_response", "Assurance observation schema is unsupported.");
  exactObject(observation.taskIdentity, ["suiteId", "suiteVersion", "taskId", "taskVersion"], "assurance task identity");
  Object.values(observation.taskIdentity).forEach(item => identifier(item, "assurance task identity"));
  for (const key of ["observationId", "invocationId", "caseId", "evidenceKind", "executionStatus", "assessment", "effectStatus"]) identifier(observation[key], `assurance ${key}`);
  requireCondition(canonicalTimestamp(value.observedAt), "diagnostics_invalid_response", "Assurance observedAt is invalid.");
  return {
    observation: {
      observationId: observation.observationId,
      invocationId: observation.invocationId,
      caseId: observation.caseId,
      taskIdentity: structuredClone(observation.taskIdentity),
      evidenceKind: observation.evidenceKind,
      executionStatus: observation.executionStatus,
      assessment: observation.assessment,
      effectStatus: observation.effectStatus,
    },
    lineage: structuredClone(value.lineage),
    observedAt: value.observedAt,
  };
}

function parseObservation(value, { runId, workUnitId }) {
  closedObject(value, ["record", "leaseStatus", "attempts"], [], "harness diagnostic observation");
  requireCondition(LEASE_STATUSES.includes(value.leaseStatus), "diagnostics_invalid_response", "Harness diagnostic lease status is invalid.");
  requireCondition(Array.isArray(value.attempts), "diagnostics_invalid_response", "Harness diagnostic attempts are invalid.");
  const record = parseRecord(value.record, { runId, workUnitId });
  const references = record.kind === "continuation"
    ? [...new Set([record.sourceAttemptId, ...(record.targetAttemptId ? [record.targetAttemptId] : [])])]
    : record.kind === "tool_execution" ? [record.attemptId]
      : record.kind === "delegation" ? [record.parentAttemptId] : [];
  requireCondition(value.attempts.length === references.length, "diagnostics_invalid_response", "Harness diagnostic attempt references are incomplete.");
  const attempts = value.attempts.map(parseAttempt);
  requireCondition(new Set(attempts.map(item => item.id)).size === attempts.length
    && attempts.every(item => references.includes(item.id)), "diagnostics_invalid_response", "Harness diagnostic attempt references are invalid.");
  return { record, leaseStatus: value.leaseStatus, attempts };
}

function parseRecord(value, { runId, workUnitId }) {
  closedObject(value, ["id", "runId", "workUnitId", "revision", "createdAt", "updatedAt", "kind", "state"],
    ["claimOwner", "claimExpiresAt", "nextAttemptAt", "sourceAttemptId", "targetAttemptId", "origin", "strategy", "runnerId", "generation", "failureCode", "failureDetailArtifactId", "completedAt", "attemptId", "toolCallId", "toolName", "executorKind", "continuationId", "delegationStepId", "supersedesExecutionId", "policySnapshotArtifactId", "approvalId", "sandboxProfileId", "executionStartedAt", "executionFinishedAt", "rootRunId", "parentAttemptId", "workflowId", "workflowStepId", "parentDelegationStepId", "childRunId", "required", "depth"], "harness diagnostic record");
  requireCondition(identifier(value.id) && value.runId === runId && value.workUnitId === workUnitId,
    "diagnostics_scope_mismatch", "Harness diagnostic record lineage does not match the requested scope.");
  requireCondition(Number.isSafeInteger(value.revision) && value.revision >= 0
    && canonicalTimestamp(value.createdAt) && canonicalTimestamp(value.updatedAt),
  "diagnostics_invalid_response", "Harness diagnostic record metadata is invalid.");
  for (const key of ["claimOwner", "failureCode", "failureDetailArtifactId", "targetAttemptId", "sourceAttemptId", "origin", "strategy", "runnerId", "attemptId", "toolCallId", "toolName", "executorKind", "continuationId", "delegationStepId", "supersedesExecutionId", "policySnapshotArtifactId", "approvalId", "sandboxProfileId", "rootRunId", "parentAttemptId", "workflowId", "workflowStepId", "parentDelegationStepId", "childRunId"]) {
    if (value[key] !== undefined) identifier(value[key], `harness diagnostic ${key}`);
  }
  for (const key of ["claimExpiresAt", "nextAttemptAt", "completedAt", "executionStartedAt", "executionFinishedAt"]) {
    if (value[key] !== undefined) requireCondition(canonicalTimestamp(value[key]), "diagnostics_invalid_response", `Harness diagnostic ${key} is invalid.`);
  }
  if (value.claimOwner !== undefined) requireCondition(value.claimExpiresAt !== undefined, "diagnostics_invalid_response", "Harness diagnostic claim expiry is missing.");
  if (value.claimExpiresAt !== undefined) requireCondition(value.claimOwner !== undefined, "diagnostics_invalid_response", "Harness diagnostic claim owner is missing.");

  if (value.kind === "continuation") {
    requireCondition(CONTINUATION_STATES.includes(value.state) && identifier(value.sourceAttemptId)
      && (value.targetAttemptId === undefined || identifier(value.targetAttemptId))
      && identifier(value.origin) && identifier(value.strategy) && identifier(value.runnerId)
      && Number.isSafeInteger(value.generation) && value.generation >= 0,
    "diagnostics_invalid_response", "Harness continuation diagnostic is invalid.");
  } else if (value.kind === "tool_execution") {
    requireCondition(TOOL_EXECUTION_STATES.includes(value.state) && identifier(value.attemptId)
      && identifier(value.toolCallId) && identifier(value.toolName) && ["bash", "apply_patch", "write"].includes(value.executorKind)
      && identifier(value.policySnapshotArtifactId) && identifier(value.sandboxProfileId),
    "diagnostics_invalid_response", "Harness tool diagnostic is invalid.");
  } else if (value.kind === "evaluation") {
    requireCondition(EVALUATION_STATES.includes(value.state) && identifier(value.rootRunId),
      "diagnostics_invalid_response", "Harness evaluation diagnostic is invalid.");
  } else if (value.kind === "delegation") {
    requireCondition(DELEGATION_STATES.includes(value.state) && identifier(value.rootRunId)
      && identifier(value.parentAttemptId) && typeof value.required === "boolean"
      && Number.isSafeInteger(value.depth) && value.depth >= 0,
    "diagnostics_invalid_response", "Harness delegation diagnostic is invalid.");
    if (value.workflowStepId !== undefined) requireCondition(value.workflowId !== undefined, "diagnostics_invalid_response", "Harness delegation workflow lineage is incomplete.");
  } else {
    requireCondition(false, "diagnostics_invalid_response", "Harness diagnostic kind is invalid.");
  }
  return structuredClone(value);
}

function parseAttempt(value) {
  closedObject(value, ["id", "status"], ["workUnitId", "runtimeInstanceId", "fencingToken", "attemptStatus"], "harness diagnostic attempt");
  identifier(value.id, "harness diagnostic attempt id");
  requireCondition(["observed", "missing", "ownership_mismatch"].includes(value.status), "diagnostics_invalid_response", "Harness diagnostic attempt status is invalid.");
  if (value.status === "observed") {
    requireCondition(identifier(value.workUnitId) && (value.runtimeInstanceId === undefined || identifier(value.runtimeInstanceId))
      && (value.fencingToken === undefined || identifier(value.fencingToken))
      && (value.attemptStatus === undefined || identifier(value.attemptStatus)),
    "diagnostics_invalid_response", "Observed Attempt metadata is invalid.");
  } else {
    requireCondition(value.workUnitId === undefined && value.runtimeInstanceId === undefined
      && value.fencingToken === undefined && value.attemptStatus === undefined,
    "diagnostics_invalid_response", "Foreign or missing Attempt metadata is overexposed.");
  }
  return structuredClone(value);
}

function parseProjectionCheckpoint(value) {
  closedObject(value, ["domain", "generation", "sourceEpoch", "builtEpoch", "state", "rowCount", "isCurrent", "updatedAt"], ["failureCode"], "harness projection checkpoint");
  requireCondition(PROJECTION_DOMAINS.includes(value.domain)
    && Number.isSafeInteger(value.generation) && value.generation >= 0
    && Number.isSafeInteger(value.sourceEpoch) && value.sourceEpoch >= 0
    && Number.isSafeInteger(value.builtEpoch) && value.builtEpoch >= 0
    && PROJECTION_STATES.includes(value.state)
    && Number.isSafeInteger(value.rowCount) && value.rowCount >= 0
    && value.isCurrent === (value.state === "ready" && value.sourceEpoch === value.builtEpoch)
    && canonicalTimestamp(value.updatedAt),
  "diagnostics_invalid_response", "Harness projection checkpoint is invalid.");
  if (value.failureCode !== undefined) identifier(value.failureCode, "harness projection failure code");
  return structuredClone(value);
}

function parseCursor(value, { runId, workUnitId }) {
  closedObject(value, ["runId", "workUnitId", "createdAt", "kind", "id"], [], "harness diagnostic cursor");
  requireCondition(value.runId === runId && value.workUnitId === workUnitId
    && canonicalTimestamp(value.createdAt) && DIAGNOSTIC_KINDS.includes(value.kind) && identifier(value.id),
  "diagnostics_invalid_response", "Harness diagnostic cursor is invalid.");
  return structuredClone(value);
}

function closedObject(value, required, optional, label) {
  requireCondition(value !== null && typeof value === "object" && !Array.isArray(value), "diagnostics_invalid_response", `${label} must be an object.`);
  const allowed = new Set([...required, ...optional]);
  requireCondition(Object.keys(value).every(key => allowed.has(key)) && required.every(key => Object.hasOwn(value, key)),
    "diagnostics_invalid_response", `${label} has missing or unsupported fields.`);
}

function sameCursor(left, right) {
  return left.runId === right.runId && left.workUnitId === right.workUnitId && left.createdAt === right.createdAt
    && left.kind === right.kind && left.id === right.id;
}

function canonicalTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
