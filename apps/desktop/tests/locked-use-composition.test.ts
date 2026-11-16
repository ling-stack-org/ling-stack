import assert from "node:assert/strict";
import test from "node:test";
import { composeLockedControlRuntime, type DesktopLockedUseBackend } from "../dist/main/locked-computer-control/runtime-composition.js";
import type { CuaDriverActionGate } from "../dist/main/cua-driver/restricted-generation.js";
import type { CuaDriverCoordinatorSnapshot } from "../dist/main/cua-driver/coordinator.js";
import { allowedTools, deferred, enabledPolicy, sessionDigest, supportedCapability } from "./locked-use-fixtures.ts";
import { policyFixture } from "./locked-use-policy-fixture.ts";

function fixture(enabled = true, configureDaemon?: (daemon: ReturnType<typeof policyFixture>["daemon"]) => void) {
  const { daemon, events } = policyFixture();
  configureDaemon?.(daemon);
  let managed = false; let revoked!: () => void; let gate!: CuaDriverActionGate;
  let clients = 0; let current = true; let drainFails = false;
  let providerSnapshot: CuaDriverCoordinatorSnapshot = { generation: 4, lifecycle: "active", providerState: "ready" };
  const restrictedEnabled = deferred();
  const backend: DesktopLockedUseBackend = {
    capability: supportedCapability, policy: enabledPolicy, allowedToolIds: allowedTools,
    createClient(onRevoked) {
      clients += 1; revoked = onRevoked;
      return {
        get ownsManagedSession() { return managed; },
        async readSession() { return { platform: "darwin", sessionBindingDigest: sessionDigest, sessionActive: true, sessionLocked: false }; },
        async verifyIdentity() { events.push("identity"); return { status: "verified" }; },
        async begin() { managed = true; events.push("native-begin"); },
        async check() { events.push("native-check"); },
        async beginAction() { events.push("action-begin"); },
        async finishAction() { events.push("action-end"); },
        async end() { managed = false; events.push("native-end"); },
      };
    },
    async verifyTargetReadiness() { return { userDesktopTargeted: true, captureReady: true, inputReady: true, secureSurfaceExcluded: true }; },
  };
  const binding = composeLockedControlRuntime({
    platform: "darwin", desktopInstanceId: "desktop-1",
    authority: { daemonAuthorityEpoch: "authority-1", bridgeConnectionId: "bridge-1", desktopInstanceEpoch: 1, workspaceCwd: "/workspace", readinessDetailsV1: true },
    daemonBaseUrl: "http://127.0.0.1:1", bridgeToken: "bridge", daemonClient: daemon,
    backend: enabled ? backend : undefined, isCurrent: () => current, onStateChanged() {},
    coordinator: {
      snapshot: { generation: 3, lifecycle: "active", providerState: "ready" },
      async enable() { throw new Error("already active"); }, async shutdown() {},
      async suspendForSystem() { events.push("normal-retire"); },
      closeCallGateForSecurityBoundary() { events.push("normal-close"); },
      advanceGenerationFloor() { events.push("reserve-generation"); },
    },
    createRestrictedCoordinator(input) {
      gate = input.actionGate!;
      return {
        get snapshot() { return providerSnapshot; },
        async enable() { events.push("restricted-enable"); restrictedEnabled.resolve(); return providerSnapshot; },
        async primeRestrictedSession() { events.push("restricted-prime"); },
        closeCallGateForSecurityBoundary() { events.push("restricted-close"); },
        async suspendForSystem() { events.push("restricted-fence"); if (drainFails) throw new Error("drain_failed"); },
        async shutdown() { events.push("restricted-shutdown"); },
      };
    },
    async resumeNormal() { events.push("normal-resume"); },
  });
  return { binding, backend, daemon, events, restrictedEnabled, gate: () => gate, revoke: () => revoked(), clients: () => clients,
    setProviderState: (providerState: CuaDriverCoordinatorSnapshot["providerState"]) => { providerSnapshot = { ...providerSnapshot, providerState }; },
    rotate: () => { current = false; }, failDrain: (value: boolean) => { drainFails = value; } };
}

test("composition retains fixed off without a trusted backend", async () => {
  const fx = fixture(false);
  assert.equal((await fx.binding.authorize()).accepted, false);
  assert.equal(fx.clients(), 0);
  await fx.binding.coordinator.shutdown();
});

test("capability publication or policy promotion failure prevents local identity verification", async () => {
  for (const boundary of ["publishCapability", "promotePolicy"] as const) {
    const fx = fixture(true, (daemon) => {
      daemon[boundary] = async () => ({ accepted: false, reason: "locked_control_probe_required", snapshot: await daemon.snapshot() });
    });
    const result = await fx.binding.authorize();
    assert.equal(result.accepted, false);
    assert.equal(fx.clients(), 0);
    assert.equal(fx.events.includes("identity"), false);
    await fx.binding.coordinator.shutdown();
  }
});

test("lazy restricted initialization and daemon attestation both precede tool admission", async () => {
  const fx = fixture();
  const attestationEntered = deferred(); const acceptAttestation = deferred();
  const publishAttestation = fx.daemon.publishAttestation;
  fx.daemon.publishAttestation = async (input) => {
    attestationEntered.resolve();
    await acceptAttestation.promise;
    return publishAttestation(input);
  };
  fx.setProviderState("desktop_unavailable");
  await fx.binding.authorize();
  const locking = fx.binding.coordinator.handleLock();
  await fx.restrictedEnabled.promise;
  const action = { jsonrpc: "2.0" as const, id: 1, method: "tools/call", params: { name: "click" } };
  await assert.rejects(fx.gate().beforeCall(action), /attestation_pending/u);
  assert.equal(fx.events.some((event) => event.startsWith("attestation:")), false);
  fx.setProviderState("ready");
  await attestationEntered.promise;
  await assert.rejects(fx.gate().beforeCall(action), /attestation_pending/u);
  acceptAttestation.resolve();
  await locking;
  const finish = await fx.gate().beforeCall(action);
  await finish();
  await fx.binding.coordinator.shutdown();
});

test("composition retires normal control before managed unlock and releases native protection after provider shutdown", async () => {
  const fx = fixture();
  assert.equal((await fx.binding.authorize()).accepted, true);
  await fx.binding.coordinator.handleLock();
  assert.equal(fx.binding.coordinator.snapshot().phase, "active_locked");
  assert.equal(fx.binding.ownsManagedSession(), true);
  assert.ok(fx.events.indexOf("normal-retire") < fx.events.indexOf("native-begin"));
  assert.ok(fx.events.indexOf("native-begin") < fx.events.indexOf("restricted-enable"));
  assert.ok(fx.events.indexOf("restricted-enable") < fx.events.indexOf("restricted-prime"));
  const finish = await fx.gate().beforeCall({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "capture" } });
  await finish();
  await fx.binding.coordinator.revokeCurrentGrant();
  assert.ok(fx.events.indexOf("restricted-shutdown") < fx.events.indexOf("native-end"));
  assert.equal(fx.binding.ownsManagedSession(), false);
  await fx.binding.coordinator.shutdown();
});

test("native loss fences synchronously, and a failed drain retains the managed session", async () => {
  const fx = fixture();
  await fx.binding.authorize(); await fx.binding.coordinator.handleLock();
  fx.failDrain(true);
  fx.revoke();
  assert.equal(fx.events.at(-1), "restricted-close");
  await assert.rejects(fx.gate().beforeCall({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "click" } }));
  await assert.rejects(fx.binding.coordinator.revokeCurrentGrant(), /drain_failed/u);
  assert.equal(fx.binding.ownsManagedSession(), true);
  assert.equal(fx.events.includes("native-end"), false);
  fx.failDrain(false);
  await fx.binding.coordinator.shutdown();
});

test("authority loss prevents both identity and native acquisition", async () => {
  const fx = fixture(); fx.rotate();
  assert.equal((await fx.binding.authorize()).accepted, false);
  assert.equal(fx.events.includes("identity"), false);
  assert.equal(fx.events.includes("native-begin"), false);
  await fx.binding.coordinator.shutdown();
});
