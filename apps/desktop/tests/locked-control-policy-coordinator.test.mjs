import assert from "node:assert/strict";
import test from "node:test";
import { LockedComputerControlPolicyCoordinator } from "../dist/main/locked-computer-control/policy-coordinator.js";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const enabledPolicy = {
  schemaVersion: 1,
  mode: "task_grant_required",
  maxGrantTtlSeconds: 900,
  requireLocalUserVerification: true,
  consumeOnUnlock: true,
  suspendRevokes: true,
  lockedToolPolicyRevision: "locked-cua-tools-v1",
  allowedLockedToolIdsSha256: digestB,
};
const disabledPolicy = { ...enabledPolicy, mode: "disabled" };
const capability = {
  schemaVersion: 1,
  platform: "darwin",
  state: "supported_restricted",
  canCaptureSameUserDesktopWhileLocked: true,
  canInjectSameUserDesktopWhileLocked: true,
  canProveSessionContinuity: true,
  secureSurfaceExcluded: true,
  adapterVersion: "darwin-test-v1",
  osVersion: "test-os",
  observedAt: "2026-07-31T00:00:00.000Z",
};

test("policy coordinator arms, rotates into one locked generation and consumes on unlock", async () => {
  const fx = fixture();
  assert.deepEqual(await fx.coordinator.authorizeCurrentTask(), { accepted: true });
  assert.equal(fx.coordinator.snapshot().phase, "armed");
  assert.equal(fx.coordinator.snapshot().grantId, "grant-1");

  await fx.coordinator.handleLock();
  assert.equal(fx.coordinator.snapshot().phase, "active_locked");
  assert.equal(fx.coordinator.snapshot().lockEpoch, 1);
  assert.deepEqual(fx.order.slice(0, 5), [
    "gate:locked_control_session_mismatch",
    "retire:locked_control_session_mismatch",
    "reserve:4",
    "attest:4",
    "start:4",
  ]);

  await fx.coordinator.handleUnlock();
  assert.equal(fx.coordinator.snapshot().phase, "off");
  assert.equal(fx.coordinator.snapshot().reason, "locked_control_grant_consumed");
  assert.ok(fx.order.includes("stop:locked_control_grant_consumed"));
  assert.ok(fx.order.includes("resume"));
  assert.equal(fx.daemonCalls.revoke, 1);
  await fx.coordinator.shutdown();
});

test("a lock arriving during OS identity verification invalidates the late success", async () => {
  const identityStarted = deferred();
  const releaseIdentity = deferred();
  const fx = fixture({
    identityVerifier: {
      async verify(requestId) {
        identityStarted.resolve();
        await releaseIdentity.promise;
        return {
          schemaVersion: 1,
          requestId,
          status: "verified",
          method: "device_owner_authentication",
          verifiedAt: new Date().toISOString(),
        };
      },
    },
  });
  const authorizing = fx.coordinator.authorizeCurrentTask();
  await identityStarted.promise;
  const locking = fx.coordinator.handleLock();
  assert.equal(fx.order[0], "gate:locked_control_session_mismatch");
  releaseIdentity.resolve();

  assert.deepEqual(await authorizing, {
    accepted: false,
    reason: "locked_control_authority_rotated",
  });
  await locking;
  assert.equal(fx.coordinator.snapshot().phase, "off");
  assert.equal(fx.daemonCalls.prepare, 0);
  assert.equal(fx.daemonCalls.revoke, 1);
  assert.equal(fx.order.some((value) => value.startsWith("start:")), false);
  await fx.coordinator.shutdown();
});

test("disabled packaged policy cannot open identity UI or contact mutation routes", async () => {
  let identityCalls = 0;
  const fx = fixture({
    policy: disabledPolicy,
    identityVerifier: {
      async verify() {
        identityCalls += 1;
        throw new Error("must not run");
      },
    },
  });
  assert.deepEqual(await fx.coordinator.authorizeCurrentTask(), {
    accepted: false,
    reason: "locked_control_disabled_by_build",
  });
  assert.equal(identityCalls, 0);
  assert.equal(fx.daemonCalls.snapshot, 0);
  assert.equal(fx.coordinator.snapshot().phase, "off");
  await fx.coordinator.shutdown();
});

test("cancelled identity is reported for durable audit before local revocation", async () => {
  const fx = fixture({
    identityVerifier: {
      async verify(requestId) {
        return {
          schemaVersion: 1,
          requestId,
          status: "cancelled",
          method: "device_owner_authentication",
          reason: "locked_control_identity_cancelled",
        };
      },
    },
  });
  assert.deepEqual(await fx.coordinator.authorizeCurrentTask(), {
    accepted: false,
    reason: "locked_control_identity_cancelled",
  });
  assert.equal(fx.daemonCalls.prepare, 1);
  assert.equal(fx.daemonCalls.commit, 0);
  assert.equal(fx.daemonCalls.revoke, 1);
  await fx.coordinator.shutdown();
});

test("failed input-fence retirement revokes and never starts a locked generation", async () => {
  const fx = fixture({ retireFails: true });
  assert.equal((await fx.coordinator.authorizeCurrentTask()).accepted, true);
  await fx.coordinator.handleLock();
  assert.equal(fx.coordinator.snapshot().phase, "off");
  assert.equal(fx.coordinator.snapshot().reason, "locked_control_input_fence_timeout");
  assert.equal(fx.order.some((value) => value.startsWith("start:")), false);
  assert.equal(fx.daemonCalls.revoke, 1);
  await fx.coordinator.shutdown();
});

test("unlock during locked attestation invalidates the late result before generation start", async () => {
  const attestationStarted = deferred();
  const releaseAttestation = deferred();
  const fx = fixture({
    attestor: {
      async attest(input) {
        fx.order.push(`attest:${input.reservedProviderGeneration}`);
        attestationStarted.resolve();
        await releaseAttestation.promise;
        return positiveAttestation(input);
      },
    },
  });
  assert.equal((await fx.coordinator.authorizeCurrentTask()).accepted, true);
  const locking = fx.coordinator.handleLock();
  await attestationStarted.promise;
  const unlocking = fx.coordinator.handleUnlock();
  releaseAttestation.resolve();

  await locking;
  await unlocking;
  assert.equal(fx.order.some((value) => value.startsWith("start:")), false);
  assert.equal(fx.coordinator.snapshot().phase, "off");
  assert.equal(fx.coordinator.snapshot().reason, "locked_control_grant_consumed");
  assert.ok(fx.order.includes("resume"));
  await fx.coordinator.shutdown();
});

function fixture({ policy = enabledPolicy, identityVerifier, attestor, retireFails = false } = {}) {
  const order = [];
  const daemonCalls = { snapshot: 0, begin: 0, prepare: 0, commit: 0, attest: 0, revoke: 0 };
  const authority = {
    platform: "darwin",
    desktopInstanceId: "desktop-1",
    desktopInstanceEpoch: 1,
    daemonAuthorityEpoch: "authority-1",
    bridgeConnectionId: "bridge-1",
    workspaceCwd: "/workspace",
    normalGeneration: 3,
    lockEpoch: 0,
    sessionBindingDigest: digestA,
  };
  const offProjection = {
    schemaVersion: 1,
    capability: "supported_restricted",
    phase: "off",
  };
  const grant = {
    schemaVersion: 1,
    grantId: "grant-1",
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    ttlSeconds: 900,
    workspaceCwd: "/workspace",
    runId: "run-1",
    computerUseSessionId: "session-1",
    platform: "darwin",
    desktopInstanceId: "desktop-1",
    desktopInstanceEpoch: 1,
    daemonAuthorityEpoch: "authority-1",
    bridgeConnectionId: "bridge-1",
    authorizedNormalGeneration: 3,
    osSessionBindingDigest: digestA,
    authorizedLockEpoch: 1,
    allowedLockedToolIdsDigest: digestB,
  };
  const daemon = {
    async snapshot() {
      daemonCalls.snapshot += 1;
      return { revision: 0, projection: offProjection };
    },
    async beginAuthorization() {
      daemonCalls.begin += 1;
      return {
        accepted: true,
        snapshot: {
          revision: 1,
          projection: { ...offProjection, phase: "verifying", runId: "run-1", computerUseSessionId: "session-1" },
        },
      };
    },
    async prepare() {
      daemonCalls.prepare += 1;
      return {
        accepted: true,
        grant,
        snapshot: { revision: 2, projection: { ...offProjection, phase: "verifying" } },
      };
    },
    async commit() {
      daemonCalls.commit += 1;
      return {
        accepted: true,
        snapshot: { revision: 3, projection: { ...offProjection, phase: "armed", grantId: "grant-1" } },
      };
    },
    async reconcile() {
      return { revision: 3, projection: { ...offProjection, phase: "armed", grantId: "grant-1" } };
    },
    async publishAttestation() {
      daemonCalls.attest += 1;
      return {
        accepted: true,
        snapshot: { revision: 4, projection: { ...offProjection, phase: "active_locked", grantId: "grant-1" } },
      };
    },
    async publishCapability() {
      throw new Error("not used");
    },
    async revoke() {
      daemonCalls.revoke += 1;
      return { accepted: true, snapshot: { revision: 5, projection: offProjection } };
    },
  };
  const runtime = {
    readAuthority() { return authority; },
    closeCallGate(reason) { order.push(`gate:${reason}`); },
    async retireNormalForLock(reason) {
      order.push(`retire:${reason}`);
      if (retireFails) throw new Error("input fence missed");
    },
    reserveLockedGeneration() {
      order.push("reserve:4");
      return 4;
    },
    async startLockedGeneration({ generation }) { order.push(`start:${generation}`); },
    async stopLockedGeneration(reason) { order.push(`stop:${reason}`); },
    async resumeNormal() { order.push("resume"); },
  };
  const coordinator = new LockedComputerControlPolicyCoordinator({
    policy,
    capability: () => capability,
    daemon,
    identityVerifier: identityVerifier ?? {
      async verify(requestId) {
        return {
          schemaVersion: 1,
          requestId,
          status: "verified",
          method: "device_owner_authentication",
          verifiedAt: new Date().toISOString(),
        };
      },
    },
    attestor: attestor ?? {
      async attest(input) {
        order.push(`attest:${input.reservedProviderGeneration}`);
        return positiveAttestation(input);
      },
    },
    runtime,
    createRequestId: () => "request-1",
  });
  return { coordinator, order, daemonCalls };
}

function positiveAttestation(input) {
  return {
    ok: true,
    attestation: {
      schemaVersion: 1,
      grantId: "grant-1",
      platform: "darwin",
      lockEpoch: 1,
      sessionBindingDigest: digestA,
      sameUserSession: true,
      userDesktopTargeted: true,
      captureReady: true,
      inputReady: true,
      secureSurfaceExcluded: true,
      providerGeneration: input.reservedProviderGeneration,
      sequence: input.sequence,
      observedAt: new Date().toISOString(),
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
