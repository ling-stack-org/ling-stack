import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

import type {
  DeviceArtifactTransferV1,
  DeviceCollaborationProposalV1,
  DeviceDeveloperArtifactV1,
  DeviceDeveloperJobV1,
  DeviceDeveloperSessionV1,
} from "@ling-stack/contracts";
import { DeviceFabricError } from "../../device-fabric.js";

export interface DeviceDeveloperStoreOptions {
  readonly databasePath?: string;
}

export class SqliteDeviceDeveloperStore {
  readonly database: DatabaseSync;

  constructor(options: DeviceDeveloperStoreOptions = {}) {
    const path = options.databasePath ?? ":memory:";
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS device_developer_sessions (session_id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL, session_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS device_developer_jobs (job_id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, revision INTEGER NOT NULL, job_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS device_developer_artifacts (artifact_id TEXT PRIMARY KEY NOT NULL, digest TEXT NOT NULL, artifact_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS device_collaboration_proposals (proposal_id TEXT PRIMARY KEY NOT NULL, payload_digest TEXT NOT NULL, proposal_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS device_artifact_transfers (transfer_id TEXT PRIMARY KEY NOT NULL, proposal_id TEXT NOT NULL, transfer_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS device_artifact_transfer_chunks (
        transfer_id TEXT NOT NULL REFERENCES device_artifact_transfers(transfer_id),
        chunk_index INTEGER NOT NULL,
        digest TEXT NOT NULL,
        payload BLOB NOT NULL,
        PRIMARY KEY(transfer_id,chunk_index)
      );
    `);
  }

  withWriteTransaction<T>(write: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = write();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  saveSession(session: DeviceDeveloperSessionV1): DeviceDeveloperSessionV1 {
    const current = this.getSession(session.sessionId);
    if (current && session.revision <= current.revision) throw new DeviceFabricError("revision_conflict", "developer session revision must advance");
    this.database.prepare("INSERT INTO device_developer_sessions(session_id,revision,session_json) VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET revision=excluded.revision,session_json=excluded.session_json")
      .run(session.sessionId, session.revision, JSON.stringify(session));
    return session;
  }

  getSession(sessionId: string): DeviceDeveloperSessionV1 | undefined {
    const row = this.database.prepare("SELECT session_json FROM device_developer_sessions WHERE session_id=?").get(sessionId) as Row | undefined;
    return row ? parseJson<DeviceDeveloperSessionV1>(row.session_json, "developer session") : undefined;
  }

  saveJob(job: DeviceDeveloperJobV1): DeviceDeveloperJobV1 {
    const current = this.getJob(job.jobId);
    if (current && job.revision <= current.revision) throw new DeviceFabricError("revision_conflict", "developer job revision must advance");
    this.database.prepare("INSERT INTO device_developer_jobs(job_id,session_id,revision,job_json) VALUES(?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET session_id=excluded.session_id,revision=excluded.revision,job_json=excluded.job_json")
      .run(job.jobId, job.sessionId, job.revision, JSON.stringify(job));
    return job;
  }

  getJob(jobId: string): DeviceDeveloperJobV1 | undefined {
    const row = this.database.prepare("SELECT job_json FROM device_developer_jobs WHERE job_id=?").get(jobId) as Row | undefined;
    return row ? parseJson<DeviceDeveloperJobV1>(row.job_json, "developer job") : undefined;
  }

  listInterruptedJobIds(owner: Pick<DeviceDeveloperSessionV1, "ownerKind" | "ownerId">): readonly string[] {
    // Offline replay can retry its digest-bound import without another device call.
    return this.database.prepare(`
      SELECT job_id
      FROM device_developer_jobs JOIN device_developer_sessions USING (session_id)
      WHERE json_extract(session_json, '$.ownerKind') = ?
        AND json_extract(session_json, '$.ownerId') = ?
        AND json_extract(job_json, '$.status') IN ('queued', 'running')
        AND NOT (
          json_extract(job_json, '$.kind') = 'workbench'
          AND json_type(session_json, '$.protocolReplay') IS 'object'
          AND json_type(session_json, '$.protocolReplay.liveTransport') IS NULL
        )
    `).all(owner.ownerKind, owner.ownerId).map(row => String(row.job_id));
  }

  saveArtifact(artifact: DeviceDeveloperArtifactV1): DeviceDeveloperArtifactV1 {
    const current = this.getArtifact(artifact.artifactId);
    if (current && current.digest !== artifact.digest) throw new DeviceFabricError("revision_conflict", "artifact id is bound to another digest");
    this.database.prepare("INSERT INTO device_developer_artifacts(artifact_id,digest,artifact_json) VALUES(?,?,?) ON CONFLICT(artifact_id) DO NOTHING")
      .run(artifact.artifactId, artifact.digest, JSON.stringify(artifact));
    return current ?? artifact;
  }

  getArtifact(artifactId: string): DeviceDeveloperArtifactV1 | undefined {
    const row = this.database.prepare("SELECT artifact_json FROM device_developer_artifacts WHERE artifact_id=?").get(artifactId) as Row | undefined;
    return row ? parseJson<DeviceDeveloperArtifactV1>(row.artifact_json, "developer artifact") : undefined;
  }

  saveProposal(proposal: DeviceCollaborationProposalV1): DeviceCollaborationProposalV1 {
    const current = this.getProposal(proposal.proposalId);
    if (current) {
      if (current.payloadDigest !== proposal.payloadDigest || current.taskId !== proposal.taskId
        || current.ownerId !== proposal.ownerId || current.targetDeviceId !== proposal.targetDeviceId
        || !isProposalTransitionAllowed(current.status, proposal.status)) {
        throw new DeviceFabricError("revision_conflict", "proposal id is bound to another payload or state");
      }
      this.database.prepare("UPDATE device_collaboration_proposals SET proposal_json=? WHERE proposal_id=?")
        .run(JSON.stringify(proposal), proposal.proposalId);
      return proposal;
    }
    this.database.prepare("INSERT INTO device_collaboration_proposals(proposal_id,payload_digest,proposal_json) VALUES(?,?,?)")
      .run(proposal.proposalId, proposal.payloadDigest, JSON.stringify(proposal));
    return proposal;
  }

  getProposal(proposalId: string): DeviceCollaborationProposalV1 | undefined {
    const row = this.database.prepare("SELECT proposal_json FROM device_collaboration_proposals WHERE proposal_id=?").get(proposalId) as Row | undefined;
    return row ? parseJson<DeviceCollaborationProposalV1>(row.proposal_json, "collaboration proposal") : undefined;
  }

  saveTransfer(transfer: DeviceArtifactTransferV1): DeviceArtifactTransferV1 {
    const proposal = this.getProposal(transfer.proposalId);
    if (!proposal || proposal.status !== "accepted") throw new DeviceFabricError("safety_denied", "artifact transfer requires an accepted proposal");
    const current = this.getTransfer(transfer.transferId);
    if (current && (current.digest !== transfer.digest || current.proposalId !== transfer.proposalId
      || current.sizeBytes !== transfer.sizeBytes || current.chunkSizeBytes !== transfer.chunkSizeBytes
      || current.totalChunks !== transfer.totalChunks
      || current.receivedChunks.some(chunk => !transfer.receivedChunks.includes(chunk)))) {
      throw new DeviceFabricError("revision_conflict", "transfer id is bound to another artifact");
    }
    this.database.prepare("INSERT INTO device_artifact_transfers(transfer_id,proposal_id,transfer_json) VALUES(?,?,?) ON CONFLICT(transfer_id) DO UPDATE SET transfer_json=excluded.transfer_json")
      .run(transfer.transferId, transfer.proposalId, JSON.stringify(transfer));
    return transfer;
  }

  getTransfer(transferId: string): DeviceArtifactTransferV1 | undefined {
    const row = this.database.prepare("SELECT transfer_json FROM device_artifact_transfers WHERE transfer_id=?").get(transferId) as Row | undefined;
    return row ? parseJson<DeviceArtifactTransferV1>(row.transfer_json, "artifact transfer") : undefined;
  }

  acceptChunk(transferId: string, chunkIndex: number): DeviceArtifactTransferV1 {
    const transfer = this.getTransfer(transferId);
    if (!transfer || !Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= transfer.totalChunks) throw new DeviceFabricError("target_missing", "artifact transfer chunk is invalid");
    const next = { ...transfer, receivedChunks: [...new Set([...transfer.receivedChunks, chunkIndex])].sort((left, right) => left - right) };
    this.database.prepare("UPDATE device_artifact_transfers SET transfer_json=? WHERE transfer_id=?").run(JSON.stringify(next), transferId);
    return next;
  }

  saveArtifactChunk(transferId: string, chunkIndex: number, digest: string, payload: Uint8Array): void {
    const saved = this.database.prepare(`
      INSERT INTO device_artifact_transfer_chunks(transfer_id,chunk_index,digest,payload) VALUES(?,?,?,?)
      ON CONFLICT(transfer_id,chunk_index) DO NOTHING
    `).run(transferId, chunkIndex, digest, payload);
    if (saved.changes === 0) {
      const row = this.database.prepare(`
        SELECT digest,payload FROM device_artifact_transfer_chunks WHERE transfer_id=? AND chunk_index=?
      `).get(transferId, chunkIndex);
      if (row?.digest !== digest || !(row.payload instanceof Uint8Array) || !Buffer.from(row.payload).equals(payload)) {
        throw new DeviceFabricError("revision_conflict", "artifact chunk index is already bound to different bytes");
      }
    }
  }

  listStoredArtifactChunkIndexes(transferId: string): readonly number[] {
    return this.database.prepare("SELECT chunk_index FROM device_artifact_transfer_chunks WHERE transfer_id=? ORDER BY chunk_index")
      .all(transferId).map(row => Number(row.chunk_index));
  }

  digestStoredArtifact(transfer: DeviceArtifactTransferV1): string {
    const hash = createHash("sha256");
    let chunkIndex = 0;
    let size = 0;
    for (const row of this.database.prepare(`
      SELECT chunk_index,digest,payload FROM device_artifact_transfer_chunks WHERE transfer_id=? ORDER BY chunk_index
    `).iterate(transfer.transferId)) {
      if (row.chunk_index !== chunkIndex || !(row.payload instanceof Uint8Array)
        || `sha256:${createHash("sha256").update(row.payload).digest("hex")}` !== row.digest) {
        throw new DeviceFabricError("revision_conflict", "stored artifact chunk did not pass integrity checks");
      }
      hash.update(row.payload);
      size += row.payload.byteLength;
      chunkIndex += 1;
    }
    if (chunkIndex !== transfer.totalChunks || size !== transfer.sizeBytes) {
      throw new DeviceFabricError("revision_conflict", "stored artifact is incomplete");
    }
    return `sha256:${hash.digest("hex")}`;
  }

  close(): void { this.database.close(); }
}

function isProposalTransitionAllowed(
  current: DeviceCollaborationProposalV1["status"],
  next: DeviceCollaborationProposalV1["status"],
): boolean {
  return current === next || (current === "proposed" && ["accepted", "rejected", "expired"].includes(next));
}

type Row = Record<string, SQLOutputValue>;

function parseJson<T>(raw: SQLOutputValue, label: string): T {
  if (typeof raw !== "string") throw new Error(`Stored ${label} is not JSON`);
  return JSON.parse(raw) as T;
}
