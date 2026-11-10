import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const caseEnv = "LING_A32_MEDIA_RECOVERY_CASE";
const scenarios = ["provider-poll-success", "provider-poll-failure", "workflow-collector-success", "workflow-collector-failure",
  "captured-poll-abort-no-terminal", "captured-provider-complete-failure-tail", "captured-workflow-complete-success-tail"];
for (const scenario of scenarios) {
  if (process.env[caseEnv] && process.env[caseEnv] !== scenario) continue;
  test(`A32 shutdown preserves recoverable Media facts: ${scenario}`, { timeout: 26_000 }, t =>
    process.env[caseEnv] ? exerciseCase(t, scenario) : runOwnedChild(scenario));
}

async function runOwnedChild(scenario) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.realpath(await fs.mkdtemp(join(parent, "ling-a32-business-recovery-")));
  const home = join(root, "home"), cwd = join(root, "workspace"), temporary = join(root, "tmp");
  await Promise.all([fs.mkdir(home), fs.mkdir(cwd), fs.mkdir(temporary)]);
  try {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", fileURLToPath(import.meta.url)], {
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC", HOME: home, USERPROFILE: home, LOCALAPPDATA: home,
        TMPDIR: temporary, LING_STACK_HOME: join(root, "ling-home"), LING_STACK_DEFAULT_WORKSPACE_CWD: cwd, [caseEnv]: scenario },
      stdio: ["ignore", "pipe", "pipe"], timeout: 21_000,
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
    });
    process.stdout.write(stdout); process.stderr.write(stderr);
    console.log(`A32 business child actual exit: ${JSON.stringify({ scenario, ...exit })}`);
    assert.ok(stdout.includes(`A32 business entered: ${scenario}`));
    assert.ok(stdout.includes("A32 business observation:"));
    assert.equal(exit.signal, null, "fixture kill cannot stand in for production drain or remote cancellation");
    assert.equal(exit.code, 0, "a later cleanup cannot make an earlier business-state failure GREEN");
  } finally {
    assert.ok(root.startsWith(`${parent}/ling-a32-business-recovery-`));
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function exerciseCase(t, scenario) {
  console.log(`A32 business entered: ${scenario}`);
  assert.deepEqual(Object.keys(process.env).filter(key => /API_?KEY|TOKEN|SECRET|BASE_URL/iu.test(key)), []);
  const cwd = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD;
  assert.ok(cwd && cwd !== process.cwd());
  const source = scenario.includes("workflow") ? "workflow" : "provider";
  const captured = scenario.startsWith("captured-"), lateTail = scenario.includes("complete-");
  const failure = scenario.endsWith("failure") || scenario.includes("failure-tail");
  const remote = await upstreamFixture({ source, hold: !lateTail, failure });
  const actualFetch = globalThis.fetch, wire = [], patches = [], owners = [];
  let externalProcesses = 0, stores, store, supervisor, localExecution, jobId, tracker, writers, hookCalls = 0;
  globalThis.fetch = (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    assert.equal(new URL(request.url).origin, remote.url, "only this test's native loopback requests are permitted");
    const observation = { url: request.url, signal: request.signal, aborts: 0 };
    request.signal.addEventListener("abort", () => { observation.aborts++; }, { once: true });
    wire.push(observation);
    return actualFetch(input, init); // Original native sender and Promise, no Response substitution.
  };
  const tcp = process.binding("tcp_wrap").TCP.prototype, originalConnect = tcp.connect;
  patches.push(t.mock.method(tcp, "connect", function (request, address, port) {
    assert.equal(address, "127.0.0.1"); assert.equal(port, remote.port);
    return Reflect.apply(originalConnect, this, [request, address, port]);
  }));
  patches.push(t.mock.method(tcp, "connect6", () => { assert.fail("no non-owned IPv6 connection is authorized"); }));
  for (const method of ["exec", "execFile", "spawn", "execSync", "execFileSync", "spawnSync"]) {
    patches.push(t.mock.method(childProcess, method, () => { externalProcesses++; throw new Error("a32_business_external_process_forbidden"); }));
  }
  syncBuiltinESMExports();
  try {
    const core = await import("../../core/dist/index.js");
    const { RunStoreRegistry } = await import("../dist/runtime/store-registry.js");
    const { RuntimeSupervisor } = await import("../dist/runtime/supervisor.js");
    const { resolveConfig } = await import("../dist/config.js");
    const workUnits = await import("../dist/runtime/work-units.js");
    const { runWorkflowMediaJobExecution, resumePendingWorkflowMediaJobs } =
      await import("../dist/features/media/workflows/workflow-executor.js");
    const { runProviderMediaJobExecution, resumePendingProviderMediaJobs } =
      await import("../dist/features/media/provider-executor.js");
    const { MediaLocalExecutionRegistry } = await import("../dist/runtime/media-local-executions.js");
    const originalTick = MediaLocalExecutionRegistry.prototype.runTick;
    patches.push(t.mock.method(MediaLocalExecutionRegistry.prototype, "runTick", function (...args) {
      const promise = Reflect.apply(originalTick, this, args);
      const observation = { registry: this, mediaJobId: args[0].mediaJobId, settled: false, promise };
      owners.push(observation);
      promise.then(() => { observation.settled = true; }, () => { observation.settled = true; });
      return promise;
    }));
    const secretResolver = { resolve: ref => ({ ref, configured: false }), status: ref => ({ ref, kind: "local", configured: false }) };
    const open = () => {
      stores = new RunStoreRegistry(core.createSqliteRunStore);
      store = stores.getStore(cwd);
      supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd, host: "127.0.0.1", port: 0 }));
      supervisor.getRuntime(cwd, store); // Real startup reconciliation runs before any new ownership is acquired.
    };
    const hooks = () => ({
      startRuntimeWorkUnit: input => workUnits.startRuntimeWorkUnit({ ...input, runtimeSupervisor: supervisor }),
      recoverRuntimeWorkUnit: input => workUnits.retryRuntimeWorkUnit({ ...input, runtimeSupervisor: supervisor }),
      transitionRuntimeWorkUnitTerminal: input => workUnits.transitionWorkUnitTerminal(input.store, input),
      transitionRuntimeWorkUnitCancelled: input => workUnits.transitionWorkUnitCancelled(input.store,
        input.workUnitId, input.attemptId, input.reason),
    });
    const input = () => ({ cwd, storeRegistry: stores, secretResolver, mediaJobId: jobId, hooks: hooks() });
    const execute = source === "workflow" ? runWorkflowMediaJobExecution : runProviderMediaJobExecution;
    const resume = source === "workflow" ? resumePendingWorkflowMediaJobs : resumePendingProviderMediaJobs;
    const localSnapshot = () => stores.mediaLocalExecutions.getSnapshot();
    const mark = label => console.log(`A32 business observation: ${JSON.stringify({ scenario, label,
      jobStatus: jobId ? store.getMediaJob(jobId)?.status : undefined,
      handle: jobId ? Boolean(store.getMediaJobExecutionHandle(jobId)) : undefined,
      local: localSnapshot().executions.map(({ phase, active, stopped }) => ({ phase, active, stopped })),
      requests: remote.requests.map(([method, path]) => [method, path]), hookCalls })}`);
    open();
    const target = source === "workflow" ? configureWorkflow(store, remote.url) : configureProvider(store, `${remote.url}/v1`);
    if (captured) {
      const { AttemptHostOperationTracker } = await import("../dist/runtime/attempt-host-operation-tracker.js");
      const { AttemptLocalWriterGroup } = await import("../dist/runtime/attempt-local-writers.js");
      const { createConversationMediaGenerationToolHandler } = await import("../dist/features/media/conversation-tool-handler.js");
      const parent = workUnits.startRuntimeWorkUnit({ store, runtimeSupervisor: supervisor, kind: "conversation_run",
        ownerType: "run", ownerId: "a32-captured-run", idempotencyKey: "a32-captured-parent", request: {} });
      const at = now(), task = { id: "a32-captured-task", title: "A32 captured Media", prompt: "Owned native fixture" };
      store.createRun({ id: "a32-captured-run", cwd, workUnitId: parent.workUnit.id, taskId: task.id,
        providerName: "fixture", providerModel: "fixture", taskSnapshot: task, providerSnapshot: {}, requestSnapshot: {}, createdAt: at });
      store.linkRunToWorkUnit("a32-captured-run", parent.workUnit.id, at); store.markRunStarted("a32-captured-run", at);
      const sourceFence = { runId: "a32-captured-run", ...core.toRuntimeAttemptFence(parent.attempt) };
      tracker = new AttemptHostOperationTracker({ store, source: sourceFence }); writers = new AttemptLocalWriterGroup(sourceFence);
      store.updateWorkspaceSettings({ mediaGenerationDefaults: source === "workflow"
        ? { image: { kind: "workflow", workflowDefinitionId: target.id } }
        : { video: { kind: "provider", providerPresetId: target.id } } }, at);
      if (lateTail) {
        const method = source === "workflow" ? "recordHostMediaArtifactManifest" : "recordHostMediaTerminal";
        const original = store[method].bind(store);
        // After an original Core COMMIT of native EOF-backed evidence, but
        // before the executor's business tail. No forged response or receipt.
        store[method] = (...args) => {
          const result = original(...args);
          hookCalls++;
          if (hookCalls === 1) {
            assert.equal(store.getMediaJob(result.mediaJobId).status, "running");
            assert.ok(result.terminalArtifactId, "the actual remote terminal receipt must already be durable");
            stores.mediaLocalExecutions.beginShutdown();
          }
          return result;
        };
      }
      const run = store.getRun("a32-captured-run");
      const handler = createConversationMediaGenerationToolHandler({ store, storeRegistry: stores, secretResolver,
        runtimeSupervisor: supervisor, run, getExecutionContext: () => ({ localWriters: writers, hostOperationTracker: tracker }) });
      const reply = handler({ runId: run.id, toolCallId: "a32-captured-media", toolName: source === "workflow" ? "image_generate" : "video_generate",
        prompt: "One owned output", task, cwd });
      assert.equal(reply.isError, undefined, JSON.stringify(reply)); jobId = reply.details.mediaJobId;
    } else {
      const job = store.createMediaJob({ ...(source === "workflow" ? { workflowVersionId: target.versionId } : { providerPresetId: target.id }),
        operation: source === "workflow" ? "image_generate" : "video_generate", prompt: "Owned recovery output" }, now());
      jobId = job.id; localExecution = stores.mediaLocalExecutions.getOrStart({ cwd, mediaJobId: jobId });
      assert.equal((await execute({ ...input(), localExecution })).statusCode, 202);
    }
    if (lateTail) {
      await stores.mediaLocalExecutions.waitForIdle(6_000); mark("real-EOF-business-tail-after-shutdown");
      assert.equal(hookCalls, 1); assert.equal(localSnapshot().shutdown, true);
      assert.equal(store.getMediaJob(jobId).status, failure ? "failed" : "succeeded");
      const rows = tracker.executorGroup.getSnapshot().operations.map(item => store.getHostOperation(item.ticket.id));
      const execution = store.getHostMediaExecution(rows[0].evidenceRef.id);
      assert.ok(execution.submissionArtifactId && execution.terminalArtifactId && execution.manifestArtifactId && execution.finalizationArtifactId);
      const terminal = store.getArtifact(execution.terminalArtifactId).sealedPayload;
      assert.equal(terminal.observation.outcome, failure ? "failed" : source === "workflow" ? "completed" : "succeeded");
      assert.ok(rows.every(row => row.phase === "safe"));
      const child = store.getWorkUnit(execution.mediaChildWorkUnitId);
      assert.equal(child.status, failure ? "failed" : "succeeded");
      assert.equal(store.getWorkUnitAttempt(execution.childFence.attemptId).status, failure ? "failed" : "succeeded");
      if (!failure) await assertArtifactBytes(store, jobId, remote.bytes);
      assert.equal(remote.requests.filter(([method]) => method === "POST").length, 1);
      assert.equal(externalProcesses, 0);
      return;
    }
    await bounded(remote.entered.promise, 5_000, "real poll/collector response body entry");
    const before = snapshotBusiness(store, jobId);
    assert.equal(before.job.status, "running");
    assert.ok(before.handle && before.handle.externalOperationId === "a32-owned-operation");
    assert.ok(before.handle.workUnitId && before.handle.attemptId);
    assert.ok(["claimed", "running"].includes(before.child.status));
    assert.ok(["created", "started"].includes(before.attempt.status));
    const activeOwner = owners.findLast(item => item.mediaJobId === jobId && !item.settled);
    assert.ok(activeOwner, "observe an actual production runTick owner, not its scheduled timer");
    const heldWire = wire.findLast(item => source === "workflow" ? item.url.includes("/api/view?") : item.url.endsWith("/a32-owned-operation"));
    assert.ok(heldWire); assert.equal(heldWire.signal.aborted, false);
    const { ActiveRunRegistry } = await import("../dist/runtime/active-runs.js");
    const { createRunShutdownCoordinator } = await import("../dist/runtime/run-shutdown-coordinator.js");
    const parentRuns = new ActiveRunRegistry();
    // Captured media holds the parent's real writer. Waiting on parent idle
    // before issuing media-local abort would deadlock this held HTTP body.
    if (writers) parentRuns.trackCompletion(writers.waitForIdle());
    const shutdown = createRunShutdownCoordinator({ activeRuns: parentRuns,
      delegations: { stopAdmission() {}, async settle() {} }, mediaExecutions: stores.mediaLocalExecutions });
    const shutdownWork = shutdown.shutdown("daemon_restart");
    assert.equal(activeOwner.settled, false, "same-stack abort cannot fake physical callback settlement");
    assert.equal(localSnapshot().executions.some(item => item.active > 0), true);
    await bounded(shutdownWork, 1_500, "coordinated parent/media physical drain");
    await bounded(remote.closed.promise, 700, "real aborted upstream body close");
    mark("local-abort-drained-before-business-recovery");
    assert.equal(activeOwner.settled, true);
    assert.equal(heldWire.signal.aborted, true); assert.equal(heldWire.aborts, 1);
    assert.equal(remote.released, false, "fixture EOF did not cause local abort/drain");
    const after = snapshotBusiness(store, jobId);
    assert.equal(after.job.status, "running", "local shutdown is neither remote failure nor user cancellation");
    assert.equal(after.job.errorMessage, before.job.errorMessage);
    assert.ok(after.handle, "persisted operation handle must survive local shutdown for recovery");
    for (const key of ["mediaJobId", "externalOperationId", "adapterKind", "workUnitId", "attemptId"]) {
      assert.equal(after.handle[key], before.handle[key], `shutdown cannot erase/rebind durable ${key}`);
    }
    assert.equal(after.child.status, before.child.status); assert.equal(after.attempt.status, before.attempt.status);
    assert.equal(after.attempt.endedAt, undefined);
    assert.equal(after.events.some(event => ["work_unit_succeeded", "work_unit_failed", "work_unit_cancelled"].includes(event.type)), false);
    assert.equal(after.artifacts.length, 0);
    assert.equal(remote.requests.filter(([method]) => method === "POST").length, 1);
    assert.equal(remote.requests.some(([method]) => method === "DELETE"), false);
    if (captured) {
      const rows = tracker.executorGroup.getSnapshot().operations.map(item => store.getHostOperation(item.ticket.id));
      const receipt = store.getHostMediaExecution(rows[0].evidenceRef.id);
      assert.ok(receipt.submissionArtifactId, "a genuine earlier submit ACK was persisted");
      assert.equal(receipt.terminalArtifactId, undefined, "partial status JSON plus local abort cannot mint a remote terminal receipt");
      assert.equal(receipt.manifestArtifactId, undefined); assert.equal(receipt.finalizationArtifactId, undefined);
      assert.ok(rows.every(row => row.phase !== "safe" && !["media_remote_terminal", "media_chain_completed"].includes(row.settlementKind)));
      tracker.executorGroup.closeAdmission({ kind: "user_input_required", requestId: "a32-stop-audit", requestVersion: 1 });
      writers.close(); await writers.waitForIdle();
      assert.equal((await tracker.executorGroup.drain()).status, "blocked", "local idle is not whole-operation remote safety");
      assert.equal(externalProcesses, 0);
      return;
    }
    const databasePath = store.paths.databasePath, originalAttemptId = before.handle.attemptId;
    supervisor.releaseAll(); stores.closeAll();
    remote.recover(); open();
    assert.equal(store.paths.databasePath, databasePath, "recovery reopens the same original SQLite file, not a copied fixture");
    const reopened = store.getMediaJobExecutionHandle(jobId);
    assert.equal(reopened.externalOperationId, "a32-owned-operation"); assert.equal(reopened.attemptId, originalAttemptId);
    assert.equal(store.getWorkUnitAttempt(originalAttemptId).status, "lost", "real new Supervisor reconciles the departed owner");
    resume(input()); // Production recovery schedules the durable operation; it must not submit again.
    await waitUntil(() => ["succeeded", "failed"].includes(store.getMediaJob(jobId)?.status), 6_000, "recovered actual terminal business result");
    await stores.mediaLocalExecutions.waitForIdle(1_500); mark("same-SQLite-recovery-terminal");
    const final = store.getMediaJob(jobId), child = store.getWorkUnit(before.handle.workUnitId);
    assert.equal(final.status, failure ? "failed" : "succeeded");
    assert.equal(child.status, final.status); assert.notEqual(child.activeAttemptId, originalAttemptId);
    assert.equal(store.getWorkUnitAttempt(child.activeAttemptId).status, final.status);
    assert.equal(store.getWorkUnitAttempt(originalAttemptId).status, "lost");
    assert.equal(store.listWorkUnitAttempts(child.id).length, 2, "new local ownership recovers the original child instead of a second task");
    assert.equal(remote.requests.filter(([method]) => method === "POST").length, 1, "no duplicate paid submission on restart");
    assert.equal(remote.requests.filter(([method, path]) => method === "GET" && (source === "workflow" ? path.startsWith("/api/jobs/") : path.includes("/contents/generations/tasks/"))).length, 2);
    assert.equal(remote.requests.some(([method]) => method === "DELETE"), false);
    if (failure) assert.equal(store.listMediaJobArtifacts(jobId).some(artifact => artifact.type === (source === "workflow" ? "image" : "video")), false);
    else await assertArtifactBytes(store, jobId, remote.bytes);
    if (!failure) assert.equal(store.getMediaJobExecutionHandle(jobId), undefined);
    assert.equal(externalProcesses, 0);
  } finally {
    remote.release();
    writers?.close();
    if (stores) {
      stores.mediaLocalExecutions.beginShutdown();
      await observeWithin(stores.mediaLocalExecutions.waitForIdle(1_000), 1_200);
      try { supervisor?.releaseAll(); } finally { try { stores.closeAll(); } catch { /* Preserve the original RED. */ } }
    }
    await remote.close();
    globalThis.fetch = actualFetch;
    for (const patch of patches.reverse()) patch.mock.restore();
    syncBuiltinESMExports();
  }
}

function snapshotBusiness(store, id) {
  const handle = store.getMediaJobExecutionHandle(id);
  return { job: store.getMediaJob(id), handle,
    child: handle?.workUnitId ? store.getWorkUnit(handle.workUnitId) : undefined,
    attempt: handle?.attemptId ? store.getWorkUnitAttempt(handle.attemptId) : undefined,
    events: handle?.workUnitId ? store.listRuntimeEvents(handle.workUnitId) : [], artifacts: store.listMediaJobArtifacts(id) };
}

function configureWorkflow(store, baseUrl) {
  const at = now();
  const connection = store.createMediaWorkflowConnection({ name: "A32 owned workflow", baseUrl,
    authMode: "none", networkPolicy: "trusted_private_network", protocolVariant: "jobs_v1" }, at);
  store.updateMediaWorkflowConnection(connection.id, { status: "ready", health: {
    ok: true, message: "Owned fixture ready", checkedAt: at, protocolVariant: "jobs_v1" } }, at);
  const definition = store.createMediaWorkflowDefinition({ connectionId: connection.id, name: "A32 recovery output" }, at);
  const version = store.createMediaWorkflowVersion({ workflowDefinitionId: definition.id, sourceDigest: "a32-native-recovery",
    graphSnapshot: { "1": { class_type: "SaveImage", inputs: {} } }, inputFields: [],
    outputRules: [{ nodeId: "1", artifactType: "image", collect: "first" }], validation: { ok: true, errors: [], warnings: [], checkedAt: at } }, at);
  store.updateMediaWorkflowDefinition(definition.id, { status: "ready", currentVersionId: version.id }, at);
  return { id: definition.id, versionId: version.id };
}

function configureProvider(store, baseUrl) {
  const at = now();
  const provider = store.createProviderPreset({ kind: "seedance", displayName: "A32 owned video", providerId: "seedance",
    model: "doubao-seedance-1-0-pro-250528", api: "media-job", baseUrl, capabilities: ["video_generate"],
    compat: { mediaVendorTransport: { mode: "live" } }, enabled: true }, at);
  store.setProviderSecret(provider.id, "a32-owned-not-external-secret", at);
  store.updateProviderPreset(provider.id, { apiKeyRef: `local:${provider.id}` }, at);
  store.recordProviderCheckResult(provider.id, { ok: true, code: "ready", message: "Owned fixture ready", checkedAt: at });
  return provider;
}

async function upstreamFixture({ source, hold, failure }) {
  const requests = [], sockets = new Set(), entered = deferred(), closed = deferred();
  const bytes = source === "workflow"
    ? Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5l8AAAAASUVORK5CYII=", "base64")
    : Buffer.from("a32-owned-real-video-output");
  let response, recovered = false, released = false;
  const server = createServer(async (request, outgoing) => {
    for await (const _ of request) { /* Actual request bytes must reach EOF. */ }
    requests.push([request.method, request.url]);
    const path = new URL(request.url, "http://owned.invalid").pathname;
    if (request.method === "POST") {
      assert.equal(path, source === "workflow" ? "/api/prompt" : "/v1/contents/generations/tasks");
      return json(outgoing, source === "workflow" ? { prompt_id: "a32-owned-operation" } : { id: "a32-owned-operation" });
    }
    assert.equal(request.method, "GET", "shutdown/recovery must not emit remote cancel or new production");
    const pollPath = source === "workflow" ? "/api/jobs/a32-owned-operation" : "/v1/contents/generations/tasks/a32-owned-operation";
    if (path === pollPath) {
      if (source === "provider" && hold && !recovered) {
        response = outgoing; outgoing.setHeader("content-type", "application/json");
        outgoing.write('{"id":"a32-owned-operation","status":');
        outgoing.once("close", () => closed.resolve()); entered.resolve(); return;
      }
      if (source === "provider") return json(outgoing, failure
        ? { id: "a32-owned-operation", status: "failed", error: { message: "Owned real remote failure" } }
        : { id: "a32-owned-operation", status: "succeeded", content: { video_url: `${url}/output/video.mp4` } });
      return json(outgoing, { id: "a32-owned-operation", status: "completed",
        outputs: { "1": { images: [{ filename: "recovered.png", type: "output" }] } } });
    }
    assert.equal(path, source === "workflow" ? "/api/view" : "/output/video.mp4");
    if (source === "workflow" && hold && !recovered) {
      response = outgoing; outgoing.setHeader("content-type", "image/png"); outgoing.write(bytes.subarray(0, 8));
      outgoing.once("close", () => closed.resolve()); entered.resolve(); return;
    }
    if (source === "workflow" && failure) return json(outgoing, { error: "Owned real collector failure" }, 500);
    outgoing.writeHead(200, { "content-type": source === "workflow" ? "image/png" : "video/mp4" }); outgoing.end(bytes);
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port, url = `http://127.0.0.1:${port}`;
  const release = () => {
    if (response && !response.destroyed && !released) {
      released = true; response.end(source === "workflow" ? bytes.subarray(8) : '"running"}');
    }
  };
  return { requests, bytes, entered, closed, port, url, get released() { return released; },
    recover() { recovered = true; }, release,
    async close() {
      release(); for (const socket of sockets) socket.destroy(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    } };
}

async function assertArtifactBytes(store, jobId, expected) {
  const artifact = store.listMediaJobArtifacts(jobId).find(item => item.type === (expected[0] === 137 ? "image" : "video"));
  assert.ok(artifact, "success needs an actual persisted media file, not model text or a terminal field");
  assert.deepEqual(await fs.readFile(join(store.paths.artifactsDir, artifact.path)), expected);
}
function json(response, value, status = 200) { response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value)); }
function now() { return new Date().toISOString(); }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function observeWithin(promise, milliseconds) {
  let timer;
  try { return await Promise.race([Promise.resolve(promise).then(value => ({ kind: "fulfilled", value }), error => ({ kind: "rejected", error })),
    new Promise(resolve => { timer = setTimeout(() => resolve({ kind: "unsettled" }), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function bounded(promise, milliseconds, description) {
  const result = await observeWithin(promise, milliseconds);
  assert.equal(result.kind, "fulfilled", description); return result.value;
}
async function waitUntil(read, milliseconds, description) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) { if (read()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(description);
}
