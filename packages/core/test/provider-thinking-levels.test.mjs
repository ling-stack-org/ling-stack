import assert from "node:assert/strict";
import test from "node:test";
import { enrichProviderModelOption, normalizeProviderThinkingModes, providerThinkingModesToLevelMap } from "../dist/index.js";

const context = { kind: "openai-compatible", providerId: "openai", api: "openai-responses" };

test("upstream max and ultra remain distinct from xhigh through capability normalization", () => {
  const modes = normalizeProviderThinkingModes(["high", "xhigh", "MAX", "maximum", "ultra", "unknown"]);
  assert.deepEqual(modes, ["high", "xhigh", "max", "ultra"]);
  assert.deepEqual(providerThinkingModesToLevelMap(modes), {
    off: null, minimal: null, low: null, medium: null, high: "high", xhigh: "xhigh", max: "max", ultra: "ultra",
  });
  const model = enrichProviderModelOption({ id: "relay-model", thinkingSupport: { levels: modes } }, context);
  assert.deepEqual(model.thinkingModes, modes);
  assert.equal(providerThinkingModesToLevelMap(["low", "high"]).ultra, null);
});

test("Sol API fallback exposes max without inventing ultra or disabled reasoning", () => {
  assert.deepEqual(enrichProviderModelOption({ id: "gpt-6.1-sol" }, context).thinkingModes,
    ["low", "medium", "high", "xhigh", "max"]);
  for (const thinkingModes of [[], ["high"], ["high", "max", "ultra"]]) {
    assert.deepEqual(enrichProviderModelOption({ id: "gpt-6.1-sol", thinkingModes }, context).thinkingModes, thinkingModes);
  }
  assert.equal(enrichProviderModelOption({ id: "gpt-6.1-sol" }, { ...context, api: "openai-codex-responses" }).thinkingModes.includes("ultra"), false);
  assert.equal(enrichProviderModelOption({ id: "unrecognized-model" }, context).thinkingModes.includes("max"), false);
});
