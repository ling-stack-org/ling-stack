import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { acquireResourceLease, initResourceWorkspace, resourceCheckpoint, within } from "./resource-workspace.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
const repository = resolve(scripts, "../..");
const policyFiles = ["resource-workspace.mjs", "run-managed.mjs", "managed-integration-guard.mjs"];
const policyChecksum = async () => createHash("sha256").update(Buffer.concat(await Promise.all(
  policyFiles.map(path => readFile(join(scripts, path)))))).digest("hex");
const operations = {
  source: ["build-source-bundle.mjs", 2, 3], native: ["build-native-runtime.mjs", 2, 3],
  resource: ["prepare-platform-resource-stage.mjs", 8, 8],
  "browser-archives": ["collect-browser-archives.mjs", 3, 3],
  "chromium-snapshot": ["collect-chromium-snapshot.mjs", 3, 3],
  "ungoogled-candidate": ["collect-ungoogled-chromium.mjs", 3, 3],
  "testsavant-model": ["collect-testsavant-model.mjs", 0, 0],
  executable: ["assemble-executable-bundle.mjs", 3, 3],
};

export function managedNodeArguments(operation, args) {
  if (operation === "test") {
    if (!args.length) throw new Error("gstack_managed_test_paths_required");
    const files = args.map(path => {
      const full = resolve(repository, path);
      if (path.startsWith("-") || !within(scripts, full) || !full.endsWith(".test.mjs")) throw new Error("gstack_managed_test_path_invalid");
      return full;
    });
    return ["--test", "--test-concurrency=1", ...files];
  }
  const entry = operations[operation];
  if (!entry) throw new Error("gstack_managed_operation_invalid");
  if (args.length < entry[1] || args.length > entry[2] || args.some(arg => arg.startsWith("-"))) throw new Error("gstack_managed_arguments_invalid");
  return [join(scripts, entry[0]), ...args];
}

async function stopGroup(child, signal) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await new Promise(resolve => execFile("taskkill.exe", ["/PID", `${child.pid}`, "/T", "/F"], () => resolve()));
  } else {
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}

// The parent stays asynchronous even when the builder uses execFileSync.
// Checkpoints/watchdog are not an OS-enforced disk quota; admission reserves full copies.
export async function runManagedNode({ root, args, additionalBytes = 6 * 1024 ** 3,
  timeoutMs = 30 * 60_000, maxOutputBytes = 4 * 1024 ** 2,
  onOutput = (bytes, stream) => process[stream].write(bytes) }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60_000 ||
    !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 4 * 1024 ** 2) throw new Error("gstack_managed_limits_invalid");
  const lease = await acquireResourceLease(root, { additionalBytes });
  const started = Date.now();
  let child, deadline, monitor, monitorWork = Promise.resolve(), killing;
  let reason = null, outputBytes = 0, signalHandler;
  let result;
  const fail = code => {
    reason ??= code;
    if (!killing && child) killing = (async () => {
      await stopGroup(child, "SIGTERM");
      await delay(500);
      await stopGroup(child, "SIGKILL");
    })();
  };
  try {
    const policy = await policyChecksum();
    const env = { ...lease.env };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    delete env.NODE_TEST_CONTEXT;
    child = spawn(process.execPath, args, { cwd: repository, env, shell: false,
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of ["stdout", "stderr"]) child[stream].on("data", bytes => {
      outputBytes += bytes.length;
      if (outputBytes > maxOutputBytes) fail("output_budget_exceeded");
      else onOutput(bytes, stream);
    });
    deadline = setTimeout(() => fail("deadline_exceeded"), timeoutMs);
    let checking = false;
    monitor = setInterval(() => {
      if (checking) return;
      checking = true;
      monitorWork = lease.checkpoint().catch(error => fail(error.message)).finally(() => { checking = false; });
    }, 5000);
    signalHandler = () => fail("cancelled");
    process.on("SIGINT", signalHandler);
    process.on("SIGTERM", signalHandler);
    const terminal = await new Promise(resolve => {
      child.once("error", error => { fail(`spawn_failed:${error.code}`); });
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(deadline);
    clearInterval(monitor);
    await monitorWork;
    if (process.platform !== "win32") {
      try { process.kill(-child.pid, 0); fail("descendant_leak"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    if (killing) await killing;
    if (await policyChecksum() !== policy) reason ??= "resource_policy_changed";
    let usage;
    try { usage = await lease.checkpoint(); }
    catch (error) { reason ??= error.message; }
    result = { exitCode: reason ? 1 : terminal.code ?? 1, signal: terminal.signal, reason,
      elapsedMs: Date.now() - started, outputBytes, usage, policyChecksum: policy,
      commandChecksum: createHash("sha256").update(JSON.stringify(args)).digest("hex") };
    await writeFile(join(root, "last-run.json"), `${JSON.stringify(result, null, 2)}\n`);
  } finally {
    clearTimeout(deadline);
    clearInterval(monitor);
    if (signalHandler) {
      process.off("SIGINT", signalHandler);
      process.off("SIGTERM", signalHandler);
    }
    await monitorWork;
    if (killing) await killing;
    await lease.release();
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, root, ...args] = process.argv.slice(2);
  if (operation === "init" && root && args.length === 1) {
    process.stdout.write(`${JSON.stringify(await initResourceWorkspace({ root: resolve(root), mountPath: args[0] }), null, 2)}\n`);
  } else if (operation === "inspect" && root && !args.length) {
    process.stdout.write(`${JSON.stringify(await resourceCheckpoint(resolve(root)), null, 2)}\n`);
  } else {
    if (!root) throw new Error("Usage: run-managed.mjs <init|inspect|source|native|resource|test|browser-archives|chromium-snapshot|ungoogled-candidate|testsavant-model> <external-workspace> <arguments...>");
    const result = await runManagedNode({ root: resolve(root), args: managedNodeArguments(operation, args) });
    process.stderr.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.exitCode;
  }
}
