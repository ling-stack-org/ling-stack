import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../packages/daemon");

// These real native lifecycle fixtures have short observation windows. Keep
// their original exclusive execution before starting other test workers.
const exclusiveTestFiles = new Set([
  "test/acp-kimi-host-read.test.mjs",
  "test/acp-kimi-host-terminal.test.mjs",
]);

/**
 * Return daemon test files in a stable order. The caller passes these paths to
 * Node's test runner, so discovery stays independent from shell globbing.
 * @param {string} testDirectory
 * @returns {Promise<string[]>}
 */
export async function discoverDaemonTestFiles(testDirectory = join(packageRoot, "test")) {
  return (await readdir(testDirectory))
    .filter((file) => file.endsWith(".test.mjs") && file !== "dependency-security.test.mjs")
    .sort()
    .map((file) => `test/${file}`);
}

/**
 * Estimate relative test cost using stable filename categories. This is only
 * a first-pass balancer; a future timing artifact can replace these weights
 * without changing the shard contract.
 * @param {string} file
 * @returns {number}
 */
export function estimateTestWeight(file) {
  const keywordWeight = /(?:integration|computer-use|remote|channel|workflow|workspace|media|mcp|runner|runtime)/iu.test(file)
    ? 3
    : /(?:storage|conversation|startup|provider|terminal|skill|cua|office)/iu.test(file)
      ? 2
      : 1;
  const absoluteFile = file.startsWith("test/") ? resolve(packageRoot, file) : file;
  try {
    // Source size tracks the number of test cases and setup work better than
    // filename categories alone, while the keyword floor covers small costly
    // integration fixtures.
    return Math.max(keywordWeight, Math.ceil(statSync(absoluteFile).size / 1024));
  } catch {
    return keywordWeight;
  }
}

/**
 * Greedily assign the heaviest tests first to the currently lightest bucket.
 * The tie-breaker is shard index, making assignments reproducible across runs.
 * @param {string[]} files
 * @param {number} shardCount
 * @returns {{files: string[], weight: number}[]}
 */
export function assignTestShards(files, shardCount) {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new RangeError("shardCount must be a positive integer");
  }
  const buckets = Array.from({ length: shardCount }, () => ({ files: [], weight: 0 }));
  const weightedFiles = [...new Set(files)]
    .map((file) => ({ file, weight: estimateTestWeight(file) }))
    .sort((left, right) => right.weight - left.weight || left.file.localeCompare(right.file));

  for (const item of weightedFiles) {
    const target = buckets.reduce((best, bucket, index) => (
      bucket.weight < best.weight || (bucket.weight === best.weight && index < best.index)
        ? { ...bucket, index }
        : best
    ), { ...buckets[0], index: 0 });
    buckets[target.index].files.push(item.file);
    buckets[target.index].weight += item.weight;
  }

  return buckets.map((bucket) => ({ ...bucket, files: bucket.files.sort() }));
}

export async function createDaemonShardIsolation(shard, temporaryDirectory = tmpdir()) {
  const root = await mkdtemp(join(temporaryDirectory, `ling-stack-daemon-shard-${shard}-`));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  await Promise.all([mkdir(home), mkdir(workspace)]);
  return { root, home, workspace };
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const [key, inlineValue] = value.slice(2).split("=", 2);
    parsed[key] = inlineValue ?? argv[++index];
  }
  return parsed;
}

async function runWorker(files, { shard, worker, cwd, temporaryDirectory, stdio }) {
  const isolation = await createDaemonShardIsolation(`${shard}-worker-${worker}`, temporaryDirectory);
  const started = performance.now();
  try {
    const env = {
      ...process.env,
      LING_STACK_HOME: isolation.home,
      LING_STACK_DEFAULT_WORKSPACE_CWD: isolation.workspace,
    };
    // This is a new test coordinator even when invoked by a runner contract test.
    delete env.NODE_TEST_CONTEXT;
    const status = await new Promise((resolveStatus, reject) => {
      const child = spawn(process.execPath, ["--test", "--test-concurrency=1", ...files], {
        cwd,
        env,
        stdio,
      });
      child.once("error", reject);
      child.once("close", (code) => resolveStatus(code ?? 1));
    });
    console.log(`Daemon shard ${shard}, worker ${worker}: ${files.length} files, exit ${status}, ${((performance.now() - started) / 1000).toFixed(1)}s.`);
    return status;
  } finally {
    await rm(isolation.root, { recursive: true, force: true });
  }
}

/** Keep files serial within each isolated worker, without adding hosted jobs. */
export async function runDaemonTestFiles(files, {
  concurrency = 1, shard = 0, cwd = packageRoot, temporaryDirectory = tmpdir(), stdio = "inherit",
} = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency must be a positive integer");
  }
  const uniqueFiles = [...new Set(files)];
  if (uniqueFiles.length === 0) return 0;
  const exclusive = concurrency > 1 ? uniqueFiles.filter(file => exclusiveTestFiles.has(file)).sort() : [];
  const parallel = uniqueFiles.filter(file => !exclusive.includes(file));
  const results = [];
  if (exclusive.length > 0) {
    results.push(...await Promise.allSettled([runWorker(exclusive, {
      shard, worker: "exclusive", cwd, temporaryDirectory, stdio,
    })]));
  }
  const workers = parallel.length > 0
    ? assignTestShards(parallel, Math.min(concurrency, parallel.length)) : [];
  // Wait for all workers even after a failure so their evidence and cleanup
  // complete before this process reports the aggregate result.
  results.push(...await Promise.allSettled(workers.map((bucket, worker) => runWorker(bucket.files, {
    shard, worker, cwd, temporaryDirectory, stdio,
  }))));
  const error = results.find(result => result.status === "rejected");
  if (error) throw error.reason;
  return results.some(result => result.value !== 0) ? 1 : 0;
}

async function runShard() {
  const args = parseArgs(process.argv.slice(2));
  const shard = Number(args.shard ?? 0);
  const shardCount = Number(args["shard-count"] ?? 4);
  if (!Number.isInteger(shard) || !Number.isInteger(shardCount) || shard < 0 || shard >= shardCount) {
    throw new RangeError(`expected --shard in [0, ${shardCount - 1}]`);
  }

  const files = await discoverDaemonTestFiles(args["test-directory"] ?? join(packageRoot, "test"));
  const bucket = assignTestShards(files, shardCount)[shard];
  const concurrency = Number(args.concurrency ?? 1);
  console.log(`Daemon shard ${shard + 1}/${shardCount}: ${bucket.files.length} files, weight ${bucket.weight}, concurrency ${concurrency}.`);
  return runDaemonTestFiles(bucket.files, { shard, concurrency });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runShard();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  }
}
