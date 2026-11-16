import assert from "node:assert/strict";
import test from "node:test";
import { RestrictedCuaDriverGeneration, type CuaDriverActionGate } from "../dist/main/cua-driver/restricted-generation.js";
import type { CuaDriverCoordinatorSnapshot } from "../dist/main/cua-driver/coordinator.js";
import { allowedTools, deferred, taskGrant } from "./locked-use-fixtures.ts";

function fixture() {
  const events: string[] = [];
  let generation = 3;
  let gate!: CuaDriverActionGate;
  let drainFails = false;
  let current = true;
  const owner = new RestrictedCuaDriverGeneration({
    currentGeneration: () => generation,
    advanceNormalGenerationFloor(value) { generation = value; },
    allowedToolIds: allowedTools,
    isAuthorityCurrent: () => current,
    native: {
      async check() { events.push("check"); },
      async beginAction() { events.push("begin"); },
      async finishAction() { events.push("finish"); },
      async end() { events.push("end"); },
    },
    createCoordinator(input) {
      gate = input.actionGate!;
      return {
        async enable(): Promise<CuaDriverCoordinatorSnapshot> {
          events.push("enable");
          return { lifecycle: "active", providerState: "ready", generation: input.generationFloor! + 1 };
        },
        closeCallGateForSecurityBoundary() { events.push("close"); },
        async suspendForSystem() { events.push("fence"); if (drainFails) throw new Error("drain_failed"); },
        async shutdown() { events.push("shutdown"); },
      };
    },
  });
  return { owner, events, gate: () => gate, generation: () => generation,
    setDrainFails: (value: boolean) => { drainFails = value; }, setCurrent: (value: boolean) => { current = value; } };
}

test("a restricted owner reserves a unique generation, freezes authority and fences each allowed action", async () => {
  const fx = fixture();
  const generation = fx.owner.reserve();
  assert.equal(generation, 4);
  assert.equal(fx.generation(), 4);
  assert.throws(() => fx.owner.reserve());
  const grant = taskGrant();
  await fx.owner.start({ generation, grant });
  Object.assign(grant, { expiresAt: "2000-01-01T00:00:00.000Z" });
  const finish = await fx.gate().beforeCall({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "capture" } });
  assert.equal(fx.events.at(-1), "begin");
  await finish();
  assert.equal(fx.events.at(-1), "finish");
  const begins = fx.events.filter((event) => event === "begin").length;
  for (const message of [
    { jsonrpc: "2.0" as const, id: 2, method: "tools/call", params: { name: "shell" } },
    { jsonrpc: "2.0" as const, method: "tools/call", params: { name: "click" } },
    { jsonrpc: "2.0" as const, id: 2, method: "resources/read", params: { uri: "file:///private/data" } },
    { jsonrpc: "2.0" as const, id: 2, method: "custom/input" },
    { jsonrpc: "2.0" as const, id: 2, method: "notifications/initialized" },
    { jsonrpc: "2.0" as const, id: 2, result: {} },
  ]) await assert.rejects(fx.gate().beforeCall(message), /disabled_by_policy/u);
  assert.equal(fx.events.filter((event) => event === "begin").length, begins);
  const postFence = await fx.gate().beforeCall({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "click" } });
  fx.setCurrent(false);
  await assert.rejects(postFence(), /authority_rotated/u);
  await fx.owner.stop("revoked");
  assert.deepEqual(fx.events.slice(-4), ["close", "fence", "shutdown", "end"]);
});

test("invalid generation or tool digest never starts a restricted provider", async () => {
  for (const invalid of [{ generation: 5 }, { grant: { ...taskGrant(), allowedLockedToolIdsDigest: "b".repeat(64) } }]) {
    const fx = fixture(); fx.owner.reserve();
    await assert.rejects(fx.owner.start({ generation: 4, grant: taskGrant(), ...invalid }));
    assert.equal(fx.events.includes("enable"), false);
    await fx.owner.stop("invalid");
  }
});

test("a failed provider drain keeps native protection and cleanup ownership for retry", async () => {
  const fx = fixture();
  await fx.owner.start({ generation: fx.owner.reserve(), grant: taskGrant() });
  fx.setDrainFails(true);
  await assert.rejects(fx.owner.stop("revoked"), /drain_failed/u);
  assert.equal(fx.events.includes("end"), false);
  await assert.rejects(fx.gate().beforeCall({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  fx.setDrainFails(false);
  await fx.owner.stop("retry");
  assert.equal(fx.events.filter((event) => event === "end").length, 1);
});

test("stop during native startup cannot create a successor provider", async () => {
  const checking = deferred(); const release = deferred();
  let enabled = false; let ended = false;
  const fx = new RestrictedCuaDriverGeneration({
    currentGeneration: () => 3, advanceNormalGenerationFloor() {}, allowedToolIds: allowedTools,
    isAuthorityCurrent: () => true,
    native: { async check() { checking.resolve(); await release.promise; }, async beginAction() {}, async finishAction() {}, async end() { ended = true; } },
    createCoordinator() { enabled = true; throw new Error("must not start"); },
  });
  const starting = fx.start({ generation: fx.reserve(), grant: taskGrant() });
  await checking.promise;
  const stopping = fx.stop("revoked");
  release.resolve();
  await assert.rejects(starting, /authority_rotated/u);
  await stopping;
  assert.equal(enabled, false); assert.equal(ended, true);
});
