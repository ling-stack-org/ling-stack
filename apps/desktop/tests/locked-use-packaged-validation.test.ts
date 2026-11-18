import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { captureImage, runLockedUsePackagedValidation } from "../dist/main/locked-computer-control/packaged-validation.js";
import type { CuaDriverActionGate } from "../dist/main/cua-driver/restricted-generation.js";
import type { CuaDriverCoordinatorSnapshot } from "../dist/main/cua-driver/coordinator.js";
import { parseLockedUseValidationCandidate, parseLockedUsePackagedValidationReport } from "../shared/locked-use-validation-contract.ts";
import { validateLockedUsePackagedCase } from "../scripts/locked-use-release-evidence.ts";

function image(color: string): Buffer {
  const canvas = createCanvas(32, 32);
  const context = canvas.getContext("2d");
  context.fillStyle = color; context.fillRect(0, 0, 32, 32);
  return canvas.toBuffer("image/png");
}

function fixture(options: { identity?: string; unchanged?: boolean; failDrain?: boolean; revoke?: boolean; permission?: boolean; wrongTarget?: boolean } = {}) {
  const events: string[] = [];
  const before = image("white"); const after = image("blue");
  const controller = new AbortController();
  let locked = false; let managed = false; let counter = 0; let captures = 0; let nativeRevoked = false;
  let onRevoked!: () => void; let gate!: CuaDriverActionGate;
  const candidate = parseLockedUseValidationCandidate({
    schemaVersion: 1, kind: "attended_candidate", platform: "darwin", architecture: "arm64", osBuild: "TEST1",
    expectedTeamId: "ABCDE12345", expectedBuildManifestSha256: "a".repeat(64),
    providerCodeHash: "b".repeat(40), fixtureExecutableSha256: "c".repeat(64),
  });
  const input: Parameters<typeof runLockedUsePackagedValidation>[0] = {
    candidate, candidateSha256: "d".repeat(64), packageCodeHash: "e".repeat(40), workspaceCwd: "/owned-validation-workspace",
    signal: controller.signal,
    fixture: { processID: 321, windowID: 456,
      async waitForCounter(expected) { assert.equal(counter, expected); events.push("counter:" + counter); } },
    createNative(revoked) {
      if (!onRevoked) onRevoked = revoked;
      return {
        providerHostProcessID: 100,
        async readSession() { return { platform: "darwin", sessionActive: true, sessionLocked: locked, sessionBindingDigest: "f".repeat(64) }; },
        async readStatus() { return { platform: "darwin", productCapability: "supported_restricted", available: true,
          captureReady: true, inputReady: true, secureSurfaceExcluded: true }; },
        async verifyIdentity() { events.push("identity"); return { status: options.identity ?? "verified" }; },
        async begin() { events.push("native-begin"); managed = true; locked = false; },
        async check() { if (nativeRevoked) throw new Error("native_revoked"); },
        async attachProvider(pid) { assert.equal(pid, 200); events.push("provider-registered"); },
        async beginAction(_signal, target) { assert.equal(target.processID, 321); assert.equal(target.windowID, 456); events.push("action:" + target.toolName); },
        async finishAction() { events.push("action-end"); },
        async end() { events.push("native-end"); managed = false; locked = true; },
        close() { events.push("observer-closed"); },
      };
    },
    createCoordinator(input) {
      gate = input.actionGate!;
      let snapshot: CuaDriverCoordinatorSnapshot = { generation: 1, lifecycle: "active", providerState: "desktop_unavailable" };
      return {
        get snapshot() { return snapshot; },
        async enable() { events.push("provider-enable"); return snapshot; },
        async primeRestrictedSession() {
          await input.providerLifetime!.registerProcess(200, controller.signal);
          const finish = await gate.beforeCall({ jsonrpc: "2.0", id: 0, method: "initialize" });
          await finish();
          events.push("provider-initialized");
          snapshot = { ...snapshot, providerState: "ready", pid: 200,
            permissions: { accessibility: options.permission === false ? "denied" : "granted", screenRecording: "granted", capturable: true } };
        },
        closeCallGateForSecurityBoundary() { events.push("provider-fenced"); },
        async suspendForSystem() { events.push("provider-drain"); if (options.failDrain) throw new Error("provider_drain_failed"); },
        async shutdown() { events.push("provider-exited"); },
      };
    },
    async connect(generation) {
      assert.equal(generation, 1);
      events.push("connect");
      return async (name, args) => {
        assert.equal(args.pid, 321); assert.equal(args.window_id, 456);
        const finish = await gate.beforeCall({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
        try {
          if (name === "click") {
            assert.deepEqual(args, { pid: 321, window_id: 456, element_index: 9, delivery_mode: "background" });
            counter += 1;
            if (options.revoke) { nativeRevoked = true; onRevoked(); }
            return { content: [] };
          }
          assert.equal(name, "get_window_state");
          const bytes = captures++ === 0 || options.unchanged ? before : after;
          return { content: [{ type: "image", mimeType: "image/png", data: bytes.toString("base64") }],
            structuredContent: { pid: options.wrongTarget ? 999 : 321, window_id: 456,
              elements: [{ role: "AXButton", label: "Increment", element_index: 9 }] } };
        } finally { await finish(); }
      };
    },
    onPhase(phase) {
      events.push(phase);
      if (phase === "waiting_for_manual_lock") locked = true;
      if (phase === "waiting_for_manual_unlock") locked = false;
    },
  };
  return { input, events, controller, isManaged: () => managed, captures: () => captures };
}

test("candidate exercises a registered restricted provider and records passing evidence only after relock and manual unlock", async () => {
  const fx = fixture();
  const result = await runLockedUsePackagedValidation(fx.input);
  assert.equal(result.report.result, "passed");
  assert.equal(result.report.productCapability, "disabled_by_build");
  assert.notEqual(result.report.beforePixelsSha256, result.report.afterPixelsSha256);
  assert.equal(result.report.beforeImageSha256, createHash("sha256").update(result.beforeImage).digest("hex"));
  assert.ok(fx.events.indexOf("provider-registered") < fx.events.indexOf("provider-initialized"));
  assert.ok(fx.events.indexOf("provider-exited") < fx.events.indexOf("native-end"));
  assert.ok(fx.events.indexOf("native-end") < fx.events.indexOf("waiting_for_manual_unlock"));
  assert.equal(fx.isManaged(), false);
  const expected = { osBuild: "TEST1", nativeBuildManifestSha256: "a".repeat(64), providerCodeHash: "b".repeat(40) };
  if (process.arch === "arm64") validateLockedUsePackagedCase(result.report, expected);
  else assert.throws(() => validateLockedUsePackagedCase(result.report, expected), /case_mismatch/u);
  assert.throws(() => validateLockedUsePackagedCase(result.report, { osBuild: "OTHER", nativeBuildManifestSha256: "a".repeat(64), providerCodeHash: "b".repeat(40) }), /case_mismatch/u);
  for (const mutation of [{ productCapability: "supported_restricted" }, { counterAfter: 0 },
    { beforePixelsSha256: result.report.afterPixelsSha256 }, { facts: { ...result.report.facts, manualUnlockObserved: false } }]) {
    assert.throws(() => parseLockedUsePackagedValidationReport({ ...result.report, ...mutation }), /incomplete/u);
  }
});

test("cancelled identity and absent provider permissions never dispatch fixture actions", async () => {
  for (const options of [{ identity: "cancelled" }, { permission: false }]) {
    const fx = fixture(options);
    await assert.rejects(runLockedUsePackagedValidation(fx.input), /identity_not_verified|permissions_required/u);
    assert.equal(fx.events.some(event => event.startsWith("action:")), false);
    assert.equal(fx.isManaged(), false);
  }
});

test("unchanged captured pixels fail the run and drain the provider before native release", async () => {
  const fx = fixture({ unchanged: true });
  await assert.rejects(runLockedUsePackagedValidation(fx.input), /unchanged_window_capture/u);
  assert.ok(fx.events.indexOf("provider-exited") < fx.events.indexOf("native-end"));
  assert.equal(fx.isManaged(), false);
});

test("a provider capture naming a different process cannot qualify or dispatch input", async () => {
  const fx = fixture({ wrongTarget: true });
  await assert.rejects(runLockedUsePackagedValidation(fx.input), /capture_target_mismatch/u);
  assert.equal(fx.events.includes("action:click"), false);
});

test("unconfirmed provider drainage retains the native session and cannot produce passing evidence", async () => {
  const fx = fixture({ unchanged: true, failDrain: true });
  await assert.rejects(runLockedUsePackagedValidation(fx.input), /cleanup_unconfirmed/u);
  assert.equal(fx.events.includes("native-end"), false);
  assert.equal(fx.isManaged(), true);
});

test("native revocation fences the generation before another capture is admitted", async () => {
  const fx = fixture({ revoke: true });
  await assert.rejects(runLockedUsePackagedValidation(fx.input), /authority_rotated/u);
  assert.equal(fx.captures(), 1);
  assert.ok(fx.events.includes("provider-fenced"));
});

test("only bounded PNG window captures qualify as capture evidence", () => {
  for (const value of [{ content: [] }, { isError: true, content: [] },
    { content: [{ type: "image", mimeType: "image/png", data: "not-an-image" }] },
    { content: [{ type: "image", mimeType: "image/jpeg", data: image("white").toString("base64") }] }]) {
    assert.throws(() => captureImage({ ...value, structuredContent: { pid: 321, window_id: 456 } },
      { processID: 321, windowID: 456 }), /capture_failed|image_missing|image_invalid/u);
  }
});
