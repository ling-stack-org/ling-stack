import assert from "node:assert/strict";
import test from "node:test";
import { assignTestShards, discoverDaemonTestFiles, estimateTestWeight } from "./daemon-test-shard.mjs";

test("daemon shard discovery leaves the dedicated dependency check out", async () => {
  const files = await discoverDaemonTestFiles();
  assert.ok(files.length > 0);
  assert.ok(!files.includes("test/dependency-security.test.mjs"));
});

test("daemon shard assignment is deterministic and covers every test once", () => {
  const files = [
    "test/runtime-supervisor.test.mjs",
    "test/contracts.test.mjs",
    "test/channel-reply-dispatch.test.mjs",
    "test/providers-api.test.mjs",
    "test/remote-gateway-security.test.mjs",
  ];
  const first = assignTestShards(files, 3);
  const second = assignTestShards([...files].reverse(), 3);
  assert.deepEqual(first, second);
  assert.deepEqual(first.flatMap((bucket) => bucket.files).sort(), files.sort());
  assert.equal(new Set(first.flatMap((bucket) => bucket.files)).size, files.length);
  assert.ok(first.every((bucket) => bucket.weight > 0));
});

test("weighted assignment puts expensive tests into the lightest shard", () => {
  assert.ok(estimateTestWeight("test/contracts.test.mjs") >= 1);
  assert.ok(estimateTestWeight("test/channel-workflow-status.test.mjs") >= 3);
  assert.throws(() => assignTestShards([], 0), /positive integer/);
});
