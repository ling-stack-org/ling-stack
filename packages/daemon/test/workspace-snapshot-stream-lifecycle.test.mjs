import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import nativeFs from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const caseEnv = "LING_A29_STREAM_CASE";
const originalScenarios = ["capture-open", "capture-write-true", "restore-open", "restore-write-true"];
const edgeKinds = ["source-read", "backpressure", "final", "close", "collision", "cleanup"];
const scenarios = [...originalScenarios,
  ...["capture", "restore"].flatMap(producer => edgeKinds.map(kind => `${producer}-${kind}`)),
  ...["capture", "restore"].flatMap(producer => ["multichunk", "empty"].map(kind => `${producer}-success-${kind}`))];
for (const scenario of scenarios) {
  if (!process.env[caseEnv] || process.env[caseEnv] === scenario) {
    test(`A29 owned snapshot stream lifecycle: ${scenario}`, { timeout: 20_000 }, t =>
      process.env[caseEnv]
        ? scenario.includes("-success-") ? exerciseSuccessCase(t, scenario) : exerciseCase(t, scenario)
        : runOwnedChild(scenario));
  }
}

async function runOwnedChild(scenario) {
  const root = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), `ling-a29-stream-${scenario}-`)));
  const home = join(root, "home"), cwd = join(root, "workspace");
  await fs.mkdir(home); await fs.mkdir(cwd);
  try {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", fileURLToPath(import.meta.url)], {
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC", LING_STACK_HOME: home,
        LING_STACK_DEFAULT_WORKSPACE_CWD: cwd, [caseEnv]: scenario },
      stdio: ["ignore", "pipe", "pipe"], timeout: 15_000,
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", value => { stdout += value; });
    child.stderr.on("data", value => { stderr += value; });
    const exit = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => done({ code, signal }));
    });
    process.stdout.write(stdout); process.stderr.write(stderr);
    console.log(`A29 stream child actual exit: ${JSON.stringify({ scenario, ...exit })}`);
    assert.ok(stdout.includes(`A29 stream case entered: ${scenario}`), "the owned production fixture must actually enter");
    assert.ok(stdout.includes(scenario.includes("-success-") ? "A29 exact stream success:"
      : originalScenarios.includes(scenario) ? "A29 exact output fault:" : "A29 exact stream fault:"),
    "a setup failure must not masquerade as the stream regression");
    assert.equal(exit.signal, null, "a killed or timed-out child is not successful error handling");
    assert.equal(exit.code, 0, "the child must survive and prove its operation plus durable lifecycle facts; nonzero is RED");
  } finally {
    assert.ok(root.startsWith(`${await fs.realpath(os.tmpdir())}/ling-a29-stream-${scenario}-`));
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** Exercise real capture/restore producers and WriteStream callbacks inside one disposable child. */
async function exerciseCase(t, scenario) {
  const cwd = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD, home = process.env.LING_STACK_HOME;
  assert.ok(cwd && home && cwd !== process.cwd());
  assert.deepEqual(Object.keys(process.env).filter(key => /API_?KEY|TOKEN|SECRET|BASE_URL/iu.test(key)), []);
  console.log(`A29 stream case entered: ${scenario}`);
  const victim = join(cwd, "project.txt"), baselineBody = Buffer.from("baseline snapshot bytes\n");
  const currentBody = Buffer.from("current preimage bytes that must remain unchanged after a stream failure\n");
  const baselineSha = sha256(baselineBody), currentSha = sha256(currentBody);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("A29 snapshot stream fixture forbids network access"); };
  const homePatch = t.mock.method(os, "homedir", () => home);
  syncBuiltinESMExports();
  const kind = scenario.slice(scenario.indexOf("-") + 1);
  const isOriginal = originalScenarios.includes(scenario);
  let store, reopened, hooks, uncaught = 0;
  const onUncaught = error => {
    uncaught++;
    // Monitoring does not consume the exception or turn a crashed child into a passing case.
    console.error(`A29 uncaught stream exception: ${JSON.stringify({ code: error?.code, message: error?.message })}`);
  };
  process.on("uncaughtExceptionMonitor", onUncaught);
  try {
    const core = await import("../../core/dist/index.js");
    const restore = await import("../dist/features/runs/workspace-snapshot-restore.js");
    store = core.createSqliteRunStore(cwd);
    await fs.writeFile(victim, baselineBody, { mode: 0o600 });
    const baseline = await restore.captureWorkspaceSnapshot(store, cwd);
    const entry = baseline.entries.find(value => value.relativePath === "project.txt");
    assert.ok(entry?.managed);
    assert.equal(entry.sha256, baselineSha);
    assert.equal(entry.blobSha256, baselineSha);
    assert.equal(entry.sizeBytes, baselineBody.byteLength);
    assert.deepEqual(await fs.readFile(join(store.paths.snapshotBlobsDir, baselineSha)), baselineBody);
    assert.deepEqual(await fs.readdir(store.paths.snapshotStagingDir), []);
    assert.equal(store.getWorkspaceSnapshotFence(baseline.manifest.workspaceId).ownerRequestId, undefined);
    await fs.writeFile(victim, currentBody);
    await fs.chmod(victim, 0o640);
    const before = { body: await fs.readFile(victim), mode: (await fs.lstat(victim)).mode & 0o777 };
    const manifestIds = store.listWorkspaceSnapshotManifests({ workspaceId: baseline.manifest.workspaceId }).map(value => value.id);
    let restoreInput;
    if (scenario.startsWith("restore-")) {
      const anchor = await restore.createWorkspaceSnapshotUserRestoreAnchor(store, cwd, baseline.manifest.id);
      const now = new Date().toISOString();
      const confirmation = store.createSnapshotRestoreConfirmation({ workspaceId: baseline.manifest.workspaceId,
        anchorId: anchor.id, snapshotId: baseline.manifest.id, createdAt: now });
      assert.equal(store.resolveSnapshotRestoreConfirmation(confirmation.id, "confirmed", now)?.state, "confirmed");
      restoreInput = { idempotencyKey: `a29-${scenario}`, anchorId: anchor.id,
        snapshotId: baseline.manifest.id, confirmationId: confirmation.id };
    }
    const sentinelName = "unrelated-staging-sentinel";
    if (!isOriginal) await fs.writeFile(join(store.paths.snapshotStagingDir, sentinelName), "not owned by this hash operation\n", { flag: "wx" });
    hooks = isOriginal
      ? installStreamFault(t, { victim, stagingDir: store.paths.snapshotStagingDir, kind })
      : installStreamEdgeFault(t, { victim, stagingDir: store.paths.snapshotStagingDir, kind });
    syncBuiltinESMExports();
    const operation = restoreInput
      ? restore.restoreWorkspaceSnapshot(store, cwd, restoreInput)
      : restore.captureWorkspaceSnapshot(store, cwd);
    const outcome = await boundedOutcome(operation, 5_000);
    const facts = hooks.facts();
    console.log(`A29 operation observation: ${JSON.stringify({ scenario, outcome: outcome.kind,
      errorCode: outcome.error?.code, errorMessage: outcome.error?.message, uncaught, ...facts })}`);
    assert.equal(facts.faultCalls, 1, "the selected stream callback boundary must actually be reached exactly once");
    if (isOriginal) {
      assert.equal(facts.inputHeldAtFault, true, "the output error must occur while production awaits the selected input read");
    }
    if (scenario.endsWith("-write-true")) {
      assert.equal(facts.firstWriteReturnedTrue, true, "the decisive error must not be protected by once(drain)");
      assert.equal(facts.realPartialBytesWritten, 1, "the fixture must leave a genuine partial staging file before the error");
    }
    assert.equal(outcome.kind, "rejected", "hashing must reject, not hang or resolve a staged digest");
    if (kind === "cleanup") {
      const errors = hooks.errors();
      assert.ok(outcome.error instanceof AggregateError, "failed cleanup must preserve both errors, not replace the stream error");
      assert.deepEqual(outcome.error.errors, [errors.streamError, errors.cleanupError]);
      assert.equal(outcome.error.errors[0], errors.streamError);
      assert.equal(outcome.error.errors[1], errors.cleanupError);
      assert.equal(outcome.error.cause, errors.streamError);
      assert.equal(errors.streamError?.code, "ENOSPC");
      assert.equal(errors.cleanupError?.code, "EACCES");
      assert.equal(facts.cleanupCalls, 1);
      assert.equal(facts.ownedOpenSucceeded, true, "rm denial must target a file actually created by this hash operation");
      assertSafeCleanupMessage(outcome.error.message, errors);
    } else {
      assert.equal(outcome.error?.code, kind === "open" ? "EACCES" : kind === "collision" ? "EEXIST"
        : ["write-true", "backpressure"].includes(kind) ? "ENOSPC" : "EIO");
      if (kind === "collision") assert.match(outcome.error.message, /EEXIST/u);
      else assert.match(outcome.error.message, /A29 injected (?:output|source)/u);
    }
    if (kind === "source-read") {
      assert.ok(facts.sourceBytesRead > 0, "the read fault must follow real source bytes");
      assert.ok(facts.realOutputBytesWritten > 0, "the source failure must leave actual staging bytes to clean");
    }
    if (["backpressure", "cleanup"].includes(kind)) {
      assert.equal(facts.firstWriteReturnedFalse, true, "the selected failure must cross actual Writable backpressure");
      assert.equal(facts.realOutputBytesWritten, 1);
    }
    if (kind === "final") assert.equal(facts.finalCalled, true, "the error must happen in Writable finalization after input EOF");
    if (["final", "close"].includes(kind)) assert.equal(facts.inputEndedAtFault, true);
    if (kind === "close") {
      assert.equal(facts.outputFinishedAtFault, true, "this fault must occur after finish, not during an earlier write");
      assert.equal(facts.realOutputFdClosed, true, "the fixture must actually close the OS fd before reporting EIO");
    }
    assert.equal(uncaught, 0, "an EventEmitter error outside the awaited operation is a product failure");
    assert.equal(facts.inputClosed, true, "rejection must await the input lifecycle, not leave an open reader");
    assert.equal(facts.outputClosed, true, "rejection must await the output lifecycle before returning");
    const remainingStaging = await fs.readdir(store.paths.snapshotStagingDir);
    assert.deepEqual(remainingStaging.sort(), isOriginal ? []
      : [sentinelName, ...(kind === "collision" ? [facts.collisionName] : []),
        ...(kind === "cleanup" ? [facts.ownedTemporaryName] : [])].sort(),
    "only successfully removed owned staging may disappear; collisions and failed cleanup must remain visible");
    if (!isOriginal) assert.equal(await fs.readFile(join(store.paths.snapshotStagingDir, sentinelName), "utf8"), "not owned by this hash operation\n");
    if (kind === "collision") assert.equal(await fs.readFile(join(store.paths.snapshotStagingDir, facts.collisionName), "utf8"), "pre-existing staging collision bytes\n");
    if (kind === "cleanup") {
      assert.deepEqual(await fs.readFile(join(store.paths.snapshotStagingDir, facts.ownedTemporaryName)), currentBody.subarray(0, 1),
        "a denied cleanup must leave the genuine one-byte partial file, not claim clean staging");
    }
    assert.equal(store.getWorkspaceSnapshotBlob(currentSha), undefined, "a failed preimage cannot publish blob success");
    assert.deepEqual(store.listWorkspaceSnapshotManifests({ workspaceId: baseline.manifest.workspaceId }).map(value => value.id), manifestIds);
    assert.deepEqual({ body: await fs.readFile(victim), mode: (await fs.lstat(victim)).mode & 0o777 }, before);
    const fence = store.getWorkspaceSnapshotFence(baseline.manifest.workspaceId);
    assert.equal(fence.ownerRequestId, undefined);
    let request;
    if (restoreInput) {
      request = store.getSnapshotRestoreRequestByIdempotency(baseline.manifest.workspaceId, restoreInput.idempotencyKey);
      assert.ok(request, "the fault must be after durable restore admission, while staging the rollback preimage");
      assert.equal(request.state, "failed", "no workspace effects have started at this boundary");
      assert.ok(request.fencingEpoch > 0, "the real restore fence must have been acquired");
      if (kind === "cleanup") assertSafeCleanupMessage(request.lastError ?? "", hooks.errors());
      else assert.match(request.lastError ?? "", kind === "collision" ? /EEXIST/u : /A29 injected (?:output|source)/u);
      assert.deepEqual(store.listSnapshotRestoreJournalEntries({ restoreRequestId: request.id }), []);
    } else {
      assert.deepEqual(store.listSnapshotRestoreRequests({ workspaceId: baseline.manifest.workspaceId }), []);
    }
    store.close(); store = undefined;
    reopened = core.createSqliteRunStore(cwd);
    assert.equal(reopened.getWorkspaceSnapshotFence(baseline.manifest.workspaceId).ownerRequestId, undefined);
    assert.equal(reopened.getWorkspaceSnapshotBlob(currentSha), undefined);
    assert.equal(reopened.getWorkspaceSnapshotManifest(baseline.manifest.id)?.state, "committed");
    if (request) {
      assert.deepEqual(reopened.getSnapshotRestoreRequest(request.id), request);
      assert.deepEqual(reopened.listSnapshotRestoreJournalEntries({ restoreRequestId: request.id }), []);
    }
  } finally {
    await hooks?.dispose();
    for (const candidate of [reopened, store]) if (candidate?.database.isOpen) candidate.close();
    homePatch.mock.restore();
    syncBuiltinESMExports();
    globalThis.fetch = originalFetch;
    process.removeListener("uncaughtExceptionMonitor", onUncaught);
  }
}

/** Keep native stream behavior; only owned fs callbacks and one source read are controlled. */
function installStreamFault(t, { victim, stagingDir, kind }) {
  const actual = { createReadStream: nativeFs.createReadStream, createWriteStream: nativeFs.createWriteStream,
    open: nativeFs.open, read: nativeFs.read, write: nativeFs.write, close: nativeFs.close };
  const inputs = [], outputs = [], patches = [];
  let latestInput, selectedInput, selectedOutput, pendingRead, pendingOpen, pendingWrite;
  let reads = 0, faultCalls = 0, realPartialBytesWritten = 0, inputHeldAtFault = false;
  let firstWriteReturnedTrue;
  const releaseRead = () => { const release = pendingRead; pendingRead = undefined; release?.(); };
  const maybeInject = () => {
    if (faultCalls || !pendingRead || !selectedOutput) return;
    if (kind === "open" && !pendingOpen) return;
    if (kind === "write-true" && (!pendingWrite || firstWriteReturnedTrue !== true || realPartialBytesWritten !== 1)) return;
    faultCalls++;
    inputHeldAtFault = true;
    console.log(`A29 exact output fault: ${JSON.stringify({ kind, faultCalls, inputHeldAtFault,
      firstWriteReturnedTrue, realPartialBytesWritten, errorListeners: selectedOutput.listenerCount("error") })}`);
    const callback = kind === "open" ? pendingOpen : pendingWrite;
    pendingOpen = undefined; pendingWrite = undefined;
    callback(Object.assign(new Error(`A29 injected output ${kind} failure`), { code: kind === "open" ? "EACCES" : "ENOSPC" }));
    // A real pending read must settle even when pipeline destruction is waiting for its callback.
    setImmediate(releaseRead);
  };
  patches.push(t.mock.method(nativeFs, "createReadStream", function (path, options) {
    if (path !== victim || faultCalls) return Reflect.apply(actual.createReadStream, this, [path, options]);
    let input;
    const streamFs = { open: actual.open, close: actual.close, read(...args) {
      const nativeRead = () => Reflect.apply(actual.read, nativeFs, args);
      if (input !== selectedInput || faultCalls) { nativeRead(); return; }
      reads++;
      if (kind === "write-true" && reads === 1) {
        // Yield one small chunk so production output.write returns true, then hold the next read.
        args[3] = Math.min(args[3], 8);
        nativeRead();
        return;
      }
      pendingRead = nativeRead;
      maybeInject();
    } };
    input = Reflect.apply(actual.createReadStream, this, [path, { ...options, fs: streamFs }]);
    inputs.push(input); latestInput = input;
    return input;
  }));
  patches.push(t.mock.method(nativeFs, "createWriteStream", function (path, options) {
    if (typeof path !== "string" || !path.startsWith(`${stagingDir}/blob-`) || faultCalls) {
      return Reflect.apply(actual.createWriteStream, this, [path, options]);
    }
    assert.equal(options?.flags, "wx");
    assert.ok(latestInput && !latestInput.destroyed, "pair the staging output with its actual current source input");
    selectedInput = latestInput;
    const streamFs = { close: actual.close, open(...args) {
      if (kind !== "open") { Reflect.apply(actual.open, nativeFs, args); return; }
      pendingOpen = args.at(-1);
      maybeInject();
    }, write(...args) {
      assert.equal(kind, "write-true");
      const callback = args.at(-1);
      // Perform a real partial filesystem write, then return an asynchronous ENOSPC.
      const partialArgs = [...args];
      partialArgs[3] = 1;
      partialArgs[partialArgs.length - 1] = (error, written) => {
        if (error) { callback(error); return; }
        realPartialBytesWritten += written;
        pendingWrite = callback;
        maybeInject();
      };
      Reflect.apply(actual.write, nativeFs, partialArgs);
    } };
    const output = Reflect.apply(actual.createWriteStream, this, [path, { ...options, fs: streamFs }]);
    outputs.push(output); selectedOutput = output;
    if (kind === "write-true") {
      const write = output.write;
      patches.push(t.mock.method(output, "write", function (...args) {
        const accepted = Reflect.apply(write, this, args);
        firstWriteReturnedTrue ??= accepted;
        maybeInject();
        return accepted;
      }));
    }
    return output;
  }));
  return {
    facts: () => ({ faultCalls, inputHeldAtFault, firstWriteReturnedTrue, realPartialBytesWritten,
      inputClosed: selectedInput?.closed === true, outputClosed: selectedOutput?.closed === true }),
    async dispose() {
      releaseRead();
      if (pendingOpen) { pendingOpen(Object.assign(new Error("A29 fixture cleanup open"), { code: "EIO" })); pendingOpen = undefined; }
      if (pendingWrite) { pendingWrite(Object.assign(new Error("A29 fixture cleanup write"), { code: "EIO" })); pendingWrite = undefined; }
      await Promise.all([...inputs, ...outputs].map(async stream => {
        const settled = finished(stream, { cleanup: true }).catch(() => undefined);
        stream.destroy();
        await settled;
      }));
      for (const patch of patches.reverse()) patch.mock.restore();
    },
  };
}

/** Reach errors through real stream/fs callbacks, preserving ownership and backpressure. */
function installStreamEdgeFault(t, { victim, stagingDir, kind }) {
  const actual = { createReadStream: nativeFs.createReadStream, createWriteStream: nativeFs.createWriteStream,
    open: nativeFs.open, read: nativeFs.read, write: nativeFs.write, close: nativeFs.close, rm: fs.rm };
  const inputs = [], outputs = [], patches = [];
  let latestInput, selectedInput, selectedOutput, pendingReadFailure, pendingWriteFailure;
  let reads = 0, faultCalls = 0, sourceBytesRead = 0, realOutputBytesWritten = 0;
  let firstWriteReturnedFalse, finalCalled = false, inputEndedAtFault = false;
  let outputFinishedAtFault = false, realOutputFdClosed = false, collisionName;
  let ownedTemporaryName, ownedOpenSucceeded = false, cleanupCalls = 0, streamError, cleanupError;
  const usesBackpressure = ["backpressure", "cleanup"].includes(kind);
  const fault = () => streamError ??= Object.assign(new Error(kind === "cleanup"
    ? `A29 private stream message at ${victim}`
    : `A29 injected ${kind === "source-read" ? "source" : "output"} ${kind} failure`),
  { code: usesBackpressure ? "ENOSPC" : "EIO" });
  const recordFault = () => {
    faultCalls++;
    inputEndedAtFault = selectedInput?.readableEnded === true;
    outputFinishedAtFault = selectedOutput?.writableFinished === true;
    console.log(`A29 exact stream fault: ${JSON.stringify({ kind, faultCalls, sourceBytesRead,
      realOutputBytesWritten, firstWriteReturnedFalse, inputEndedAtFault, outputFinishedAtFault,
      realOutputFdClosed, collisionName })}`);
  };
  const maybeInject = () => {
    if (faultCalls) return;
    if (kind === "source-read" && pendingReadFailure && realOutputBytesWritten > 0) {
      const callback = pendingReadFailure; pendingReadFailure = undefined;
      recordFault();
      setImmediate(() => callback(fault()));
    }
    if (usesBackpressure && pendingWriteFailure && firstWriteReturnedFalse === true) {
      const callback = pendingWriteFailure; pendingWriteFailure = undefined;
      recordFault();
      setImmediate(() => callback(fault()));
    }
  };
  patches.push(t.mock.method(nativeFs, "createReadStream", function (path, options) {
    if (path !== victim || faultCalls) return Reflect.apply(actual.createReadStream, this, [path, options]);
    let input;
    const streamFs = { open: actual.open, close: actual.close, read(...args) {
      if (input !== selectedInput || faultCalls) { Reflect.apply(actual.read, nativeFs, args); return; }
      reads++;
      const callback = args.at(-1);
      if (kind === "source-read" && reads === 2) {
        pendingReadFailure = callback;
        maybeInject();
        return;
      }
      args[3] = Math.min(args[3], 8);
      args[args.length - 1] = (error, bytesRead, buffer) => {
        if (!error) sourceBytesRead += bytesRead;
        callback(error, bytesRead, buffer);
      };
      Reflect.apply(actual.read, nativeFs, args);
    } };
    input = Reflect.apply(actual.createReadStream, this, [path, { ...options, fs: streamFs }]);
    inputs.push(input); latestInput = input;
    return input;
  }));
  patches.push(t.mock.method(nativeFs, "createWriteStream", function (path, options) {
    if (typeof path !== "string" || !path.startsWith(`${stagingDir}/blob-`) || selectedOutput) {
      return Reflect.apply(actual.createWriteStream, this, [path, options]);
    }
    assert.equal(options?.flags, "wx");
    assert.ok(latestInput && !latestInput.destroyed);
    selectedInput = latestInput;
    ownedTemporaryName = path.slice(stagingDir.length + 1);
    if (kind === "collision") {
      collisionName = path.slice(stagingDir.length + 1);
      nativeFs.writeFileSync(path, "pre-existing staging collision bytes\n", { flag: "wx", mode: 0o600 });
    }
    const streamFs = { open(...args) {
      const callback = args.at(-1);
      args[args.length - 1] = (error, fd) => {
        if (!error) ownedOpenSucceeded = true;
        if (kind === "collision") {
          assert.equal(error?.code, "EEXIST", "the product's real wx open must detect the pre-existing file");
          recordFault();
        }
        callback(error, fd);
      };
      Reflect.apply(actual.open, nativeFs, args);
    }, write(...args) {
      const callback = args.at(-1);
      if (usesBackpressure && !faultCalls) args[3] = 1;
      args[args.length - 1] = (error, written, buffer) => {
        if (error) { callback(error); return; }
        realOutputBytesWritten += written;
        if (usesBackpressure && !faultCalls) {
          pendingWriteFailure = callback;
          maybeInject();
          return;
        }
        callback(null, written, buffer);
        maybeInject();
      };
      Reflect.apply(actual.write, nativeFs, args);
    }, close(...args) {
      const callback = args.at(-1);
      args[args.length - 1] = error => {
        if (!error) realOutputFdClosed = true;
        if (!error && kind === "close" && !faultCalls) {
          recordFault();
          setImmediate(() => callback(fault()));
          return;
        }
        callback(error);
      };
      Reflect.apply(actual.close, nativeFs, args);
    } };
    const output = Reflect.apply(actual.createWriteStream, this,
      [path, { ...options, ...(usesBackpressure ? { highWaterMark: 1 } : {}), fs: streamFs }]);
    outputs.push(output); selectedOutput = output;
    if (usesBackpressure) {
      const write = output.write;
      patches.push(t.mock.method(output, "write", function (...args) {
        const accepted = Reflect.apply(write, this, args);
        firstWriteReturnedFalse ??= !accepted;
        maybeInject();
        return accepted;
      }));
    }
    if (kind === "final") {
      const originalFinal = output._final;
      output._final = function (callback) {
        finalCalled = true;
        const finish = error => {
          if (error) { callback(error); return; }
          recordFault();
          setImmediate(() => callback(fault()));
        };
        if (originalFinal) Reflect.apply(originalFinal, this, [finish]);
        else finish();
      };
    }
    return output;
  }));
  if (kind === "cleanup") {
    patches.push(t.mock.method(fs, "rm", async function (path, options) {
      if (path !== join(stagingDir, ownedTemporaryName ?? "") || !ownedOpenSucceeded || !faultCalls) {
        return Reflect.apply(actual.rm, this, [path, options]);
      }
      cleanupCalls++;
      assert.equal(selectedInput.closed, true, "cleanup must wait until the real input has closed");
      assert.equal(selectedOutput.closed, true, "cleanup must wait until the real output has closed");
      cleanupError = Object.assign(new Error(`A29 private cleanup message at ${path}`), { code: "EACCES" });
      throw cleanupError;
    }));
  }
  return {
    facts: () => ({ faultCalls, sourceBytesRead, realOutputBytesWritten, firstWriteReturnedFalse,
      finalCalled, inputEndedAtFault, outputFinishedAtFault, realOutputFdClosed, collisionName,
      ownedTemporaryName, ownedOpenSucceeded, cleanupCalls,
      inputClosed: selectedInput?.closed === true, outputClosed: selectedOutput?.closed === true }),
    errors: () => ({ streamError, cleanupError }),
    async dispose() {
      if (pendingReadFailure) { const callback = pendingReadFailure; pendingReadFailure = undefined; callback(fault()); }
      if (pendingWriteFailure) { const callback = pendingWriteFailure; pendingWriteFailure = undefined; callback(fault()); }
      await Promise.all([...inputs, ...outputs].map(async stream => {
        const settled = finished(stream, { cleanup: true }).catch(() => undefined);
        stream.destroy();
        await settled;
      }));
      for (const patch of patches.reverse()) patch.mock.restore();
    },
  };
}

/** Public routes and durable restore records retain only message, so it must carry safe error roles/codes. */
function assertSafeCleanupMessage(message, { streamError, cleanupError }) {
  assert.match(message, /stream/iu);
  assert.match(message, /cleanup|staging/iu);
  assert.match(message, /ENOSPC/u);
  assert.match(message, /EACCES/u);
  assert.ok(!message.includes(streamError.message), "public/durable diagnostics must not copy arbitrary source error text or paths");
  assert.ok(!message.includes(cleanupError.message), "public/durable diagnostics must not copy arbitrary cleanup error text or paths");
  assert.ok(!message.includes("A29 private"));
  assert.ok(!message.includes("ling-a29-stream-"));
}

/** Positive controls cover stream boundaries and the rollback-preimage producer, not a private helper. */
async function exerciseSuccessCase(t, scenario) {
  const cwd = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD, home = process.env.LING_STACK_HOME;
  assert.ok(cwd && home && cwd !== process.cwd());
  assert.deepEqual(Object.keys(process.env).filter(key => /API_?KEY|TOKEN|SECRET|BASE_URL/iu.test(key)), []);
  console.log(`A29 stream case entered: ${scenario}`);
  const victim = join(cwd, "project.txt"), baselineBody = Buffer.from("baseline target for stream success\n");
  const body = scenario.endsWith("-empty") ? Buffer.alloc(0) : Buffer.alloc(256 * 1024 + 23);
  if (body.length) for (let index = 0; index < body.length; index++) body[index] = index % 251;
  const digest = sha256(body), baselineSha = sha256(baselineBody);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("A29 snapshot stream fixture forbids network access"); };
  const homePatch = t.mock.method(os, "homedir", () => home);
  syncBuiltinESMExports();
  let store, reopened, observations;
  try {
    const core = await import("../../core/dist/index.js");
    const restore = await import("../dist/features/runs/workspace-snapshot-restore.js");
    store = core.createSqliteRunStore(cwd);
    await fs.writeFile(victim, baselineBody, { mode: 0o600 });
    const baseline = await restore.captureWorkspaceSnapshot(store, cwd);
    await fs.writeFile(victim, body);
    await fs.chmod(victim, 0o640);
    let restoreInput;
    if (scenario.startsWith("restore-")) {
      const anchor = await restore.createWorkspaceSnapshotUserRestoreAnchor(store, cwd, baseline.manifest.id);
      const now = new Date().toISOString();
      const confirmation = store.createSnapshotRestoreConfirmation({ workspaceId: baseline.manifest.workspaceId,
        anchorId: anchor.id, snapshotId: baseline.manifest.id, createdAt: now });
      assert.equal(store.resolveSnapshotRestoreConfirmation(confirmation.id, "confirmed", now)?.state, "confirmed");
      restoreInput = { idempotencyKey: `a29-${scenario}`, anchorId: anchor.id,
        snapshotId: baseline.manifest.id, confirmationId: confirmation.id };
    }
    const sentinel = join(store.paths.snapshotStagingDir, "unrelated-success-sentinel");
    await fs.writeFile(sentinel, "success must not remove unrelated staging\n", { flag: "wx" });
    observations = observeSuccessfulStreams(t, { victim, stagingDir: store.paths.snapshotStagingDir });
    syncBuiltinESMExports();
    const outcome = await boundedOutcome(restoreInput
      ? restore.restoreWorkspaceSnapshot(store, cwd, restoreInput)
      : restore.captureWorkspaceSnapshot(store, cwd), 5_000);
    assert.equal(outcome.kind, "fulfilled", outcome.error?.stack ?? "successful streams must settle without a timeout");
    const facts = observations.facts();
    assert.equal(facts.staged.length, 1, "the actual capture/preimage must traverse the staging stream");
    const staged = facts.staged[0];
    assert.equal(staged.bytesRead, body.byteLength);
    assert.ok(staged.readCalls > 0, "even empty files must observe their real EOF");
    if (body.byteLength) assert.ok(staged.readChunks > 1, "the positive control must actually hash more than one native input chunk");
    else assert.equal(staged.readChunks, 0, "an empty-file digest must not depend on a data chunk");
    assert.equal(staged.inputClosed, true);
    assert.equal(staged.outputFinished, true);
    assert.equal(staged.outputClosed, true);
    assert.deepEqual(await fs.readdir(store.paths.snapshotStagingDir), ["unrelated-success-sentinel"]);
    assert.equal(await fs.readFile(sentinel, "utf8"), "success must not remove unrelated staging\n");
    assert.deepEqual(await fs.readFile(join(store.paths.snapshotBlobsDir, digest)), body);
    assert.equal(store.getWorkspaceSnapshotBlob(digest)?.sizeBytes, body.byteLength);
    let request;
    if (restoreInput) {
      request = outcome.value;
      assert.equal(request.state, "committed");
      const journal = store.listSnapshotRestoreJournalEntries({ restoreRequestId: request.id });
      assert.equal(journal.length, 1);
      assert.equal(journal[0].rollbackBlobSha256, digest);
      assert.equal(journal[0].targetBlobSha256, baselineSha);
      assert.equal(journal[0].state, "applied");
      assert.deepEqual(await fs.readFile(victim), baselineBody);
      assert.equal((await fs.lstat(victim)).mode & 0o777, 0o600);
    } else {
      const entry = outcome.value.entries.find(value => value.relativePath === "project.txt");
      assert.equal(entry?.sha256, digest);
      assert.equal(entry?.blobSha256, digest);
      assert.equal(entry?.sizeBytes, body.byteLength);
      assert.equal(outcome.value.manifest.managedBytes, body.byteLength);
      assert.deepEqual(await fs.readFile(victim), body);
      assert.equal((await fs.lstat(victim)).mode & 0o777, 0o640);
    }
    assert.equal(store.getWorkspaceSnapshotFence(baseline.manifest.workspaceId).ownerRequestId, undefined);
    store.close(); store = undefined;
    reopened = core.createSqliteRunStore(cwd);
    assert.equal(reopened.getWorkspaceSnapshotBlob(digest)?.sizeBytes, body.byteLength);
    assert.equal(reopened.getWorkspaceSnapshotFence(baseline.manifest.workspaceId).ownerRequestId, undefined);
    if (request) assert.deepEqual(reopened.getSnapshotRestoreRequest(request.id), request);
    console.log(`A29 exact stream success: ${JSON.stringify({ scenario, sha256: digest, sizeBytes: body.byteLength, ...facts })}`);
  } finally {
    await observations?.dispose();
    for (const candidate of [reopened, store]) if (candidate?.database.isOpen) candidate.close();
    homePatch.mock.restore();
    syncBuiltinESMExports();
    globalThis.fetch = originalFetch;
  }
}

function observeSuccessfulStreams(t, { victim, stagingDir }) {
  const actual = { createReadStream: nativeFs.createReadStream, createWriteStream: nativeFs.createWriteStream,
    open: nativeFs.open, read: nativeFs.read, close: nativeFs.close };
  const records = [], outputs = [], patches = [];
  let latest;
  patches.push(t.mock.method(nativeFs, "createReadStream", function (path, options) {
    if (path !== victim) return Reflect.apply(actual.createReadStream, this, [path, options]);
    const record = { readCalls: 0, readChunks: 0, bytesRead: 0, staged: false };
    const streamFs = { open: actual.open, close: actual.close, read(...args) {
      record.readCalls++;
      const callback = args.at(-1);
      args[args.length - 1] = (error, bytesRead, buffer) => {
        if (!error) { record.bytesRead += bytesRead; if (bytesRead > 0) record.readChunks++; }
        callback(error, bytesRead, buffer);
      };
      Reflect.apply(actual.read, nativeFs, args);
    } };
    record.input = Reflect.apply(actual.createReadStream, this, [path, { ...options, highWaterMark: 4096, fs: streamFs }]);
    records.push(record); latest = record;
    return record.input;
  }));
  patches.push(t.mock.method(nativeFs, "createWriteStream", function (path, options) {
    const output = Reflect.apply(actual.createWriteStream, this, [path, options]);
    if (typeof path === "string" && path.startsWith(`${stagingDir}/blob-`)) {
      assert.ok(latest);
      assert.equal(options?.flags, "wx");
      latest.staged = true; latest.output = output;
      outputs.push(output);
    }
    return output;
  }));
  return {
    facts: () => ({ staged: records.filter(record => record.staged).map(record => ({ readCalls: record.readCalls,
      readChunks: record.readChunks, bytesRead: record.bytesRead, inputClosed: record.input.closed === true,
      outputFinished: record.output.writableFinished === true, outputClosed: record.output.closed === true })) }),
    async dispose() {
      await Promise.all([...records.map(record => record.input), ...outputs].map(async stream => {
        const settled = finished(stream, { cleanup: true }).catch(() => undefined);
        stream.destroy();
        await settled;
      }));
      for (const patch of patches.reverse()) patch.mock.restore();
    },
  };
}

async function boundedOutcome(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      operation.then(value => ({ kind: "fulfilled", value }), error => ({ kind: "rejected", error })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ kind: "unsettled" }), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
