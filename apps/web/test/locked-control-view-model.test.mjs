import assert from "node:assert/strict";
import test from "node:test";
import { buildLockedComputerControlViewModel } from "../src/domains/computer-control/locked-control-view-model.ts";

const nowMs = Date.parse("2026-07-31T10:00:00.000Z");

test("locked-control view model keeps absent, malformed and packaged-disabled projections inert", () => {
  assert.deepEqual(build({ projection: undefined }), {
    kind: "disabled",
    reason: "locked_control_projection_missing",
    canRecheck: true,
    busy: false,
  });
  assert.deepEqual(build({ projection: { schemaVersion: 1, capability: "future", phase: "off" } }), {
    kind: "disabled",
    reason: "locked_control_projection_invalid",
    canRecheck: true,
    busy: false,
  });
  assert.deepEqual(build({ projection: disabledProjection() }), {
    kind: "disabled",
    reason: "locked_control_disabled_by_build",
    canRecheck: false,
    busy: false,
  });
});

test("supported projection still requires normal Computer Control and an active task", () => {
  assert.deepEqual(build({
    projection: supportedOff(),
    requestedEnabled: false,
    effectiveEnabled: false,
  }), {
    kind: "disabled",
    reason: "locked_control_computer_control_off",
    canRecheck: false,
    busy: false,
  });
  assert.deepEqual(build({
    projection: supportedOff(),
    requestedEnabled: true,
    effectiveEnabled: false,
  }), {
    kind: "disabled",
    reason: "locked_control_computer_control_not_ready",
    canRecheck: true,
    busy: false,
  });
  assert.deepEqual(build({
    projection: supportedOff("locked_control_no_active_run"),
  }), {
    kind: "disabled",
    reason: "locked_control_no_active_run",
    canRecheck: false,
    busy: false,
  });
});

test("supported off and verifying states expose only intent actions", () => {
  assert.deepEqual(build({ projection: supportedOff() }), {
    kind: "off",
    canAuthorize: true,
    busy: false,
  });
  assert.deepEqual(build({
    projection: {
      schemaVersion: 1,
      capability: "supported_restricted",
      phase: "verifying",
      auditId: "audit-1",
    },
    busyAction: "authorize",
  }), {
    kind: "verifying",
    canRevoke: true,
    busy: true,
  });
});

test("grant states show a presentation-only countdown and fail closed after wall expiry", () => {
  const armed = grantProjection("armed");
  const active = { ...grantProjection("active_locked"), lockedSince: "2026-07-31T10:00:05.000Z" };
  const paused = {
    ...active,
    phase: "paused",
    reason: "locked_control_approval_required",
  };

  assert.equal(build({ projection: armed }).kind, "armed");
  assert.equal(build({ projection: armed }).remainingSeconds, 600);
  assert.equal(build({ projection: active }).kind, "active");
  assert.deepEqual(
    { kind: build({ projection: paused }).kind, reason: build({ projection: paused }).reason },
    { kind: "paused", reason: "locked_control_approval_required" },
  );
  assert.equal(build({ projection: armed, nowMs: Date.parse(armed.expiresAt) }).kind, "expired");
});

function build(overrides) {
  return buildLockedComputerControlViewModel({
    projection: supportedOff(),
    requestedEnabled: true,
    effectiveEnabled: true,
    nowMs,
    ...overrides,
  });
}

function disabledProjection() {
  return {
    schemaVersion: 1,
    capability: "disabled_by_build",
    phase: "off",
    reason: "locked_control_disabled_by_build",
  };
}

function supportedOff(reason) {
  return {
    schemaVersion: 1,
    capability: "supported_restricted",
    phase: "off",
    ...(reason ? { reason } : {}),
  };
}

function grantProjection(phase) {
  return {
    schemaVersion: 1,
    capability: "supported_restricted",
    phase,
    grantId: "grant-1",
    runId: "run-1",
    computerUseSessionId: "session-1",
    issuedAt: "2026-07-31T10:00:00.000Z",
    expiresAt: "2026-07-31T10:10:00.000Z",
    auditId: "audit-1",
  };
}
