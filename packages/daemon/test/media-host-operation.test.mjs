import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, toRuntimeAttemptFence } from "@ling-stack/core";
import { reserveHostMediaOperation, assertHostMediaOperation } from "../dist/features/media/host-operation.js";
import { AttemptHostOperationTracker } from "../dist/runtime/attempt-host-operation-tracker.js";
import { AttemptLocalWriterGroup } from "../dist/runtime/attempt-local-writers.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { MediaLocalExecutionRegistry } from "../dist/runtime/media-local-executions.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { resolveConfig } from "../dist/config.js";
import { startRuntimeWorkUnit } from "../dist/runtime/work-units.js";
import { createConversationMediaGenerationToolHandler } from "../dist/features/media/conversation-tool-handler.js";
import { runMediaJobExecution, resumePendingMediaJobExecutions } from "../dist/features/media/executor.js";
import { scopeUserInputLocalWriters } from "../dist/features/runs/user-input-local-writer-scope.js";
import { createUnifiedExecFixture } from "./support/unified-exec-fixture.mjs";

const required = { kind: "user_input_required", requestId: "media-required", requestVersion: 1 };
async function fixture(t, withRuntime = false) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-media-host-operation-"));
  const task = { id: "media-task", title: "Media", prompt: "Isolated Media" };
  let f, supervisor;
  if (withRuntime) {
    const store = createSqliteRunStore(cwd);
    supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd }));
    // Initialize the actual Runtime before creating a live parent. Otherwise
    // startup reconciliation correctly marks a fabricated old owner stale.
    supervisor.getRuntime(cwd, store);
    const execution = startRuntimeWorkUnit({ store, runtimeSupervisor: supervisor, kind: "conversation_run",
      ownerType: "run", ownerId: "media-run", idempotencyKey: "actual-media-parent", request: {} });
    const now = new Date().toISOString();
    store.createRun({ id: "media-run", cwd, workUnitId: execution.workUnit.id, taskId: task.id,
      providerName: "fixture", providerModel: "fixture", taskSnapshot: task, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
    store.linkRunToWorkUnit("media-run", execution.workUnit.id, now);
    store.markRunStarted("media-run", now);
    f = { store, run: store.getRun("media-run"), sourceFence: toRuntimeAttemptFence(execution.attempt) };
    t.after(() => { supervisor.releaseAll(); store.close(); });
  } else f = createUnifiedExecFixture(t, cwd, task, "media-run");
  // after hooks run in registration order. Retire the exact live owner and
  // close SQLite before removing its diagnostic projection and coordination DB.
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const source = { runId: f.run.id, ...f.sourceFence };
  const tracker = new AttemptHostOperationTracker({ store: f.store, source });
  const rows = () => tracker.executorGroup.getSnapshot().operations.map(row => f.store.getHostOperation(row.ticket.id));
  return { ...f, source, tracker, group: tracker.executorGroup, rows, supervisor };
}

for (const fault of ["none", "submission-precommit", "submission-postcommit", "submission-unconfirmed", "response-postcommit", "terminal-postcommit"]) {
test(`actual captured Seedance submit/poll/download: ${fault}`, { timeout: 8000 }, async t => {
  const f = await fixture(t, true);
  const requests = [];
  const bytes = Buffer.from("isolated-native-video");
  let baseUrl;
  const upstream = createServer(async (request, response) => {
    for await (const _ of request) { /* Read the actual native request to EOF. */ }
    requests.push([request.method, request.url]);
    if (request.method === "POST") response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "exact-native-task" }));
    else if (request.url === "/v1/contents/generations/tasks/exact-native-task") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "exact-native-task", status: "succeeded",
        content: { video_url: `${baseUrl}/output/video.mp4` }, token: "private-fixture-token" }));
    } else response.writeHead(200, { "content-type": "video/mp4" }).end(bytes);
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${upstream.address().port}`;
  const at = new Date().toISOString();
  const provider = f.store.createProviderPreset({ kind: "seedance", displayName: "Native video receipt fixture", providerId: "seedance",
    model: "doubao-seedance-1-0-pro-250528", api: "media-job", baseUrl: `${baseUrl}/v1`, capabilities: ["video_generate"],
    compat: { mediaVendorTransport: { mode: "live" } }, enabled: true }, at);
  f.store.setProviderSecret(provider.id, "local-fixture-only", at);
  f.store.updateProviderPreset(provider.id, { apiKeyRef: `local:${provider.id}` }, at);
  f.store.recordProviderCheckResult(provider.id, { ok: true, code: "ready", message: "Fixture ready", checkedAt: at });
  f.store.updateWorkspaceSettings({ mediaGenerationDefaults: { video: { kind: "provider", providerPresetId: provider.id } } }, at);
  const writers = new AttemptLocalWriterGroup(f.source), mediaLocalExecutions = new MediaLocalExecutionRegistry();
  const persist = f.store.recordHostMediaSubmissionAndExecutionHandle.bind(f.store);
  let persistenceCalls = 0;
  f.store.recordHostMediaSubmissionAndExecutionHandle = (...args) => {
    persistenceCalls++;
    if (fault === "submission-unconfirmed" || (fault === "submission-precommit" && persistenceCalls === 1)) {
      throw new Error("synthetic_precommit_failure");
    }
    const result = persist(...args);
    if (fault === "submission-postcommit" && persistenceCalls === 1) throw new Error("synthetic_postcommit_failure");
    return result;
  };
  let receiptWriteCalls = 0;
  if (fault === "response-postcommit" || fault === "terminal-postcommit") {
    const name = fault === "response-postcommit" ? "recordHostMediaResponse" : "recordHostMediaTerminal";
    const original = f.store[name].bind(f.store);
    f.store[name] = (...args) => {
      receiptWriteCalls++;
      const result = original(...args);
      if (receiptWriteCalls === 1) throw new Error("synthetic_receipt_postcommit_failure");
      return result;
    };
  }
  const handler = createConversationMediaGenerationToolHandler({ store: f.store,
    storeRegistry: { getStore: () => f.store, mediaLocalExecutions },
    secretResolver: { resolve: () => ({ configured: false }), status: () => ({ configured: false }) },
    runtimeSupervisor: f.supervisor, run: f.run, getExecutionContext: () => ({ localWriters: writers, hostOperationTracker: f.tracker }) });
  try {
    const response = handler({ runId: f.run.id, toolCallId: "native-video", toolName: "video_generate", prompt: "One fixture video",
      task: f.run.taskSnapshot, cwd: f.store.paths.cwd });
    assert.equal(response.isError, undefined, JSON.stringify(response));
    await mediaLocalExecutions.waitForIdle();
    const job = f.store.getMediaJob(response.details.mediaJobId);
    if (fault === "submission-unconfirmed") {
      assert.equal(persistenceCalls, 2, "same DB receipt retry is bounded; it never retries POST");
      assert.deepEqual(requests, [["POST", "/v1/contents/generations/tasks"]]);
      assert.equal(job.status, "running", "uncertain receipt must not terminalize the original child");
      const handle = f.store.getMediaJobExecutionHandle(job.id);
      assert.ok(handle.workUnitId && handle.attemptId);
      assert.equal(f.store.getWorkUnitAttempt(handle.attemptId).endedAt, undefined);
      assert.match(mediaLocalExecutions.getSnapshot().executions[0].lastError, /precommit_failure/);
      f.group.closeAdmission(required); writers.close(); await writers.waitForIdle();
      assert.equal((await f.group.drain()).status, "blocked");
      return;
    }
    assert.equal(persistenceCalls, ["submission-precommit", "submission-postcommit"].includes(fault) ? 2 : 1);
    if (fault === "response-postcommit" || fault === "terminal-postcommit") assert.equal(receiptWriteCalls, 2);
    assert.equal(job.status, "succeeded", JSON.stringify({ error: job.errorMessage,
      handle: f.store.getMediaJobExecutionHandle(job.id), local: mediaLocalExecutions.getSnapshot() }));
    assert.deepEqual(requests, [["POST", "/v1/contents/generations/tasks"], ["GET", "/v1/contents/generations/tasks/exact-native-task"],
      ["GET", "/output/video.mp4"]]);
    const artifacts = f.store.listMediaJobArtifacts(job.id);
    assert.deepEqual(artifacts.map(item => item.type).sort(), ["json", "video"]);
    const summary = await readFile(join(f.store.paths.artifactsDir, artifacts.find(item => item.type === "json").path), "utf8");
    assert.doesNotMatch(summary, /private-fixture-token/);
    assert.equal(JSON.parse(summary).response.token, "[REDACTED]");
    const execution = f.store.getHostMediaExecution(f.rows()[0].evidenceRef.id);
    assert.ok(execution.submissionArtifactId && execution.terminalArtifactId && execution.manifestArtifactId && execution.finalizationArtifactId);
    const manifest = f.store.getArtifact(execution.manifestArtifactId).sealedPayload;
    assert.deepEqual(new Set(manifest.items.map(item => item.artifactId)), new Set(artifacts.map(item => item.id)));
    assert.ok(f.rows().every(row => row.phase === "safe"));
    f.group.closeAdmission(required); writers.close();
    await writers.waitForIdle();
    assert.equal((await f.group.drain()).status, "settled");
  } finally {
    mediaLocalExecutions.beginShutdown(); await mediaLocalExecutions.waitForIdle();
    await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
  }
});
}

for (const mode of ["jobs", "partial", "remote-failed"]) {
test(`actual captured Comfy receipt chain: ${mode}`, { timeout: 8000 }, async t => {
  const f = await fixture(t, true), requests = [];
  const protocolVariant = "jobs_v1";
  const statusPath = "/api/jobs/exact-prompt";
  const bytes = Buffer.from("actual-comfy-output");
  const files = [{ filename: "chosen.png", type: "output" }, ...(mode === "partial" ? [{ filename: "second.png", type: "output" }] : [])];
  const upstream = createServer(async (request, response) => {
    for await (const _ of request) { /* Materialized native submit body. */ }
    requests.push([request.method, request.url]);
    if (request.method === "POST" && request.url === "/api/prompt") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ prompt_id: "exact-prompt" }));
    } else if (request.url === statusPath) {
      const outputs = { "1": { images: files } };
      const value = { id: "exact-prompt", status: mode === "remote-failed" ? "failed" : "completed", outputs };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
    } else if (request.url.startsWith("/api/view?")) {
      if (mode === "partial" && request.url.includes("second.png")) response.writeHead(500).end("synthetic second download failure");
      else response.writeHead(200, { "content-type": "image/png" }).end(bytes);
    } else response.writeHead(404, { "content-type": "application/json" }).end("{}");
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const at = new Date().toISOString();
  const connection = f.store.createMediaWorkflowConnection({ name: "Captured Comfy fixture",
    baseUrl: `http://127.0.0.1:${upstream.address().port}`, authMode: "none", networkPolicy: "trusted_private_network", protocolVariant }, at);
  f.store.updateMediaWorkflowConnection(connection.id, { status: "ready", health: { ok: true, message: "Fixture ready", checkedAt: at, protocolVariant } }, at);
  const definition = f.store.createMediaWorkflowDefinition({ connectionId: connection.id, name: "Captured native receipt fixture" }, at);
  const version = f.store.createMediaWorkflowVersion({ workflowDefinitionId: definition.id, sourceDigest: "actual-native-test",
    graphSnapshot: { "1": { class_type: "SaveImage", inputs: {} } }, inputFields: [],
    outputRules: [{ nodeId: "1", artifactType: "image", collect: "all" }], validation: { ok: true, errors: [], warnings: [], checkedAt: at } }, at);
  f.store.updateMediaWorkflowDefinition(definition.id, { status: "ready", currentVersionId: version.id }, at);
  f.store.updateWorkspaceSettings({ mediaGenerationDefaults: { image: { kind: "workflow", workflowDefinitionId: definition.id } } }, at);
  const writers = new AttemptLocalWriterGroup(f.source), mediaLocalExecutions = new MediaLocalExecutionRegistry();
  const handler = createConversationMediaGenerationToolHandler({ store: f.store,
    storeRegistry: { getStore: () => f.store, mediaLocalExecutions },
    secretResolver: { resolve: () => ({ configured: false }), status: () => ({ configured: false }) },
    runtimeSupervisor: f.supervisor, run: f.run, getExecutionContext: () => ({ localWriters: writers, hostOperationTracker: f.tracker }) });
  try {
    const reply = handler({ runId: f.run.id, toolCallId: `comfy-${mode}`, toolName: "image_generate", prompt: "One actual workflow image",
      task: f.run.taskSnapshot, cwd: f.store.paths.cwd });
    assert.equal(reply.isError, undefined, JSON.stringify(reply));
    await mediaLocalExecutions.waitForIdle();
    const job = f.store.getMediaJob(reply.details.mediaJobId), failed = ["partial", "remote-failed"].includes(mode);
    assert.equal(job.status, failed ? "failed" : "succeeded", JSON.stringify({ error: job.errorMessage, local: mediaLocalExecutions.getSnapshot() }));
    assert.equal(requests.filter(([method]) => method === "POST").length, 1);
    const artifacts = f.store.listMediaJobArtifacts(job.id);
    assert.equal(artifacts.length, mode === "remote-failed" ? 0 : 1);
    assert.deepEqual(new Set(job.artifactIds), new Set(artifacts.map(item => item.id)), "confirmed partial remains in job projection");
    const execution = f.store.getHostMediaExecution(f.rows()[0].evidenceRef.id);
    assert.ok(execution.submissionArtifactId && execution.terminalArtifactId && execution.manifestArtifactId && execution.finalizationArtifactId);
    const manifest = f.store.getArtifact(execution.manifestArtifactId).sealedPayload;
    assert.equal(manifest.outcome, mode === "remote-failed" ? "remote_failed" : mode === "partial" ? "collection_failed" : "collected");
    assert.deepEqual(new Set(manifest.items.map(item => item.artifactId)), new Set(artifacts.map(item => item.id)));
    assert.ok(f.rows().every(row => row.phase === "safe"), "safe scope is not the same as successful business output");
    f.group.closeAdmission(required); writers.close(); await writers.waitForIdle();
    assert.equal((await f.group.drain()).status, "settled");
  } finally {
    mediaLocalExecutions.beginShutdown(); await mediaLocalExecutions.waitForIdle();
    await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
  }
});
}

test("Media reserves exact parent and transport journal facts before preparation", async t => {
  const f = await fixture(t);
  const operation = reserveHostMediaOperation(f.tracker, "reserve");
  assert.equal(f.rows().length, 2);
  assert.ok(f.rows().every(row => row.phase === "admitted"));
  assert.ok(f.rows().every(row => row.source.attemptId === f.source.attemptId));
  operation.finish();
  f.group.closeAdmission(required);
  assert.equal((await f.group.drain()).status, "settled");
  assert.ok(f.rows().every(row => row.settlementKind === "known_no_start"));
});

test("required input during awaited preparation blocks the final upload/submit send", async t => {
  const f = await fixture(t);
  const operation = reserveHostMediaOperation(f.tracker, "prepared");
  operation.assertMayPrepare();
  await Promise.resolve();
  f.group.closeAdmission(required);
  let sends = 0;
  assert.throws(() => operation.launchEffect("forward", () => { sends++; }), { code: "attempt_execution_admission_closed" });
  operation.finish();
  assert.equal(sends, 0);
  assert.equal((await f.group.drain()).status, "settled");
});

test("entered upload may observe its original remote operation but cannot submit after required close", async t => {
  const f = await fixture(t);
  const operation = reserveHostMediaOperation(f.tracker, "uploaded");
  let uploads = 0, polls = 0, submits = 0;
  operation.launchEffect("forward", () => { uploads++; });
  f.group.closeAdmission(required);
  operation.launchEffect("observation", () => { polls++; });
  assert.throws(() => operation.launchEffect("forward", () => { submits++; }), { code: "attempt_execution_admission_closed" });
  operation.finish();
  assert.equal(uploads, 1);
  assert.equal(polls, 1);
  assert.equal(submits, 0);
  assert.ok(f.rows().every(row => row.phase === "unknown_outcome"));
  assert.equal((await f.group.drain()).status, "blocked");
});

test("Media response/timeout and local completion cannot relabel an entered operation as safe", async t => {
  const f = await fixture(t);
  const operation = reserveHostMediaOperation(f.tracker, "entered");
  let pending;
  operation.launchEffect("forward", () => { pending = Promise.resolve(new Response("ack")); });
  assert.equal(await (await pending).text(), "ack");
  operation.finish();
  f.group.closeAdmission(required);
  assert.equal((await f.group.drain()).reason, "unknown_outcome");
  assert.ok(f.rows().every(row => row.settlementKind === "unknown_outcome"));
  assert.throws(() => operation.launchEffect("observation", () => {}), /finished/);
});

test("late observation cannot use a replaced parent source", async t => {
  const f = await fixture(t);
  const operation = reserveHostMediaOperation(f.tracker, "old-source");
  operation.launchEffect("forward", () => {});
  const old = f.store.getWorkUnitAttempt(f.source.attemptId);
  f.store.createWorkUnitAttempt({ workUnitId: old.workUnitId, attemptNumber: old.attemptNumber + 1,
    runtimeInstanceId: "replacement", runnerId: "pi", status: "started", now: new Date().toISOString() });
  let effects = 0;
  assert.throws(() => operation.launchEffect("observation", () => { effects++; }), /stale_owner/);
  assert.equal(effects, 0);
  operation.finish();
  assert.ok(f.rows().every(row => row.phase === "unknown_outcome"));
});

test("async Media effects and structural operation clones grant no launch authority", async t => {
  const f = await fixture(t);
  const operation = reserveHostMediaOperation(f.tracker, "opaque");
  let effects = 0;
  assert.throws(() => operation.launchEffect("forward", async () => { effects++; }), /synchronous/);
  assert.throws(() => assertHostMediaOperation({ ...operation }), /invalid/);
  assert.equal(effects, 0);
  operation.finish();
  assert.ok(f.rows().every(row => row.settlementKind === "known_no_start"));
});

test("U local writer scope rejects arbitrary Media callbacks before their first effect", async t => {
  const f = await fixture(t);
  const writers = new AttemptLocalWriterGroup(f.source);
  let effects = 0;
  const scoped = scopeUserInputLocalWriters({ onMediaGenerationToolCall: () => { effects++; return { content: [] }; } }, writers);
  assert.throws(() => scoped.onMediaGenerationToolCall({ toolCallId: "arbitrary" }), /lifecycle_unsupported/);
  assert.equal(effects, 0);
  writers.close();
  await writers.waitForIdle();
});

test("closed Store registry never resurrects SQLite after late Media work", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-media-store-close-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let opened = 0;
  const stores = new RunStoreRegistry(path => { opened++; return createSqliteRunStore(path); });
  stores.getStore(cwd);
  stores.closeAll();
  assert.throws(() => stores.getStore(cwd), /registry is closed/);
  assert.equal(opened, 1);
  assert.equal(stores.mediaLocalExecutions.getSnapshot().shutdown, true);
});

for (const mode of ["required", "completed-reuse", "parent-replaced"]) {
test(`actual captured Media HTTP chain: ${mode}`, { timeout: 8000 }, async t => {
  const f = await fixture(t, true);
  const cwd = f.store.paths.cwd;
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const requested = new Promise(resolve => { started = resolve; });
  let sends = 0;
  const upstream = createServer(async (request, response) => {
    for await (const _ of request) { /* Consume the actual request. */ }
    sends++;
    started();
    await gate;
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{
      b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlWQAAAAASUVORK5CYII=",
    }] }));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const now = new Date().toISOString();
  const provider = f.store.createProviderPreset({ kind: "openai", displayName: "Local Media fixture", providerId: "openai",
    model: "gpt-image-1", api: "media-job", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
    capabilities: ["image_generate"], compat: { mediaVendorTransport: { mode: "live" } }, enabled: true }, now);
  f.store.setProviderSecret(provider.id, "local-fixture-only", now);
  f.store.updateProviderPreset(provider.id, { apiKeyRef: `local:${provider.id}` }, now);
  f.store.recordProviderCheckResult(provider.id, { ok: true, code: "ready", message: "Local HTTP ready", checkedAt: now });
  f.store.updateWorkspaceSettings({ mediaGenerationDefaults: { image: { kind: "provider", providerPresetId: provider.id } } }, now);
  const writers = new AttemptLocalWriterGroup(f.source);
  const mediaLocalExecutions = new MediaLocalExecutionRegistry();
  const supervisor = f.supervisor;
  let contextReads = 0;
  const handler = createConversationMediaGenerationToolHandler({ store: f.store,
    storeRegistry: { getStore: () => f.store, mediaLocalExecutions },
    secretResolver: { resolve: () => ({ configured: false }), status: () => ({ configured: false }) },
    runtimeSupervisor: supervisor, run: f.run,
    getExecutionContext: () => { contextReads++; return { localWriters: writers, hostOperationTracker: f.tracker }; } });
  const request = { runId: f.run.id, toolCallId: "actual-captured", toolName: "image_generate", prompt: "One fixture pixel",
    task: f.run.taskSnapshot, cwd };
  try {
    const first = handler(request);
    assert.equal(first.isError, undefined, JSON.stringify(first));
    const reused = handler(request);
    assert.equal(reused.details.reused, true, JSON.stringify(reused));
    assert.equal(reused.details.mediaJobId, first.details.mediaJobId);
    assert.equal(contextReads, 2, "each callback captures its trusted context once");
    assert.equal(handler({ ...request, prompt: "Changed request" }).isError, true);
    await requested;
    assert.equal(sends, 1);
    assert.equal(f.rows().length, 2, "reuse must not mint another Host producer");
    const jobId = first.details.mediaJobId;
    const jobBefore = structuredClone(f.store.getMediaJob(jobId));
    if (mode === "parent-replaced") {
      const old = f.store.getWorkUnitAttempt(f.source.attemptId);
      f.store.createWorkUnitAttempt({ workUnitId: old.workUnitId, attemptNumber: old.attemptNumber + 1,
        runtimeInstanceId: "replaced-parent", runnerId: "pi", status: "started", now: new Date().toISOString() });
    } else if (mode === "required") {
      f.group.closeAdmission(required);
      writers.close();
      await assert.rejects(writers.waitForIdle(0), /not drained/);
    }
    release();
    await mediaLocalExecutions.waitForIdle();
    if (mode === "parent-replaced") {
      assert.deepEqual(f.store.getMediaJob(jobId), jobBefore, "old parent result cannot change the Media job");
      assert.equal(f.store.getMediaJob(jobId).artifactIds.length, 0);
      writers.close();
    } else {
      assert.equal(f.store.getMediaJob(jobId).status, "succeeded", f.store.getMediaJob(jobId).errorMessage);
      if (mode === "completed-reuse") {
        const completed = handler(request);
        assert.equal(completed.details.reused, true, JSON.stringify(completed));
        assert.equal(sends, 1);
        const beforeManual = structuredClone(f.store.getMediaJob(jobId));
        await assert.rejects(runMediaJobExecution({ cwd, storeRegistry: { getStore: () => f.store, mediaLocalExecutions },
          secretResolver: {}, mediaJobId: jobId, hooks: {} }), /captured|binding/i);
        assert.deepEqual(f.store.getMediaJob(jobId), beforeManual);
        resumePendingMediaJobExecutions({ cwd, storeRegistry: { getStore: () => f.store, mediaLocalExecutions }, secretResolver: {}, hooks: {} });
        assert.equal(sends, 1);
        f.group.closeAdmission(required);
        writers.close();
      }
    }
    await writers.waitForIdle();
    if (mode === "parent-replaced") assert.ok(f.rows().every(row => row.phase === "unknown_outcome"));
    else {
      assert.ok(f.rows().every(row => row.phase === "safe"), "only real response/bytes/manifest/finalization may settle both original scopes");
      const execution = f.store.getHostMediaExecution(f.rows()[0].evidenceRef.id);
      assert.ok(execution.manifestArtifactId && execution.finalizationArtifactId);
      const effects = f.store.listHostMediaEffects(execution.executionId);
      assert.equal(effects.length, 1);
      assert.ok(effects[0].responseArtifactId);
      assert.equal((await f.group.drain()).status, "settled");
    }
  } finally {
    release();
    mediaLocalExecutions.beginShutdown();
    await mediaLocalExecutions.waitForIdle();
    supervisor.releaseAll();
    await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
  }
});
}

test("configured tracked Media handler with missing context creates no job or background writer", async t => {
  const f = await fixture(t);
  const registry = new MediaLocalExecutionRegistry();
  const handler = createConversationMediaGenerationToolHandler({ store: f.store,
    storeRegistry: { getStore: () => f.store, mediaLocalExecutions: registry }, secretResolver: {}, runtimeSupervisor: {},
    run: f.run, getExecutionContext: () => undefined });
  const result = handler({ runId: f.run.id, toolCallId: "missing-context", toolName: "image_generate", prompt: "no dispatch" });
  assert.equal(result.details.code, "media_host_context_unavailable");
  assert.equal(f.store.listMediaJobs().length, 0);
  assert.equal(registry.getSnapshot().pendingReservations, 0);
  assert.equal(f.rows().length, 0);
});
