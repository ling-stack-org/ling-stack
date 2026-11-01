import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_REASONABLE_MS = 7 * 24 * 60 * 60 * 1000;

function parseTimestamp(value) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

function duration(start, end) {
  const started = parseTimestamp(start);
  const completed = parseTimestamp(end);
  if (started === null || completed === null || completed < started || completed - started > MAX_REASONABLE_MS) return null;
  return completed - started;
}

function sum(values) {
  return values.reduce((total, value) => total + (Number.isFinite(value) && value >= 0 ? value : 0), 0);
}

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function normalizeJobs(input) {
  if (Array.isArray(input)) return input;
  if (Array.isArray(input?.jobs)) return input.jobs;
  return [];
}

function normalizeReports(input) {
  if (!Array.isArray(input)) return [];
  return input.filter(report => report && report.version === 1 && typeof report.suite === "string"
    && Number.isInteger(report.shard) && Array.isArray(report.results));
}

function parseArguments(argv, allowed) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const [key, ...valueParts] = argv[index].split("=");
    if (!allowed.includes(key) || Object.hasOwn(args, key)) throw new Error(`Unknown or duplicate argument: ${key}`);
    const value = valueParts.length ? valueParts.join("=") : argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    args[key] = value;
  }
  return args;
}

async function readReportsDirectory(directory) {
  try {
    const files = (await readdir(directory)).filter(file => file.endsWith(".json")).sort();
    const reports = [];
    for (const file of files) {
      try {
        reports.push(JSON.parse(await readFile(join(directory, file), "utf8")));
      } catch {
        // A failed shard must not turn observation into a quality failure.
      }
    }
    return reports;
  } catch {
    return [];
  }
}

function jobTelemetry(jobs, run) {
  const runCreated = parseTimestamp(run.created_at);
  const runStarted = parseTimestamp(run.run_started_at) ?? runCreated;
  return jobs.map(job => {
    const executionMs = duration(job.started_at, job.completed_at);
    const queuedMs = runStarted !== null && parseTimestamp(job.started_at) !== null
      ? Math.max(0, parseTimestamp(job.started_at) - runStarted) : null;
    const stepDurations = (job.steps ?? []).map(step => ({
      name: step.name,
      conclusion: step.conclusion ?? null,
      durationMs: duration(step.started_at, step.completed_at),
    }));
    return {
      name: job.name ?? "unnamed",
      status: job.status ?? null,
      conclusion: job.conclusion ?? null,
      runner: job.runner_name ?? null,
      queuedMs,
      executionMs,
      stepDurations,
    };
  });
}

function reportTelemetry(reports) {
  const shards = reports.map(report => {
    const durations = report.results.map(result => result.durationMs).filter(value => Number.isFinite(value) && value >= 0);
    const statuses = Object.fromEntries([...new Set(report.results.map(result => result.status))]
      .map(status => [status, report.results.filter(result => result.status === status).length]));
    return {
      suite: report.suite,
      shard: report.shard,
      platform: report.platform ?? null,
      complete: report.complete === true,
      fileCount: report.results.length,
      passedCount: report.results.filter(result => result.status === "passed").length,
      statusCounts: statuses,
      sumFileDurationMs: sum(durations),
      maxFileDurationMs: durations.length ? Math.max(...durations) : null,
      p95FileDurationMs: percentile(durations, 0.95),
    };
  });
  const bySuite = {};
  for (const shard of shards) (bySuite[shard.suite] ??= []).push(shard);
  const suites = Object.fromEntries(Object.entries(bySuite).map(([suite, entries]) => {
    const durations = entries.map(entry => entry.sumFileDurationMs).filter(value => value > 0);
    const max = durations.length ? Math.max(...durations) : null;
    const average = durations.length ? sum(durations) / durations.length : null;
    return [suite, {
      shardCount: entries.length,
      maxShardFileDurationMs: max,
      averageShardFileDurationMs: average,
      imbalanceRatio: max !== null && average ? max / average : null,
    }];
  }));
  return { shards, suites };
}

export function buildTelemetry({ run = {}, jobs = [], reports = [] } = {}) {
  const normalizedJobs = normalizeJobs(jobs);
  const normalizedReports = normalizeReports(reports);
  const jobDurations = jobTelemetry(normalizedJobs, run);
  const runDurationMs = duration(run.created_at, run.updated_at);
  const completedAt = normalizedJobs.map(job => parseTimestamp(job.completed_at)).filter(Number.isFinite);
  const runCreated = parseTimestamp(run.created_at);
  const criticalPathMs = runCreated !== null && completedAt.length && Math.max(...completedAt) >= runCreated
    ? Math.min(Math.max(...completedAt) - runCreated, MAX_REASONABLE_MS) : null;
  const failedJobs = jobDurations.filter(job => job.conclusion && !["success", "skipped"].includes(job.conclusion)).length;
  const timedOutFiles = normalizedReports.flatMap(report => report.results)
    .filter(result => result.status === "timed_out").length;
  const leakedProcessFiles = normalizedReports.flatMap(report => report.results)
    .filter(result => result.status === "leaked_processes").length;
  const suiteSummaries = reportTelemetry(normalizedReports).suites;
  const finiteJobExecutions = jobDurations.map(job => job.executionMs).filter(Number.isFinite);
  const finiteJobQueues = jobDurations.map(job => job.queuedMs).filter(Number.isFinite);
  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    telemetryUnavailable: run.telemetry_unavailable === true || jobs.telemetry_unavailable === true,
    run: {
      id: run.id ?? null,
      event: run.event ?? null,
      sha: run.head_sha ?? null,
      status: run.status ?? null,
      conclusion: run.conclusion ?? null,
      createdAt: run.created_at ?? null,
      startedAt: run.run_started_at ?? null,
      updatedAt: run.updated_at ?? null,
      durationMs: runDurationMs,
      criticalPathMs,
    },
    summary: {
      jobCount: jobDurations.length,
      failedJobCount: failedJobs,
      timedOutFileCount: timedOutFiles,
      leakedProcessFileCount: leakedProcessFiles,
      maxJobExecutionMs: finiteJobExecutions.length ? Math.max(...finiteJobExecutions) : null,
      maxJobQueueMs: finiteJobQueues.length ? Math.max(...finiteJobQueues) : null,
      maxCoreShardDurationMs: suiteSummaries.core?.maxShardFileDurationMs ?? null,
      maxDaemonShardDurationMs: suiteSummaries.daemon?.maxShardFileDurationMs ?? null,
      shardImbalanceRatioBySuite: Object.fromEntries(Object.entries(suiteSummaries)
        .map(([suite, summary]) => [suite, summary.imbalanceRatio])),
    },
    jobs: jobDurations,
    reports: reportTelemetry(normalizedReports),
  };
}

export function renderSummary(telemetry) {
  const ms = value => value === null ? "n/a" : `${(value / 60000).toFixed(2)} min`;
  const lines = [
    "## CI timing telemetry",
    "",
    ...(telemetry.telemetryUnavailable ? ["- Collection status: **unavailable**; this did not affect the quality gate."] : []),
    `- Run duration observed at collection: **${ms(telemetry.run.durationMs)}**; critical path: **${ms(telemetry.run.criticalPathMs)}**`,
    `- Jobs: **${telemetry.summary.jobCount}**; max execution: **${ms(telemetry.summary.maxJobExecutionMs)}**; max queue estimate: **${ms(telemetry.summary.maxJobQueueMs)}**`,
    `- Failed jobs: **${telemetry.summary.failedJobCount}**; timed-out files: **${telemetry.summary.timedOutFileCount}**; leaked-process files: **${telemetry.summary.leakedProcessFileCount}**`,
  ];
  for (const [suite, data] of Object.entries(telemetry.reports.suites)) {
    lines.push(`- ${suite} shards: **${data.shardCount}**; max/average file time: **${ms(data.maxShardFileDurationMs)} / ${ms(data.averageShardFileDurationMs)}**; imbalance: **${data.imbalanceRatio === null ? "n/a" : data.imbalanceRatio.toFixed(2)}x**`);
  }
  lines.push("", "Per-job and per-file details are retained in the `ci-telemetry` artifact.");
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArguments(process.argv.slice(2), ["--run", "--jobs", "--reports", "--reports-dir", "--output", "--summary"]);
  if (!args["--run"] || !args["--jobs"] || !args["--output"] || !args["--summary"]
    || (args["--reports"] && args["--reports-dir"])) {
    throw new Error("--run, --jobs, --output and --summary are required; use only one reports input");
  }
  const run = JSON.parse(await readFile(args["--run"], "utf8"));
  const jobs = JSON.parse(await readFile(args["--jobs"], "utf8"));
  const reports = args["--reports"] ? JSON.parse(await readFile(args["--reports"], "utf8"))
    : args["--reports-dir"] ? await readReportsDirectory(args["--reports-dir"]) : [];
  const telemetry = buildTelemetry({ run, jobs, reports });
  await mkdir(dirname(resolve(args["--output"])), { recursive: true });
  await writeFile(args["--output"], `${JSON.stringify(telemetry, null, 2)}\n`);
  await writeFile(args["--summary"], renderSummary(telemetry));
  console.log(`Captured CI telemetry for ${telemetry.summary.jobCount} jobs and ${telemetry.reports.shards.length} shard reports.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); } catch (error) { console.error(error); process.exitCode = 1; }
}
