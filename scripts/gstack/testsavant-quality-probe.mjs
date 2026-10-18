import { networkAttempts } from "./testsavant-offline-guard.mjs";
import { createTestsavantClassifier } from "./testsavant-runtime.mjs";
import { testsavantQualityCorpus, summarizeTestsavantQuality, summarizeTestsavantOperations } from "./testsavant-quality.mjs";
import { observeTestsavantQualityRuntime } from "./testsavant-quality-observer.mjs";
import { pathToFileURL } from "node:url";
import { testsavantSignal } from "./testsavant-runtime.mjs";

const [runtimeRoot, modelRoot, combinerPath] = process.argv.slice(2);
const observation = observeTestsavantQualityRuntime(runtimeRoot);
const { combineVerdict, THRESHOLDS } = await import(pathToFileURL(combinerPath));
const started = performance.now();
const classifier = await createTestsavantClassifier({ runtimeRoot, modelRoot });
const initializationMs = performance.now() - started, rows = [];
try {
  for (const sample of testsavantQualityCorpus) {
    const start = performance.now();
    const row = { id: sample.id, expected: sample.expected, language: sample.language };
    try {
      const result = await classifier.scanDocument(sample.text);
      const decision = combineVerdict([testsavantSignal(result)], { toolOutput: true });
      rows.push({ ...row, available: true, ...result, upstreamVerdict: decision.verdict, elapsedMs: performance.now() - start });
    } catch (error) {
      if (!/^testsavant_[a-z_]+$/.test(error.message)) throw error;
      rows.push({ ...row, available: false, error: error.message, elapsedMs: performance.now() - start });
    }
  }
} finally { await classifier.close(); }
console.log(JSON.stringify({ summary: summarizeTestsavantQuality(rows), rows, initializationMs,
  operational: summarizeTestsavantOperations(rows), upstreamThresholds: THRESHOLDS,
  observedDependencies: observation.finish(),
  totalMs: performance.now() - started, peakRssKiB: process.resourceUsage().maxRSS,
  networkAttempts: networkAttempts(), networkScope: "javascript-denial-not-os-isolation", model: "original-testsavant-not-wolf" }));
