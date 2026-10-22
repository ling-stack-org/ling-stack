import assert from "node:assert/strict";
import test from "node:test";
import { normalizeModelTokenLimits } from "../provider-model-catalog-normalization.mjs";

test("catalog token limits preserve output capacity that leaves room for model input", () => {
  assert.deepEqual(normalizeModelTokenLimits({ context: 8_192, output: 4_096 }), {
    contextWindow: 8_192,
    maxTokens: 4_096,
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
