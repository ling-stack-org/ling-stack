import assert from "node:assert/strict";
import test from "node:test";
import {
  FailClosedCuaDriverReadinessController,
  GenerationFencedCuaDriverReadiness,
  WindowsActiveChildReadinessController,
} from "../dist/main/cua-driver/readiness-controller.js";

test("readiness controller rejects stale nonce/generation/sequence notifications", async () => {
  const invalidations = [];
  const delegate = {
    async check(context) {
      return { generation: context.generation, childInstanceNonce: context.childInstanceNonce, readinessSequence: 1, ready: true, providerState: "ready" };
    },
    invalidate(generation, reason) {
      invalidations.push({ generation, reason });
    },
  };
  const controller = new GenerationFencedCuaDriverReadiness(delegate);
  const context = { generation: 2, childInstanceNonce: "n".repeat(32), platform: "win32", hostProcessId: 10, providerProcessId: 11 };
  assert.equal((await controller.check(context)).ready, true);
  const base = readinessChanged(context, 2);
  assert.equal(controller.acceptChanged(context, { ...base, childInstanceNonce: "old" }), undefined);
  assert.equal(controller.acceptChanged(context, { ...base, leaseGeneration: 1 }), undefined);
  const accepted = controller.acceptChanged(context, base);
  assert.equal(accepted.providerState, "ready");
  assert.equal(controller.acceptChanged(context, base), undefined);
  const locked = controller.acceptChanged(context, { ...base, readinessSequence: 3, inputDesktop: "locked", reason: "lock" });
  assert.equal(locked.providerState, "interactive_session_required");
  assert.equal(invalidations.length, 1);
  assert.equal(controller.acceptChanged(context, { ...base, readinessSequence: 4, inputDesktop: "default_unlocked", reason: "unlock" }), undefined);
});

test("default readiness adapter is fail-closed until PR6/PR7 installs native checks", async () => {
  const controller = new FailClosedCuaDriverReadinessController();
  const result = await controller.check({ generation: 1, childInstanceNonce: "nonce", platform: "darwin" });
  assert.equal(result.ready, false);
  assert.equal(result.providerState, "platform_unavailable");
});

test("Windows initial readiness uses the active stdio child and records its response sequence", async () => {
  let request;
  const context = {
    generation: 5,
    childInstanceNonce: "n".repeat(32),
    platform: "win32",
    hostProcessId: 10,
    providerProcessId: 11,
    async requestControl(method, params) {
      request = { method, params };
      return { jsonrpc: "2.0", id: "ling-control:1", result: readinessResponse(context, 7) };
    },
  };
  const controller = new GenerationFencedCuaDriverReadiness(new WindowsActiveChildReadinessController());
  const result = await controller.check(context);
  assert.equal(result.ready, true);
  assert.equal(result.readinessSequence, 7);
  assert.deepEqual(request, {
    method: "ling/managed_readiness",
    params: { schemaVersion: 1, childInstanceNonce: context.childInstanceNonce, leaseGeneration: 5 },
  });
  assert.equal(controller.acceptChanged(context, { ...readinessChanged(context, 7) }), undefined);
  assert.equal(controller.acceptChanged(context, { ...readinessChanged(context, 8), providerProcessId: "forged" }), undefined);
  assert.equal(controller.acceptChanged(context, readinessChanged(context, 8)).ready, true);
});

function readinessChanged(context, sequence) {
  return { ...readinessResponse(context, sequence), reason: "heartbeat" };
}

function readinessResponse(context, sequence) {
  return {
    schemaVersion: 1,
    childInstanceNonce: context.childInstanceNonce,
    leaseGeneration: context.generation,
    readinessSequence: sequence,
    hostProcessId: 10,
    hostSessionId: 3,
    hostIntegrityLevel: "medium",
    providerProcessId: 11,
    providerSessionId: 3,
    providerIntegrityLevel: "medium",
    inputDesktop: "default_unlocked",
    jobObjectAssigned: true,
    killOnJobClose: true,
    uiaRuntime: "available",
    d3d11: "available",
    wgcApi: "supported",
    contentObserved: false,
  };
}
