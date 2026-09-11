/** Immutable Host-owned boundary in one Run event log, never a tool or completion fact. */
export interface UserInputRunEventPositionV1 {
  readonly runId: string;
  readonly attemptId: string;
  readonly afterEventSequence: number;
  readonly afterEventId?: string;
}

export function isUserInputRunEventPositionV1(value: unknown): value is UserInputRunEventPositionV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).every(key => ["runId", "attemptId", "afterEventSequence", "afterEventId"].includes(key))
    && text(row.runId) && text(row.attemptId) && typeof row.afterEventSequence === "number"
    && Number.isSafeInteger(row.afterEventSequence) && row.afterEventSequence >= 0
    && (row.afterEventSequence === 0 ? row.afterEventId === undefined : text(row.afterEventId));
}
function text(value: unknown): boolean { return typeof value === "string" && value.trim().length > 0 && value.length <= 256; }
