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
  "source-fetch": ["collect-pinned-source.mjs", 1, 2],
  "shell-parser": ["build-shell-parser.mjs", 1, 2],
  "browser-inputs": ["collect-executable-browser-inputs.mjs", 3, 3],
  "select-executable": ["select-executable-bundle.mjs", 2, 2],
  "reviewed-resource": ["rebuild-reviewed-resource-stage.mjs", 4, 4],
  source: ["build-source-bundle.mjs", 2, 3], native: ["build-native-runtime.mjs", 2, 3],
  resource: ["prepare-platform-resource-stage.mjs", 8, 8],
  "browser-archives": ["collect-browser-archives.mjs", 3, 3],
  "chromium-snapshot": ["collect-chromium-snapshot.mjs", 3, 3],
  "ungoogled-candidate": ["collect-ungoogled-chromium.mjs", 3, 3],
  "testsavant-model": ["collect-testsavant-model.mjs", 0, 0],
  executable: ["assemble-executable-bundle.mjs", 5, 5],
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
  if (!Number.isSafeInteger(child.pid) || child.pid < 1) return;
  if (process.platform === "win32") {
    await new Promise((resolve, reject) => execFile("taskkill.exe", ["/PID", `${child.pid}`, "/T", "/F"],
      { timeout: 5000, maxBuffer: 64 * 1024 }, error => error ? reject(error) : resolve()));
  } else {
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}

function observeGroup(child, spawnError) {
  if (!child || !child.pid && spawnError) return { status: "not_started" };
  if (!Number.isSafeInteger(child.pid) || child.pid < 1) return { status: "unknown", errorCode: "invalid_pid" };
  // taskkill success and direct-child close do not prove a drained Windows tree.
  if (process.platform === "win32") return { status: "unknown", errorCode: "group_observation_unsupported" };
  try { process.kill(-child.pid, 0); return { status: "present" }; }
  catch (error) {
    return error.code === "ESRCH" ? { status: "absent" }
      : { status: "unknown", errorCode: error.code ?? "observation_failed" };
  }
}

function managedOutput(onOutput, onFailure) {
  const pending = new Set();
  let sealed = false;
  const streams = onOutput ? [] : [process.stdout, process.stderr];
  for (const stream of streams) stream.on("error", onFailure);
  const detach = () => { for (const stream of streams) stream.off("error", onFailure); };
  return {
    write(bytes, stream) {
      if (sealed) return;
      let work;
      try {
        work = onOutput ? onOutput(bytes, stream) : new Promise(resolve => {
          process[stream].write(bytes, error => { if (error) onFailure(error); resolve(); });
        });
      } catch (error) { onFailure(error); return; }
      const tracked = Promise.resolve(work).catch(onFailure).finally(() => pending.delete(tracked));
      pending.add(tracked);
    },
    async settle() {
      sealed = true;
      const all = Promise.all([...pending]);
      let timeout;
      const settled = await Promise.race([all.then(() => true), new Promise(resolve => {
        timeout = setTimeout(() => resolve(false), 5000);
      })]);
      clearTimeout(timeout);
      // Writable emits error after invoking the failing write's callback. Keep
      // the listener through that turn; late pending writes must not crash us.
      if (settled) { await new Promise(setImmediate); detach(); }
      else void all.then(() => new Promise(setImmediate)).then(detach);
      return settled ? "settled" : "unverified";
    },
  };
}

// The parent stays asynchronous even when the builder uses execFileSync.
// Checkpoints/watchdog are not an OS-enforced disk quota; admission reserves full copies.
export async function runManagedNode({ root, args, additionalBytes = 6 * 1024 ** 3,
  timeoutMs = 30 * 60_000, maxOutputBytes = 4 * 1024 ** 2,
  onOutput }) {
  // Do not let spawn's (command, options) overload discard our detached/stdio
  // options when an object is accidentally supplied in place of argv.
  if (!Array.isArray(args) || args.some(arg => typeof arg !== "string")) throw new Error("gstack_managed_argv_invalid");
  args = [...args];
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60_000 ||
    !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 4 * 1024 ** 2) throw new Error("gstack_managed_limits_invalid");
  const lease = await acquireResourceLease(root, { additionalBytes });
  const started = Date.now();
  let child, deadline, drainDeadline, monitor, monitorWork = Promise.resolve(), killing;
  let reason = null, outputBytes = 0, signalHandler, outputError, spawnError;
  let terminal, closed = false, policy, primaryError, finalized = false;
  const terminationErrors = [];
  let resolveTerminal;
  const terminalWait = new Promise(resolve => { resolveTerminal = resolve; });
  const fail = code => {
    if (finalized) return;
    reason ??= code;
    // A detached pipe holder can prevent close even after the leader has died.
    // Bound that wait, but never turn its expiry into permission to clean scratch.
    drainDeadline ??= setTimeout(() => resolveTerminal(null), 5500);
    if (!killing && child?.pid && !(closed && observeGroup(child, spawnError).status === "absent")) killing = (async () => {
      try { await stopGroup(child, "SIGTERM"); }
      catch (error) { terminationErrors.push({ signal: "SIGTERM", code: error.code ?? "termination_failed" }); }
      await delay(500);
      if (observeGroup(child, spawnError).status === "absent") return;
      try { await stopGroup(child, "SIGKILL"); }
      catch (error) { terminationErrors.push({ signal: "SIGKILL", code: error.code ?? "termination_failed" }); }
    })();
  };
  const output = managedOutput(onOutput, error => {
    if (finalized) return;
    outputError ??= String(error?.message ?? error).slice(0, 2000);
    fail("output_handler_failed");
  });
  try {
    policy = await policyChecksum();
    const env = { ...lease.env };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    delete env.NODE_TEST_CONTEXT;
    child = spawn(process.execPath, args, { cwd: repository, env, shell: false,
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of ["stdout", "stderr"]) child[stream].on("data", bytes => {
      if (finalized) return;
      outputBytes += bytes.length;
      if (outputBytes > maxOutputBytes) fail("output_budget_exceeded");
      else output.write(bytes, stream);
    });
    child.once("error", error => { spawnError = error.code ?? "unknown"; fail(`spawn_failed:${spawnError}`); });
    child.once("close", (code, signal) => { closed = true; terminal = { code, signal }; resolveTerminal(terminal); });
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
    terminal = await terminalWait;
  } catch (error) {
    primaryError = error;
    fail("supervision_failed");
  } finally {
    clearTimeout(deadline);
    clearInterval(monitor);
    await monitorWork;
    if (child && !closed) { fail("direct_child_not_closed"); terminal ??= await terminalWait; }
    let group = observeGroup(child, spawnError);
    if (group.status === "present") fail("descendant_leak");
    else if (group.status === "unknown") fail("group_observation_failed");
    if (killing) await killing;
    const outputSettlement = await output.settle();
    if (outputSettlement !== "settled") reason ??= "output_sink_unsettled";
    // Sending KILL is an intent, not settlement evidence. ESRCH is the only
    // positive absence observation here; permission/probe failures retain state.
    if (child) {
      const observeUntil = performance.now() + 5000;
      do {
        group = observeGroup(child, spawnError);
        if (["absent", "not_started"].includes(group.status) || performance.now() >= observeUntil) break;
        await delay(50);
      } while (true);
    }
    const releasable = !child || closed && ["absent", "not_started"].includes(group.status);
    if (!releasable) reason ??= "process_settlement_unverified";
    try { if (policy && await policyChecksum() !== policy) reason ??= "resource_policy_changed"; }
    catch (error) { primaryError ??= error; reason ??= "resource_policy_unreadable"; }
    let usage;
    try { usage = await lease.checkpoint(); }
    catch (error) { reason ??= error.message; }
    const result = { exitCode: reason ? 1 : terminal?.code ?? 1, signal: terminal?.signal ?? null, reason,
      elapsedMs: Date.now() - started, outputBytes, usage, policyChecksum: policy,
      commandChecksum: createHash("sha256").update(JSON.stringify(args)).digest("hex"),
      settlement: { scope: process.platform === "win32" ? "windows-tree-unverified" : "posix-process-group-only", directChild: { pid: child?.pid ?? null, closed,
        exitCode: terminal?.code ?? null, signal: terminal?.signal ?? null, spawnError: spawnError ?? null }, processGroup: group },
      terminationErrors, outputSettlement, ...(outputError ? { outputError } : {}),
      leaseDisposition: releasable ? "release_authorized" : "retained",
      ...(!releasable ? { retainedScratchPath: lease.scratchPath } : {}) };
    finalized = true;
    clearTimeout(drainDeadline);
    if (signalHandler) {
      process.off("SIGINT", signalHandler);
      process.off("SIGTERM", signalHandler);
    }
    // Unknown consumers may still hold inherited pipes. Keep draining without
    // invoking the sink, but do not let those handles make this bounded API hang.
    if (!releasable && child) {
      child.unref();
      child.stdout?.unref?.();
      child.stderr?.unref?.();
    }
    // Write while still holding the lease. The persisted receipt authorizes
    // cleanup; only the returned value can attest that release itself completed.
    try { await writeFile(join(root, "last-run.json"), `${JSON.stringify(result, null, 2)}\n`); }
    catch (error) { primaryError = primaryError ? new AggregateError([primaryError, error], "gstack_managed_receipt_failed") : error; }
    if (releasable) {
      try { await lease.release(); }
      catch (error) { primaryError = primaryError ? new AggregateError([primaryError, error], "gstack_managed_release_failed") : error; }
    }
    if (primaryError) throw primaryError;
    return { ...result, leaseDisposition: releasable ? "released" : "retained" };
  }
}

export function finishManagedCli(result) {
  process.stderr.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.exitCode;
  // A downstream pipe may stay open without reading: a pending stdout write
  // can keep this CLI alive even after the API returned. The local receipt is
  // already durable and process cleanup already decided; never wait forever
  // for that failed sink, or apply this process-exit policy to library callers.
  if (result.outputSettlement === "unverified") process.exit(result.exitCode || 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, root, ...args] = process.argv.slice(2);
  if (operation === "init" && root && args.length === 1) {
    process.stdout.write(`${JSON.stringify(await initResourceWorkspace({ root: resolve(root), mountPath: args[0] }), null, 2)}\n`);
  } else if (operation === "init-local" && root && !args.length) {
    process.stdout.write(`${JSON.stringify(await initResourceWorkspace({ root: resolve(root), storageMode: "local-bounded" }), null, 2)}\n`);
  } else if (operation === "inspect" && root && !args.length) {
    process.stdout.write(`${JSON.stringify(await resourceCheckpoint(resolve(root)), null, 2)}\n`);
  } else {
    if (!root) throw new Error("Usage: run-managed.mjs <init|init-local|inspect|source-fetch|source|shell-parser|native|resource|reviewed-resource|test|browser-inputs|browser-archives|chromium-snapshot|ungoogled-candidate|testsavant-model|executable|select-executable> <managed-workspace> <arguments...>");
    const result = await runManagedNode({ root: resolve(root), args: managedNodeArguments(operation, args) });
    finishManagedCli(result);
  }
}
