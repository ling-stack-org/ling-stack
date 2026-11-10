import type { ExecutionCancellationRequest } from "@ling-stack/contracts";
import { isRecord } from "./validation.js";

export function parseExecutionCancellationRequest(value: unknown): ExecutionCancellationRequest {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error("Cancellation request must be an object");
  const result: { expectedAttemptId?: string | null; expectedRunId?: string | null } = {};
  for (const key of ["expectedAttemptId", "expectedRunId"] as const) {
    const id = value[key];
    if (id === undefined) continue;
    if (id !== null && (typeof id !== "string" || !id.trim() || id !== id.trim())) {
      throw new Error(`${key} must be a non-empty identifier or null`);
    }
    result[key] = id as string | null;
  }
  return result;
}
