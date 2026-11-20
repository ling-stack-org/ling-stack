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

export class DeviceDeveloperSessionCoordinator {
  readonly #sessions = new Map<string, DeviceDeveloperSessionV1>();
  readonly #jobs = new Map<string, DeviceDeveloperJobV1>();
  readonly #artifacts = new Map<string, DeviceDeveloperArtifactV1>();

  createSession(session: DeviceDeveloperSessionV1): DeviceDeveloperSessionV1 {
    if (this.#sessions.has(session.sessionId)) throw new DeviceFabricError("revision_conflict", "developer session already exists");
    this.#sessions.set(session.sessionId, session);
    return session;
  }

  authorize(sessionId: string, authorizationRevision: string, now: string): DeviceDeveloperSessionV1 {
    const session = this.requireSession(sessionId);
    const next = { ...session, authorizationRevision, status: "authorized" as const, revision: session.revision + 1, updatedAt: now };
    this.#sessions.set(sessionId, next);
    return next;
  }

  bindArtifact(sessionId: string, artifact: DeviceDeveloperArtifactV1): DeviceDeveloperSessionV1 {
    const session = this.requireSession(sessionId);
    if (artifact.workspaceId !== session.workspaceId || artifact.targetDeviceId !== session.targetDeviceId) throw new DeviceFabricError("target_missing", "artifact is bound to another workspace or target");
    this.#artifacts.set(artifact.artifactId, artifact);
    const next = { ...session, artifactDigest: artifact.digest, revision: session.revision + 1, updatedAt: artifact.createdAt };
    this.#sessions.set(sessionId, next);
    return next;
  }

  startJob(input: DeviceDeveloperJobV1): DeviceDeveloperJobV1 {
    const session = this.requireSession(input.sessionId);
    if (!["authorized", "running"].includes(session.status)) throw new DeviceFabricError("safety_denied", "developer session is not authorized");
    if (input.targetDeviceId !== session.targetDeviceId) throw new DeviceFabricError("target_missing", "job target does not match session");
    if (input.kind === "deploy" && (!input.artifactDigest || input.artifactDigest !== session.artifactDigest)) throw new DeviceFabricError("target_changed", "deploy job artifact is not bound to the session");
    this.#jobs.set(input.jobId, input);
    this.#sessions.set(session.sessionId, { ...session, status: "running", revision: session.revision + 1, updatedAt: input.updatedAt });
    return input;
  }

  settleJob(jobId: string, status: DeviceDeveloperJobV1["status"], outputRef: string | undefined, updatedAt: string): DeviceDeveloperJobV1 {
    const job = this.#jobs.get(jobId);
    if (!job) throw new DeviceFabricError("target_missing", "developer job is missing");
    const next = { ...job, status, ...(outputRef ? { outputRef } : {}), revision: job.revision + 1, updatedAt };
    this.#jobs.set(jobId, next);
    const session = this.requireSession(job.sessionId);
    if (["completed", "failed", "unknown", "cancelled"].includes(status)) this.#sessions.set(session.sessionId, { ...session, status: status === "completed" ? "completed" : "failed", revision: session.revision + 1, updatedAt });
    return next;
  }

  getSession(sessionId: string): DeviceDeveloperSessionV1 | undefined { return this.#sessions.get(sessionId); }
  getJob(jobId: string): DeviceDeveloperJobV1 | undefined { return this.#jobs.get(jobId); }

  private requireSession(sessionId: string): DeviceDeveloperSessionV1 {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new DeviceFabricError("target_missing", "developer session is missing");
    return session;
  }
}

export class DeviceCollaborationCoordinator {
  readonly #proposals = new Map<string, DeviceCollaborationProposalV1>();
  readonly #transfers = new Map<string, DeviceArtifactTransferV1>();

  propose(proposal: DeviceCollaborationProposalV1): DeviceCollaborationProposalV1 {
    const existing = this.#proposals.get(proposal.proposalId);
    if (existing) {
      if (existing.payloadDigest !== proposal.payloadDigest) throw new DeviceFabricError("revision_conflict", "proposal id is bound to another payload");
      return existing;
    }
    if (proposal.ownerKind !== "mobile" || proposal.targetDeviceId.length === 0) throw new DeviceFabricError("invalid_graph", "phone-owned proposal is invalid");
    this.#proposals.set(proposal.proposalId, proposal);
    return proposal;
  }

  accept(proposalId: string, ownerId: string, now: string): DeviceCollaborationProposalV1 {
    const proposal = this.requireProposal(proposalId);
    if (proposal.ownerId !== ownerId) throw new DeviceFabricError("safety_denied", "proposal owner does not match");
    if (proposal.status !== "proposed") throw new DeviceFabricError("safety_denied", "proposal is no longer actionable");
    if (Date.parse(proposal.expiresAt) <= Date.parse(now)) throw new DeviceFabricError("safety_denied", "proposal has expired");
    const next = { ...proposal, status: "accepted" as const };
    this.#proposals.set(proposalId, next);
    return next;
  }

  reject(proposalId: string, ownerId: string): DeviceCollaborationProposalV1 {
    const proposal = this.requireProposal(proposalId);
    if (proposal.ownerId !== ownerId) throw new DeviceFabricError("safety_denied", "proposal owner does not match");
    const next = { ...proposal, status: "rejected" as const };
    this.#proposals.set(proposalId, next);
    return next;
  }

  registerTransfer(transfer: DeviceArtifactTransferV1): DeviceArtifactTransferV1 {
    const proposal = this.requireProposal(transfer.proposalId);
    if (proposal.status !== "accepted") throw new DeviceFabricError("safety_denied", "artifact transfer requires an accepted proposal");
    this.#transfers.set(transfer.transferId, transfer);
    return transfer;
  }

  acceptChunk(transferId: string, chunkIndex: number): DeviceArtifactTransferV1 {
    const transfer = this.#transfers.get(transferId);
    if (!transfer || chunkIndex < 0 || chunkIndex >= transfer.totalChunks) throw new DeviceFabricError("target_missing", "artifact transfer chunk is invalid");
    const receivedChunks = [...new Set([...transfer.receivedChunks, chunkIndex])].sort((left, right) => left - right);
    const next = { ...transfer, receivedChunks };
    this.#transfers.set(transferId, next);
    return next;
  }

  private requireProposal(proposalId: string): DeviceCollaborationProposalV1 {
    const proposal = this.#proposals.get(proposalId);
    if (!proposal) throw new DeviceFabricError("target_missing", "collaboration proposal is missing");
    return proposal;
  }
}

export function digestCollaborationPayload(payload: JsonValue): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
