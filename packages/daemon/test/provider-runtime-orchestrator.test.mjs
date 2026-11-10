import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, resolveStoragePaths } from "@ling-stack/core";
import { appendChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import { isRunEventData } from "@ling-stack/contracts";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import { resolveConfig } from "../dist/config.js";
import { HttpError } from "../dist/errors.js";
import { readProviderInvocationFailure } from "../dist/features/providers/runtime-invocations.js";
import { listCurrentlyApplicableAvailabilityIncidents } from "../dist/features/providers/runtime-failure-observations.js";
import {
  compareProviderRuntimeObservationScope,
  providerRuntimeScopeIdentity,
  runtimeObservationScopeForProvider,
} from "../dist/features/providers/runtime-observation-scope.js";
import { createDetachedRunExecutionSink, executeRunRequest } from "../dist/features/runs/orchestrator.js";
import { resolveProviderForRun } from "../dist/features/runs/providers.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { startRuntimeWorkUnit } from "../dist/runtime/work-units.js";
import { executeApprovalAutoReviewModel } from "../dist/features/runs/approval-auto-review-executor.js";
import { routeChannelMessageReply } from "../dist/features/channels/channel-message-router.js";
import { selectChannelWorkflowIntent } from "../dist/features/channels/channel-intent-selector.js";
import { createAiChannelReply } from "../dist/features/channels/ai-replies.js";

const PRIVATE_KEY = "synthetic-orchestrator-key-marker";
const PRIVATE_HEADER = "synthetic-orchestrator-header-marker";
const PRIVATE_BODY = "synthetic-orchestrator-provider-body-marker";
const TASK_ID = "synthetic-orchestrator-task";
const MODEL_A = "synthetic-orchestrator-model-a";
const MODEL_B = "synthetic-orchestrator-model-b";

/** Keep the production Pi/SDK/auth/fetch path; disable only hidden HTTP retries. */
class NoHttpRetryRunner extends PiRunnerAdapter {
  registerCustomProviderIfNeeded(runtime, provider) {
    super.registerCustomProviderIfNeeded(runtime, provider);
    const registered = runtime.getProvider(provider.provider);
    assert.equal(typeof registered?.streamSimple, "function");
    const streamSimple = registered.streamSimple.bind(registered);
    runtime.registerProvider(provider.provider, {
      api: provider.api,
      streamSimple: (model, context, options) => streamSimple(model, context, { ...options, maxRetries: 0 }),
    });
  }
}

/** Every request is real HTTP to loopback, never a replaced global fetch. */
async function loopbackProvider(t, mode = "success") {
  const requests = [];
  let heldResponse;
  let resolveFirst;
  const firstRequest = new Promise(resolveRequest => { resolveFirst = resolveRequest; });
  const respondSuccess = response => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      'data: {"choices":[{"index":0,"delta":{"content":"Synthetic orchestrator complete."},"finish_reason":null}]}',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]', "",
    ].join("\n\n"));
  };
  const respondFailure = (response, status, code) => {
    response.writeHead(status, { "content-type": "application/json", "retry-after": "0" });
    response.end(JSON.stringify({ error: { message: PRIVATE_BODY, code } }));
  };
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      let payload;
      try { payload = JSON.parse(body); } catch {
        response.writeHead(400); response.end(); return;
      }
      const captured = {
        method: request.method, path: request.url, model: payload.model,
        hasExpectedApiKey: request.headers.authorization === `Bearer ${PRIVATE_KEY}`,
        hasExpectedSecretHeader: request.headers["x-secret-tenant"] === PRIVATE_HEADER,
      };
      requests.push(captured);
      if (requests.length === 1) resolveFirst(captured);
      if (mode === "hold-first-rate-limit" && requests.length === 1) heldResponse = response;
      else if (mode === "provider-error") respondFailure(response, 503, "service_unavailable");
      else respondSuccess(response);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    heldResponse?.destroy();
    server.closeAllConnections();
    await new Promise(resolveClose => server.close(resolveClose));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`, requests, firstRequest,
    releaseRateLimit() {
      assert.ok(heldResponse, "A must reach real HTTP before its error can be released");
      respondFailure(heldResponse, 429, "rate_limit_exceeded");
      heldResponse = undefined;
    },
  };
}

/** Real disposable registry/SQLite and the actual saved-preset materializer. */
async function fixture(t, transport) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-provider-orchestrator-"));
  const paths = resolveStoragePaths(cwd, {
    homeDir: join(cwd, "synthetic-home"), env: {}, workspaceStateLocation: "repo-local",
  }).workspace;
  const stores = new RunStoreRegistry(workspaceCwd => createSqliteRunStore(workspaceCwd, paths));
  const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd }));
  const activeRuns = new ActiveRunRegistry();
  const pending = new Set();
  t.after(async () => {
    activeRuns.suspendAll("daemon_restart");
    await Promise.allSettled(pending);
    supervisor.releaseAll();
    stores.closeAll();
    await rm(cwd, { recursive: true, force: true });
  });
  const store = stores.getStore(cwd);
  const now = new Date().toISOString();
  const preset = store.createProviderPreset({
    kind: "openai-compatible", displayName: "Synthetic orchestrator fixture",
    providerId: "synthetic-orchestrator-provider", model: MODEL_A, api: "openai-completions",
    baseUrl: transport.url, contextWindow: 128_000, maxTokens: 16_384,
    apiKeyRef: "env:SYNTHETIC_ORCHESTRATOR_KEY",
    secretHeaderRefs: { "X-Secret-Tenant": "keychain:SYNTHETIC_ORCHESTRATOR_HEADER" },
    authHeader: true, reasoning: false, capabilities: ["chat"], enabled: true,
  }, now);
  store.recordProviderCheckResult(preset.id, {
    ok: true, code: "ready", message: "Synthetic loopback fixture only", checkedAt: now,
  });
  const secretResolver = {
    status(ref) { return { ref, kind: ref.startsWith("keychain:") ? "keychain" : "env", configured: true }; },
    resolve(ref) {
      return { ref, configured: true, status: this.status(ref),
        value: ref.startsWith("keychain:") ? PRIVATE_HEADER : PRIVATE_KEY };
    },
  };
  const thread = store.createLingThread({
    kind: "conversation", teammateId: "ling_agent", title: "Synthetic runtime scope",
    objective: "Finish one isolated synthetic task.",
  }, now);
  const request = {
    cwd, workspaceCwd: cwd, threadId: thread.id, teammateId: "ling_agent",
    providerPresetId: preset.id, tools: [], agentDir: join(cwd, "synthetic-agent"),
    task: { id: TASK_ID, title: "Synthetic runtime scope", prompt: "Finish this isolated synthetic task." },
    idempotencyKey: "synthetic-orchestrator-idempotency", createdByActor: "local-user",
  };
  const failures = [], errors = [], publicEvents = [];
  const dispatch = (adapter = new NoHttpRetryRunner(), overrides = {}) => {
    const running = executeRunRequest({ ...request, ...overrides }, {
      ...createDetachedRunExecutionSink(),
      writeError: (status, body) => errors.push({ status, body }),
      writeEvent: (type, event) => publicEvents.push({ type, event }),
    }, createRunnerRegistry([{
      id: "pi", displayName: "Synthetic production Pi fixture", status: "enabled", adapter,
    }]), stores, activeRuns, supervisor, secretResolver, {}, {
      onProviderInvocationFailure: failure => failures.push(failure),
    }).then(runId => ({ runId }), error => ({ error }));
    pending.add(running);
    void running.then(() => pending.delete(running));
    return running;
  };
  const startReply = (runRequest, sink, failureSink) => {
    const running = executeRunRequest(runRequest, sink, createRunnerRegistry([{
      id: "pi", displayName: "Synthetic production Pi reply", status: "enabled", adapter: new NoHttpRetryRunner(),
    }]), stores, activeRuns, supervisor, secretResolver, {}, {
      onProviderInvocationFailure: failureSink, providerInvocationOrigin: "reply",
    });
    pending.add(running);
    void running.then(() => pending.delete(running), () => pending.delete(running));
    return running;
  };
  return { cwd, store, preset, secretResolver, request, failures, errors, publicEvents, dispatch, startReply, supervisor };
}

function channelSource(f, body = "Explain the current test result.") {
  const now = new Date().toISOString();
  const channel = f.store.createChannel({ name: "Synthetic invocation channel", boundPath: f.cwd,
    defaultProviderPresetId: f.preset.id, autoReplyMode: "auto_route" }, now);
  const sourceMessage = appendChannelItemFixture(f.store, { channelId: channel.id, authorType: "local-user", body }, now);
  return { channel, sourceMessage };
}

function assertDurableOrigin(f, transport, origin, taskId, attemptId) {
  assert.ok(transport.requests.length > 0, "the original production entry must reach real loopback HTTP");
  transport.requests.forEach(assertTransport);
  const candidates = f.store.listAvailabilityIncidentCandidates({ now: new Date().toISOString() }).candidates;
  assert.equal(candidates.length, transport.requests.length);
  for (const row of candidates) {
    assert.equal(row.provenance, "provider_runtime");
    assert.equal(row.source.origin, origin);
    assert.equal(row.source.taskId, taskId);
    if (attemptId) assert.equal(row.source.attemptId, attemptId);
  }
  assert.doesNotMatch(JSON.stringify(candidates), /synthetic-orchestrator-key-marker|synthetic-orchestrator-header-marker|synthetic-orchestrator-provider-body-marker/);
  return candidates;
}

function assertTransport(request) {
  assert.equal(request.method, "POST");
  assert.equal(request.path, "/v1/chat/completions");
  assert.equal(request.model, MODEL_A);
  assert.equal(request.hasExpectedApiKey, true);
  assert.equal(request.hasExpectedSecretHeader, true);
}

function assertFailureLineage(f, runId, failure, revision) {
  const fact = readProviderInvocationFailure(failure);
  const run = f.store.getRun(runId);
  const unit = f.store.getWorkUnit(run.workUnitId);
  const attempt = f.store.getWorkUnitAttempt(unit.activeAttemptId);
  assert.ok(fact, "the private sink must receive a branded Host fact, not a public event");
  assert.equal(fact.taskId, TASK_ID);
  assert.equal(fact.runId, runId);
  assert.equal(fact.attemptId, attempt.id);
  assert.equal(attempt.workUnitId, unit.id);
  assert.equal(fact.origin, "task");
  assert.equal(fact.identity.providerPresetId, f.preset.id);
  assert.equal(fact.identity.modelId, MODEL_A);
  assert.equal(fact.identity.configRevision, revision);
  assert.equal(fact.identity.providerApi, "openai-completions");
  assert.ok(Date.parse(fact.settledAt) >= Date.parse(fact.admittedAt));
  assert.equal(Object.isFrozen(fact), true);
  assert.equal(Object.isFrozen(failure), true);
  assert.deepEqual(Reflect.ownKeys(failure), []);
  assert.equal(JSON.stringify(failure), "{}");
  assert.equal(readProviderInvocationFailure(structuredClone(failure)), undefined);
  return fact;
}

function assertNoPrivatePublication(f, runId, facts = []) {
  const persisted = JSON.stringify({ run: f.store.getRun(runId), events: f.store.listEvents(runId) });
  const published = JSON.stringify(f.publicEvents);
  assert.doesNotMatch(persisted + published + JSON.stringify(facts),
    /synthetic-orchestrator-key-marker|synthetic-orchestrator-header-marker|synthetic-orchestrator-provider-body-marker/);
  for (const fact of facts) assert.equal((persisted + published).includes(fact.invocationId), false);
}

test("real orchestrator Pi failure reaches the private sink with its actual Run/Attempt and preset revision",
  { timeout: 25_000 }, async t => {
    const transport = await loopbackProvider(t, "provider-error");
    const f = await fixture(t, transport);
    const revision = f.store.getProviderConfigurationSnapshot(f.preset.id).configRevision;
    const outcome = await f.dispatch();
    assert.equal(outcome.error, undefined);
    assert.ok(outcome.runId, JSON.stringify(f.errors));
    assert.equal(f.store.getRun(outcome.runId).status, "failed");
    assert.deepEqual(f.errors, []);
    assert.equal(transport.requests.length, 2, "each SDK attempt reaches HTTP once; hidden HTTP retries are disabled");
    assert.equal(f.failures.length, transport.requests.length);
    transport.requests.forEach(assertTransport);
    const facts = f.failures.map(failure => assertFailureLineage(f, outcome.runId, failure, revision));
    assert.equal(new Set(facts.map(fact => fact.invocationId)).size, facts.length);
    for (const fact of facts) {
      assert.equal(fact.classification.kind, "overload");
      assert.equal(fact.classification.state, "overloaded");
      assert.equal(compareProviderRuntimeObservationScope({
        store: f.store, scope: fact.scope, secretResolver: f.secretResolver,
      }).state, "sampled_value_match");
    }
    const candidates = f.store.listAvailabilityIncidentCandidates({ now: new Date().toISOString() }).candidates;
    assert.equal(candidates.length, facts.length, "every actual failed invocation has an atomic durable source");
    assert.ok(candidates.every(row => row.provenance === "provider_runtime" && row.source.origin === "task"));
    assert.deepEqual(new Set(candidates.map(row => row.source.invocationId)), new Set(facts.map(fact => fact.invocationId)));
    assert.equal(listCurrentlyApplicableAvailabilityIncidents({ store: f.store, secretResolver: f.secretResolver,
      providerPresetId: f.preset.id, now: new Date().toISOString() }).length, facts.length);
    assert.doesNotMatch(JSON.stringify(candidates), /synthetic-orchestrator-key-marker|synthetic-orchestrator-header-marker|synthetic-orchestrator-provider-body-marker/);
    assertNoPrivatePublication(f, outcome.runId, facts);
  });

test("the production orchestrator keeps held A's late failure on A after Store switches to B and SDK retry succeeds",
  { timeout: 25_000 }, async t => {
    const transport = await loopbackProvider(t, "hold-first-rate-limit");
    const f = await fixture(t, transport);
    const before = f.store.getProviderConfigurationSnapshot(f.preset.id);
    const running = f.dispatch();
    const first = await Promise.race([
      transport.firstRequest,
      running.then(outcome => { throw outcome.error ?? new Error(`Run settled before HTTP: ${JSON.stringify(f.errors)}`); }),
    ]);
    assertTransport(first);
    assert.deepEqual(f.failures, [], "no failure exists before the real Provider response");
    f.store.updateProviderPreset(f.preset.id, { model: MODEL_B, contextWindow: 256_000 }, new Date().toISOString());
    const providerB = resolveProviderForRun(f.store, {
      providerPresetId: f.preset.id, skipProviderPreflight: true,
    }, f.secretResolver);
    const scopeB = runtimeObservationScopeForProvider(f.store, providerB);
    assert.ok(scopeB);
    transport.releaseRateLimit();
    const outcome = await running;
    assert.equal(outcome.error, undefined);
    assert.ok(outcome.runId, JSON.stringify(f.errors));
    assert.equal(f.store.getRun(outcome.runId).status, "succeeded");
    assert.deepEqual(f.errors, []);
    assert.equal(transport.requests.length, 2, "retry is a separate SDK invocation, not a hidden HTTP attempt");
    transport.requests.forEach(assertTransport);
    assert.equal(f.failures.length, 1, "the successful retry does not erase A's failure or fabricate B's failure");
    const fact = assertFailureLineage(f, outcome.runId, f.failures[0], before.configRevision);
    assert.equal(fact.classification.state, "rate_limited");
    assert.equal(compareProviderRuntimeObservationScope({
      store: f.store, scope: fact.scope, secretResolver: f.secretResolver,
    }).state, "changed");
    assert.equal(compareProviderRuntimeObservationScope({
      store: f.store, scope: scopeB, secretResolver: f.secretResolver,
    }).state, "sampled_value_match");
    assert.notEqual(fact.identity.configRevision, providerRuntimeScopeIdentity(scopeB).configRevision);
    const candidates = f.store.listAvailabilityIncidentCandidates({ now: new Date().toISOString() }).candidates;
    assert.equal(candidates.length, 1, "late A remains durable history after B is selected");
    assert.equal(candidates[0].source.identity.modelId, MODEL_A);
    assert.equal(candidates[0].source.identity.configRevision, before.configRevision);
    assert.deepEqual(listCurrentlyApplicableAvailabilityIncidents({ store: f.store, secretResolver: f.secretResolver,
      providerPresetId: f.preset.id, now: new Date().toISOString() }), [], "current B health cannot consume A's late failure");
    assertNoPrivatePublication(f, outcome.runId, [fact]);
  });

test("a normal successful production Pi run performs real HTTP but emits no Provider failure",
  { timeout: 20_000 }, async t => {
    const transport = await loopbackProvider(t);
    const f = await fixture(t, transport);
    const outcome = await f.dispatch();
    assert.equal(outcome.error, undefined);
    assert.ok(outcome.runId, JSON.stringify(f.errors));
    assert.equal(f.store.getRun(outcome.runId).status, "succeeded");
    assert.deepEqual(f.errors, []);
    assert.equal(transport.requests.length, 1);
    assertTransport(transport.requests[0]);
    assert.deepEqual(f.failures, []);
    assertNoPrivatePublication(f, outcome.runId);
  });

test("SDK preparation rejection never becomes a Provider failure or dispatches HTTP",
  { timeout: 20_000 }, async t => {
    const transport = await loopbackProvider(t);
    const f = await fixture(t, transport);
    let prepares = 0, runs = 0;
    class PreparationRejectedRunner extends NoHttpRetryRunner {
      async prepareTaskInput(options) {
        prepares += 1;
        await super.prepareTaskInput(options);
        throw new HttpError(409, "synthetic_preparation_rejected", "Synthetic local preparation rejection.");
      }
      async runTask(options) { runs += 1; return super.runTask(options); }
    }
    const outcome = await f.dispatch(new PreparationRejectedRunner());
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.runId, undefined);
    assert.equal(prepares, 1);
    assert.equal(runs, 0);
    assert.deepEqual(f.errors, [{ status: 409, body: {
      error: "synthetic_preparation_rejected", message: "Synthetic local preparation rejection.",
    } }]);
    assert.deepEqual(f.store.listRuns(), []);
    assert.deepEqual(transport.requests, []);
    assert.deepEqual(f.failures, []);
    assert.deepEqual(f.store.listAvailabilityIncidents({ includeExpired: true }), []);
  });

test("a non-Pi adapter cannot borrow saved-preset proof through forged receipt-shaped results or runtime events",
  { timeout: 20_000 }, async t => {
    const transport = await loopbackProvider(t);
    const f = await fixture(t, transport);
    let calls = 0;
    const adapter = { async runTask(options) {
      calls += 1;
      assert.equal(options.onProviderInvocationAdmitted, undefined);
      assert.equal(options.onProviderInvocationSettled, undefined);
      const admittedAt = new Date().toISOString();
      const fabricated = { invocationId: "synthetic-forged-invocation", taskId: options.task.id,
        runId: options.runId, attemptId: options.runnerAttemptId, admittedAt, settledAt: admittedAt,
        outcome: "provider_error", errorDiagnostic: {
          schemaVersion: 1, category: "rate_limited", basis: "structured_http_status", httpStatus: 429,
        } };
      options.onProviderInvocationAdmitted?.(fabricated);
      options.onProviderInvocationSettled?.(fabricated);
      // Receipt lineage is not part of the public retry schema. Exercise a
      // valid persisted runtime event, rather than failing its strict parser.
      const retryEvent = { type: "provider_retry", policyVersion: "pi_sdk_retry_v1", scope: "assistant",
        phase: "scheduled", retryAttempt: 1, maxRetryAttempts: 1, delayMs: 0,
        errorDiagnostic: fabricated.errorDiagnostic };
      assert.equal(isRunEventData("provider_retry", retryEvent), true);
      options.onEvent?.(retryEvent);
      return { taskId: options.task.id, events: [], messages: [{ role: "assistant", content: "Synthetic non-Pi complete." }],
        providerInvocationFailure: fabricated };
    } };
    const outcome = await f.dispatch(adapter);
    assert.equal(outcome.error, undefined);
    assert.ok(outcome.runId, JSON.stringify(f.errors));
    assert.equal(calls, 1);
    assert.equal(f.store.getRun(outcome.runId).status, "succeeded");
    assert.deepEqual(f.errors, []);
    const events = f.store.listEvents(outcome.runId);
    const retries = events.filter(event => event.type === "provider_retry");
    assert.equal(retries.length, 1, "the legal public event reaches real SQLite without private invocation authority");
    assert.equal(isRunEventData("provider_retry", retries[0].data), true);
    assert.equal(retries[0].data.invocationId, undefined);
    const results = events.filter(event => event.type === "result");
    assert.equal(results.length, 1, "Host completion persists the adapter result normally");
    assert.equal(results[0].data.messageCount, 1);
    assert.deepEqual(transport.requests, []);
    assert.deepEqual(f.failures, []);
  });

test("an unsupported requested runner fails locally without dispatching Pi or creating Provider failure evidence",
  { timeout: 20_000 }, async t => {
    const transport = await loopbackProvider(t);
    const f = await fixture(t, transport);
    const outcome = await f.dispatch(new NoHttpRetryRunner(), { runnerId: "synthetic-unsupported-runner" });
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.runId, undefined);
    assert.equal(f.errors.length, 1);
    assert.equal(f.errors[0].body.error, "unsupported_runner");
    assert.deepEqual(f.store.listRuns(), []);
    assert.deepEqual(transport.requests, []);
    assert.deepEqual(f.failures, []);
  });

test("a real inline Pi Provider error without private saved-preset binding stays unknown rather than borrowing another preset",
  { timeout: 25_000 }, async t => {
    const transport = await loopbackProvider(t, "provider-error");
    const f = await fixture(t, transport);
    const outcome = await f.dispatch(new NoHttpRetryRunner(), {
      providerPresetId: undefined,
      provider: { provider: f.preset.providerId, model: MODEL_A, api: "openai-completions", baseUrl: transport.url,
        contextWindow: 128_000, maxTokens: 16_384, apiKey: PRIVATE_KEY,
        headers: { "X-Secret-Tenant": PRIVATE_HEADER }, authHeader: true, reasoning: false },
    });
    assert.equal(outcome.error, undefined);
    assert.ok(outcome.runId, JSON.stringify(f.errors));
    assert.equal(f.store.getRun(outcome.runId).status, "failed");
    assert.deepEqual(f.errors, []);
    assert.equal(transport.requests.length, 2);
    transport.requests.forEach(assertTransport);
    assert.deepEqual(f.failures, [], "matching public connection values cannot manufacture private resolver authority");
    assertNoPrivatePublication(f, outcome.runId);
  });

for (const origin of ["route", "intent"]) {
  test(`the real channel ${origin} entry publishes only its own actual SDK failure lineage`, { timeout: 25_000 }, async t => {
    const transport = await loopbackProvider(t, "provider-error");
    const f = await fixture(t, transport);
    const source = channelSource(f);
    f.store.updateWorkspaceSettings({ defaultProviderPresetId: f.preset.id }, new Date().toISOString());
    const input = { ...source, store: f.store, secretResolver: f.secretResolver,
      config: resolveConfig({ defaultWorkspaceCwd: f.cwd, channels: { autoRoute: true, intentSelector: true } }),
      runnerRegistry: createRunnerRegistry([{ id: "pi", displayName: "Synthetic production selector", status: "enabled", adapter: new NoHttpRetryRunner() }]) };
    const result = origin === "route" ? await routeChannelMessageReply(input) : await selectChannelWorkflowIntent(input);
    assert.ok(transport.requests.length > 0, `selector must dispatch, result: ${JSON.stringify(result)}`);
    const candidates = assertDurableOrigin(f, transport, origin, source.sourceMessage.id);
    assert.ok(candidates.every(row => row.source.runId === undefined && row.source.attemptId === undefined),
      "selectors do not borrow a task Run or Attempt they do not own");
  });
}

test("the actual isolated reviewer executor attributes HTTP failures to its independent Core Attempt", { timeout: 25_000 }, async t => {
  const transport = await loopbackProvider(t, "provider-error");
  const f = await fixture(t, transport);
  const unit = startRuntimeWorkUnit({ store: f.store, runtimeSupervisor: f.supervisor, kind: "approval_review",
    ownerType: "approval_request", ownerId: "synthetic-review-approval", providerPresetId: f.preset.id,
    request: {}, idempotencyKey: "synthetic-review-unit" });
  const provider = resolveProviderForRun(f.store, { providerPresetId: f.preset.id, skipProviderPreflight: true }, f.secretResolver);
  const fingerprint = "a".repeat(64);
  await assert.rejects(executeApprovalAutoReviewModel({ runner: new NoHttpRetryRunner(), provider, cwd: f.cwd,
    approvalId: "synthetic-review-approval", evidenceFingerprint: fingerprint, serializedEvidence: '{"schemaVersion":1}',
    providerObservation: { store: f.store, secretResolver: f.secretResolver, runId: "synthetic-source-run", attemptId: unit.attempt.id } }));
  const candidates = assertDurableOrigin(f, transport, "reviewer", `approval-review:synthetic-review-approval:${fingerprint.slice(0, 16)}`, unit.attempt.id);
  assert.ok(candidates.every(row => row.source.runId === "synthetic-source-run"));
  assert.equal(f.store.getWorkUnitAttempt(unit.attempt.id).workUnitId, unit.workUnit.id);
});

test("the real channel reply wrapper deduplicates its callback and orchestrator durable publication", { timeout: 25_000 }, async t => {
  const transport = await loopbackProvider(t, "provider-error");
  const f = await fixture(t, transport), source = channelSource(f);
  const reply = await createAiChannelReply({ ...source, store: f.store, secretResolver: f.secretResolver,
    providerPresetId: f.preset.id, teammateId: "ling_agent", disableWebEvidence: true, completionMode: "inline", startRun: f.startReply });
  assert.equal(reply.status, "blocked");
  const candidates = assertDurableOrigin(f, transport, "reply", f.store.listRuns()[0].taskId);
  const run = f.store.listRuns()[0], unit = f.store.getWorkUnit(run.workUnitId);
  assert.ok(candidates.every(row => row.source.runId === run.id && row.source.attemptId === unit.activeAttemptId));
  assert.equal(f.store.listAvailabilityIncidents({ includeExpired: true }).length, transport.requests.length,
    "the reply callback does not publish the same authentic failure twice");
});
