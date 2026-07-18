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

test("a stale readiness completion cannot invalidate the current generation", async () => {
  const pending = new Map();
  const invalidations = [];
  const delegate = {
    check(context) {
      return new Promise((resolve) => pending.set(context.generation, { context, resolve }));
    },
    invalidate(generation, reason) {
      invalidations.push({ generation, reason });
    },
  };
  const controller = new GenerationFencedCuaDriverReadiness(delegate);
  const oldContext = { generation: 1, childInstanceNonce: "o".repeat(32), platform: "win32", hostProcessId: 10, providerProcessId: 11 };
  const currentContext = { generation: 2, childInstanceNonce: "n".repeat(32), platform: "win32", hostProcessId: 10, providerProcessId: 11 };

  const oldCheck = controller.check(oldContext);
  const currentCheck = controller.check(currentContext);
  pending.get(2).resolve({
    generation: 2,
    childInstanceNonce: currentContext.childInstanceNonce,
    readinessSequence: 1,
    ready: true,
    providerState: "ready",
  });
  assert.equal((await currentCheck).ready, true);

  pending.get(1).resolve({
    generation: 1,
    childInstanceNonce: oldContext.childInstanceNonce,
    readinessSequence: 1,
    ready: true,
    providerState: "ready",
  });
  const stale = await oldCheck;
  assert.equal(stale.ready, false);
  assert.equal(stale.reason, "readiness_check_superseded");
  assert.deepEqual(invalidations, []);

  const changed = controller.acceptChanged(currentContext, readinessChanged(currentContext, 2));
  assert.equal(changed.ready, true);
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

test("Windows Session 0 initial readiness is valid but requires an interactive session", async () => {
  const context = {
    generation: 6,
    childInstanceNonce: "s".repeat(32),
    platform: "win32",
    hostProcessId: 10,
    providerProcessId: 11,
    async requestControl() {
      return {
        jsonrpc: "2.0",
        id: "ling-control:session-zero",
        result: { ...readinessResponse(context, 1), hostSessionId: 0, providerSessionId: 0 },
      };
    },
  };
  const result = await new WindowsActiveChildReadinessController().check(context);
  assert.equal(result.ready, false);
  assert.equal(result.providerState, "interactive_session_required");
  assert.equal(result.reason, "windows_interactive_session_required");
});

test("Windows cross-session readiness change projects interactive-session recovery", async () => {
  const context = { generation: 7, childInstanceNonce: "x".repeat(32), platform: "win32", hostProcessId: 10, providerProcessId: 11 };
  const delegate = {
    async check() {
      return { generation: 7, childInstanceNonce: context.childInstanceNonce, readinessSequence: 1, ready: true, providerState: "ready" };
    },
    invalidate() {},
  };
  const controller = new GenerationFencedCuaDriverReadiness(delegate);
  assert.equal((await controller.check(context)).ready, true);
  const changed = controller.acceptChanged(context, {
    ...readinessChanged(context, 2),
    providerSessionId: 4,
    reason: "session_mismatch",
  });
  assert.equal(changed.ready, false);
  assert.equal(changed.providerState, "interactive_session_required");
  assert.equal(changed.reason, "session_mismatch");
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
