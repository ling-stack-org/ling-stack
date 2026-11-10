import assert from "node:assert/strict";

// Test-only observation of native calls; never used by the production worker.
export function validateTestsavantParityCalls(calls, upstream = false) {
  assert.equal(calls.length, upstream ? 2 : 1, "unexpected native call count");
  const classifier = calls[0];
  const names = ["attention_mask", "input_ids", "token_type_ids"];
  assert.deepEqual([...classifier.inputNames].sort(), names);
  assert.deepEqual(Object.keys(classifier.feeds).sort(), names);
  assert.equal(classifier.outputNames.length, 1);
  const length = classifier.feeds.input_ids.data.length;
  assert.ok(length >= 2 && length <= 512);
  for (const name of names) {
    const tensor = classifier.feeds[name];
    assert.equal(tensor.type, "int64"); assert.deepEqual(tensor.dims, [1, length]);
    assert.equal(tensor.data.length, length); assert.ok(tensor.data.every(value => typeof value === "bigint"));
  }
  if (upstream) {
    const topk = calls[1];
    assert.notEqual(topk.session, classifier.session, "TopK is a distinct native session");
    assert.deepEqual([...topk.inputNames].sort(), ["k", "x"]);
    assert.deepEqual([...topk.outputNames].sort(), ["i", "v"]);
    assert.deepEqual(Object.keys(topk.feeds).sort(), ["k", "x"]);
    assert.deepEqual(topk.feeds.k, { type: "int64", dims: [1], data: [1n] });
    assert.equal(topk.feeds.x.type, "float32"); assert.deepEqual(topk.feeds.x.dims, [2]);
    assert.equal(topk.feeds.x.data.length, 2);
    assert.ok(topk.feeds.x.data.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
    assert.ok(Math.abs(topk.feeds.x.data[0] + topk.feeds.x.data[1] - 1) < 1e-6);
  }
  return classifier.feeds;
}
