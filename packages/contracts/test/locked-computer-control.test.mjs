import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_LOCKED_COMPUTER_CONTROL_POLICIES,
  LOCKED_COMPUTER_CONTROL_CAPABILITY_STATES,
  LOCKED_COMPUTER_CONTROL_MAX_GRANT_TTL_SECONDS,
  LOCKED_COMPUTER_CONTROL_REASON_CODES,
  isLockedComputerControlAttestationV1,
  isLockedComputerControlAuditEventV1,
  isLockedComputerControlCapabilityV1,
  isLockedComputerControlGrantV1,
  isLockedComputerControlPolicyV1,
  isLockedComputerControlProjectionV1,
  isLockedControlIdentityResultV1,
  isLockedControlReasonCode,
  isPositiveLockedComputerControlAttestationV1,
} from "../dist/index.js";

const now = "2026-07-31T00:00:00.000Z";
const later = "2026-07-31T00:15:00.000Z";
const digestA = "a".repeat(64);
const digestB = "b".repeat(64);

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
  observedAt: now,
};

const grant = {
  schemaVersion: 1,
  grantId: "grant-1",
  issuedAt: now,
  expiresAt: later,
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
  authorizedLockEpoch: 2,
  allowedLockedToolIdsDigest: digestB,
};

const attestation = {
  schemaVersion: 1,
  grantId: "grant-1",
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
  observedAt: now,
};

test("locked Computer Control packaged policy is valid and disabled on both platforms", () => {
  assert.equal(LOCKED_COMPUTER_CONTROL_MAX_GRANT_TTL_SECONDS, 900);
  assert.deepEqual(Object.keys(DEFAULT_LOCKED_COMPUTER_CONTROL_POLICIES), ["darwin", "win32"]);
  for (const policy of Object.values(DEFAULT_LOCKED_COMPUTER_CONTROL_POLICIES)) {
    assert.equal(isLockedComputerControlPolicyV1(policy), true);
    assert.equal(policy.mode, "disabled");
  }
  assert.equal(isLockedComputerControlPolicyV1({
    ...DEFAULT_LOCKED_COMPUTER_CONTROL_POLICIES.darwin,
    mode: "task_grant_required",
    maxGrantTtlSeconds: 901,
  }), false);
  assert.equal(isLockedComputerControlPolicyV1({
    ...DEFAULT_LOCKED_COMPUTER_CONTROL_POLICIES.darwin,
    requireLocalUserVerification: false,
  }), false);
  assert.equal(isLockedComputerControlPolicyV1({
    ...DEFAULT_LOCKED_COMPUTER_CONTROL_POLICIES.darwin,
    futureAuthority: true,
  }), false);
});

test("reason codes are closed and include input-fence failure", () => {
  for (const reason of LOCKED_COMPUTER_CONTROL_REASON_CODES) {
    assert.equal(isLockedControlReasonCode(reason), true);
  }
  assert.equal(isLockedControlReasonCode("locked_control_input_fence_timeout"), true);
  assert.equal(isLockedControlReasonCode("native error: password was 1234"), false);
});

test("capability accepts every state but only positive proof may be supported", () => {
  for (const state of LOCKED_COMPUTER_CONTROL_CAPABILITY_STATES) {
    const candidate = state === "supported_restricted"
      ? capability
      : {
          ...capability,
          state,
          reason: state === "disabled_by_build"
            ? "locked_control_disabled_by_build"
            : state === "probe_required"
              ? "locked_control_probe_required"
              : "locked_control_platform_unsupported",
          canInjectSameUserDesktopWhileLocked: false,
        };
    assert.equal(isLockedComputerControlCapabilityV1(candidate), true, state);
  }
  assert.equal(isLockedComputerControlCapabilityV1({
    ...capability,
    reason: "locked_control_probe_required",
  }), false);
  assert.equal(isLockedComputerControlCapabilityV1({
    ...capability,
    state: "unsupported",
    reason: "locked_control_platform_unsupported",
  }), false, "unsupported cannot carry an all-positive proof");
  assert.equal(isLockedComputerControlCapabilityV1({
    ...capability,
    observedAt: "2026-07-31T00:00:00Z",
  }), false, "timestamps must be canonical UTC milliseconds");
  assert.equal(isLockedComputerControlCapabilityV1({ ...capability, rawNativeError: "secret" }), false);
});

test("identity result requires exact success and failure fields", () => {
  const base = {
    schemaVersion: 1,
    requestId: "request-1",
    method: "device_owner_authentication",
  };
  assert.equal(isLockedControlIdentityResultV1({ ...base, status: "verified", verifiedAt: now }), true);
  for (const [status, reason] of [
    ["cancelled", "locked_control_identity_cancelled"],
    ["failed", "locked_control_identity_failed"],
    ["unavailable", "locked_control_identity_unavailable"],
  ]) {
    assert.equal(isLockedControlIdentityResultV1({ ...base, status, reason }), true);
  }
  assert.equal(isLockedControlIdentityResultV1({
    ...base,
    status: "verified",
    verifiedAt: now,
    reason: "locked_control_identity_failed",
  }), false);
  assert.equal(isLockedControlIdentityResultV1({
    ...base,
    status: "failed",
    reason: "locked_control_identity_cancelled",
  }), false);
  assert.equal(isLockedControlIdentityResultV1({
    ...base,
    status: "cancelled",
    verifiedAt: now,
    reason: "locked_control_identity_cancelled",
  }), false);
});

test("grant validates scope, exact TTL and authority digests", () => {
  assert.equal(isLockedComputerControlGrantV1(grant), true);
  assert.equal(isLockedComputerControlGrantV1(grant, 600), false);
  assert.equal(isLockedComputerControlGrantV1({ ...grant, ttlSeconds: 901 }), false);
  assert.equal(isLockedComputerControlGrantV1({ ...grant, expiresAt: "2026-07-31T00:14:59.000Z" }), false);
  assert.equal(isLockedComputerControlGrantV1({ ...grant, platform: "linux" }), false);
  assert.equal(isLockedComputerControlGrantV1({ ...grant, osSessionBindingDigest: "nope" }), false);
  assert.equal(isLockedComputerControlGrantV1({ ...grant, authorizedNormalGeneration: -1 }), false);
  assert.equal(isLockedComputerControlGrantV1({ ...grant, credentialBlob: "forbidden" }), false);
});

test("attestation accepts negative facts but positive predicate requires all proofs", () => {
  assert.equal(isLockedComputerControlAttestationV1(attestation), true);
  assert.equal(isPositiveLockedComputerControlAttestationV1(attestation), true);
  for (const field of [
    "sameUserSession",
    "userDesktopTargeted",
    "captureReady",
    "inputReady",
    "secureSurfaceExcluded",
  ]) {
    const negative = { ...attestation, [field]: false };
    assert.equal(isLockedComputerControlAttestationV1(negative), true, field);
    assert.equal(isPositiveLockedComputerControlAttestationV1(negative), false, field);
  }
  assert.equal(isLockedComputerControlAttestationV1({ ...attestation, sequence: 0 }), false);
  assert.equal(isLockedComputerControlAttestationV1({ ...attestation, sessionBindingDigest: digestB.slice(1) }), false);
  assert.equal(isLockedComputerControlAttestationV1({ ...attestation, platform: "win32", frame: "pixels" }), false);
});

test("projection accepts reachable states and rejects impossible authority", () => {
  const scope = {
    grantId: grant.grantId,
    runId: grant.runId,
    computerUseSessionId: grant.computerUseSessionId,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
  };
  const valid = [
    { schemaVersion: 1, capability: "unsupported", phase: "off", reason: "locked_control_platform_unsupported" },
    { schemaVersion: 1, capability: "supported_restricted", phase: "off" },
    { schemaVersion: 1, capability: "supported_restricted", phase: "verifying" },
    { schemaVersion: 1, capability: "supported_restricted", phase: "armed", ...scope },
    { schemaVersion: 1, capability: "supported_restricted", phase: "active_locked", ...scope, lockedSince: now },
    { schemaVersion: 1, capability: "supported_restricted", phase: "paused", ...scope, lockedSince: now, reason: "locked_control_approval_required" },
  ];
  for (const projection of valid) {
    assert.equal(isLockedComputerControlProjectionV1(projection), true, projection.phase);
  }
  assert.equal(isLockedComputerControlProjectionV1({
    schemaVersion: 1,
    capability: "supported_restricted",
    phase: "active_locked",
    lockedSince: now,
  }), false, "active requires the full grant projection");
  assert.equal(isLockedComputerControlProjectionV1({
    schemaVersion: 1,
    capability: "supported_restricted",
    phase: "armed",
    ...scope,
    reason: "locked_control_grant_expired",
  }), false);
  assert.equal(isLockedComputerControlProjectionV1({
    schemaVersion: 1,
    capability: "probe_required",
    phase: "off",
  }), false, "negative capability requires reason");
  assert.equal(isLockedComputerControlProjectionV1({
    schemaVersion: 1,
    capability: "probe_required",
    phase: "armed",
    reason: "locked_control_probe_required",
    ...scope,
  }), false);
});

test("audit events enforce closed content-free event payloads", () => {
  const common = { schemaVersion: 1, auditId: "audit-1", platform: "darwin", occurredAt: now };
  const events = [
    { ...common, event: "locked_control_capability_evaluated", capability: "supported_restricted", adapterVersion: "darwin-v1", buildId: "build-1" },
    { ...common, event: "locked_control_authorization_requested", intentId: "intent-1", runId: "run-1", computerUseSessionId: "session-1", ttlCeilingSeconds: 900 },
    { ...common, event: "locked_control_identity_resolved", identityStatus: "verified", identityMethod: "device_owner_authentication" },
    { ...common, event: "locked_control_grant_armed", grantId: "grant-1", runId: "run-1", computerUseSessionId: "session-1", expiresAt: later, authorityDigest: digestA, generationDigest: digestB },
    { ...common, event: "locked_control_entered", grantId: "grant-1", lockEpoch: 2, providerGeneration: 4, sameUserSession: true, userDesktopTargeted: true, captureReady: true, inputReady: true, secureSurfaceExcluded: true },
    { ...common, event: "locked_control_action_denied", toolId: "click", toolCallId: "call-1", reason: "locked_control_approval_required" },
    { ...common, event: "locked_control_grant_revoked", grantId: "grant-1", trigger: "locked_control_input_fence_timeout", reason: "locked_control_input_fence_timeout", acknowledged: false, terminalAt: now },
    { ...common, event: "locked_control_recovered_unlocked", previousGeneration: 4, nextGeneration: 5, result: "ready" },
  ];
  for (const event of events) {
    assert.equal(isLockedComputerControlAuditEventV1(event), true, event.event);
  }
  assert.equal(isLockedComputerControlAuditEventV1({ ...events[0], screenshotBase64: "forbidden" }), false);
  assert.equal(isLockedComputerControlAuditEventV1({
    ...events[2],
    identityStatus: "failed",
  }), false, "failed identity audit requires a reason");
  assert.equal(isLockedComputerControlAuditEventV1({
    ...events[6],
    reason: "locked_control_suspend",
  }), false, "revoke reason must match its trigger");
});

test("optional setup projection remains backwards compatible", async () => {
  const legacySetup = {
    kind: "local_binary",
    state: "ready",
    checkedAt: now,
  };
  assert.equal("lockedControl" in legacySetup, false);
  const newSetup = {
    ...legacySetup,
    lockedControl: {
      schemaVersion: 1,
      capability: "disabled_by_build",
      phase: "off",
      reason: "locked_control_disabled_by_build",
    },
  };
  assert.equal(isLockedComputerControlProjectionV1(newSetup.lockedControl), true);
  assert.deepEqual(
    (({ lockedControl: _ignored, ...oldConsumer }) => oldConsumer)(newSetup),
    legacySetup,
  );
});
