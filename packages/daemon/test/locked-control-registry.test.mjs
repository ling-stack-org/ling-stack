import assert from "node:assert/strict";
import test from "node:test";

import {
  isLockedComputerControlAuditEventV1,
} from "../../contracts/dist/index.js";
import {
  LOCKED_CONTROL_ATTESTATION_FRESHNESS_MS,
  LOCKED_CONTROL_PREPARED_TTL_MS,
  LockedComputerControlRegistry,
} from "../dist/features/computer-use/locked-control-registry.js";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const baseWallMs = Date.parse("2099-01-01T00:00:00.000Z");

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
  adapterVersion: "darwin-v1",
  osVersion: "15.6",
  observedAt: "2098-12-31T23:59:00.000Z",
};

const intentInput = {
  requestId: "request-1",
  expectedRevision: 0,
  workspaceCwd: "/workspace",
  runId: "run-1",
  computerUseSessionId: "session-1",
};

const authority = {
  platform: "darwin",
  desktopInstanceId: "desktop-1",
  desktopInstanceEpoch: 1,
  daemonAuthorityEpoch: "authority-1",
  bridgeConnectionId: "bridge-1",
  authorizedNormalGeneration: 3,
  osSessionBindingDigest: digestA,
  authorizedLockEpoch: 2,
  allowedLockedToolIdsDigest: digestB,
};

const identity = {
  schemaVersion: 1,
  requestId: "request-1",
  status: "verified",
  method: "device_owner_authentication",
  verifiedAt: "2099-01-01T00:00:00.000Z",
};

function fixture({ policy = enabledPolicy, appendAudit } = {}) {
  let wallMs = baseWallMs;
  let monotonicMs = 1_000;
  let id = 0;
  const audits = [];
  const scheduled = [];
  const registry = new LockedComputerControlRegistry({
    workspaceCwd: "/workspace",
    policy,
    capability,
    isScopeActive: (input) => input.workspaceCwd === "/workspace"
      && input.runId === "run-1"
      && input.computerUseSessionId === "session-1",
    isAuthorityCurrent: (input) => input.workspaceCwd === "/workspace"
      && input.daemonAuthorityEpoch === authority.daemonAuthorityEpoch
      && input.bridgeConnectionId === authority.bridgeConnectionId
      && input.desktopInstanceEpoch === authority.desktopInstanceEpoch,
    appendAudit: appendAudit ?? ((event) => {
      assert.equal(isLockedComputerControlAuditEventV1(event), true, event.event);
      audits.push(event);
    }),
    now: () => new Date(wallMs),
    monotonicNowMs: () => monotonicMs,
    createId: () => `id-${++id}`,
    scheduleDeadline(callback, delayMs) {
      const task = { callback, due: monotonicMs + delayMs, cancelled: false };
      scheduled.push(task);
      return { cancel: () => { task.cancelled = true; } };
    },
  });

  function advance(milliseconds) {
    wallMs += milliseconds;
    monotonicMs += milliseconds;
    let ran;
    do {
      ran = false;
      for (const task of scheduled) {
        if (!task.cancelled && task.due <= monotonicMs) {
          task.cancelled = true;
          task.callback();
          ran = true;
        }
      }
    } while (ran);
  }

  return { registry, audits, advance, wallMs: () => wallMs, monotonicMs: () => monotonicMs };
}

function arm(fx, ttlSeconds = 900) {
  const begun = fx.registry.beginAuthorization(intentInput);
  assert.equal(begun.accepted, true);
  assert.equal(begun.snapshot.revision, 1);
  const prepared = fx.registry.prepare({
    requestId: "request-1",
    expectedRevision: 1,
    identity,
    authority,
    requestedTtlSeconds: ttlSeconds,
  });
  assert.equal(prepared.accepted, true);
  assert.equal(prepared.snapshot.revision, 2);
  const committed = fx.registry.commit({
    requestId: "request-1",
    grantId: prepared.grant.grantId,
    expectedRevision: 2,
  });
  assert.equal(committed.accepted, true);
  assert.equal(committed.snapshot.projection.phase, "armed");
  return prepared.grant;
}

function attestation(grant, overrides = {}) {
  return {
    schemaVersion: 1,
    grantId: grant.grantId,
    platform: "darwin",
    lockEpoch: 2,
    sessionBindingDigest: digestA,
    sameUserSession: true,
    userDesktopTargeted: true,
    captureReady: true,
    inputReady: true,
    secureSurfaceExcluded: true,
    providerGeneration: 4,
    sequence: 1,
    observedAt: "2099-01-01T00:00:01.000Z",
    ...overrides,
  };
}

test("disabled packaged policy cannot begin authorization", () => {
  const fx = fixture({ policy: disabledPolicy });
  const evaluated = fx.registry.evaluateCapability(capability, "fixture-build");
  assert.equal(evaluated.accepted, true);
  assert.equal(evaluated.snapshot.projection.capability, "disabled_by_build");
  assert.equal(evaluated.snapshot.projection.reason, "locked_control_disabled_by_build");
  const result = fx.registry.beginAuthorization({
    ...intentInput,
    expectedRevision: evaluated.snapshot.revision,
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "locked_control_disabled_by_build");
  assert.equal(result.snapshot.projection.phase, "off");
  assert.deepEqual(fx.audits.map((event) => event.event), [
    "locked_control_capability_evaluated",
  ]);
});

test("prepare, durable commit and attestation form one revisioned authority", () => {
  const fx = fixture();
  const grant = arm(fx);
  assert.deepEqual(fx.audits.map((event) => event.event), [
    "locked_control_authorization_requested",
    "locked_control_identity_resolved",
    "locked_control_grant_armed",
  ]);
  assert.equal(fx.registry.snapshot().projection.phase, "armed");

  const entered = fx.registry.acceptAttestation(attestation(grant));
  assert.equal(entered.accepted, true);
  assert.equal(entered.snapshot.projection.phase, "active_locked");
  assert.equal(entered.snapshot.projection.lockedSince, "2099-01-01T00:00:00.000Z");
  assert.equal(fx.audits.at(-1).event, "locked_control_entered");
  assert.equal(fx.registry.isCurrentPositiveAttestation({
    grantId: grant.grantId,
    platform: "darwin",
    lockEpoch: 2,
    sessionBindingDigest: digestA,
    providerGeneration: 4,
    sequence: 1,
  }), true);
});

test("request id and projection revision make authorization single-owner", () => {
  const fx = fixture();
  const begun = fx.registry.beginAuthorization(intentInput);
  assert.equal(begun.accepted, true);
  const duplicate = fx.registry.beginAuthorization({ ...intentInput, expectedRevision: 1 });
  assert.equal(duplicate.accepted, true);
  assert.equal(fx.audits.length, 1);
  const competing = fx.registry.beginAuthorization({
    ...intentInput,
    requestId: "request-2",
    expectedRevision: 1,
  });
  assert.equal(competing.accepted, false);
  assert.equal(competing.reason, "locked_control_commit_unconfirmed");
  const stale = fx.registry.prepare({
    requestId: "request-1",
    expectedRevision: 0,
    identity,
    authority,
  });
  assert.equal(stale.accepted, false);
  assert.equal(stale.reason, "locked_control_commit_unconfirmed");
});

test("audit failures cannot create partial executable authority", () => {
  let writes = 0;
  const fx = fixture({
    appendAudit() {
      writes += 1;
      if (writes === 2) {
        throw new Error("disk full");
      }
    },
  });
  assert.equal(fx.registry.beginAuthorization(intentInput).accepted, true);
  assert.throws(() => fx.registry.prepare({
    requestId: "request-1",
    expectedRevision: 1,
    identity,
    authority,
  }), /disk full/);
  assert.equal(fx.registry.snapshot().projection.phase, "verifying");

  const commitFx = fixture({
    appendAudit(event) {
      if (event.event === "locked_control_grant_armed") {
        throw new Error("audit unavailable");
      }
    },
  });
  commitFx.registry.beginAuthorization(intentInput);
  const prepared = commitFx.registry.prepare({
    requestId: "request-1",
    expectedRevision: 1,
    identity,
    authority,
  });
  assert.equal(prepared.accepted, true);
  assert.throws(() => commitFx.registry.commit({
    requestId: "request-1",
    grantId: prepared.grant.grantId,
    expectedRevision: 2,
  }), /audit unavailable/);
  assert.equal(commitFx.registry.snapshot().projection.phase, "verifying");
});

test("prepared intent and committed grant use independent monotonic expiry", () => {
  const pendingFx = fixture();
  pendingFx.registry.beginAuthorization(intentInput);
  const prepared = pendingFx.registry.prepare({
    requestId: "request-1",
    expectedRevision: 1,
    identity,
    authority,
  });
  assert.equal(prepared.accepted, true);
  pendingFx.advance(LOCKED_CONTROL_PREPARED_TTL_MS + 1);
  assert.equal(pendingFx.registry.snapshot().projection.phase, "off");
  assert.equal(pendingFx.registry.snapshot().projection.reason, "locked_control_commit_unconfirmed");

  const liveFx = fixture();
  arm(liveFx, 60);
  liveFx.advance(60_001);
  assert.equal(liveFx.registry.snapshot().projection.phase, "off");
  assert.equal(liveFx.registry.snapshot().projection.reason, "locked_control_grant_expired");
  assert.equal(liveFx.audits.at(-1).event, "locked_control_grant_revoked");
});

test("negative attestation revokes immediately and stale positive cannot overwrite", () => {
  const negativeFx = fixture();
  const negativeGrant = arm(negativeFx);
  const denied = negativeFx.registry.acceptAttestation(attestation(negativeGrant, { secureSurfaceExcluded: false }));
  assert.equal(denied.accepted, false);
  assert.equal(denied.reason, "locked_control_secure_surface");
  assert.equal(negativeFx.registry.snapshot().projection.phase, "off");
  assert.equal(negativeFx.audits.at(-1).event, "locked_control_grant_revoked");

  const staleFx = fixture();
  const staleGrant = arm(staleFx);
  staleFx.registry.acceptAttestation(attestation(staleGrant));
  const stale = staleFx.registry.acceptAttestation(attestation(staleGrant));
  assert.equal(stale.accepted, false);
  assert.equal(stale.reason, "locked_control_authority_rotated");
  assert.equal(staleFx.registry.snapshot().projection.phase, "active_locked");
});

test("attestation predicate binds every identity field and freshness", () => {
  const fx = fixture();
  const grant = arm(fx);
  fx.registry.acceptAttestation(attestation(grant));
  const current = {
    grantId: grant.grantId,
    platform: "darwin",
    lockEpoch: 2,
    sessionBindingDigest: digestA,
    providerGeneration: 4,
    sequence: 1,
  };
  for (const change of [
    { grantId: "wrong" },
    { platform: "win32" },
    { lockEpoch: 3 },
    { sessionBindingDigest: digestB },
    { providerGeneration: 5 },
    { sequence: 2 },
  ]) {
    assert.equal(fx.registry.isCurrentPositiveAttestation({ ...current, ...change }), false);
  }
  fx.advance(LOCKED_CONTROL_ATTESTATION_FRESHNESS_MS + 1);
  assert.equal(fx.registry.isCurrentPositiveAttestation(current), false);
  assert.equal(fx.registry.snapshot().projection.phase, "off");
});

test("revocation clears memory before a durable audit retry can fail", () => {
  let failRevocation = false;
  const fx = fixture({
    appendAudit(event) {
      if (failRevocation && event.event === "locked_control_grant_revoked") {
        throw new Error("disk unavailable");
      }
    },
  });
  arm(fx);
  failRevocation = true;
  const result = fx.registry.revoke("locked_control_suspend", false);
  assert.equal(result.accepted, true);
  assert.equal(fx.registry.snapshot().projection.phase, "off");
  assert.equal(fx.registry.snapshot().projection.reason, "locked_control_suspend");
});
