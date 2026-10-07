import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpus, platform, arch } from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { projectCanonicalConversationTimeline, projectDisplayBatches, expandDisplayBatch } from "../dist/index.js";
import { transcriptScaleFixture } from "./fixtures/transcript-scale.mjs";

const sampleCount = 20;
const warmupCount = 3;
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const summarize = (values) => ({ samples: values, p50Ms: percentile(values, .5), p95Ms: percentile(values, .95), maxMs: Math.max(...values) });

if (process.argv[2] === "--worker") {
  const count = Number(process.argv[3]);
  const kind = process.argv[4];
  assert.ok([10, 1_000, 10_000].includes(count));
  assert.ok(kind === "message" || kind === "exploration");
  const input = transcriptScaleFixture(count, kind);
  const projectionTimes = [], batchTimes = [], heapSamples = [];
  let atomic, display;
  for (let sample = -warmupCount; sample < sampleCount; sample += 1) {
    globalThis.gc?.();
    const start = performance.now();
    atomic = projectCanonicalConversationTimeline(input);
    const projected = performance.now();
    const contextSegmentIdByItemId = new Map(atomic.items.map((item) => [item.id, "synthetic-segment"]));
    const batchStart = performance.now();
    display = projectDisplayBatches(atomic.items, { contextSegmentIdByItemId });
    const end = performance.now();
    assert.equal(atomic.items.length, count);
    assert.equal(atomic.diagnostics.length, 0);
    assert.deepEqual(display.items.flatMap(expandDisplayBatch).map((item) => item.id), atomic.items.map((item) => item.id));
    assert.equal(atomic.terminalEvidence.length, kind === "message" ? 0 : count);
    if (sample >= 0) {
      projectionTimes.push(projected - start);
      batchTimes.push(end - batchStart);
      heapSamples.push(process.memoryUsage().heapUsed);
    }
  }
  console.log(JSON.stringify({ count, kind, projection: summarize(projectionTimes), batching: summarize(batchTimes),
    atomicRows: atomic.items.length, displayRows: display.items.length, terminalEvidenceRows: atomic.terminalEvidence.length,
    processPeakRssKiB: process.resourceUsage().maxRSS, maxSampledHeapBytes: Math.max(...heapSamples) }));
} else {
  const results = [];
  for (const kind of ["message", "exploration"]) {
    for (const count of [10, 1_000, 10_000]) {
      const run = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), "--worker", String(count), kind], { encoding: "utf8" });
      if (run.error) throw run.error;
      if (run.status !== 0) throw new Error(`Benchmark failed (${kind}/${count}): ${run.stderr}`);
      results.push(JSON.parse(run.stdout));
    }
  }
  console.log(JSON.stringify({ capturedAt: new Date().toISOString(), simulation: true, sampleCount, warmupCount,
    runtime: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
    methodology: "Fresh process per size/scenario; fixture construction and assertions excluded from timings. GC before samples. p95 uses nearest rank. RSS is whole-worker high-water mark, including runtime and fixtures; sampled heap is not a transient-allocation peak. Display rows are projection counts, not mounted DOM nodes. No historical baseline assumed.",
    results }, null, 2));
}
