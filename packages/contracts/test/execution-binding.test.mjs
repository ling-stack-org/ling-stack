import assert from "node:assert/strict";
import test from "node:test";
import * as contracts from "../dist/index.js";

const native = { kind: "native_profile", engineId: "codex-app-server", profileId: "profile_fixture", profileRevision: 3, nativeModelId: "fixture-model" };

test("execution bindings keep Pi presets and native profiles as separate identities", () => {
  assert.equal(typeof contracts.parseExecutionBindingRequest, "function");
  const pi = { kind: "pi_provider", providerPresetId: "preset_fixture" };
  assert.deepEqual(contracts.parseExecutionBindingRequest(pi), pi);
  for (const engineId of ["codex-app-server", "claude-agent-sdk", "kimi-acp", "openclaw-acp"]) {
    const input = { ...native, engineId };
    const parsed = contracts.parseExecutionBindingRequest(input);
    assert.deepEqual(parsed, input);
    assert.notEqual(parsed, input);
    assert.equal("providerPresetId" in parsed, false);
  }
  const { nativeModelId, ...withoutModel } = native;
  assert.deepEqual(contracts.parseExecutionBindingRequest(withoutModel), withoutModel);
});

test("mixed, incomplete and secret-bearing execution bindings are rejected without echo", () => {
  for (const input of [null, [], {}, { kind: "other" }, { ...native, providerPresetId: "preset" },
    { kind: "pi_provider", providerPresetId: "preset", profileId: "profile" }, { kind: "pi_provider", providerPresetId: "" },
    { ...native, engineId: "pi" }, { ...native, engineId: "unregistered" }, { ...native, profileId: " " },
    { ...native, profileRevision: 0 }, { ...native, profileRevision: -1 }, { ...native, profileRevision: 1.5 },
    { ...native, profileRevision: "3" }, { ...native, profileRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...native, nativeModelId: "bad\nvalue" }, { ...native, nativeModelId: "x".repeat(513) },
    { ...native, nativeModelId: null }, { ...native, apiKey: "secret-fixture" }, { ...native, executablePath: "/forged" }]) {
    assert.throws(() => contracts.parseExecutionBindingRequest(input), (error) => {
      assert.equal(error.code, "execution_binding_invalid");
      assert.equal(error.message, "execution_binding_invalid");
      return true;
    });
  }
});
