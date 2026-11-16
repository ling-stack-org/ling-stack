import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { finished } from "node:stream/promises";
import { assignTestShards, assertSuiteCoverage, discoverSuiteFiles, estimateTestWeight, parseArguments, testSuites } from "./test-shard-plan.mjs";
import { trackTestProcesses } from "./test-processes.mjs";

export const defaultFileTimeoutMs = 300_000;
export const defaultShardTimeoutMs = 1_800_000;
// Keep process ownership checks frequent enough for cleanup without flooding
// the hosted runner's process table while several files run in parallel.
const processInspectionIntervalMs = 100;

export async function createTestIsolation(label, temporaryDirectory = tmpdir()) {
  const root = await mkdtemp(join(temporaryDirectory, `ling-stack-test-${label}-`));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  try { await Promise.all([mkdir(home), mkdir(workspace)]); }
  catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  return { root, home, workspace };
}

/** Each file owns an isolated runtime and bounded process cleanup. */
async function runFile(file, { cwd, shard, worker, suite, temporaryDirectory, stdio, signal,
  fileTimeoutMs, terminationGraceMs, reportPath }) {
  const isolation = await createTestIsolation(`${suite}-${shard}-${worker}`, temporaryDirectory);
  const started = performance.now();
  let result;
  let log;
  try {
    if (reportPath) {
      const logPath = join(dirname(reportPath), "logs", `${suite}-${shard}`, `${basename(file)}.log`);
      await mkdir(dirname(logPath), { recursive: true });
      log = createWriteStream(logPath);
      await new Promise((done, reject) => { log.once("open", done); log.once("error", reject); });
    }
    if (signal.aborted) return { file, worker, status: "cancelled", exitCode: null, signal: null,
      durationMs: Math.max(1, performance.now() - started) };
    const token = randomUUID();
    const env = { ...process.env, LING_STACK_HOME: isolation.home, LING_STACK_DEFAULT_WORKSPACE_CWD: isolation.workspace,
      LING_STACK_CI_TEST_OWNER: token };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", file], {
      cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let stopped;
    let escalation;
    let logError;
    let cleanupError;
    const processes = trackTestProcesses(child.pid, token);
    // Capture descendants before a fast coordinator can exit and reparent them.
    try { processes.live(true); }
    catch (error) { cleanupError = error; }
    const terminate = signal => {
      // Observe ancestry before terminating parents that may orphan a child.
      try { processes.signal(signal); }
      catch (error) {
        cleanupError ??= error;
        try { child.kill(signal); } catch (error) { cleanupError ??= error; }
      }
    };
    const stop = reason => {
      stopped ??= reason;
      terminate("SIGTERM");
      escalation ??= setTimeout(() => terminate("SIGKILL"), terminationGraceMs);
    };
    const observe = setInterval(() => {
      try { processes.live(); }
      catch (error) { cleanupError ??= error; stop("cleanup_error"); }
    }, 100);
    const onAbort = () => stop("cancelled");
    const onLogError = error => { logError = error; stop("log_error"); };
    log?.on("error", onLogError);
    for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      if (log) stream.pipe(log, { end: false });
      if (stdio === "inherit") stream.pipe(destination, { end: false });
      if (!log && stdio !== "inherit") stream.resume();
    }
    const exited = new Promise((done, reject) => {
      child.once("error", reject);
      child.once("exit", (code, exitSignal) => done({ code, signal: exitSignal }));
    });
    const closed = new Promise(done => child.once("close", done));
    child.once("exit", () => {
      // The exit event is the last reliable boundary before the coordinator is
      // reaped; take one final ownership snapshot before teardown starts.
      try { processes.live(true); }
      catch (error) { cleanupError ??= error; stop("cleanup_error"); }
    });
    const deadline = setTimeout(() => stop("timed_out"), fileTimeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    let teardownTimer;
    try {
      const exit = await exited;
      clearTimeout(deadline);
      // Even a successful coordinator can leave a grandchild alive. Reap its
      // group before deleting the private workspace or moving to another file.
      if (processes.live(true).length) stop("leaked_processes");
      const teardown = new Promise(done => {
        teardownTimer = setTimeout(() => {
          stop("teardown_timeout");
          terminate("SIGKILL");
          child.stdout.destroy();
          child.stderr.destroy();
          done();
        }, terminationGraceMs + 1000);
      });
      await Promise.race([closed, teardown]);
      if (!(await processes.waitForExit(terminationGraceMs))) {
        terminate("SIGKILL");
        if (!(await processes.waitForExit(1000))) throw new Error("CI-owned test processes survived SIGKILL");
      }
      if (logError) throw logError;
      if (cleanupError) throw cleanupError;
      result = { file, worker, status: stopped ?? (exit.code === 0 ? "passed" : "failed"),
        exitCode: exit.code, signal: exit.signal, fileTimeoutMs, durationMs: Math.max(1, performance.now() - started) };
    } finally {
      clearTimeout(deadline);
      clearTimeout(escalation);
      clearTimeout(teardownTimer);
      clearInterval(observe);
      signal.removeEventListener("abort", onAbort);
      try {
        terminate("SIGKILL");
        if (!(await processes.waitForExit(1000))) throw new Error("CI-owned test processes survived final cleanup");
        if (cleanupError) throw cleanupError;
      } finally { child.stdout.destroy(); child.stderr.destroy(); }
    }
  } finally {
    try {
      if (log) { log.end(); await finished(log); }
    } finally { await rm(isolation.root, { recursive: true, force: true }); }
  }
  return result;
}

/**
 * @param {string[]} files
 * @param {{ concurrency?: number, shard?: number, shardCount?: number, suite?: string,
 * cwd?: string, exclusive?: string[], timings?: Record<string, number>, fileTimeouts?: Record<string, number>,
 * temporaryDirectory?: string, stdio?: string, fileTimeoutMs?: number, shardTimeoutMs?: number,
 * terminationGraceMs?: number, reportPath?: string, signal?: AbortSignal }} [options]
 */
export async function runNodeTestFiles(files, {
  concurrency = 1, shard = 0, shardCount = 1, suite = "tests", cwd = process.cwd(), exclusive = [], timings = {}, fileTimeouts = {}, temporaryDirectory = tmpdir(), stdio = "inherit",
  fileTimeoutMs = defaultFileTimeoutMs, shardTimeoutMs = defaultShardTimeoutMs, terminationGraceMs = 5000,
  reportPath, signal: parentSignal,
} = {}) {
  for (const [name, value] of Object.entries({ concurrency, fileTimeoutMs, shardTimeoutMs, terminationGraceMs })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  }
  for (const [file, timeout] of Object.entries(fileTimeouts)) {
    if (!Number.isSafeInteger(timeout) || timeout < 1) throw new RangeError(`fileTimeouts[${file}] must be a positive integer`);
  }
  if (process.platform === "win32") throw new Error("This CI runner requires POSIX process groups (Linux or macOS)");
  const selected = [...new Set(files)];
  const records = new Map(selected.map(file => [file, { file, status: "pending" }]));
  const controller = new AbortController();
  const relayAbort = () => controller.abort(parentSignal.reason);
  parentSignal?.addEventListener("abort", relayAbort, { once: true });
  if (parentSignal?.aborted) relayAbort();
  const shardDeadline = setTimeout(() => controller.abort(new Error("shard_deadline_exceeded")), shardTimeoutMs);
  let complete = false;
  let writes = Promise.resolve();
  const persist = () => {
    if (!reportPath) return Promise.resolve();
    const snapshot = JSON.stringify({ version: 1, suite, shard, shardCount, platform: process.platform,
      complete, fileTimeoutMs, shardTimeoutMs, results: selected.map(file => records.get(file)) }, null, 2);
    writes = writes.then(async () => {
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(`${reportPath}.tmp`, `${snapshot}\n`);
      await rename(`${reportPath}.tmp`, reportPath);
    });
    return writes;
  };
  const errors = [];
  const worker = async (bucket, index) => {
    for (const file of bucket) {
      if (controller.signal.aborted) break;
      const timeout = fileTimeouts[file] ?? fileTimeoutMs;
      console.log(`[${suite} shard ${shard}, worker ${index}] START ${file} (deadline ${timeout}ms)`);
      records.set(file, { file, worker: index, status: "running" });
      await persist();
      try {
        const result = await runFile(file, { cwd, shard, worker: index, suite, temporaryDirectory, stdio,
          signal: controller.signal, fileTimeoutMs: timeout, terminationGraceMs, reportPath });
        records.set(file, result);
        console.log(`[${suite} shard ${shard}, worker ${index}] END ${file}: ${result.status}, ${(result.durationMs / 1000).toFixed(2)}s`);
      } catch (error) {
        errors.push(error);
        records.set(file, { file, worker: index, status: "error", error: error.message });
        console.error(`[${suite} shard ${shard}, worker ${index}] ERROR ${file}: ${error.message}`);
      }
      await persist();
    }
  };
  try {
    await persist();
    const exclusiveFiles = selected.filter(file => exclusive.includes(file)).sort();
    await worker(exclusiveFiles, "exclusive");
    const parallel = selected.filter(file => !exclusive.includes(file))
      .map(file => ({ file, weight: estimateTestWeight(file, { cwd, timings }) }))
      .sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file));
    // Each idle worker claims one file synchronously from the same iterator.
    const queue = parallel.map(item => item.file).values();
    const outcomes = await Promise.allSettled(Array.from({ length: Math.min(concurrency, parallel.length) },
      (_, index) => worker(queue, index)));
    for (const outcome of outcomes) if (outcome.status === "rejected") errors.push(outcome.reason);
    complete = !controller.signal.aborted && [...records.values()].every(result => result.status !== "pending" && result.status !== "running");
  } finally {
    clearTimeout(shardDeadline);
    parentSignal?.removeEventListener("abort", relayAbort);
    for (const [file, record] of records) {
      if (record.status === "pending" || record.status === "running") records.set(file, { ...record, status: "cancelled" });
    }
    await persist();
  }
  if (errors.length) throw errors[0];
  if (controller.signal.aborted) console.error(`[${suite} shard ${shard}] Cancelled: ${controller.signal.reason}`);
  return complete && [...records.values()].every(result => result.status === "passed") ? 0 : 1;
}

export async function runTestShard(suiteName, argv) {
  const args = parseArguments(argv, ["--shard", "--shard-count", "--concurrency", "--plan", "--report", "--file-timeout-ms", "--shard-timeout-ms"]);
  const config = testSuites[suiteName];
  if (!config) throw new Error(`Unknown suite: ${suiteName}`);
  const shard = Number(args["--shard"] ?? 0);
  const shardCount = Number(args["--shard-count"] ?? config.shardCount);
  const concurrency = Number(args["--concurrency"] ?? config.concurrency);
  if (!Number.isInteger(shard) || !Number.isInteger(shardCount) || shardCount < 1 || shard < 0 || shard >= shardCount) {
    throw new RangeError(`expected --shard in [0, ${shardCount - 1}]`);
  }
  const discovered = await discoverSuiteFiles(config);
  let shards = assignTestShards(discovered, shardCount, { ...config, concurrency });
  let timings = {};
  if (args["--plan"]) {
    const plan = JSON.parse(await readFile(args["--plan"], "utf8"));
    const suite = plan.suites?.[suiteName];
    if (plan.version !== 1 || suite?.shardCount !== shardCount || suite.platform !== process.platform
      || suite.concurrency !== concurrency) throw new Error("Invalid test plan for this suite/platform");
    assertSuiteCoverage(suite, discovered);
    shards = suite.shards;
    timings = suite.timings ?? {};
  }
  const files = shards[shard].files;
  console.log(`${suiteName} shard ${shard + 1}/${shardCount}: ${files.length} files, weight ${shards[shard].weight.toFixed(2)}.`);
  const controller = new AbortController();
  const onInt = () => controller.abort(new Error("SIGINT"));
  const onTerm = () => controller.abort(new Error("SIGTERM"));
  process.once("SIGINT", onInt);
  process.once("SIGTERM", onTerm);
  try {
    return await runNodeTestFiles(files, { ...config, suite: suiteName, shard, shardCount, timings,
      concurrency, reportPath: args["--report"], signal: controller.signal,
      fileTimeoutMs: Number(args["--file-timeout-ms"] ?? defaultFileTimeoutMs),
      shardTimeoutMs: Number(args["--shard-timeout-ms"] ?? defaultShardTimeoutMs) });
  } finally {
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const index = args.findIndex(value => value.startsWith("--suite="));
    if (index < 0) throw new Error("--suite=core or --suite=daemon is required");
    const [suite] = args.splice(index, 1);
    process.exitCode = await runTestShard(suite.slice("--suite=".length), args);
  } catch (error) { console.error(error); process.exitCode = 2; }
}
