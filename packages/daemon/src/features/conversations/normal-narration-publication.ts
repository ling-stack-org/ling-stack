import type { ControlPlaneEvent, RunStore, PublishNormalRunNarrationResult } from "@ling-stack/core";
import { setImmediate } from "node:timers/promises";

const publishers = new WeakMap<RunStore, (event: ControlPlaneEvent) => void>();

export function configureNormalNarrationPublication(store: RunStore, publish: (event: ControlPlaneEvent) => void): void {
  publishers.set(store, publish);
}

/** Derived publication failure must never roll back or relabel the actual execution outcome. */
export function publishNormalNarrationAfterRun(store: RunStore, runId: string, now: string): PublishNormalRunNarrationResult | undefined {
  let result: PublishNormalRunNarrationResult;
  try { result = store.publishNormalRunNarration(runId, now); }
  catch { recordFailure(store, runId, now, "publication_storage_error"); return undefined; }
  if (result.ok) {
    if (!result.duplicate) {
      // The durable outbox already committed. Transport failure is recovered by replay.
      try { publishers.get(store)?.(result.event); } catch { /* durable event remains available */ }
    }
  } else if (!["unsupported_surface", "run_not_terminal", "stale_run", "narration_empty"].includes(result.code)) {
    recordFailure(store, runId, now, result.code);
  }
  return result;
}

/** Keyset pagination cannot silently stop recovery at the Run list's 200-row UI cap. */
export async function recoverNormalNarrationPublications(store: RunStore, now: string): Promise<void> {
  let afterRunId = "";
  for (;;) {
    // Startup stays responsive; no SQLite transaction crosses this yield.
    await setImmediate();
    const ids = store.listUnpublishedNormalNarrationRunIds(afterRunId, 100);
    if (!ids.length) return;
    for (let index = 0; index < ids.length; index += 1) {
      publishNormalNarrationAfterRun(store, ids[index]!, now);
      if (index % 10 === 9) await setImmediate();
    }
    const next = ids.at(-1)!;
    if (next <= afterRunId) throw new Error("Narration recovery cursor did not advance");
    afterRunId = next;
  }
}

function recordFailure(store: RunStore, runId: string, now: string, code: string): void {
  try {
    const run = store.getRun(runId), thread = run?.threadId ? store.getLingThread(run.threadId) : undefined;
    if (!run || !thread || thread.kind !== "conversation") return;
    const event = store.appendControlPlaneEvent({
      cwd: store.paths.cwd, workspaceId: thread.workspaceId, domain: "work_units", entityType: "conversation_item",
      entityId: `narration:${runId}`, action: "conversation_narration.publication_failed",
      idempotencyKey: `normal-run-narration:${runId}:failure:${code}`,
      data: { threadId: thread.id, runId, code },
    }, now);
    publishers.get(store)?.(event);
  } catch {
    // Storage/transport may both be unavailable; the missing item remains a recovery candidate.
    // Never log raw provider text, credentials or database payloads from the caught exception.
  }
}
