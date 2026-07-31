import assert from "node:assert/strict";
import test from "node:test";

import {
  createLockedControlFeasibilityProbe,
  isLockedControlFeasibilityEvidenceV1,
} from "../dist/main/locked-computer-control/feasibility-probe.js";

const now = "2026-07-31T00:00:00.000Z";
const evidence = {
  schemaVersion: 1,
  platform: "darwin",
  result: "feasible_candidate",
  sameUserSessionBound: true,
  captureReadyWhileLocked: true,
  inputAcknowledgedWhileLocked: true,
  secureSurfaceExcluded: true,
  providerIntegrationMode: "embedded-stdio",
  providerVersion: "0.8.3",
  distributionRevision: "ling.1",
  helperSha256: "a".repeat(64),
  providerSha256: "b".repeat(64),
  adapterVersion: "darwin-probe-v1",
  osVersion: "15.6",
  observedAt: now,
};

test("feasibility evidence is closed and content-free", () => {
  assert.equal(isLockedControlFeasibilityEvidenceV1(evidence), true);
  assert.equal(isLockedControlFeasibilityEvidenceV1({ ...evidence, screenshot: "pixels" }), false);
  assert.equal(isLockedControlFeasibilityEvidenceV1({
    ...evidence,
    inputAcknowledgedWhileLocked: false,
  }), false, "candidate requires every proof");
  assert.equal(isLockedControlFeasibilityEvidenceV1({
    ...evidence,
    result: "unsupported",
    inputAcknowledgedWhileLocked: false,
    reason: "locked_control_input_unavailable",
  }), true);
  assert.equal(isLockedControlFeasibilityEvidenceV1({
    ...evidence,
    result: "unsupported",
    reason: "locked_control_platform_unsupported",
  }), false, "unsupported cannot carry an all-positive proof");
});

test("packaged build policy keeps the native probe inert by default", async () => {
  let calls = 0;
  const probe = createLockedControlFeasibilityProbe({
    platform: "darwin",
    buildProbeEnabled: false,
    adapterVersion: "darwin-probe-v1",
    osVersion: "15.6",
    nativeProbe: { async probe() { calls += 1; return evidence; } },
  });
  const result = await probe.run();
  assert.equal(calls, 0);
  assert.equal(result.capability.state, "disabled_by_build");
  assert.equal(result.capability.reason, "locked_control_disabled_by_build");
  assert.equal(result.evidence, undefined);
});

test("feasible candidate evidence cannot self-promote product capability", async () => {
  const probe = createLockedControlFeasibilityProbe({
    platform: "darwin",
    buildProbeEnabled: true,
    adapterVersion: "darwin-probe-v1",
    osVersion: "15.6",
    nativeProbe: { async probe() { return evidence; } },
  });
  const result = await probe.run();
  assert.equal(result.evidence?.result, "feasible_candidate");
  assert.equal(result.capability.state, "probe_required");
  assert.equal(result.capability.canCaptureSameUserDesktopWhileLocked, false);
  assert.equal(result.capability.secureSurfaceExcluded, false);
});

test("unsupported native evidence stops only its own platform", async () => {
  const unsupported = {
    ...evidence,
    platform: "win32",
    adapterVersion: "win32-probe-v1",
    osVersion: "10.0.26100",
    result: "unsupported",
    inputAcknowledgedWhileLocked: false,
    reason: "locked_control_input_unavailable",
  };
  const probe = createLockedControlFeasibilityProbe({
    platform: "win32",
    buildProbeEnabled: true,
    adapterVersion: "win32-probe-v1",
    osVersion: "10.0.26100",
    nativeProbe: { async probe() { return unsupported; } },
  });
  const result = await probe.run();
  assert.equal(result.capability.state, "unsupported");
  assert.equal(result.capability.reason, "locked_control_input_unavailable");
  assert.equal(result.evidence?.platform, "win32");
});

test("missing, crashed, stale and cross-platform helpers fail closed", async () => {
  const base = {
    platform: "darwin",
    buildProbeEnabled: true,
    adapterVersion: "darwin-probe-v1",
    osVersion: "15.6",
  };
  for (const nativeProbe of [
    undefined,
    { async probe() { throw new Error("native secret"); } },
    { async probe() { return { ...evidence, platform: "win32" }; } },
    { async probe() { return { ...evidence, adapterVersion: "stale" }; } },
    { async probe() { return { ...evidence, password: "forbidden" }; } },
  ]) {
    const result = await createLockedControlFeasibilityProbe({ ...base, nativeProbe }).run();
    assert.equal(result.capability.state, "probe_required");
    assert.equal(result.capability.reason, "locked_control_probe_required");
    assert.equal(result.evidence, undefined);
  }
});
