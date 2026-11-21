import { createHash } from "node:crypto";
import type {
  DeviceArtifactTransferV1,
  DeviceCollaborationProposalV1,
  DeviceDeveloperArtifactV1,
  DeviceDeveloperJobV1,
  DeviceDeveloperSessionV1,
} from "@ling-stack/contracts";
import type { JsonValue } from "@ling-stack/contracts";
import { DeviceFabricError } from "./device-fabric.js";
import type { SqliteDeviceDeveloperStore } from "./storage/sqlite/device-developer-store.js";

export class DeviceDeveloperSessionCoordinator {
  readonly #sessions = new Map<string, DeviceDeveloperSessionV1>();
  readonly #jobs = new Map<string, DeviceDeveloperJobV1>();
  readonly #artifacts = new Map<string, DeviceDeveloperArtifactV1>();
  readonly #store?: SqliteDeviceDeveloperStore;

  constructor(options: { readonly store?: SqliteDeviceDeveloperStore } = {}) {
    this.#store = options.store;
  }

  createSession(session: DeviceDeveloperSessionV1): DeviceDeveloperSessionV1 {
    return this.write(() => {
      if (this.getSession(session.sessionId)) throw new DeviceFabricError("revision_conflict", "developer session already exists");
      return this.saveSession(session);
    });
  }

  authorize(sessionId: string, authorizationRevision: string, now: string): DeviceDeveloperSessionV1 {
    return this.write(() => {
      const session = this.requireSession(sessionId);
      if (session.status === "revoked" || !authorizationRevision.trim()) {
        throw new DeviceFabricError("safety_denied", "developer session authorization is unavailable");
      }
      return this.saveSession({ ...session, authorizationRevision, status: "authorized", revision: session.revision + 1, updatedAt: now });
    });
  }

  bindArtifact(sessionId: string, artifact: DeviceDeveloperArtifactV1): DeviceDeveloperSessionV1 {
    return this.write(() => {
      const session = this.requireSession(sessionId);
      if (session.status === "revoked") throw new DeviceFabricError("safety_denied", "developer session is revoked");
      if (artifact.workspaceId !== session.workspaceId || artifact.targetDeviceId !== session.targetDeviceId) {
        throw new DeviceFabricError("target_missing", "artifact is bound to another workspace or target");
      }
      const current = this.#store ? this.#store.getArtifact(artifact.artifactId) : this.#artifacts.get(artifact.artifactId);
      if (current && (current.digest !== artifact.digest || current.workspaceId !== artifact.workspaceId
        || current.targetDeviceId !== artifact.targetDeviceId || current.packageId !== artifact.packageId || current.sizeBytes !== artifact.sizeBytes)) {
        throw new DeviceFabricError("revision_conflict", "artifact id is bound to another artifact identity");
      }
      if (!current) {
        if (this.#store) this.#store.saveArtifact(artifact);
        else this.#artifacts.set(artifact.artifactId, artifact);
      }
      return this.saveSession({ ...session, artifactDigest: artifact.digest, revision: session.revision + 1, updatedAt: artifact.createdAt });
    });
  }

  startJob(input: DeviceDeveloperJobV1): DeviceDeveloperJobV1 {
    return this.write(() => {
      const session = this.requireSession(input.sessionId);
      const current = this.getJob(input.jobId);
      if (current) {
        if (current.sessionId !== input.sessionId || current.kind !== input.kind || current.targetDeviceId !== input.targetDeviceId
          || current.artifactDigest !== input.artifactDigest) {
          throw new DeviceFabricError("revision_conflict", "developer job id is bound to another job");
        }
        return current;
      }
      if (!["authorized", "running"].includes(session.status)) throw new DeviceFabricError("safety_denied", "developer session is not authorized");
      if (input.targetDeviceId !== session.targetDeviceId) throw new DeviceFabricError("target_missing", "job target does not match session");
      if ((input.status !== "running" && input.status !== "queued") || input.outputRef !== undefined) {
        throw new DeviceFabricError("invalid_graph", "a new developer job requires an admission state");
      }
      if (input.kind === "deploy" && (!input.artifactDigest || input.artifactDigest !== session.artifactDigest)) {
        throw new DeviceFabricError("target_changed", "deploy job artifact is not bound to the session");
      }
      this.saveJob(input);
      this.saveSession({ ...session, status: "running", revision: session.revision + 1, updatedAt: input.updatedAt });
      return input;
    });
  }

  settleJob(jobId: string, status: DeviceDeveloperJobV1["status"], outputRef: string | undefined, updatedAt: string): DeviceDeveloperJobV1 {
    return this.write(() => {
      const job = this.getJob(jobId);
      if (!job) throw new DeviceFabricError("target_missing", "developer job is missing");
      if (job.status === status && (outputRef === undefined || outputRef === job.outputRef)) return job;
      if (isTerminalDeveloperJob(job.status)) throw new DeviceFabricError("revision_conflict", "developer job has a retained outcome");
      if (status === "queued") throw new DeviceFabricError("revision_conflict", "developer job cannot return to its queue");
      const session = this.requireSession(job.sessionId);
      const next = { ...job, status, ...(outputRef ? { outputRef } : {}), revision: job.revision + 1, updatedAt };
      this.saveJob(next);
      if (isTerminalDeveloperJob(status) && session.status !== "revoked") {
        const sessionStatus = status === "completed" ? "completed" : status === "unknown" ? "paused" : "failed";
        this.saveSession({ ...session, status: sessionStatus, revision: session.revision + 1, updatedAt });
      }
      return next;
    });
  }

  getSession(sessionId: string): DeviceDeveloperSessionV1 | undefined {
    return this.#store ? this.#store.getSession(sessionId) : this.#sessions.get(sessionId);
  }
  getJob(jobId: string): DeviceDeveloperJobV1 | undefined {
    return this.#store ? this.#store.getJob(jobId) : this.#jobs.get(jobId);
  }

  private requireSession(sessionId: string): DeviceDeveloperSessionV1 {
    const session = this.getSession(sessionId);
    if (!session) throw new DeviceFabricError("target_missing", "developer session is missing");
    return session;
  }

  private saveSession(session: DeviceDeveloperSessionV1): DeviceDeveloperSessionV1 {
    if (this.#store) return this.#store.saveSession(session);
    this.#sessions.set(session.sessionId, session);
    return session;
  }

  private saveJob(job: DeviceDeveloperJobV1): void {
    if (this.#store) this.#store.saveJob(job);
    else this.#jobs.set(job.jobId, job);
  }

  private write<T>(work: () => T): T {
    return this.#store ? this.#store.withWriteTransaction(work) : work();
  }
}

function isTerminalDeveloperJob(status: DeviceDeveloperJobV1["status"]): boolean {
  return status === "completed" || status === "failed" || status === "unknown" || status === "cancelled";
}

export class DeviceCollaborationCoordinator {
  readonly #proposals = new Map<string, DeviceCollaborationProposalV1>();
  readonly #transfers = new Map<string, DeviceArtifactTransferV1>();
  readonly #store?: SqliteDeviceDeveloperStore;

  constructor(options: { readonly store?: SqliteDeviceDeveloperStore } = {}) {
    this.#store = options.store;
  }

  propose(proposal: DeviceCollaborationProposalV1): DeviceCollaborationProposalV1 {
    return this.write(() => {
      const existing = this.getProposal(proposal.proposalId);
      if (existing) {
        assertSameProposal(existing, proposal);
        return existing;
      }
      validateProposal(proposal);
      return this.saveProposal(proposal);
    });
  }

  accept(proposalId: string, ownerId: string, now: string): DeviceCollaborationProposalV1 {
    return this.write(() => {
      const proposal = this.requireProposal(proposalId);
      assertOwner(proposal, ownerId);
      if (proposal.status !== "proposed") throw new DeviceFabricError("safety_denied", "proposal is no longer actionable");
      if (Date.parse(proposal.expiresAt) <= Date.parse(now)) throw new DeviceFabricError("safety_denied", "proposal has expired");
      return this.saveProposal({ ...proposal, status: "accepted" });
    });
  }

  reject(proposalId: string, ownerId: string): DeviceCollaborationProposalV1 {
    return this.write(() => {
      const proposal = this.requireProposal(proposalId);
      assertOwner(proposal, ownerId);
      if (proposal.status !== "proposed") throw new DeviceFabricError("safety_denied", "proposal is no longer actionable");
      return this.saveProposal({ ...proposal, status: "rejected" });
    });
  }

  registerTransfer(transfer: DeviceArtifactTransferV1): DeviceArtifactTransferV1 {
    return this.write(() => {
      const proposal = this.requireProposal(transfer.proposalId);
      if (proposal.status !== "accepted") throw new DeviceFabricError("safety_denied", "artifact transfer requires an accepted proposal");
      validateTransfer(transfer);
      const existing = this.getTransfer(transfer.transferId);
      if (existing) {
        if (existing.proposalId !== transfer.proposalId || existing.digest !== transfer.digest || existing.sizeBytes !== transfer.sizeBytes
          || existing.chunkSizeBytes !== transfer.chunkSizeBytes || existing.totalChunks !== transfer.totalChunks) {
          throw new DeviceFabricError("revision_conflict", "transfer id is bound to another artifact");
        }
        return existing;
      }
      return this.saveTransfer(transfer);
    });
  }

  acceptChunk(transferId: string, chunkIndex: number): DeviceArtifactTransferV1 {
    return this.write(() => {
      const transfer = this.getTransfer(transferId);
      if (!transfer || !Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= transfer.totalChunks) {
        throw new DeviceFabricError("target_missing", "artifact transfer chunk is invalid");
      }
      const receivedChunks = [...new Set([...transfer.receivedChunks, chunkIndex])].sort((left, right) => left - right);
      return this.saveTransfer({ ...transfer, receivedChunks });
    });
  }

  private requireProposal(proposalId: string): DeviceCollaborationProposalV1 {
    const proposal = this.getProposal(proposalId);
    if (!proposal) throw new DeviceFabricError("target_missing", "collaboration proposal is missing");
    return proposal;
  }

  private getProposal(proposalId: string): DeviceCollaborationProposalV1 | undefined {
    return this.#store?.getProposal(proposalId) ?? this.#proposals.get(proposalId);
  }

  private saveProposal(proposal: DeviceCollaborationProposalV1): DeviceCollaborationProposalV1 {
    if (this.#store) return this.#store.saveProposal(proposal);
    this.#proposals.set(proposal.proposalId, proposal);
    return proposal;
  }

  private getTransfer(transferId: string): DeviceArtifactTransferV1 | undefined {
    return this.#store?.getTransfer(transferId) ?? this.#transfers.get(transferId);
  }

  private saveTransfer(transfer: DeviceArtifactTransferV1): DeviceArtifactTransferV1 {
    if (this.#store) return this.#store.saveTransfer(transfer);
    this.#transfers.set(transfer.transferId, transfer);
    return transfer;
  }

  private write<T>(work: () => T): T {
    return this.#store ? this.#store.withWriteTransaction(work) : work();
  }
}

function validateProposal(proposal: DeviceCollaborationProposalV1): void {
  if (proposal.ownerKind !== "mobile" || proposal.proposerKind !== "daemon" || !proposal.ownerId.trim()
    || !proposal.proposerId.trim() || !proposal.taskId.trim() || !proposal.targetDeviceId.trim()
    || proposal.status !== "proposed" || !Number.isFinite(Date.parse(proposal.createdAt))
    || !Number.isFinite(Date.parse(proposal.expiresAt)) || Date.parse(proposal.expiresAt) <= Date.parse(proposal.createdAt)
    || proposal.payloadDigest !== digestCollaborationPayload(proposal.payload)) {
    throw new DeviceFabricError("invalid_graph", "phone-owned collaboration proposal is invalid");
  }
}

function assertSameProposal(left: DeviceCollaborationProposalV1, right: DeviceCollaborationProposalV1): void {
  if (left.payloadDigest !== right.payloadDigest || left.taskId !== right.taskId || left.ownerId !== right.ownerId
    || left.targetDeviceId !== right.targetDeviceId || left.baseRevision !== right.baseRevision) {
    throw new DeviceFabricError("revision_conflict", "proposal id is bound to another payload");
  }
}

function assertOwner(proposal: DeviceCollaborationProposalV1, ownerId: string): void {
  if (proposal.ownerId !== ownerId) throw new DeviceFabricError("safety_denied", "proposal owner does not match");
}

function validateTransfer(transfer: DeviceArtifactTransferV1): void {
  if (!transfer.transferId.trim() || !transfer.proposalId.trim() || !/^sha256:[a-z0-9._-]{1,128}$/iu.test(transfer.digest)
    || !Number.isInteger(transfer.sizeBytes) || transfer.sizeBytes < 0
    || !Number.isInteger(transfer.chunkSizeBytes) || transfer.chunkSizeBytes <= 0
    || !Number.isInteger(transfer.totalChunks) || transfer.totalChunks < 1
    || transfer.receivedChunks.some(index => !Number.isInteger(index) || index < 0 || index >= transfer.totalChunks)) {
    throw new DeviceFabricError("invalid_graph", "artifact transfer metadata is invalid");
  }
  const expectedChunks = Math.max(1, Math.ceil(transfer.sizeBytes / transfer.chunkSizeBytes));
  if (expectedChunks !== transfer.totalChunks || new Set(transfer.receivedChunks).size !== transfer.receivedChunks.length) {
    throw new DeviceFabricError("invalid_graph", "artifact transfer chunk metadata is inconsistent");
  }
}

export function digestCollaborationPayload(payload: JsonValue): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
