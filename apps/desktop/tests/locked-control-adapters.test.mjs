import assert from "node:assert/strict";
import test from "node:test";

import {
  createLockedControlCapabilityAttestor,
} from "../dist/main/locked-computer-control/capability-attestor.js";
import {
  createLockedControlIdentityVerifier,
} from "../dist/main/locked-computer-control/identity-verifier.js";
import {
  parseLockedControlNativeAttestationResponse,
  parseLockedControlNativeIdentityResponse,
} from "../dist/main/locked-computer-control/native-bridge.js";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const verifiedAt = new Date("2099-01-01T00:00:00.000Z");

const identityContext = {
  platform: "darwin",
  sessionBindingDigest: digestA,
  workspaceCwd: "/workspace",
  runId: "run-1",
  computerUseSessionId: "session-1",
  desktopInstanceId: "desktop-1",
  desktopInstanceEpoch: 1,
  daemonAuthorityEpoch: "authority-1",
  bridgeConnectionId: "bridge-1",
  providerGeneration: 3,
  lockEpoch: 1,
  sessionActive: true,
  sessionLocked: false,
};

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

const grant = {
  schemaVersion: 1,
  grantId: "grant-1",
  issuedAt: "2099-01-01T00:00:00.000Z",
  expiresAt: "2099-01-01T00:15:00.000Z",
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

const nativeAttestation = {
  platform: "darwin",
  sessionBindingDigest: digestA,
  lockEpoch: 2,
  providerGeneration: 4,
  sameUserSession: true,
  userDesktopTargeted: true,
  captureReady: true,
  inputReady: true,
  secureSurfaceExcluded: true,
};

test("native bridge parsers reject credential and screen payload expansion", () => {
  assert.deepEqual(parseLockedControlNativeIdentityResponse({ status: "verified" }), { status: "verified" });
  assert.equal(parseLockedControlNativeIdentityResponse({ status: "verified", biometricType: "face" }), undefined);
  assert.deepEqual(parseLockedControlNativeAttestationResponse(nativeAttestation), nativeAttestation);
  assert.equal(parseLockedControlNativeAttestationResponse({ ...nativeAttestation, windowTitle: "secret" }), undefined);
});

test("Darwin and Windows identity adapters normalize their native method", async () => {
  for (const [platform, method] of [
    ["darwin", "device_owner_authentication"],
    ["win32", "windows_user_consent"],
  ]) {
    const context = { ...identityContext, platform };
    const verifier = createLockedControlIdentityVerifier({
      platform,
      localizedReason: "Authorize Ling for this task",
      readContext: () => context,
      nativeBridge: { async verifyIdentity() { return { status: "verified" }; } },
      now: () => verifiedAt,
    });
    assert.deepEqual(await verifier.verify(`request-${platform}`), {
      schemaVersion: 1,
      requestId: `request-${platform}`,
      status: "verified",
      method,
      verifiedAt: verifiedAt.toISOString(),
    });
  }
});

test("identity adapter preserves closed cancel/fail/unavailable statuses", async () => {
  for (const [status, reason] of [
    ["cancelled", "locked_control_identity_cancelled"],
    ["failed", "locked_control_identity_failed"],
    ["unavailable", "locked_control_identity_unavailable"],
  ]) {
    const verifier = createLockedControlIdentityVerifier({
      platform: "darwin",
      localizedReason: "Authorize Ling for this task",
      readContext: () => identityContext,
      nativeBridge: { async verifyIdentity() { return { status }; } },
    });
    const result = await verifier.verify(`request-${status}`);
    assert.equal(result.status, status);
    assert.equal(result.reason, reason);
    assert.equal(result.verifiedAt, undefined);
  }
});

test("identity adapter denies before opening native UI when scope is ineligible", async () => {
  let calls = 0;
  for (const [context, reason] of [
    [{ ...identityContext, sessionLocked: true }, "locked_control_session_mismatch"],
    [{ ...identityContext, sessionActive: false }, "locked_control_no_active_run"],
    [{ ...identityContext, runId: undefined }, "locked_control_no_active_run"],
  ]) {
    const verifier = createLockedControlIdentityVerifier({
      platform: "darwin",
      localizedReason: "Authorize Ling for this task",
      readContext: () => context,
      nativeBridge: { async verifyIdentity() { calls += 1; return { status: "verified" }; } },
    });
    const result = await verifier.verify("request-ineligible");
    assert.equal(result.status, "failed");
    assert.equal(result.reason, reason);
  }
  assert.equal(calls, 0);
});

test("identity adapter discards a verified result after session or authority changes", async () => {
  for (const [change, reason] of [
    [{ sessionBindingDigest: digestB }, "locked_control_user_switched"],
    [{ daemonAuthorityEpoch: "authority-2" }, "locked_control_authority_rotated"],
    [{ runId: "run-2" }, "locked_control_no_active_run"],
    [{ sessionLocked: true }, "locked_control_session_mismatch"],
  ]) {
    let reads = 0;
    const verifier = createLockedControlIdentityVerifier({
      platform: "darwin",
      localizedReason: "Authorize Ling for this task",
      readContext: () => reads++ === 0 ? identityContext : { ...identityContext, ...change },
      nativeBridge: { async verifyIdentity() { return { status: "verified" }; } },
    });
    const result = await verifier.verify("request-stale");
    assert.equal(result.status, "failed");
    assert.equal(result.reason, reason);
  }
});

test("native identity prompt is single-flight and malformed output fails closed", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const verifier = createLockedControlIdentityVerifier({
    platform: "darwin",
    localizedReason: "Authorize Ling for this task",
    readContext: () => identityContext,
    nativeBridge: {
      async verifyIdentity() {
        calls += 1;
        await gate;
        return { status: "verified" };
      },
    },
    now: () => verifiedAt,
  });
  const first = verifier.verify("request-1");
  const second = verifier.verify("request-2");
  assert.equal(calls, 1);
  release();
  assert.deepEqual((await Promise.all([first, second])).map((result) => result.status), ["verified", "verified"]);

  const malformed = createLockedControlIdentityVerifier({
    platform: "darwin",
    localizedReason: "Authorize Ling for this task",
    readContext: () => identityContext,
    nativeBridge: { async verifyIdentity() { return { status: "verified", credential: "forbidden" }; } },
  });
  assert.equal((await malformed.verify("request-malformed")).reason, "locked_control_identity_unavailable");
});

test("positive attestation binds the exact grant, epoch, generation and sequence", async () => {
  const attestor = createLockedControlCapabilityAttestor({
    nativeBridge: { async attestLockedSession() { return nativeAttestation; } },
    now: () => verifiedAt,
  });
  const result = await attestor.attest({
    capability,
    grant,
    lockEpoch: 2,
    reservedProviderGeneration: 4,
    sequence: 7,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.attestation, {
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
    sequence: 7,
    observedAt: verifiedAt.toISOString(),
  });
});

test("attestation rejects every negative proof with a stable reason", async () => {
  for (const [field, reason] of [
    ["sameUserSession", "locked_control_session_mismatch"],
    ["userDesktopTargeted", "locked_control_session_mismatch"],
    ["secureSurfaceExcluded", "locked_control_secure_surface"],
    ["captureReady", "locked_control_capture_unavailable"],
    ["inputReady", "locked_control_input_unavailable"],
  ]) {
    const attestor = createLockedControlCapabilityAttestor({
      nativeBridge: { async attestLockedSession() { return { ...nativeAttestation, [field]: false }; } },
      now: () => verifiedAt,
    });
    assert.deepEqual(await attestor.attest({
      capability,
      grant,
      lockEpoch: 2,
      reservedProviderGeneration: 4,
      sequence: 1,
    }), { ok: false, reason });
  }
});

test("attestation fails before native work on static capability or authority mismatch", async () => {
  let calls = 0;
  const nativeBridge = { async attestLockedSession() { calls += 1; return nativeAttestation; } };
  const cases = [
    {
      capability: { ...capability, state: "probe_required", reason: "locked_control_probe_required", canCaptureSameUserDesktopWhileLocked: false },
      grant,
      lockEpoch: 2,
      reservedProviderGeneration: 4,
      sequence: 1,
      expected: "locked_control_probe_required",
    },
    { capability, grant, lockEpoch: 3, reservedProviderGeneration: 4, sequence: 1, expected: "locked_control_authority_rotated" },
    { capability, grant, lockEpoch: 2, reservedProviderGeneration: 3, sequence: 1, expected: "locked_control_authority_rotated" },
  ];
  for (const { expected, ...input } of cases) {
    const attestor = createLockedControlCapabilityAttestor({ nativeBridge, now: () => verifiedAt });
    assert.deepEqual(await attestor.attest(input), { ok: false, reason: expected });
  }
  assert.equal(calls, 0);
});

test("attestation rejects absent, malformed and cross-boundary native bridges", async () => {
  for (const nativeBridge of [
    undefined,
    { async attestLockedSession() { throw new Error("native error"); } },
    { async attestLockedSession() { return { ...nativeAttestation, sessionBindingDigest: digestB }; } },
    { async attestLockedSession() { return { ...nativeAttestation, providerGeneration: 5 }; } },
    { async attestLockedSession() { return { ...nativeAttestation, rawFrame: "forbidden" }; } },
  ]) {
    const attestor = createLockedControlCapabilityAttestor({ nativeBridge, now: () => verifiedAt });
    const result = await attestor.attest({
      capability,
      grant,
      lockEpoch: 2,
      reservedProviderGeneration: 4,
      sequence: 1,
    });
    assert.equal(result.ok, false);
  }
});
