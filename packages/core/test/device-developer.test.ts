import assert from "node:assert/strict";
import test from "node:test";

import {
  DeviceCollaborationCoordinator,
  DeviceDeveloperSessionCoordinator,
  digestCollaborationPayload,
} from "../dist/device-developer.js";

const now = "2026-11-21T00:00:00.000Z";

test("developer sessions bind artifacts to the target and reattach jobs", () => {
  const coordinator = new DeviceDeveloperSessionCoordinator();
  coordinator.createSession({ sessionId: "session-1", workspaceId: "workspace-1", ownerKind: "daemon", ownerId: "daemon-1", targetDeviceId: "android-1", targetKind: "android", mode: "developer", authorizationRevision: "auth-0", status: "created", revision: 1, createdAt: now, updatedAt: now });
  coordinator.authorize("session-1", "auth-1", now);
  coordinator.bindArtifact("session-1", { artifactId: "artifact-1", workspaceId: "workspace-1", targetDeviceId: "android-1", digest: "sha256:app", sizeBytes: 10, packageId: "com.example.app", createdAt: now });
  const job = coordinator.startJob({ jobId: "job-1", sessionId: "session-1", kind: "deploy", status: "running", artifactDigest: "sha256:app", targetDeviceId: "android-1", taskStatus: "executing", revision: 1, updatedAt: now });
  assert.equal(coordinator.settleJob(job.jobId, "completed", "logs-1", now).status, "completed");
  assert.equal(coordinator.getSession("session-1")?.status, "completed");
  coordinator.authorize("session-1", "auth-2", now);
  assert.throws(() => coordinator.startJob({ ...job, jobId: "job-2", artifactDigest: "sha256:other" }), /artifact/);
});

test("phone-owned collaboration proposals are idempotent and chunked transfers are scoped", () => {
  const coordinator = new DeviceCollaborationCoordinator();
  const payload = { capabilityId: "linux.inspect.network", input: { includeDns: true } };
  const proposal = { proposalId: "proposal-1", taskId: "task-1", ownerKind: "mobile", ownerId: "mobile-1", proposerKind: "daemon", proposerId: "daemon-1", targetDeviceId: "linux-1", kind: "plan", payload, payloadDigest: digestCollaborationPayload(payload), baseRevision: "rev-1", status: "proposed", createdAt: now, expiresAt: "2026-11-21T00:05:00.000Z" } as const;
  assert.equal(coordinator.propose(proposal).proposalId, coordinator.propose(proposal).proposalId);
  coordinator.accept(proposal.proposalId, "mobile-1", now);
  const transfer = coordinator.registerTransfer({ transferId: "transfer-1", proposalId: proposal.proposalId, digest: "sha256:artifact", sizeBytes: 10, chunkSizeBytes: 5, totalChunks: 2, receivedChunks: [] });
  assert.deepEqual(coordinator.acceptChunk(transfer.transferId, 1).receivedChunks, [1]);
  assert.throws(() => coordinator.acceptChunk(transfer.transferId, 2), /invalid/);
});
