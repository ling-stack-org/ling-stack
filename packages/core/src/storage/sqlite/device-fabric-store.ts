import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

import {
  isDeviceResourceManifestV1,
  type DeviceConformanceReportV1,
  type DeviceCredentialRevisionV1,
  type DeviceAccessGrantV1,
  type DeviceEventEnvelopeV1,
  type DeviceGraphNodeV1,
  type DeviceGraphRelationshipV1,
  type DeviceIdentityChangeV1,
  type DeviceLifecycleRecordV1,
  type DeviceOwnershipRevisionV1,
  type DeviceResourceManifestV1,
  type DeviceSecretUseV1,
  type DeviceTaskGraphV1,
  type DeviceTraceSpanV1,
  type DeviceTwinV1,
  type EdgeRuntimeEnrollmentV1,
  type EdgeRuntimeJournalEntryV1,
  type JsonValue,
} from "@ling-stack/contracts";

import { assertEdgeRuntimeJournalEntry, assertIdentityChange, assertIdentitySplitDestination, DeviceFabricError, isAllowedDeviceLifecycleTransition } from "../../device-fabric.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { withSqliteSnapshotParentTransaction } from "./read-snapshot.js";

export interface DeviceFabricStoreOptions {
  readonly databasePath?: string;
  readonly maxEventsPerStream?: number;
  readonly verifyResourceSignature?: (manifest: DeviceResourceManifestV1) => boolean;
  readonly resourceContractMajor?: number;
  readonly allowedResourceLicenses?: readonly string[];
}

export interface DeviceEventReadResult {
  readonly streamId: string;
  readonly generation: number;
  readonly events: readonly DeviceEventEnvelopeV1[];
  readonly oldestSequence?: number;
  readonly latestSequence?: number;
  readonly hasGap: boolean;
}

export interface DeviceSnapshotRecord {
  readonly streamId: string;
  readonly generation: number;
  readonly sequence: number;
  readonly snapshot: JsonValue;
  readonly createdAt: string;
}

export interface DeviceResourceRecord {
  readonly manifest: DeviceResourceManifestV1;
  readonly payloadDigest: string;
  readonly installedAt: string;
  readonly status: "active" | "disabled";
  readonly statusReason?: string;
}

export interface DeviceResourceCompatibility {
  readonly platform?: "ios" | "android" | "macos" | "windows" | "linux";
  readonly deviceKind?: DeviceResourceManifestV1["supportedDeviceKinds"][number];
  readonly firmwareVersion?: string;
  readonly availablePermissions?: readonly string[];
  readonly contractMajor?: number;
  readonly isFirmwareSupported?: (ranges: readonly string[], firmwareVersion: string) => boolean;
}

export class SqliteDeviceFabricStore {
  readonly database: DatabaseSync;
  readonly #maxEventsPerStream: number;
  readonly #verifyResourceSignature?: (manifest: DeviceResourceManifestV1) => boolean;
  readonly #resourceContractMajor: number;
  readonly #allowedResourceLicenses?: readonly string[];

  constructor(options: DeviceFabricStoreOptions = {}) {
    const path = options.databasePath ?? ":memory:";
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.#maxEventsPerStream = options.maxEventsPerStream ?? 2_000;
    if (!Number.isInteger(this.#maxEventsPerStream) || this.#maxEventsPerStream < 1) {
      throw new Error("maxEventsPerStream must be a positive integer");
    }
    this.#verifyResourceSignature = options.verifyResourceSignature;
    this.#resourceContractMajor = options.resourceContractMajor ?? 1;
    this.#allowedResourceLicenses = options.allowedResourceLicenses;
    this.applySchema();
  }

  appendEvent(event: DeviceEventEnvelopeV1, now = new Date().toISOString()): { readonly event: DeviceEventEnvelopeV1; readonly replayed: boolean } {
    const streamId = event.streamId ?? `${event.sourceKind}:${event.sourceId}`;
    const generation = event.generation ?? 1;
    validateEvent(event, streamId, generation);
    const normalized = { ...event, streamId, generation, retentionClass: event.retentionClass ?? "bounded" } satisfies DeviceEventEnvelopeV1;

    const byId = this.database.prepare("SELECT stream_id,generation,sequence,envelope_json FROM device_fabric_events WHERE event_id=?").get(event.eventId) as Row | undefined;
    if (byId) {
      const existing = parseJson<DeviceEventEnvelopeV1>(byId.envelope_json, "device event");
      if (JSON.stringify(existing) !== JSON.stringify(normalized)) {
        throw new DeviceFabricError("revision_conflict", "event id is already bound to a different envelope");
      }
      return { event: existing, replayed: true };
    }

    const existingSequence = this.database.prepare("SELECT event_id,envelope_json FROM device_fabric_events WHERE stream_id=? AND generation=? AND sequence=?")
      .get(streamId, generation, event.sequence) as Row | undefined;
    if (existingSequence) {
      const existing = parseJson<DeviceEventEnvelopeV1>(existingSequence.envelope_json, "device event");
      if (existing.eventId === normalized.eventId && JSON.stringify(existing) === JSON.stringify(normalized)) return { event: existing, replayed: true };
      throw new DeviceFabricError("revision_conflict", "event sequence is already occupied");
    }

    const latest = this.database.prepare("SELECT MAX(sequence) AS sequence FROM device_fabric_events WHERE stream_id=? AND generation=?").get(streamId, generation) as Row | undefined;
    const latestSequence = latest?.sequence === null || latest?.sequence === undefined ? 0 : Number(latest.sequence);
    if (event.sequence <= latestSequence) throw new DeviceFabricError("revision_conflict", "event sequence must advance within its stream");

    this.database.prepare("INSERT INTO device_fabric_events(stream_id,generation,sequence,event_id,envelope_json,occurred_at,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(streamId, generation, event.sequence, event.eventId, JSON.stringify(normalized), event.occurredAt, now);
    this.database.prepare("DELETE FROM device_fabric_events WHERE stream_id=? AND generation=? AND sequence <= ? AND COALESCE(json_extract(envelope_json,'$.retentionClass'),'bounded') <> 'durable'")
      .run(streamId, generation, event.sequence - this.#maxEventsPerStream);
    return { event: normalized, replayed: false };
  }

  readEvents(streamId: string, generation = 1, afterSequence = 0, limit = 100): DeviceEventReadResult {
    if (!streamId.trim()) throw new Error("streamId is required");
    if (!Number.isInteger(generation) || generation < 1) throw new Error("generation must be a positive integer");
    if (!Number.isInteger(afterSequence) || afterSequence < 0) throw new Error("afterSequence must be a non-negative integer");
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error("limit must be between 1 and 10000");

    const bounds = this.database.prepare("SELECT MIN(sequence) AS oldest,MAX(sequence) AS latest FROM device_fabric_events WHERE stream_id=? AND generation=?")
      .get(streamId, generation) as Row | undefined;
    const oldestSequence = bounds?.oldest === null || bounds?.oldest === undefined ? undefined : Number(bounds.oldest);
    const latestSequence = bounds?.latest === null || bounds?.latest === undefined ? undefined : Number(bounds.latest);
    if (oldestSequence !== undefined && afterSequence < oldestSequence - 1) {
      throw new DeviceFabricError("revision_conflict", "event cursor is older than the retained range");
    }
    const rows = this.database.prepare("SELECT envelope_json FROM device_fabric_events WHERE stream_id=? AND generation=? AND sequence>? ORDER BY sequence LIMIT ?")
      .all(streamId, generation, afterSequence, limit) as Row[];
    const events = rows.map(row => parseJson<DeviceEventEnvelopeV1>(row.envelope_json, "device event"));
    const hasGap = events.length > 0
      ? events[0]!.sequence > afterSequence + 1
      : latestSequence !== undefined && latestSequence > afterSequence;
    return { streamId, generation, events, oldestSequence, latestSequence, hasGap };
  }

  saveSnapshot(input: Omit<DeviceSnapshotRecord, "createdAt"> & { readonly createdAt?: string }): DeviceSnapshotRecord {
    if (!input.streamId.trim()) throw new Error("streamId is required");
    if (!Number.isInteger(input.generation) || input.generation < 1) throw new Error("generation must be a positive integer");
    if (!Number.isInteger(input.sequence) || input.sequence < 0) throw new Error("snapshot sequence must be a non-negative integer");
    const record: DeviceSnapshotRecord = { ...input, createdAt: input.createdAt ?? new Date().toISOString() };
    this.database.prepare("INSERT INTO device_fabric_snapshots(stream_id,generation,sequence,snapshot_json,created_at) VALUES(?,?,?,?,?) ON CONFLICT(stream_id,generation) DO UPDATE SET sequence=excluded.sequence,snapshot_json=excluded.snapshot_json,created_at=excluded.created_at")
      .run(record.streamId, record.generation, record.sequence, JSON.stringify(record.snapshot), record.createdAt);
    return record;
  }

  getSnapshot(streamId: string, generation = 1): DeviceSnapshotRecord | undefined {
    const row = this.database.prepare("SELECT sequence,snapshot_json,created_at FROM device_fabric_snapshots WHERE stream_id=? AND generation=?")
      .get(streamId, generation) as Row | undefined;
    if (!row) return undefined;
    return {
      streamId,
      generation,
      sequence: Number(row.sequence),
      snapshot: parseJson<JsonValue>(row.snapshot_json, "device snapshot"),
      createdAt: readString(row, "created_at"),
    };
  }

  installResource(manifest: DeviceResourceManifestV1, payload: Uint8Array, installedAt = new Date().toISOString(), compatibility: DeviceResourceCompatibility = {}): { readonly record: DeviceResourceRecord; readonly replayed: boolean } {
    this.assertResourcePolicy(manifest, compatibility);
    const bytes = Buffer.from(payload);
    const payloadDigest = createHash("sha256").update(bytes).digest("hex");
    if (payloadDigest !== manifest.digest) throw new DeviceFabricError("resource_conflict", "resource digest does not match manifest");
    return this.withWriteTransaction(() => {
      this.assertResourceDependencies(manifest);
      const current = this.getResource(manifest.resourceId);
      if (current?.manifest.version === manifest.version && (current.payloadDigest !== payloadDigest
        || (this.#verifyResourceSignature !== undefined && current.manifest.signature !== manifest.signature))) {
        throw new DeviceFabricError("resource_conflict", "resource version is bound to another signed manifest or payload");
      }
      const payloadWrite = this.database.prepare(`
        INSERT INTO device_resource_payloads(resource_id,payload_digest,payload_bytes) VALUES(?,?,?)
        ON CONFLICT(resource_id,payload_digest) DO NOTHING
      `).run(manifest.resourceId, payloadDigest, bytes);
      if (payloadWrite.changes === 0) this.readResourcePayload(manifest.resourceId, payloadDigest);
      if (current?.manifest.version === manifest.version && current.payloadDigest === payloadDigest) return { record: current, replayed: true };
      if (current) {
        this.database.prepare("INSERT INTO device_resource_history(resource_id,manifest_json,payload_digest,installed_at) VALUES(?,?,?,?)")
          .run(manifest.resourceId, JSON.stringify(current.manifest), current.payloadDigest, current.installedAt);
      }
      const record = { manifest, payloadDigest, installedAt, status: "active" as const } satisfies DeviceResourceRecord;
      this.activateResource(record);
      return { record, replayed: false };
    });
  }

  rollbackResource(resourceId: string, compatibility: DeviceResourceCompatibility = {}): DeviceResourceRecord {
    return this.withWriteTransaction(() => {
      const row = this.database.prepare(`
        SELECT revision_id,manifest_json,payload_digest,installed_at FROM device_resource_history
        WHERE resource_id=? ORDER BY revision_id DESC LIMIT 1
      `).get(resourceId) as Row | undefined;
      if (!row) throw new DeviceFabricError("resource_conflict", "resource has no rollback revision");
      const record = {
        manifest: parseJson<DeviceResourceManifestV1>(row.manifest_json, "resource manifest"),
        payloadDigest: readString(row, "payload_digest"),
        installedAt: readString(row, "installed_at"),
        status: "active" as const,
      } satisfies DeviceResourceRecord;
      if (record.manifest.resourceId !== resourceId || record.manifest.digest !== record.payloadDigest) {
        throw new DeviceFabricError("resource_conflict", "resource rollback manifest does not match its payload");
      }
      this.assertResourcePolicy(record.manifest, compatibility);
      this.assertResourceDependencies(record.manifest);
      if (!this.readResourcePayload(resourceId, record.payloadDigest)) {
        throw new DeviceFabricError("resource_conflict", "resource rollback payload is missing");
      }
      this.activateResource(record);
      this.database.prepare("DELETE FROM device_resource_history WHERE revision_id=?").run(row.revision_id!);
      return record;
    });
  }

  getResource(resourceId: string): DeviceResourceRecord | undefined {
    const row = this.database.prepare("SELECT a.manifest_json,a.payload_digest,a.installed_at,COALESCE(s.status,'active') AS status,s.reason AS status_reason FROM device_resource_active a LEFT JOIN device_resource_state s ON s.resource_id=a.resource_id WHERE a.resource_id=?").get(resourceId) as Row | undefined;
    if (!row) return undefined;
    const status = readString(row, "status");
    if (status !== "active" && status !== "disabled") throw new DeviceFabricError("resource_conflict", "stored resource status is invalid");
    return { manifest: parseJson<DeviceResourceManifestV1>(row.manifest_json, "resource manifest"), payloadDigest: readString(row, "payload_digest"), installedAt: readString(row, "installed_at"), status, ...(typeof row.status_reason === "string" ? { statusReason: row.status_reason } : {}) };
  }

  readActiveResourcePayload(resourceId: string, compatibility: DeviceResourceCompatibility = {}): Uint8Array | undefined {
    const row = this.database.prepare(`
      SELECT p.payload_bytes,a.payload_digest,a.manifest_json FROM device_resource_active a
      JOIN device_resource_payloads p ON p.resource_id=a.resource_id AND p.payload_digest=a.payload_digest
      LEFT JOIN device_resource_state s ON s.resource_id=a.resource_id
      WHERE a.resource_id=? AND COALESCE(s.status,'active')='active'
    `).get(resourceId) as Row | undefined;
    if (!row) return undefined;
    const digest = readString(row, "payload_digest");
    const manifest = parseJson<DeviceResourceManifestV1>(row.manifest_json, "resource manifest");
    if (manifest.resourceId !== resourceId || manifest.digest !== digest) {
      throw new DeviceFabricError("resource_conflict", "active resource manifest does not match its payload");
    }
    this.assertResourcePolicy(manifest, compatibility);
    this.assertResourceDependencies(manifest);
    return verifyResourcePayload(row.payload_bytes, digest);
  }

  private assertResourcePolicy(manifest: DeviceResourceManifestV1, compatibility: DeviceResourceCompatibility): void {
    if (!isDeviceResourceManifestV1(manifest)) throw new DeviceFabricError("resource_conflict", "resource manifest is invalid");
    validateResourceCompatibility(manifest, compatibility, this.#resourceContractMajor, this.#allowedResourceLicenses);
    if (this.#verifyResourceSignature && !this.#verifyResourceSignature(manifest)) {
      throw new DeviceFabricError("resource_conflict", "resource signature is not valid");
    }
  }

  private assertResourceDependencies(manifest: DeviceResourceManifestV1): void {
    for (const dependency of manifest.dependencies) {
      if (this.getResource(dependency)?.status !== "active") {
        throw new DeviceFabricError("resource_conflict", `resource dependency is not active: ${dependency}`);
      }
    }
  }

  private readResourcePayload(resourceId: string, digest: string): Uint8Array | undefined {
    const row = this.database.prepare("SELECT payload_bytes FROM device_resource_payloads WHERE resource_id=? AND payload_digest=?")
      .get(resourceId, digest) as Row | undefined;
    return row ? verifyResourcePayload(row.payload_bytes, digest) : undefined;
  }

  private activateResource(record: DeviceResourceRecord): void {
    this.database.prepare(`
      INSERT INTO device_resource_active(resource_id,manifest_json,payload_digest,installed_at) VALUES(?,?,?,?)
      ON CONFLICT(resource_id) DO UPDATE SET manifest_json=excluded.manifest_json,payload_digest=excluded.payload_digest,installed_at=excluded.installed_at
    `).run(record.manifest.resourceId, JSON.stringify(record.manifest), record.payloadDigest, record.installedAt);
    this.setResourceStatus(record.manifest.resourceId, "active");
  }

  setResourceStatus(resourceId: string, status: "active" | "disabled", reason?: string, updatedAt = new Date().toISOString()): void {
    if (!this.getResource(resourceId)) throw new DeviceFabricError("target_missing", "resource is missing");
    this.database.prepare("INSERT INTO device_resource_state(resource_id,status,reason,updated_at) VALUES(?,?,?,?) ON CONFLICT(resource_id) DO UPDATE SET status=excluded.status,reason=excluded.reason,updated_at=excluded.updated_at")
      .run(resourceId, status, reason ?? null, updatedAt);
  }

  healthCheckResource(resourceId: string, check: () => boolean, checkedAt = new Date().toISOString()): DeviceResourceRecord {
    const resource = this.getResource(resourceId);
    if (!resource) throw new DeviceFabricError("target_missing", "resource is missing");
    const healthy = check();
    this.setResourceStatus(resourceId, healthy ? "active" : "disabled", healthy ? undefined : "health check failed", checkedAt);
    return this.getResource(resourceId)!;
  }

  upsertGraphNode(node: DeviceGraphNodeV1): DeviceGraphNodeV1 {
    if (!node.nodeId.trim() || node.revision < 0) throw new DeviceFabricError("revision_conflict", "graph node identity is invalid");
    const current = this.getGraphNode(node.nodeId);
    if (current && node.revision < current.revision) throw new DeviceFabricError("revision_conflict", "graph node revision regressed");
    if (current && node.revision === current.revision) {
      if (!isDeepStrictEqual(JSON.parse(JSON.stringify(node)), current)) {
        throw new DeviceFabricError("revision_conflict", "graph node revision is bound to different state");
      }
      return current;
    }
    if (node.parentNodeId && !this.getGraphNode(node.parentNodeId)) throw new DeviceFabricError("target_missing", "graph parent node is missing");
    if (current && node.revision > current.revision) {
      this.database.prepare("INSERT OR IGNORE INTO device_fabric_graph_node_history(node_id,revision,node_json,changed_at) VALUES(?,?,?,?)")
        .run(current.nodeId, current.revision, JSON.stringify(current), new Date().toISOString());
    }
    this.database.prepare("INSERT INTO device_fabric_graph_nodes(node_id,revision,node_json) VALUES(?,?,?) ON CONFLICT(node_id) DO UPDATE SET revision=excluded.revision,node_json=excluded.node_json")
      .run(node.nodeId, node.revision, JSON.stringify(node));
    return node;
  }

  mergeGraphIdentity(nodeId: string, identityRef: string, revision: number): DeviceGraphNodeV1 {
    return this.withWriteTransaction(() => {
      const current = this.getGraphNode(nodeId);
      if (!current) throw new DeviceFabricError("target_missing", "graph node is missing");
      if (!identityRef.trim() || revision < current.revision) throw new DeviceFabricError("revision_conflict", "identity merge revision is invalid");
      const next = { ...current, revision, identityRefs: [...new Set([...current.identityRefs, identityRef])] };
      return this.upsertGraphNode(next);
    });
  }

  splitGraphIdentity(nodeId: string, identityRef: string, newNode: DeviceGraphNodeV1): DeviceGraphNodeV1 {
    return this.withWriteTransaction(() => {
      const current = this.getGraphNode(nodeId);
      if (!current || !current.identityRefs.includes(identityRef)) throw new DeviceFabricError("target_missing", "identity reference is not attached");
      if (newNode.revision <= current.revision) throw new DeviceFabricError("revision_conflict", "identity split revision must advance");
      assertIdentitySplitDestination(nodeId, identityRef, newNode, this.getGraphNode(newNode.nodeId) !== undefined);
      this.upsertGraphNode({ ...current, identityRefs: current.identityRefs.filter(ref => ref !== identityRef), revision: newNode.revision });
      return this.upsertGraphNode(newNode);
    });
  }

  mergeGraphIdentityWithEvidence(change: DeviceIdentityChangeV1): DeviceGraphNodeV1 {
    assertIdentityChange(change, "merge");
    return this.withWriteTransaction(() => {
      const replay = this.replayIdentityChange(change);
      if (replay) return replay;
      const current = this.getGraphNode(change.nodeId);
      if (!current) throw new DeviceFabricError("target_missing", "graph node is missing");
      if (change.revision !== current.revision + 1) throw new DeviceFabricError("revision_conflict", "identity merge revision is stale");
      const next = this.upsertGraphNode({ ...current, revision: change.revision, identityRefs: [...new Set([...current.identityRefs, change.identityRef])] });
      this.saveIdentityChange(change);
      return next;
    });
  }

  splitGraphIdentityWithEvidence(change: DeviceIdentityChangeV1, newNode: DeviceGraphNodeV1): DeviceGraphNodeV1 {
    assertIdentityChange(change, "split");
    return this.withWriteTransaction(() => {
      const replay = this.replayIdentityChange(change);
      if (replay) {
        if (!isDeepStrictEqual(replay, JSON.parse(JSON.stringify(newNode)))) {
          throw new DeviceFabricError("revision_conflict", "identity change id is bound to another split destination");
        }
        return replay;
      }
      const current = this.getGraphNode(change.nodeId);
      if (!current || !current.identityRefs.includes(change.identityRef)) throw new DeviceFabricError("target_missing", "identity reference is not attached");
      if (change.newNodeId !== newNode.nodeId || change.revision !== current.revision + 1 || newNode.revision !== change.revision) {
        throw new DeviceFabricError("revision_conflict", "identity split revision is inconsistent");
      }
      assertIdentitySplitDestination(change.nodeId, change.identityRef, newNode, this.getGraphNode(newNode.nodeId) !== undefined);
      this.upsertGraphNode({ ...current, revision: change.revision, identityRefs: current.identityRefs.filter(ref => ref !== change.identityRef) });
      const next = this.upsertGraphNode(newNode);
      this.saveIdentityChange(change);
      return next;
    });
  }

  listIdentityChanges(nodeId?: string): readonly DeviceIdentityChangeV1[] {
    const rows = nodeId === undefined
      ? this.database.prepare("SELECT change_json FROM device_fabric_identity_changes ORDER BY revision,change_id").all()
      : this.database.prepare("SELECT change_json FROM device_fabric_identity_changes WHERE node_id=? ORDER BY revision,change_id").all(nodeId);
    return (rows as Row[]).map(row => parseJson<DeviceIdentityChangeV1>(row.change_json, "identity change"));
  }

  private replayIdentityChange(change: DeviceIdentityChangeV1): DeviceGraphNodeV1 | undefined {
    const saved = this.database.prepare("SELECT change_json FROM device_fabric_identity_changes WHERE change_id=?").get(change.changeId) as Row | undefined;
    if (!saved) return undefined;
    const original = parseJson<DeviceIdentityChangeV1>(saved.change_json, "identity change");
    if (!isDeepStrictEqual(original, JSON.parse(JSON.stringify(change)))) {
      throw new DeviceFabricError("revision_conflict", "identity change id is bound to another change");
    }
    const nodeId = original.newNodeId ?? original.nodeId;
    const row = this.database.prepare(`
      SELECT node_json FROM device_fabric_graph_nodes WHERE node_id=? AND revision=?
      UNION ALL
      SELECT node_json FROM device_fabric_graph_node_history WHERE node_id=? AND revision=?
      LIMIT 1
    `).get(nodeId, original.revision, nodeId, original.revision) as Row | undefined;
    if (!row) throw new DeviceFabricError("target_missing", "the recorded graph revision is missing");
    return parseJson<DeviceGraphNodeV1>(row.node_json, "graph node");
  }

  private saveIdentityChange(change: DeviceIdentityChangeV1): void {
    this.database.prepare("INSERT INTO device_fabric_identity_changes(change_id,node_id,revision,change_json) VALUES(?,?,?,?)")
      .run(change.changeId, change.nodeId, change.revision, JSON.stringify(change));
  }

  listGraphNodeHistory(nodeId: string): readonly DeviceGraphNodeV1[] {
    return (this.database.prepare("SELECT node_json FROM device_fabric_graph_node_history WHERE node_id=? ORDER BY revision").all(nodeId) as Row[])
      .map(row => parseJson<DeviceGraphNodeV1>(row.node_json, "graph node history"));
  }

  getGraphNode(nodeId: string): DeviceGraphNodeV1 | undefined {
    const row = this.database.prepare("SELECT node_json FROM device_fabric_graph_nodes WHERE node_id=?").get(nodeId) as Row | undefined;
    return row ? parseJson<DeviceGraphNodeV1>(row.node_json, "graph node") : undefined;
  }

  listGraphNodes(): readonly DeviceGraphNodeV1[] {
    return (this.database.prepare("SELECT node_json FROM device_fabric_graph_nodes ORDER BY node_id").all() as Row[])
      .map(row => parseJson<DeviceGraphNodeV1>(row.node_json, "graph node"));
  }

  addGraphRelationship(relationship: DeviceGraphRelationshipV1): DeviceGraphRelationshipV1 {
    if (!relationship.relationshipId.trim() || relationship.fromNodeId === relationship.toNodeId) throw new DeviceFabricError("invalid_graph", "graph relationship identity is invalid");
    if (!this.getGraphNode(relationship.fromNodeId) || !this.getGraphNode(relationship.toNodeId)) throw new DeviceFabricError("target_missing", "relationship endpoint is missing");
    const existing = this.getGraphRelationship(relationship.relationshipId);
    if (existing && relationship.revision < existing.revision) throw new DeviceFabricError("revision_conflict", "relationship revision regressed");
    if (["contains", "part_of"].includes(relationship.type) && this.wouldCreateContainmentCycle(relationship.fromNodeId, relationship.toNodeId, relationship.relationshipId)) {
      throw new DeviceFabricError("invalid_graph", "relationship would create a containment cycle");
    }
    this.database.prepare("INSERT INTO device_fabric_graph_relationships(relationship_id,revision,relationship_json) VALUES(?,?,?) ON CONFLICT(relationship_id) DO UPDATE SET revision=excluded.revision,relationship_json=excluded.relationship_json")
      .run(relationship.relationshipId, relationship.revision, JSON.stringify(relationship));
    return relationship;
  }

  getGraphRelationship(relationshipId: string): DeviceGraphRelationshipV1 | undefined {
    const row = this.database.prepare("SELECT relationship_json FROM device_fabric_graph_relationships WHERE relationship_id=?").get(relationshipId) as Row | undefined;
    return row ? parseJson<DeviceGraphRelationshipV1>(row.relationship_json, "graph relationship") : undefined;
  }

  listGraphRelationships(): readonly DeviceGraphRelationshipV1[] {
    return (this.database.prepare("SELECT relationship_json FROM device_fabric_graph_relationships ORDER BY relationship_id").all() as Row[])
      .map(row => parseJson<DeviceGraphRelationshipV1>(row.relationship_json, "graph relationship"));
  }

  saveTwin(twin: DeviceTwinV1): DeviceTwinV1 {
    const current = this.getTwin(twin.deviceId);
    if (current && twin.revision <= current.revision) throw new DeviceFabricError("revision_conflict", "device twin revision must advance");
    this.database.prepare("INSERT INTO device_fabric_twins(device_id,revision,twin_json) VALUES(?,?,?) ON CONFLICT(device_id) DO UPDATE SET revision=excluded.revision,twin_json=excluded.twin_json")
      .run(twin.deviceId, twin.revision, JSON.stringify(twin));
    return twin;
  }

  getTwin(deviceId: string): DeviceTwinV1 | undefined {
    const row = this.database.prepare("SELECT twin_json FROM device_fabric_twins WHERE device_id=?").get(deviceId) as Row | undefined;
    return row ? parseJson<DeviceTwinV1>(row.twin_json, "device twin") : undefined;
  }

  saveTaskGraph(graph: DeviceTaskGraphV1): DeviceTaskGraphV1 {
    validateTaskGraph(graph);
    const result = this.database.prepare(`
      INSERT INTO device_fabric_task_graphs(graph_id,revision,graph_json) VALUES(?,?,?)
      ON CONFLICT(graph_id) DO UPDATE SET revision=excluded.revision,graph_json=excluded.graph_json
      WHERE excluded.revision > device_fabric_task_graphs.revision
    `)
      .run(graph.graphId, graph.revision, JSON.stringify(graph));
    if (result.changes === 0) throw new DeviceFabricError("revision_conflict", "task graph revision must advance");
    return graph;
  }

  getTaskGraph(graphId: string): DeviceTaskGraphV1 | undefined {
    const row = this.database.prepare("SELECT graph_json FROM device_fabric_task_graphs WHERE graph_id=?").get(graphId) as Row | undefined;
    return row ? parseJson<DeviceTaskGraphV1>(row.graph_json, "task graph") : undefined;
  }

  acquireTaskGraphLease(targetDeviceId: string, ownerId: string, now: string, leaseMs: number): boolean {
    const nowMs = Date.parse(now);
    if (!targetDeviceId.trim() || !ownerId.trim() || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || !Number.isFinite(nowMs)) {
      throw new DeviceFabricError("lease_busy", "task graph lease input is invalid");
    }
    const result = this.database.prepare(`
      INSERT INTO device_task_graph_leases(target_device_id,owner_id,expires_at,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(target_device_id) DO UPDATE SET owner_id=excluded.owner_id,expires_at=excluded.expires_at,updated_at=excluded.updated_at
      WHERE device_task_graph_leases.owner_id=excluded.owner_id OR device_task_graph_leases.expires_at<=excluded.updated_at
    `).run(targetDeviceId, ownerId, new Date(nowMs + leaseMs).toISOString(), new Date(nowMs).toISOString());
    return result.changes !== 0;
  }

  releaseTaskGraphLease(targetDeviceId: string, ownerId: string): void {
    this.database.prepare("DELETE FROM device_task_graph_leases WHERE target_device_id=? AND owner_id=?").run(targetDeviceId, ownerId);
  }

  saveEdgeRuntime(runtime: EdgeRuntimeEnrollmentV1): EdgeRuntimeEnrollmentV1 {
    if (!runtime.runtimeId.trim() || !runtime.publicKeyFingerprint.trim() || runtime.revision < 1) {
      throw new DeviceFabricError("revision_conflict", "edge runtime identity is invalid");
    }
    const current = this.getEdgeRuntime(runtime.runtimeId);
    if (current && runtime.revision <= current.revision) throw new DeviceFabricError("revision_conflict", "edge runtime revision must advance");
    this.database.prepare("INSERT INTO device_edge_runtimes(runtime_id,revision,runtime_json) VALUES(?,?,?) ON CONFLICT(runtime_id) DO UPDATE SET revision=excluded.revision,runtime_json=excluded.runtime_json")
      .run(runtime.runtimeId, runtime.revision, JSON.stringify(runtime));
    return runtime;
  }

  getEdgeRuntime(runtimeId: string): EdgeRuntimeEnrollmentV1 | undefined {
    const row = this.database.prepare("SELECT runtime_json FROM device_edge_runtimes WHERE runtime_id=?").get(runtimeId) as Row | undefined;
    return row ? parseJson<EdgeRuntimeEnrollmentV1>(row.runtime_json, "edge runtime enrollment") : undefined;
  }

  listEdgeRuntimes(): readonly EdgeRuntimeEnrollmentV1[] {
    return (this.database.prepare("SELECT runtime_json FROM device_edge_runtimes ORDER BY runtime_id").all() as Row[])
      .map(row => parseJson<EdgeRuntimeEnrollmentV1>(row.runtime_json, "edge runtime enrollment"));
  }

  appendEdgeRuntimeJournalEntry(entry: EdgeRuntimeJournalEntryV1): { readonly entry: EdgeRuntimeJournalEntryV1; readonly replayed: boolean } {
    assertEdgeRuntimeJournalEntry(entry);
    const serialized = JSON.stringify(entry);
    return this.withWriteTransaction(() => {
      const byId = this.database.prepare("SELECT entry_json FROM device_edge_runtime_journal WHERE entry_id=?").get(entry.entryId) as Row | undefined;
      if (byId) {
        const existing = parseJson<EdgeRuntimeJournalEntryV1>(byId.entry_json, "edge journal entry");
        if (!isDeepStrictEqual(existing, JSON.parse(serialized))) {
          throw new DeviceFabricError("revision_conflict", "edge journal entry id is bound to another entry");
        }
        return { entry: existing, replayed: true };
      }
      const latest = this.database.prepare(`
        SELECT sequence FROM device_edge_runtime_journal
        WHERE runtime_id=? AND owner_task_id=? ORDER BY sequence DESC LIMIT 1
      `).get(entry.runtimeId, entry.ownerTaskId) as Row | undefined;
      if (entry.sequence !== Number(latest?.sequence ?? 0) + 1) {
        throw new DeviceFabricError("revision_conflict", "edge journal sequence is not contiguous");
      }
      this.database.prepare("INSERT INTO device_edge_runtime_journal(runtime_id,owner_task_id,sequence,entry_id,entry_json,recorded_at) VALUES(?,?,?,?,?,?)")
        .run(entry.runtimeId, entry.ownerTaskId, entry.sequence, entry.entryId, serialized, entry.recordedAt);
      return { entry, replayed: false };
    });
  }

  listEdgeRuntimeJournalEntries(runtimeId: string, ownerTaskId: string, afterSequence = 0, limit = 100): readonly EdgeRuntimeJournalEntryV1[] {
    if (!runtimeId.trim() || !ownerTaskId.trim() || !Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new DeviceFabricError("revision_conflict", "edge journal cursor is invalid");
    }
    return (this.database.prepare("SELECT entry_json FROM device_edge_runtime_journal WHERE runtime_id=? AND owner_task_id=? AND sequence>? ORDER BY sequence LIMIT ?")
      .all(runtimeId, ownerTaskId, afterSequence, limit) as Row[]).map(row => parseJson<EdgeRuntimeJournalEntryV1>(row.entry_json, "edge journal entry"));
  }

  saveTraceSpan(span: DeviceTraceSpanV1): DeviceTraceSpanV1 {
    if (!span.spanId.trim() || !span.traceId.trim() || !span.sourceId.trim()) throw new DeviceFabricError("revision_conflict", "trace span identity is invalid");
    if (!Number.isFinite(Date.parse(span.startedAt)) || span.finishedAt !== undefined && (!Number.isFinite(Date.parse(span.finishedAt)) || Date.parse(span.finishedAt) < Date.parse(span.startedAt))) {
      throw new DeviceFabricError("revision_conflict", "trace span timestamps are invalid");
    }
    if (span.parentSpanId) {
      const parent = this.getTraceSpan(span.parentSpanId);
      if (!parent || parent.traceId !== span.traceId) throw new DeviceFabricError("target_missing", "trace span parent is unavailable");
    }
    const current = this.getTraceSpan(span.spanId);
    if (current?.finishedAt && !span.finishedAt) throw new DeviceFabricError("revision_conflict", "finished trace span cannot return to running");
    this.database.prepare("INSERT INTO device_trace_spans(span_id,trace_id,span_json) VALUES(?,?,?) ON CONFLICT(span_id) DO UPDATE SET trace_id=excluded.trace_id,span_json=excluded.span_json")
      .run(span.spanId, span.traceId, JSON.stringify(span));
    return span;
  }

  getTraceSpan(spanId: string): DeviceTraceSpanV1 | undefined {
    const row = this.database.prepare("SELECT span_json FROM device_trace_spans WHERE span_id=?").get(spanId) as Row | undefined;
    return row ? parseJson<DeviceTraceSpanV1>(row.span_json, "trace span") : undefined;
  }

  listTraceSpans(traceId: string): readonly DeviceTraceSpanV1[] {
    return (this.database.prepare("SELECT span_json FROM device_trace_spans WHERE trace_id=? ORDER BY span_id").all(traceId) as Row[])
      .map(row => parseJson<DeviceTraceSpanV1>(row.span_json, "trace span"));
  }

  recordSecretUse(use: DeviceSecretUseV1): void {
    if (!use.useId.trim() || !use.taskId.trim() || !use.targetDeviceId.trim() || !use.secretRef.trim() || !use.purpose.trim() || !use.policyRevision.trim()) {
      throw new DeviceFabricError("safety_denied", "secret use identity is invalid");
    }
    this.database.prepare("INSERT INTO device_secret_uses(use_id,task_id,attempt_id,target_device_id,secret_ref,purpose,policy_revision,used_at,use_json) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(use_id) DO NOTHING")
      .run(use.useId, use.taskId, use.attemptId ?? null, use.targetDeviceId, use.secretRef, use.purpose, use.policyRevision, use.usedAt, JSON.stringify(use));
  }

  listSecretUses(targetDeviceId?: string): readonly DeviceSecretUseV1[] {
    const rows = targetDeviceId
      ? this.database.prepare("SELECT use_json FROM device_secret_uses WHERE target_device_id=? ORDER BY used_at,use_id").all(targetDeviceId) as Row[]
      : this.database.prepare("SELECT use_json FROM device_secret_uses ORDER BY used_at,use_id").all() as Row[];
    return rows.map(row => parseJson<DeviceSecretUseV1>(row.use_json, "device secret use"));
  }

  transitionLifecycle(record: DeviceLifecycleRecordV1): DeviceLifecycleRecordV1 {
    const current = this.getLifecycle(record.deviceId);
    if (!current && record.status !== "discovered") throw new DeviceFabricError("lifecycle_invalid", "device lifecycle must start at discovered");
    if (current && (record.revision <= current.revision || !isAllowedDeviceLifecycleTransition(current.status, record.status))) {
      throw new DeviceFabricError("lifecycle_invalid", "device lifecycle transition is invalid");
    }
    this.database.prepare("INSERT INTO device_lifecycle_state(device_id,revision,record_json,changed_at) VALUES(?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET revision=excluded.revision,record_json=excluded.record_json,changed_at=excluded.changed_at")
      .run(record.deviceId, record.revision, JSON.stringify(record), record.changedAt);
    return record;
  }

  getLifecycle(deviceId: string): DeviceLifecycleRecordV1 | undefined {
    const row = this.database.prepare("SELECT record_json FROM device_lifecycle_state WHERE device_id=?").get(deviceId) as Row | undefined;
    return row ? parseJson<DeviceLifecycleRecordV1>(row.record_json, "device lifecycle record") : undefined;
  }

  transferOwnership(input: DeviceOwnershipRevisionV1): DeviceOwnershipRevisionV1 {
    if (!input.deviceId.trim() || !input.ownerScope.trim() || !input.authority.trim() || input.revision < 1) throw new DeviceFabricError("lifecycle_invalid", "device ownership revision is invalid");
    const current = this.getOwnership(input.deviceId);
    if (current && input.revision <= current.revision) throw new DeviceFabricError("revision_conflict", "device ownership revision must advance");
    if (current) this.database.prepare("INSERT INTO device_ownership_history(device_id,revision,record_json,changed_at) VALUES(?,?,?,?)").run(current.deviceId, current.revision, JSON.stringify(current), current.changedAt);
    this.database.prepare("INSERT INTO device_ownership_current(device_id,revision,record_json,changed_at) VALUES(?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET revision=excluded.revision,record_json=excluded.record_json,changed_at=excluded.changed_at")
      .run(input.deviceId, input.revision, JSON.stringify(input), input.changedAt);
    return input;
  }

  getOwnership(deviceId: string): DeviceOwnershipRevisionV1 | undefined {
    const row = this.database.prepare("SELECT record_json FROM device_ownership_current WHERE device_id=?").get(deviceId) as Row | undefined;
    return row ? parseJson<DeviceOwnershipRevisionV1>(row.record_json, "device ownership revision") : undefined;
  }

  listOwnershipHistory(deviceId: string): readonly DeviceOwnershipRevisionV1[] {
    return (this.database.prepare("SELECT record_json FROM device_ownership_history WHERE device_id=? ORDER BY revision").all(deviceId) as Row[])
      .map(row => parseJson<DeviceOwnershipRevisionV1>(row.record_json, "device ownership revision"));
  }

  saveConformanceReport(report: DeviceConformanceReportV1): DeviceConformanceReportV1 {
    validateConformanceReport(report);
    this.database.prepare("INSERT INTO device_conformance_reports(report_id,runtime_id,adapter_id,adapter_version,target_profile,transport,report_json,generated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(report_id) DO UPDATE SET report_json=excluded.report_json,generated_at=excluded.generated_at")
      .run(report.reportId, report.runtimeId, report.adapterId, report.adapterVersion, report.targetProfile, report.transport, JSON.stringify(report), report.generatedAt);
    return report;
  }

  getConformanceReport(reportId: string): DeviceConformanceReportV1 | undefined {
    const row = this.database.prepare("SELECT report_json FROM device_conformance_reports WHERE report_id=?").get(reportId) as Row | undefined;
    return row ? parseJson<DeviceConformanceReportV1>(row.report_json, "device conformance report") : undefined;
  }

  saveAccessGrant(grant: DeviceAccessGrantV1): DeviceAccessGrantV1 {
    const current = this.getAccessGrant(grant.grantId);
    if (current && grant.revision <= current.revision) throw new DeviceFabricError("revision_conflict", "device access grant revision must advance");
    this.database.prepare("INSERT INTO device_access_grants(grant_id,target_device_id,principal_id,revision,grant_json) VALUES(?,?,?,?,?) ON CONFLICT(grant_id) DO UPDATE SET target_device_id=excluded.target_device_id,principal_id=excluded.principal_id,revision=excluded.revision,grant_json=excluded.grant_json")
      .run(grant.grantId, grant.targetDeviceId, grant.principalId, grant.revision, JSON.stringify(grant));
    this.database.prepare("INSERT INTO device_access_history(grant_id,revision,grant_json,changed_at) VALUES(?,?,?,?)").run(grant.grantId, grant.revision, JSON.stringify(grant), grant.changedAt);
    return grant;
  }

  getAccessGrant(grantId: string): DeviceAccessGrantV1 | undefined {
    const row = this.database.prepare("SELECT grant_json FROM device_access_grants WHERE grant_id=?").get(grantId) as Row | undefined;
    return row ? parseJson<DeviceAccessGrantV1>(row.grant_json, "device access grant") : undefined;
  }

  revokeAccessGrant(grantId: string, revision: number, changedAt: string): DeviceAccessGrantV1 {
    const current = this.getAccessGrant(grantId);
    if (!current) throw new DeviceFabricError("target_missing", "device access grant is missing");
    return this.saveAccessGrant({ ...current, status: "revoked", revision, changedAt });
  }

  saveCredentialRevision(credential: DeviceCredentialRevisionV1): DeviceCredentialRevisionV1 {
    if (!credential.credentialId.trim() || !credential.targetDeviceId.trim() || !credential.secretRef.trim() || !credential.fingerprint.trim() || !credential.authority.trim() || credential.revision < 1) throw new DeviceFabricError("safety_denied", "device credential revision is invalid");
    const current = this.getCredentialRevision(credential.credentialId);
    if (current && credential.revision <= current.revision) throw new DeviceFabricError("revision_conflict", "device credential revision must advance");
    if (current) this.database.prepare("INSERT INTO device_credential_history(credential_id,revision,credential_json,changed_at) VALUES(?,?,?,?)").run(current.credentialId, current.revision, JSON.stringify(current), current.changedAt);
    this.database.prepare("INSERT INTO device_credentials(credential_id,target_device_id,revision,credential_json) VALUES(?,?,?,?) ON CONFLICT(credential_id) DO UPDATE SET target_device_id=excluded.target_device_id,revision=excluded.revision,credential_json=excluded.credential_json")
      .run(credential.credentialId, credential.targetDeviceId, credential.revision, JSON.stringify(credential));
    return credential;
  }

  getCredentialRevision(credentialId: string): DeviceCredentialRevisionV1 | undefined {
    const row = this.database.prepare("SELECT credential_json FROM device_credentials WHERE credential_id=?").get(credentialId) as Row | undefined;
    return row ? parseJson<DeviceCredentialRevisionV1>(row.credential_json, "device credential revision") : undefined;
  }

  revokeCredentialRevision(credentialId: string, revision: number, authority: string, changedAt: string): DeviceCredentialRevisionV1 {
    const current = this.getCredentialRevision(credentialId);
    if (!current) throw new DeviceFabricError("target_missing", "device credential revision is missing");
    return this.saveCredentialRevision({ ...current, revision, status: "revoked", authority, changedAt });
  }

  close(): void { this.database.close(); }

  private withWriteTransaction<T>(write: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = withSqliteSnapshotParentTransaction(this.database, write);
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.database);
      throw error;
    }
  }

  private wouldCreateContainmentCycle(fromNodeId: string, toNodeId: string, replacingRelationshipId: string): boolean {
    const children = new Map<string, string[]>();
    for (const relationship of this.listGraphRelationships()) {
      if (relationship.relationshipId === replacingRelationshipId || !["contains", "part_of"].includes(relationship.type)) continue;
      const values = children.get(relationship.fromNodeId) ?? [];
      values.push(relationship.toNodeId);
      children.set(relationship.fromNodeId, values);
    }
    const stack = [toNodeId];
    const visited = new Set<string>();
    while (stack.length) {
      const current = stack.pop()!;
      if (current === fromNodeId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      stack.push(...(children.get(current) ?? []));
    }
    return false;
  }

  private applySchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS device_fabric_events (
        stream_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        envelope_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(stream_id,generation,sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_device_fabric_events_stream ON device_fabric_events(stream_id,generation,sequence);
      CREATE TABLE IF NOT EXISTS device_fabric_snapshots (
        stream_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(stream_id,generation)
      );
      CREATE TABLE IF NOT EXISTS device_resource_active (
        resource_id TEXT PRIMARY KEY NOT NULL,
        manifest_json TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        installed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS device_resource_history (
        revision_id INTEGER PRIMARY KEY AUTOINCREMENT,
        resource_id TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        installed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_device_resource_history_resource ON device_resource_history(resource_id,revision_id);
      CREATE TABLE IF NOT EXISTS device_resource_payloads (
        resource_id TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        payload_bytes BLOB NOT NULL,
        PRIMARY KEY(resource_id,payload_digest)
      );
      CREATE TABLE IF NOT EXISTS device_resource_state (
        resource_id TEXT PRIMARY KEY NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS device_fabric_graph_nodes (
        node_id TEXT PRIMARY KEY NOT NULL,
        revision INTEGER NOT NULL,
        node_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS device_fabric_graph_node_history (
        node_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        node_json TEXT NOT NULL,
        changed_at TEXT NOT NULL,
        PRIMARY KEY(node_id, revision)
      );
      CREATE TABLE IF NOT EXISTS device_fabric_identity_changes (
        change_id TEXT PRIMARY KEY NOT NULL,
        node_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        change_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS device_fabric_graph_relationships (
        relationship_id TEXT PRIMARY KEY NOT NULL,
        revision INTEGER NOT NULL,
        relationship_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS device_fabric_twins (
        device_id TEXT PRIMARY KEY NOT NULL,
        revision INTEGER NOT NULL,
        twin_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS device_fabric_task_graphs (
        graph_id TEXT PRIMARY KEY NOT NULL,
        revision INTEGER NOT NULL,
        graph_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS device_task_graph_leases (
        target_device_id TEXT PRIMARY KEY NOT NULL,
        owner_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS device_edge_runtimes (
        runtime_id TEXT PRIMARY KEY NOT NULL,
        revision INTEGER NOT NULL,
        runtime_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS device_edge_runtime_journal (
        runtime_id TEXT NOT NULL,
        owner_task_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        entry_id TEXT NOT NULL UNIQUE,
        entry_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY(runtime_id,owner_task_id,sequence)
      );
      CREATE TABLE IF NOT EXISTS device_trace_spans (
        span_id TEXT PRIMARY KEY NOT NULL,
        trace_id TEXT NOT NULL,
        span_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_device_trace_spans_trace ON device_trace_spans(trace_id,span_id);
      CREATE TABLE IF NOT EXISTS device_secret_uses (
        use_id TEXT PRIMARY KEY NOT NULL,
        task_id TEXT NOT NULL,
        attempt_id TEXT,
        target_device_id TEXT NOT NULL,
        secret_ref TEXT NOT NULL,
        purpose TEXT NOT NULL,
        policy_revision TEXT NOT NULL,
        used_at TEXT NOT NULL,
        use_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_device_secret_uses_target ON device_secret_uses(target_device_id,used_at,use_id);
      CREATE TABLE IF NOT EXISTS device_lifecycle_state (
        device_id TEXT PRIMARY KEY NOT NULL,
        revision INTEGER NOT NULL,
        record_json TEXT NOT NULL,
        changed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS device_ownership_current (
        device_id TEXT PRIMARY KEY NOT NULL,
        revision INTEGER NOT NULL,
        record_json TEXT NOT NULL,
        changed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS device_ownership_history (
        history_id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        record_json TEXT NOT NULL,
        changed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_device_ownership_history_device ON device_ownership_history(device_id,revision);
      CREATE TABLE IF NOT EXISTS device_conformance_reports (
        report_id TEXT PRIMARY KEY NOT NULL,
        runtime_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        adapter_version TEXT NOT NULL,
        target_profile TEXT NOT NULL,
        transport TEXT NOT NULL,
        report_json TEXT NOT NULL,
        generated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS device_access_grants (
        grant_id TEXT PRIMARY KEY NOT NULL,
        target_device_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        grant_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS device_access_history (
        history_id INTEGER PRIMARY KEY AUTOINCREMENT,
        grant_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        grant_json TEXT NOT NULL,
        changed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS device_credentials (
        credential_id TEXT PRIMARY KEY NOT NULL,
        target_device_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        credential_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS device_credential_history (
        history_id INTEGER PRIMARY KEY AUTOINCREMENT,
        credential_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        credential_json TEXT NOT NULL,
        changed_at TEXT NOT NULL
      );
    `);
  }
}

function validateEvent(event: DeviceEventEnvelopeV1, streamId: string, generation: number): void {
  if (!event.eventId.trim() || !event.traceId.trim() || !streamId.trim() || !Number.isInteger(generation) || generation < 1 || !Number.isInteger(event.sequence) || event.sequence < 1 || !event.kind.trim()) {
    throw new DeviceFabricError("revision_conflict", "device event identity or sequence is invalid");
  }
}

function verifyResourcePayload(bytes: SQLOutputValue | undefined, digest: string): Uint8Array {
  if (!(bytes instanceof Uint8Array) || createHash("sha256").update(bytes).digest("hex") !== digest) {
    throw new DeviceFabricError("resource_conflict", "stored resource payload digest does not match");
  }
  return bytes;
}

function validateResourceCompatibility(
  manifest: DeviceResourceManifestV1,
  compatibility: DeviceResourceCompatibility,
  expectedContractMajor: number,
  allowedLicenses: readonly string[] | undefined,
): void {
  if (manifest.contractMajor !== undefined && manifest.contractMajor !== expectedContractMajor) throw new DeviceFabricError("resource_conflict", "resource contract major is incompatible");
  if (compatibility.contractMajor !== undefined && compatibility.contractMajor !== expectedContractMajor) throw new DeviceFabricError("resource_conflict", "runtime contract major is incompatible");
  if (allowedLicenses && !allowedLicenses.includes(manifest.license)) throw new DeviceFabricError("resource_conflict", "resource license is not allowed");
  if (compatibility.platform && manifest.supportedPlatforms && !manifest.supportedPlatforms.includes(compatibility.platform)) throw new DeviceFabricError("resource_conflict", "resource platform is not supported");
  if (compatibility.deviceKind && !manifest.supportedDeviceKinds.includes(compatibility.deviceKind)) throw new DeviceFabricError("resource_conflict", "resource device kind is not supported");
  if (manifest.requiredPermissions && compatibility.availablePermissions) {
    const available = new Set(compatibility.availablePermissions);
    if (manifest.requiredPermissions.some(permission => !available.has(permission))) throw new DeviceFabricError("resource_conflict", "resource permissions are unavailable");
  }
  if (manifest.supportedFirmwareRanges && compatibility.firmwareVersion) {
    const supported = compatibility.isFirmwareSupported
      ? compatibility.isFirmwareSupported(manifest.supportedFirmwareRanges, compatibility.firmwareVersion)
      : manifest.supportedFirmwareRanges.includes(compatibility.firmwareVersion);
    if (!supported) throw new DeviceFabricError("resource_conflict", "resource firmware range is incompatible");
  }
}

function validateConformanceReport(report: DeviceConformanceReportV1): void {
  if (!report.reportId.trim() || !report.runtimeId.trim() || !report.adapterId.trim() || !report.adapterVersion.trim() || !report.targetProfile.trim() || !report.transport.trim() || !report.generatedAt.trim() || report.checks.length === 0) {
    throw new DeviceFabricError("revision_conflict", "device conformance report is incomplete");
  }
  const ids = new Set<string>();
  for (const check of report.checks) {
    if (!check.id.trim() || ids.has(check.id) || !["pass", "fail", "skip"].includes(check.status)) throw new DeviceFabricError("revision_conflict", "device conformance check is invalid");
    ids.add(check.id);
  }
}

function validateTaskGraph(graph: DeviceTaskGraphV1): void {
  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (!node.nodeId.trim() || nodeIds.has(node.nodeId)) throw new DeviceFabricError("invalid_graph", "task graph node ids must be unique");
    nodeIds.add(node.nodeId);
  }
  const dependencies = new Map(graph.nodes.map(node => [node.nodeId, node.dependencies]));
  for (const node of graph.nodes) {
    if (node.dependencies.some(dependency => dependency === node.nodeId || !nodeIds.has(dependency))) throw new DeviceFabricError("invalid_graph", "task graph dependency is invalid");
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    for (const dependency of dependencies.get(nodeId) ?? []) if (visit(dependency)) return true;
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };
  if (graph.nodes.some(node => visit(node.nodeId))) throw new DeviceFabricError("invalid_graph", "task graph contains a cycle");
}

type Row = Record<string, SQLOutputValue>;

function readString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Expected ${key} to be a string`);
  return value;
}

function parseJson<T>(raw: SQLOutputValue, label: string): T {
  if (typeof raw !== "string") throw new Error(`Stored ${label} is not JSON`);
  return JSON.parse(raw) as T;
}
