import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverDaemonTestFiles } from "./daemon-test-shard.mjs";
import { assertSuiteCoverage, assignTestShards, createTestPlan, discoverSuiteFiles, discoverTestFiles, testSuites } from "./test-shard-plan.mjs";

test("shared and daemon discovery include TypeScript tests without treating helpers as tests", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-test-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "test");
  await mkdir(directory);
  for (const file of ["legacy.test.mjs", "typed.test.ts", "helper.ts", "dependency-security.test.mjs"]) {
    await writeFile(join(directory, file), "");
  }
  const expected = ["test/legacy.test.mjs", "test/typed.test.ts"];
  assert.deepEqual(await discoverTestFiles(root, testSuites.daemon.excluded), expected);
  assert.deepEqual(await discoverDaemonTestFiles(directory), expected);
});

test("outer placement accounts for all workers occupied by an exclusive file", () => {
  const exclusive = "test/exclusive.test.mjs";
  const ordinary = Array.from({ length: 12 }, (_, index) => `test/ordinary-${String(index).padStart(2, "0")}.test.mjs`);
  const files = [exclusive, ...ordinary];
  const timings = Object.fromEntries(files.map(file => [file, file === exclusive ? 60000 : 10000]));
  const options = { timings, concurrency: 2, exclusive: [exclusive] };
  const shards = assignTestShards(files, 2, options);
  assert.deepEqual(shards.map(shard => shard.files), [[exclusive], ordinary]);
  assert.deepEqual(shards.map(shard => shard.weight), [120, 120]);
  assert.deepEqual(assignTestShards([...files].reverse(), 2, options), shards);
  assert.deepEqual(shards.flatMap(shard => shard.files).sort(), files.sort());
  assert.deepEqual(assignTestShards(files, 2, { ...options, concurrency: 1 }),
    assignTestShards(files, 2, { timings }));
  for (const concurrency of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => assignTestShards(files, 2, { ...options, concurrency }), /positive integer/u);
  }
});

test("published plans apply exclusive cost without altering measured timing evidence", async () => {
  const base = await createTestPlan(["@ling-stack/daemon"]);
  const config = testSuites.daemon;
  const durationsMs = Object.fromEntries(base.suites.daemon.files.map((file: string) =>
    [file, config.exclusive.includes(file) ? 60000 : 1000]));
  const plan = await createTestPlan(["@ling-stack/daemon"], { timings: { suites: {
    daemon: { platform: config.platform, durationsMs },
  } } });
  const suite = plan.suites.daemon;
  assert.ok(plan.suites["daemon-linux"].files.includes("test/recovery-discovery-prefix.test.ts"));
  assert.deepEqual(suite.shards, assignTestShards(suite.files, config.shardCount, {
    cwd: config.cwd, timings: durationsMs, exclusive: config.exclusive, concurrency: config.concurrency,
  }));
  const expectedCost = Object.entries(durationsMs).reduce((sum, [file, duration]) =>
    sum + duration / 1000 * (config.exclusive.includes(file) ? config.concurrency : 1), 0);
  assert.equal(suite.shards.reduce((sum: number, shard: { weight: number }) => sum + shard.weight, 0), expectedCost);
  assert.deepEqual(suite.timings, durationsMs);
  assert.doesNotThrow(() => assertSuiteCoverage(suite, base.suites.daemon.files));
});

test("combined plans fit twenty runner slots while preserving isolated suite parallelism", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  const siblingJobs = workflow.split(/(?=^  [a-z][a-z-]*:\n)/mu).slice(1)
    .filter(block => /^    needs: \[scope, build\]$/mu.test(block) && !/^    strategy:/mu.test(block))
    .map(block => /^  ([a-z][a-z-]*):/u.exec(block)![1]).sort();
  assert.deepEqual(siblingJobs, ["daemon-linux-contracts", "restricted-command-macos", "typecheck", "web-smoke"]);
  for (const extra of [[], ["@ling-stack/web"], ["@ling-stack/api-client"]]) {
    const plan = await createTestPlan(["@ling-stack/core", "@ling-stack/daemon", ...extra]);
    const requested = plan.unitMatrix.include.length + plan.daemonMatrix.include.length + siblingJobs.length;
    assert.ok(requested <= 20, `Requested ${requested} runner slots`);
    assert.equal(plan.daemonMatrix.include.filter(entry => entry.runner === "macos-26").length + 1, 5);
    for (const [name, config] of Object.entries(testSuites)) {
      const discovered = await discoverSuiteFiles(config);
      assert.doesNotThrow(() => assertSuiteCoverage(plan.suites[name], discovered));
    }
  }
  assert.equal((await createTestPlan(["@ling-stack/core"])).unitMatrix.include.length, 8);
  const daemon = await createTestPlan(["@ling-stack/daemon"]);
  assert.equal(daemon.daemonMatrix.include.filter(entry => entry.suite === "daemon-linux").length, 8);
});
