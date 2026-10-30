import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { installOwnedMediaNativeObserver } from "./support/media-owned-native-observer.mjs";

// This process owns all credentials, files, SQLite state and HTTP listeners.
// No daily workspace, external Provider, synthetic fetch result or Response replacement.
const ownedRoot = await mkdtemp(join(tmpdir(), "ling-a19-scene-cancel-"));
const home = join(ownedRoot, "user");
const initialWorkspace = join(ownedRoot, "initial-workspace");
await Promise.all([mkdir(home), mkdir(initialWorkspace)]);
const environmentKeys = ["LING_STACK_HOME", "LING_STACK_DEFAULT_WORKSPACE_CWD"];
const originalEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));
process.env.LING_STACK_HOME = home;
process.env.LING_STACK_DEFAULT_WORKSPACE_CWD = initialWorkspace;
after(async () => {
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(ownedRoot, { recursive: true, force: true });
});

// Installed before the product captures native fetch. Only explicitly armed
// owned-upstream requests are observed; late-tail controls additionally ignore
// their signal to retain A19's real EOF/ACK case under a non-cooperative sender.
const nativeObserver = installOwnedMediaNativeObserver();
after(() => nativeObserver.restore());

// Import only after storage isolation is established; native transport is real.
const { createSqliteRunStore } = await import("@ling-stack/core");
const { prepareFixtureTaskInput } = await import("./support/prepared-input-fixture.mjs");
const { createDaemonServer } = await import("../dist/index.js");
const { MediaLocalExecutionRegistry } = await import("../dist/runtime/media-local-executions.js");
const { RunStoreRegistry } = await import("../dist/runtime/store-registry.js");
const { RuntimeSupervisor } = await import("../dist/runtime/supervisor.js");
const { ActiveRunRegistry } = await import("../dist/runtime/active-runs.js");
const { createRunnerRegistry } = await import("../dist/runtime/runners.js");
const { resolveConfig } = await import("../dist/config.js");
const { executeRunRequest, createDetachedRunExecutionSink } = await import("../dist/features/runs/orchestrator.js");
const { handleMediaSceneRunRoute, parseMediaSceneRunRoute } = await import("../dist/features/media/production-routes.js");
const { handleRunMediaJob } = await import("../dist/features/media/executor.js");
const { startRuntimeWorkUnit, retryRuntimeWorkUnit, transitionWorkUnitTerminal,
  transitionWorkUnitCancelled } = await import("../dist/runtime/work-units.js");
const emptySecrets = {
  status: ref => ({ ref, configured: false }),
  resolve: ref => ({ ref, configured: false }),
};
const graph = {
  "1": { class_type: "CLIPTextEncode", inputs: { text: "Default prompt" } },
  "9": { class_type: "SaveVideo", inputs: { filename_prefix: "Ling" } },
};
// Transport and content persistence evidence, not playable-video/model evidence.
const mediaBytes = Buffer.from("A19-owned-loopback-video-bytes");
const terminalStatuses = new Set(["succeeded", "failed", "cancelled"]);

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function bounded(promise, description, timeoutMs = 10_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function waitUntil(read, description, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await delay(15);
  }
  throw new Error(`Timed out: ${description}`);
}

/** Observe only; original this/args, branch decisions and returned Promise stay intact. */
function observeRealOwners() {
  const prototype = MediaLocalExecutionRegistry.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "runTick");
  assert.equal(typeof descriptor?.value, "function");
  const original = descriptor.value;
  const owners = [];
  Object.defineProperty(prototype, "runTick", {
    ...descriptor,
    value: function (...args) {
      const promise = Reflect.apply(original, this, args);
      const completion = deferred();
      const owner = { mediaJobId: args[0]?.mediaJobId, registry: this, pending: true, completion: completion.promise };
      owners.push(owner);
      // The observer handles its own branch only: callers receive the exact
      // original Promise/rejection, never a .finally replacement or fake result.
      promise.then(
        () => { owner.pending = false; completion.resolve({ status: "fulfilled" }); },
        error => { owner.pending = false; completion.resolve({ status: "rejected", error }); },
      );
      return promise;
    },
  });
  return {
    pending(mediaJobId) {
      const candidates = owners.filter(owner => owner.mediaJobId === mediaJobId && owner.pending);
      assert.equal(candidates.length, 1, "the real paused poll has one exact entered owner");
      return candidates[0];
    },
    snapshot(mediaJobId) {
      const owner = owners.findLast(item => item.mediaJobId === mediaJobId);
      return owner?.registry.getSnapshot().executions.find(item => item.mediaJobId === mediaJobId);
    },
    async drain() {
      await bounded(Promise.all(owners.filter(owner => owner.pending).map(owner => owner.completion)),
        "actual entered Media owner settlement before daemon stop");
    },
    restore() { Object.defineProperty(prototype, "runTick", descriptor); },
  };
}

/** Own a real upstream; delay response bytes, not adapters or Host facts. */
async function createOwnedUpstream() {
  const requests = [], failures = [], operations = new Set();
  const entered = deferred(), release = deferred();
  let sequence = 0, armFailure, armStage = "poll", armed = false, targetOperationId, wire;
  let targetClosed = false, released = false;
  const server = createServer((request, response) => {
    void handle(request, response).catch(error => {
      failures.push(error);
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "owned_fixture_error" }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function handle(request, response) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const url = new URL(request.url, baseUrl), path = url.pathname;
    const submission = request.method === "POST" &&
      (path.endsWith("/contents/generations/tasks") || path === "/api/prompt");
    const providerPoll = request.method === "GET" && path.includes("/contents/generations/tasks/");
    const comfyJobsPoll = request.method === "GET" && path.startsWith("/api/jobs/");
    const comfyHistoryPoll = request.method === "GET" && path.startsWith("/api/history/");
    const comfyPoll = comfyJobsPoll || comfyHistoryPoll;
    const remoteCancel = request.method === "POST" && path.startsWith("/api/jobs/") && path.endsWith("/cancel");
    const collection = request.method === "GET" && (path.startsWith("/generated/") || path === "/api/view");
    let operationId = providerPoll || comfyPoll ? decodeURIComponent(path.split("/").at(-1))
      : collection ? path === "/api/view" ? url.searchParams.get("filename")?.replace(/\.mp4$/u, "")
        : path.split("/").at(-1)?.replace(/\.mp4$/u, "") : undefined;
    if (submission) {
      operationId = `a19-operation-${++sequence}`;
      operations.add(operationId);
      if (armed && targetOperationId === undefined) targetOperationId = operationId;
    }
    requests.push({ method: request.method, path, operationId, submission, poll: providerPoll || comfyPoll,
      remoteCancel, collection, body: bodyText ? JSON.parse(bodyText) : undefined });
    const selectedStage = armStage === "submit" ? submission : armStage === "collect" ? collection : providerPoll || comfyPoll;
    if (selectedStage && armed && operationId === targetOperationId) {
      assert.equal(wire?.record?.url, url.href, "the selected owner uses the exact observed native URL");
      assert.equal(wire.record.method, request.method);
      response.once("close", () => { targetClosed = true; });
      if (collection) {
        // Enter actual response body consumption, not only a pre-header await.
        response.writeHead(200, { "content-type": "video/mp4",
          "content-length": String(armFailure ? mediaBytes.length + 100 : mediaBytes.length) });
        response.flushHeaders(); response.write(mediaBytes.subarray(0, 4));
      }
      entered.resolve();
      // Keep the real native fetch/Host response receipt pending until cancel.
      await release.promise;
      // A cooperative native abort already closed this real response. Fixture
      // cleanup must not pretend to deliver bytes or raise write-after-close.
      if (response.destroyed) return;
      if (collection) {
        if (armFailure) response.destroy();
        else response.end(mediaBytes.subarray(4));
        return;
      }
      if (armFailure) return sendJson(response, 500, { error: "owned_late_response_failure" });
    }
    if (path === "/api/object_info") return sendJson(response, 200, { CLIPTextEncode: {}, SaveVideo: {} });
    if (remoteCancel) return sendJson(response, 200, { ok: true });
    if (submission) return sendJson(response, 200, path === "/api/prompt"
      ? { prompt_id: operationId } : { id: operationId, status: "queued" });
    if (path.startsWith("/api/history_v2/")) return sendJson(response, 404, { error: "not_found" });
    if (providerPoll && operations.has(operationId)) return sendJson(response, 200, {
      id: operationId, status: "succeeded", content: { video_url: `${baseUrl}/generated/${operationId}.mp4` },
    });
    if (comfyJobsPoll && operations.has(operationId)) return sendJson(response, 200, {
      id: operationId, status: "completed",
      outputs: { "9": { videos: [{ filename: `${operationId}.mp4`, type: "output" }] } },
    });
    if (comfyHistoryPoll && operations.has(operationId)) return sendJson(response, 200, { [operationId]: {
      status: { status_str: "success", completed: true },
      outputs: { "9": { videos: [{ filename: `${operationId}.mp4`, type: "output" }] } },
    } });
    if (collection && operations.has(operationId)) {
      response.writeHead(200, { "content-type": "video/mp4", "content-length": String(mediaBytes.length) });
      response.end(mediaBytes); return;
    }
    sendJson(response, 404, { error: "not_found" });
  }
  return {
    baseUrl, requests, failures, entered: entered.promise,
    get targetOperationId() { return targetOperationId; },
    get native() { return wire?.record; },
    get targetClosed() { return targetClosed; },
    get released() { return released; },
    arm(failure, stage = "poll", { ignoreSignal = false } = {}) {
      assert.equal(armed, false); armed = true; armFailure = failure; armStage = stage;
      wire = nativeObserver.register({ ignoreSignal, matches: (value, input, init) => {
        const url = new URL(value);
        if (url.origin !== baseUrl) return false;
        const method = input instanceof Request ? input.method : init?.method ?? "GET";
        const submit = method === "POST" && (url.pathname.endsWith("/contents/generations/tasks") || url.pathname === "/api/prompt");
        const collect = method === "GET" && (url.pathname.startsWith("/generated/") || url.pathname === "/api/view");
        return stage === "submit" ? submit : stage === "collect" ? collect
          : method === "GET" && (url.pathname.includes("/contents/generations/tasks/") || url.pathname.startsWith("/api/history/"));
      } });
    },
    release: () => { released = true; release.resolve(); },
    restoreNativeObservation: () => wire?.close(),
    async close() {
      released = true; release.resolve();
      try { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
      finally { wire?.close(); }
    },
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function createCase(t) {
  const cwd = await mkdtemp(join(ownedRoot, "workspace-"));
  process.env.LING_STACK_DEFAULT_WORKSPACE_CWD = cwd;
  const store = createSqliteRunStore(cwd);
  const upstream = await createOwnedUpstream();
  const observer = observeRealOwners();
  let runnerCalls = 0;
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
    channels: { autoRoute: false, intentSelector: false, terminalReports: false } }, {
    secretResolver: emptySecrets,
    storeFactory: requestedCwd => { assert.equal(requestedCwd, cwd); return store; },
    runner: { prepareTaskInput: prepareFixtureTaskInput, async runTask() {
      runnerCalls++;
      throw new Error("A19 direct Media must not call an LLM runner");
    } },
  });
  t.after(async () => {
    upstream.release();
    try {
      // This is test-only local owner observation, not remote-stop evidence.
      await observer.drain();
    } finally {
      try { await daemon.stop(); }
      finally {
        observer.restore();
        await upstream.close();
      }
    }
    assert.equal(runnerCalls, 0);
    assert.deepEqual(upstream.failures, [], "owned upstream itself must not fail");
  });
  // A previous cleanup failure must not leak this test's selected sender rule.
  t.after(() => upstream.restoreNativeObservation());
  await daemon.start();
  const base = `http://127.0.0.1:${daemon.server.address().port}`;
  async function api(path, body) {
    const response = await fetch(`${base}${path}?cwd=${encodeURIComponent(cwd)}`, {
      method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(15_000),
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  return { store, upstream, observer, api };
}

function assertResponse(result, status, description) {
  assert.equal(result.status, status, `${description}: ${JSON.stringify(result.body)}`);
  return result.body;
}

async function prepareProject(fixture, kind) {
  const { api, store, upstream } = fixture;
  if (kind === "provider") {
    const created = assertResponse(await api("/providers", {
      kind: "seedance", displayName: "A19 owned Seedance", providerId: "seedance",
      model: "doubao-seedance-1-0-pro-250528", api: "media-job", capabilities: ["video_generate"],
      input: ["text"], authHeader: false, enabled: true, baseUrl: upstream.baseUrl,
      compat: { mediaVendorTransport: { mode: "live" } },
    }), 201, "create configured Provider");
    // Managed local fixture credential only; never consult env or Keychain keys.
    const now = new Date().toISOString();
    store.setProviderSecret(created.provider.id, "a19-owned-upstream-only", now);
    store.updateProviderPreset(created.provider.id, { apiKeyRef: `local:${created.provider.id}` }, now);
    store.recordProviderCheckResult(created.provider.id, { ok: true, code: "ready",
      message: "Owned loopback fixture only", checkedAt: now });
    return assertResponse(await api("/media-projects", {
      name: "A19 direct project", defaultProviderPresetId: created.provider.id,
    }), 201, "create direct project").mediaProject;
  }
  const connection = assertResponse(await api("/media-workflow-connections", {
    name: "A19 owned Comfy", authMode: "none", networkPolicy: "trusted_private_network",
    protocolVariant: "jobs_v1", baseUrl: upstream.baseUrl,
  }), 201, "create legal private-network Comfy connection").connection;
  const checked = assertResponse(await api(`/media-workflow-connections/${connection.id}/check`, {}),
    200, "real Comfy check");
  assert.equal(checked.connection.status, "ready"); assert.equal(checked.connection.health.ok, true);
  const imported = assertResponse(await api("/media-workflows/import", {
    connectionId: connection.id, name: "A19 graph", graph,
  }), 201, "real Comfy workflow import");
  assert.equal(imported.analysis.validation.ok, true);
  const definitionId = imported.definition.id, versionId = imported.importedVersion.id;
  const prompt = imported.importedVersion.inputFields.find(field => field.semantic === "prompt");
  assert.ok(prompt);
  const trial = assertResponse(await api(`/media-workflows/${definitionId}/test`, {
    versionId, inputValues: { [prompt.id]: "A19 real workflow activation preflight" },
  }), 202, "real Comfy activation trial");
  await waitForTerminal(fixture, trial.mediaJob.id, "succeeded");
  const activated = assertResponse(await api(`/media-workflows/${definitionId}/activate`, { versionId }),
    200, "activate only after actual success");
  assert.equal(activated.definition.status, "ready");
  return assertResponse(await api("/media-projects", {
    name: "A19 workflow project", defaultExecutionMode: "workflow", defaultWorkflowDefinitionId: definitionId,
  }), 201, "create workflow project").mediaProject;
}

function readLineage(store, mediaJobId) {
  const units = store.listWorkUnits({ linkedMediaJobId: mediaJobId });
  if (units.length !== 1) return undefined;
  const unit = units[0], attempts = store.listWorkUnitAttempts(unit.id);
  return { unit, attempts, attempt: attempts.find(attempt => attempt.id === unit.activeAttemptId) };
}

async function waitForTerminal(fixture, mediaJobId, expected) {
  return await waitUntil(async () => {
    const result = assertResponse(await fixture.api(`/media-jobs/${mediaJobId}`), 200, "read actual Media job");
    const lineage = readLineage(fixture.store, mediaJobId);
    return result.mediaJob.status === expected && lineage?.unit.status === expected && lineage.attempt?.status === expected
      ? result.mediaJob : undefined;
  }, `actual Media job and exact child Attempt ${expected}`);
}

function assertTerminalLineage(store, mediaJobId, expected) {
  const lineage = readLineage(store, mediaJobId);
  assert.ok(lineage, "one actual child work unit exists");
  assert.equal(lineage.attempts.length, 1, "cancellation cannot manufacture a replacement Attempt");
  assert.equal(lineage.unit.status, expected); assert.equal(lineage.attempt?.status, expected);
  const slots = store.listRuntimeSemaphoreSlots({ workUnitId: lineage.unit.id })
    .filter(slot => slot.attemptId === lineage.attempt.id);
  assert.ok(slots.length >= 1, "the exact child really acquired a Media semaphore");
  assert.ok(slots.every(slot => slot.status === "released"), "settled exact child retains no active semaphore");
}

function assertNonCooperativeEnteredTail(fixture, owner) {
  const wire = fixture.upstream.native;
  assert.ok(wire, "observe the exact owned native request");
  assert.equal(wire.ignoreSignal, true, "only this explicit test sender ignores cancellation");
  assert.equal(wire.signal.aborted, true); assert.equal(wire.aborts, 1);
  assert.equal(wire.fetchRejected, 0); assert.equal(wire.bodySettled, 0);
  assert.equal(wire.completedEof, false); assert.equal(owner.pending, true);
  assert.equal(fixture.upstream.targetClosed, false); assert.equal(fixture.upstream.released, false);
  assert.deepEqual(wire.errors, []);
}

async function assertCooperativeNativeAbort(fixture, owner) {
  await bounded(owner.completion, "original cooperative native/owner settles before fixture release");
  await fixture.observer.drain();
  await waitUntil(() => fixture.upstream.targetClosed, "actual upstream close caused by local abort, not fixture cleanup");
  const wire = fixture.upstream.native;
  assert.ok(wire, "observe the exact owned native request");
  assert.equal(wire.ignoreSignal, false, "cooperative control uses the default product signal");
  assert.equal(wire.signal.aborted, true); assert.equal(wire.aborts, 1);
  assert.equal(wire.fetchSettled, 1);
  assert.equal(wire.fetchRejected + wire.bodyRejected, 1, "actual native request or original body rejects exactly once");
  assert.equal(wire.completedEof, false, "abort is not a completed response or remote terminal receipt");
  assert.equal(owner.pending, false); assert.equal(fixture.upstream.released, false);
  assert.deepEqual(wire.errors, []);
}

for (const kind of ["provider", "workflow"]) {
  test(`A19 ${kind}: public scene independently completes through native HTTP`,
    { timeout: 30_000, concurrency: false }, async t => {
      const fixture = await createCase(t);
      const project = await prepareProject(fixture, kind);
      const scene = assertResponse(await fixture.api(`/media-projects/${project.id}/scenes`, {
        title: "A19 normal scene", prompt: "A19 owned normal scene", ratio: "16:9", durationSeconds: 5,
      }), 201, "create normal scene").mediaScene;
      const started = assertResponse(await fixture.api(`/media-scenes/${scene.id}/run`, {}), 202, "submit normal scene");
      const job = await waitForTerminal(fixture, started.mediaJob.id, "succeeded");
      await fixture.observer.drain();
      assert.ok(job.artifactIds.length > 0);
      assertTerminalLineage(fixture.store, job.id, "succeeded");
      const detail = assertResponse(await fixture.api(`/media-projects/${project.id}`), 200, "read normal project");
      assert.equal(detail.scenes.find(item => item.id === scene.id)?.selectedMediaSceneRunId, started.mediaSceneRun.id);
      const artifacts = assertResponse(await fixture.api(`/media-jobs/${job.id}/artifacts`), 200, "read persisted artifacts");
      assert.ok(artifacts.artifacts.some(artifact => artifact.type === "video" && artifact.sizeBytes === mediaBytes.length));
      assertResponse(await fixture.api(`/media-scene-runs/${started.mediaSceneRun.id}/cancel`, {}),
        409, "a completed scene wins over later cancellation");
    });

  for (const lateResult of ["success", "failure"]) {
    test(`A19 ${kind}: accepted scene cancel cannot be overwritten by late native poll ${lateResult}`,
      { timeout: 35_000, concurrency: false }, async t => {
        const fixture = await createCase(t);
        const project = await prepareProject(fixture, kind);
        const scene = assertResponse(await fixture.api(`/media-projects/${project.id}/scenes`, {
          title: `A19 cancel before late ${lateResult}`, prompt: "A19 owned cancellation scene",
          ratio: "16:9", durationSeconds: 5,
        }), 201, "create cancel scene").mediaScene;
        fixture.upstream.arm(lateResult === "failure");
        const started = assertResponse(await fixture.api(`/media-scenes/${scene.id}/run`, {}), 202, "submit cancel scene");
        const mediaJobId = started.mediaJob.id;
        await bounded(fixture.upstream.entered, "real native poll reaches owned upstream");
        const owner = fixture.observer.pending(mediaJobId);
        assert.ok(fixture.upstream.targetOperationId);
        const handleBefore = fixture.store.getMediaJobExecutionHandle(mediaJobId);
        assert.equal(handleBefore?.externalOperationId, fixture.upstream.targetOperationId);
        assert.ok(handleBefore?.attemptId);
        const cancelled = assertResponse(await fixture.api(`/media-scene-runs/${started.mediaSceneRun.id}/cancel`, {}),
          200, "public scene cancellation is accepted while native poll awaits bytes");
        assert.equal(cancelled.mediaJob.status, "cancelled");
        fixture.upstream.release();
        await bounded(owner.completion, "the exact late poll owner actually settles");
        await fixture.observer.drain();
        const after = assertResponse(await fixture.api(`/media-jobs/${mediaJobId}`), 200, "read after actual late owner settlement");
        assert.equal(after.mediaJob.status, "cancelled", "accepted cancellation is a terminal fact, not a temporary UI status");
        assert.deepEqual(after.mediaJob.artifactIds, [], "late poll cannot collect new artifacts after cancellation");
        assertTerminalLineage(fixture.store, mediaJobId, "cancelled");
        const detail = assertResponse(await fixture.api(`/media-projects/${project.id}`), 200, "read cancelled project");
        assert.equal(detail.scenes.find(item => item.id === scene.id)?.selectedMediaSceneRunId, undefined,
          "a late producer cannot select the cancelled scene result");
        // Observe a full real two-second product polling interval, with no timer
        // shortcut. Local cancellation is not a claim the remote task stopped.
        await delay(2_150);
        const operationRequests = fixture.upstream.requests.filter(item => item.operationId === fixture.upstream.targetOperationId);
        assert.equal(operationRequests.filter(item => item.submission).length, 1, "no implicit resubmission");
        assert.equal(operationRequests.filter(item => item.poll).length, 1, "no successor poll after accepted cancellation");
        assert.equal(operationRequests.filter(item => item.collection).length, 0, "no late collection request after accepted cancellation");
        assert.ok(operationRequests.every(item => item.method === "GET" || item.submission || item.remoteCancel),
          "a cancellation may issue at most the protocol-owned remote stop request");
        assertResponse(await fixture.api(`/media-scene-runs/${started.mediaSceneRun.id}/cancel`, {}),
          409, "repeated public cancellation does not revive or resubmit the scene");
        assert.ok(terminalStatuses.has(fixture.store.getMediaJob(mediaJobId).status));
        assert.equal(fixture.store.getMediaJob(mediaJobId).status, "cancelled");
      });
  }

  for (const stage of ["submit", "collect"]) for (const lateResult of ["success", "failure"])
    for (const sender of ["non-cooperative", "cooperative"]) {
    test(`A19 ${kind}: ${stage} pending cancel with ${sender} sender preserves ${lateResult} facts without reviving the generation`,
      { timeout: 35_000, concurrency: false }, async t => {
        const fixture = await createCase(t);
        const project = await prepareProject(fixture, kind);
        const scene = assertResponse(await fixture.api(`/media-projects/${project.id}/scenes`, {
          title: `A19 ${stage} ${lateResult}`, prompt: "A19 actual late response", ratio: "16:9", durationSeconds: 5,
        }), 201, "create delayed scene").mediaScene;
        fixture.upstream.arm(lateResult === "failure", stage, { ignoreSignal: sender === "non-cooperative" });
        const started = assertResponse(await fixture.api(`/media-scenes/${scene.id}/run`, {}), 202, "start delayed scene");
        const mediaJobId = started.mediaJob.id;
        await bounded(fixture.upstream.entered, `actual ${stage} request/body entered`);
        const owner = fixture.observer.pending(mediaJobId);
        const originalLineage = readLineage(fixture.store, mediaJobId);
        assert.equal(originalLineage?.attempt.status, "started");
        const cancellations = await Promise.all([
          fixture.api(`/media-scene-runs/${started.mediaSceneRun.id}/cancel`, {}),
          fixture.api(`/media-scene-runs/${started.mediaSceneRun.id}/cancel`, {}),
        ]);
        assert.deepEqual(cancellations.map(result => result.status).sort(), [200, 409], "one cancellation wins the CAS");
        assert.equal(fixture.store.getMediaJob(mediaJobId).status, "cancelled");
        if (sender === "non-cooperative") {
          assertNonCooperativeEnteredTail(fixture, owner);
          assert.equal(fixture.store.getWorkUnitAttempt(originalLineage.attempt.id).status, "started",
            "original entered EOF/ACK producer keeps its exact child fence until response facts arrive");
        } else {
          await assertCooperativeNativeAbort(fixture, owner);
          assertTerminalLineage(fixture.store, mediaJobId, "cancelled");
        }
        const waitingHandle = fixture.store.getMediaJobExecutionHandle(mediaJobId);
        assert.equal(waitingHandle.nextPollAt, undefined);
        if (stage === "submit") {
          assert.equal(waitingHandle.externalOperationId, `ling-pending:${mediaJobId}`);
          assert.equal(waitingHandle.recovery.submissionOutcome, "unknown");
        }
        fixture.upstream.release();
        await bounded(owner.completion, `real ${stage} late ${lateResult} owner settles`);
        await fixture.observer.drain();
        assert.equal(fixture.store.getMediaJob(mediaJobId).status, "cancelled");
        assert.deepEqual(fixture.store.getMediaJob(mediaJobId).artifactIds, []);
        assertTerminalLineage(fixture.store, mediaJobId, "cancelled");
        const finalHandle = fixture.store.getMediaJobExecutionHandle(mediaJobId);
        assert.ok(finalHandle, "local cancellation cannot erase unknown/actual submitted operation identity");
        assert.equal(finalHandle.nextPollAt, undefined);
        if (stage === "submit" && (lateResult === "failure" || sender === "cooperative")) {
          assert.equal(finalHandle.externalOperationId, `ling-pending:${mediaJobId}`);
          assert.equal(finalHandle.recovery.phase, "submission_outcome_unknown");
          assert.equal(finalHandle.recovery.submissionOutcome, "unknown",
            "a sent submission without real ACK never becomes known-no-start or remote cancelled");
        } else assert.equal(finalHandle.externalOperationId, fixture.upstream.targetOperationId,
          "the original genuine late ACK, not a cancellation fiction, supplies the operation identity");
        if (sender === "non-cooperative") {
          const wire = fixture.upstream.native;
          assert.equal(wire.fetchSettled, 1);
          if (lateResult === "success") {
            assert.equal(wire.completedEof, true, "the late facts come from the original genuine native EOF");
            assert.equal(wire.bodySettled, 1); assert.equal(wire.bodyRejected, 0);
          }
          assert.deepEqual(wire.errors, []);
        }
        const artifacts = assertResponse(await fixture.api(`/media-jobs/${mediaJobId}/artifacts`), 200, "read cancelled artifact rows");
        assert.deepEqual(artifacts.artifacts, [], "an entered download may return, but cannot be persisted as business success");
        assertResponse(await fixture.api(`/media-jobs/${mediaJobId}/run`, {}), 409,
          "explicit old-job retry cannot replay an unknown/cancelled submission");
        await delay(2_150);
        const calls = fixture.upstream.requests.filter(item => item.operationId === fixture.upstream.targetOperationId);
        assert.equal(calls.filter(item => item.submission).length, 1);
        assert.equal(calls.filter(item => item.poll).length, stage === "submit" ? 0 : 1);
        assert.equal(calls.filter(item => item.collection).length, stage === "submit" ? 0 : 1,
          "only the already-entered collection exists; no retry or successor collection");
        assert.equal(fixture.store.getMediaJob(mediaJobId).status, "cancelled");
      });
  }

  test(`A19 ${kind}: public cancel racing real collect completion has exactly one terminal winner`,
    { timeout: 35_000, concurrency: false }, async t => {
      const fixture = await createCase(t);
      const project = await prepareProject(fixture, kind);
      const scene = assertResponse(await fixture.api(`/media-projects/${project.id}/scenes`, {
        title: "A19 terminal race", prompt: "A19 terminal race", ratio: "16:9", durationSeconds: 5,
      }), 201, "create racing scene").mediaScene;
      fixture.upstream.arm(false, "collect");
      const started = assertResponse(await fixture.api(`/media-scenes/${scene.id}/run`, {}), 202, "start racing scene");
      await bounded(fixture.upstream.entered, "real collect EOF awaits race");
      const owner = fixture.observer.pending(started.mediaJob.id);
      const cancellation = fixture.api(`/media-scene-runs/${started.mediaSceneRun.id}/cancel`, {});
      fixture.upstream.release();
      const [cancelled] = await Promise.all([cancellation, bounded(owner.completion, "racing actual owner settles")]);
      await fixture.observer.drain();
      assert.ok([200, 409].includes(cancelled.status));
      const expected = cancelled.status === 200 ? "cancelled" : "succeeded";
      assert.equal(fixture.store.getMediaJob(started.mediaJob.id).status, expected);
      assertTerminalLineage(fixture.store, started.mediaJob.id, expected);
      const detail = assertResponse(await fixture.api(`/media-projects/${project.id}`), 200, "read race winner");
      assert.equal(detail.scenes.find(item => item.id === scene.id)?.selectedMediaSceneRunId,
        expected === "succeeded" ? started.mediaSceneRun.id : undefined);
      assertResponse(await fixture.api(`/media-scene-runs/${started.mediaSceneRun.id}/cancel`, {}), 409,
        "terminal winner remains immutable");
    });

  test(`A19 ${kind}: late cancelled generation cannot cancel or overwrite a new scene run`,
    { timeout: 40_000, concurrency: false }, async t => {
      const fixture = await createCase(t);
      const project = await prepareProject(fixture, kind);
      const scene = assertResponse(await fixture.api(`/media-projects/${project.id}/scenes`, {
        title: "A19 generation isolation", prompt: "A19 two distinct scene runs", ratio: "16:9", durationSeconds: 5,
      }), 201, "create isolated scene").mediaScene;
      fixture.upstream.arm(false);
      const oldRun = assertResponse(await fixture.api(`/media-scenes/${scene.id}/run`, {}), 202, "start old scene run");
      await bounded(fixture.upstream.entered, "old real poll awaits response");
      const oldOwner = fixture.observer.pending(oldRun.mediaJob.id);
      assertResponse(await fixture.api(`/media-scene-runs/${oldRun.mediaSceneRun.id}/cancel`, {}), 200, "cancel old generation");
      const next = assertResponse(await fixture.api(`/media-scenes/${scene.id}/run`, {}), 202, "create new scene run and identity");
      assert.notEqual(next.mediaJob.id, oldRun.mediaJob.id);
      fixture.upstream.release();
      await bounded(oldOwner.completion, "late old poll actually returns");
      await waitForTerminal(fixture, next.mediaJob.id, "succeeded");
      await fixture.observer.drain();
      assert.equal(fixture.store.getMediaJob(oldRun.mediaJob.id).status, "cancelled");
      assertTerminalLineage(fixture.store, oldRun.mediaJob.id, "cancelled");
      assertTerminalLineage(fixture.store, next.mediaJob.id, "succeeded");
      const detail = assertResponse(await fixture.api(`/media-projects/${project.id}`), 200, "read selected successor");
      assert.equal(detail.scenes.find(item => item.id === scene.id)?.selectedMediaSceneRunId, next.mediaSceneRun.id);
    });

  test(`A19 ${kind}: repeated cancel repairs a timer-only cancellation after an owned Store write fault`,
    { timeout: 35_000, concurrency: false }, async t => {
      const fixture = await createCase(t);
      const project = await prepareProject(fixture, kind);
      const scene = assertResponse(await fixture.api(`/media-projects/${project.id}/scenes`, {
        title: "A19 cancellation reconciliation fault", prompt: "A19 timer-only owned Store fault",
        ratio: "16:9", durationSeconds: 5,
      }), 201, "create timer-only fault scene").mediaScene;
      const started = assertResponse(await fixture.api(`/media-scenes/${scene.id}/run`, {}), 202, "start timer-only scene");
      const mediaJobId = started.mediaJob.id;
      const before = await waitUntil(() => {
        const handle = fixture.store.getMediaJobExecutionHandle(mediaJobId);
        const local = fixture.observer.snapshot(mediaJobId);
        return handle && !handle.externalOperationId.startsWith("ling-pending:") && handle.nextPollAt
          && Date.parse(handle.nextPollAt) > Date.now() && local?.active === 0 && local.scheduled
          ? { handle, local } : undefined;
      }, "real ACK persisted and all entered owners settled, leaving only the original poll timer");
      const original = readLineage(fixture.store, mediaJobId);
      assert.equal(original?.unit.status, "running");
      assert.equal(original.attempt.status, "started");
      const originalSlots = fixture.store.listRuntimeSemaphoreSlots({ workUnitId: original.unit.id })
        .filter(slot => slot.attemptId === original.attempt.id);
      assert.ok(originalSlots.length > 0 && originalSlots.every(slot => slot.status === "active"),
        "the no-owner control retains a real exact-child semaphore before cancellation");
      const operationId = before.handle.externalOperationId;
      assert.equal(fixture.upstream.requests.filter(item => item.operationId === operationId && item.poll).length, 0);

      const descriptor = Object.getOwnPropertyDescriptor(fixture.store, "upsertMediaJobExecutionHandle");
      const originalWrite = fixture.store.upsertMediaJobExecutionHandle;
      let injectedFaults = 0;
      Object.defineProperty(fixture.store, "upsertMediaJobExecutionHandle", {
        configurable: true, writable: true,
        value: function (...args) {
          const input = args[0];
          if (injectedFaults === 0 && input.mediaJobId === mediaJobId && input.nextPollAt === null
            && this.getMediaJob(mediaJobId)?.status === "cancelled") {
            const local = fixture.observer.snapshot(mediaJobId);
            assert.equal(local?.active, 0, "fault occurs without any entered physical/receipt tail to finish cleanup");
            assert.equal(local.scheduled, false, "cancel already closed the original local timer before the Store fault");
            injectedFaults++;
            throw new Error("a19_owned_cancel_handle_write_fault");
          }
          return Reflect.apply(originalWrite, this, args);
        },
      });
      try {
        const faultResponse = assertResponse(await fixture.api(`/media-scene-runs/${started.mediaSceneRun.id}/cancel`, {}), 400,
          "the existing production error mapper surfaces the owned Store fault, not completed reconciliation");
        assert.equal(faultResponse.message, "a19_owned_cancel_handle_write_fault");
        assert.equal(injectedFaults, 1, "the exact post-CAS cleanup write was exercised once");
        assert.equal(fixture.store.getMediaJob(mediaJobId).status, "cancelled", "the terminal cancellation CAS really committed");
        assertResponse(await fixture.api(`/media-scene-runs/${started.mediaSceneRun.id}/cancel`, {}), 409,
          "duplicate cancellation preserves the existing terminal HTTP contract while repairing local reconciliation");

        // Observe the full real product poll interval. No owner remains to
        // repair this fault later; a duplicate request must reconcile locally.
        await delay(2_150);
        await fixture.observer.drain();
        const calls = fixture.upstream.requests.filter(item => item.operationId === operationId);
        assert.equal(calls.filter(item => item.submission).length, 1, "repair cannot resubmit");
        assert.equal(calls.filter(item => item.poll || item.collection).length, 0, "repair cannot restart polling or collection");
        assert.ok(calls.every(item => item.submission || item.remoteCancel),
          "repair cannot issue a second remote cancel or any other operation request");
        const finalLineage = readLineage(fixture.store, mediaJobId);
        const finalHandle = fixture.store.getMediaJobExecutionHandle(mediaJobId);
        const finalSlots = fixture.store.listRuntimeSemaphoreSlots({ workUnitId: original.unit.id })
          .filter(slot => slot.attemptId === original.attempt.id);
        assert.deepEqual({
          status: fixture.store.getMediaJob(mediaJobId).status,
          workUnitId: finalLineage.unit.id, attemptId: finalLineage.attempt.id,
          workUnitStatus: finalLineage.unit.status, attemptStatus: finalLineage.attempt.status,
          attemptCount: finalLineage.attempts.length,
          externalOperationId: finalHandle?.externalOperationId, nextPollAt: finalHandle?.nextPollAt,
          slots: finalSlots.map(slot => ({ id: slot.id, status: slot.status })),
        }, {
          status: "cancelled", workUnitId: original.unit.id, attemptId: original.attempt.id,
          workUnitStatus: "cancelled", attemptStatus: "cancelled", attemptCount: 1,
          externalOperationId: operationId, nextPollAt: undefined,
          slots: originalSlots.map(slot => ({ id: slot.id, status: "released" })),
        }, "terminal HTTP 409 cannot strand the original child, semaphore or durable nextPollAt after a transient cleanup failure");
        assertTerminalLineage(fixture.store, mediaJobId, "cancelled");
        assert.deepEqual(fixture.store.getMediaJob(mediaJobId).artifactIds, []);
      } finally {
        if (descriptor) Object.defineProperty(fixture.store, "upsertMediaJobExecutionHandle", descriptor);
        else delete fixture.store.upsertMediaJobExecutionHandle;
      }
    });
}

/** Internal receipt controls own one real runtime and mount only the production
 * cancel/replay HTTP handlers. Public conversation currently keeps the trusted
 * user-input/Host lifecycle gate off; these controls must not pretend otherwise.
 * Store APIs configure synthetic targets and scene metadata, never issue a Host
 * ticket, native receipt, Attempt fence or lifecycle execution capability.
 */
async function createCapturedCase(t, kind) {
  const cwd = await mkdtemp(join(ownedRoot, "captured-workspace-"));
  process.env.LING_STACK_DEFAULT_WORKSPACE_CWD = cwd;
  const store = createSqliteRunStore(cwd), upstream = await createOwnedUpstream();
  const observer = observeRealOwners(), captured = deferred(), runnerRelease = deferred(), activeRuns = new ActiveRunRegistry();
  const stores = new RunStoreRegistry(requestedCwd => { assert.equal(requestedCwd, cwd); return store; });
  assert.equal(stores.getStore(cwd), store);
  const config = resolveConfig({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
    harness: { toolBroker: { mode: "enforce" } },
    channels: { autoRoute: false, intentSelector: false, terminalReports: false } });
  const supervisor = new RuntimeSupervisor(config);
  const hooks = {
    startRuntimeWorkUnit: input => startRuntimeWorkUnit({ ...input, runtimeSupervisor: supervisor }),
    recoverRuntimeWorkUnit: input => retryRuntimeWorkUnit({ ...input, runtimeSupervisor: supervisor }),
    transitionRuntimeWorkUnitTerminal: input => transitionWorkUnitTerminal(input.store, input),
    transitionRuntimeWorkUnitCancelled: input => transitionWorkUnitCancelled(input.store,
      input.workUnitId, input.attemptId, input.reason),
  };
  const at = new Date().toISOString();
  let project;
  if (kind === "provider") {
    const provider = store.createProviderPreset({ kind: "seedance", displayName: "A19 captured owned Seedance",
      providerId: "seedance", model: "doubao-seedance-1-0-pro-250528", api: "media-job", baseUrl: upstream.baseUrl,
      capabilities: ["video_generate"], compat: { mediaVendorTransport: { mode: "live" } }, enabled: true }, at);
    store.setProviderSecret(provider.id, "a19-owned-upstream-only", at);
    store.updateProviderPreset(provider.id, { apiKeyRef: `local:${provider.id}` }, at);
    store.recordProviderCheckResult(provider.id, { ok: true, code: "ready",
      message: "Owned loopback fixture only", checkedAt: at });
    store.updateWorkspaceSettings({ mediaGenerationDefaults: {
      video: { kind: "provider", providerPresetId: provider.id },
    } }, at);
    project = store.createMediaProject({ name: "A19 internal receipt association", defaultProviderPresetId: provider.id }, at);
  } else {
    const connection = store.createMediaWorkflowConnection({ name: "A19 captured owned Comfy", baseUrl: upstream.baseUrl,
      authMode: "none", networkPolicy: "trusted_private_network", protocolVariant: "jobs_v1" }, at);
    store.updateMediaWorkflowConnection(connection.id, { status: "ready", health: {
      ok: true, message: "Owned loopback fixture only", checkedAt: at, protocolVariant: "jobs_v1",
    } }, at);
    const definition = store.createMediaWorkflowDefinition({ connectionId: connection.id, name: "A19 internal receipt graph" }, at);
    const version = store.createMediaWorkflowVersion({ workflowDefinitionId: definition.id, sourceDigest: "a19-internal-fixture",
      graphSnapshot: graph, inputFields: [], outputRules: [{ nodeId: "9", artifactType: "video", collect: "first" }],
      validation: { ok: true, errors: [], warnings: [], checkedAt: at } }, at);
    store.updateMediaWorkflowDefinition(definition.id, { status: "ready", currentVersionId: version.id }, at);
    store.updateWorkspaceSettings({ mediaGenerationDefaults: {
      video: { kind: "workflow", workflowDefinitionId: definition.id },
    } }, at);
    project = store.createMediaProject({ name: "A19 internal receipt association", defaultExecutionMode: "workflow",
      defaultWorkflowDefinitionId: definition.id }, at);
  }
  let runnerCalls = 0;
  const runners = createRunnerRegistry([{ id: "a19_scripted", aliases: ["pi"], displayName: "A19 no-model fixture",
    status: "enabled", adapter: { prepareTaskInput: prepareFixtureTaskInput, async runTask(input) {
      runnerCalls++;
      try {
        assert.equal(typeof input.onUserInputRequest, "function", "the trusted internal lifecycle was actually selected");
        const result = await input.onMediaGenerationToolCall({ runId: input.runId, toolCallId: "a19-actual-captured-media",
          toolName: "video_generate", prompt: "A19 actual captured native Media", task: input.task,
          cwd: input.cwd, signal: input.signal });
        assert.equal(result.isError, undefined, JSON.stringify(result));
        assert.ok(result.details?.mediaJobId);
        captured.resolve({ mediaJobId: result.details.mediaJobId, runId: input.runId });
        // Keep the real source Attempt active until this control has observed
        // its native/Host tail. Never bypass Core's live-parent admission gate.
        await runnerRelease.promise;
        return { taskId: input.task.id, messages: [], events: [] };
      } catch (error) { captured.reject(error); throw error; }
    } } }]);
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const sceneRoute = parseMediaSceneRunRoute(url.pathname);
      if (sceneRoute) return handleMediaSceneRunRoute(request, response, config, stores, sceneRoute);
      const replay = /^\/media-jobs\/([^/]+)\/run$/u.exec(url.pathname);
      if (request.method === "POST" && replay) return await handleRunMediaJob(response, url, stores,
        emptySecrets, decodeURIComponent(replay[1]), hooks);
      sendJson(response, 404, { error: "unmounted_internal_control_route" });
    })().catch(error => {
      if (!response.headersSent) sendJson(response, 500, { error: "internal_control_handler_failed", message: error.message });
      else response.destroy(error);
    });
  });
  t.after(async () => {
    upstream.release();
    try {
      await observer.drain();
      runnerRelease.resolve();
      await activeRuns.waitForIdle();
      stores.mediaLocalExecutions.beginShutdown();
      await stores.mediaLocalExecutions.waitForIdle();
    } finally {
      runnerRelease.resolve();
      supervisor.releaseAll();
      stores.closeAll();
      observer.restore();
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      await upstream.close();
    }
    assert.equal(runnerCalls, 1);
    assert.deepEqual(upstream.failures, []);
  });
  t.after(() => upstream.restoreNativeObservation());
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { store, upstream, observer, project, captured: captured.promise, releaseRun: () => runnerRelease.resolve(),
    async api(path, body) {
      const response = await fetch(`${base}${path}?cwd=${encodeURIComponent(cwd)}`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15_000),
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
    runCaptured() {
      const completion = (async () => {
      const at = new Date().toISOString(), prompt = "Generate one A19 internal receipt fixture video.";
      const thread = store.createLingThread({ kind: "conversation", teammateId: "ling_agent",
        title: "A19 internal receipt control", objective: prompt }, at);
      const turn = store.appendConversationUserTurn({ threadId: thread.id, teammateId: "ling_agent",
        title: "A19 internal receipt control", userInstruction: prompt, idempotencyKey: "a19-captured-source",
        payload: { body: prompt, format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, at);
      const sink = { ...createDetachedRunExecutionSink(), writeError: (status, body) => {
        captured.reject(new Error(`Actual captured Run rejected (${status}): ${JSON.stringify(body)}`));
      } };
      const runId = await executeRunRequest({ cwd, workspaceCwd: cwd, threadId: thread.id, turnId: turn.turnId,
        sourceMessageId: turn.item.id, teammateId: "ling_agent", createdByActor: "local-user",
        provider: { provider: "a19-no-llm", model: "a19-fixture-model", api: "google-generative-ai", baseUrl: upstream.baseUrl },
        task: { id: "a19-captured-task", title: "A19 internal receipt control", prompt }, idempotencyKey: "a19-captured-run",
      }, sink, runners, stores, activeRuns, supervisor, emptySecrets, {}, { enableUserInputPause: true });
      assert.ok(runId, "the actual orchestrator must admit the internal source Turn");
      assert.equal(store.getLingTurnForRun(runId).sourceItemId, turn.item.id);
      if (store.getRun(runId).status === "failed") throw new Error(store.getRun(runId).errorMessage);
      return runId;
      })();
      // Preparation/terminal failures must surface even if the scripted runner
      // never entered. Observe rejection without replacing the caller's Promise.
      completion.catch(error => { captured.reject(error); });
      return completion;
    },
  };
}

// Additional INTERNAL captured-receipt controls, not public conversation or
// public scene-submit acceptance. The trusted executeRunRequest/onMedia path
// creates the real source, child, private Host tickets, native sender and receipts.
// A Store sceneRun association lets the unchanged production HTTP cancel handler
// target that exact job, in the very same Registry/Supervisor/Store.
for (const kind of ["provider", "workflow"]) for (const stage of ["submit", "collect"])
  for (const sender of ["non-cooperative", "cooperative"]) {
  test(`A19 internal captured ${kind}: cancel during native ${stage} with ${sender} sender preserves original Core ACK/EOF evidence`,
    { timeout: 35_000, concurrency: false }, async t => {
      const fixture = await createCapturedCase(t, kind);
      const project = fixture.project;
      const now = new Date().toISOString();
      const scene = fixture.store.createMediaScene({ projectId: project.id,
        title: "A19 captured cancel association", prompt: "A19 real captured tool job", ratio: "16:9", durationSeconds: 5,
      }, now);
      fixture.upstream.arm(false, stage, { ignoreSignal: sender === "non-cooperative" });
      const execution = fixture.runCaptured();
      const actual = await bounded(fixture.captured, "actual trusted orchestrator calls its captured Media tool");
      await bounded(fixture.upstream.entered, `captured actual ${stage} request entered`);
      const owner = fixture.observer.pending(actual.mediaJobId);
      const sceneRun = fixture.store.createMediaSceneRun({ projectId: project.id, sceneId: scene.id,
        mediaJobId: actual.mediaJobId, providerSnapshot: {}, executionSnapshot: { fixtureAssociationOnly: true },
        inputSnapshot: { prompt: "A19 internal captured job cancellation" } }, new Date().toISOString());
      const db = new DatabaseSync(fixture.store.paths.databasePath, { readOnly: true });
      try {
        const before = db.prepare("SELECT * FROM host_media_executions WHERE media_job_id=?").get(actual.mediaJobId);
        assert.ok(before?.execution_id, "actual captured Host preparation, not a hand-minted receipt");
        assert.ok(before.child_attempt_id);
        assertResponse(await fixture.api(`/media-scene-runs/${sceneRun.id}/cancel`, {}), 200, "cancel genuine captured job");
        if (sender === "non-cooperative") {
          assertNonCooperativeEnteredTail(fixture, owner);
          assert.equal(fixture.store.getWorkUnitAttempt(before.child_attempt_id).status, "started",
            "retain original exact fence while its native response is physically pending");
        } else {
          await assertCooperativeNativeAbort(fixture, owner);
          assertTerminalLineage(fixture.store, actual.mediaJobId, "cancelled");
        }
        fixture.upstream.release();
        await bounded(owner.completion, "actual captured response is processed by its original owner");
        await fixture.observer.drain();
        const after = await waitUntil(() => {
          const row = db.prepare("SELECT * FROM host_media_executions WHERE media_job_id=?").get(actual.mediaJobId);
          const operations = row && db.prepare("SELECT * FROM host_operations WHERE operation_id IN (?,?)")
            .all(row.parent_operation_id, row.transport_operation_id);
          return operations?.length === 2 && operations.every(operation => ["safe", "unknown_outcome"].includes(operation.phase))
            ? { row, operations } : undefined;
        }, "captured Host producer finalization/unknown readback");
        fixture.releaseRun();
        await execution;
        const finalHandle = fixture.store.getMediaJobExecutionHandle(actual.mediaJobId);
        const effects = db.prepare("SELECT * FROM host_media_effects WHERE execution_id=?").all(before.execution_id);
        assert.ok(effects.length >= 1);
        assert.ok(effects.every(effect => effect.launched_at && !effect.no_start_artifact_id),
          "actual entered requests cannot become fake no-start after local cancellation");
        if (sender === "cooperative" && stage === "submit") {
          assert.equal(before.submission_artifact_id, null);
          assert.equal(after.row.submission_artifact_id, null, "aborted native response cannot mint a submission ACK");
          assert.ok(effects.every(effect => !effect.response_artifact_id), "no EOF means no completed response receipt");
          assert.equal(finalHandle.externalOperationId, `ling-pending:${actual.mediaJobId}`);
          assert.equal(finalHandle.recovery.phase, "submission_outcome_unknown");
          assert.equal(finalHandle.recovery.submissionOutcome, "unknown");
          assert.ok(after.operations.every(operation => operation.phase === "unknown_outcome"),
            "native abort plus local cancelled child is not proof of remote no-start, failure or cancellation");
        } else {
          assert.ok(after.row.submission_artifact_id, "genuine ACK passes the unchanged Core atomic receipt/handle writer");
          const ack = db.prepare("SELECT sealed_payload_json FROM artifacts WHERE id=?").get(after.row.submission_artifact_id);
          assert.equal(JSON.parse(ack.sealed_payload_json).externalOperationId, fixture.upstream.targetOperationId);
          assert.equal(finalHandle.externalOperationId, fixture.upstream.targetOperationId);
          assert.ok(effects.every(effect => effect.response_artifact_id),
            "original complete submit responses retain their real response receipts");
          if (sender === "non-cooperative") {
            assert.equal(fixture.upstream.native.completedEof, true,
              "non-cooperative late ACK/collection uses the original real body EOF, not fabricated response facts");
            assert.equal(fixture.upstream.native.bodySettled, 1);
            assert.equal(fixture.upstream.native.bodyRejected, 0);
          } else {
            assert.equal(after.row.submission_artifact_id, before.submission_artifact_id,
              "collection abort preserves the prior genuinely committed ACK");
            assert.equal(after.row.terminal_artifact_id, before.terminal_artifact_id,
              "collection abort cannot erase or replace the prior genuine terminal observation");
          }
        }
        if (stage === "submit") {
          assert.equal(after.row.terminal_artifact_id, null);
          assert.ok(after.operations.every(operation => operation.phase === "unknown_outcome"),
            "local cancel plus real ACK does not prove the remote task stopped");
        } else assert.ok(after.row.terminal_artifact_id, "completed native poll receipt remains factual despite business cancellation");
        assert.equal(fixture.store.getMediaJob(actual.mediaJobId).status, "cancelled");
        assert.deepEqual(fixture.store.getMediaJob(actual.mediaJobId).artifactIds, []);
        assertTerminalLineage(fixture.store, actual.mediaJobId, "cancelled");
        assertResponse(await fixture.api(`/media-jobs/${actual.mediaJobId}/run`, {}), 409, "captured old-job replay remains forbidden");
        assert.equal(finalHandle.nextPollAt, undefined);
        await delay(2_150);
        const requests = fixture.upstream.requests.filter(item => item.operationId === fixture.upstream.targetOperationId);
        assert.equal(requests.filter(item => item.submission).length, 1, "cancel cannot replay the already-entered submission");
        assert.equal(requests.filter(item => item.poll).length, stage === "submit" ? 0 : 1);
        assert.equal(requests.filter(item => item.collection).length, stage === "submit" ? 0 : 1,
          "only the original collection may have entered; no successor download or retry");
        assert.ok(requests.every(item => item.method === "GET" || item.submission),
          "local abort never sends or invents a remote cancel request");
        assert.deepEqual(fixture.upstream.native.errors, []);
      } finally { db.close(); }
    });
}
