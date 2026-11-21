import { isDeviceTaskV1, type DeviceEventEnvelopeV1, type DeviceTaskJournalPageV1, type JsonValue } from "@ling-stack/contracts";

import { DeviceBrokerError } from "./device-support.js";
import type { DeviceTaskEvent, SqliteDeviceSupportStore } from "./storage/sqlite/device-support-store.js";
import { readSqliteSnapshot } from "./storage/sqlite/read-snapshot.js";

export function readOwnedDeviceTaskJournal(input: {
  readonly store: SqliteDeviceSupportStore;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly generation?: number;
  readonly afterSequence?: number;
  readonly limit?: number;
}): DeviceTaskJournalPageV1 {
  const { store, taskId, workspaceId } = input;
  const generation = input.generation ?? 1;
  const afterSequence = input.afterSequence ?? 0;
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(generation) || generation < 1 || !Number.isSafeInteger(afterSequence) || afterSequence < 0
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new DeviceBrokerError("invalid_request", "device journal cursor or page size is invalid");
  }
  return readSqliteSnapshot(store.database, () => {
    const task = store.getTask(taskId);
    if (!task || task.ownerKind !== "daemon" || task.targetDeviceIds.length === 0
      || task.targetDeviceIds.some(id => store.getDevice(id)?.device.ownerScope !== workspaceId)) {
      throw new DeviceBrokerError("missing_target", "device journal is unavailable in this workspace");
    }
    const streamId = `device-task:${task.id}`;
    const latestSequence = store.countEvents(task.id);
    const requiresSnapshot = generation !== 1 || afterSequence > latestSequence;
    const events = requiresSnapshot ? [] : store.listEvents(task.id, { offset: afterSequence, limit })
      .map((event, index) => projectEvent(store, event, streamId, task.ownerId, afterSequence + index + 1));
    return {
      streamId, generation: 1, latestSequence, task, events,
      hasMore: !requiresSnapshot && afterSequence + events.length < latestSequence,
      requiresSnapshot,
    };
  });
}

type EventView = Pick<DeviceEventEnvelopeV1, "kind" | "sourceKind" | "payload" | "evidenceRefs">;

function projectEvent(
  store: SqliteDeviceSupportStore, event: DeviceTaskEvent, streamId: string, ownerId: string, sequence: number,
): DeviceEventEnvelopeV1 {
  return {
    eventId: `${streamId}:${event.sequence}`, traceId: streamId, streamId, generation: 1,
    sourceId: ownerId, sequence, occurredAt: event.createdAt, redactionClass: "public", retentionClass: "durable",
    ...publicEventView(store, event),
  };
}

function publicEventView(store: SqliteDeviceSupportStore, event: DeviceTaskEvent): EventView {
  const { type: kind, body } = event;
  switch (kind) {
    case "task_created":
      return { kind, sourceKind: "runtime", payload: isDeviceTaskV1(body.task) ? { status: body.task.status } : {} };
    case "task_transition":
      return { kind, sourceKind: "runtime", payload: fields(body, "from", "to") };
    case "device_plan_accepted":
      return { kind, sourceKind: "graph", payload: fields(body, "proposalId", "contextId", "source") };
    case "attempt_prepared":
      return { kind, sourceKind: "runtime", payload: fields(body, "attemptId", "actionId") };
    case "attempt_updated":
      return { kind, sourceKind: "runtime", payload: fields(body, "attemptId", "status", "receiptStatus", "verificationStatus") };
    case "task_stop_requested":
      return { kind, sourceKind: "runtime", payload: fields(body, "attemptId", "status") };
    case "attempt_reconciled":
      return { kind, sourceKind: "verification", payload: fields(body, "attemptId", "status", "reconciliationId") };
    case "observation_recorded":
      if (typeof body.observationId === "string" && store.hasPublicObservation(event.taskId, body.observationId)) {
        return { kind, sourceKind: "adapter", payload: { observationId: body.observationId }, evidenceRefs: [body.observationId] };
      }
      break;
  }
  return { kind: "journal_changed", sourceKind: "runtime", payload: {} };
}

function fields(body: Record<string, unknown>, ...keys: string[]): JsonValue {
  const result: Record<string, string> = {};
  for (const key of keys) {
    if (typeof body[key] === "string") result[key] = body[key];
  }
  return result;
}
