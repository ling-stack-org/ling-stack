import type { RunStore } from "@ling-stack/core";
import { DuplicateRunRequestError } from "./concurrency.js";

/** A preparation loser cannot clear another dispatch's durable execution linkage. */
export function failUnlinkedPreparationThread(
  store: RunStore,
  threadId: string,
  turnId: string | undefined,
  error: unknown,
  now: string,
): void {
  if (error instanceof DuplicateRunRequestError || store.getLingThread(threadId)?.activeRunId
    || turnId && store.listLingTurnRuns(turnId).length > 0) return;
  store.updateLingThread(threadId, { status: "failed", activeRunId: null }, now);
}
