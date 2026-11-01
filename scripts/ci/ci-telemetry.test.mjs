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
  created_at: "2026-01-01T00:00:00Z",
  run_started_at: "2026-01-01T00:00:10Z",
  updated_at: "2026-01-01T00:05:00Z",
};

test("builds bounded run, queue, job, and shard telemetry", () => {
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
  assert.equal(telemetry.run.criticalPathMs, 180000);
  assert.equal(telemetry.jobs[0].queuedMs, 50000);
  assert.equal(telemetry.jobs[0].executionMs, 120000);
  assert.equal(telemetry.jobs[0].stepDurations[0].durationMs, 30000);
  assert.equal(telemetry.summary.timedOutFileCount, 1);
  assert.equal(telemetry.summary.maxDaemonShardDurationMs, 3000);
  assert.equal(telemetry.summary.shardImbalanceRatioBySuite.daemon, 1);
  assert.equal(telemetry.reports.suites.daemon.imbalanceRatio, 1);
  assert.match(renderSummary(telemetry), /timed-out files: \*\*1\*\*/u);
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
  assert.equal(buildTelemetry({ run: { telemetry_unavailable: true } }).telemetryUnavailable, true);
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
      version: 1, suite: "daemon", shard: 0, results: [],
    }));
    const child = spawn(process.execPath, ["scripts/ci/ci-telemetry.mjs",
      `--run=${runPath}`, `--jobs=${jobsPath}`, `--reports-dir=${reportsPath}`,
      `--output=${outputPath}`, `--summary=${summaryPath}`], { cwd: process.cwd() });
    const [code] = await new Promise(resolve => child.on("close", (status, signal) => resolve([status, signal])));
    assert.equal(code, 0);
    assert.equal(JSON.parse(await readFile(outputPath, "utf8")).reports.shards.length, 1);
    assert.match(await readFile(summaryPath, "utf8"), /CI timing telemetry/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
