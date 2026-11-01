import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_REASONABLE_MS = 7 * 24 * 60 * 60 * 1000;

function parseTimestamp(value) {
  const timestamp = typeof value === "string" ? Date.parse(value) : NaN;
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
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function normalizeJobs(input) {
  const jobs = Array.isArray(input) ? input : Array.isArray(input?.jobs) ? input.jobs : [];
  return jobs.filter(job => job && typeof job === "object");
}

function normalizeReports(input) {
  if (!Array.isArray(input)) return [];
  return input.filter(report => report && report.version === 1 && typeof report.suite === "string"
    && report.suite.length > 0 && Number.isInteger(report.shard) && report.shard >= 0 && Array.isArray(report.results));
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
  const runStarted = parseTimestamp(run.run_started_at) !== null ? run.run_started_at : run.created_at;
  return jobs.map(job => {
    const executionMs = duration(job.started_at, job.completed_at);
    const startDelayMs = duration(runStarted, job.started_at);
    const stepDurations = (Array.isArray(job.steps) ? job.steps : []).filter(step => step && typeof step === "object").map(step => ({
      name: step.name,
      conclusion: step.conclusion ?? null,
      durationMs: duration(step.started_at, step.completed_at),
    }));
    return {
      name: job.name ?? "unnamed",
      status: job.status ?? null,
      conclusion: job.conclusion ?? null,
      runner: job.runner_name ?? null,
      startDelayMs,
      executionMs,
      stepDurations,
    };
  });
}

function reportTelemetry(reports) {
  const shards = reports.map(report => {
    const files = report.results.filter(result => result && typeof result.file === "string").map(result => ({
      file: result.file,
      status: typeof result.status === "string" ? result.status : null,
      durationMs: Number.isFinite(result.durationMs) && result.durationMs >= 0 && result.durationMs <= MAX_REASONABLE_MS
        ? result.durationMs : null,
    }));
    const durations = files.map(result => result.durationMs).filter(Number.isFinite);
    const statuses = Object.fromEntries([...new Set(files.map(result => result.status))]
      .map(status => [status, files.filter(result => result.status === status).length]));
    return {
      suite: report.suite,
      shard: report.shard,
      platform: report.platform ?? null,
      complete: report.complete === true,
      fileCount: files.length,
      passedCount: files.filter(result => result.status === "passed").length,
      statusCounts: statuses,
      sumFileDurationMs: durations.length ? sum(durations) : null,
      maxFileDurationMs: durations.length ? Math.max(...durations) : null,
      p95FileDurationMs: percentile(durations, 0.95),
      files,
    };
  });
  const bySuite = Object.create(null);
  for (const shard of shards) (bySuite[shard.suite] ??= []).push(shard);
  const suites = Object.fromEntries(Object.entries(bySuite).map(([suite, entries]) => {
    const durations = entries.map(entry => entry.sumFileDurationMs).filter(Number.isFinite);
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

export function buildTelemetry({ run = {}, jobs = [], reports = [], capturedAt = new Date().toISOString() } = {}) {
  run ??= {};
  const normalizedJobs = normalizeJobs(jobs);
  const normalizedReports = normalizeReports(reports);
  const jobDurations = jobTelemetry(normalizedJobs, run);
  const durationSource = run.status === "completed" ? "updated_at" : "capturedAt";
  const runDurationMs = duration(run.created_at, durationSource === "updated_at" ? run.updated_at : capturedAt);
  const completedAt = normalizedJobs.filter(job => job.status === "completed")
    .map(job => parseTimestamp(job.completed_at)).filter(Number.isFinite);
  const completedJobsElapsedMs = completedAt.length
    ? duration(run.created_at, new Date(Math.max(...completedAt)).toISOString()) : null;
  const failedJobs = jobDurations.filter(job => job.conclusion && !["success", "skipped"].includes(job.conclusion)).length;
  const reportDetails = reportTelemetry(normalizedReports);
  const files = reportDetails.shards.flatMap(shard => shard.files);
  const timedOutFiles = files
    .filter(result => result.status === "timed_out").length;
  const leakedProcessFiles = files
    .filter(result => result.status === "leaked_processes").length;
  const suiteSummaries = reportDetails.suites;
  const finiteJobExecutions = jobDurations.map(job => job.executionMs).filter(Number.isFinite);
  const finiteJobStartDelays = jobDurations.map(job => job.startDelayMs).filter(Number.isFinite);
  return {
    version: 1,
    capturedAt,
    telemetryUnavailable: run.telemetry_unavailable === true || jobs?.telemetry_unavailable === true,
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
      durationSource,
      completedJobsElapsedMs,
    },
    summary: {
      jobCount: jobDurations.length,
      failedJobCount: failedJobs,
      availableReportCount: normalizedReports.length,
      timedOutFileCount: normalizedReports.length ? timedOutFiles : null,
      leakedProcessFileCount: normalizedReports.length ? leakedProcessFiles : null,
      maxJobExecutionMs: finiteJobExecutions.length ? Math.max(...finiteJobExecutions) : null,
      maxJobStartDelayMs: finiteJobStartDelays.length ? Math.max(...finiteJobStartDelays) : null,
      maxCoreShardFileDurationMs: suiteSummaries.core?.maxShardFileDurationMs ?? null,
      maxDaemonShardFileDurationMs: suiteSummaries.daemon?.maxShardFileDurationMs ?? null,
      shardImbalanceRatioBySuite: Object.fromEntries(Object.entries(suiteSummaries)
        .map(([suite, summary]) => [suite, summary.imbalanceRatio])),
    },
    jobs: jobDurations,
    reports: reportDetails,
  };
}

export function renderSummary(telemetry) {
  const ms = value => value === null ? "n/a" : `${(value / 60000).toFixed(2)} min`;
  const count = value => value === null ? "n/a" : value;
  const lines = [
    "## CI timing telemetry",
    "",
    ...(telemetry.telemetryUnavailable ? ["- Collection status: **unavailable**; this did not affect the quality gate."] : []),
    `- Run duration: **${ms(telemetry.run.durationMs)}** (source: ${telemetry.run.durationSource}); completed jobs elapsed since run creation: **${ms(telemetry.run.completedJobsElapsedMs)}** (excludes in-progress jobs; not a DAG critical path).`,
    `- Jobs: **${telemetry.summary.jobCount}**; max execution: **${ms(telemetry.summary.maxJobExecutionMs)}**; max start delay: **${ms(telemetry.summary.maxJobStartDelayMs)}** (includes dependency wait; measured from run start, or run creation if unavailable).`,
    `- Failed jobs: **${telemetry.summary.failedJobCount}**; timed-out files: **${count(telemetry.summary.timedOutFileCount)}**; leaked-process files: **${count(telemetry.summary.leakedProcessFileCount)}** (counts from available reports: ${telemetry.summary.availableReportCount}; missing or incomplete reports do not establish zero faults across the run).`,
  ];
  for (const [suite, data] of Object.entries(telemetry.reports.suites)) {
    lines.push(`- ${suite} shards: **${data.shardCount}**; max/average aggregate file time: **${ms(data.maxShardFileDurationMs)} / ${ms(data.averageShardFileDurationMs)}** (aggregate file time, not wall clock); imbalance: **${data.imbalanceRatio === null ? "n/a" : data.imbalanceRatio.toFixed(2)}x**`);
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
