import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createSqliteRunStore, toRuntimeAttemptFence } from "@ling-stack/core";

const dist = process.env.LING_DAEMON_MEDIA_RECEIPT_TEST_DIST
  ? pathToFileURL(`${process.env.LING_DAEMON_MEDIA_RECEIPT_TEST_DIST.replace(/\/+$/u, "")}/`)
  : new URL("../dist/", import.meta.url);
const [trackerModule, writersModule, mediaModule, supervisorModule, configModule, workUnitsModule, handlerModule, receiptModule] =
  await Promise.all(["runtime/attempt-host-operation-tracker.js", "runtime/attempt-local-writers.js",
    "runtime/media-local-executions.js", "runtime/supervisor.js", "config.js", "runtime/work-units.js",
    "features/media/conversation-tool-handler.js", "features/media/host-receipt-producer.js"].map(path => import(new URL(path, dist).href)));
const { AttemptHostOperationTracker } = trackerModule;
const { AttemptLocalWriterGroup } = writersModule;
const { MediaLocalExecutionRegistry } = mediaModule;
const { RuntimeSupervisor } = supervisorModule;
const { resolveConfig } = configModule;
const { startRuntimeWorkUnit } = workUnitsModule;
const { createConversationMediaGenerationToolHandler } = handlerModule;
const { HostMediaReceiptProducer } = receiptModule;
const required = { kind: "user_input_required", requestId: "no-start-required", requestVersion: 1 };
const now = () => new Date().toISOString();
const hash = value => createHash("sha256").update(value).digest("hex");

/** Initialize the real Runtime before creating the parent; startup must not reconcile a fabricated owner. */
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-media-receipt-no-start-"));
  const store = createSqliteRunStore(cwd);
  const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd }));
  t.after(async () => { supervisor.releaseAll(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  supervisor.getRuntime(cwd, store);
  const execution = startRuntimeWorkUnit({ store, runtimeSupervisor: supervisor, kind: "conversation_run",
    ownerType: "run", ownerId: "no-start-run", idempotencyKey: "no-start-parent", request: {} });
  const task = { id: "no-start-task", title: "No-start receipt", prompt: "Isolated no-start generation" };
  store.createRun({ id: "no-start-run", cwd, workUnitId: execution.workUnit.id, taskId: task.id,
    providerName: "fixture", providerModel: "fixture", taskSnapshot: task, providerSnapshot: {}, requestSnapshot: {}, createdAt: now() });
  store.linkRunToWorkUnit("no-start-run", execution.workUnit.id, now()); store.markRunStarted("no-start-run", now());
  const run = store.getRun("no-start-run"), source = { runId: run.id, ...toRuntimeAttemptFence(execution.attempt) };
  const tracker = new AttemptHostOperationTracker({ store, source });
  const rows = () => tracker.executorGroup.getSnapshot().operations.map(row => store.getHostOperation(row.ticket.id));
  return { store, supervisor, run, source, tracker, group: tracker.executorGroup, rows };
}

for (const boundary of ["callback-throw-rollback", "after-commit-throw"]) {
  test(`entered actual Media POST ${boundary} rejects no-start and keeps required barrier blocked`, { timeout: 8000 }, async t => {
    const f = await fixture(t), requests = [], connections = [], noStartResults = [];
    const upstream = createServer(async (request, response) => {
      for await (const _ of request) { /* Consume the actual native POST before replying. */ }
      requests.push([request.method, request.url]);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{
        b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlWQAAAAASUVORK5CYII=",
      }] }));
    });
    upstream.on("connection", socket => connections.push(socket.remotePort));
    await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
    configureProvider(f.store, `http://127.0.0.1:${upstream.address().port}/v1`);
    const writers = new AttemptLocalWriterGroup(f.source), registry = new MediaLocalExecutionRegistry();
    const originalLaunch = f.store.launchHostMediaEffect.bind(f.store);
    const originalNoStart = HostMediaReceiptProducer.prototype.recordNoStartCollection;
    let executionId, sends = 0;
    const injected = new Error(`exact entered ${boundary}`);
    // Only inject a failure around the original Core transaction and actual
    // native callback. Do not fabricate an HTTP response, seal or safety claim.
    f.store.launchHostMediaEffect = (ticket, effectId, send) => {
      executionId = ticket.executionId;
      if (boundary === "callback-throw-rollback") {
        return originalLaunch(ticket, effectId, () => {
          sends++; send(); f.group.closeAdmission(required); writers.close(); throw injected;
        });
      }
      const result = originalLaunch(ticket, effectId, () => { sends++; return send(); });
      f.group.closeAdmission(required); writers.close();
      assert.equal(result, undefined); throw injected;
    };
    HostMediaReceiptProducer.prototype.recordNoStartCollection = function () {
      const result = originalNoStart.call(this); noStartResults.push(result); return result;
    };
    const handler = createConversationMediaGenerationToolHandler({ store: f.store,
      storeRegistry: { getStore: () => f.store, mediaLocalExecutions: registry },
      secretResolver: { resolve: () => ({ configured: false }), status: () => ({ configured: false }) },
      runtimeSupervisor: f.supervisor, run: f.run,
      getExecutionContext: () => ({ localWriters: writers, hostOperationTracker: f.tracker }) });
    try {
      const response = handler({ runId: f.run.id, toolCallId: `entered-${boundary}`, toolName: "image_generate",
        prompt: "One actual local pixel", task: f.run.taskSnapshot, cwd: f.store.paths.cwd });
      assert.equal(response.isError, undefined, JSON.stringify(response));
      await registry.waitForIdle(2000); await writers.waitForIdle(2000);
      assert.equal(sends, 1); assert.equal(connections.length, 1);
      assert.deepEqual(requests, [["POST", "/v1/images/generations"]]);
      assert.deepEqual(noStartResults, [false], "an entered send cannot create a zero-send manifest");
      const execution = f.store.getHostMediaExecution(executionId), effects = f.store.listHostMediaEffects(executionId);
      assert.equal(effects.length, 1);
      assert.equal(Boolean(effects[0].launchedAt), boundary === "after-commit-throw",
        "real SQL rollback removes the marker, never the irreversible native send latch");
      assert.equal(effects[0].noStartArtifactId, undefined); assert.equal(effects[0].responseArtifactId, undefined);
      assert.equal(execution.manifestArtifactId, undefined); assert.equal(execution.finalizationArtifactId, undefined);
      assert.equal(execution.submissionArtifactId, undefined); assert.equal(execution.terminalArtifactId, undefined);
      assert.equal(f.store.listMediaJobArtifacts(execution.mediaJobId).length, 0);
      const rows = f.rows();
      assert.equal(rows.length, 2);
      assert.ok(rows.every(row => row.phase === "unknown_outcome" && row.settlementKind !== "known_no_start"));
      assert.equal((await f.group.drain()).status, "blocked");
      assert.equal(f.store.getWorkUnitAttempt(execution.childFence.attemptId).status, "started");
      assert.equal(f.store.getWorkUnit(execution.childFence.workUnitId).status, "running");
    } finally {
      f.store.launchHostMediaEffect = originalLaunch;
      HostMediaReceiptProducer.prototype.recordNoStartCollection = originalNoStart;
      writers.close(); registry.beginShutdown(); await registry.waitForIdle(2000); await writers.waitForIdle(2000);
      await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
    }
  });
}

function configureProvider(store, baseUrl) {
  const provider = store.createProviderPreset({ kind: "openai", displayName: "No-start local HTTP fixture", providerId: "openai",
    model: "gpt-image-1", api: "media-job", baseUrl, capabilities: ["image_generate"],
    compat: { mediaVendorTransport: { mode: "live" } }, enabled: true }, now());
  store.setProviderSecret(provider.id, "local-fixture-only", now());
  store.updateProviderPreset(provider.id, { apiKeyRef: `local:${provider.id}` }, now());
  store.recordProviderCheckResult(provider.id, { ok: true, code: "ready", message: "Local fixture ready", checkedAt: now() });
  store.updateWorkspaceSettings({ mediaGenerationDefaults: { image: { kind: "provider", providerPresetId: provider.id } } }, now());
}

for (const boundary of ["after-receipt", "after-effect"]) {
  test(`actual captured Media first POST blocked ${boundary} seals exact no-start and settles both scopes`, { timeout: 8000 }, async t => {
    const f = await fixture(t), requests = [], connections = [];
    const upstream = createServer(async (request, response) => {
      requests.push([request.method, request.url]);
      for await (const _ of request) { /* Record and consume any unintended actual native send. */ }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{
        b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlWQAAAAASUVORK5CYII=",
      }] }));
    });
    upstream.on("connection", socket => connections.push(socket.remotePort));
    await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
    configureProvider(f.store, `http://127.0.0.1:${upstream.address().port}/v1`);
    const writers = new AttemptLocalWriterGroup(f.source), registry = new MediaLocalExecutionRegistry();
    const storeRegistry = { getStore: () => f.store, mediaLocalExecutions: registry };
    let closed = 0, preparedExecutionId;
    const originalBind = f.store.bindHostMediaChildExecution.bind(f.store);
    const originalPrepareEffect = f.store.prepareHostMediaEffect.bind(f.store);
    // These are deterministic scheduling barriers around real committed Core
    // writes, not fake HTTP/Response or injected receipt/safety claims.
    f.store.bindHostMediaChildExecution = (...args) => {
      const row = originalBind(...args);
      preparedExecutionId = row.executionId;
      assert.ok(row.childFence && row.preparedRequestArtifactId);
      if (boundary === "after-receipt") { f.group.closeAdmission(required); writers.close(); closed++; }
      return row;
    };
    f.store.prepareHostMediaEffect = (...args) => {
      const effect = originalPrepareEffect(...args);
      assert.ok(preparedExecutionId, "the receipt must already have captured its original child before the POST boundary");
      if (boundary === "after-effect") { f.group.closeAdmission(required); writers.close(); closed++; }
      return effect;
    };
    const handler = createConversationMediaGenerationToolHandler({ store: f.store, storeRegistry,
      secretResolver: { resolve: () => ({ configured: false }), status: () => ({ configured: false }) },
      runtimeSupervisor: f.supervisor, run: f.run,
      getExecutionContext: () => ({ localWriters: writers, hostOperationTracker: f.tracker }) });
    try {
      const response = handler({ runId: f.run.id, toolCallId: `no-start-${boundary}`, toolName: "image_generate",
        prompt: "One isolated no-start fixture pixel", task: f.run.taskSnapshot, cwd: f.store.paths.cwd });
      assert.equal(response.isError, undefined, JSON.stringify(response));
      await registry.waitForIdle(2000); await writers.waitForIdle(2000);
      assert.equal(closed, 1, "required admission must close at the chosen real Core boundary");
      assert.deepEqual(requests, [], "the blocked first POST must never reach the actual HTTP server");
      assert.deepEqual(connections, [], "no native socket may be created before a rejected first send");
      const execution = f.store.getHostMediaExecution(preparedExecutionId);
      assert.ok(execution?.childFence, "receipt preparation must complete even though the first send is blocked");
      const effects = f.store.listHostMediaEffects(execution.executionId), rows = f.rows();
      assert.equal(effects.length, boundary === "after-effect" ? 1 : 0);
      assert.ok(effects.every(effect => !effect.launchedAt && !effect.responseArtifactId));
      const child = f.store.getWorkUnitAttempt(execution.childFence.attemptId);
      const childUnit = f.store.getWorkUnit(execution.childFence.workUnitId);
      const manifest = execution.manifestArtifactId && f.store.getArtifact(execution.manifestArtifactId);
      const finalization = execution.finalizationArtifactId && f.store.getArtifact(execution.finalizationArtifactId);
      const noStart = effects.map(effect => effect.noStartArtifactId && f.store.getArtifact(effect.noStartArtifactId));
      const drain = await f.group.drain();
      const expectedIdentity = { schemaVersion: 1, executionId: execution.executionId,
        executionIdentityDigest: execution.identityDigest, mediaJobId: execution.mediaJobId,
        executionGenerationId: execution.executionGenerationId, source: f.source, childFence: execution.childFence,
        namespaceDigest: execution.namespaceDigest, protocol: execution.protocol };
      const validIdentity = artifact => artifact && Object.entries(expectedIdentity).every(([key, value]) =>
        assert.deepEqual(artifact.sealedPayload?.[key], value) === undefined)
        && artifact.contentSha256 === hash(JSON.stringify(artifact.sealedPayload));
      const checks = [
        ["every prepared effect has its exact immutable no-start seal", noStart.every((artifact, index) => artifact
          && artifact.sealedPayload?.kind === "media_effect_no_start_v1"
          && artifact.sealedPayload.effectId === effects[index].effectId && validIdentity(artifact))],
        ["empty collection_failed manifest is sealed", manifest?.sealedPayload?.kind === "media_manifest_v1"
          && manifest.sealedPayload.outcome === "collection_failed" && manifest.sealedPayload.items.length === 0 && validIdentity(manifest)],
        ["exact finalization is sealed", finalization?.sealedPayload?.kind === "media_finalization_v1" && validIdentity(finalization)
          && finalization.sealedPayload.manifestArtifactId === execution.manifestArtifactId
          && JSON.stringify(finalization.sealedPayload.effects) === JSON.stringify(effects.map(effect => ({ effectId: effect.effectId,
            noStartArtifactId: effect.noStartArtifactId })))],
        ["child attempt is terminal without fake success", ["failed", "cancelled"].includes(child?.status) && Boolean(child.endedAt)],
        ["child WorkUnit is terminal", ["failed", "cancelled"].includes(childUnit?.status)],
        ["both original scopes verify known_no_start", rows.length === 2
          && rows.every(row => row.phase === "safe" && row.settlementKind === "known_no_start")],
        ["required-input execution group is settled", drain.status === "settled"],
      ];
      assert.equal(execution.submissionArtifactId, undefined); assert.equal(execution.terminalArtifactId, undefined);
      assert.equal(f.store.listMediaJobArtifacts(execution.mediaJobId).length, 0);
      assert.deepEqual(checks.filter(([, pass]) => !pass).map(([label]) => label), [], JSON.stringify({ boundary, effects,
        manifest: manifest?.sealedPayload, finalization: finalization?.sealedPayload, child: child?.status,
        childUnit: childUnit?.status, rows, drain, local: registry.getSnapshot() }, null, 2));
    } finally {
      f.store.bindHostMediaChildExecution = originalBind; f.store.prepareHostMediaEffect = originalPrepareEffect;
      writers.close(); registry.beginShutdown(); await registry.waitForIdle(2000); await writers.waitForIdle(2000);
      await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
    }
  });
}
