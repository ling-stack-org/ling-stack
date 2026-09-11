import { isDeepStrictEqual } from "node:util";
import type { LingThread, LingTurn, RunIntervention, RunSession, RunStore } from "@ling-stack/core";

/** Validate durable Host origin before accepting a new normal continuation source. */
export function requireNormalContinuationSource(input: {
  readonly store: RunStore;
  readonly thread: LingThread;
  readonly sourceRun: RunSession;
  readonly intervention: RunIntervention;
}): LingTurn {
  const { store, thread, sourceRun, intervention } = input;
  const persisted = store.getRunIntervention(intervention.id);
  const run = store.getRun(sourceRun.id);
  const turn = store.getLingTurnForRun(sourceRun.id);
  if (!persisted || !run || !turn || thread.kind !== "conversation" || thread.channelId ||
    turn.threadId !== thread.id || run.threadId !== thread.id || turn.workspaceId !== thread.workspaceId ||
    persisted.workspaceId !== thread.workspaceId || persisted.sourceRunId !== run.id ||
    (persisted.requestedBy !== "local-user" && persisted.requestedBy !== "system") ||
    ["sourceRunId", "requestedBy", "mode", "instruction", "messagePayload"].some((key) =>
      !isDeepStrictEqual(Reflect.get(persisted, key), Reflect.get(intervention, key))) ||
    ["cwd", "taskId", "threadId", "teammateId", "requestSnapshot", "taskSnapshot", "providerSnapshot"].some((key) =>
      !isDeepStrictEqual(Reflect.get(run, key), Reflect.get(sourceRun, key)))) {
    throw new Error("Normal continuation intervention source mismatch");
  }
  return turn;
}
