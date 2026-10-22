import assert from "node:assert/strict";
import test from "node:test";
import { p95, performanceGate } from "../../../scripts/harness-reliability-benchmark.mjs";

test("p95 is nearest rank and refuses missing/non-finite measurements", () => {
  assert.equal(p95(Array.from({ length: 100 }, (_, index) => index + 1)), 95);
  for (const samples of [[], [NaN], [Infinity], [-1]]) assert.throws(() => p95(samples), /samples_invalid/);
});

test("hard gates retain every threshold and insufficient evidence cannot pass", () => {
  const metrics = { dispatchP95Ms: 25, claimP95Ms: 20, maxEventRowBytes: 16_383, evaluationQueueIncreaseRatio: 0.05 };
  const complete = { sampleCount: 250, warmupCount: 50 };
  assert.equal(performanceGate(metrics, complete).passed, true);
  assert.equal(performanceGate(metrics, { sampleCount: 249, warmupCount: 50 }).passed, false);
  for (const [name, value] of [["dispatchP95Ms", 25.01], ["claimP95Ms", 20.01], ["maxEventRowBytes", 16_384], ["evaluationQueueIncreaseRatio", 0.051]]) {
    assert.equal(performanceGate({ ...metrics, [name]: value }, complete).passed, false);
  }
  assert.equal(performanceGate({ ...metrics, maxEventRowBytes: 0 }, complete).passed, false);
});
