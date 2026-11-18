import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  DEFAULT_LOCKED_COMPUTER_CONTROL_POLICIES,
  LOCKED_COMPUTER_CONTROL_ALLOWED_TOOL_IDS,
  LOCKED_COMPUTER_CONTROL_ALLOWED_TOOL_IDS_SHA256,
  LOCKED_COMPUTER_CONTROL_TOOL_POLICY_REVISION,
  type LockedComputerControlCapabilityV1,
  type LockedComputerControlPolicyV1,
} from "@ling-stack/contracts";
import { LockedComputerControlRegistry } from "../dist/features/computer-use/locked-control-registry.js";

const policy: LockedComputerControlPolicyV1 = {
  ...DEFAULT_LOCKED_COMPUTER_CONTROL_POLICIES.darwin,
  mode: "task_grant_required",
  lockedToolPolicyRevision: LOCKED_COMPUTER_CONTROL_TOOL_POLICY_REVISION,
  allowedLockedToolIdsSha256: LOCKED_COMPUTER_CONTROL_ALLOWED_TOOL_IDS_SHA256,
};
const capability: LockedComputerControlCapabilityV1 = {
  schemaVersion: 1, platform: "darwin", state: "supported_restricted",
  canCaptureSameUserDesktopWhileLocked: true, canInjectSameUserDesktopWhileLocked: true,
  canProveSessionContinuity: true, secureSurfaceExcluded: true,
  adapterVersion: "test", osVersion: "test", observedAt: new Date().toISOString(),
};
function registry() {
  return new LockedComputerControlRegistry({
    workspaceCwd: "/workspace", policy: DEFAULT_LOCKED_COMPUTER_CONTROL_POLICIES.darwin, capability,
    isScopeActive: () => true, isAuthorityCurrent: () => true, appendAudit() {},
  });
}

test("policy promotion requires the published capability's build and canonical boundaries", (t) => {
  assert.equal(createHash("sha256").update(JSON.stringify(LOCKED_COMPUTER_CONTROL_ALLOWED_TOOL_IDS)).digest("hex"),
    LOCKED_COMPUTER_CONTROL_ALLOWED_TOOL_IDS_SHA256);
  const fx = registry(); t.after(() => fx.close());
  assert.equal(fx.promotePolicy(policy, "build-1").accepted, false);
  const published = fx.evaluateCapability(capability, "build-1");
  assert.equal(published.snapshot.projection.capability, "disabled_by_build");
  assert.equal(fx.promotePolicy(policy, "other-build").accepted, false);
  for (const invalid of [
    { mode: "disabled" }, { maxGrantTtlSeconds: 901 }, { consumeOnUnlock: false },
    { suspendRevokes: false }, { requireLocalUserVerification: false },
    { lockedToolPolicyRevision: "future-tools" }, { allowedLockedToolIdsSha256: "b".repeat(64) },
  ]) {
    assert.equal(fx.promotePolicy({ ...policy, ...invalid } as LockedComputerControlPolicyV1, "build-1").accepted, false);
  }
  const promoted = fx.promotePolicy(policy, "build-1");
  assert.equal(promoted.accepted, true);
  assert.equal(promoted.snapshot.projection.capability, "supported_restricted");
  assert.equal(promoted.snapshot.projection.phase, "off");
  assert.equal(fx.beginAuthorization({
    requestId: "request-1", expectedRevision: promoted.snapshot.revision, workspaceCwd: "/workspace",
    runId: "run-1", computerUseSessionId: "session-1",
  }).accepted, true);
  assert.equal(fx.promotePolicy(policy, "build-1").accepted, false);
});

test("negative native capability cannot promote a task policy", (t) => {
  const fx = registry(); t.after(() => fx.close());
  fx.evaluateCapability({
    ...capability, state: "probe_required", reason: "locked_control_probe_required",
    canCaptureSameUserDesktopWhileLocked: false, canInjectSameUserDesktopWhileLocked: false,
    canProveSessionContinuity: false, secureSurfaceExcluded: false,
  }, "build-1");
  const result = fx.promotePolicy(policy, "build-1");
  assert.equal(result.accepted, false);
  if (!result.accepted) assert.equal(result.reason, "locked_control_probe_required");
});
