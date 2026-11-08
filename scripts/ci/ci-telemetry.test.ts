import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { buildTelemetry, renderSummary } from "./ci-telemetry.mjs";

const run = {
  id: 42,
  event: "pull_request",
  head_sha: "abc123",
  status: "completed",
  created_at: "2026-01-01T00:00:00Z",
  run_started_at: "2026-01-01T00:00:10Z",
  updated_at: "2026-01-01T00:05:00Z",
};

test("builds run, start-delay, job, and aggregate shard file telemetry", () => {
  const telemetry = buildTelemetry({
    run,
    jobs: [{ name: "Daemon tests (shard 0)", status: "completed", conclusion: "success", runner_name: "macos-26",
      started_at: "2026-01-01T00:01:00Z", completed_at: "2026-01-01T00:03:00Z",
      steps: [{ name: "Run isolated daemon shard", started_at: "2026-01-01T00:02:00Z", completed_at: "2026-01-01T00:02:30Z", conclusion: "success" }] }],
    reports: [{ version: 1, suite: "daemon", shard: 0, platform: "darwin", complete: true, results: [
      { file: "test/a.test.mjs", status: "passed", durationMs: 1000 },
      { file: "test/b.test.mjs", status: "timed_out", durationMs: 2000 },
    ] }],
  });
  assert.equal(telemetry.run.durationMs, 300000);
  assert.equal(telemetry.run.durationSource, "updated_at");
  assert.equal(telemetry.run.completedJobsElapsedMs, 180000);
  assert.equal(telemetry.jobs[0].startDelayMs, 50000);
  assert.equal(telemetry.summary.maxJobStartDelayMs, 50000);
  assert.equal(telemetry.jobs[0].executionMs, 120000);
  assert.equal(telemetry.jobs[0].stepDurations[0].durationMs, 30000);
  assert.equal(telemetry.summary.timedOutFileCount, 1);
  assert.equal(telemetry.summary.availableReportCount, 1);
  assert.equal(telemetry.summary.maxDaemonShardFileDurationMs, 3000);
  assert.deepEqual(telemetry.reports.shards[0].files, [
    { file: "test/a.test.mjs", status: "passed", durationMs: 1000 },
    { file: "test/b.test.mjs", status: "timed_out", durationMs: 2000 },
  ]);
  assert.equal(telemetry.summary.shardImbalanceRatioBySuite.daemon, 1);
  assert.equal(telemetry.reports.suites.daemon.imbalanceRatio, 1);
  assert.match(renderSummary(telemetry), /timed-out files: \*\*1\*\*/u);
  assert.match(renderSummary(telemetry), /includes dependency wait/u);
  assert.match(renderSummary(telemetry), /aggregate file time, not wall clock/u);
  assert.match(renderSummary(telemetry), /excludes in-progress jobs; not a DAG critical path/u);
  assert.match(renderSummary(telemetry), /source: updated_at/u);
  assert.equal(Object.hasOwn(telemetry.run, "criticalPathMs"), false);
  assert.equal(Object.hasOwn(telemetry.jobs[0], "queuedMs"), false);
  for (const field of ["maxJobQueueMs", "maxCoreShardDurationMs", "maxDaemonShardDurationMs"]) {
    assert.equal(Object.hasOwn(telemetry.summary, field), false);
  }
});

test("in-progress run duration uses the injected capture time rather than updated_at", () => {
  const capturedAt = "2026-01-01T00:10:00Z";
  const telemetry = buildTelemetry({
    run: { ...run, status: "in_progress", updated_at: "2026-01-01T00:00:20Z" },
    capturedAt,
    jobs: [
      { status: "completed", completed_at: "2026-01-01T00:02:00Z" },
      { status: "in_progress", started_at: "2026-01-01T00:03:00Z", completed_at: "2026-01-01T00:09:00Z" },
    ],
  });
  assert.equal(telemetry.capturedAt, capturedAt);
  assert.equal(telemetry.run.durationSource, "capturedAt");
  assert.equal(telemetry.run.durationMs, 600000);
  assert.equal(telemetry.run.completedJobsElapsedMs, 120000);
  assert.match(renderSummary(telemetry), /source: capturedAt/u);
  for (const updated_at of ["not-a-date", "2026-01-01T00:09:59Z"]) {
    assert.equal(buildTelemetry({ run: { ...run, status: "in_progress", updated_at }, capturedAt }).run.durationMs, 600000);
  }
  assert.equal(buildTelemetry({ run: { ...run, status: "queued" }, capturedAt }).run.durationMs, 600000);
});

test("completed run duration retains the updated_at source even after collection", () => {
  const telemetry = buildTelemetry({ run, capturedAt: "2026-01-02T00:00:00Z" });
  assert.equal(telemetry.run.durationMs, 300000);
  assert.equal(telemetry.run.durationSource, "updated_at");
  assert.equal(telemetry.run.completedJobsElapsedMs, null);
});

test("default capture time is a real collection clock", () => {
  const before = Date.now();
  const telemetry = buildTelemetry({ run: { status: "in_progress", created_at: new Date(before - 1000).toISOString() } });
  const captured = Date.parse(telemetry.capturedAt);
  assert.ok(captured >= before && captured <= Date.now());
  assert.equal(telemetry.run.durationMs, captured - (before - 1000));
});

test("keeps incomplete or malformed timestamps observable without inventing durations", () => {
  const telemetry = buildTelemetry({
    run: { created_at: "not-a-date", updated_at: "2026-01-01T00:00:00Z" },
    jobs: [{ name: "broken", started_at: "not-a-date", completed_at: "2026-01-01T00:01:00Z", conclusion: "failure" }],
    reports: [{ version: 2, suite: "ignored", shard: 0, results: [] }],
  });
  assert.equal(telemetry.run.durationMs, null);
  assert.equal(telemetry.jobs[0].executionMs, null);
  assert.equal(telemetry.summary.failedJobCount, 1);
  assert.equal(telemetry.summary.maxJobExecutionMs, null);
  assert.deepEqual(telemetry.reports.shards, []);
  assert.equal(telemetry.summary.availableReportCount, 0);
  assert.equal(telemetry.summary.timedOutFileCount, null);
  assert.equal(telemetry.summary.leakedProcessFileCount, null);
  assert.match(renderSummary(telemetry), /timed-out files: \*\*n\/a\*\*/u);
  assert.match(renderSummary(telemetry), /counts from available reports: 0/u);
  assert.equal(buildTelemetry({ run: { telemetry_unavailable: true } }).telemetryUnavailable, true);
  assert.equal(buildTelemetry({ jobs: { telemetry_unavailable: true } }).telemetryUnavailable, true);
});

test("rejects invalid, reversed, and unreasonable timing intervals without clamping", () => {
  for (const [started_at, completed_at] of [
    ["not-a-date", "2026-01-01T00:01:00Z"],
    ["2026-01-01T00:01:00Z", "2026-01-01T00:00:00Z"],
    ["2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"],
    [null, "2026-01-01T00:01:00Z"],
    [0, "2026-01-01T00:01:00Z"],
    [{ invalid: true }, "2026-01-01T00:01:00Z"],
  ]) {
    const telemetry = buildTelemetry({
      run: { ...run, created_at: started_at, updated_at: completed_at },
      jobs: [{ status: "completed", started_at, completed_at, steps: [{ started_at, completed_at }] }],
    });
    assert.equal(telemetry.run.durationMs, null);
    assert.equal(telemetry.run.completedJobsElapsedMs, null);
    assert.equal(telemetry.jobs[0].executionMs, null);
    assert.equal(telemetry.jobs[0].stepDurations[0].durationMs, null);
  }
  for (const started_at of ["not-a-date", "2025-12-31T23:59:00Z", "2026-02-01T00:00:00Z"]) {
    const telemetry = buildTelemetry({ run, jobs: [{ started_at }] });
    assert.equal(telemetry.jobs[0].startDelayMs, null);
    assert.equal(telemetry.summary.maxJobStartDelayMs, null);
  }
  for (const capturedAt of ["bad-clock", "2025-12-31T23:59:00Z", "2026-02-01T00:00:00Z"]) {
    assert.equal(buildTelemetry({ run: { ...run, status: "in_progress" }, capturedAt }).run.durationMs, null);
  }
  const fallback = buildTelemetry({ run: { ...run, run_started_at: "bad" }, jobs: [{ started_at: "2026-01-01T00:01:00Z" }] });
  assert.equal(fallback.jobs[0].startDelayMs, 60000);
});

test("retains pending and running file details and normalizes invalid file durations", () => {
  const results = [
    { file: "pending.mjs", status: "pending" },
    { file: "running.mjs", status: "running" },
    { file: "timeout.mjs", status: "timed_out", durationMs: -1 },
    { file: "leak.mjs", status: "leaked_processes", durationMs: "100" },
    ...[null, NaN, Infinity, 8 * 24 * 60 * 60 * 1000].map((durationMs, index) => ({ file: `invalid-${index}.mjs`, status: "failed", durationMs })),
    { file: "passed.mjs", status: "passed", durationMs: 1000 },
  ];
  const telemetry = buildTelemetry({ reports: [{ version: 1, suite: "daemon", shard: 0, complete: false, results }] });
  const shard = telemetry.reports.shards[0];
  assert.deepEqual(shard.files, results.map(result => ({ ...result, durationMs: result.status === "passed" ? 1000 : null })));
  assert.equal(shard.complete, false);
  assert.equal(shard.fileCount, results.length);
  assert.equal(shard.statusCounts.pending, 1);
  assert.equal(shard.statusCounts.running, 1);
  assert.equal(shard.passedCount, 1);
  assert.equal(shard.sumFileDurationMs, 1000);
  assert.equal(shard.maxFileDurationMs, 1000);
  assert.equal(shard.p95FileDurationMs, 1000);
  assert.equal(telemetry.summary.timedOutFileCount, 1);
  assert.equal(telemetry.summary.leakedProcessFileCount, 1);
  assert.match(renderSummary(telemetry), /counts from available reports: 1/u);
  assert.match(renderSummary(telemetry), /missing or incomplete reports do not establish zero faults across the run/u);
});

test("aggregate shard durations are file sums and retain measured zero durations", () => {
  const telemetry = buildTelemetry({ reports: [
    { version: 1, suite: "core", shard: 0, results: [
      { file: "a.mjs", status: "passed", durationMs: 1000 },
      { file: "b.mjs", status: "passed", durationMs: 2000 },
    ] },
    { version: 1, suite: "core", shard: 1, results: [{ file: "c.mjs", status: "passed", durationMs: 0 }] },
    { version: 1, suite: "core", shard: 2, results: [{ file: "d.mjs", status: "pending" }] },
  ] });
  assert.equal(telemetry.summary.maxCoreShardFileDurationMs, 3000);
  assert.equal(telemetry.reports.shards[0].sumFileDurationMs, 3000);
  assert.equal(telemetry.reports.shards[1].sumFileDurationMs, 0);
  assert.equal(telemetry.reports.shards[2].sumFileDurationMs, null);
  assert.deepEqual(telemetry.reports.suites.core, {
    shardCount: 3, maxShardFileDurationMs: 3000, averageShardFileDurationMs: 1500, imbalanceRatio: 2,
  });
});

test("p95 file duration uses nearest-rank for small samples", () => {
  const samples: [number[], number | null][] = [
    [[], null], [[1000], 1000], [[2000, 1000], 2000],
    [[3000, 1000, 2000], 3000], [Array.from({ length: 20 }, (_, index) => index + 1), 19],
  ];
  for (const [durations, expected] of samples) {
    const telemetry = buildTelemetry({ reports: [{ version: 1, suite: "core", shard: 0,
      results: durations.map((durationMs, index) => ({ file: `${index}.mjs`, status: "passed", durationMs })) }] });
    assert.equal(telemetry.reports.shards[0].p95FileDurationMs, expected);
  }
});

test("tolerates invalid reports and malformed result, job, and step entries", () => {
  const invalidReports = [null, false, "bad", {}, { version: 2, suite: "core", shard: 0, results: [] },
    { version: 1, suite: "core", shard: -1, results: [] }, { version: 1, suite: "core", shard: 0, results: null }];
  assert.equal(buildTelemetry({ reports: invalidReports }).summary.availableReportCount, 0);
  for (const reports of [null, {}, "bad"]) assert.deepEqual(buildTelemetry({ reports }).reports.shards, []);
  assert.doesNotThrow(() => buildTelemetry({ run: null, jobs: null }));
  const telemetry = buildTelemetry({
    jobs: { jobs: [null, false, "bad", { steps: {} }, { steps: [null, false, "bad", {}] }] },
    reports: [...invalidReports, { version: 1, suite: "__proto__", shard: 0,
      results: [null, false, "bad", {}, { file: "retained.mjs", status: "running" }] }],
  });
  assert.equal(telemetry.jobs.length, 2);
  assert.deepEqual(telemetry.jobs[0].stepDurations, []);
  assert.equal(telemetry.jobs[1].stepDurations.length, 1);
  assert.equal(telemetry.summary.availableReportCount, 1);
  assert.deepEqual(telemetry.reports.shards[0].files, [{ file: "retained.mjs", status: "running", durationMs: null }]);
  assert.equal(telemetry.reports.shards[0].sumFileDurationMs, null);
  assert.equal(telemetry.reports.suites.__proto__.maxShardFileDurationMs, null);
});

test("CLI reads a report directory and writes both telemetry outputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ci-telemetry-test-"));
  try {
    const runPath = join(directory, "run.json");
    const jobsPath = join(directory, "jobs.json");
    const reportsPath = join(directory, "reports");
    const outputPath = join(directory, "nested", "telemetry.json");
    const summaryPath = join(directory, "nested", "telemetry.md");
    await writeFile(runPath, JSON.stringify(run));
    await writeFile(jobsPath, JSON.stringify({ jobs: [] }));
    await mkdir(reportsPath);
    await writeFile(join(reportsPath, "daemon-0.json"), JSON.stringify({
      version: 1, suite: "daemon", shard: 0, results: [{ file: "pending.mjs", status: "pending" }],
    }));
    await writeFile(join(reportsPath, "broken.json"), "{broken");
    await writeFile(join(reportsPath, "invalid.json"), JSON.stringify({ version: 2 }));
    const child = spawn(process.execPath, ["scripts/ci/ci-telemetry.mjs",
      `--run=${runPath}`, `--jobs=${jobsPath}`, `--reports-dir=${reportsPath}`,
      `--output=${outputPath}`, `--summary=${summaryPath}`], { cwd: process.cwd() });
    const [code] = await new Promise<[number | null, NodeJS.Signals | null]>(resolve =>
      child.on("close", (status, signal) => resolve([status, signal])));
    assert.equal(code, 0);
    const telemetry = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(telemetry.reports.shards.length, 1);
    assert.deepEqual(telemetry.reports.shards[0].files, [{ file: "pending.mjs", status: "pending", durationMs: null }]);
    assert.match(await readFile(summaryPath, "utf8"), /CI timing telemetry/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
