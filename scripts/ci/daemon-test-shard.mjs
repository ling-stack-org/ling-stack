import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../packages/daemon");

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

async function runShard() {
  const args = parseArgs(process.argv.slice(2));
  const shard = Number(args.shard ?? 0);
  const shardCount = Number(args["shard-count"] ?? 4);
  if (!Number.isInteger(shard) || !Number.isInteger(shardCount) || shard < 0 || shard >= shardCount) {
    throw new RangeError(`expected --shard in [0, ${shardCount - 1}]`);
  }

  const files = await discoverDaemonTestFiles(args["test-directory"] ?? join(packageRoot, "test"));
  const bucket = assignTestShards(files, shardCount)[shard];
  console.log(`Daemon shard ${shard + 1}/${shardCount}: ${bucket.files.length} files, weight ${bucket.weight}.`);
  if (bucket.files.length === 0) return 0;

  const isolatedHome = await mkdtemp(join(tmpdir(), `ling-stack-daemon-shard-${shard}-`));
  try {
    const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...bucket.files], {
      cwd: packageRoot,
      env: { ...process.env, LING_STACK_HOME: isolatedHome },
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    await rm(isolatedHome, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runShard();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  }
}
