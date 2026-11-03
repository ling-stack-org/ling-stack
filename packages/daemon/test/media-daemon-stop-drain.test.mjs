import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

const caseEnv = "LING_A32_DAEMON_STOP_CASE";
for (const scenario of ["cooperative", "non-cooperative"]) {
  if (process.env[caseEnv] && process.env[caseEnv] !== scenario) continue;
  test(`A32 real daemon stop drain: ${scenario}`, { timeout: 24_000 }, t =>
    process.env[caseEnv] ? exerciseCase(t, scenario) : runOwnedChild(scenario));
}

async function runOwnedChild(scenario) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.realpath(await fs.mkdtemp(join(parent, `ling-a32-stop-${scenario}-`)));
  const home = join(root, "home"), cwd = join(root, "workspace"), temporary = join(root, "tmp");
  await Promise.all([fs.mkdir(home), fs.mkdir(cwd), fs.mkdir(temporary)]);
  try {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", fileURLToPath(import.meta.url)], {
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC", HOME: home, USERPROFILE: home,
        LOCALAPPDATA: home, LING_STACK_HOME: join(root, "ling-home"), TMPDIR: temporary,
        LING_STACK_DEFAULT_WORKSPACE_CWD: cwd, [caseEnv]: scenario },
      stdio: ["ignore", "pipe", "pipe"], timeout: 19_000,
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
    });
    process.stdout.write(stdout); process.stderr.write(stderr);
    console.log(`A32 stop child actual exit: ${JSON.stringify({ scenario, ...exit })}`);
    assert.ok(stdout.includes(`A32 stop entered: ${scenario}`));
    assert.ok(stdout.includes("A32 stop observation:"), "the actual stop chain must reach its observation barrier");
    assert.equal(exit.signal, null, "killing a fixture cannot be evidence of product physical stop");
    assert.equal(exit.code, 0, "nonzero remains RED even when fixture EOF later permits cleanup");
  } finally {
    assert.ok(root.startsWith(`${parent}/ling-a32-stop-${scenario}-`));
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** Real constructor, original registry, native sender/body and two independent SQLite connections. */
async function exerciseCase(t, scenario) {
  const cwd = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD;
  assert.ok(cwd && cwd !== process.cwd());
  assert.equal(process.env.HOME, process.env.USERPROFILE);
  assert.deepEqual(Object.keys(process.env).filter(key => /API_?KEY|TOKEN|SECRET|BASE_URL/iu.test(key)), []);
  console.log(`A32 stop entered: ${scenario}`);
  const calls = { externalProcess: 0, runner: 0, listen: 0, sends: 0, nativeSettled: 0,
    nativeRejected: 0, bodySettled: 0, wireAborts: 0, providerAborts: 0, admissions: 0 };
  const entered = deferred(), upstreamClosed = deferred(), sockets = new Set();
  let response, trickle, ended = false, closed = false, daemon, registry, store, ownerProbe;
  let execution, tick, firstStop, firstStopFinished = false, stopSucceeded = false;
  let wireSignal, providerSignal;
  const closeObservations = [], releaseObservations = [], admissionClosures = [];
  const admissionCodes = [];
  const server = createServer((request, outgoing) => {
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/api/v3/contents/generations/tasks/a32-stop-task");
    calls.sends++; response = outgoing;
    outgoing.setHeader("content-type", "application/json");
    outgoing.write('{"id":"a32-stop-task","status":');
    trickle = setInterval(() => { if (!outgoing.destroyed) outgoing.write(" "); }, 15);
    outgoing.once("close", () => { clearInterval(trickle); closed = true; upstreamClosed.resolve(); });
    entered.resolve();
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port, baseUrl = `http://127.0.0.1:${port}/api/v3`;
  const actualFetch = globalThis.fetch;
  // The capture is installed before the transport module captures fetch. It
  // forwards the same original Request and returns the original native Promise.
  globalThis.fetch = (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    assert.equal(new URL(request.url).origin, `http://127.0.0.1:${port}`);
    wireSignal = request.signal;
    request.signal.addEventListener("abort", () => { calls.wireAborts++; }, { once: true });
    return actualFetch(input, init);
  };
  const tcp = process.binding("tcp_wrap").TCP.prototype;
  const originalConnect = tcp.connect;
  const tcpPatch = t.mock.method(tcp, "connect", function (request, address, targetPort) {
    assert.equal(address, "127.0.0.1"); assert.equal(targetPort, port, "only this owned loopback listener is allowed");
    return Reflect.apply(originalConnect, this, [request, address, targetPort]);
  });
  const tcp6Patch = t.mock.method(tcp, "connect6", () => { assert.fail("A32 stop forbids IPv6 outbound connections"); });
  const childPatches = ["exec", "execFile", "spawn", "execSync", "execFileSync", "spawnSync"].map(name =>
    t.mock.method(childProcess, name, () => { calls.externalProcess++; throw new Error("a32_stop_external_process_forbidden"); }));
  syncBuiltinESMExports();
  const originalListen = server.constructor.prototype.listen;
  const listenPatch = t.mock.method(server.constructor.prototype, "listen", () => {
    calls.listen++; throw new Error("a32_stop_daemon_must_not_start");
  });
  const observers = [];
  const observe = (prototype, method, hook) => {
    const original = prototype[method];
    observers.push(t.mock.method(prototype, method, function (...args) {
      hook.call(this, args);
      return Reflect.apply(original, this, args);
    }));
  };
  const snapshot = () => registry.mediaLocalExecutions.getSnapshot();
  const local = () => snapshot().executions.find(item => item.generation === execution?.generation);
  const readStopFacts = () => ({ nativeSettled: calls.nativeSettled, bodySettled: calls.bodySettled,
    aborted: execution ? registry.mediaLocalExecutions.getAbortSignal(execution).aborted : undefined,
    pending: registry ? snapshot().pendingReservations : undefined,
    phase: registry ? local()?.phase : undefined, active: registry ? local()?.active : undefined,
    ownerBusy: ownerProbe ? ownerIsBusy(ownerProbe) : undefined });
  const mark = (label, outcome) => console.log(`A32 stop observation: ${JSON.stringify({ scenario, label,
    outcome: outcome?.kind, code: outcome?.error?.code, closed, ended, ...calls,
    pending: registry ? snapshot().pendingReservations : undefined,
    phase: execution ? local()?.phase : undefined, active: execution ? local()?.active : undefined,
    closeCalls: closeObservations.length, releaseCalls: releaseObservations.length })}`);
  const endFixture = () => { if (response && !response.destroyed && !ended) { ended = true; response.end('"running"}'); } };
  try {
    const core = await import("../../core/dist/index.js");
    const { RunStoreRegistry } = await import("../dist/runtime/store-registry.js");
    const { RuntimeSupervisor } = await import("../dist/runtime/supervisor.js");
    const { ActiveRunRegistry } = await import("../dist/runtime/active-runs.js");
    observe(ActiveRunRegistry.prototype, "stopAdmission", function () { admissionClosures.push(this); });
    const originalGet = RunStoreRegistry.prototype.getStore;
    observers.push(t.mock.method(RunStoreRegistry.prototype, "getStore", function (...args) {
      const value = Reflect.apply(originalGet, this, args);
      if (args[0] === cwd) { registry = this; store = value; }
      return value;
    }));
    observe(core.SqliteRunStore.prototype, "close", function () {
      if (this.paths.cwd === cwd) closeObservations.push(readStopFacts());
    });
    observe(RuntimeSupervisor.prototype, "releaseAll", () => { releaseObservations.push(readStopFacts()); });
    const { pollSeedanceVideoTask } = await import("../../providers/dist/vendors/seedance.js");
    const { createGuardedMediaHttpTransport } = await import("../dist/features/media/guarded-native-transport.js");
    const { createDaemonServer } = await import("../dist/index.js");
    const emptySecrets = { status: ref => ({ ref, kind: "local", configured: false }),
      resolve: ref => ({ ref, configured: false }),
      setSecret() { assert.fail("no Keychain or credential mutation is authorized"); },
      deleteSecret() { assert.fail("no Keychain or credential mutation is authorized"); } };
    daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
      channels: { autoRoute: false, intentSelector: false, terminalReports: false, teamObserverBus: false },
      cuaDriver: { bundledEmbedded: { darwin: false, win32: false }, packagedProvider: { darwin: false, win32: false } },
    }, { secretResolver: emptySecrets, externalSecretStore: emptySecrets, chromeBrowserNativeMessagingEnabled: false,
      runner: { async runTask() { calls.runner++; throw new Error("a32_stop_runner_forbidden"); } } });
    assert.ok(registry && store, "capture the production registry opened by real daemon construction");
    assert.equal(daemon.server.listening, false);
    const sentinel = store.createChannel({ name: "A32 owned stop sentinel", boundPath: cwd }, new Date().toISOString());
    ownerProbe = new DatabaseSync(join(store.paths.rootDir, "runtime.lock.coordination.sqlite"));
    ownerProbe.exec("PRAGMA busy_timeout=0");
    assert.equal(ownerIsBusy(ownerProbe), true, "a second real SQLite writer must be refused while original owner lives");
    const source = { runId: "a32-stop-run", workUnitId: "a32-stop-parent", attemptId: "a32-stop-attempt",
      runtimeInstanceId: "a32-stop-runtime", fencingToken: "a32-stop-fence" };
    const ticket = registry.mediaLocalExecutions.reserve({ source, requestDigest: "a32-stop-digest", toolCallId: "a32-stop-tool" });
    execution = registry.mediaLocalExecutions.bindNew(ticket, { cwd, mediaJobId: "a32-stop-job" });
    tick = registry.mediaLocalExecutions.runTick({ cwd, mediaJobId: "a32-stop-job", execution }, async handle => {
      const native = createGuardedMediaHttpTransport({ registry: registry.mediaLocalExecutions, execution: handle,
        captureAdmissionFailure: error => { calls.admissions++; admissionCodes.push(error.code); } });
      return pollSeedanceVideoTask({ adapterKind: "seedance", externalOperationId: "a32-stop-task",
        recovery: { statusEndpoint: `${baseUrl}/contents/generations/tasks/a32-stop-task` } },
      { baseUrl, apiKeyConfigured: false, timeoutMs: 30_000, httpClient: async (url, init) => {
        providerSignal = init.signal;
        init.signal?.addEventListener("abort", () => { calls.providerAborts++; }, { once: true });
        if (scenario === "non-cooperative") {
          // Injection-only sender really reads a native HTTP body while ignoring
          // every supplied signal. No fake Response, idle hook or timed promise.
          const originalResponse = await actualFetch(url, { ...init, signal: undefined });
          const readJson = originalResponse.json.bind(originalResponse);
          originalResponse.json = async () => { try { return await readJson(); } finally { calls.bodySettled++; } };
          return originalResponse;
        }
        try { return await native.fetch(url, init); }
        catch (error) { calls.nativeRejected++; throw error; }
        finally { calls.nativeSettled++; }
      } });
    });
    await entered.promise;
    assert.equal(snapshot().pendingReservations, 1); assert.equal(local().active, 1);
    const abortObserved = deferred();
    registry.mediaLocalExecutions.getAbortSignal(execution).addEventListener("abort", () => {
      abortObserved.resolve({ ...readStopFacts(), closeCalls: closeObservations.length, releaseCalls: releaseObservations.length,
        mediaAdmissionClosed: snapshot().shutdown, activeRunAdmissionClosures: admissionClosures.length,
        activeRunAdmissionClosed: admissionClosures[0]?.isShuttingDown() });
    }, { once: true });
    const startedAt = performance.now();
    firstStop = daemon.stop();
    firstStop.then(() => { firstStopFinished = true; stopSucceeded = true; }, () => { firstStopFinished = true; });
    assert.equal(snapshot().shutdown, true);
    assert.equal(admissionClosures.length, 1, "the real Daemon must synchronously close its original ActiveRuns admission");
    assert.equal(admissionClosures[0].isShuttingDown(), true);
    assert.equal(local().active, 1, "same-stack stop request is not physical sender/body settlement");
    assert.equal(calls.nativeSettled, 0); assert.equal(calls.bodySettled, 0);
    assert.equal(closeObservations.length, 0); assert.equal(releaseObservations.length, 0);
    assert.throws(() => registry.mediaLocalExecutions.getOrStart({ cwd, mediaJobId: "new-after-stop" }),
      error => error.code === "shutdown");
    const abort = await observeWithin(abortObserved.promise, 500);
    assert.equal(abort.kind, "fulfilled", "the real abort phase must signal the original sender after admission closes");
    assert.equal(abort.value.aborted, true);
    assert.equal(abort.value.mediaAdmissionClosed, true, "media admission must already be closed at the actual abort event");
    assert.equal(abort.value.activeRunAdmissionClosures, 1);
    assert.equal(abort.value.activeRunAdmissionClosed, true, "original Run admission must already be closed at the actual abort event");
    assert.equal(abort.value.active, 1, "abort notification is not physical sender/body settlement");
    assert.equal(abort.value.nativeSettled, 0); assert.equal(abort.value.bodySettled, 0);
    assert.equal(abort.value.closeCalls, 0); assert.equal(abort.value.releaseCalls, 0);
    if (scenario === "cooperative") {
      const outcome = await observeWithin(firstStop, 2_000); mark("cooperative-stop", outcome);
      assert.equal(outcome.kind, "fulfilled", "real local abort must permit full daemon stop before the Provider deadline");
      assert.equal((await tick).status, "failed");
      assert.equal(calls.nativeSettled, 1); assert.equal(calls.nativeRejected, 1);
      assert.equal(wireSignal.aborted, true); assert.equal(calls.wireAborts, 1);
      assert.equal(providerSignal.aborted, false); assert.equal(calls.providerAborts, 0);
      assert.equal((await observeWithin(upstreamClosed.promise, 500)).kind, "fulfilled");
      assert.equal(ended, false, "fixture EOF must not be responsible for the successful product stop");
    } else {
      const outcome = await observeWithin(firstStop, 6_500), elapsed = performance.now() - startedAt;
      mark("non-cooperative-stop-default-deadline", outcome);
      assert.equal(outcome.kind, "rejected", "production stop must reject within its default finite drain budget");
      assert.equal(outcome.error.code, "media_local_drain_timeout");
      assert.equal(outcome.error.message.includes(cwd), false, "structured shutdown errors must not expose workspace paths");
      assert.ok(elapsed >= 4_500 && elapsed < 6_500, `exercise the actual default 5-second deadline, not a replaced idle hook: ${elapsed}`);
      assert.equal(Object.getPrototypeOf(outcome.error.details), Object.prototype);
      const counts = Object.values(outcome.error.details);
      assert.ok(counts.length > 0 && counts.every(value => Number.isSafeInteger(value) && value >= 0));
      assert.ok(counts.some(value => value > 0), "safe diagnostics must retain an outstanding count");
      assert.equal(JSON.stringify(outcome.error.details).includes(cwd), false);
      assert.equal(local().active, 1); assert.equal(local().phase, "active");
      assert.equal(snapshot().pendingReservations, 1);
      assert.equal(calls.bodySettled, 0); assert.equal(closed, false);
      assert.equal((await observeWithin(tick, 40)).kind, "unsettled");
      assert.equal(closeObservations.length, 0); assert.equal(releaseObservations.length, 0);
      assert.equal(store.getChannel(sentinel.id)?.id, sentinel.id, "timeout must leave real Store reads available");
      assert.equal(registry.getInitializedStore(cwd), store);
      assert.equal(ownerIsBusy(ownerProbe), true, "timeout must retain the exact original owner's real SQLite transaction");
      assert.throws(() => registry.mediaLocalExecutions.getOrStart({ cwd, mediaJobId: "new-after-timeout" }),
        error => error.code === "shutdown");
      endFixture();
      const settled = await observeWithin(tick, 1_000);
      assert.equal(settled.kind, "fulfilled"); assert.equal(calls.bodySettled, 1);
      assert.equal(settled.value.terminalObservation, undefined, "EOF running status is not remote terminal/cancel evidence");
      await execution.completion;
      const retry = await observeWithin(daemon.stop(), 2_000); mark("retry-after-real-EOF", retry);
      assert.equal(retry.kind, "fulfilled", "the same daemon can finish its original stop after actual tails settle");
      stopSucceeded = true;
    }
    assert.equal(snapshot().pendingReservations, 0); assert.equal(local().phase, "completed");
    assert.equal(closeObservations.length, 1); assert.equal(releaseObservations.length, 1);
    for (const observation of [...closeObservations, ...releaseObservations]) {
      assert.equal(observation.aborted, true); assert.equal(observation.pending, 0);
      assert.equal(observation.phase, "completed"); assert.equal(observation.active, 0);
      assert.equal(scenario === "cooperative" ? observation.nativeSettled : observation.bodySettled, 1);
    }
    assert.equal(releaseObservations[0].ownerBusy, true, "original owner is held up to the real release boundary");
    assert.equal(closeObservations[0].ownerBusy, false, "Store closes only after actual runtime owner release");
    assert.equal(ownerIsBusy(ownerProbe), false);
    assert.throws(() => store.getChannel(sentinel.id), "the real Store must actually close after drain");
    assert.equal(calls.sends, 1); assert.equal(calls.runner, 0); assert.equal(calls.externalProcess, 0);
    assert.equal(calls.listen, 0); assert.equal(calls.admissions, scenario === "cooperative" ? 1 : 0);
    assert.deepEqual(admissionCodes, scenario === "cooperative" ? ["media_local_aborted"] : []);
  } finally {
    // Only owned fixture cleanup. It cannot turn an earlier assertion into GREEN.
    endFixture();
    if (tick) await observeWithin(tick, 700);
    if (firstStop && !firstStopFinished) await observeWithin(firstStop, 700);
    if (daemon && !stopSucceeded) await observeWithin(daemon.stop(), 1_000);
    clearInterval(trickle);
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    ownerProbe?.close();
    for (const observer of observers.reverse()) observer.mock.restore();
    globalThis.fetch = actualFetch;
    tcpPatch.mock.restore(); tcp6Patch.mock.restore(); listenPatch.mock.restore();
    assert.equal(server.constructor.prototype.listen, originalListen);
    for (const patch of childPatches) patch.mock.restore();
    syncBuiltinESMExports();
  }
}

/** A different connection tests the real writer lease; successful probes roll back immediately. */
function ownerIsBusy(connection) {
  try { connection.exec("BEGIN IMMEDIATE"); }
  catch (error) {
    assert.equal(typeof error.errcode, "number");
    assert.equal(error.errcode & 0xff, 5, "only actual SQLITE_BUSY proves competing owner retention");
    return true;
  }
  connection.exec("ROLLBACK"); return false;
}

async function observeWithin(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([Promise.resolve(promise).then(value => ({ kind: "fulfilled", value }), error => ({ kind: "rejected", error })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ kind: "unsettled" }), milliseconds); })]);
  } finally { clearTimeout(timer); }
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
