import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  HarnessDiagnosticAttemptV1,
  HarnessDiagnosticObservationV1,
  HarnessDiagnosticProjectionCheckpointV1,
  HarnessDiagnosticQueryV1,
  HarnessDiagnosticRecordV1,
  HarnessDiagnosticScopeV1,
  WorkUnitHarnessDiagnosticsResponse,
} from "@ling-stack/contracts";
import {
  HARNESS_PROJECTION_DOMAINS,
  HarnessDiagnosticsStoreError,
  validateHarnessDiagnosticQuery,
  type HarnessProjectionCheckpoint,
  type RunStore,
} from "@ling-stack/core";
import { HttpError } from "../errors.js";
import { writeJson } from "../shared/response.js";
import type { RunStoreRegistry } from "./store-registry.js";

type DiagnosticsReader = Pick<RunStore,
  "getHarnessDiagnosticAttempt" | "queryHarnessDiagnostics" | "getHarnessProjectionCheckpoint">;

/** A read-only metadata projection: observation never grants a claim or a usable execution fence. */
export function projectWorkUnitHarnessDiagnostics(
  cwd: string,
  store: DiagnosticsReader,
  scope: HarnessDiagnosticScopeV1,
  query: HarnessDiagnosticQueryV1,
  observedAt: string,
): WorkUnitHarnessDiagnosticsResponse {
  const base = {
    schemaVersion: 1 as const, cwd, workUnitId: scope.workUnitId, observedAt,
    projectionCheckpoints: [] as readonly HarnessDiagnosticProjectionCheckpointV1[],
  };
  const runId = scope.runId;
  if (scope.status !== "available" || !runId) return { ...base, runId, status: scope.status, items: [] };
  const page = store.queryHarnessDiagnostics(runId, scope.workUnitId, query);
  const attempts = new Map<string, HarnessDiagnosticAttemptV1>();
  const observeAttempt = (id: string): HarnessDiagnosticAttemptV1 => {
    const known = attempts.get(id);
    if (known) return known;
    const result = store.getHarnessDiagnosticAttempt(scope.workUnitId, id);
    attempts.set(id, result);
    return result;
  };
  return {
    ...base, runId, status: "available", nextCursor: page.nextCursor,
    projectionCheckpoints: HARNESS_PROJECTION_DOMAINS.map(domain => {
      const checkpoint = store.getHarnessProjectionCheckpoint(domain);
      if (checkpoint.domain !== domain) {
        throw new HarnessDiagnosticsStoreError("diagnostics.record_invalid", "Harness projection checkpoint domain does not match.");
      }
      return projectProjectionCheckpoint(checkpoint);
    }),
    items: page.items.map(record => ({
      record,
      leaseStatus: observeLease(record, observedAt),
      attempts: (record.kind === "tool_execution" ? [record.attemptId]
        : record.kind === "continuation"
          ? [...new Set([record.sourceAttemptId, ...(record.targetAttemptId ? [record.targetAttemptId] : [])])]
          : record.kind === "delegation" ? [record.parentAttemptId] : [])
        .map(observeAttempt),
    })),
  };
}

/** Explicit allowlist: projection digests/cursors and source rows stay internal. */
function projectProjectionCheckpoint(checkpoint: HarnessProjectionCheckpoint): HarnessDiagnosticProjectionCheckpointV1 {
  return {
    domain: checkpoint.domain,
    generation: checkpoint.generation,
    sourceEpoch: checkpoint.sourceEpoch,
    builtEpoch: checkpoint.builtEpoch,
    state: checkpoint.state,
    rowCount: checkpoint.rowCount,
    isCurrent: checkpoint.state === "ready" && checkpoint.sourceEpoch === checkpoint.builtEpoch,
    ...(checkpoint.failureCode === undefined ? {} : { failureCode: checkpoint.failureCode }),
    updatedAt: checkpoint.updatedAt,
  };
}

function observeLease(record: HarnessDiagnosticRecordV1, observedAt: string): HarnessDiagnosticObservationV1["leaseStatus"] {
  if (!record.claimOwner) return "unclaimed";
  if (["succeeded", "failed", "cancelled", "superseded", "denied", "unknown_outcome"].includes(record.state)) return "terminal_retained";
  return record.claimExpiresAt && record.claimExpiresAt <= observedAt ? "expired" : "held";
}

/** Independent route, deliberately ahead of Store initialization and RuntimeSupervisor reconciliation. */
export function handleWorkUnitHarnessDiagnostics(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  registry: Pick<RunStoreRegistry, "getInitializedStore">,
  workUnitId: string,
): void {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: "Harness diagnostics support GET only." });
    return;
  }
  try {
    const { cwd, query } = parseDiagnosticsQuery(url, workUnitId);
    const store = registry.getInitializedStore(cwd);
    if (!store) throw new HttpError(503, "harness_workspace_uninitialized", "Diagnostics require an initialized workspace; this read does not initialize or recover it.");
    const scope = store.queryWorkUnitHarnessDiagnosticScope(workUnitId);
    if (!scope) throw new HttpError(404, "work_unit_not_found", "The requested work unit was not found in this workspace.");
    const normalized = validateHarnessDiagnosticQuery(scope.runId ?? "unlinked", workUnitId, query);
    writeJson(response, 200, projectWorkUnitHarnessDiagnostics(cwd, store, scope, normalized, new Date().toISOString()));
  } catch (error) {
    if (error instanceof HttpError) {
      writeJson(response, error.statusCode, { error: error.code, message: error.message });
    } else if (error instanceof HarnessDiagnosticsStoreError && error.code === "diagnostics.invalid_query") {
      writeJson(response, 400, { error: "harness_diagnostics_invalid_query", message: "Diagnostics pagination parameters are invalid or belong to another scope." });
    } else {
      // SQLite/adapter failures can include private paths and data. Do not send their message or masquerade as an empty page.
      writeJson(response, 500, { error: "harness_diagnostics_unavailable", message: "Harness diagnostics could not be read. Retry the read after resolving the workspace error." });
    }
  }
}

function parseDiagnosticsQuery(url: URL, workUnitId: string): { cwd: string; query: HarnessDiagnosticQueryV1 } {
  for (const key of url.searchParams.keys()) {
    if (!["cwd", "limit", "cursor"].includes(key) || url.searchParams.getAll(key).length !== 1) {
      throw new HttpError(400, "harness_diagnostics_invalid_query", "Diagnostics query fields must be unique and supported.");
    }
  }
  const cwd = url.searchParams.get("cwd");
  if (!cwd || cwd.length > 4096 || cwd.includes("\0")) throw new HttpError(400, "bad_request", "A valid cwd query parameter is required.");
  const rawLimit = url.searchParams.get("limit");
  if (rawLimit !== null && (!/^[1-9]\d{0,2}$/.test(rawLimit) || Number(rawLimit) > 500)) {
    throw new HttpError(400, "harness_diagnostics_invalid_query", "Diagnostics limit must be an integer between 1 and 500.");
  }
  const rawCursor = url.searchParams.get("cursor");
  let cursor: HarnessDiagnosticQueryV1["cursor"];
  if (rawCursor !== null) {
    if (rawCursor.length > 8192) throw new HttpError(400, "harness_diagnostics_invalid_query", "Diagnostics cursor is invalid.");
    try { cursor = JSON.parse(rawCursor) as HarnessDiagnosticQueryV1["cursor"]; }
    catch { throw new HttpError(400, "harness_diagnostics_invalid_query", "Diagnostics cursor is invalid."); }
    // Use the Core validator for the closed shape, even when the workspace is not yet initialized.
    validateHarnessDiagnosticQuery(cursor?.runId ?? "unlinked", workUnitId, { cursor });
  }
  return { cwd, query: { ...(rawLimit !== null ? { limit: Number(rawLimit) } : {}), ...(rawCursor !== null ? { cursor } : {}) } };
}
