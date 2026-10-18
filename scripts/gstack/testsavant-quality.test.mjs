import assert from "node:assert/strict";
import test from "node:test";
import { testsavantQualityCorpus, summarizeTestsavantQuality, summarizeTestsavantOperations } from "./testsavant-quality.mjs";

const ideal = () => testsavantQualityCorpus.map(sample => ({ id: sample.id, expected: sample.expected,
  language: sample.language, available: true, label: sample.expected,
  injectionScore: sample.expected === "SAFE" ? 0.01 : 0.99, score: 0.99, coverage: "complete", tokens: 1,
  windows: [{ start: 0, end: 1, tokens: 3, injectionScore: sample.expected === "SAFE" ? 0.01 : 0.99,
    label: sample.expected, score: 0.99 }], aggregation: "maximum-window-score",
  upstreamVerdict: sample.expected === "SAFE" ? "safe" : "block", elapsedMs: 1 }));
test("quality assessment includes both languages and never counts unavailable detection as safe", () => {
  const rows = ideal();
  assert.equal(summarizeTestsavantQuality(rows).localCriteriaMet, true);
  const at = rows.findIndex(row => row.expected === "INJECTION" && row.language === "zh");
  rows[at] = { id: rows[at].id, expected: "INJECTION", language: "zh", available: false, error: "testsavant_tokens_invalid", elapsedMs: 1 };
  const summary = summarizeTestsavantQuality(rows);
  assert.equal(summary.localCriteriaMet, false);
  assert.equal(summary.overall.unavailable, 1);
  assert.equal(summary.overall.trueNegative, 18);
  assert.equal(summary.representativeQualityAccepted, false);
});

test("operational counts cover every row and reject unknown or downgraded decisions", () => {
  const rows = ideal(), summary = summarizeTestsavantOperations(rows);
  assert.equal(Object.values(summary.byExpected.SAFE).reduce((a, b) => a + b), 18);
  assert.equal(Object.values(summary.byExpected.INJECTION).reduce((a, b) => a + b), 20);
  for (const verdict of [undefined, "unknown", "safe", { toString: null }]) {
    const changed = ideal(); changed.find(row => row.expected === "INJECTION").upstreamVerdict = verdict;
    assert.throws(() => summarizeTestsavantOperations(changed), /operation_invalid/);
  }
  const tampered = structuredClone(summary); tampered.byExpected.SAFE.safe = 0;
  assert.notDeepEqual(summarizeTestsavantOperations(rows), tampered);
});
test("quality assessment rejects missing, duplicate, relabelled and malformed observations", () => {
  for (const edit of [rows => rows.pop(), rows => { rows[1] = rows[0]; },
    rows => { rows[0].expected = "INJECTION"; }, rows => { rows[0].label = "INJECTION"; },
    rows => { rows[0].injectionScore = NaN; }, rows => { rows[0].coverage = "prefix"; },
    rows => { rows[0].available = "false"; }, rows => { delete rows[0].windows; },
    rows => { rows[0].tokens = 2; }, rows => { rows[0].windows[0].start = 1; },
    rows => { rows[0].windows[0].injectionScore = 0.2; }, rows => { rows[0].windows[0].score = 0.9; }]) {
    const rows = ideal(); edit(rows);
    assert.throws(() => summarizeTestsavantQuality(rows), /quality_invalid/);
  }
});
