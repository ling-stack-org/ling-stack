import assert from "node:assert/strict";
import test from "node:test";
import { processNextRunEvaluationTask, RunEvaluationTaskWorkerRegistry } from "../dist/index.js";
import { copyQaModelJson, qaModelRecord } from "../dist/features/harness/evaluations/qa-model-json.js";
import { createRunEvaluationQaModelConfiguration, preparedRunEvaluationQaModelFacts,
  runEvaluationQaModelConfigurationSnapshot } from "../dist/features/harness/evaluations/qa-model-preparation.js";
import { admitRunEvaluationQaModelTransport, createRunEvaluationQaModelTransport, executeRunEvaluationQaModelTransport,
  runEvaluationQaModelSuccessFacts } from "../dist/features/harness/evaluations/qa-model-transport.js";
import { completion, fixture, now, expired, ownedServer, preparedTransport } from "./fixtures/run-evaluation-qa-model.mjs";
import { createRunEvaluationQaModelHostAdapter } from "../dist/features/harness/evaluations/qa-model-coordinator.js";
import { createRunEvaluationQaOwnedModelBatch, runEvaluationQaOwnedModelBatchFacts,
  createRunEvaluationQaProviderCurrentness } from "../dist/features/harness/evaluations/qa-model-owned-batch.js";
import { resolveProviderForRun } from "../dist/features/runs/providers.js";

const options = (f, extra = {}) => ({ store: f.store, workerId: "owned-qa-worker", hostAdapter: f.adapter(), clock: () => now, ...extra });
const taskAttempt = f => f.store.getRunEvaluationTaskAttempt(f.store.getRunEvaluationTask(f.task.id).activeAttemptId);
const requestRows = f => f.database.prepare("SELECT * FROM run_evaluation_qa_requests ORDER BY id").all();
const expectUnknown = f => {
  assert.equal(f.store.getRunEvaluationTask(f.task.id).state, "unknown_outcome");
  assert.equal(taskAttempt(f).state, "unknown_outcome");
  assert.equal(f.store.getRunEvaluationQaScope().laneState, "quarantined");
  assert.equal(requestRows(f).length, 1);
  assert.equal(requestRows(f)[0].state, "unknown");
  assert.equal(requestRows(f)[0].released_at, null);
  assert.equal(f.store.getRunEvaluationTaskResult(f.task.id), undefined);
};

test("own-data schema supports full optional shapes but refuses getters, unknown authority and over-budget trees", () => {
  const shape = qaModelRecord(completion(), ["model", "choices"], ["id", "object", "created", "usage", "system_fingerprint", "service_tier"]);
  assert.equal(shape.id, "chatcmpl-owned-qa");
  assert.equal(shape.usage.total_tokens, 120);
  assert.throws(() => qaModelRecord({ ...completion(), authenticated: true }, ["model", "choices"], ["id"]));
  let reads = 0;
  assert.throws(() => qaModelRecord({ get model() { reads += 1; return "fixture"; }, choices: [] }, ["model", "choices"]));
  assert.equal(reads, 0);
  assert.throws(() => copyQaModelJson({ value: "x".repeat(32_768) }));
  assert.throws(() => copyQaModelJson(Array.from({ length: 1_025 }, () => 0)));
  assert.throws(() => copyQaModelJson({ toJSON() { assert.fail("toJSON must not run"); } }));
});

test("real owned HTTP + SQLite completes unverified repeat with actual usage, no monetary fiction and real drain", async t => {
  const server = await ownedServer(t);
  const f = await fixture(t, server.baseUrl);
  let sawHeld = false;
  const release = f.store.releaseRunEvaluationQaLane.bind(f.store);
  f.store.releaseRunEvaluationQaLane = input => {
    assert.equal(f.store.getRunEvaluationQaScope().laneState, "held");
    assert.equal(f.store.getRunEvaluationQaRequest(input.requestId).state, "completed");
    sawHeld = true;
    return release(input);
  };
  assert.deepEqual(await processNextRunEvaluationTask(options(f)), { disposition: "completed", taskId: f.task.id });
  assert.equal(sawHeld, true);
  assert.equal(server.requests.length, 1);
  const captured = server.requests[0];
  assert.equal(captured.path, "/v1/chat/completions");
  assert.equal(captured.headers.authorization, "Bearer owned-loopback-fake-key");
  assert.equal(captured.headers["x-owned-qa"], "fixture");
  const body = JSON.parse(captured.body);
  assert.deepEqual(Object.keys(body).sort(), ["max_tokens", "messages", "model", "stream"]);
  assert.equal(body.max_tokens, 1024); assert.equal(body.stream, false);
  assert.deepEqual(body.messages.map(item => item.role), ["system", "user"]);
  assert.ok(Buffer.byteLength(captured.body) <= 8_000);
  const result = f.store.getRunEvaluationTaskResult(f.task.id);
  assert.equal(result.authority, "unverified");
  assert.equal(result.costInputTokens, 100); assert.equal(result.costOutputTokens, 20); assert.equal(result.costAmountMicros, undefined);
  assert.equal(result.score, 0.9); assert.equal(result.severity, "info");
  const request = f.store.getRunEvaluationQaRequest(requestRows(f)[0].id);
  assert.equal(request.receipt.transport, "owned_openai_chat_completions");
  assert.equal(request.releaseKind, "host_callback_drained");
  assert.equal(request.usage.state, "measured");
  assert.equal(f.store.getRunEvaluationQaScope().laneState, "available");
  const persisted = JSON.stringify(request) + JSON.stringify(result) + JSON.stringify(runEvaluationQaModelConfigurationSnapshot(f.configuration));
  assert.equal(persisted.includes("owned-loopback-fake-key"), false);
  assert.equal(persisted.includes("Bearer"), false);
  assert.equal(requestRows(f)[0].payload_utf8, undefined);
  assert.equal((await processNextRunEvaluationTask(options(f))).disposition, "idle");
  assert.equal(server.requests.length, 1);
});

test("both reviewed output-cap modes and authHeader=false preserve exact Host intent", async t => {
  for (const kind of ["anonymous", "custom-authorization", "completion-total"]) await t.test(kind, async t => {
    const server = await ownedServer(t);
    const auth = { authHeader: false, headers: kind === "custom-authorization" ? { authorization: "Owned-Custom fixture" } : {} };
    const f = await fixture(t, server.baseUrl, kind === "completion-total"
      ? { outputTokenField: "max_completion_tokens", outputCapCapability: "max_completion_tokens_total" } : {}, {}, auth);
    assert.equal((await processNextRunEvaluationTask(options(f))).disposition, "completed");
    assert.equal(server.requests[0].headers.authorization, kind === "custom-authorization" ? "Owned-Custom fixture" : undefined);
    const body = JSON.parse(server.requests[0].body);
    assert.equal(body[kind === "completion-total" ? "max_completion_tokens" : "max_tokens"], 1024);
    assert.equal(body[kind === "completion-total" ? "max_tokens" : "max_completion_tokens"], undefined);
  });
});

test("usage absence remains unknown while a complete valid response may finish", async t => {
  const response = completion(); delete response.usage;
  const server = await ownedServer(t, (_req, res) => res.end(JSON.stringify(response)));
  const f = await fixture(t, server.baseUrl);
  assert.equal((await processNextRunEvaluationTask(options(f))).disposition, "completed");
  const result = f.store.getRunEvaluationTaskResult(f.task.id);
  assert.equal(result.costInputTokens, undefined); assert.equal(result.costOutputTokens, undefined); assert.equal(result.costAmountMicros, undefined);
  assert.deepEqual(f.store.getRunEvaluationQaRequest(requestRows(f)[0].id).usage, { state: "unknown" });
});

test("HTTP/finish/tool/schema/usage failures consume one charge and remain quarantined after callback drain", async t => {
  const responses = {
    status: (_req, res) => { res.statusCode = 503; res.end("unavailable"); },
    redirect: (_req, res) => { res.statusCode = 302; res.setHeader("location", "/do-not-follow"); res.end(); },
    partial: (_req, res) => { res.setHeader("content-length", "2000"); res.write("{\"model\":"); res.destroy(); },
    truncated: (_req, res) => res.end("{\"model\":\"qa-fixture-model\","),
    oversized: (_req, res) => res.end("x".repeat(65_537)),
    length_finish: (_req, res) => { const value = completion(); value.choices[0].finish_reason = "length"; res.end(JSON.stringify(value)); },
    model_alias: (_req, res) => res.end(JSON.stringify(completion({ model: "unexpected-model" }))),
    tool_call: (_req, res) => { const value = completion(); value.choices[0].message.tool_calls = [{ id: "tool", type: "function" }]; res.end(JSON.stringify(value)); },
    authority: (_req, res) => { const value = completion(); value.choices[0].message.content = JSON.stringify({ schemaVersion: 1, verdict: "pass", rationale: "fixture", authenticated: true }); res.end(JSON.stringify(value)); },
    score: (_req, res) => { const value = completion(); value.choices[0].message.content = JSON.stringify({ schemaVersion: 1, verdict: "pass", rationale: "fixture", score: 2 }); res.end(JSON.stringify(value)); },
    usage_null: (_req, res) => res.end(JSON.stringify(completion({ usage: null }))),
    usage_negative: (_req, res) => res.end(JSON.stringify(completion({ usage: { prompt_tokens: -1, completion_tokens: 1, total_tokens: 0 } }))),
    usage_inconsistent: (_req, res) => res.end(JSON.stringify(completion({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 3 } }))),
    usage_missing: (_req, res) => res.end(JSON.stringify(completion({ usage: { prompt_tokens: 1, total_tokens: 2 } }))),
    usage_fractional: (_req, res) => res.end(JSON.stringify(completion({ usage: { prompt_tokens: 0.5, completion_tokens: 1, total_tokens: 1.5 } }))),
    usage_cap: (_req, res) => res.end(JSON.stringify(completion({ usage: { prompt_tokens: 1, completion_tokens: 1025, total_tokens: 1026 } }))),
    usage_detail: (_req, res) => res.end(JSON.stringify(completion({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, completion_tokens_details: { reasoning_tokens: 2 } } }))),
    depth: (_req, res) => { let nested = null; for (let i = 0; i < 26; i++) nested = { nested }; res.end(JSON.stringify(completion({ system_fingerprint: nested }))); },
  };
  for (const [name, handler] of Object.entries(responses)) await t.test(name, async t => {
    const server = await ownedServer(t, handler);
    const f = await fixture(t, server.baseUrl);
    assert.equal((await processNextRunEvaluationTask(options(f))).disposition, "unknown");
    expectUnknown(f);
    assert.equal(server.requests.length, 1);
    f.enroll(2);
    const deferred = await processNextRunEvaluationTask(options(f));
    assert.equal(deferred.disposition, "deferred"); assert.equal(deferred.reason, "qa_lane_quarantined");
    assert.equal(server.requests.length, 1); assert.equal(requestRows(f).length, 1);
  });
});

test("preparation is private and one prepared handle cannot mint a second transport or send without durable admission", async t => {
  const server = await ownedServer(t);
  const f = await fixture(t, server.baseUrl);
  const p = await preparedTransport(f);
  assert.throws(() => preparedRunEvaluationQaModelFacts({}), /untrusted/);
  assert.throws(() => preparedRunEvaluationQaModelFacts(JSON.parse(JSON.stringify(p.prepared))), /untrusted/);
  assert.throws(() => createRunEvaluationQaModelTransport({ prepared: p.prepared, provider: f.provider, store: f.store, batchId: f.batch.id }), /already_bound/);
  const controller = new AbortController();
  await assert.rejects(executeRunEvaluationQaModelTransport(p.transport, { taskId: p.claim.task.id, attemptId: p.claim.attempt.id,
    invocationId: "pretend-admitted", signal: controller.signal }), /untrusted_or_used/);
  assert.equal(server.requests.length, 0); assert.equal(requestRows(f).length, 0);
  const admitted = admitRunEvaluationQaModelTransport(p.transport, p.fence(p.claim)); assert.equal(admitted.ok, true);
  const args = { taskId: p.claim.task.id, attemptId: p.claim.attempt.id, invocationId: admitted.value.attempt.invocationId, signal: controller.signal };
  const success = await executeRunEvaluationQaModelTransport(p.transport, args);
  assert.equal(runEvaluationQaModelSuccessFacts(p.transport, success).receipt.usage.outputTokens, 20);
  assert.throws(() => runEvaluationQaModelSuccessFacts(p.transport, { authenticated: true, receipt: {} }), /untrusted/);
  assert.throws(() => runEvaluationQaModelSuccessFacts(p.transport, JSON.parse(JSON.stringify(success))), /untrusted/);
  await assert.rejects(executeRunEvaluationQaModelTransport(p.transport, args), /untrusted_or_used/);
  assert.equal(server.requests.length, 1); assert.equal(requestRows(f).length, 1);
});

test("admission replay grants no fetch permission and cannot release another callback's lane", async t => {
  const server = await ownedServer(t);
  const f = await fixture(t, server.baseUrl);
  const admit = f.store.admitRunEvaluationQaRequest.bind(f.store);
  f.store.admitRunEvaluationQaRequest = input => {
    const first = admit(input); assert.equal(first.ok, true);
    const replay = admit({ ...input, expectedTaskRevision: first.value.task.revision, expectedAttemptRevision: first.value.attempt.revision });
    assert.equal(replay.ok, true); assert.equal(replay.value.mayDispatch, false); return replay;
  };
  assert.equal((await processNextRunEvaluationTask(options(f))).disposition, "claim_lost");
  assert.equal(server.requests.length, 0); assert.equal(requestRows(f).length, 1);
  assert.equal(f.store.getRunEvaluationQaScope().laneState, "held");
});

test("non-enrolled ordinary repeats and mismatched reviewed pins never read sealed evidence or credentials", async t => {
  for (const kind of ["ordinary", "pins"]) await t.test(kind, async t => {
    const server = await ownedServer(t);
    const f = await fixture(t, server.baseUrl);
    const getEnrollment = f.store.getRunEvaluationQaEnrollment.bind(f.store);
    f.store.getRunEvaluationQaEnrollment = id => kind === "ordinary" ? undefined : {
      ...getEnrollment(id), artifactPins: { ...f.artifactPins, candidate: { ...f.artifactPins.candidate, artifactId: "not-reviewed" } } };
    let materialized = 0; let artifactReads = 0;
    const originalAdapter = f.adapter({ materializeProvider: () => { materialized++; return f.provider; } });
    let preparing = false;
    const adapter = { ...originalAdapter, prepare: async input => {
      preparing = true; try { return await originalAdapter.prepare(input); } finally { preparing = false; }
    } };
    const read = f.store.getArtifact.bind(f.store);
    f.store.getArtifact = id => { if (preparing) { artifactReads++; assert.fail("unreviewed content must not be read"); } return read(id); };
    const result = await processNextRunEvaluationTask(options(f, { hostAdapter: adapter }));
    assert.equal(result.disposition, kind === "ordinary" ? "idle" : "failed");
    assert.equal(artifactReads, 0); assert.equal(materialized, 0); assert.equal(server.requests.length, 0); assert.equal(requestRows(f).length, 0);
  });
});

test("bounded wire preparation and provider changes fail before request admission", async t => {
  for (const kind of ["oversize", "provider-change", "config-getter", "endpoint-token", "endpoint-invalid", "cap-mismatch"]) await t.test(kind, async t => {
    const server = await ownedServer(t);
    const f = await fixture(t, server.baseUrl, {}, kind === "oversize" ? { body: "x".repeat(10_000) } : {});
    if (kind === "config-getter") {
      let getter = 0;
      assert.throws(() => createRunEvaluationQaModelConfiguration({ ...f.configurationInput, get modelId() { getter++; return "qa-fixture-model"; } }));
      assert.equal(getter, 0); return;
    }
    if (kind.startsWith("endpoint") || kind === "cap-mismatch") {
      assert.throws(() => createRunEvaluationQaModelConfiguration({ ...f.configurationInput,
        ...(kind === "cap-mismatch" ? { outputTokenField: "max_completion_tokens" } : { baseUrl: kind === "endpoint-token" ? "https://fixture.invalid/v1?key=must-not-store" : "not a url" }) }));
      return;
    }
    const result = await processNextRunEvaluationTask(options(f, { hostAdapter: f.adapter({ materializeProvider: () =>
      kind === "provider-change" ? { ...f.provider, modelId: "new-model" } : f.provider }) }));
    assert.equal(result.disposition, "failed"); assert.equal(server.requests.length, 0); assert.equal(requestRows(f).length, 0);
  });
});

test("pre-admission cancellation, async artifact/provider and synchronous descriptor/clock reentry cannot dispatch", async t => {
  for (const kind of ["pre-abort", "artifact-await", "provider-await", "descriptor", "clock"]) await t.test(kind, async t => {
    const server = await ownedServer(t);
    const f = await fixture(t, server.baseUrl);
    const controller = new AbortController();
    const getArtifact = f.store.getArtifact.bind(f.store);
    if (kind === "pre-abort") controller.abort();
    let preparing = false;
    if (kind === "artifact-await") f.store.getArtifact = id => {
      if (!preparing) return getArtifact(id);
      return Promise.resolve().then(() => { f.store.getArtifact = getArtifact; controller.abort(); return getArtifact(id); });
    };
    if (kind === "descriptor") f.store.getArtifact = id => {
      controller.abort(); return new Proxy(getArtifact(id), { getOwnPropertyDescriptor(target, key) { return Object.getOwnPropertyDescriptor(target, key); } });
    };
    const originalAdapter = f.adapter({ materializeProvider: async () => { await Promise.resolve(); if (kind === "provider-await") controller.abort(); return f.provider; } });
    const adapter = { ...originalAdapter, prepare: input => { preparing = true; return originalAdapter.prepare(input); } };
    const result = await processNextRunEvaluationTask(options(f, { hostAdapter: adapter, signal: controller.signal,
      ...(kind === "clock" ? { clock: () => { controller.abort(); return now; } } : {}) }));
    assert.equal(result.disposition, ["pre-abort", "clock"].includes(kind) ? "stopped" : "cancelled");
    assert.equal(server.requests.length, 0); assert.equal(requestRows(f).length, 0);
  });
});

test("post-admission cancel and expired dispatch lease produce zero fetch but non-refundable quarantine", async t => {
  for (const kind of ["cancel", "dispatch-clock-expired", "dispatch-store-reentry", "admit-committed-throw"]) await t.test(kind, async t => {
    const server = await ownedServer(t);
    const f = await fixture(t, server.baseUrl);
    const controller = new AbortController();
    const admit = f.store.admitRunEvaluationQaRequest.bind(f.store);
    let admitted = false;
    f.store.admitRunEvaluationQaRequest = input => { const result = admit(input); admitted = result.ok;
      if (kind === "admit-committed-throw") throw new Error("fixture_after_commit_fault");
      if (kind === "cancel") controller.abort(); return result; };
    if (kind === "dispatch-store-reentry") {
      const read = f.store.getRunEvaluationQaRequest.bind(f.store);
      f.store.getRunEvaluationQaRequest = id => { const result = read(id); if (admitted) controller.abort(); return result; };
    }
    const adapter = f.adapter(kind === "dispatch-clock-expired" ? { clock: () => expired } : {});
    const result = await processNextRunEvaluationTask(options(f, { hostAdapter: adapter, signal: controller.signal,
      ...(kind === "dispatch-clock-expired" ? { clock: () => admitted ? expired : now } : {}) }));
    assert.equal(result.disposition, "unknown"); expectUnknown(f); assert.equal(server.requests.length, 0);
  });
});

test("final synchronous credential callback cannot quarantine or advance a lease after the last admission gate", async t => {
  for (const kind of ["quarantine", "lease"]) await t.test(kind, async t => {
    const server = await ownedServer(t);
    const f = await fixture(t, server.baseUrl);
    let admitted = false; let callback = false; let currentTime = now;
    const admit = f.store.admitRunEvaluationQaRequest.bind(f.store);
    f.store.admitRunEvaluationQaRequest = input => { const result = admit(input); admitted = result.ok; return result; };
    f.setCredentialCurrent(() => {
      if (!admitted || callback) return;
      callback = true;
      if (kind === "lease") { currentTime = expired; return; }
      const task = f.store.getRunEvaluationTask(f.task.id);
      const attempt = f.store.getRunEvaluationTaskAttempt(task.activeAttemptId);
      const marked = f.store.markRunEvaluationQaRequestUnknown({ requestId: f.store.getRunEvaluationQaScope().laneRequestId,
        taskId: task.id, attemptId: attempt.id, expectedTaskRevision: task.revision, expectedAttemptRevision: attempt.revision,
        claimOwner: attempt.claimOwner, claimToken: attempt.claimToken, now });
      assert.equal(marked.ok, true);
    });
    const result = await processNextRunEvaluationTask(options(f, { clock: () => currentTime,
      hostAdapter: f.adapter({ clock: () => currentTime }) }));
    assert.equal(callback, true); assert.equal(result.disposition, "unknown"); expectUnknown(f);
    assert.equal(server.requests.length, 0);
  });
});

test("timeout or user abort during an owned body drains locally yet never auto-releases unknown remote outcome", async t => {
  for (const kind of ["timeout", "abort"]) await t.test(kind, async t => {
    const controller = new AbortController();
    const server = await ownedServer(t, (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" }); res.write("{");
      if (kind === "abort") controller.abort();
    });
    const f = await fixture(t, server.baseUrl);
    assert.equal((await processNextRunEvaluationTask(options(f, { signal: controller.signal,
      hostAdapter: f.adapter({ transportTimeoutMs: 50 }), executionTimeoutMs: 2_000 }))).disposition, "unknown");
    expectUnknown(f); assert.equal(server.requests.length, 1);
    f.enroll(2);
    assert.equal((await processNextRunEvaluationTask(options(f))).reason, "qa_lane_quarantined");
    assert.equal(server.requests.length, 1);
  });
});

test("atomic settlement rejection or forged success never creates a completed repeat", async t => {
  for (const kind of ["reject", "forged", "artifact-abort"]) await t.test(kind, async t => {
    const server = await ownedServer(t);
    const f = await fixture(t, server.baseUrl);
    const controller = new AbortController();
    let adapter = f.adapter();
    if (kind === "reject") f.store.completeRunEvaluationQaRequest = () => ({ ok: false, code: "stale_revision" });
    if (kind === "forged") {
      const prepare = adapter.prepare.bind(adapter);
      adapter = { ...adapter, prepare: async input => { const execution = await prepare(input); return { ...execution,
        execute: () => ({ authenticated: true, output: { verdict: "pass" }, receipt: {} }) }; } };
    }
    if (kind === "artifact-abort") {
      const create = f.store.createArtifact.bind(f.store);
      f.store.createArtifact = input => { const artifact = create(input); controller.abort(); return artifact; };
    }
    const result = await processNextRunEvaluationTask(options(f, { hostAdapter: adapter, signal: controller.signal }));
    assert.equal(result.disposition, "unknown"); expectUnknown(f);
    assert.equal(server.requests.length, kind === "forged" ? 0 : 1);
  });
});

test("synchronous atomic successful settlement wins transaction-internal cancel without nested unknown writes", async t => {
  const server = await ownedServer(t);
  const f = await fixture(t, server.baseUrl);
  const controller = new AbortController();
  const read = f.store.getArtifact.bind(f.store);
  let reentered = false;
  f.store.getArtifact = id => {
    if (id.startsWith("evaluation_qa_output_") && !reentered) { reentered = true; controller.abort(); }
    return read(id);
  };
  let drains = 0;
  const release = f.store.releaseRunEvaluationQaLane.bind(f.store);
  f.store.releaseRunEvaluationQaLane = input => { drains++; return release(input); };
  const result = await processNextRunEvaluationTask(options(f, { signal: controller.signal }));
  assert.equal(reentered, true);
  assert.deepEqual(result, { disposition: "completed", taskId: f.task.id });
  assert.equal(f.store.getRunEvaluationTask(f.task.id).state, "completed");
  assert.equal(f.store.getRunEvaluationTaskResult(f.task.id).verdict, "pass");
  assert.equal(f.store.getRunEvaluationQaRequest(requestRows(f)[0].id).state, "completed");
  assert.equal(f.store.getRunEvaluationQaScope().laneState, "available");
  assert.equal(drains, 1); assert.equal(server.requests.length, 1); assert.equal(requestRows(f).length, 1);
});

test("batch exhaustion defers with an unadmitted claim and registry never immediately busy-loops", async t => {
  const server = await ownedServer(t);
  const f = await fixture(t, server.baseUrl);
  f.enroll(2); f.enroll(3); f.enroll(4);
  for (let i = 0; i < 3; i++) assert.equal((await processNextRunEvaluationTask(options(f))).disposition, "completed");
  let dispositions = [];
  const adapter = f.adapter();
  let prepares = 0;
  const wrapped = { ...adapter, prepare: async input => { prepares++; return adapter.prepare(input); } };
  const registry = new RunEvaluationTaskWorkerRegistry({ enabled: true, hostAdapter: wrapped, clock: () => now, scanIntervalMs: 1_000,
    onError: error => dispositions.push(error) });
  registry.registerStore(f.cwd, f.store);
  await registry.waitForIdle();
  registry.beginShutdown(); await registry.waitForIdle();
  assert.equal(prepares, 1); assert.deepEqual(dispositions, []);
  assert.equal(server.requests.length, 3); assert.equal(requestRows(f).length, 3);
  const unadmitted = f.database.prepare("SELECT task_id FROM run_evaluation_task_attempts WHERE state='claimed'").all();
  assert.equal(unadmitted.length, 1);
  assert.equal(f.store.getRunEvaluationTask(unadmitted[0].task_id).state, "active");
});

test("registry lifetime includes asynchronous preparation, actual callback must drain before idle", async t => {
  const server = await ownedServer(t);
  const f = await fixture(t, server.baseUrl);
  let release; let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const materialized = new Promise(resolve => { release = resolve; });
  const adapter = f.adapter({ materializeProvider: () => { entered(); return materialized; } });
  const registry = new RunEvaluationTaskWorkerRegistry({ enabled: true, hostAdapter: adapter, clock: () => now });
  registry.registerStore(f.cwd, f.store);
  await started;
  registry.beginShutdown();
  let idle = false;
  const draining = registry.waitForIdle().then(() => { idle = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(idle, false); assert.equal(requestRows(f).length, 0); assert.equal(server.requests.length, 0);
  release(f.provider); await draining;
  assert.equal(idle, true); assert.equal(f.store.getRunEvaluationTask(f.task.id).state, "cancelled");
  assert.equal(server.requests.length, 0); assert.equal(requestRows(f).length, 0);
});

test("owned activation refuses forged/saved tokens and credential rotation cannot silently resume an old batch", async t => {
  for (const kind of ["key", "header", "host-generation", "unknown-proof", "during-evidence", "final-generation"]) await t.test(kind, async t => {
    const server = await ownedServer(t);
    const f = await fixture(t, server.baseUrl);
    assert.throws(() => createRunEvaluationQaModelHostAdapter({ store: f.store, ownedBatch: f.batch }), /activation_untrusted/);
    assert.throws(() => runEvaluationQaOwnedModelBatchFacts(JSON.parse(JSON.stringify(f.ownedBatch))), /activation_untrusted/);
    let revision = 1;
    f.setCredentialCurrent(() => { if (revision !== 1) throw new Error("fixture_host_generation_unknown_or_changed"); });
    if (kind === "host-generation" || kind === "unknown-proof") revision = 2;
    if (kind === "key") f.setMaterializeProvider(() => ({ ...f.provider, apiKey: "owned-loopback-rotated-key" }));
    if (kind === "header") f.setMaterializeProvider(() => ({ ...f.provider, headers: { "x-owned-qa": "rotated" } }));
    if (kind === "during-evidence") {
      const read = f.store.getArtifact.bind(f.store);
      f.store.getArtifact = id => { const artifact = read(id); if (id === f.artifactPins.candidate.artifactId) revision = 2; return artifact; };
    }
    let admitted = false;
    const admit = f.store.admitRunEvaluationQaRequest.bind(f.store);
    if (kind === "final-generation") f.store.admitRunEvaluationQaRequest = input => { const result = admit(input); admitted = result.ok; revision = 2; return result; };
    const result = await processNextRunEvaluationTask(options(f));
    assert.equal(server.requests.length, 0);
    if (admitted) { assert.equal(result.disposition, "unknown"); expectUnknown(f); }
    else { assert.ok(["failed", "claim_lost"].includes(result.disposition)); assert.equal(requestRows(f).length, 0); }
  });
});

test("fresh owned activation cancellation creates no request authority or charge", async t => {
  const server = await ownedServer(t);
  const f = await fixture(t, server.baseUrl);
  const controller = new AbortController();
  const count = () => f.database.prepare("SELECT count(*) AS n FROM run_evaluation_qa_batches").get().n;
  const before = count();
  await assert.rejects(createRunEvaluationQaOwnedModelBatch({ store: f.store, qaWorkspaceCwd: f.cwd, configuration: f.configuration,
    configSnapshotRef: f.configArtifact.id, now, signal: controller.signal, assertCredentialCurrent() {},
    materializeProvider: async () => { await Promise.resolve(); controller.abort(); return f.provider; } }), /activation_cancelled/);
  await assert.rejects(createRunEvaluationQaOwnedModelBatch({ store: f.store, qaWorkspaceCwd: f.cwd, configuration: f.configuration,
    configSnapshotRef: f.configArtifact.id, now, assertCredentialCurrent() {},
    materializeProvider: () => { throw new Error("private_owned_fixture_do_not_echo"); } }), error => {
    assert.equal(error.message, "evaluation_qa_activation_rejected"); return true;
  });
  assert.equal(count(), before); assert.equal(requestRows(f).length, 0); assert.equal(server.requests.length, 0);
});

test("production credential checker reuses original D1 authority and rejects same-value managed revision or cloned/new-store proof", async t => {
  const server = await ownedServer(t);
  const f = await fixture(t, server.baseUrl);
  let preset = f.store.createProviderPreset({ kind: "openai-compatible", displayName: "Owned D1 fixture", providerId: "owned-loopback",
    model: "qa-fixture-model", api: "openai-completions", baseUrl: server.baseUrl,
    headers: { "x-owned-qa": "fixture" }, capabilities: ["chat"], enabled: true }, now);
  f.store.setProviderSecret(preset.id, "owned-loopback-fake-key", now);
  preset = f.store.updateProviderPreset(preset.id, { apiKeyRef: `local:${preset.id}` }, now);
  const secretResolver = { status() { assert.fail("managed fixture must not read external keys"); }, resolve() { assert.fail("managed fixture must not resolve external keys"); } };
  const originalProvider = resolveProviderForRun(f.store, { providerPresetId: preset.id, skipProviderPreflight: true }, secretResolver);
  const configuration = createRunEvaluationQaModelConfiguration({ ...f.configurationInput, providerPresetId: preset.id,
    configRevision: f.store.getProviderConfigurationSnapshot(preset.id).configRevision });
  const checker = createRunEvaluationQaProviderCurrentness({ store: f.store, originalProvider, configuration, secretResolver });
  assert.doesNotThrow(checker);
  assert.throws(() => createRunEvaluationQaProviderCurrentness({ store: f.store, originalProvider: { ...originalProvider }, configuration, secretResolver }), /scope_untrusted/);
  assert.throws(() => createRunEvaluationQaProviderCurrentness({ store: new Proxy(f.store, {}), originalProvider, configuration, secretResolver }), /scope_untrusted/);
  const otherServer = await ownedServer(t);
  const batchesBefore = f.database.prepare("SELECT count(*) AS n FROM run_evaluation_qa_batches").get().n;
  for (const changed of [{ baseUrl: otherServer.baseUrl }, { providerId: "miswired-provider" }]) {
    const miswired = createRunEvaluationQaModelConfiguration({ ...f.configurationInput, providerPresetId: preset.id,
      configRevision: f.store.getProviderConfigurationSnapshot(preset.id).configRevision, ...changed });
    assert.throws(() => createRunEvaluationQaProviderCurrentness({ store: f.store, originalProvider, configuration: miswired, secretResolver }), /scope_untrusted/);
  }
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM run_evaluation_qa_batches").get().n, batchesBefore);
  assert.equal(otherServer.requests.length, 0);
  f.store.setProviderSecret(preset.id, "owned-loopback-fake-key", expired);
  assert.throws(checker, /credentials_changed/);
  assert.equal(server.requests.length, 0); assert.equal(requestRows(f).length, 0);
});

test("new owned batch retains the namespace's existing non-refundable charges", async t => {
  const server = await ownedServer(t);
  const f = await fixture(t, server.baseUrl);
  assert.equal((await processNextRunEvaluationTask(options(f))).disposition, "completed");
  const before = f.store.getRunEvaluationQaScope();
  const newOwnedBatch = await createRunEvaluationQaOwnedModelBatch({ store: f.store, qaWorkspaceCwd: f.cwd,
    configuration: f.configuration, configSnapshotRef: f.configArtifact.id, now,
    materializeProvider: () => f.provider, assertCredentialCurrent() {} });
  const newBatch = runEvaluationQaOwnedModelBatchFacts(newOwnedBatch);
  assert.notEqual(newBatch.id, f.batch.id); assert.equal(newBatch.namespaceId, before.namespaceId);
  const enrolled = f.store.enrollRunEvaluationQaTask({ evaluationId: f.evaluation.id, evaluationKey: f.evaluation.idempotencyKey,
    frozenGraderArtifact: f.pin(f.frozen), frozenGraderDigest: f.configFacts.frozenGraderDigest, repeatOrdinal: 2,
    batchId: newBatch.id, reviewRef: "explicit-new-owned-activation", artifactPins: f.artifactPins, now });
  assert.equal(enrolled.ok, true);
  const adapter = createRunEvaluationQaModelHostAdapter({ store: f.store, ownedBatch: newOwnedBatch, clock: () => now });
  assert.equal((await processNextRunEvaluationTask(options(f, { hostAdapter: adapter }))).disposition, "completed");
  assert.equal(requestRows(f).length, 2); assert.equal(server.requests.length, 2);
  assert.equal(f.store.getRunEvaluationQaScope().namespaceId, before.namespaceId);
});

test("current QA batch queue bypasses more than 100 older ordinary/old-batch tasks without claiming them", async t => {
  const server = await ownedServer(t);
  const f = await fixture(t, server.baseUrl);
  const older = "2026-10-10T00:00:30.000Z";
  const oldIds = [];
  for (let ordinal = 2; ordinal <= 102; ordinal++) {
    const enqueued = f.store.enqueueRunEvaluationTask({ evaluationId: f.evaluation.id, evaluationKey: f.evaluation.idempotencyKey,
      frozenGraderArtifact: f.pin(f.frozen), frozenGraderDigest: f.configFacts.frozenGraderDigest, repeatOrdinal: ordinal, now: older });
    assert.equal(enqueued.ok, true); oldIds.push(enqueued.value.id);
  }
  const oldBatchResult = f.store.createRunEvaluationQaBatch({ configSnapshotRef: f.configArtifact.id, configDigest: f.configFacts.configDigest, now: older });
  assert.equal(oldBatchResult.ok, true);
  const oldEnrolled = f.store.enrollRunEvaluationQaTask({ evaluationId: f.evaluation.id, evaluationKey: f.evaluation.idempotencyKey,
    frozenGraderArtifact: f.pin(f.frozen), frozenGraderDigest: f.configFacts.frozenGraderDigest, repeatOrdinal: 103,
    batchId: oldBatchResult.value.id, reviewRef: "old-batch-host-review", artifactPins: f.artifactPins, now: older });
  assert.equal(oldEnrolled.ok, true); oldIds.push(oldEnrolled.value.taskId);
  let claims = [];
  const claim = f.store.claimRunEvaluationTask.bind(f.store);
  f.store.claimRunEvaluationTask = input => { claims.push(input.taskId); return claim(input); };
  assert.deepEqual(await processNextRunEvaluationTask(options(f)), { disposition: "completed", taskId: f.task.id });
  assert.deepEqual(claims, [f.task.id]); assert.equal(server.requests.length, 1); assert.equal(requestRows(f).length, 1);
  for (const id of oldIds) { const task = f.store.getRunEvaluationTask(id); assert.equal(task.state, "queued"); assert.equal(task.activeAttemptId, undefined); }
});
