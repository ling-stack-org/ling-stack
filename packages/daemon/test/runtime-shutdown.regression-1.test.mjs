import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as tick, setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { resolveStoragePaths } from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { createA21LoopbackTransport, createA21RealPiRunner } from "./support/noncompacted-recovery-crash-worker.mjs";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function within(promise, description, ms = 3_000) {
  const controller = new AbortController();
  try {
    return await Promise.race([promise, delay(ms, undefined, { signal: controller.signal }).then(() => {
      throw new Error(`Timed out: ${description}`);
    })]);
  } finally { controller.abort(); }
}
function errorMessages(error) {
  return [error?.message, ...(error instanceof AggregateError ? error.errors.flatMap(errorMessages) : [])];
}

// Regression: E6-R03 — rejected stop proof must not deadlock on a passive SSE client.
// Found by /qa on 2026-10-26
// Report: output/e6-20260928/r03-daemon-restart-packaged-20261026/repair-status.md
// Value: protects=failed shutdown drains observers but retains unknown effects/resources;
// fails_when=run shutdown rejection bypasses passive transport close;
// why_new=existing shutdown tests do not combine completed bash with live control-plane SSE;
// seam=none; no_claim=packaged GUI recovery (provider transport is deterministic loopback).
for (const heldUpgrade of [false, true]) test(`unverified command shutdown closes passive SSE without releasing the retained Host: heldUpgrade=${heldUpgrade}`, { timeout: 20_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-r03-stop-failure-"));
  const priorLingHome = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = join(cwd, "owned-user-home");
  const reached = deferred(), release = deferred(), stores = new Set(), closedStores = new Set();
  let daemon, transport, observer, stopResult, streamReader, sourceResponse, captured, upgradedClient, upgradedServer;
  let networkClosed = false;
  const getStore = RunStoreRegistry.prototype.getStore;
  t.mock.method(RunStoreRegistry.prototype, "getStore", function (...args) {
    const store = Reflect.apply(getStore, this, args);
    if (!stores.has(store)) {
      stores.add(store);
      const close = store.close.bind(store);
      t.mock.method(store, "close", () => { closedStores.add(store); close(); });
    }
    return store;
  });
  t.after(async () => {
    release.resolve();
    upgradedClient?.destroy(); upgradedServer?.destroy();
    await streamReader?.cancel().catch(() => undefined);
    daemon?.server.closeAllConnections();
    await within(stopResult ?? daemon?.stop().catch(error => error) ?? Promise.resolve(), "owned shutdown cleanup").catch(() => undefined);
    observer?.close();
    await transport?.close();
    for (const store of stores) if (!closedStores.has(store)) store.close();
    if (priorLingHome === undefined) delete process.env.LING_STACK_HOME;
    else process.env.LING_STACK_HOME = priorLingHome;
    await rm(cwd, { recursive: true, force: true });
  });
  const marker = join(cwd, "executed-once.txt");
  const shellPath = `'${marker.replaceAll("'", "'\\''")}'`;
  transport = await createA21LoopbackTransport(count => count === 1
    ? { tool_calls: [{ index: 0, id: "r03-command", type: "function",
      function: { name: "bash", arguments: JSON.stringify({ command: `printf 'r03-once\\n' >> ${shellPath}` }) } }] }
    : { content: "Unexpected provider request after shutdown." });
  const runner = createA21RealPiRunner(transport), runTask = runner.runTask.bind(runner);
  runner.runTask = options => runTask({ ...options, onTaskContinuationBoundary: async (boundary, modelView) => {
    if (boundary === "before_provider_request"
      && modelView?.some(message => message.role === "toolResult" && message.toolCallId === "r03-command")) {
      assert.equal(captured, undefined);
      captured = { runId: options.runId, attemptId: options.runnerAttemptId };
      reached.resolve();
      await release.promise;
    }
    return options.onTaskContinuationBoundary?.(boundary, modelView);
  } });
  daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
    channels: { autoRoute: false, intentSelector: false, terminalReports: false }, harness: {
      continuations: { mode: "enforce" }, toolBroker: { mode: "enforce" },
      evaluations: { mode: "off" }, delegations: { mode: "off" },
    } }, { runner, chromeBrowserNativeMessagingEnabled: false, remoteReplyDispatcher: null,
    secretResolver: { status: ref => ({ ref, kind: "env", configured: false }),
      resolve: ref => ({ ref, configured: false, status: { ref, kind: "env", configured: false } }) } });
  await daemon.start();
  daemon.server.once("close", () => { networkClosed = true; });
  const url = `http://127.0.0.1:${daemon.server.address().port}`;
  if (heldUpgrade) {
    // A fixture-owned live upgrade models a retained execution transport, not
    // Chrome success/containment. HTTP closeAllConnections must not destroy it,
    // and stop failure must not wait for or falsely report its physical close.
    const upgraded = deferred();
    daemon.server.once("upgrade", (request, socket) => {
      assert.equal(request.url, "/r03-owned-upgrade");
      upgradedServer = socket;
      socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: r03-fixture\r\n\r\n");
      upgraded.resolve();
    });
    upgradedClient = connect({ host: "127.0.0.1", port: daemon.server.address().port });
    upgradedClient.on("error", () => undefined);
    upgradedClient.write("GET /r03-owned-upgrade HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: r03-fixture\r\n\r\n");
    await within(upgraded.promise, "owned live execution transport fixture");
  }
  observer = new DatabaseSync(resolveStoragePaths(cwd).workspace.databasePath, { readOnly: true });
  sourceResponse = await fetch(`${url}/runs`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd, workspaceCwd: cwd,
      task: { id: "r03-failure", title: "R03 retained failure", prompt: "Execute the authorized marker once." },
      provider: { provider: "r03-fixture", model: "fixture", api: "openai-completions",
        baseUrl: "https://fixture.invalid/v1", authHeader: false, reasoning: false },
      tools: ["bash"], authorizationMode: "always", workspaceAccessMode: "full_access", thinkingLevel: "off",
      permissionConfirmation: { mode: "full_access", confirmed: true, confirmedAt: new Date().toISOString(),
        reason: "Owned temporary QA marker; not a containment test." },
      idempotencyKey: "r03-failure", createdByActor: "local-user" }) });
  const sourceText = sourceResponse.text(); void sourceText.catch(() => undefined);
  assert.equal(sourceResponse.status, 200);
  await within(Promise.race([reached.promise, sourceText.then(text => {
    throw new Error(`Source returned before actual command boundary: ${text}`);
  })]), "actual completed command boundary", 8_000);
  assert.equal(await readFile(marker, "utf8"), "r03-once\n");
  const stream = await fetch(`${url}/control-plane/stream?cwd=${encodeURIComponent(cwd)}&afterSeq=0&domains=runs`);
  assert.equal(stream.status, 200);
  streamReader = stream.body.getReader();
  assert.equal((await within(streamReader.read(), "live passive SSE")).done, false);
  stopResult = daemon.stop().then(() => { throw new Error("Unknown effects must not authorize successful shutdown."); }, error => error);
  await within((async () => {
    while (!observer.prepare("SELECT 1 FROM run_suspensions WHERE attempt_id=?").get(captured.attemptId)) await delay(5);
  })(), "durable original suspension request");
  release.resolve();
  const failure = await within(stopResult, "failed stop must return without client-side SSE cancellation");
  const messages = errorMessages(failure);
  assert.ok(messages.includes("harness_shutdown_incomplete_stores_retained"), messages.join(" | "));
  // This ordinary full-access source is refused at checkpoint sealing, before
  // begin-stop. The packaged approval-resume source reached the later stop
  // proof refusal; both exercise the same production shutdown failure wiring.
  assert.ok(messages.includes("checkpoint.effect_unknown"), messages.join(" | "));
  await within((async () => { while (!(await streamReader.read()).done) {} })(), "server-owned passive SSE close");
  assert.equal(closedStores.size, 0, "unknown effects cannot authorize Store/resource disposal");
  assert.equal(daemon.server.listening, false);
  if (heldUpgrade) {
    assert.equal(upgradedServer.destroyed, false, "a failed stop must retain non-passive execution transport");
    assert.equal(networkClosed, false, "failed lifecycle must not claim all network work closed");
  }
  assert.equal(transport.requests.length, 1);
  assert.equal(await readFile(marker, "utf8"), "r03-once\n");
  const completion = observer.prepare("SELECT * FROM host_attempt_completions WHERE attempt_id=?").get(captured.attemptId);
  assert.ok(completion.drained_at); assert.equal(completion.effect_coverage, "unverified");
  const suspension = observer.prepare("SELECT * FROM run_suspensions WHERE attempt_id=?").get(captured.attemptId);
  assert.equal(suspension.state, "requested"); assert.equal(suspension.seal_artifact_id, null);
  assert.equal(observer.prepare("SELECT COUNT(*) n FROM run_suspension_stops WHERE suspension_id=?").get(suspension.id).n, 0);
  const run = observer.prepare("SELECT * FROM run_sessions WHERE id=?").get(captured.runId);
  assert.equal(run.status, "running"); assert.equal(run.ended_at, null);
  assert.equal(observer.prepare("SELECT COUNT(*) n FROM work_unit_attempts WHERE work_unit_id=?").get(run.work_unit_id).n, 1);
  assert.equal(observer.prepare("SELECT COUNT(*) n FROM run_events WHERE run_id=? AND type='tool_end'").get(run.id).n, 1);
  t.diagnostic(JSON.stringify({ failureCodes: messages, commands: 1, providerRequests: 1, heldUpgrade,
    effects: completion.effect_coverage, suspensionState: suspension.state, storesClosed: closedStores.size }));
});

// A caller's bounded observation is not the final Host lifetime. Exercise the
// real Media registry and default Daemon, with a synthetic owned callback tail.
for (const waitForOwnedDrain of [false, true]) test(`Daemon shutdown observation is separate from actual media drain: ${waitForOwnedDrain}`, { timeout: 10_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-r03-media-observation-"));
  const priorLingHome = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = join(cwd, "owned-user-home");
  let registry, daemon, work, tail, failure, closed = false;
  const entered = deferred(), release = deferred();
  const getStore = RunStoreRegistry.prototype.getStore;
  t.mock.method(RunStoreRegistry.prototype, "getStore", function (...args) {
    registry = this;
    return Reflect.apply(getStore, this, args);
  });
  t.after(async () => {
    release.resolve();
    await tail;
    await work;
    await daemon?.stop();
    t.mock.timers.reset();
    if (priorLingHome === undefined) delete process.env.LING_STACK_HOME;
    else process.env.LING_STACK_HOME = priorLingHome;
    await rm(cwd, { recursive: true, force: true });
  });
  daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
    channels: { autoRoute: false, intentSelector: false, terminalReports: false },
    harness: { continuations: { mode: "off" }, evaluations: { mode: "off" }, delegations: { mode: "off" } },
  }, { chromeBrowserNativeMessagingEnabled: false, remoteReplyDispatcher: null,
    runner: { async runTask() { assert.fail("media lifetime fixture must not invoke a model"); } },
    secretResolver: { status: ref => ({ ref, kind: "env", configured: false }), resolve: ref => ({ ref, configured: false }) } });
  await daemon.start();
  assert.ok(registry);
  const media = registry.mediaLocalExecutions;
  const ticket = media.reserve({ source: { runId: "owned-run", workUnitId: "owned-work", attemptId: "owned-attempt",
    runtimeInstanceId: "owned-runtime", fencingToken: "owned-fence" }, toolCallId: "owned-media", requestDigest: "owned-request" });
  const handle = media.bindNew(ticket, { cwd, mediaJobId: "owned-job" });
  tail = media.track(handle, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  work = daemon.stop(waitForOwnedDrain ? { waitForOwnedDrain: true } : undefined)
    .then(() => { closed = true; }, error => { failure = error; });
  await tick();
  t.mock.timers.tick(5_001);
  await tick();
  assert.equal(closed, false, "elapsed time never establishes physical drain");
  if (waitForOwnedDrain) assert.equal(failure, undefined, "CLI must observe actual drain, not cache a temporary timeout");
  else assert.equal(failure?.code, "media_local_drain_timeout", "default embedding observer keeps its exact bounded contract");
  release.resolve(); await tail; await work;
  await daemon.stop();
  if (waitForOwnedDrain) assert.equal(closed, true);
});
