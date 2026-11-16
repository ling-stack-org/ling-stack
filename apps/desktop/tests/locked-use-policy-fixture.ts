import { LockedComputerControlPolicyCoordinator, type LockedControlGenerationRuntime } from "../dist/main/locked-computer-control/policy-coordinator.js";
import type { LockedControlDaemonClient } from "../dist/main/locked-computer-control/daemon-client.js";
import type { LockedControlCapabilityAttestor } from "../dist/main/locked-computer-control/capability-attestor.js";
import { deferred, enabledPolicy, sessionDigest, supportedCapability, taskGrant } from "./locked-use-fixtures.ts";

export function policyFixture() {
  const events: string[] = [];
  const grant = taskGrant();
  const snapshot = { revision: 1, projection: { schemaVersion: 1 as const, capability: "supported_restricted" as const, phase: "off" as const } };
  const daemon: LockedControlDaemonClient & { currentTask(): Promise<{ runId: string; computerUseSessionId: string }> } = {
    async snapshot() { return snapshot; },
    async beginAuthorization() { return { accepted: true, snapshot }; },
    async prepare() { return { accepted: true, snapshot, grant }; },
    async commit() { return { accepted: true, snapshot }; },
    async reconcile() { return snapshot; },
    async publishAttestation(input) { events.push(`attestation:${input.attestation.sequence}`); return { accepted: true, snapshot }; },
    async publishCapability() { return { accepted: true, snapshot }; },
    async promotePolicy() { return { accepted: true, snapshot }; },
    async currentTask() { return { runId: "run-1", computerUseSessionId: "session-1" }; },
    async revoke() { events.push("revoke"); return { accepted: true, snapshot }; },
  };
  const runtime: LockedControlGenerationRuntime = {
    readAuthority: () => ({
      ...grant, normalGeneration: 3, lockEpoch: 0, sessionBindingDigest: sessionDigest,
    }),
    closeCallGate: (reason) => { events.push(`close:${reason}`); },
    async retireNormalForLock() { events.push("retire"); },
    reserveLockedGeneration() { events.push("reserve"); return 4; },
    async prepareLockedGeneration() { events.push("prepare-native"); },
    async startLockedGeneration() { events.push("start"); },
    async stopLockedGeneration() { events.push("stop"); },
    async resumeNormal() { events.push("resume"); },
  };
  const attestor: LockedControlCapabilityAttestor = {
    async attest(input) {
      return { ok: true, attestation: {
        schemaVersion: 1, grantId: grant.grantId, platform: "darwin", lockEpoch: 1,
        sessionBindingDigest: sessionDigest, sameUserSession: true, userDesktopTargeted: true,
        captureReady: true, inputReady: true, secureSurfaceExcluded: true,
        providerGeneration: input.reservedProviderGeneration, sequence: input.sequence,
        observedAt: new Date().toISOString(),
      } };
    },
  };
  const coordinator = new LockedComputerControlPolicyCoordinator({
    policy: enabledPolicy, capability: () => supportedCapability, daemon, runtime, attestor,
    identityVerifier: { async verify(requestId) { return { schemaVersion: 1, requestId, status: "verified", method: "device_owner_authentication", verifiedAt: new Date().toISOString() }; } },
  });
  return { coordinator, events, runtime, daemon, attestor, grant };
}
