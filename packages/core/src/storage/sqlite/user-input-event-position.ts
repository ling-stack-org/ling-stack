import { isUserInputRunEventPositionV1, type UserInputRunEventPositionV1 } from "@ling-stack/contracts";
import { UserInputStoreError, type UserInputSource } from "../../user-input-store-types.js";
import type { SqliteStoreContext } from "./store-context.js";

/** Capture only inside the existing request/answer write transaction. No event or clock is invented. */
export function captureUserInputRunEventPosition(context: SqliteStoreContext, source: UserInputSource): UserInputRunEventPositionV1 {
  const event = context.database.prepare("SELECT id,seq FROM run_events WHERE run_id=? ORDER BY seq DESC LIMIT 1").get(source.runId);
  const position = { runId: source.runId, attemptId: source.fence.attemptId,
    afterEventSequence: event ? Number(event.seq) : 0, ...(event ? { afterEventId: String(event.id) } : {}) };
  if (!isUserInputRunEventPositionV1(position)) throw new UserInputStoreError("invalid_record");
  return position;
}

/** Read a frozen boundary; never replace it with the current event tail. */
export function readUserInputRunEventPosition(context: SqliteStoreContext, value: unknown, source: UserInputSource)
  : UserInputRunEventPositionV1 | undefined {
  if (value === undefined) return undefined;
  if (!isUserInputRunEventPositionV1(value) || value.runId !== source.runId || value.attemptId !== source.fence.attemptId) {
    throw new UserInputStoreError("invalid_record");
  }
  if (value.afterEventSequence > 0 && !context.database.prepare("SELECT 1 FROM run_events WHERE run_id=? AND seq=? AND id=?")
    .get(value.runId, value.afterEventSequence, value.afterEventId!)) throw new UserInputStoreError("invalid_record");
  return { runId: value.runId, attemptId: value.attemptId, afterEventSequence: value.afterEventSequence,
    ...(value.afterEventId ? { afterEventId: value.afterEventId } : {}) };
}
