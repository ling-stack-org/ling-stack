import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, toRuntimeAttemptFence } from "@ling-stack/core";
import { AttemptHostOperationTracker } from "../dist/runtime/attempt-host-operation-tracker.js";
import { AttemptLocalWriterGroup } from "../dist/runtime/attempt-local-writers.js";
import { MediaLocalExecutionRegistry } from "../dist/runtime/media-local-executions.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { resolveConfig } from "../dist/config.js";
import { startRuntimeWorkUnit } from "../dist/runtime/work-units.js";
import { createConversationMediaGenerationToolHandler } from "../dist/features/media/conversation-tool-handler.js";

const now = () => new Date().toISOString();
const required = { kind: "user_input_required", requestId: "finish-required", requestVersion: 1 };
const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlWQAAAAASUVORK5CYII=";
const settlementKinds = { transport: "media_response_completed", parent: "media_chain_completed" };
const finishStages = ["manifest", "finalization", "transport", "parent"];

/** Real captured handler, native loopback HTTP, and isolated SQLite; no synthetic safety receipts. */
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-media-receipt-finish-"));
  const store = createSqliteRunStore(cwd);
  const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd }));
  const registry = new MediaLocalExecutionRegistry();
  let writers, release;
  const held = new Promise(resolve => { release = resolve; });
  let observed;
  const requested = new Promise(resolve => { observed = resolve; });
  const requests = [];
  const upstream = createServer(async (request, response) => {
    for await (const _ of request) { /* Consume the actual synthetic request before closing admission. */ }
    requests.push([request.method, request.url]);
    observed();
    await held;
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ b64_json: pixel }] }));
  });
  t.after(async () => {
    release();
    writers?.close();
    registry.beginShutdown();
    await registry.waitForIdle(2000);
    if (writers) await writers.waitForIdle(2000);
    await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
    supervisor.releaseAll();
    store.close();
    await rm(cwd, { recursive: true, force: true });
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  // Runtime startup precedes creation of the original parent, so no fabricated
  // parent owner can be reconciled away by startup recovery.
  supervisor.getRuntime(cwd, store);
  const unit = startRuntimeWorkUnit({ store, runtimeSupervisor: supervisor, kind: "conversation_run",
    ownerType: "run", ownerId: "receipt-finish-run", idempotencyKey: "receipt-finish-parent", request: {} });
  const task = { id: "receipt-finish-task", title: "Receipt finish", prompt: "One synthetic pixel" };
  store.createRun({ id: "receipt-finish-run", cwd, workUnitId: unit.workUnit.id, taskId: task.id,
    providerName: "fixture", providerModel: "fixture", taskSnapshot: task, providerSnapshot: {}, requestSnapshot: {}, createdAt: now() });
  store.linkRunToWorkUnit("receipt-finish-run", unit.workUnit.id, now());
  store.markRunStarted("receipt-finish-run", now());
  const run = store.getRun("receipt-finish-run"), source = { runId: run.id, ...toRuntimeAttemptFence(unit.attempt) };
  const tracker = new AttemptHostOperationTracker({ store, source });
  writers = new AttemptLocalWriterGroup(source);
  const provider = store.createProviderPreset({ kind: "openai", displayName: "Receipt finish loopback fixture", providerId: "openai",
    model: "gpt-image-1", api: "media-job", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
    capabilities: ["image_generate"], compat: { mediaVendorTransport: { mode: "live" } }, enabled: true }, now());
  store.setProviderSecret(provider.id, "synthetic-fixture-only", now());
  store.updateProviderPreset(provider.id, { apiKeyRef: `local:${provider.id}` }, now());
  store.recordProviderCheckResult(provider.id, { ok: true, code: "ready", message: "Local fixture ready", checkedAt: now() });
  store.updateWorkspaceSettings({ mediaGenerationDefaults: { image: { kind: "provider", providerPresetId: provider.id } } }, now());
  const handler = createConversationMediaGenerationToolHandler({ store,
    storeRegistry: { getStore: () => store, mediaLocalExecutions: registry },
    secretResolver: { resolve: () => ({ configured: false }), status: () => ({ configured: false }) },
    runtimeSupervisor: supervisor, run, getExecutionContext: () => ({ localWriters: writers, hostOperationTracker: tracker }) });
  return { cwd, store, registry, run, source, tracker, writers, handler, requested, requests, release };
}

/** Fail the actual SQLite COMMIT (letting Core roll back), or throw after the writer's successful COMMIT. */
function injectFinishFault(store, fault) {
  const calls = { manifest: [], finalization: [], transport: [], parent: [] };
  let failures = 0;
  const wrap = (stage, original) => (...args) => {
    calls[stage].push(args);
    const fail = fault?.stage === stage && (fault.persistence === "persistent" || failures === 0);
    if (fail && fault.timing === "before") {
      const originalExec = store.database.exec;
      store.database.exec = function (sql) {
        if (/^COMMIT;?$/u.test(sql.trim())) { failures++; throw new Error(`synthetic_before_commit_${stage}`); }
        return originalExec.call(this, sql);
      };
      try { return original(...args); }
      finally { store.database.exec = originalExec; }
    }
    const result = original(...args);
    if (fail) { failures++; throw new Error(`synthetic_after_commit_${stage}`); }
    return result;
  };
  const manifest = store.recordHostMediaArtifactManifest.bind(store);
  store.recordHostMediaArtifactManifest = wrap("manifest", manifest);
  const finalize = store.finalizeHostMediaExecution.bind(store);
  store.finalizeHostMediaExecution = wrap("finalization", finalize);
  const settle = store.settleHostOperation.bind(store);
  const transport = wrap("transport", settle), parent = wrap("parent", settle);
  store.settleHostOperation = (...args) => args[1].kind === settlementKinds.transport ? transport(...args)
    : args[1].kind === settlementKinds.parent ? parent(...args) : settle(...args);
  return { calls, get failures() { return failures; } };
}

async function scenario(t, fault) {
  const f = await fixture(t), injection = injectFinishFault(f.store, fault);
  const response = f.handler({ runId: f.run.id, toolCallId: "receipt-finish-image", toolName: "image_generate",
    prompt: "One isolated fixture pixel", task: f.run.taskSnapshot, cwd: f.cwd });
  assert.equal(response.isError, undefined, JSON.stringify(response));
  await f.requested;
  f.tracker.executorGroup.closeAdmission(required);
  f.writers.close();
  f.release();
  await f.registry.waitForIdle(2000);
  await f.writers.waitForIdle(2000);
  const snapshot = f.tracker.executorGroup.getSnapshot();
  const operations = snapshot.operations.map(local => ({ local, row: f.store.getHostOperation(local.ticket.id) }));
  const parent = operations.find(({ row }) => !row.parentOperationId);
  const transport = operations.find(({ row }) => row.parentOperationId);
  assert.equal(operations.length, 2, "reconciliation must keep the two original operation scopes");
  assert.equal(transport.row.parentOperationId, parent.row.operationId);
  assert.equal(parent.row.evidenceRef.kind, "media_chain_execution");
  assert.equal(transport.row.evidenceRef.kind, "media_transport_execution");
  assert.equal(parent.row.evidenceRef.id, transport.row.evidenceRef.id);
  const execution = f.store.getHostMediaExecution(parent.row.evidenceRef.id);
  const effects = f.store.listHostMediaEffects(execution.executionId);
  const artifacts = f.store.listArtifacts(f.run.id);
  const seals = artifacts.filter(artifact => artifact.sealedPayload?.kind === "media_finalization_v1");
  const manifestSeals = artifacts.filter(artifact => artifact.sealedPayload?.kind === "media_manifest_v1");
  const child = f.store.getWorkUnitAttempt(execution.childFence.attemptId);
  const childUnit = f.store.getWorkUnit(execution.childFence.workUnitId);
  const job = f.store.getMediaJob(response.details.mediaJobId);
  const drain = await f.tracker.executorGroup.drain();
  const persistent = fault?.persistence === "persistent";
  const unconfirmedManifest = persistent && fault.stage === "manifest";
  t.diagnostic(JSON.stringify({ fault: fault ?? "baseline", failures: injection.failures, requests: f.requests,
    phases: [parent.row.phase, transport.row.phase], states: [parent.local.state, transport.local.state],
    drain: drain.status, business: job.status, finalization: Boolean(execution.finalizationArtifactId),
    writerCalls: Object.fromEntries(Object.entries(injection.calls).map(([stage, calls]) => [stage, calls.length])) }));

  assert.deepEqual(f.requests, [["POST", "/v1/images/generations"]], "receipt retries must never issue another physical POST");
  assert.equal(injection.failures, fault ? persistent ? 2 : 1 : 0, "the chosen fault must trigger and remain bounded");
  assert.equal(job.status, unconfirmedManifest ? "failed" : "succeeded", "receipt uncertainty cannot erase confirmed generated artifacts");
  assert.equal(child.status, unconfirmedManifest ? "failed" : "succeeded");
  assert.ok(child.endedAt, "the actual child Attempt must have reached its terminal state");
  assert.equal(childUnit.status, unconfirmedManifest ? "failed" : "succeeded");
  assert.equal(effects.length, 1, "bounded reconciliation cannot create another prepared effect");
  assert.ok(effects[0].launchedAt && effects[0].responseArtifactId);
  assert.equal(effects[0].noStartArtifactId, undefined, "an entered POST must never acquire a fake no-start proof");
  assert.equal(execution.submissionArtifactId, undefined, "synchronous image completion cannot invent a remote ACK");
  assert.equal(execution.terminalArtifactId, undefined, "synchronous image completion uses response, not remote terminal evidence");
  assert.equal(manifestSeals.length, 1, "manifest reconciliation must replay one original seal, never reseal or reclock");
  const manifest = manifestSeals[0];
  assert.equal(manifest.sealedPayload.outcome, "collected");
  assert.ok(manifest.sealedPayload.items.length > 0);
  const mediaArtifacts = f.store.listMediaJobArtifacts(job.id);
  assert.ok(mediaArtifacts.length > 0);
  assert.deepEqual(new Set(manifest.sealedPayload.items.map(item => item.artifactId)), new Set(mediaArtifacts.map(item => item.id)),
    "the original manifest must retain every committed artifact, including on persistent uncertainty");
  assert.deepEqual(new Set(job.artifactIds), new Set(mediaArtifacts.map(item => item.id)),
    "terminal success or failure must keep all committed artifact references");
  assert.equal(execution.manifestArtifactId, unconfirmedManifest && fault.timing === "before" ? undefined : manifest.id,
    "failed COMMIT rolls back binding; post-COMMIT errors must not erase its exact durable manifest");
  assert.equal(manifest.contentSha256, createHash("sha256").update(JSON.stringify(manifest.sealedPayload)).digest("hex"));
  assert.equal(seals.length, unconfirmedManifest ? 0 : 1, "unconfirmed manifest cannot proceed to another seal or finalization");
  const seal = seals[0];
  for (const receipt of [manifest, ...(seal ? [seal] : [])]) {
    assert.equal(receipt.contentSha256, createHash("sha256").update(JSON.stringify(receipt.sealedPayload)).digest("hex"));
    for (const [key, value] of Object.entries({ executionId: execution.executionId, executionIdentityDigest: execution.identityDigest,
      mediaJobId: job.id, executionGenerationId: execution.executionGenerationId, source: f.source,
      childFence: execution.childFence, namespaceDigest: execution.namespaceDigest, protocol: execution.protocol })) {
      assert.deepEqual(receipt.sealedPayload[key], value, `receipt must retain original ${key}`);
    }
  }
  if (seal) {
    assert.equal(seal.sealedPayload.manifestArtifactId, execution.manifestArtifactId);
    assert.deepEqual(seal.sealedPayload.effects, [{ effectId: effects[0].effectId, responseArtifactId: effects[0].responseArtifactId }]);
  }
  for (const [stage, calls] of Object.entries(injection.calls)) {
    const stopsBeforeStage = persistent && finishStages.indexOf(stage) > finishStages.indexOf(fault.stage);
    const expected = stopsBeforeStage ? 0 : fault?.stage === stage ? 2 : 1;
    assert.equal(calls.length, expected, `${stage} must be bounded and later scopes must not run after unconfirmed settlement`);
    if (calls.length === 2) {
      assert.equal(calls[1][0], calls[0][0], "replay must keep the exact opaque ticket, not a reconstructed capability");
      assert.equal(calls[1][1], calls[0][1], "replay must keep the same seal or same original settlement object");
    }
    for (const [, input] of calls) {
      if (stage === "manifest") assert.equal(input, manifest.id);
      else if (stage === "finalization") assert.equal(input, seal.id);
      else { assert.equal(input.kind, settlementKinds[stage]); assert.ok(Number.isFinite(Date.parse(input.settledAt))); }
    }
  }
  assert.equal(execution.finalizationArtifactId, unconfirmedManifest
    || persistent && fault.stage === "finalization" && fault.timing === "before"
    ? undefined : seal.id, "after-COMMIT exceptions cannot erase a committed immutable finalization");
  if (!persistent) {
    assert.deepEqual([parent.row.phase, transport.row.phase], ["safe", "safe"]);
    assert.deepEqual([parent.row.settlementKind, transport.row.settlementKind], [settlementKinds.parent, settlementKinds.transport]);
    assert.deepEqual([parent.local.state, transport.local.state], ["settled", "settled"]);
    assert.equal(drain.status, "settled", "a transient exception must reconcile durable facts and the original local barrier");
  } else {
    const parentSafe = fault.stage === "parent" && fault.timing === "after";
    const transportSafe = fault.stage === "parent" || fault.stage === "transport" && fault.timing === "after";
    // A failed settlement COMMIT leaves the original launched row while its
    // private ticket retains the exact safe intent. Unknown fallback cannot
    // rewrite that intent; the local barrier must still conservatively block.
    const parentRolledBack = fault.stage === "parent" && fault.timing === "before";
    const transportRolledBack = fault.stage === "transport" && fault.timing === "before";
    assert.equal(parent.row.phase, parentSafe ? "safe" : parentRolledBack ? "launched" : "unknown_outcome");
    assert.equal(transport.row.phase, transportSafe ? "safe" : transportRolledBack ? "launched" : "unknown_outcome");
    assert.equal(parent.local.state, "blocked", "partial durable facts cannot acknowledge an unconfirmed local parent");
    assert.equal(transport.local.state, fault.stage === "parent" ? "settled" : "blocked");
    assert.equal(drain.status, "blocked", "persistent failures must not release the required-input barrier");
    for (const [stage, { row }] of [["parent", parent], ["transport", transport]]) {
      if (row.phase === "safe") {
        const [, originalIntent] = injection.calls[stage][0];
        assert.equal(row.settlementKind, originalIntent.kind, "unknown fallback must not overwrite a durable safe fact");
        assert.equal(row.settledAt, originalIntent.settledAt, "after-COMMIT replay must not reclock settlement");
      }
      assert.notEqual(row.settlementKind, "known_no_start");
    }
  }
}

test("actual Media receipt finalization baseline settles the two original scopes", { timeout: 8000 }, t => scenario(t));
for (const stage of finishStages) {
  for (const timing of ["before", "after"]) {
    for (const persistence of ["once", "persistent"]) {
      test(`actual Media receipt ${stage}: ${persistence} exception ${timing} COMMIT`, { timeout: 8000 },
        t => scenario(t, { stage, timing, persistence }));
    }
  }
}
