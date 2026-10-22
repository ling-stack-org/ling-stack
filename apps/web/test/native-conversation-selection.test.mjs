import test from "node:test";
import assert from "node:assert/strict";
import { projectNativeConversationSelection, resolveConversationReplacementProvider } from "../src/features/workspace/native-conversation-selection.ts";
const binding = { kind: "native_profile", engineId: "codex-app-server", profileId: "profile", profileRevision: 2, nativeModelId: "model" };
test("only current ready native selection exposes a runnable bound conversation choice", () => {
  const ready = projectNativeConversationSelection({ status: "ready", cwd: "/test", defaultRunnerId: "codex-app-server", executionBinding: binding }, false, "blocked");
  assert.equal(ready.option.runnable, true);
  assert.deepEqual(ready.option.executionBinding, binding);
  assert.equal(ready.option.providerPresetId, undefined);
  const blocked = projectNativeConversationSelection({ status: "blocked", cwd: "/test", defaultRunnerId: "codex-app-server", executionBinding: binding }, false, "blocked");
  assert.equal(blocked.defaultId, ready.defaultId);
  assert.equal(blocked.option.runnable, false);
  const changed = projectNativeConversationSelection({ status: "blocked", cwd: "/test", defaultRunnerId: "codex-app-server", executionBinding: { ...binding, profileRevision: 3 } }, false, "blocked");
  assert.notEqual(changed.defaultId, ready.defaultId);
});
test("unknown default stays pending or blocked while explicit Pi defaults remain available", () => {
  assert.equal(projectNativeConversationSelection(undefined, false, "blocked").pending, true);
  const failed = projectNativeConversationSelection(undefined, true, "blocked");
  assert.equal(failed.option.runnable, false);
  assert.ok(failed.defaultId);
  assert.equal(projectNativeConversationSelection({ status: "not_selected", cwd: "/test", defaultRunnerId: "pi" }, false, "blocked").option, undefined);
});

test("native message replacement retains its source selection when the composer changes to Pi", () => {
  const message = { turnId: "source-turn" };
  const context = { runs: [{ id: "native-run", providerName: "native", requestSnapshot: { executionBinding: binding } }],
    runLinks: [{ turnId: "source-turn", runId: "native-run" }] };
  assert.equal(resolveConversationReplacementProvider(message, context, "new-pi-preset"), undefined);
  const pi = { runs: [{ id: "pi-run", providerName: "pi", requestSnapshot: {} }], runLinks: [] };
  assert.equal(resolveConversationReplacementProvider({ runId: "pi-run" }, pi, "new-pi-preset"), "new-pi-preset");
  assert.equal(resolveConversationReplacementProvider(message, undefined, "new-pi-preset"), undefined);
});
