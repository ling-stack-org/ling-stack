import type { DeviceEventEnvelopeV1, JsonValue, LingServerPeerFrameV1 } from "@ling-stack/contracts";
import { DeviceFabricError } from "./device-fabric.js";
import type { DeviceEventReadResult, DeviceSnapshotRecord } from "./storage/sqlite/device-fabric-store.js";
import type { LingServerPeerSessionCoordinator } from "./ling-server.js";

export interface DeviceEventProjectionStore {
  readEvents(streamId: string, generation: number, afterSequence: number, limit: number): DeviceEventReadResult;
  getSnapshot(streamId: string, generation: number): DeviceSnapshotRecord | undefined;
  saveSnapshot(input: Omit<DeviceSnapshotRecord, "createdAt"> & { readonly createdAt?: string }): DeviceSnapshotRecord;
}

export interface DeviceEventAppendStore {
  appendEvent(event: DeviceEventEnvelopeV1, now?: string): { readonly event: DeviceEventEnvelopeV1; readonly replayed: boolean };
}

export interface DevicePeerEventPublishResult {
  readonly frame: LingServerPeerFrameV1;
  readonly replayed: boolean;
}

export interface DevicePeerEventReceiveResult {
  readonly frame: LingServerPeerFrameV1;
  readonly event: DeviceEventEnvelopeV1;
  readonly replayed: boolean;
}

export interface DevicePeerSnapshotReceiveResult {
  readonly frame: LingServerPeerFrameV1;
  readonly snapshot: DeviceSnapshotRecord;
  readonly replayed: boolean;
}

/** Binds owner-stream events to the authenticated peer session without exposing transport internals to projections. */
export class DevicePeerEventSynchronizer {
  readonly #sessions: LingServerPeerSessionCoordinator;
  readonly #store: DeviceEventAppendStore & DeviceEventProjectionStore;
  readonly #now: () => string;

  constructor(input: { readonly sessions: LingServerPeerSessionCoordinator; readonly store: DeviceEventAppendStore & DeviceEventProjectionStore; readonly now?: () => string }) {
    this.#sessions = input.sessions;
    this.#store = input.store;
    this.#now = input.now ?? (() => new Date().toISOString());
  }

  publish(sessionId: string, event: DeviceEventEnvelopeV1, direction: LingServerPeerFrameV1["direction"] = "to_mobile"): DevicePeerEventPublishResult {
    const result = this.#sessions.sendFrame(sessionId, {
      frameId: `event:${event.eventId}`,
      direction,
      kind: "device_task",
      payload: { type: "device_event", event: event as unknown as JsonValue } as unknown as JsonValue,
      sentAt: this.#now(),
    });
    return result;
  }

  publishSnapshot(sessionId: string, snapshot: DeviceSnapshotRecord, direction: LingServerPeerFrameV1["direction"] = "to_mobile"): DevicePeerEventPublishResult {
    assertSnapshot(snapshot);
    return this.#sessions.sendFrame(sessionId, {
      frameId: "snapshot:" + snapshot.streamId + ":" + snapshot.generation + ":" + snapshot.sequence,
      direction,
      kind: "device_task",
      payload: { type: "device_snapshot", snapshot: snapshot as unknown as JsonValue } as unknown as JsonValue,
      sentAt: this.#now(),
    });
  }

  receive(frame: LingServerPeerFrameV1): DevicePeerEventReceiveResult {
    const accepted = this.#sessions.acceptFrame(frame);
    const event = readPeerEvent(frame.payload);
    const stored = this.#store.appendEvent(event, this.#now());
    return { frame: accepted.frame, event: stored.event, replayed: accepted.replayed || stored.replayed };
  }

  receiveSnapshot(frame: LingServerPeerFrameV1): DevicePeerSnapshotReceiveResult {
    const accepted = this.#sessions.acceptFrame(frame);
    const snapshot = readPeerSnapshot(frame.payload);
    const saved = this.#store.saveSnapshot(snapshot);
    return { frame: accepted.frame, snapshot: saved, replayed: accepted.replayed };
  }
}

export interface DeviceEventProjectionSyncResult {
  readonly status: "applied" | "resync_required";
  readonly streamId: string;
  readonly generation: number;
  readonly sequence: number;
  readonly snapshot: JsonValue;
  readonly eventsApplied: number;
  readonly hasMore: boolean;
  readonly reason?: "cursor_stale" | "sequence_gap" | "snapshot_missing";
}

export class DeviceEventProjector {
  readonly #store: DeviceEventProjectionStore;
  readonly #streamId: string;
  readonly #generation: number;
  readonly #apply: (snapshot: JsonValue, event: DeviceEventEnvelopeV1) => JsonValue;
  readonly #now: () => string;

  constructor(input: {
    readonly store: DeviceEventProjectionStore;
    readonly streamId: string;
    readonly generation?: number;
    readonly apply: (snapshot: JsonValue, event: DeviceEventEnvelopeV1) => JsonValue;
    readonly now?: () => string;
  }) {
    if (!input.streamId.trim()) throw new Error("streamId is required");
    this.#store = input.store;
    this.#streamId = input.streamId;
    this.#generation = input.generation ?? 1;
    this.#apply = input.apply;
    this.#now = input.now ?? (() => new Date().toISOString());
  }

  sync(initialSnapshot: JsonValue, limit = 100): DeviceEventProjectionSyncResult {
    const stored = this.#store.getSnapshot(this.#streamId, this.#generation);
    let sequence = stored?.sequence ?? 0;
    let snapshot = stored?.snapshot ?? initialSnapshot;
    let result: DeviceEventReadResult;
    try {
      result = this.#store.readEvents(this.#streamId, this.#generation, sequence, limit);
    } catch (error) {
      if (error instanceof DeviceFabricError && error.code === "revision_conflict") {
        return {
          status: stored ? "resync_required" : "resync_required",
          streamId: this.#streamId,
          generation: this.#generation,
          sequence,
          snapshot,
          eventsApplied: 0,
          hasMore: false,
          reason: stored ? "cursor_stale" : "snapshot_missing",
        };
      }
      throw error;
    }
    if (result.hasGap) {
      return {
        status: "resync_required",
        streamId: this.#streamId,
        generation: this.#generation,
        sequence,
        snapshot,
        eventsApplied: 0,
        hasMore: false,
        reason: "sequence_gap",
      };
    }
    for (const event of result.events) {
      if (event.sequence !== sequence + 1) {
        return {
          status: "resync_required",
          streamId: this.#streamId,
          generation: this.#generation,
          sequence,
          snapshot,
          eventsApplied: 0,
          hasMore: false,
          reason: "sequence_gap",
        };
      }
      snapshot = this.#apply(snapshot, event);
      sequence = event.sequence;
    }
    if (result.events.length > 0) this.#store.saveSnapshot({ streamId: this.#streamId, generation: this.#generation, sequence, snapshot, createdAt: this.#now() });
    return {
      status: "applied",
      streamId: this.#streamId,
      generation: this.#generation,
      sequence,
      snapshot,
      eventsApplied: result.events.length,
      hasMore: result.latestSequence !== undefined && result.latestSequence > sequence,
    };
  }
}

function readPeerEvent(value: JsonValue): DeviceEventEnvelopeV1 {
  if (!isRecord(value) || value.type !== "device_event" || !isRecord(value.event)) throw new DeviceFabricError("revision_conflict", "peer frame does not contain a device event");
  const event = value.event;
  if (typeof event.eventId !== "string" || typeof event.traceId !== "string" || typeof event.sourceKind !== "string" || typeof event.sourceId !== "string" || typeof event.sequence !== "number" || !Number.isInteger(event.sequence) || event.sequence < 1 || typeof event.kind !== "string" || typeof event.occurredAt !== "string") {
    throw new DeviceFabricError("revision_conflict", "peer device event is malformed");
  }
  return event as unknown as DeviceEventEnvelopeV1;
}

function readPeerSnapshot(value: JsonValue): DeviceSnapshotRecord {
  if (!isRecord(value) || value.type !== "device_snapshot" || !isRecord(value.snapshot)) {
    throw new DeviceFabricError("revision_conflict", "peer frame does not contain a device snapshot");
  }
  const snapshot = value.snapshot;
  if (typeof snapshot.streamId !== "string" || !snapshot.streamId.trim()
    || typeof snapshot.generation !== "number" || !Number.isSafeInteger(snapshot.generation) || snapshot.generation < 1
    || typeof snapshot.sequence !== "number" || !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0
    || typeof snapshot.createdAt !== "string" || !Number.isFinite(Date.parse(snapshot.createdAt))
    || !Object.hasOwn(snapshot, "snapshot")) {
    throw new DeviceFabricError("revision_conflict", "peer device snapshot is malformed");
  }
  return snapshot as unknown as DeviceSnapshotRecord;
}

function assertSnapshot(snapshot: DeviceSnapshotRecord): void {
  if (!snapshot.streamId.trim() || !Number.isSafeInteger(snapshot.generation) || snapshot.generation < 1
    || !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0 || !Number.isFinite(Date.parse(snapshot.createdAt))) {
    throw new DeviceFabricError("revision_conflict", "device snapshot is invalid");
  }
}

function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
