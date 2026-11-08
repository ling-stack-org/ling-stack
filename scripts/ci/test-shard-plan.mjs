import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const testSuites = {
  core: { packageName: "@ling-stack/core", cwd: join(root, "packages/core"), platform: "linux", shardCount: 4, concurrency: 2, excluded: [], exclusive: [] },
  daemon: { packageName: "@ling-stack/daemon", cwd: join(root, "packages/daemon"), platform: "darwin", shardCount: 6, concurrency: 2,
    excluded: ["dependency-security.test.mjs"],
    // Keep explicit hosted-runner allowances for high-cost workflow fixtures.
    // Split channel files use the ordinary five-minute watchdog and workers.
    fileTimeouts: {
      "test/recovery-discovery-fair-scan.test.mjs": 600_000,
      "test/workflow-candidate-validation.test.mjs": 600_000,
      "test/workflow-conflict-recovery.test.mjs": 600_000,
      "test/workflow-integration-candidate.test.mjs": 600_000,
      "test/workflow-isolated-parallel-integration.test.mjs": 600_000,
      "test/workflow-merge-approval.test.mjs": 600_000,
      "test/workflow-worktree-cleanup.test.mjs": 600_000,
    },
    exclusive: ["test/acp-kimi-host-read.test.mjs", "test/acp-kimi-host-terminal.test.mjs",
      // Preserve the child-lifecycle fixture's exclusive execution from the PR.
      "test/delegation-production-tool-surface.test.mjs"] },
};

export async function discoverTestFiles(cwd, excluded = []) {
  return (await readdir(join(cwd, "test"))).filter(file => /\.test\.(?:mjs|ts)$/u.test(file) && !excluded.includes(file))
    .sort().map(file => `test/${file}`);
}

/** Timing hints only change placement, never discovery, coverage or deadlines. */
export function estimateTestWeight(file, { cwd = testSuites.daemon.cwd, timings = {} } = {}) {
  const measured = timings[file];
  if (Number.isFinite(measured) && measured > 0 && measured <= 3_600_000) return measured / 1000;
  const floor = /(?:integration|computer-use|remote|channel|workflow|workspace|media|mcp|runner|runtime)/iu.test(file)
    ? 3 : /(?:storage|conversation|startup|provider|terminal|skill|cua|office)/iu.test(file) ? 2 : 1;
  try { return Math.max(floor, Math.ceil(statSync(resolve(cwd, file)).size / 1024)); }
  catch (error) { if (error.code !== "ENOENT") throw error; return floor; }
}

/**
 * @param {string[]} files
 * @param {number} shardCount
 * @param {{ cwd?: string, timings?: Record<string, number>, exclusive?: string[], concurrency?: number }} [options]
 */
export function assignTestShards(files, shardCount, options = {}) {
  if (!Number.isInteger(shardCount) || shardCount < 1) throw new RangeError("shardCount must be a positive integer");
  const concurrency = options.concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new RangeError("concurrency must be a positive integer");
  const buckets = Array.from({ length: shardCount }, () => ({ files: [], weight: 0 }));
  // Exclusive files occupy the whole runner; ordinary files use one worker.
  const weighted = [...new Set(files)].map(file => ({ file, weight: estimateTestWeight(file, options)
    * (options.exclusive?.includes(file) ? concurrency : 1) }))
    .sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file));
  for (const item of weighted) {
    let target = 0;
    for (let index = 1; index < buckets.length; index += 1) {
      if (buckets[index].weight < buckets[target].weight) target = index;
    }
    buckets[target].files.push(item.file);
    buckets[target].weight += item.weight;
  }
  return buckets.map(bucket => ({ ...bucket, files: bucket.files.sort() }));
}

export async function loadTimingHints(path) {
  try {
    const hints = JSON.parse(await readFile(path, "utf8"));
    if (hints.version !== 1 || !hints.suites || typeof hints.suites !== "object") throw new Error("unsupported timing schema");
    return hints;
  } catch (error) {
    if (error.code !== "ENOENT") console.warn(`Ignoring unusable CI timing hints: ${error.message}`);
    return { version: 1, suites: {} };
  }
}

export async function createTestPlan(packages, { timings = { suites: {} } } = {}) {
  if (!Array.isArray(packages) || packages.some(name => typeof name !== "string")) throw new TypeError("packages must be a string array");
  /** @type {Record<string, { platform: string, files: string[], shardCount: number, concurrency: number,
   * timings: Record<string, number>, shards: ReturnType<typeof assignTestShards> }>} */
  const suites = {};
  for (const [name, config] of Object.entries(testSuites)) {
    if (!packages.includes(config.packageName)) continue;
    const files = await discoverTestFiles(config.cwd, config.excluded);
    if (files.length === 0) throw new Error(`No tests discovered for ${name}`);
    const hints = timings.suites?.[name];
    const durations = hints?.platform === config.platform ? hints.durationsMs : {};
    suites[name] = { platform: config.platform, files, shardCount: config.shardCount, concurrency: config.concurrency, timings: durations ?? {},
      shards: assignTestShards(files, config.shardCount, { ...config, timings: durations ?? {} }) };
  }
  const shardedPackages = Object.values(testSuites).map(config => config.packageName);
  return { version: 1, suites, unitMatrix: { include: [
    ...(packages.some(name => !shardedPackages.includes(name)) ? [{ suite: "packages", shard: 0 }] : []),
    ...Array.from({ length: suites.core?.shardCount ?? 0 }, (_, shard) => ({ suite: "core", shard })),
  ] } };
}

export function assertSuiteCoverage(suite, discovered) {
  const assigned = suite?.shards?.flatMap(bucket => bucket.files);
  const expected = [...discovered].sort();
  if (!Array.isArray(assigned) || suite.shards.length !== suite.shardCount
    || JSON.stringify([...assigned].sort()) !== JSON.stringify(expected)
    || JSON.stringify(suite.files) !== JSON.stringify(expected)
    || new Set(assigned).size !== assigned.length) {
    throw new Error("test_plan_coverage_mismatch: every discovered file must be assigned exactly once");
  }
}

/** The aggregate gate checks reports against the immutable plan before saving hints. */
export function mergeTestReports(plan, reports) {
  if (plan.version !== 1) throw new Error("Unsupported test plan version");
  const expected = new Map();
  for (const [name, suite] of Object.entries(plan.suites)) {
    assertSuiteCoverage(suite, suite.files);
    suite.shards.forEach((bucket, shard) => expected.set(`${name}-${shard}`, { name, suite, bucket, shard }));
  }
  const hints = { version: 1, suites: {} };
  for (const report of reports) {
    const key = `${report.suite}-${report.shard}`;
    const entry = expected.get(key);
    if (!entry || report.version !== 1 || report.complete !== true || report.shardCount !== entry.suite.shardCount
      || report.platform !== entry.suite.platform) throw new Error(`Invalid, duplicate or incomplete test report: ${key}`);
    const files = report.results?.map(result => result.file).sort();
    if (JSON.stringify(files) !== JSON.stringify(entry.bucket.files)) throw new Error(`test_report_coverage_mismatch: ${key}`);
    for (const result of report.results) {
      if (result.status !== "passed" || !Number.isFinite(result.durationMs) || result.durationMs <= 0) {
        throw new Error(`Unsuccessful test report: ${key} ${result.file} ${result.status}`);
      }
    }
    hints.suites[entry.name] ??= { platform: entry.suite.platform, durationsMs: {} };
    Object.assign(hints.suites[entry.name].durationsMs, Object.fromEntries(report.results.map(result => [result.file, result.durationMs])));
    expected.delete(key);
  }
  if (expected.size > 0) throw new Error(`Missing test reports: ${[...expected.keys()].join(", ")}`);
  return hints;
}

export function parseArguments(argv, allowed) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const [key, ...rest] = argv[index].split("=");
    if (!allowed.includes(key) || Object.hasOwn(args, key)) throw new Error(`Unknown or duplicate argument: ${key}`);
    const value = rest.length ? rest.join("=") : argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    args[key] = value;
  }
  return args;
}

async function main() {
  const args = parseArguments(process.argv.slice(2), ["--packages", "--timings", "--output", "--plan", "--reports"]);
  let result;
  if (args["--reports"]) {
    const plan = JSON.parse(await readFile(args["--plan"], "utf8"));
    const directory = args["--reports"];
    const files = (await readdir(directory)).filter(file => file.endsWith(".json")).sort();
    const reports = await Promise.all(files.map(async file => JSON.parse(await readFile(join(directory, file), "utf8"))));
    result = mergeTestReports(plan, reports);
    console.log(`Verified complete test coverage for ${Object.keys(plan.suites).join(", ")}.`);
  } else {
    result = await createTestPlan(JSON.parse(args["--packages"]), {
      timings: args["--timings"] ? await loadTimingHints(args["--timings"]) : undefined,
    });
    console.log(JSON.stringify(result.unitMatrix));
  }
  if (!args["--output"]) throw new Error("--output is required");
  await mkdir(dirname(resolve(args["--output"])), { recursive: true });
  await writeFile(args["--output"], `${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); } catch (error) { console.error(error); process.exitCode = 1; }
}
