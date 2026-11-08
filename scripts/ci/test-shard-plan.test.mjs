import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertSuiteCoverage, assignTestShards, createTestPlan, discoverTestFiles, estimateTestWeight,
  loadTimingHints, mergeTestReports, testSuites } from "./test-shard-plan.mjs";

test("core and daemon plans preserve full discovery exactly once with dynamic core jobs", async () => {
  for (const packages of [[], ["@ling-stack/core"], ["@ling-stack/daemon"], ["@ling-stack/core", "@ling-stack/daemon"]]) {
    const plan = await createTestPlan(packages);
    assert.deepEqual(Object.keys(plan.suites), Object.keys(testSuites).filter(name => packages.includes(testSuites[name].packageName)));
    assert.deepEqual(plan.unitMatrix.include, packages.includes("@ling-stack/core")
      ? Array.from({ length: 4 }, (_, shard) => ({ suite: "core", shard })) : []);
    for (const [name, suite] of Object.entries(plan.suites)) {
      const discovered = await discoverTestFiles(testSuites[name].cwd, testSuites[name].excluded);
      assert.ok(discovered.length > 100);
      assert.doesNotThrow(() => assertSuiteCoverage(suite, discovered));
      assert.equal(suite.shardCount, name === "daemon" ? 6 : 4);
    }
    if (plan.suites.daemon) assert.ok(!plan.suites.daemon.files.includes("test/dependency-security.test.mjs"));
  }
});

test("only selected unsharded packages create the packages job", async () => {
  for (const name of ["@ling-stack/web", "@ling-stack/cli", "@ling-stack/mobile"]) {
    const plan = await createTestPlan([name, "@ling-stack/daemon"]);
    assert.deepEqual(plan.unitMatrix.include, [{ suite: "packages", shard: 0 }]);
    assert.deepEqual(Object.keys(plan.suites), ["daemon"]);
  }
  const mixed = await createTestPlan(["@ling-stack/web", "@ling-stack/core", "@ling-stack/daemon"]);
  assert.deepEqual(mixed.unitMatrix.include, [{ suite: "packages", shard: 0 },
    ...Array.from({ length: 4 }, (_, shard) => ({ suite: "core", shard }))]);
});

test("split channel suites are discovered once with ordinary parallel workers and watchdogs", async () => {
  const plan = await createTestPlan(["@ling-stack/daemon"]);
  const suite = plan.suites.daemon;
  for (const file of ["channel-discussion", "channel-intents", "channel-workflows", "channel-workspace"]) {
    const path = `test/${file}.test.mjs`;
    assert.equal(suite.shards.flatMap(bucket => bucket.files).filter(file => file === path).length, 1);
    assert.ok(!testSuites.daemon.exclusive.includes(path));
    assert.equal(testSuites.daemon.fileTimeouts[path], undefined);
  }
  assert.ok(!suite.files.some(file => file.includes("channel-workspace-fixture")));
  assert.ok(testSuites.daemon.exclusive.includes("test/delegation-production-tool-surface.test.mjs"));
  for (const file of ["test/recovery-discovery-fair-scan.test.mjs", "test/workflow-candidate-validation.test.mjs",
    "test/workflow-conflict-recovery.test.mjs", "test/workflow-integration-candidate.test.mjs",
    "test/workflow-isolated-parallel-integration.test.mjs", "test/workflow-merge-approval.test.mjs"]) {
    assert.equal(testSuites.daemon.fileTimeouts[file], 600_000);
  }
});

test("measured durations balance placement deterministically without changing coverage", () => {
  const files = ["test/a.test.mjs", "test/b.test.mjs", "test/c.test.mjs", "test/new.test.mjs"];
  const options = { timings: { [files[0]]: 100_000, [files[1]]: 90_000, [files[2]]: 10_000 } };
  const plan = assignTestShards(files, 2, options);
  assert.deepEqual(plan, assignTestShards([...files].reverse(), 2, options));
  assert.deepEqual(plan.map(bucket => bucket.files), [[files[0], files[3]], [files[1], files[2]]]);
  assert.equal(estimateTestWeight(files[0], options), 100);
  assert.ok(estimateTestWeight(files[3], options) > 0);
  for (const duration of [0, -1, NaN, Infinity, "100", 3_600_001]) {
    assert.equal(estimateTestWeight(files[3], { timings: { [files[3]]: duration } }), 1);
  }
});

test("wrong-platform timings cannot influence a suite's plan", async () => {
  const base = await createTestPlan(["@ling-stack/core"]);
  const wrongPlatform = await createTestPlan(["@ling-stack/core"], { timings: {
    suites: { core: { platform: "darwin", durationsMs: Object.fromEntries(base.suites.core.files.map(file => [file, 1])) } },
  } });
  assert.deepEqual(wrongPlatform, base);
});

test("unavailable and corrupt timing caches fall back to complete plans", async t => {
  const root = await mkdtemp(join(tmpdir(), "ling-ci-timings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "timings.json");
  assert.deepEqual(await loadTimingHints(path), { version: 1, suites: {} });
  for (const invalid of ["{", "null", '{"version":2,"suites":{}}']) {
    await writeFile(path, invalid);
    assert.deepEqual(await loadTimingHints(path), { version: 1, suites: {} });
  }
  await writeFile(path, '{"version":1,"suites":{}}');
  assert.deepEqual(await loadTimingHints(path), { version: 1, suites: {} });
});

test("coverage rejects omissions, duplicate files, changed discovery and wrong shard counts", () => {
  const files = ["test/a.test.mjs", "test/b.test.mjs"];
  const valid = { files, shardCount: 2, shards: assignTestShards(files, 2) };
  assert.doesNotThrow(() => assertSuiteCoverage(valid, files));
  for (const suite of [null, {}, { ...valid, files: [files[0]] }, { ...valid, shardCount: 3 },
    { ...valid, shards: [{ files }, { files: [files[0]] }] }, { ...valid, shards: [{ files: [] }, { files: [] }] }]) {
    assert.throws(() => assertSuiteCoverage(suite, files), /coverage_mismatch/u);
  }
  assert.throws(() => assertSuiteCoverage(valid, [...files, "test/new.test.mjs"]), /coverage_mismatch/u);
});

async function reportFixture() {
  const plan = await createTestPlan(["@ling-stack/core", "@ling-stack/daemon"]);
  const reports = Object.entries(plan.suites).flatMap(([suite, entry]) => entry.shards.map((bucket, shard) => ({
    version: 1, suite, shard, shardCount: entry.shardCount, platform: entry.platform, complete: true,
    results: bucket.files.map((file, index) => ({ file, status: "passed", durationMs: index + 1 })),
  })));
  return { plan, reports };
}

test("only full, successful, same-platform shard reports become timing hints", async () => {
  const { plan, reports } = await reportFixture();
  const hints = mergeTestReports(plan, reports);
  for (const [name, suite] of Object.entries(plan.suites)) {
    assert.deepEqual(Object.keys(hints.suites[name].durationsMs).sort(), suite.files);
    assert.equal(hints.suites[name].platform, suite.platform);
  }
  assert.deepEqual(mergeTestReports(plan, [...reports].reverse()), hints);
  assert.throws(() => mergeTestReports(plan, reports.slice(1)), /Missing test reports/u);
  assert.throws(() => mergeTestReports(plan, [...reports, reports[0]]), /duplicate/u);
  for (const patch of [{ complete: false }, { version: 2 }, { suite: "other" }, { shardCount: 99 }, { platform: "win32" }, { results: [] }]) {
    assert.throws(() => mergeTestReports(plan, [{ ...reports[0], ...patch }, ...reports.slice(1)]));
  }
  for (const status of ["failed", "timed_out", "cancelled", "pending", "error", "leaked_processes"]) {
    const broken = structuredClone(reports);
    broken[0].results[0].status = status;
    assert.throws(() => mergeTestReports(plan, broken), /Unsuccessful test report/u);
  }
  const duplicate = structuredClone(reports);
  duplicate[0].results.push(duplicate[0].results[0]);
  assert.throws(() => mergeTestReports(plan, duplicate), /coverage_mismatch/u);
});

test("the plan CLI publishes a parseable matrix and the aggregate CLI verifies downloaded report paths", async t => {
  const root = await mkdtemp(join(tmpdir(), "ling-ci-plan-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = fileURLToPath(new URL("./test-shard-plan.mjs", import.meta.url));
  const path = join(root, "test-plan.json");
  const matrix = JSON.parse(execFileSync(process.execPath, [script, '--packages=["@ling-stack/core","@ling-stack/daemon"]',
    `--output=${path}`], { encoding: "utf8" }));
  const plan = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(matrix, plan.unitMatrix);
  const fixture = await reportFixture();
  assert.deepEqual(plan, fixture.plan);
  const reports = join(root, "reports");
  await mkdir(join(reports, "logs"), { recursive: true });
  await Promise.all(fixture.reports.map(report => writeFile(join(reports, `${report.suite}-${report.shard}.json`), JSON.stringify(report))));
  const output = join(root, "timings.json");
  assert.match(execFileSync(process.execPath, [script, `--plan=${path}`, `--reports=${reports}`, `--output=${output}`],
    { encoding: "utf8" }), /Verified complete test coverage/u);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), mergeTestReports(plan, fixture.reports));
});
