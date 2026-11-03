import type { HarnessDiagnosticCursorV1, HarnessDiagnosticQueryV1 } from "@ling-stack/contracts";
import { assertRecoveryDiscoveryId, assertRecoveryDiscoveryTimestamp } from "./recovery-discovery-validation.js";

const diagnosticKinds = new Set(["continuation", "tool_execution", "evaluation", "delegation"]);

export type HarnessDiagnosticsStoreErrorCode =
  | "diagnostics.invalid_query"
  | "diagnostics.lineage_mismatch"
  | "diagnostics.record_invalid";

/** Diagnostic failures are explicit; neither malformed input nor damaged metadata becomes an empty page. */
export class HarnessDiagnosticsStoreError extends Error {
  constructor(readonly code: HarnessDiagnosticsStoreErrorCode, message: string) {
    super(message);
    this.name = "HarnessDiagnosticsStoreError";
  }
}

export const HARNESS_DIAGNOSTIC_DEFAULT_LIMIT = 100;
export const HARNESS_DIAGNOSTIC_MAX_LIMIT = 500;

export function harnessDiagnosticIdentity(value: unknown): string {
  try {
    assertRecoveryDiscoveryId(value);
    return value;
  } catch {
    return invalidQuery();
  }
}

/** Capture data properties only; do not execute caller getters or accept inherited cursor identity. */
function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) invalidQuery();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalidQuery();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string" || !allowed.includes(key)) invalidQuery();
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) invalidQuery();
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return invalidQuery();
  }
}

export function validateHarnessDiagnosticQuery(
  runId: string, workUnitId: string, input: HarnessDiagnosticQueryV1 | undefined,
): { readonly limit: number; readonly cursor?: HarnessDiagnosticCursorV1 } {
  harnessDiagnosticIdentity(runId);
  harnessDiagnosticIdentity(workUnitId);
  const query = input === undefined ? {} : fields(input, ["limit", "cursor"]);
  const limit = query.limit === undefined ? HARNESS_DIAGNOSTIC_DEFAULT_LIMIT : query.limit;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > HARNESS_DIAGNOSTIC_MAX_LIMIT) {
    invalidQuery();
  }
  if (query.cursor === undefined) return { limit };
  const cursor = fields(query.cursor, ["runId", "workUnitId", "createdAt", "kind", "id"]);
  if (cursor.runId !== runId || cursor.workUnitId !== workUnitId
    || typeof cursor.kind !== "string" || !diagnosticKinds.has(cursor.kind)) invalidQuery();
  const id = harnessDiagnosticIdentity(cursor.id);
  try { assertRecoveryDiscoveryTimestamp(cursor.createdAt, "cursor creation time"); } catch { invalidQuery(); }
  return { limit, cursor: {
    runId, workUnitId, createdAt: cursor.createdAt, kind: cursor.kind as HarnessDiagnosticCursorV1["kind"], id,
  } };
}

function invalidQuery(): never {
  throw new HarnessDiagnosticsStoreError("diagnostics.invalid_query", "Invalid Harness diagnostics query or cursor.");
}
