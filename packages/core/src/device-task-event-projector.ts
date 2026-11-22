import {
  DEVICE_TASK_JOURNAL_PUBLIC_EVENTS_V1, isDeviceTaskV1,
  type DeviceEventEnvelopeV1, type DeviceTaskJournalPageV1, type DeviceTaskV1, type JsonValue,
} from "@ling-stack/contracts";

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
    const task = requireWorkspaceDeviceTask(store, taskId, workspaceId);
    const streamId = `device-task:${task.id}`;
    const latestSequence = store.countEvents(task.id);
    const requiresSnapshot = generation !== 1 || afterSequence > latestSequence;
    const events = requiresSnapshot ? [] : store.listEvents(task.id, { offset: afterSequence, limit })
      .map(event => projectEvent(store, event, streamId, task.ownerId));
    return {
      streamId, generation: 1, latestSequence, task, events,
      hasMore: !requiresSnapshot && afterSequence + events.length < latestSequence,
      requiresSnapshot,
    };
  });
}

export function requireWorkspaceDeviceTask(store: SqliteDeviceSupportStore, taskId: string, workspaceId: string): DeviceTaskV1 {
  const task = store.getTask(taskId);
  if (!task || task.ownerKind !== "daemon" || task.targetDeviceIds.length === 0
    || task.targetDeviceIds.some(id => store.getDevice(id)?.device.ownerScope !== workspaceId)) {
    throw new DeviceBrokerError("missing_target", "device task is unavailable in this workspace");
  }
  return task;
}

type EventView = Pick<DeviceEventEnvelopeV1, "kind" | "sourceKind" | "payload" | "evidenceRefs">;

function projectEvent(
  store: SqliteDeviceSupportStore, event: DeviceTaskEvent, streamId: string, ownerId: string,
): DeviceEventEnvelopeV1 {
  return {
    eventId: `${streamId}:${event.rowSequence}`, traceId: streamId, streamId, generation: 1,
    sourceId: ownerId, sequence: event.sequence, occurredAt: event.createdAt, redactionClass: "public", retentionClass: "durable",
    ...publicEventView(store, event),
  };
}

function publicEventView(store: SqliteDeviceSupportStore, event: DeviceTaskEvent): EventView {
  const { type: kind, body } = event;
  const publicEvents = DEVICE_TASK_JOURNAL_PUBLIC_EVENTS_V1;
  if (kind === "task_created") {
    return { kind, sourceKind: publicEvents[kind].sourceKind, payload: isDeviceTaskV1(body.task) ? { status: body.task.status } : {} };
  }
  if (kind === "observation_recorded") {
    if (typeof body.observationId === "string" && store.hasPublicObservation(event.taskId, body.observationId)) {
      return { kind, sourceKind: publicEvents[kind].sourceKind, payload: { observationId: body.observationId }, evidenceRefs: [body.observationId] };
    }
  } else if (Object.hasOwn(publicEvents, kind)) {
    const schema = publicEvents[kind as keyof typeof publicEvents];
    return { kind, sourceKind: schema.sourceKind, payload: fields(body, schema.fields) };
  }
  return { kind: "journal_changed", sourceKind: "runtime", payload: {} };
}

function fields(body: Record<string, unknown>, keys: readonly string[]): JsonValue {
  const result: Record<string, string> = {};
  for (const key of keys) {
    if (typeof body[key] === "string") result[key] = body[key];
  }
  return result;
}
