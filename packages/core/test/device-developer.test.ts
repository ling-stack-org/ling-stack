import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

test("a project build publishes the job and exact APK artifact in one SQLite transaction", t => {
  const store = new SqliteDeviceDeveloperStore();
  t.after(() => store.close());
  const coordinator = new DeviceDeveloperSessionCoordinator({ store });
  const session = coordinator.createSession({
    sessionId: "pc-build", workspaceId: "workspace", ownerKind: "daemon", ownerId: "workspace", targetDeviceId: "pc",
    targetKind: "pc", mode: "developer", authorizationRevision: "auth", status: "authorized", revision: 1,
    createdAt: now, updatedAt: now,
  });
  const job = coordinator.startJob({
    jobId: "build", sessionId: session.sessionId, buildId: "android-debug", kind: "build", status: "running",
    targetDeviceId: session.targetDeviceId, authorizationRevision: session.authorizationRevision,
    taskStatus: "executing", revision: 1, updatedAt: now,
  });
  const artifact = {
    artifactId: "pc-artifact", workspaceId: session.workspaceId, targetDeviceId: job.targetDeviceId, packageId: "org.example.preview",
    digest: "sha256:" + "a".repeat(64), sizeBytes: 80, createdAt: now,
    androidApk: { versionCode: "71", signerCertificateSha256: ["b".repeat(64)] },
    build: { jobId: job.jobId, buildId: "android-debug", fileName: "preview.apk", configurationDigest: "sha256:" + "c".repeat(64),
      toolchain: "Android SDK", variant: "debug", sourceRevision: "1".repeat(40), sourceModified: false },
  };
  assert.throws(() => coordinator.completeBuildJob(job.jobId, { ...artifact, targetDeviceId: "other-pc" }, now), /admitted job/u);
  store.database.exec("CREATE TRIGGER reject_job_update BEFORE UPDATE ON device_developer_jobs BEGIN SELECT RAISE(ABORT, 'fixture write failed'); END");
  assert.throws(() => coordinator.completeBuildJob(job.jobId, artifact, now), /fixture write failed/u);
  assert.equal(coordinator.getArtifact(artifact.artifactId), undefined);
  assert.deepEqual(coordinator.getJob(job.jobId), job);
  assert.equal(coordinator.getSession(session.sessionId)?.status, "running");
  store.database.exec("DROP TRIGGER reject_job_update");
  const completed = coordinator.completeBuildJob(job.jobId, artifact, now);
  assert.equal(completed.status, "completed");
  assert.equal(completed.outputRef, artifact.artifactId);
  assert.equal(completed.outputDigest, artifact.digest.slice(7));
  assert.deepEqual(coordinator.getArtifact(artifact.artifactId), artifact);
  assert.deepEqual(coordinator.admitJob(job), { job: completed, admitted: false });
});

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

test("target-bound sessions fence authorization revisions and developer job admission", () => {
  const coordinator = new DeviceDeveloperSessionCoordinator();
  const base = {
    workspaceId: "workspace-1", ownerKind: "daemon", ownerId: "daemon-1", targetDeviceId: "android-1", targetKind: "android",
    authorizationRevision: "pending", targetBinding: { profileRevision: "profile-1", connectionRevision: "connection-1" },
    status: "created", revision: 1, createdAt: now, updatedAt: now,
  } as const;
  const standard = coordinator.createSession({ ...base, sessionId: "standard", mode: "standard" });
  const developer = coordinator.createSession({ ...base, sessionId: "developer", mode: "developer" });
  coordinator.authorize(standard.sessionId, "standard-auth", now, standard.revision);
  assert.throws(() => coordinator.authorize(developer.sessionId, "stale-auth", now, developer.revision + 1), { code: "revision_conflict" });
  assert.deepEqual(coordinator.getSession(developer.sessionId), developer);
  coordinator.authorize(developer.sessionId, "developer-auth", now, developer.revision);
  const job = {
    jobId: "job-1", sessionId: developer.sessionId, kind: "logs", status: "running", targetDeviceId: base.targetDeviceId,
    taskStatus: "executing", revision: 1, updatedAt: now,
  } as const;
  assert.throws(() => coordinator.startJob({ ...job, sessionId: standard.sessionId, authorizationRevision: "standard-auth" }), { code: "safety_denied" });
  assert.throws(() => coordinator.startJob(job), { code: "safety_denied" });
  assert.equal(coordinator.getJob(job.jobId), undefined);
  const authorizedJob = { ...job, authorizationRevision: "developer-auth" };
  assert.deepEqual(coordinator.startJob(authorizedJob), authorizedJob);
  assert.deepEqual(coordinator.startJob(authorizedJob), authorizedJob);
  assert.throws(() => coordinator.startJob({ ...authorizedJob, authorizationRevision: "wrong" }), { code: "revision_conflict" });
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

test("collaboration verifies scoped artifact bytes across reopen before reporting completion", t => {
  const root = mkdtempSync(join(tmpdir(), "ling-collaboration-artifact-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "developer.sqlite");
  const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const artifact = Buffer.from("ling-build-artifact");
  const offer = { digest: digest(artifact), sizeBytes: artifact.byteLength };
  const proposal = {
    proposalId: "build-output", taskId: "phone-workbench", kind: "artifact", ownerKind: "mobile",
    ownerId: "phone-1", proposerKind: "daemon", proposerId: "pc-1", targetDeviceId: "head-unit-1",
    payload: offer, payloadDigest: digestCollaborationPayload(offer), baseRevision: "phone-task-r1",
    status: "proposed", createdAt: now, expiresAt: "2026-11-21T00:05:00.000Z",
  } as const;
  const ids = { transferId: "app-transfer", proposalId: proposal.proposalId };
  const scope = { ...ids, ownerId: proposal.ownerId, targetDeviceId: proposal.targetDeviceId, taskRevision: proposal.baseRevision, now };
  const firstPart = artifact.subarray(0, 10);
  const lastPart = artifact.subarray(10);
  const firstChunk = { ...scope, chunkIndex: 0, bytes: firstPart, chunkDigest: digest(firstPart) };
  const lastChunk = { ...scope, chunkIndex: 1, bytes: lastPart, chunkDigest: digest(lastPart) };
  const firstStore = new SqliteDeviceDeveloperStore({ databasePath: path });
  try {
    const owner = new DeviceCollaborationCoordinator({ store: firstStore });
    owner.propose(proposal);
    owner.accept(proposal.proposalId, proposal.ownerId, now);
    owner.registerTransfer({ ...ids, ...offer, chunkSizeBytes: 10, totalChunks: 2, receivedChunks: [] });
    owner.acceptChunk(ids.transferId, 0);
    assert.throws(() => owner.receiveArtifactChunk({ ...lastChunk, ownerId: "phone-2" }), { code: "safety_denied" });
    assert.throws(() => owner.receiveArtifactChunk({ ...lastChunk, targetDeviceId: "head-unit-2" }), { code: "safety_denied" });
    assert.throws(() => owner.receiveArtifactChunk({ ...lastChunk, chunkDigest: digest(firstPart) }), { code: "revision_conflict" });
    assert.deepEqual(owner.receiveArtifactChunk(lastChunk), { ...ids, targetDeviceId: scope.targetDeviceId,
      status: "receiving", verifiedChunkIndexes: [1] });
  } finally {
    firstStore.close();
  }
  const reopened = new SqliteDeviceDeveloperStore({ databasePath: path });
  try {
    const owner = new DeviceCollaborationCoordinator({ store: reopened });
    const otherBytes = Buffer.alloc(firstPart.byteLength);
    assert.throws(() => owner.receiveArtifactChunk({ ...firstChunk, now: proposal.expiresAt }), { code: "safety_denied" });
    assert.throws(() => owner.receiveArtifactChunk({ ...firstChunk, bytes: otherBytes, chunkDigest: digest(otherBytes) }),
      /assembled artifact digest/u);
    assert.deepEqual(reopened.listStoredArtifactChunkIndexes(ids.transferId), [1]);
    const settled = owner.receiveArtifactChunk(firstChunk);
    assert.deepEqual(settled, { ...ids, targetDeviceId: scope.targetDeviceId, status: "verified",
      verifiedChunkIndexes: [0, 1], artifactDigest: offer.digest });
    assert.deepEqual(owner.receiveArtifactChunk(lastChunk), settled);
  } finally {
    reopened.close();
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

test("recovery converts daemon jobs left running by a restart into an unknown outcome", () => {
  const root = mkdtempSync(join(tmpdir(), "ling-developer-recovery-"));
  const path = join(root, "developer.sqlite");
  const session = { sessionId: "recovery-session", workspaceId: "workspace-1", ownerKind: "daemon", ownerId: "daemon-1",
    targetDeviceId: "pc-1", targetKind: "pc", mode: "developer", authorizationRevision: "auth-1",
    status: "running", revision: 2, createdAt: now, updatedAt: now } as const;
  const job = { jobId: "recovery-job", sessionId: session.sessionId, kind: "logs", status: "running",
    targetDeviceId: session.targetDeviceId, authorizationRevision: session.authorizationRevision,
    taskStatus: "executing", revision: 1, updatedAt: now } as const;
  const firstStore = new SqliteDeviceDeveloperStore({ databasePath: path });
  firstStore.saveSession(session);
  firstStore.saveJob(job);
  firstStore.close();
  const secondStore = new SqliteDeviceDeveloperStore({ databasePath: path });
  try {
    const coordinator = new DeviceDeveloperSessionCoordinator({ store: secondStore });
    coordinator.recoverInterruptedJobs({ ownerKind: "daemon", ownerId: "daemon-1" }, "2026-11-22T00:00:00.000Z");
    assert.equal(coordinator.getJob(job.jobId)?.status, "unknown");
    assert.equal(coordinator.getSession(session.sessionId)?.status, "paused");
    coordinator.recoverInterruptedJobs({ ownerKind: "daemon", ownerId: "daemon-1" }, "2026-11-22T00:01:00.000Z");
    assert.equal(coordinator.getJob(job.jobId)?.status, "unknown");
  } finally {
    secondStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});
