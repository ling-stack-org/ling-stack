import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const caseEnv = "LING_A32_POLL_CASE";
const scenarios = ["trickle-deadline", "shutdown-drain", "cancel-drain", "complete-status"];
for (const scenario of scenarios) {
  if (!process.env[caseEnv] || process.env[caseEnv] === scenario) {
    test(`A32 owned Seedance poll operation: ${scenario}`, { timeout: 12_000 }, t =>
      process.env[caseEnv] ? exerciseCase(t, scenario) : runOwnedChild(scenario));
  }
}

async function runOwnedChild(scenario) {
  const root = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), `ling-a32-poll-${scenario}-`)));
  const home = join(root, "home"), cwd = join(root, "workspace");
  await fs.mkdir(home); await fs.mkdir(cwd);
  try {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", fileURLToPath(import.meta.url)], {
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC", LING_STACK_HOME: home,
        LING_STACK_DEFAULT_WORKSPACE_CWD: cwd, [caseEnv]: scenario },
      stdio: ["ignore", "pipe", "pipe"], timeout: 8_000,
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", value => { stdout += value; });
    child.stderr.on("data", value => { stderr += value; });
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    process.stdout.write(stdout); process.stderr.write(stderr);
    console.log(`A32 child actual exit: ${JSON.stringify({ scenario, ...exit })}`);
    assert.ok(stdout.includes(`A32 entered: ${scenario}`), "the child must enter its owned real-transport fixture");
    assert.ok(stdout.includes("A32 actual poll observation:"), "setup failures are not a deadline regression");
    assert.equal(exit.signal, null, "a killed or timed-out child is never successful physical cancellation");
    assert.equal(exit.code, 0, "the original transport/body must settle and prove all lifecycle assertions; nonzero is RED");
  } finally {
    assert.ok(root.startsWith(`${await fs.realpath(os.tmpdir())}/ling-a32-poll-${scenario}-`));
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** Real native fetch and body consumption; the fixture never returns a synthetic Response. */
async function exerciseCase(t, scenario) {
  const cwd = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD;
  assert.ok(cwd && cwd !== process.cwd());
  assert.deepEqual(Object.keys(process.env).filter(key => /API_?KEY|TOKEN|SECRET|BASE_URL/iu.test(key)), []);
  console.log(`A32 entered: ${scenario}`);
  const requests = [], sockets = new Set(), intervals = new Set();
  let bytesSent = 0, bodyClosed = false, bodyEnded = false, completeMode = "pending";
  const bodyStarted = deferred(), bodyClose = deferred();
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    assert.equal(request.method, "GET", "this fixture never submits, cancels or collects a remote operation");
    assert.equal(request.url, "/api/v3/contents/generations/tasks/a32-owned-task");
    response.setHeader("content-type", "application/json");
    response.on("close", () => { bodyClosed = true; bodyClose.resolve(); });
    if (scenario === "complete-status") {
      bodyEnded = true;
      response.end(JSON.stringify({ id: "a32-owned-task", status: completeMode === "pending" ? "running" : "succeeded",
        ...(completeMode === "terminal" ? { content: { video_url: "https://example.invalid/a32-no-download.mp4" } } : {}) }));
      bodyStarted.resolve();
      return;
    }
    // Valid incomplete JSON, then low-volume whitespace forever: headers and
    // bytes continue arriving, but no EOF or byte cap can end this operation.
    const prefix = '{"id":"a32-owned-task","status":';
    response.write(prefix); bytesSent += Buffer.byteLength(prefix);
    bodyStarted.resolve();
    const interval = setInterval(() => {
      if (!response.destroyed) { response.write(" "); bytesSent++; }
    }, 10);
    intervals.add(interval);
    response.once("close", () => { clearInterval(interval); intervals.delete(interval); });
  });
  server.on("connection", socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  // Keep the real native TCP sender, while failing any accidental non-owned
  // outbound connection before the OS socket connect is attempted.
  const tcp = process.binding("tcp_wrap").TCP.prototype;
  const actualConnect = tcp.connect, actualConnect6 = tcp.connect6;
  const tcpPatch = t.mock.method(tcp, "connect", function (request, address, targetPort) {
    assert.equal(address, "127.0.0.1", "A32 forbids non-owned network addresses");
    assert.equal(targetPort, port, "A32 forbids non-owned network ports");
    return Reflect.apply(actualConnect, this, [request, address, targetPort]);
  });
  const tcp6Patch = t.mock.method(tcp, "connect6", function (_request, address, targetPort) {
    assert.fail(`A32 forbids all IPv6 connections: ${address}:${targetPort}`);
  });
  let registry, native, execution, tick, nativeSettled = 0, nativeRejected = 0, nativeResponses = 0;
  let pollCalls = 0, abortEvents = 0, signal, admissionFailures = 0, uncaught = 0;
  const admissionCodes = [];
  const onUncaught = error => {
    uncaught++;
    console.error(`A32 uncaught monitor: ${error?.name}:${error?.code ?? "unknown"}`);
  };
  process.on("uncaughtExceptionMonitor", onUncaught);
  try {
    const { pollSeedanceVideoTask } = await import("../../providers/dist/vendors/seedance.js");
    const { createGuardedMediaHttpTransport } = await import("../dist/features/media/guarded-native-transport.js");
    const { MediaLocalExecutionRegistry } = await import("../dist/runtime/media-local-executions.js");
    registry = new MediaLocalExecutionRegistry();
    const baseUrl = `http://127.0.0.1:${port}/api/v3`;
    const handle = { adapterKind: "seedance", externalOperationId: "a32-owned-task",
      recovery: { statusEndpoint: `${baseUrl}/contents/generations/tasks/a32-owned-task` } };
    const invoke = () => registry.runTick({ cwd, mediaJobId: "a32-owned-job" }, async local => {
      execution = local;
      native = createGuardedMediaHttpTransport({ registry, execution: local,
        captureAdmissionFailure: error => { admissionFailures++; admissionCodes.push(error.code); } });
      return pollSeedanceVideoTask(handle, { baseUrl, apiKeyConfigured: false, timeoutMs: 240,
        // No actual credential or user secret is passed; a status GET to an
        // isolated loopback fixture needs no authentication.
        httpClient: async (url, init) => {
          pollCalls++;
          signal = init.signal;
          signal?.addEventListener("abort", () => { abortEvents++; }, { once: true });
          try { const response = await native.fetch(url, init); nativeResponses++; return response; }
          catch (error) { nativeRejected++; throw error; }
          finally { nativeSettled++; }
        } });
    });
    tick = invoke();
    await bodyStarted.promise;
    if (scenario === "complete-status") {
      const pending = await observeWithin(tick, 1_000);
      console.log(`A32 actual poll observation: ${JSON.stringify({ scenario, pending: pending.kind, nativeSettled, nativeResponses })}`);
      assert.equal(pending.kind, "fulfilled");
      assert.equal(pending.value.status, "pending");
      await registry.waitForIdle(500);
      completeMode = "terminal";
      const terminal = await invoke();
      assert.equal(terminal.status, "succeeded");
      assert.equal(terminal.terminalObservation?.outcome, "completed");
      assert.equal(terminal.terminalObservation?.externalOperationId, "a32-owned-task");
      assert.equal(terminal.recovery?.videoUrl, "https://example.invalid/a32-no-download.mp4");
      await registry.waitForIdle(500);
      assert.equal(nativeSettled, 2); assert.equal(nativeResponses, 2); assert.equal(nativeRejected, 0);
      assert.equal(pollCalls, 2); assert.equal(requests.length, 2); assert.equal(abortEvents, 0);
      assert.equal(bodyEnded, true);
      return;
    }
    // Observe admission/drain behavior while the actual GET/body is still open.
    if (scenario === "shutdown-drain") {
      registry.beginShutdown();
      assert.equal(registry.getSnapshot().shutdown, true);
      assert.throws(() => registry.getOrStart({ cwd, mediaJobId: "no-new-generation" }), error => error.code === "shutdown");
    } else if (scenario === "cancel-drain") {
      assert.equal(registry.cancelJob({ cwd, mediaJobId: "a32-owned-job", execution }), true);
    }
    if (scenario !== "trickle-deadline") {
      // Local stop now aborts the entered sender promptly. Before microtasks
      // settle it must still retain the real tail; an uncooperative sender's
      // bounded-drain rejection is covered by media-local-abort-lifecycle.
      const active = registry.getSnapshot().executions.find(value => value.generation === execution.generation);
      assert.equal(active?.phase, "active"); assert.equal(active?.active, 1); assert.equal(active?.scheduled, false);
      assert.equal(nativeSettled, 0); assert.equal(bodyClosed, false);
      assert.throws(() => registry.schedule(execution, 0, () => { assert.fail("no future poll may enter after stop"); }),
        error => scenario === "shutdown-drain" ? error.code === "shutdown" : error.code === "media_job_cancelled");
      for (const mode of ["forward", "observation"]) assert.throws(() => registry.launchEffect(execution, mode,
        () => { assert.fail("no later forward/poll send may launch after local stop"); }));
    }
    const outcome = await observeWithin(tick, 1_200);
    console.log(`A32 actual poll observation: ${JSON.stringify({ scenario, outcome: outcome.kind,
      status: outcome.value?.status, errorCode: outcome.value?.errorCode, nativeSettled, nativeRejected,
      nativeResponses, signalPresent: signal instanceof AbortSignal, aborted: signal?.aborted,
      abortEvents, bodyClosed, bodyEnded, bytesSent, requests: requests.length, admissionFailures })}`);
    assert.equal(outcome.kind, "fulfilled", "the original poll promise must settle; a timer winning a race is not physical stop");
    assert.equal(outcome.value.status, "failed");
    const locallyStopped = scenario !== "trickle-deadline";
    assert.equal(outcome.value.errorCode, locallyStopped ? "network_error" : "timeout");
    assert.equal(outcome.value.terminalObservation, undefined, "local timeout is not remote terminal/cancel evidence");
    assert.equal(signal instanceof AbortSignal, true, "the provider must pass a real operation signal to the actual sender");
    assert.equal(signal.aborted, !locallyStopped, "local lifecycle abort must not impersonate the Provider timer");
    assert.equal(abortEvents, locallyStopped ? 0 : 1);
    assert.equal(nativeSettled, 1, "the original native fetch/body promise must already have settled");
    assert.equal(nativeRejected, 1); assert.equal(nativeResponses, 0, "an incomplete body cannot mint a completed native exchange");
    const closed = await observeWithin(bodyClose.promise, 300);
    assert.equal(closed.kind, "fulfilled", "the actual upstream response must close due to abort, before fixture cleanup");
    assert.equal(bodyClosed, true); assert.equal(bodyEnded, false);
    assert.ok((locallyStopped ? bytesSent >= 32 : bytesSent > 32) && bytesSent < 1_024,
      "local stop may precede the first trickle; real deadline trickle stays far below the native response byte cap");
    assert.equal(pollCalls, 1); assert.equal(requests.length, 1);
    await registry.waitForIdle(300);
    assert.equal(registry.getSnapshot().executions.find(value => value.generation === execution.generation)?.phase, "completed");
    assert.equal(uncaught, 0); assert.equal(admissionFailures, locallyStopped ? 1 : 0);
    assert.deepEqual(admissionCodes, locallyStopped ? ["media_local_aborted"] : []);
    assert.throws(() => native.readExchange(new Response("incomplete")), /unissued_response/u);
  } finally {
    for (const interval of intervals) clearInterval(interval);
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (tick) await observeWithin(tick, 500); // observe original cleanup, never turn it into a passing test
    registry?.beginShutdown();
    process.removeListener("uncaughtExceptionMonitor", onUncaught);
    tcpPatch.mock.restore(); tcp6Patch.mock.restore();
    assert.equal(tcp.connect, actualConnect); assert.equal(tcp.connect6, actualConnect6);
  }
}

/** A finite test observation only; success always requires the original promise's settlement facts. */
async function observeWithin(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([Promise.resolve(promise).then(value => ({ kind: "fulfilled", value }), error => ({ kind: "rejected", error })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ kind: "unsettled" }), milliseconds); })]);
  } finally { clearTimeout(timer); }
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
