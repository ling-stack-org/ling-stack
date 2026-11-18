import { createHash } from "node:crypto";
import type { LockedComputerControlCapabilityV1, LockedComputerControlGrantV1, LockedComputerControlPolicyV1 } from "@ling-stack/contracts";

export const allowedTools = Object.freeze(["get_window_state", "click"]);
export const sessionDigest = "a".repeat(64);
export const enabledPolicy: LockedComputerControlPolicyV1 = {
  schemaVersion: 1, mode: "task_grant_required", maxGrantTtlSeconds: 900,
  requireLocalUserVerification: true, consumeOnUnlock: true, suspendRevokes: true,
  lockedToolPolicyRevision: "locked-cua-tools-v1",
  allowedLockedToolIdsSha256: createHash("sha256").update(JSON.stringify(allowedTools)).digest("hex"),
};
export const supportedCapability: LockedComputerControlCapabilityV1 = {
  schemaVersion: 1, platform: "darwin", state: "supported_restricted",
  canCaptureSameUserDesktopWhileLocked: true, canInjectSameUserDesktopWhileLocked: true,
  canProveSessionContinuity: true, secureSurfaceExcluded: true,
  adapterVersion: "test", osVersion: "test", observedAt: "2099-01-01T00:00:00.000Z",
};
export function taskGrant(now = Date.now()): LockedComputerControlGrantV1 {
  return {
    schemaVersion: 1, grantId: "grant-1", issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 900_000).toISOString(), ttlSeconds: 900,
    workspaceCwd: "/workspace", runId: "run-1", computerUseSessionId: "session-1",
    platform: "darwin", desktopInstanceId: "desktop-1", desktopInstanceEpoch: 1,
    daemonAuthorityEpoch: "authority-1", bridgeConnectionId: "bridge-1",
    authorizedNormalGeneration: 3, osSessionBindingDigest: sessionDigest,
    authorizedLockEpoch: 1, allowedLockedToolIdsDigest: enabledPolicy.allowedLockedToolIdsSha256,
  };
}
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}
