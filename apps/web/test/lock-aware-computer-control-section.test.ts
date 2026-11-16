import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { LockedComputerControlDesktopState } from "../../desktop/shared/desktop-capabilities.js";
import {
  buildLockedComputerControlView,
  parseLockedComputerControlDesktopState,
} from "../src/domains/computer-control/locked-computer-control-view-model.ts";

const supported: LockedComputerControlDesktopState = {
  projection: { schemaVersion: 1, capability: "supported_restricted", phase: "off" },
  activeTaskAvailable: true,
};
const armed: LockedComputerControlDesktopState = {
  ...supported,
  projection: { ...supported.projection, phase: "armed", grantId: "grant", runId: "run", computerUseSessionId: "session",
    issuedAt: "2099-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:15:00.000Z" },
};

test("task continuation owns no GUI authorization command", async () => {
  // This module boundary is independent of the supported native capability.
  const source = await readFile(new URL("../src/features/settings/computer-control/LockAwareComputerControlSection.tsx", import.meta.url), "utf8");
  assert.match(source, /getLockedTaskContinuationPreferences/u);
  assert.match(source, /setContinueTasksWhileLocked/u);
  assert.equal(source.includes("authorizeLockedComputerControl"), false);
  assert.equal(source.includes("revokeLockedComputerControl"), false);
});

test("locked status accepts only the closed Desktop projection shape", () => {
  assert.deepEqual(parseLockedComputerControlDesktopState(supported), supported);
  assert.deepEqual(parseLockedComputerControlDesktopState(armed), armed);
  for (const value of [null, [], {}, { ...supported, activeTaskAvailable: "true" },
    { ...supported, grantId: "forged" }, { ...supported, projection: { ...supported.projection, phase: "armed" } },
    { ...supported, projection: { schemaVersion: 1, capability: "disabled_by_build", phase: "armed" } }]) {
    assert.equal(parseLockedComputerControlDesktopState(value), undefined);
  }
});

test("ordinary and unverified capabilities never expose authorization", () => {
  const disabledStates = [
    ["disabled_by_build", "locked_control_disabled_by_build"],
    ["probe_required", "locked_control_probe_required"],
    ["unsupported", "locked_control_platform_unsupported"],
  ] as const;
  const absent = buildLockedComputerControlView({ computerControlReady: true, readFailed: false });
  assert.equal(absent.governed, false);
  assert.equal(absent.canAuthorize, false);
  for (const [capability, reason] of disabledStates) {
    const state: LockedComputerControlDesktopState = { ...supported, projection: { schemaVersion: 1, capability, phase: "off", reason } };
    const view = buildLockedComputerControlView({ state, computerControlReady: true, readFailed: false });
    assert.equal(view.governed, false);
    assert.equal(view.canAuthorize, false);
    assert.equal(view.canRevoke, false);
  }
});

test("authorization requires a verified capability, ready control and one active task", () => {
  for (const computerControlReady of [false, true]) {
    for (const activeTaskAvailable of [false, true]) {
      const view = buildLockedComputerControlView({ state: { ...supported, activeTaskAvailable }, computerControlReady, readFailed: false });
      assert.equal(view.canAuthorize, computerControlReady && activeTaskAvailable);
    }
  }
  const stale = buildLockedComputerControlView({ state: supported, computerControlReady: true, readFailed: true });
  assert.equal(stale.canAuthorize, false);
  assert.match(stale.feedback!, /could not be refreshed/u);
  for (const reason of ["locked_control_disabled_by_policy", "locked_control_probe_required"] as const) {
    const blocked = buildLockedComputerControlView({ state: { ...supported, projection: { ...supported.projection, reason } }, computerControlReady: true, readFailed: false });
    assert.equal(blocked.canAuthorize, false);
  }
});

test("identity verification is revocable and is never presented as an armed grant", () => {
  const view = buildLockedComputerControlView({ state: supported, computerControlReady: true, readFailed: false, pending: "authorize" });
  assert.equal(view.phase, "verifying");
  assert.equal(view.canAuthorize, false);
  assert.equal(view.canRevoke, true);
  assert.equal(view.expiresAt, undefined);
});

test("armed, active and paused grants stay revocable when normal control or reads are unavailable", () => {
  for (const phase of ["armed", "active_locked", "paused"] as const) {
    const state = { ...armed, projection: { ...armed.projection, phase } };
    for (const readFailed of [false, true]) {
      const view = buildLockedComputerControlView({ state, computerControlReady: false, readFailed });
      assert.equal(view.canRevoke, true);
      assert.equal(view.canAuthorize, false);
      assert.equal(view.expiresAt, armed.projection.expiresAt);
    }
  }
});

test("expiry and identity failure have user-facing feedback without native details", () => {
  const expired = buildLockedComputerControlView({ state: { ...supported, projection: { ...supported.projection, reason: "locked_control_grant_expired" } }, computerControlReady: true, readFailed: false });
  assert.equal(expired.canRevoke, false);
  assert.equal(expired.feedback, "The authorization expired.");
  const failed = buildLockedComputerControlView({ state: supported, computerControlReady: true, readFailed: false, commandError: "locked_control_identity_cancelled" });
  assert.equal(failed.feedback, "Identity verification was cancelled.");
  const unknown = buildLockedComputerControlView({ state: supported, computerControlReady: true, readFailed: false, commandError: "/private/path/token" });
  assert.equal(unknown.feedback, "Locked control is unavailable for safety.");
});
