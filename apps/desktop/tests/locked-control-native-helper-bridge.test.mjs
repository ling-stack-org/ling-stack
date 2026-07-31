import assert from "node:assert/strict";
import test from "node:test";
import {
  createLockedControlNativeHelperBridge,
  parseLockedControlNativeSessionResponse,
} from "../dist/main/locked-computer-control/native-helper-bridge.js";

const digest = "a".repeat(64);

test("native helper bridge emits closed content-free requests", async () => {
  const calls = [];
  const bridge = createLockedControlNativeHelperBridge({
    helperPath: "/Applications/Ling.app/Contents/Helpers/ling-locked-control-helper",
    platform: "darwin",
    async invoke(path, request, signal) {
      calls.push({ path, request, aborted: signal.aborted });
      if (request.command === "identity") return { status: "verified" };
      if (request.command === "session") {
        return {
          platform: "darwin",
          sessionBindingDigest: digest,
          sessionActive: true,
          sessionLocked: false,
        };
      }
      return {
        platform: "darwin",
        sessionBindingDigest: digest,
        lockEpoch: request.lockEpoch,
        providerGeneration: request.providerGeneration,
        sameUserSession: true,
        userDesktopTargeted: false,
        captureReady: false,
        inputReady: false,
        secureSurfaceExcluded: false,
      };
    },
  });
  const controller = new AbortController();
  assert.deepEqual(await bridge.verifyIdentity({
    requestId: "request-1",
    platform: "darwin",
    localizedReason: "Authorize Ling",
    signal: controller.signal,
  }), { status: "verified" });
  assert.equal((await bridge.readSession(controller.signal)).sessionBindingDigest, digest);
  await bridge.attestLockedSession({
    platform: "darwin",
    expectedSessionBindingDigest: digest,
    lockEpoch: 1,
    providerGeneration: 2,
    signal: controller.signal,
  });
  assert.deepEqual(calls.map((call) => Object.keys(call.request).sort()), [
    ["command", "localizedReason", "platform", "requestId"],
    ["command", "platform"],
    ["command", "expectedSessionBindingDigest", "lockEpoch", "platform", "providerGeneration"],
  ]);
});

test("native helper session parser rejects extra fields and platform confusion", async () => {
  assert.equal(parseLockedControlNativeSessionResponse({
    platform: "darwin",
    sessionBindingDigest: digest,
    sessionActive: true,
    sessionLocked: false,
    userName: "must-not-cross-boundary",
  }), undefined);
  assert.throws(() => createLockedControlNativeHelperBridge({
    helperPath: "relative-helper",
    platform: "darwin",
  }), /path_not_absolute/);

  const bridge = createLockedControlNativeHelperBridge({
    helperPath: "/Program Files/Ling/ling-locked-control-helper.exe",
    platform: "win32",
    invoke: async () => ({ status: "unavailable" }),
  });
  await assert.rejects(bridge.verifyIdentity({
    requestId: "request-2",
    platform: "darwin",
    localizedReason: "Authorize Ling",
    signal: new AbortController().signal,
  }), /platform_mismatch/);
});
