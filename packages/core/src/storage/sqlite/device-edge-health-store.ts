import type { SQLOutputValue } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

import {
  EDGE_LOCAL_NETWORK_CAPABILITY_ID,
  type DeviceEventEnvelopeV1, type EdgeRuntimeHealthAdmissionV1, type EdgeRuntimeHealthPageV1, type EdgeRuntimeHealthSampleV1,
} from "@ling-stack/contracts";

import { DeviceFabricError } from "../../device-fabric.js";
import { parseJson } from "./helpers.js";
import type { DeviceEventReadResult, SqliteDeviceFabricStore } from "./device-fabric-store.js";

const edgeHealthSampleIntervalMs = 5_000;
const edgeHealthSampleMaxAgeMs = 2 * 60_000;
const edgeHealthMaxClockAheadMs = 5_000;

export interface EdgeHealthRecordInput {
  readonly runtimeId: string;
  readonly runtimeRevision: number;
  readonly sample: EdgeRuntimeHealthSampleV1;
  readonly now: string;
  readonly authorize: () => void;
}

export interface EdgeHealthPageInput {
  readonly runtimeId: string;
  readonly generation?: number;
  readonly afterSequence: number;
  readonly limit: number;
  readonly now: string;
}

type EdgeHealthStore = Pick<SqliteDeviceFabricStore, "database" | "getEdgeRuntime" | "readEvents">;

export function recordEdgeRuntimeHealth(
  store: EdgeHealthStore,
  input: EdgeHealthRecordInput,
  insertEvent: (event: DeviceEventEnvelopeV1, streamId: string, generation: number, now: string) => void,
): EdgeRuntimeHealthAdmissionV1 {
  const { runtimeId, runtimeRevision, sample, now, authorize } = input;
  const receivedMs = Date.parse(now);
  const observedMs = Date.parse(sample.observedAt);
  const streamId = edgeHealthStreamId(runtimeId);
  const eventId = `${streamId}:${runtimeRevision}:${sample.sampleId}`;
  authorize();
  const enrolled = store.getEdgeRuntime(runtimeId);
  if (enrolled?.status !== "enrolled" || enrolled.revision !== runtimeRevision || !enrolled.supportedTransports.includes("local_process")) {
    throw new DeviceFabricError("safety_denied", "edge runtime health is outside the active enrollment");
  }
  if (!Number.isFinite(receivedMs) || !Number.isFinite(observedMs)
    || !/^[a-zA-Z0-9_-]{1,128}$/u.test(sample.sampleId) || typeof sample.connected !== "boolean") {
    throw new DeviceFabricError("revision_conflict", "edge runtime health sample is invalid");
  }
  const eventFields = {
    eventId, traceId: streamId, streamId, generation: runtimeRevision,
    sourceKind: "runtime", sourceId: runtimeId, kind: "edge.network_health",
    observedAt: sample.observedAt, payload: { connected: sample.connected },
    provenance: [runtimeId, EDGE_LOCAL_NETWORK_CAPABILITY_ID], quality: "good", redactionClass: "public", retentionClass: "telemetry",
  } as const;
  const saved = readHealthEvent(store.database.prepare("SELECT envelope_json FROM device_fabric_events WHERE event_id=?").get(eventId));
  if (saved) {
    if (!isDeepStrictEqual(saved, { ...eventFields, sequence: saved.sequence, occurredAt: saved.occurredAt })) {
      throw new DeviceFabricError("revision_conflict", "health sample identity already has different evidence");
    }
    return { status: "accepted", event: saved, replayed: true };
  }

  const latest = latestHealthEvent(store, streamId, runtimeRevision);
  if (observedMs > receivedMs + edgeHealthMaxClockAheadMs || observedMs <= receivedMs - edgeHealthSampleMaxAgeMs
    || (latest?.observedAt !== undefined && observedMs <= Date.parse(latest.observedAt))) {
    return { status: "stale" };
  }
  const nextSampleMs = latest ? Date.parse(latest.occurredAt) + edgeHealthSampleIntervalMs : receivedMs;
  if (receivedMs < nextSampleMs) return { status: "sampled", retryAfterMs: nextSampleMs - receivedMs };

  const event = { ...eventFields, sequence: (latest?.sequence ?? 0) + 1, occurredAt: now } satisfies DeviceEventEnvelopeV1;
  insertEvent(event, streamId, runtimeRevision, now);
  if (!enrolled.lastSeenAt || receivedMs > Date.parse(enrolled.lastSeenAt)) {
    store.database.prepare("UPDATE device_edge_runtimes SET runtime_json=? WHERE runtime_id=?")
      .run(JSON.stringify({ ...enrolled, lastSeenAt: now }), runtimeId);
  }
  return { status: "accepted", event, replayed: false };
}

export function readEdgeRuntimeHealthPage(store: EdgeHealthStore, input: EdgeHealthPageInput): EdgeRuntimeHealthPageV1 {
  const { runtimeId, afterSequence, limit, now } = input;
  const runtime = store.getEdgeRuntime(runtimeId);
  if (!runtime) throw new DeviceFabricError("target_missing", "edge runtime is missing");
  const runtimeRevision = runtime.revision;
  const runtimeStatus = runtime.status;
  const generation = runtimeStatus === "revoked" ? Math.max(1, runtimeRevision - 1) : runtimeRevision;
  const streamId = edgeHealthStreamId(runtimeId);
  const latestSample = latestHealthEvent(store, streamId, generation);
  const latestSequence = latestSample?.sequence ?? 0;
  const sampleState = latestSample === undefined ? "unavailable"
    : runtimeStatus !== "enrolled" || Date.parse(now) - Date.parse(latestSample.observedAt ?? latestSample.occurredAt) >= edgeHealthSampleMaxAgeMs
      ? "stale" : "fresh";
  let retained: DeviceEventReadResult | undefined;
  if ((input.generation ?? generation) === generation && afterSequence <= latestSequence) {
    try {
      retained = store.readEvents(streamId, generation, afterSequence, limit);
    } catch (error) {
      if (!(error instanceof DeviceFabricError && error.code === "revision_conflict")) throw error;
    }
  }
  const requiresSnapshot = retained === undefined || retained.hasGap;
  const events = retained && !retained.hasGap ? retained.events : [];
  return {
    runtimeId, runtimeRevision, runtimeStatus, streamId, generation, latestSequence, sampleState,
    ...(latestSample ? { latestSample } : {}),
    events, requiresSnapshot, hasMore: !requiresSnapshot && afterSequence + events.length < latestSequence,
  };
}

function latestHealthEvent(store: EdgeHealthStore, streamId: string, generation: number) {
  const row = store.database.prepare("SELECT envelope_json FROM device_fabric_events WHERE stream_id=? AND generation=? ORDER BY sequence DESC LIMIT 1")
    .get(streamId, generation);
  return readHealthEvent(row);
}

function readHealthEvent(row: Record<string, SQLOutputValue> | undefined): DeviceEventEnvelopeV1 | undefined {
  if (!row) return undefined;
  if (typeof row.envelope_json !== "string") throw new Error("Stored edge health event is not JSON");
  return parseJson(row.envelope_json) as DeviceEventEnvelopeV1;
}

function edgeHealthStreamId(runtimeId: string): string {
  return `edge-health:${runtimeId}`;
}
