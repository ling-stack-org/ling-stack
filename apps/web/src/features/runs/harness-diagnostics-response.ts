import { HARNESS_TOOL_EXECUTION_STATES, RUNNER_CONTINUATION_STATES } from "@ling-stack/contracts";
import type { HarnessDiagnosticCursorV1, HarnessDiagnosticObservationV1, WorkUnitHarnessDiagnosticsResponse } from "../../types.js";
import type { HarnessDiagnosticsScope } from "./harness-diagnostics-controller.js";

/** Reject malformed or foreign observations before they can become visible state. */
export function validHarnessDiagnosticsResponse(
  response: WorkUnitHarnessDiagnosticsResponse,
  scope: HarnessDiagnosticsScope,
  requestedCursor: HarnessDiagnosticCursorV1 | undefined,
  prior: readonly HarnessDiagnosticObservationV1[],
): boolean {
  if (!response || response.schemaVersion !== 1 || response.cwd !== scope.cwd || response.workUnitId !== scope.workUnitId
    || !Array.isArray(response.items) || response.items.length > 100 || !canonicalTimestamp(response.observedAt)) return false;
  if (response.status === "run_unlinked") return response.runId === undefined && response.items.length === 0 && !response.nextCursor;
  if (response.runId !== scope.runId) return false;
  if (response.status === "run_missing" || response.status === "lineage_mismatch") return response.items.length === 0 && !response.nextCursor;
  if (response.status !== "available") return false;
  const identities = new Set(prior.map(item => `${item.record.kind}:${item.record.id}`));
  for (const item of response.items) {
    if (!validObservation(item, scope)) return false;
    const identity = `${item.record.kind}:${item.record.id}`;
    if (identities.has(identity)) return false;
    identities.add(identity);
  }
  const cursor = response.nextCursor;
  if (!cursor) return true;
  const last = response.items.at(-1)?.record;
  return cursor.runId === scope.runId && cursor.workUnitId === scope.workUnitId && Boolean(last)
    && cursor.createdAt === last?.createdAt && cursor.kind === last?.kind && cursor.id === last?.id
    && (!requestedCursor || cursor.createdAt !== requestedCursor.createdAt || cursor.kind !== requestedCursor.kind || cursor.id !== requestedCursor.id);
}

function validObservation(item: HarnessDiagnosticObservationV1, scope: HarnessDiagnosticsScope): boolean {
  const record = item?.record;
  if (!record || !identifier(record.id) || record.runId !== scope.runId || record.workUnitId !== scope.workUnitId
    || !["unclaimed", "held", "expired", "terminal_retained"].includes(item.leaseStatus)
    || !Number.isSafeInteger(record.revision) || record.revision < 0
    || !canonicalTimestamp(record.createdAt) || !canonicalTimestamp(record.updatedAt) || !Array.isArray(item.attempts)) return false;
  let references: readonly string[];
  if (record.kind === "continuation") {
    if (!RUNNER_CONTINUATION_STATES.includes(record.state) || !identifier(record.sourceAttemptId)
      || (record.targetAttemptId !== undefined && !identifier(record.targetAttemptId))) return false;
    references = [...new Set([record.sourceAttemptId, ...(record.targetAttemptId ? [record.targetAttemptId] : [])])];
  } else if (record.kind === "tool_execution") {
    if (!HARNESS_TOOL_EXECUTION_STATES.includes(record.state) || !identifier(record.attemptId)) return false;
    references = [record.attemptId];
  } else return false;
  if (item.attempts.length !== references.length) return false;
  const seen = new Set<string>();
  for (const attempt of item.attempts) {
    if (!attempt || !references.includes(attempt.id) || seen.has(attempt.id)) return false;
    seen.add(attempt.id);
    if (attempt.status === "observed") {
      if (attempt.workUnitId !== scope.workUnitId || (attempt.fencingToken !== undefined && typeof attempt.fencingToken !== "string")
        || (attempt.runtimeInstanceId !== undefined && typeof attempt.runtimeInstanceId !== "string")
        || (attempt.attemptStatus !== undefined && typeof attempt.attemptStatus !== "string")) return false;
    } else if (attempt.status === "missing" || attempt.status === "ownership_mismatch") {
      if (attempt.workUnitId !== undefined || attempt.fencingToken !== undefined || attempt.runtimeInstanceId !== undefined || attempt.attemptStatus !== undefined) return false;
    } else return false;
  }
  return true;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 && !value.includes("\0");
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
