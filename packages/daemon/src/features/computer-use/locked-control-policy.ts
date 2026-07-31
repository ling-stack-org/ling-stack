import { release } from "node:os";
import type {
  LockedComputerControlCapabilityV1,
  LockedComputerControlPlatform,
  LockedComputerControlPolicyV1,
} from "@ling-stack/contracts";
import {
  CUA_DRIVER_LOCKED_ALLOWED_TOOL_IDS_SHA256,
  CUA_DRIVER_LOCKED_TOOL_POLICY_REVISION,
} from "../plugins/presets.js";

/** Product builds remain disabled until per-platform packaged acceptance is promoted. */
export function createPackagedLockedControlPolicy(
  mode: "disabled" | "task_grant_required" = "disabled",
): LockedComputerControlPolicyV1 {
  return Object.freeze({
    schemaVersion: 1,
    mode,
    maxGrantTtlSeconds: 900,
    requireLocalUserVerification: true,
    consumeOnUnlock: true,
    suspendRevokes: true,
    lockedToolPolicyRevision: CUA_DRIVER_LOCKED_TOOL_POLICY_REVISION,
    allowedLockedToolIdsSha256: CUA_DRIVER_LOCKED_ALLOWED_TOOL_IDS_SHA256,
  });
}

export function createDisabledLockedControlCapability(
  platform: LockedComputerControlPlatform,
  now = new Date(),
): LockedComputerControlCapabilityV1 {
  return Object.freeze({
    schemaVersion: 1,
    platform,
    state: "disabled_by_build",
    reason: "locked_control_disabled_by_build",
    canCaptureSameUserDesktopWhileLocked: false,
    canInjectSameUserDesktopWhileLocked: false,
    canProveSessionContinuity: false,
    secureSurfaceExcluded: false,
    adapterVersion: `${platform}-locked-control-disabled-v1`,
    osVersion: release(),
    observedAt: now.toISOString(),
  });
}

export function lockedControlPlatformForNode(
  platform: NodeJS.Platform = process.platform,
): LockedComputerControlPlatform | undefined {
  return platform === "darwin" || platform === "win32" ? platform : undefined;
}
