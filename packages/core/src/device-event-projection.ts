import type { DeviceEventEnvelopeV1, JsonValue } from "@ling-stack/contracts";
import { DeviceFabricError } from "./device-fabric.js";
import type { DeviceEventReadResult, DeviceSnapshotRecord } from "./storage/sqlite/device-fabric-store.js";

export interface DeviceEventProjectionStore {
  readEvents(streamId: string, generation: number, afterSequence: number, limit: number): DeviceEventReadResult;
  getSnapshot(streamId: string, generation: number): DeviceSnapshotRecord | undefined;
  saveSnapshot(input: Omit<DeviceSnapshotRecord, "createdAt"> & { readonly createdAt?: string }): DeviceSnapshotRecord;
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
