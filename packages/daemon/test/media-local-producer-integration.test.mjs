import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createSqliteRunStore, resolveRuntimePaths } from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { resolveConfig } from "../dist/config.js";
import { markWorkUnitStale, retryRuntimeWorkUnit, startRuntimeWorkUnit, transitionWorkUnitCancelled,
  transitionWorkUnitTerminal } from "../dist/runtime/work-units.js";
import { runWorkflowMediaJobExecution } from "../dist/features/media/workflows/workflow-executor.js";
import { runProviderMediaJobExecution } from "../dist/features/media/provider-executor.js";

const now = () => new Date().toISOString();
const secretResolver = { resolve: ref => ({ ref, configured: false }), status: ref => ({ ref, configured: false }) };

for (const source of ["workflow", "provider"]) {
test(`actual ${source} timers isolate identical persisted job ids in two workspaces`, { timeout: 8000 }, async t => {
  const remote = await remoteFixture();
  const cwdA = await mkdtemp(join(tmpdir(), "ling-media-timer-a-"));
  const cwdB = await mkdtemp(join(tmpdir(), "ling-media-timer-b-"));
  const seed = createSqliteRunStore(cwdA);
  const job = source === "workflow" ? configureWorkflow(seed, remote.url) : configureProvider(seed, remote.url);
  const execute = source === "workflow" ? runWorkflowMediaJobExecution : runProviderMediaJobExecution;
  const databasePath = seed.paths.databasePath;
  seed.close();
  await mkdir(dirname(resolveRuntimePaths(cwdB).databasePath), { recursive: true });
  // Copy a closed isolated SQLite database, preserving a real collision in
  // persisted identity without replacing any Store result or executor method.
  await copyFile(databasePath, resolveRuntimePaths(cwdB).databasePath);
  const stores = new RunStoreRegistry(createSqliteRunStore);
  const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwdA }));
  const inputs = [cwdA, cwdB].map(cwd => ({ cwd, storeRegistry: stores, secretResolver,
    mediaJobId: job.id, hooks: runtimeHooks(supervisor) }));
  t.after(async () => {
    stores.mediaLocalExecutions.beginShutdown();
    await stores.mediaLocalExecutions.waitForIdle();
    supervisor.releaseAll();
    stores.closeAll();
    await remote.close();
    await Promise.all([rm(cwdA, { recursive: true, force: true }), rm(cwdB, { recursive: true, force: true })]);
  });
  for (const input of inputs) assert.equal((await execute(input)).statusCode, 202);
  assert.equal(remote.submissions.length, 2);
  await remote.waitFor(() => remote.polls.length === 2, 3000);
  assert.equal(remote.polls.length, 2, "one workspace's schedule cannot replace another workspace's timer");
  assert.deepEqual(new Set(remote.polls), new Set(remote.submissions));
});
}

test("daemon shutdown retires a workflow timer after its initial real 202 tick", { timeout: 6000 }, async t => {
  const remote = await remoteFixture();
  const f = await daemonFixture(t, remote);
  assert.equal((await f.run()).status, 202);
  assert.equal(remote.submissions.length, 1);
  assert.equal(f.store.getMediaJob(f.job.id).status, "running");
  await f.stop();
  await delay(2150);
  assert.equal(f.afterCloseReads(), 0, "a pending timer cannot enter a closed Store after shutdown");
  assert.equal(remote.polls.length, 0, "shutdown clears observation timers without submitting or polling again");
});

for (const collectorResult of ["success", "failure"]) {
  test(`daemon shutdown waits for actual workflow collector and ${collectorResult} tail writes`, { timeout: 8000 }, async t => {
    const remote = await remoteFixture({ holdCollector: true, collectorResult });
    const f = await daemonFixture(t, remote);
    assert.equal((await f.run()).status, 202);
    await remote.waitFor(() => remote.collectorEntered(), 3000);
    let shutdownSettled = false;
    const stopping = f.stop().then(() => { shutdownSettled = true; });
    await delay(20);
    assert.equal(shutdownSettled, false, "initial 202 and timer callback return are not collector completion");
    assert.equal(f.closed(), false, "the actual collector and its success/failure Store tail must finish before close");
    remote.releaseCollector();
    await stopping;
    assert.equal(f.closed(), true);
    assert.equal(f.afterCloseReads(), 0);
    assert.equal(f.persistedTerminalStatus(), collectorResult === "success" ? "succeeded" : "failed");
  });
}

for (const collectorResult of ["success", "failure"]) {
  test(`late workflow ${collectorResult} cannot write a replacement child Attempt`, { timeout: 8000 }, async t => {
    const remote = await remoteFixture({ holdCollector: true, collectorResult });
    const cwd = await mkdtemp(join(tmpdir(), "ling-media-old-child-"));
    const stores = new RunStoreRegistry(createSqliteRunStore);
    const store = stores.getStore(cwd);
    const job = configureWorkflow(store, remote.url);
    const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd }));
    const localExecution = stores.mediaLocalExecutions.getOrStart({ cwd, mediaJobId: job.id });
    t.after(async () => {
      remote.releaseCollector();
      stores.mediaLocalExecutions.beginShutdown();
      await stores.mediaLocalExecutions.waitForIdle();
      supervisor.releaseAll();
      stores.closeAll();
      await remote.close();
      await rm(cwd, { recursive: true, force: true });
    });
    assert.equal((await runWorkflowMediaJobExecution({ cwd, storeRegistry: stores, secretResolver,
      mediaJobId: job.id, localExecution, hooks: runtimeHooks(supervisor) })).statusCode, 202);
    await remote.waitFor(() => remote.collectorEntered(), 3000);
    const handle = store.getMediaJobExecutionHandle(job.id);
    const child = store.getWorkUnit(handle.workUnitId);
    const oldAttempt = store.getWorkUnitAttempt(handle.attemptId);
    const stale = markWorkUnitStale(store, child, now(), "controlled child replacement");
    const replacement = retryRuntimeWorkUnit({ store, runtimeSupervisor: supervisor, workUnit: stale,
      reason: "controlled child replacement" });
    assert.ok(replacement);
    assert.notEqual(replacement.attempt.id, oldAttempt.id);
    store.upsertMediaJobExecutionHandle({ ...handle, workUnitId: replacement.workUnit.id,
      attemptId: replacement.attempt.id }, now());
    const before = snapshotMedia(store, job.id, child.id);
    remote.releaseCollector();
    await localExecution.completion;
    assert.deepEqual(snapshotMedia(store, job.id, child.id), before,
      "old success, collector failure and catch tails must leave the real successor SQLite facts unchanged");
    assert.match(stores.mediaLocalExecutions.getSnapshot().executions.find(entry => entry.generation === localExecution.generation).lastError,
      /captured child Attempt/);
  });
}

function snapshotMedia(store, mediaJobId, workUnitId) {
  return { job: store.getMediaJob(mediaJobId), handle: store.getMediaJobExecutionHandle(mediaJobId),
    workUnit: store.getWorkUnit(workUnitId), attempts: store.listWorkUnitAttempts(workUnitId),
    events: store.listRuntimeEvents(workUnitId), artifacts: store.listMediaJobArtifacts(mediaJobId),
    leases: store.listResourceLeases({ workUnitId }), slots: store.listRuntimeSemaphoreSlots({ workUnitId }) };
}

function configureWorkflow(store, baseUrl) {
  const createdAt = now();
  const connection = store.createMediaWorkflowConnection({ name: "Local delayed fixture", baseUrl,
    authMode: "none", networkPolicy: "trusted_private_network", protocolVariant: "jobs_v1" }, createdAt);
  store.updateMediaWorkflowConnection(connection.id, { status: "ready",
    health: { ok: true, message: "fixture ready", checkedAt: createdAt, protocolVariant: "jobs_v1" } }, createdAt);
  const definition = store.createMediaWorkflowDefinition({ connectionId: connection.id, name: "Lifecycle fixture" }, createdAt);
  const version = store.createMediaWorkflowVersion({ workflowDefinitionId: definition.id,
    sourceDigest: "isolated-lifecycle-fixture", graphSnapshot: { "1": { class_type: "SaveImage", inputs: {} } },
    inputFields: [], outputRules: [{ nodeId: "1", artifactType: "image", collect: "first" }],
    validation: { ok: true, errors: [], warnings: [], checkedAt: createdAt } }, createdAt);
  store.updateMediaWorkflowDefinition(definition.id, { status: "ready", currentVersionId: version.id }, createdAt);
  return store.createMediaJob({ workflowVersionId: version.id, operation: "image_generate", prompt: "Scoped local fixture" }, createdAt);
}

function configureProvider(store, baseUrl) {
  const createdAt = now();
  const provider = store.createProviderPreset({ kind: "seedance", displayName: "Delayed local video fixture",
    providerId: "seedance", model: "doubao-seedance-1-0-pro-250528", api: "media-job", baseUrl,
    capabilities: ["video_generate"], compat: { mediaVendorTransport: { mode: "live" } }, enabled: true }, createdAt);
  store.setProviderSecret(provider.id, "local-fixture-secret", createdAt);
  store.updateProviderPreset(provider.id, { apiKeyRef: `local:${provider.id}` }, createdAt);
  store.recordProviderCheckResult(provider.id, { ok: true, code: "ready", message: "Local fixture ready", checkedAt: createdAt });
  return store.createMediaJob({ providerPresetId: provider.id, operation: "video_generate", prompt: "Scoped local fixture" }, createdAt);
}

async function daemonFixture(t, remote) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-media-producer-daemon-"));
  const store = createSqliteRunStore(cwd);
  const job = configureWorkflow(store, remote.url);
  let closed = false, afterCloseReads = 0, terminalStatus, stopping;
  const getMediaJob = store.getMediaJob.bind(store);
  const recoverStaleRuns = store.recoverStaleRuns.bind(store);
  const close = store.close.bind(store);
  store.getMediaJob = (...args) => { if (closed) afterCloseReads++; return getMediaJob(...args); };
  store.recoverStaleRuns = (...args) => { if (closed) afterCloseReads++; return recoverStaleRuns(...args); };
  store.close = () => {
    terminalStatus = getMediaJob(job.id)?.status;
    closed = true;
    return close();
  };
  const daemon = createDaemonServer({ defaultWorkspaceCwd: cwd, host: "127.0.0.1", port: 0,
    channels: { autoRoute: false, intentSelector: false, terminalReports: false } }, {
    storeFactory: requestedCwd => { assert.equal(requestedCwd, cwd); return store; },
    runner: { async runTask() { assert.fail("media execution does not require a conversation Runner"); } },
  });
  await daemon.start();
  const url = `http://127.0.0.1:${daemon.server.address().port}`;
  await fetch(`${url}/runtime?cwd=${encodeURIComponent(cwd)}`);
  const stop = () => stopping ??= daemon.stop();
  t.after(async () => {
    remote.releaseCollector();
    await stop();
    // A failed baseline may have returned from shutdown before the physical
    // collector finished. Let its observed callback settle before cleanup.
    await delay(20);
    await remote.close();
    await rm(cwd, { recursive: true, force: true });
  });
  return { cwd, store, job, stop, closed: () => closed, afterCloseReads: () => afterCloseReads,
    persistedTerminalStatus: () => terminalStatus,
    run: () => fetch(`${url}/media-jobs/${job.id}/run?cwd=${encodeURIComponent(cwd)}`, { method: "POST" }) };
}

function runtimeHooks(runtimeSupervisor) {
  return {
    startRuntimeWorkUnit: input => startRuntimeWorkUnit({ ...input, runtimeSupervisor }),
    recoverRuntimeWorkUnit: input => retryRuntimeWorkUnit({ ...input, runtimeSupervisor }),
    transitionRuntimeWorkUnitTerminal: input => transitionWorkUnitTerminal(input.store, input),
    transitionRuntimeWorkUnitCancelled: input => transitionWorkUnitCancelled(input.store, input.workUnitId, input.attemptId, input.reason),
  };
}

async function remoteFixture({ holdCollector = false, collectorResult = "failure" } = {}) {
  const submissions = [], polls = [];
  let collectorEntered = false, release;
  const collectorReady = new Promise(resolve => { release = resolve; });
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://fixture.invalid");
    if (url.pathname === "/api/prompt") {
      request.resume();
      const id = `real-local-operation-${submissions.length + 1}`;
      submissions.push(id);
      return json(response, { prompt_id: id });
    }
    if (url.pathname.endsWith("/contents/generations/tasks")) {
      request.resume();
      const id = `real-local-operation-${submissions.length + 1}`;
      submissions.push(id);
      return json(response, { id, status: "queued" });
    }
    if (url.pathname.includes("/contents/generations/tasks/")) {
      polls.push(url.pathname.slice(url.pathname.lastIndexOf("/") + 1));
      return json(response, { status: "failed", error: "controlled remote failure" });
    }
    if (url.pathname.startsWith("/api/jobs/")) {
      const operationId = url.pathname.slice("/api/jobs/".length);
      polls.push(operationId);
      return json(response, holdCollector
        ? { id: operationId, status: "completed", outputs: { "1": { images: [{ filename: "lifecycle.png", type: "output" }] } } }
        : { id: operationId, status: "failed", error: "controlled remote failure" });
    }
    if (url.pathname === "/api/view") {
      collectorEntered = true;
      void collectorReady.then(() => {
        if (collectorResult === "failure") return json(response, { error: "controlled collection failure" }, 500);
        response.writeHead(200, { "content-type": "image/png" });
        response.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5l8AAAAASUVORK5CYII=", "base64"));
      });
      return;
    }
    json(response, { error: "unexpected path" }, 404);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { submissions, polls, url: `http://127.0.0.1:${server.address().port}`,
    collectorEntered: () => collectorEntered, releaseCollector: () => release(),
    async waitFor(predicate, timeoutMs) {
      const until = Date.now() + timeoutMs;
      while (!predicate() && Date.now() < until) await delay(10);
      assert.equal(predicate(), true, "expected actual local remote request did not occur");
    },
    async close() {
      release();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    } };
}

function json(response, value, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
