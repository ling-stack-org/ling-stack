import assert from "node:assert/strict";
import test from "node:test";
import { planTestsavantWindows, testsavantPlainText, testsavantScores, testsavantSignal } from "./testsavant-runtime.mjs";
import { testsavantChildEnvironment, testsavantNodePath } from "./testsavant-client.mjs";
import { testsavantRouteVerdict } from "./testsavant-worker.mjs";

test("BERT windows cover every token and the tail, overlap 64 tokens, and respect the 512-position ceiling", () => {
  for (const count of [1, 509, 510, 511, 512, 955, 956, 957, 1024, 4078, 4079, 4095, 4096]) {
    const ids = Array.from({ length: count }, (_, index) => index % 30522);
    const windows = planTestsavantWindows(ids);
    const seen = new Set();
    for (const [index, window] of windows.entries()) {
      assert.equal(window.ids[0], 101); assert.equal(window.ids.at(-1), 102);
      assert.ok(window.ids.length <= 512);
      assert.deepEqual(window.ids, [101, ...ids.slice(window.start, window.end), 102]);
      assert.equal(window.start, index * 446);
      if (index) assert.equal(windows[index - 1].end - window.start, 64);
      for (let i = window.start; i < window.end; i++) seen.add(i);
    }
    assert.equal(seen.size, count); assert.equal(windows.at(-1).end, count);
  }
  for (const ids of [[], [30522], [-1], [NaN]]) assert.throws(() => planTestsavantWindows(ids), /tokens_invalid/);
  assert.throws(() => planTestsavantWindows(new Array(4097).fill(1)), /token_budget_exceeded/);
});

test("preprocessing and signal label mapping retain upstream semantics, never accept invalid native output", () => {
  assert.equal(testsavantPlainText('<p>Hello&nbsp;&amp; world</p><script>drop me</script>'), "Hello & world");
  assert.equal(testsavantPlainText("  plain   text  "), "  plain   text  ");
  const benign = testsavantScores({ type: "float32", dims: [1, 2], data: [10, 0] });
  assert.equal(benign.label, "SAFE");
  assert.equal(testsavantSignal({ ...benign, tokens: 1, windows: [{}] }).confidence, 0);
  assert.equal(testsavantScores({ type: "float32", dims: [1, 2], data: [-1000, 1000] }).label, "INJECTION");
  for (const output of [null, { type: "float32", dims: [2], data: [1, 2] },
    { type: "float32", dims: [1, 2], data: [NaN, 1] }]) assert.throws(() => testsavantScores(output), /output_invalid/);
});

test("platform resolver uses only packaged Node, and child environment excludes auth and preload injection", () => {
  assert.equal(testsavantNodePath("/Program Files/Ling/runtime", "darwin"), "/Program Files/Ling/runtime/tools/node");
  assert.equal(testsavantNodePath("C:\\Program Files\\Ling\\runtime", "win32"), "C:\\Program Files\\Ling\\runtime\\tools\\node.exe");
  assert.throws(() => testsavantNodePath("tools", "win32"), /runtime_root_invalid/);
  assert.throws(() => testsavantNodePath("\\\\server\\share\\runtime", "win32"), /runtime_root_invalid/);
  assert.throws(() => testsavantNodePath("/runtime/../other", "darwin"), /runtime_root_invalid/);
  assert.deepEqual(testsavantChildEnvironment({ NODE_OPTIONS: "--require evil", NODE_PATH: "evil", ELECTRON_RUN_AS_NODE: "1",
    API_KEY: "not-real", PATH: "evil", HOME: "/empty", SystemRoot: "C:\\Windows" }), { HOME: "/empty", SystemRoot: "C:\\Windows" });
});

test("TestSavant plain text decoding preserves nested entities for a later layer", () => {
  assert.equal(testsavantPlainText("<p>&amp;lt; &lt;</p>"), "&lt; <");
});

test("the actual gs route receives its vocabulary, without changing the upstream combiner thresholds", () => {
  for (const [input, output] of [["safe", "safe"], ["log_only", "safe"], ["warn", "suspicious"], ["block", "unsafe"]]) {
    assert.equal(testsavantRouteVerdict({ verdict: input }), output);
  }
  assert.throws(() => testsavantRouteVerdict({ verdict: "missing" }), /verdict_invalid/);
});
