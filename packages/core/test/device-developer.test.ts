import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DeviceCollaborationCoordinator,
  DeviceDeveloperSessionCoordinator,
  digestCollaborationPayload,
} from "../dist/device-developer.js";
import { SqliteDeviceDeveloperStore } from "../dist/storage/sqlite/device-developer-store.js";

const now = "2026-11-21T00:00:00.000Z";

test("developer sessions bind artifacts to the target and record job state", () => {
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

test("developer sessions, jobs, proposals and artifact transfers survive SQLite reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "ling-developer-store-"));
  const path = join(root, "developer.sqlite");
  const first = new SqliteDeviceDeveloperStore({ databasePath: path });
  first.saveSession({ sessionId: "session-1", workspaceId: "workspace-1", ownerKind: "mobile", ownerId: "mobile-1", targetDeviceId: "android-1", targetKind: "android", mode: "developer", authorizationRevision: "auth-1", status: "authorized", revision: 1, createdAt: now, updatedAt: now });
  first.saveArtifact({ artifactId: "artifact-1", workspaceId: "workspace-1", targetDeviceId: "android-1", digest: "sha256:app", sizeBytes: 10, createdAt: now });
  first.saveJob({ jobId: "job-1", sessionId: "session-1", kind: "deploy", status: "running", artifactDigest: "sha256:app", targetDeviceId: "android-1", taskStatus: "executing", revision: 1, updatedAt: now });
  const payload = { capabilityId: "adb.install", digest: "sha256:app" };
  first.saveProposal({ proposalId: "proposal-1", taskId: "task-1", ownerKind: "mobile", ownerId: "mobile-1", proposerKind: "daemon", proposerId: "daemon-1", targetDeviceId: "android-1", kind: "artifact", payload, payloadDigest: digestCollaborationPayload(payload), baseRevision: "rev-1", status: "accepted", createdAt: now, expiresAt: "2026-11-21T00:05:00.000Z" });
  first.saveTransfer({ transferId: "transfer-1", proposalId: "proposal-1", digest: "sha256:app", sizeBytes: 10, chunkSizeBytes: 5, totalChunks: 2, receivedChunks: [] });
  first.close();
  const second = new SqliteDeviceDeveloperStore({ databasePath: path });
  assert.equal(second.getSession("session-1")?.ownerId, "mobile-1");
  assert.equal(second.getJob("job-1")?.status, "running");
  assert.deepEqual(second.acceptChunk("transfer-1", 1).receivedChunks, [1]);
  second.close();
});

test("collaboration coordinator reads and writes proposals and transfers through the durable store", () => {
  const root = mkdtempSync(join(tmpdir(), "ling-collaboration-store-"));
  const path = join(root, "developer.sqlite");
  const firstStore = new SqliteDeviceDeveloperStore({ databasePath: path });
  const payload = { capabilityId: "adb.install", input: { packageId: "com.example.app" } };
  const proposal = { proposalId: "proposal-durable", taskId: "task-1", ownerKind: "mobile", ownerId: "mobile-1",
    proposerKind: "daemon", proposerId: "daemon-1", targetDeviceId: "android-1", kind: "artifact", payload,
    payloadDigest: digestCollaborationPayload(payload), baseRevision: "rev-1", status: "proposed",
    createdAt: now, expiresAt: "2026-11-21T00:05:00.000Z" } as const;
  try {
    const first = new DeviceCollaborationCoordinator({ store: firstStore });
    assert.deepEqual(first.propose(proposal), proposal);
    assert.equal(first.accept(proposal.proposalId, "mobile-1", now).status, "accepted");
    const transfer = first.registerTransfer({ transferId: "transfer-durable", proposalId: proposal.proposalId,
      digest: "sha256:artifact", sizeBytes: 10, chunkSizeBytes: 5, totalChunks: 2, receivedChunks: [] });
    assert.deepEqual(first.acceptChunk(transfer.transferId, 1).receivedChunks, [1]);
  } finally {
    firstStore.close();
  }
  const secondStore = new SqliteDeviceDeveloperStore({ databasePath: path });
  try {
    const second = new DeviceCollaborationCoordinator({ store: secondStore });
    assert.equal(second.propose(proposal).status, "accepted");
    assert.deepEqual(second.acceptChunk("transfer-durable", 0).receivedChunks, [0, 1]);
    assert.throws(() => second.accept(proposal.proposalId, "mobile-1", now), /no longer actionable/);
  } finally {
    secondStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("developer session and job transitions commit together and restore after SQLite reopen", t => {
  const root = mkdtempSync(join(tmpdir(), "ling-developer-coordinator-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "developer.sqlite");
  const firstStore = new SqliteDeviceDeveloperStore({ databasePath: path });
  const first = new DeviceDeveloperSessionCoordinator({ store: firstStore });
  const session = { sessionId: "session-1", workspaceId: "workspace-1", ownerKind: "daemon", ownerId: "daemon-1",
    targetDeviceId: "android-1", targetKind: "android", mode: "developer", authorizationRevision: "auth-0",
    status: "created", revision: 1, createdAt: now, updatedAt: now } as const;
  const job = { jobId: "job-1", sessionId: session.sessionId, kind: "logs", status: "running",
    targetDeviceId: session.targetDeviceId, taskStatus: "executing", revision: 1, updatedAt: now } as const;
  try {
    first.createSession(session);
    first.authorize(session.sessionId, "auth-1", now);
    firstStore.database.exec(`
      CREATE TEMP TRIGGER reject_developer_session_update BEFORE UPDATE ON device_developer_sessions
      BEGIN SELECT RAISE(ABORT, 'fixture session write failure'); END;
    `);
    assert.throws(() => first.startJob(job), /fixture session write failure/);
    assert.equal(first.getJob(job.jobId), undefined);
    assert.equal(first.getSession(session.sessionId)?.status, "authorized");
    firstStore.database.exec("DROP TRIGGER reject_developer_session_update");
    assert.deepEqual(first.startJob(job), job);
  } finally {
    firstStore.close();
  }
  const secondStore = new SqliteDeviceDeveloperStore({ databasePath: path });
  const second = new DeviceDeveloperSessionCoordinator({ store: secondStore });
  try {
    assert.equal(second.getSession(session.sessionId)?.status, "running");
    assert.throws(() => second.createSession(session), /already exists/);
    assert.throws(() => second.startJob({ ...job, targetDeviceId: "other-device" }), /another job/);
    assert.deepEqual(second.startJob(job), job);
    const settled = second.settleJob(job.jobId, "unknown", "output-ref", now);
    assert.equal(second.getSession(session.sessionId)?.status, "paused");
    assert.deepEqual(second.startJob(job), settled);
    assert.throws(() => second.settleJob(job.jobId, "completed", undefined, now), /retained outcome/);
  } finally {
    secondStore.close();
  }
});
