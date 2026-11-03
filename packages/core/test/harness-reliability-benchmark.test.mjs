import assert from "node:assert/strict";
import test from "node:test";
import {
  balancedArmScheduleFor,
  foregroundBatchSizeFor,
  p95,
  performanceGate,
} from "../../../scripts/harness-reliability-benchmark.mjs";

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

test("foreground batching stabilizes the release sample without exceeding the fixed corpus cap", () => {
  assert.equal(foregroundBatchSizeFor(300), 16);
  assert.equal(300 * 2 * foregroundBatchSizeFor(300), 9_600);
  assert.equal(foregroundBatchSizeFor(4_000), 1);
  assert.equal(4_000 * 2 * foregroundBatchSizeFor(4_000), 8_000);
  for (const count of [0, 4_001, 1.5, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => foregroundBatchSizeFor(count), /benchmark_size_invalid/);
  }
});

test("benchmark arm scheduling is deterministic, balanced, and not fixed ABAB parity", () => {
  const first = balancedArmScheduleFor(250, "evaluation-first:samples");
  const second = balancedArmScheduleFor(250, "evaluation-first:samples");
  assert.deepEqual(first, second);
  assert.equal(first.filter(Boolean).length, 125);
  assert.equal(first.filter(value => !value).length, 125);
  assert.notDeepEqual(first.slice(0, 12), Array.from({ length: 12 }, (_, index) => Boolean(index % 2)));
  const odd = balancedArmScheduleFor(5, "odd");
  assert.ok(Math.abs(odd.filter(Boolean).length - odd.filter(value => !value).length) <= 1);
  for (const input of [[0, "valid"], [2_001, "valid"], [4, ""]]) {
    assert.throws(() => balancedArmScheduleFor(...input), /benchmark_schedule_invalid/);
  }
});
