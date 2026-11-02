import type { LingThread, RunSession, RunStore, WorkUnit } from "@ling-stack/core";
import { isRecord } from "../../dist/shared/validation.js";

interface DiscoverySeed {
  run: RunSession;
  unit: WorkUnit;
  thread: LingThread;
}

export function seedBlockedStalePrefix(store: RunStore, providerPresetId: string, seeded: DiscoverySeed, count = 500): void {
  if (!isRecord(seeded.run.requestSnapshot)) throw new Error("Discovery fixture requires a frozen request snapshot");
  for (let index = 0; index < count; index += 1) {
    const id = `z-blocked-${seeded.unit.kind}-${String(index).padStart(4, "0")}`;
    // Create/cancel rebuild thread metadata. A private thread keeps each read
    // bounded to one Run instead of repeatedly reading the growing prefix.
    const thread = store.createLingThread({ kind: seeded.thread.kind, channelId: seeded.thread.channelId,
      taskId: seeded.thread.taskId, teammateId: seeded.thread.teammateId, title: id,
      objective: seeded.thread.objective, conversationMode: seeded.thread.conversationMode }, seeded.unit.createdAt);
    const turn = store.createLingTurn({ threadId: thread.id, kind: "initial_request", title: id,
      userInstruction: seeded.thread.objective, channelId: seeded.unit.channelId, taskId: seeded.unit.taskId,
      createdByActor: "local-user" }, seeded.unit.createdAt);
    const unit = store.createWorkUnit({ id: `unit-${id}`, workspaceId: "workspace_default", kind: seeded.unit.kind,
      ownerType: seeded.unit.ownerType, ownerId: seeded.unit.ownerType === "task" ? seeded.unit.ownerId : turn.id,
      channelId: seeded.unit.channelId, taskId: seeded.unit.taskId, teammateId: seeded.unit.teammateId,
      runnerId: "pi", effectiveRunnerId: "pi", providerPresetId, idempotencyKey: id, status: "stale",
      request: {}, createdByActor: "system", now: seeded.unit.createdAt });
    store.createWorkUnitAttempt({ id: `attempt-${id}`, workUnitId: unit.id, attemptNumber: 1,
      runtimeInstanceId: "runtime-before-restart", runnerId: "pi", status: "lost", now: seeded.unit.createdAt });
    const run = store.createRun({ ...seeded.run, id: `run-${id}`, workUnitId: unit.id,
      threadId: thread.id, turnId: turn.id, turnRunRole: "primary",
      requestSnapshot: { ...seeded.run.requestSnapshot, threadId: thread.id, turnId: turn.id },
      createdAt: seeded.unit.createdAt });
    store.linkRunToWorkUnit(run.id, unit.id, seeded.unit.createdAt);
    store.markRunCancelled(run.id, seeded.unit.createdAt);
  }
}
