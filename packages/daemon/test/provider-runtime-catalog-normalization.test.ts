import assert from "node:assert/strict";
import test from "node:test";
import { normalizeModelTokenLimits, normalizeThinkingModes } from "../dist/features/providers/model-catalog-normalize.js";

test("runtime catalog preserves provider-native top reasoning levels", () => {
  assert.deepEqual(normalizeThinkingModes([{ type: "effort", values: ["low", "xhigh", "max", "maximum", "ultra", "unknown"] }]),
    ["low", "xhigh", "max", "ultra"]);
  assert.deepEqual(normalizeThinkingModes([{ type: "toggle" }]), ["off", "auto"]);
});

test("catalog token limits preserve output capacity that leaves room for model input", () => {
  assert.deepEqual(normalizeModelTokenLimits({ context: 8_192, output: 4_096 }), {
    contextWindow: 8_192,
    maxTokens: 4_096,
  });
});

test("catalog token limits cap Volcengine Seed 2.1 Pro at its documented context window", () => {
  const pro = "doubao-seed-2-1-pro-260628";
  const feedLimit = { context: 1_024_000, output: 256_000 };
  assert.deepEqual(normalizeModelTokenLimits(feedLimit, "volcengine", pro), {
    contextWindow: 256_000,
    maxTokens: 16_384,
  });
  assert.deepEqual(normalizeModelTokenLimits({ context: 128_000, output: 8_192 }, "volcengine", pro), {
    contextWindow: 128_000,
    maxTokens: 8_192,
  });
  assert.deepEqual(normalizeModelTokenLimits(feedLimit, "volcengine", "doubao-seed-evolving"), {
    contextWindow: 1_024_000,
    maxTokens: 256_000,
  });
  assert.deepEqual(normalizeModelTokenLimits(feedLimit, "siliconflow", pro), {
    contextWindow: 1_024_000,
    maxTokens: 256_000,
  });
});

test("catalog token limits bound invalid output capacity to leave a usable input budget", () => {
  for (const [context, output, expectedOutput] of [
    [8_192, 8_192, 6_656],
    [8_192, 16_384, 6_656],
    [8_192, 7_680, 6_656],
    [1_048_576, 1_048_576, 16_384],
  ]) {
    assert.deepEqual(normalizeModelTokenLimits({ context, output }), {
      contextWindow: context,
      maxTokens: expectedOutput,
    });
  }
});

test("catalog token limits omit an unusably small paired budget", () => {
  assert.deepEqual(normalizeModelTokenLimits({ context: 512, output: 512 }), {
    contextWindow: undefined,
    maxTokens: undefined,
  });
});

test("catalog token limits retain valid standalone capacities", () => {
  assert.deepEqual(normalizeModelTokenLimits({ output: 4_096 }), {
    contextWindow: undefined,
    maxTokens: 4_096,
  });
  assert.deepEqual(normalizeModelTokenLimits({ output: 100_000 }), {
    contextWindow: undefined,
    maxTokens: 100_000,
  });
  assert.deepEqual(normalizeModelTokenLimits({ output: 128_000 }), {
    contextWindow: undefined,
    maxTokens: 16_384,
  });
  assert.deepEqual(normalizeModelTokenLimits({ context: 8_192 }), {
    contextWindow: 8_192,
    maxTokens: 6_656,
  });
  assert.deepEqual(normalizeModelTokenLimits({ context: 128_000 }), {
    contextWindow: 128_000,
    maxTokens: undefined,
  });
});
