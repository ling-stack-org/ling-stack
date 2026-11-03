import type { RunSession, RunStore, WorkUnit } from "@ling-stack/core";
import { isRecord } from "../../dist/shared/validation.js";

interface DiscoverySeed {
  run: RunSession;
  unit: WorkUnit;
}

export function seedBlockedStalePrefix(store: RunStore, providerPresetId: string, seeded: DiscoverySeed, count = 500): void {
  if (!isRecord(seeded.run.requestSnapshot)) throw new Error("Discovery fixture requires a frozen request snapshot");
  for (let index = 0; index < count; index += 1) {
    const id = `z-blocked-${seeded.unit.kind}-${String(index).padStart(4, "0")}`;
    const unit = store.createWorkUnit({ id: `unit-${id}`, workspaceId: "workspace_default", kind: seeded.unit.kind,
      ownerType: seeded.unit.ownerType, ownerId: seeded.unit.ownerId,
      channelId: seeded.unit.channelId, taskId: seeded.unit.taskId, teammateId: seeded.unit.teammateId,
      runnerId: "pi", effectiveRunnerId: "pi", providerPresetId, idempotencyKey: id, status: "stale",
      request: {}, createdByActor: "system", now: seeded.unit.createdAt });
    store.createWorkUnitAttempt({ id: `attempt-${id}`, workUnitId: unit.id, attemptNumber: 1,
      runtimeInstanceId: "runtime-before-restart", runnerId: "pi", status: "lost", now: seeded.unit.createdAt });
    const run = store.createRun({ ...seeded.run, id: `run-${id}`, workUnitId: unit.id, createdAt: seeded.unit.createdAt });
    store.linkRunToWorkUnit(run.id, unit.id, seeded.unit.createdAt);
    store.markRunCancelled(run.id, seeded.unit.createdAt);
  }
}
