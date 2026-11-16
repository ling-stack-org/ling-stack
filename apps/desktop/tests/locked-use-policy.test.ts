import assert from "node:assert/strict";
import { setImmediate as flush } from "node:timers/promises";
import test from "node:test";
import { deferred } from "./locked-use-fixtures.ts";
import { policyFixture } from "./locked-use-policy-fixture.ts";

test("reserve and native preparation failures revoke without starting a provider", async () => {
  for (const boundary of ["reserve", "prepare"]) {
    const fx = policyFixture();
    if (boundary === "reserve") fx.runtime.reserveLockedGeneration = () => { throw new Error("reservation_failed"); };
    else fx.runtime.prepareLockedGeneration = async () => { throw new Error("native_failed"); };
    assert.equal((await fx.coordinator.authorizeCurrentTask()).accepted, true);
    await fx.coordinator.handleLock();
    assert.equal(fx.coordinator.snapshot().phase, "off");
    assert.equal(fx.events.includes("start"), false);
    assert.ok(fx.events.indexOf("stop") < fx.events.indexOf("revoke"));
    await fx.coordinator.shutdown();
  }
});

test("a boundary during prepare or commit cannot arm a late grant", async () => {
  for (const boundary of ["prepare", "commit"] as const) {
    const fx = policyFixture(); const entered = deferred(); const release = deferred();
    // Keep the exact typed return value of each boundary.
    if (boundary === "prepare") {
      fx.daemon.prepare = async () => { entered.resolve(); await release.promise; return { accepted: true, grant: fx.grant, snapshot: await fx.daemon.snapshot() }; };
    } else {
      fx.daemon.commit = async () => { entered.resolve(); await release.promise; return { accepted: true, snapshot: await fx.daemon.snapshot() }; };
    }
    const authorizing = fx.coordinator.authorizeCurrentTask();
    await entered.promise;
    const locking = fx.coordinator.handleLock();
    release.resolve();
    assert.equal((await authorizing).accepted, false);
    await locking;
    assert.equal(fx.events.includes("start"), false);
    await fx.coordinator.shutdown();
  }
});

test("explicit revoke fences synchronously and a failed cleanup cannot return to off or resume normal", async () => {
  const fx = policyFixture();
  await fx.coordinator.authorizeCurrentTask(); await fx.coordinator.handleLock();
  fx.runtime.stopLockedGeneration = async () => { throw new Error("drain_failed"); };
  const revoking = fx.coordinator.revokeCurrentGrant();
  assert.match(fx.events.at(-1)!, /close:locked_control_grant_consumed/u);
  await assert.rejects(revoking, /drain_failed/u);
  assert.equal(fx.coordinator.snapshot().phase, "revoking");
  assert.equal((await fx.coordinator.authorizeCurrentTask()).accepted, false);
  assert.equal(fx.events.includes("resume"), false);
  fx.runtime.stopLockedGeneration = async () => {};
  await fx.coordinator.shutdown();
});

test("active leases publish fresh attestations and heartbeat loss stops the provider", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const fx = policyFixture();
  await fx.coordinator.authorizeCurrentTask(); await fx.coordinator.handleLock();
  t.mock.timers.tick(1_000); await flush();
  assert.ok(fx.events.includes("attestation:2"));
  fx.attestor.attest = async () => ({ ok: false, reason: "locked_control_input_unavailable" });
  t.mock.timers.tick(1_000); await flush();
  assert.equal(fx.coordinator.snapshot().phase, "off");
  assert.ok(fx.events.includes("stop"));
  const count = fx.events.length;
  t.mock.timers.tick(5_000); await flush();
  assert.equal(fx.events.length, count);
  await fx.coordinator.shutdown();
});

test("grant TTL closes admission before queued cleanup", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fx = policyFixture();
  await fx.coordinator.authorizeCurrentTask(); await fx.coordinator.handleLock();
  t.mock.timers.tick(900_000);
  assert.equal(fx.events.at(-1), "close:locked_control_grant_expired");
  await flush();
  assert.equal(fx.coordinator.snapshot().phase, "off");
  assert.ok(fx.events.includes("stop"));
  await fx.coordinator.shutdown();
});

test("authority rotation during a heartbeat cannot retain the restricted provider", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  for (const stage of ["attest", "publish"] as const) {
    const fx = policyFixture();
    await fx.coordinator.authorizeCurrentTask(); await fx.coordinator.handleLock();
    const authority = fx.runtime.readAuthority();
    let rotated = false;
    fx.runtime.readAuthority = () => ({ ...authority, bridgeConnectionId: rotated ? "other-bridge" : authority.bridgeConnectionId });
    const entered = deferred(); const release = deferred();
    if (stage === "attest") {
      const original = fx.attestor.attest;
      fx.attestor.attest = async (input) => { entered.resolve(); await release.promise; return original(input); };
    } else {
      const original = fx.daemon.publishAttestation;
      fx.daemon.publishAttestation = async (input) => { entered.resolve(); await release.promise; return original(input); };
    }
    t.mock.timers.tick(1_000);
    await entered.promise;
    rotated = true;
    release.resolve(); await flush();
    assert.equal(fx.coordinator.snapshot().phase, "off");
    assert.ok(fx.events.includes("stop"));
    if (stage === "attest") assert.equal(fx.events.includes("attestation:2"), false);
    await fx.coordinator.shutdown();
  }
});
