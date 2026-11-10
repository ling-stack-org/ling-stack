import assert from "node:assert/strict";
import test from "node:test";
import { validateTestsavantParityCalls } from "./testsavant-parity-observation.mjs";

const classifier = { session: 1, inputNames: ["input_ids", "attention_mask", "token_type_ids"], outputNames: ["logits"],
  feeds: Object.fromEntries(["input_ids", "attention_mask", "token_type_ids"].map(name =>
    [name, { type: "int64", dims: [1, 2], data: [101n, 102n] }])) };
const topk = { session: 2, inputNames: ["x", "k"], outputNames: ["v", "i"], feeds: {
  x: { type: "float32", dims: [2], data: [0.9, 0.1] }, k: { type: "int64", dims: [1], data: [1n] },
} };
test("native parity counts exactly one classifier and the upstream's distinct TopK, not arbitrary duplicates", () => {
  assert.deepEqual(validateTestsavantParityCalls([classifier]), classifier.feeds);
  assert.deepEqual(validateTestsavantParityCalls([classifier, topk], true), classifier.feeds);
  for (const calls of [[], [classifier, classifier], [classifier, topk, topk], [topk, classifier],
    [classifier, { ...topk, session: 1 }], [classifier, { ...topk, inputNames: ["unknown"] }]]) {
    assert.throws(() => validateTestsavantParityCalls(calls, true));
  }
  assert.throws(() => validateTestsavantParityCalls([classifier, topk]));
});
