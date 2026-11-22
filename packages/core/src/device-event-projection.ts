import { randomUUID } from "node:crypto";

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

interface DevicePeerStreamScope {
  readonly sessionId: string;
  readonly streamId: string;
  readonly generation: number;
}

/** Binds owner-stream events to the authenticated peer session without exposing transport internals to projections. */
export class DevicePeerEventSynchronizer {
  readonly #sessions: LingServerPeerSessionCoordinator;
  readonly #store: DeviceEventAppendStore & Pick<DeviceEventProjectionStore, "getSnapshot" | "saveSnapshot">;
  readonly #scope: DevicePeerStreamScope;
  readonly #now: () => string;

  constructor(input: {
    readonly sessions: LingServerPeerSessionCoordinator;
    readonly store: DeviceEventAppendStore & Pick<DeviceEventProjectionStore, "getSnapshot" | "saveSnapshot">;
    readonly scope: DevicePeerStreamScope;
    readonly now?: () => string;
  }) {
    this.#sessions = input.sessions;
    this.#store = input.store;
    this.#scope = { ...input.scope };
    this.#now = input.now ?? (() => new Date().toISOString());
  }

  publish(sessionId: string, event: DeviceEventEnvelopeV1, direction: LingServerPeerFrameV1["direction"] = "to_mobile"): DevicePeerEventPublishResult {
    this.requireScope(sessionId, event.streamId ?? `${event.sourceKind}:${event.sourceId}`, event.generation ?? 1);
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
    this.requireScope(sessionId, snapshot.streamId, snapshot.generation);
    const payload: JsonValue = { type: "device_snapshot", snapshot: { ...snapshot } };
    readPeerSnapshot(payload);
    return this.#sessions.sendFrame(sessionId, {
      frameId: `snapshot:${randomUUID()}`,
      direction,
      kind: "device_task",
      payload,
      sentAt: this.#now(),
    });
  }

  receive(frame: LingServerPeerFrameV1): DevicePeerEventReceiveResult {
    if (frame.kind !== "device_task") throw new DeviceFabricError("invalid_graph", "peer frame must carry device task evidence");
    const event = readPeerEvent(frame.payload);
    this.requireScope(frame.sessionId, event.streamId ?? `${event.sourceKind}:${event.sourceId}`, event.generation ?? 1);
    const accepted = this.#sessions.acceptFrame(frame);
    const stored = this.#store.appendEvent(event, this.#now());
    return { frame: accepted.frame, event: stored.event, replayed: accepted.replayed || stored.replayed };
  }

  receiveSnapshot(frame: LingServerPeerFrameV1): DevicePeerSnapshotReceiveResult {
    if (frame.kind !== "device_task") throw new DeviceFabricError("invalid_graph", "peer frame must carry device task evidence");
    const snapshot = readPeerSnapshot(frame.payload);
    this.requireScope(frame.sessionId, snapshot.streamId, snapshot.generation);
    const accepted = this.#sessions.acceptFrame(frame);
    const previous = this.#store.getSnapshot(snapshot.streamId, snapshot.generation);
    const saved = this.#store.saveSnapshot(snapshot);
    return {
      frame: accepted.frame, snapshot: saved,
      replayed: saved.sequence > snapshot.sequence || (previous !== undefined && previous.sequence === snapshot.sequence),
    };
  }

  private requireScope(sessionId: string, streamId: string, generation: number): void {
    if (sessionId !== this.#scope.sessionId || streamId !== this.#scope.streamId || generation !== this.#scope.generation) {
      throw new DeviceFabricError("safety_denied", "device stream does not match the authorized peer session");
    }
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
          status: "resync_required",
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
    if (result.hasGap || result.events.some((event, index) => event.sequence !== sequence + index + 1)) {
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
      snapshot = this.#apply(snapshot, event);
      sequence = event.sequence;
    }
    let eventsApplied = result.events.length;
    if (eventsApplied > 0) {
      const saved = this.#store.saveSnapshot({ streamId: this.#streamId, generation: this.#generation, sequence, snapshot, createdAt: this.#now() });
      if (saved.sequence > sequence) eventsApplied = 0;
      sequence = saved.sequence;
      snapshot = saved.snapshot;
    }
    return {
      status: "applied",
      streamId: this.#streamId,
      generation: this.#generation,
      sequence,
      snapshot,
      eventsApplied,
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
  const { streamId, generation, sequence, createdAt, snapshot } = value.snapshot;
  if (typeof streamId !== "string" || !streamId.trim() || streamId.length > 512
    || typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1
    || typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0
    || typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))
    || snapshot === undefined || Object.keys(value.snapshot).length !== 5) {
    throw new DeviceFabricError("revision_conflict", "peer device snapshot is malformed");
  }
  return { streamId, generation, sequence, createdAt, snapshot };
}

function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
