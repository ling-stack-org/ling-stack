import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const caseEnv = "LING_A32_LOCAL_ABORT_CASE";
const scenarios = ["cancel-job", "shutdown", "source-obsolete", "two-job-isolation", "stale-generation", "non-cooperative"];
for (const scenario of scenarios) if (!process.env[caseEnv] || process.env[caseEnv] === scenario) {
  test(`A32 owned local abort lifecycle: ${scenario}`, { timeout: 12_000 }, t =>
    process.env[caseEnv] ? exerciseCase(t, scenario) : runOwnedChild(scenario));
}

async function runOwnedChild(scenario) {
  const root = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), `ling-a32-local-${scenario}-`)));
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
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
    });
    process.stdout.write(stdout); process.stderr.write(stderr);
    console.log(`A32 local child actual exit: ${JSON.stringify({ scenario, ...exit })}`);
    assert.ok(stdout.includes(`A32 local entered: ${scenario}`));
    assert.ok(stdout.includes("A32 local observation:"), "the actual product lifecycle must be entered");
    assert.equal(exit.signal, null, "a killed child is not a physically stopped sender");
    assert.equal(exit.code, 0, "nonzero is RED, even if fixture cleanup later closes its sockets");
  } finally {
    assert.ok(root.startsWith(`${await fs.realpath(os.tmpdir())}/ling-a32-local-${scenario}-`));
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** Capture native Request signals without substituting the sender or Response. */
async function exerciseCase(t, scenario) {
  const cwd = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD;
  assert.ok(cwd && cwd !== process.cwd());
  assert.deepEqual(Object.keys(process.env).filter(key => /API_?KEY|TOKEN|SECRET|BASE_URL/iu.test(key)), []);
  console.log(`A32 local entered: ${scenario}`);
  const streams = new Map(), sockets = new Set(), timers = new Set(), requests = [];
  const server = createServer((request, response) => {
    const id = request.url?.split("/").at(-1), entry = streams.get(id);
    assert.ok(entry, "only the owned task routes are valid");
    assert.equal(request.method, "GET", "fixture permits observation only, never remote production/cancel/download");
    requests.push(id); entry.response = response;
    response.setHeader("content-type", "application/json");
    response.write(`{"id":"${id}","status":`);
    const timer = setInterval(() => {
      if (!response.destroyed) { response.write(" "); entry.bytes++; }
    }, 10);
    timers.add(timer);
    response.once("close", () => {
      clearInterval(timer); timers.delete(timer); entry.closed = true; entry.close.resolve();
    });
    entry.started.resolve();
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port, baseUrl = `http://127.0.0.1:${port}/api/v3`;
  const tcp = process.binding("tcp_wrap").TCP.prototype, originalConnect = tcp.connect, originalConnect6 = tcp.connect6;
  const tcpPatch = t.mock.method(tcp, "connect", function (request, address, targetPort) {
    assert.equal(address, "127.0.0.1"); assert.equal(targetPort, port, "no non-owned network traffic is permitted");
    return Reflect.apply(originalConnect, this, [request, address, targetPort]);
  });
  const tcp6Patch = t.mock.method(tcp, "connect6", () => { assert.fail("A32 forbids IPv6 outbound connections"); });
  const actualFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const entry = streams.get(new URL(request.url).pathname.split("/").at(-1));
    assert.ok(entry, "native sender must belong to an owned poll");
    entry.wireSignal = request.signal;
    request.signal.addEventListener("abort", () => { entry.wireAborts++; }, { once: true });
    return actualFetch(input, init);
  };
  let registry, uncaught = 0, sequence = 0;
  const entries = [];
  const onUncaught = error => { uncaught++; console.error(`A32 local uncaught monitor: ${error?.name}:${error?.code ?? "unknown"}`); };
  process.on("uncaughtExceptionMonitor", onUncaught);
  try {
    const { pollSeedanceVideoTask } = await import("../../providers/dist/vendors/seedance.js");
    const { createGuardedMediaHttpTransport } = await import("../dist/features/media/guarded-native-transport.js");
    const { MediaLocalExecutionRegistry } = await import("../dist/runtime/media-local-executions.js");
    registry = new MediaLocalExecutionRegistry();
    const start = (id, { job = id, uncooperative = false } = {}) => {
      const generation = ++sequence;
      const source = { runId: `a32-run-${generation}`, workUnitId: `a32-parent-${generation}`,
        attemptId: `a32-attempt-${generation}`, runtimeInstanceId: "a32-owned-runtime", fencingToken: `a32-fence-${generation}` };
      const entry = { id, job, source, started: deferred(), close: deferred(), bytes: 0, closed: false,
        ended: false, wireAborts: 0, nativeSettled: 0, nativeRejected: 0, nativeResponses: 0,
        providerAborts: 0, pollCalls: 0, rawBodySettled: 0, admissionFailures: 0, admissionCodes: [] };
      streams.set(id, entry); entries.push(entry);
      const ticket = registry.reserve({ source, requestDigest: `a32-digest-${generation}`, toolCallId: `a32-tool-${generation}` });
      const execution = registry.bindNew(ticket, { cwd, mediaJobId: job });
      entry.execution = execution;
      entry.tick = registry.runTick({ cwd, mediaJobId: job, execution }, async local => {
        const native = createGuardedMediaHttpTransport({ registry, execution: local,
          captureAdmissionFailure: error => { entry.admissionFailures++; entry.admissionCodes.push(error.code); } });
        return pollSeedanceVideoTask({ adapterKind: "seedance", externalOperationId: id,
          recovery: { statusEndpoint: `${baseUrl}/contents/generations/tasks/${id}` } },
        { baseUrl, apiKeyConfigured: false, timeoutMs: 4_000, httpClient: async (url, init) => {
          entry.pollCalls++; entry.providerSignal = init.signal;
          init.signal?.addEventListener("abort", () => { entry.providerAborts++; }, { once: true });
          if (uncooperative) {
            // Deliberately ignore all signals in this injection-only custom
            // sender. Use a real owned HTTP body, not a resolved fake value.
            const response = await actualFetch(url, { ...init, signal: undefined });
            const readJson = response.json.bind(response);
            response.json = async () => {
              try { return await readJson(); } finally { entry.rawBodySettled++; }
            };
            return response;
          }
          try { const response = await native.fetch(url, init); entry.nativeResponses++; return response; }
          catch (error) { entry.nativeRejected++; throw error; }
          finally { entry.nativeSettled++; }
        } });
      });
      return entry;
    };
    const active = entry => registry.getSnapshot().executions.find(value => value.generation === entry.execution.generation);
    const markObservation = (label, entry, outcome) => console.log(`A32 local observation: ${JSON.stringify({ scenario, label,
      outcome: outcome?.kind, status: outcome?.value?.status, errorCode: outcome?.value?.errorCode,
      wireAborts: entry.wireAborts, wireAborted: entry.wireSignal?.aborted, providerAborts: entry.providerAborts,
      nativeSettled: entry.nativeSettled, nativeRejected: entry.nativeRejected, nativeResponses: entry.nativeResponses,
      rawBodySettled: entry.rawBodySettled, upstreamClosed: entry.closed, requests: requests.length,
      phase: active(entry)?.phase, active: active(entry)?.active })}`);
    const stoppedButEntered = entry => {
      assert.equal(active(entry)?.phase, "active"); assert.equal(active(entry)?.active, 1);
      assert.equal(entry.nativeSettled, 0, "stop must not claim physical native/body settlement in the same stack");
      assert.equal(entry.closed, false);
      for (const mode of ["forward", "observation"]) assert.throws(() => registry.launchEffect(entry.execution, mode,
        () => { assert.fail("no post-stop effect may start"); }));
      assert.throws(() => registry.schedule(entry.execution, 0, () => { assert.fail("no next poll may enter"); }));
    };
    const assertPromptAbort = async entry => {
      const outcome = await observeWithin(entry.tick, 700);
      markObservation("stop-settlement", entry, outcome);
      assert.equal(outcome.kind, "fulfilled", "local stop must abort and settle long before the 4000ms provider deadline");
      assert.equal(outcome.value.status, "failed");
      assert.notEqual(outcome.value.errorCode, "timeout", "this stop must not be confused with the provider deadline");
      assert.equal(outcome.value.terminalObservation, undefined, "local abort cannot invent remote terminal/cancel evidence");
      assert.equal(entry.wireSignal instanceof AbortSignal, true);
      assert.equal(entry.wireSignal.aborted, true); assert.equal(entry.wireAborts, 1);
      assert.equal(entry.providerSignal.aborted, false); assert.equal(entry.providerAborts, 0);
      assert.equal(entry.nativeSettled, 1); assert.equal(entry.nativeRejected, 1); assert.equal(entry.nativeResponses, 0);
      assert.equal((await observeWithin(entry.close.promise, 300)).kind, "fulfilled", "real upstream must close before fixture cleanup");
      assert.equal(entry.ended, false); assert.equal(entry.pollCalls, 1); assert.equal(entry.admissionFailures, 1);
      assert.deepEqual(entry.admissionCodes, ["media_local_aborted"], "Host stop survives adapter error translation");
      assert.ok(entry.bytes < 1024);
      await entry.execution.completion;
      assert.equal(active(entry)?.phase, "completed");
      return outcome;
    };
    const first = start("a32-task-first", { uncooperative: scenario === "non-cooperative" });
    await first.started.promise;
    if (scenario === "non-cooperative") {
      registry.beginShutdown();
      stoppedButEntered(first);
      await assert.rejects(registry.waitForIdle(30), /have not drained/u);
      const outcome = await observeWithin(first.tick, 80);
      markObservation("uncooperative-still-owned", first, outcome);
      assert.equal(outcome.kind, "unsettled"); assert.equal(first.rawBodySettled, 0); assert.equal(first.closed, false);
      assert.equal(active(first)?.active, 1); assert.equal(registry.getSnapshot().shutdown, true);
      assert.throws(() => registry.getOrStart({ cwd, mediaJobId: "no-new-work" }), error => error.code === "shutdown");
      // Explicit fixture EOF is not a product cancellation. Only after this
      // real custom sender settles may registry membership become completed.
      first.ended = true; first.response.end('"running"}');
      const released = await observeWithin(first.tick, 700);
      assert.equal(released.kind, "fulfilled"); assert.equal(first.rawBodySettled, 1);
      assert.equal(released.value.terminalObservation, undefined);
      await registry.waitForIdle(300);
      assert.equal(active(first)?.phase, "completed");
      return;
    }
    if (scenario === "two-job-isolation") {
      const second = start("a32-task-second"); await second.started.promise;
      assert.equal(registry.cancelJob({ cwd, mediaJobId: first.job, execution: first.execution }), true);
      stoppedButEntered(first); await assertPromptAbort(first);
      assert.equal(second.wireSignal.aborted, false); assert.equal(second.closed, false);
      assert.equal(second.nativeSettled, 0); assert.equal(active(second)?.active, 1);
      await assert.rejects(registry.waitForIdle(25), /have not drained/u);
      second.ended = true; second.response.end('"running"}');
      assert.equal((await second.tick).status, "pending");
      await registry.waitForIdle(300);
      assert.equal(second.wireAborts, 0); assert.equal(second.nativeResponses, 1);
      assert.equal(requests.length, 2);
      return;
    }
    if (scenario === "shutdown") registry.beginShutdown();
    else if (scenario === "source-obsolete") registry.stopSource(first.source);
    else assert.equal(registry.cancelJob({ cwd, mediaJobId: first.job, execution: first.execution }), true);
    stoppedButEntered(first); await assertPromptAbort(first);
    if (scenario === "stale-generation") {
      const successor = start("a32-task-successor", { job: first.job }); await successor.started.promise;
      assert.notEqual(successor.execution.generation, first.execution.generation);
      assert.throws(() => registry.cancelJob({ cwd, mediaJobId: first.job, execution: first.execution }), error => error.code === "invalid_handle");
      registry.stopSource(first.source);
      await delay(30);
      markObservation("old-stop-does-not-touch-successor", successor);
      assert.equal(successor.wireSignal.aborted, false); assert.equal(successor.closed, false);
      assert.equal(successor.nativeSettled, 0); assert.equal(active(successor)?.active, 1);
      registry.cancelJob({ cwd, mediaJobId: successor.job, execution: successor.execution });
      stoppedButEntered(successor); await assertPromptAbort(successor);
      assert.equal(requests.length, 2);
    }
    await registry.waitForIdle(300);
    assert.equal(uncaught, 0);
  } finally {
    for (const timer of timers) clearInterval(timer);
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const entry of entries) await observeWithin(entry.tick, 500); // cleanup cannot change an earlier RED assertion
    registry?.beginShutdown();
    globalThis.fetch = actualFetch;
    process.removeListener("uncaughtExceptionMonitor", onUncaught);
    tcpPatch.mock.restore(); tcp6Patch.mock.restore();
    assert.equal(tcp.connect, originalConnect); assert.equal(tcp.connect6, originalConnect6);
  }
}

async function observeWithin(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([Promise.resolve(promise).then(value => ({ kind: "fulfilled", value }), error => ({ kind: "rejected", error })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ kind: "unsettled" }), milliseconds); })]);
  } finally { clearTimeout(timer); }
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
