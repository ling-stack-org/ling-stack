import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  DeviceArtifactTransferV1,
  DeviceArtifactChunkReceiptV1,
  DeviceCollaborationProposalV1,
  DeviceDeveloperArtifactV1,
  DeviceDeveloperExecutorResultV1,
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

  authorize(sessionId: string, authorizationRevision: string, now: string, expectedRevision?: number): DeviceDeveloperSessionV1 {
    return this.write(() => {
      const session = this.requireSession(sessionId);
      if (expectedRevision !== undefined && session.revision !== expectedRevision) {
        throw new DeviceFabricError("revision_conflict", "developer session revision changed");
      }
      if (session.status === "revoked" || !authorizationRevision.trim()) {
        throw new DeviceFabricError("safety_denied", "developer session authorization is unavailable");
      }
      return this.saveSession({ ...session, authorizationRevision, status: "authorized", revision: session.revision + 1, updatedAt: now });
    });
  }

  bindArtifact(sessionId: string, artifact: DeviceDeveloperArtifactV1, expectedRevision?: number): DeviceDeveloperSessionV1 {
    return this.write(() => {
      const session = this.requireSession(sessionId);
      if (expectedRevision !== undefined && session.revision !== expectedRevision) {
        throw new DeviceFabricError("revision_conflict", "developer session revision changed");
      }
      if (session.status === "revoked") throw new DeviceFabricError("safety_denied", "developer session is revoked");
      if (artifact.workspaceId !== session.workspaceId || artifact.targetDeviceId !== session.targetDeviceId) {
        throw new DeviceFabricError("target_missing", "artifact is bound to another workspace or target");
      }
      const current = this.getArtifact(artifact.artifactId);
      if (current && (current.digest !== artifact.digest || current.workspaceId !== artifact.workspaceId
        || current.targetDeviceId !== artifact.targetDeviceId || current.packageId !== artifact.packageId
        || current.sizeBytes !== artifact.sizeBytes || !isDeepStrictEqual(current.androidApk, artifact.androidApk))) {
        throw new DeviceFabricError("revision_conflict", "artifact id is bound to another artifact identity");
      }
      if (!current) {
        if (this.#store) this.#store.saveArtifact(artifact);
        else this.#artifacts.set(artifact.artifactId, artifact);
      }
      if (current && session.artifactId === artifact.artifactId) return session;
      return this.saveSession({ ...session, artifactId: artifact.artifactId, artifactDigest: artifact.digest,
        revision: session.revision + 1, updatedAt: artifact.createdAt });
    });
  }

  startJob(input: DeviceDeveloperJobV1): DeviceDeveloperJobV1 {
    return this.admitJob(input).job;
  }

  admitJob(input: DeviceDeveloperJobV1): { readonly job: DeviceDeveloperJobV1; readonly admitted: boolean } {
    return this.write(() => {
      const session = this.requireSession(input.sessionId);
      const current = this.getJob(input.jobId);
      if (current) {
        if (current.sessionId !== input.sessionId || current.kind !== input.kind || current.targetDeviceId !== input.targetDeviceId
          || current.artifactDigest !== input.artifactDigest || current.authorizationRevision !== input.authorizationRevision) {
          throw new DeviceFabricError("revision_conflict", "developer job id is bound to another job");
        }
        return { job: current, admitted: false };
      }
      if (!["authorized", "running"].includes(session.status)) throw new DeviceFabricError("safety_denied", "developer session is not authorized");
      if (session.mode !== "developer") throw new DeviceFabricError("safety_denied", "developer jobs require a developer session");
      if ((session.targetBinding || input.authorizationRevision !== undefined)
        && session.authorizationRevision !== input.authorizationRevision) {
        throw new DeviceFabricError("safety_denied", "developer job authorization changed");
      }
      if (input.targetDeviceId !== session.targetDeviceId) throw new DeviceFabricError("target_missing", "job target does not match session");
      if (session.protocolReplay && input.kind !== "workbench") {
        throw new DeviceFabricError("safety_denied", "protocol session only authorizes workbench jobs");
      }
      if ((input.status !== "running" && input.status !== "queued") || input.outputRef !== undefined || input.outputDigest !== undefined) {
        throw new DeviceFabricError("invalid_graph", "a new developer job requires an admission state");
      }
      if (input.kind === "deploy" && (!input.artifactDigest || input.artifactDigest !== session.artifactDigest)) {
        throw new DeviceFabricError("target_changed", "deploy job artifact is not bound to the session");
      }
      this.saveJob(input);
      this.saveSession({ ...session, status: "running", revision: session.revision + 1, updatedAt: input.updatedAt });
      return { job: input, admitted: true };
    });
  }

  recoverInterruptedJobs(
    owner: Pick<DeviceDeveloperSessionV1, "ownerKind" | "ownerId">, now: string,
    readOutcome?: (job: DeviceDeveloperJobV1) => DeviceDeveloperExecutorResultV1 | undefined,
  ): void {
    for (const jobId of this.#store?.listInterruptedJobIds(owner) ?? []) {
      const job = this.getJob(jobId);
      if (!job || isTerminalDeveloperJob(job.status)) continue;
      const outcome = readOutcome?.(job);
      this.settleJob(jobId, outcome?.status ?? "unknown", outcome?.outputRef, now, outcome?.taskStatus ?? "unknown", outcome?.outputDigest);
    }
  }

  settleJob(
    jobId: string, status: DeviceDeveloperJobV1["status"], outputRef: string | undefined, updatedAt: string,
    taskStatus?: DeviceDeveloperJobV1["taskStatus"], outputDigest?: string,
  ): DeviceDeveloperJobV1 {
    return this.write(() => {
      const job = this.getJob(jobId);
      if (!job) throw new DeviceFabricError("target_missing", "developer job is missing");
      if (outputDigest !== undefined && (status !== "completed" || !outputRef || !/^[0-9a-f]{64}$/u.test(outputDigest))) {
        throw new DeviceFabricError("revision_conflict", "developer job output digest is invalid");
      }
      if (job.status === status && (outputRef === undefined || outputRef === job.outputRef)
        && (taskStatus === undefined || taskStatus === job.taskStatus)
        && (outputDigest === undefined || outputDigest === job.outputDigest)) return job;
      if (isTerminalDeveloperJob(job.status)) throw new DeviceFabricError("revision_conflict", "developer job has a retained outcome");
      if (status === "queued") throw new DeviceFabricError("revision_conflict", "developer job cannot return to its queue");
      const session = this.requireSession(job.sessionId);
      const next = { ...job, status, ...(outputRef ? { outputRef } : {}), ...(outputDigest ? { outputDigest } : {}),
        taskStatus: taskStatus ?? job.taskStatus, revision: job.revision + 1, updatedAt };
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
  getArtifact(artifactId: string): DeviceDeveloperArtifactV1 | undefined {
    return this.#store ? this.#store.getArtifact(artifactId) : this.#artifacts.get(artifactId);
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

  receiveArtifactChunk(input: {
    readonly transferId: string;
    readonly proposalId: string;
    readonly ownerId: string;
    readonly targetDeviceId: string;
    readonly taskRevision: string;
    readonly chunkIndex: number;
    readonly chunkDigest: string;
    readonly bytes: Uint8Array;
    readonly now: string;
  }): DeviceArtifactChunkReceiptV1 {
    const store = this.#store;
    if (!store) throw new DeviceFabricError("target_missing", "artifact chunk storage is unavailable");
    return store.withWriteTransaction(() => {
      const transfer = this.getTransfer(input.transferId);
      if (!transfer || transfer.proposalId !== input.proposalId) {
        throw new DeviceFabricError("target_missing", "artifact transfer is unavailable for the selected proposal");
      }
      const proposal = this.requireProposal(transfer.proposalId);
      assertOwner(proposal, input.ownerId);
      const asOf = Date.parse(input.now);
      if (proposal.targetDeviceId !== input.targetDeviceId || proposal.baseRevision !== input.taskRevision
        || proposal.kind !== "artifact" || proposal.status !== "accepted"
        || !(Date.parse(proposal.createdAt) <= asOf && asOf < Date.parse(proposal.expiresAt))) {
        throw new DeviceFabricError("safety_denied", "artifact transfer authority changed");
      }
      const offer = proposal.payload;
      if (!offer || typeof offer !== "object" || Array.isArray(offer)
        || !("digest" in offer) || offer.digest !== transfer.digest || !("sizeBytes" in offer) || offer.sizeBytes !== transfer.sizeBytes
        || !/^sha256:[0-9a-f]{64}$/u.test(transfer.digest)) {
        throw new DeviceFabricError("safety_denied", "artifact transfer does not match the accepted digest and size");
      }
      const { chunkIndex, bytes, chunkDigest } = input;
      const { sizeBytes, chunkSizeBytes, totalChunks } = transfer;
      if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= totalChunks
        || chunkSizeBytes > 64 * 1024 || totalChunks > 4096
        || !(bytes instanceof Uint8Array) || bytes.byteLength !== Math.min(chunkSizeBytes, sizeBytes - chunkIndex * chunkSizeBytes)) {
        throw new DeviceFabricError("invalid_graph", "artifact chunk size or index is invalid");
      }
      const payload = Buffer.from(bytes);
      if (`sha256:${createHash("sha256").update(payload).digest("hex")}` !== chunkDigest) {
        throw new DeviceFabricError("revision_conflict", "artifact chunk digest did not match the bytes");
      }
      store.saveArtifactChunk(transfer.transferId, chunkIndex, chunkDigest, payload);
      const verifiedChunkIndexes = store.listStoredArtifactChunkIndexes(transfer.transferId);
      const receipt = { transferId: transfer.transferId, proposalId: proposal.proposalId,
        targetDeviceId: proposal.targetDeviceId, verifiedChunkIndexes };
      if (verifiedChunkIndexes.length < totalChunks) return { ...receipt, status: "receiving" };
      const artifactDigest = store.digestStoredArtifact(transfer);
      if (artifactDigest !== transfer.digest) throw new DeviceFabricError("revision_conflict", "assembled artifact digest did not match the accepted proposal");
      return { ...receipt, status: "verified", artifactDigest };
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
