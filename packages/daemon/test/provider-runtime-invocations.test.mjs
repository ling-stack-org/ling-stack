import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { inspect } from "node:util";
import test from "node:test";
import { createSqliteRunStore, resolveStoragePaths } from "@ling-stack/core";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import {
  createProviderInvocationObserver,
  readProviderInvocationFailure,
} from "../dist/features/providers/runtime-invocations.js";
import {
  compareProviderRuntimeObservationScope,
  providerRuntimeScopeIdentity,
  runtimeObservationScopeForProvider,
} from "../dist/features/providers/runtime-observation-scope.js";
import { resolveProviderForRun } from "../dist/features/runs/providers.js";

const NOW = "2026-10-10T00:00:00.000Z";
const SETTLED = "2026-10-10T00:00:01.000Z";
const TASK_ID = "synthetic-task-a";
const RUN_ID = "synthetic-run-a";
const ATTEMPT_ID = "synthetic-attempt-a";
const PRIVATE_KEY = "synthetic-invocation-private-key-marker";
const PRIVATE_HEADER = "synthetic-invocation-private-header-marker";
const PRIVATE_PATH = "/private/synthetic-invocation-private-path";

async function fixture(t) {
  const directory = await mkdtemp(resolve(tmpdir(), "ling-provider-invocation-"));
  const cwd = resolve(directory, "workspace");
  const paths = resolveStoragePaths(cwd, {
    homeDir: resolve(directory, "home"), env: {}, workspaceStateLocation: "repo-local",
  }).workspace;
  const store = createSqliteRunStore(cwd, paths);
  t.after(async () => {
    if (store.database.isOpen) store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const preset = store.createProviderPreset({
    kind: "openai-compatible", displayName: "Synthetic invocation fixture",
    providerId: "fixture", model: "fixture-model-a", api: "openai-completions",
    baseUrl: "https://invocation-a.example.test/v1", contextWindow: 128_000,
    apiKeyRef: "env:SYNTHETIC_INVOCATION_KEY",
    secretHeaderRefs: { "X-Secret-Tenant": "keychain:SYNTHETIC_INVOCATION_HEADER" },
    capabilities: ["chat"], enabled: true,
  }, NOW);
  const secretResolver = {
    status(ref) { return { ref, kind: ref.startsWith("keychain:") ? "keychain" : "env", configured: true }; },
    resolve(ref) {
      return {
        ref, configured: true, status: this.status(ref),
        value: ref.startsWith("keychain:") ? PRIVATE_HEADER : PRIVATE_KEY,
      };
    },
  };
  const resolveProvider = () => resolveProviderForRun(store, {
    providerPresetId: preset.id, skipProviderPreflight: true,
  }, secretResolver);
  const provider = resolveProvider();
  const scope = runtimeObservationScopeForProvider(store, provider);
  assert.ok(scope, "fixture requires the real saved-preset resolver's private binding");
  return { cwd, store, preset, provider, scope, secretResolver, resolveProvider, failures: [] };
}

function observer(f, options = {}) {
  return createProviderInvocationObserver({
    store: f.store, provider: f.provider, taskId: TASK_ID, runId: RUN_ID, attemptId: ATTEMPT_ID,
    origin: "task", onFailure: failure => f.failures.push(failure), ...options,
  });
}

function admitted(invocationId = "synthetic-invocation-a", overrides = {}) {
  return { invocationId, taskId: TASK_ID, runId: RUN_ID, attemptId: ATTEMPT_ID, admittedAt: NOW, ...overrides };
}

function settled(receipt = admitted(), overrides = {}) {
  return {
    ...receipt, outcome: "provider_error", settledAt: SETTLED,
    errorDiagnostic: diagnostic("context_limit"), ...overrides,
  };
}

function diagnostic(category) {
  return { schemaVersion: 1, category, basis: "structured_http_status" };
}

function fail(callbacks, receipt = admitted(), overrides = {}) {
  callbacks.onProviderInvocationAdmitted(receipt);
  callbacks.onProviderInvocationSettled(settled(receipt, overrides));
}

function numericBudget(overrides = {}) {
  return {
    schemaVersion: 1, basis: "pi_projected_context_estimate", estimatedInputTokens: 100,
    contextWindowTokens: 128_000, reservedOutputTokens: 4_000,
    reservedRuntimeOverheadTokens: 512, inputBudgetTokens: 123_488, ...overrides,
  };
}

test("Host budget fact retains an immutable copy of the exact admitted numeric snapshot", async (t) => {
  const f = await fixture(t);
  const budget = numericBudget();
  const receipt = admitted("budget-copy", { contextBudget: budget });
  fail(observer(f), receipt);
  assert.equal(f.failures.length, 1);
  const fact = readProviderInvocationFailure(f.failures[0]);
  assert.deepEqual(fact.contextBudget, budget);
  assert.notEqual(fact.contextBudget, budget);
  assert.equal(Object.isFrozen(fact.contextBudget), true);
  budget.estimatedInputTokens = 500;
  assert.equal(fact.contextBudget.estimatedInputTokens, 100);
  assert.equal(JSON.stringify(f.failures[0]), "{}");
});

test("Host budget fact never fabricates defaults from missing, malformed or text-bearing evidence", async (t) => {
  const f = await fixture(t);
  const candidates = [
    undefined,
    numericBudget({ schemaVersion: 2 }),
    numericBudget({ basis: PRIVATE_KEY }),
    numericBudget({ estimatedInputTokens: NaN }),
    numericBudget({ estimatedInputTokens: Infinity }),
    numericBudget({ estimatedInputTokens: -1 }),
    numericBudget({ estimatedInputTokens: 100.5 }),
    numericBudget({ contextWindowTokens: Number.MAX_SAFE_INTEGER + 1 }),
    numericBudget({ reservedOutputTokens: 0 }),
    numericBudget({ reservedRuntimeOverheadTokens: 0 }),
    numericBudget({ inputBudgetTokens: 123_487 }),
    numericBudget({ estimatedInputTokens: 123_489 }),
    numericBudget({ payload: PRIVATE_HEADER, privatePath: PRIVATE_PATH }),
  ];
  const callbacks = observer(f);
  for (const [index, contextBudget] of candidates.entries()) {
    fail(callbacks, admitted(`budget-invalid-${index}`, { contextBudget }));
    const fact = readProviderInvocationFailure(f.failures.at(-1));
    assert.equal(fact.contextBudget, undefined);
    assert.equal(fact.classification.label, "provider context window retry");
    assert.doesNotMatch(JSON.stringify(fact), /private-key-marker|private-header-marker|private-path/);
  }
  assert.equal(f.failures.length, candidates.length, "budget uncertainty must not suppress independent availability evidence");
});

test("Host budget fact requires settlement to preserve its own admitted snapshot", async (t) => {
  const f = await fixture(t);
  const callbacks = observer(f);
  const receipt = admitted("budget-mutated", { contextBudget: numericBudget() });
  callbacks.onProviderInvocationAdmitted(receipt);
  receipt.contextBudget.estimatedInputTokens = 101;
  callbacks.onProviderInvocationSettled(settled(receipt));
  assert.equal(readProviderInvocationFailure(f.failures[0]).contextBudget, undefined);
  const missing = admitted("budget-missing-settlement", { contextBudget: numericBudget() });
  fail(callbacks, missing, { contextBudget: undefined });
  assert.equal(readProviderInvocationFailure(f.failures[1]).contextBudget, undefined);
  const unadmitted = admitted("budget-invented-settlement");
  fail(callbacks, unadmitted, { contextBudget: numericBudget() });
  assert.equal(readProviderInvocationFailure(f.failures[2]).contextBudget, undefined);
  assert.equal(f.failures.length, 3);
});

test("Host budget facts from concurrent invocations cannot borrow each other's numeric inputs", async (t) => {
  const f = await fixture(t);
  const callbacks = observer(f);
  const a = admitted("budget-a", { contextBudget: numericBudget({ estimatedInputTokens: 50 }) });
  const b = admitted("budget-b", { contextBudget: numericBudget({ estimatedInputTokens: 500 }) });
  callbacks.onProviderInvocationAdmitted(a);
  callbacks.onProviderInvocationAdmitted(b);
  callbacks.onProviderInvocationSettled(settled(b));
  callbacks.onProviderInvocationSettled(settled(a));
  assert.deepEqual(f.failures.map(failure => readProviderInvocationFailure(failure).contextBudget.estimatedInputTokens), [500, 50]);
});

test("an admitted provider error yields one private immutable fact tied to its original scope", async (t) => {
  const f = await fixture(t);
  const callbacks = observer(f);
  const receipt = admitted();
  fail(callbacks, receipt);
  assert.equal(f.failures.length, 1);
  const fact = readProviderInvocationFailure(f.failures[0]);
  assert.deepEqual(Object.keys(fact).sort(), [
    "admittedAt", "attemptId", "classification", "identity", "invocationId", "origin", "runId", "scope", "settledAt", "taskId",
  ]);
  assert.equal(fact.invocationId, receipt.invocationId);
  assert.equal(fact.taskId, TASK_ID);
  assert.equal(fact.runId, RUN_ID);
  assert.equal(fact.attemptId, ATTEMPT_ID);
  assert.equal(fact.admittedAt, NOW);
  assert.equal(fact.settledAt, SETTLED);
  assert.equal(fact.scope, f.scope);
  assert.deepEqual(fact.identity, providerRuntimeScopeIdentity(f.scope));
  assert.equal(fact.classification.label, "provider context window retry");
  assert.equal(Object.isFrozen(fact), true);
  assert.equal(Object.isFrozen(fact.classification), true);
  assert.equal(Object.isFrozen(fact.identity), true);
});

test("a late error from A keeps A's original revision after the current provider is replaced by B", async (t) => {
  const f = await fixture(t);
  const callbacks = observer(f);
  const before = f.store.getProviderConfigurationSnapshot(f.preset.id);
  const receipt = admitted();
  callbacks.onProviderInvocationAdmitted(receipt);
  f.store.updateProviderPreset(f.preset.id, {
    model: "fixture-model-b", baseUrl: "https://invocation-b.example.test/v1", contextWindow: 256_000,
  }, NOW);
  const providerB = f.resolveProvider();
  const scopeB = runtimeObservationScopeForProvider(f.store, providerB);
  callbacks.onProviderInvocationSettled(settled(receipt));
  assert.equal(f.failures.length, 1);
  const fact = readProviderInvocationFailure(f.failures[0]);
  assert.equal(fact.scope, f.scope);
  assert.equal(fact.identity.configRevision, before.configRevision);
  assert.equal(fact.identity.modelId, "fixture-model-a");
  assert.equal(compareProviderRuntimeObservationScope({ store: f.store, scope: fact.scope, secretResolver: f.secretResolver }).state, "changed");
  assert.equal(compareProviderRuntimeObservationScope({ store: f.store, scope: scopeB, secretResolver: f.secretResolver }).state, "sampled_value_match");
  assert.notEqual(fact.identity.configRevision, providerRuntimeScopeIdentity(scopeB).configRevision);
});

test("failure handles and original scopes expose no payload under reflection, serialization or cloning", async (t) => {
  const f = await fixture(t);
  fail(observer(f), admitted(), {
    errorMessage: `context length exceeded; ${PRIVATE_KEY}; ${PRIVATE_HEADER}; ${PRIVATE_PATH}`,
    error: { secret: PRIVATE_KEY }, payload: { privatePath: PRIVATE_PATH },
  });
  const failure = f.failures[0];
  assert.ok(failure);
  assert.equal(Object.isFrozen(failure), true);
  assert.deepEqual(Reflect.ownKeys(failure), []);
  assert.deepEqual(Object.getOwnPropertyDescriptors(failure), {});
  assert.equal(JSON.stringify(failure), "{}");
  assert.equal(JSON.stringify(f.scope), "{}");
  for (const fake of [{}, { ...failure }, structuredClone(failure), JSON.parse(JSON.stringify(failure)), undefined]) {
    assert.equal(readProviderInvocationFailure(fake), undefined);
  }
  const fact = readProviderInvocationFailure(failure);
  const rendered = JSON.stringify(fact) + inspect(failure, { showHidden: true });
  assert.doesNotMatch(rendered, /synthetic-invocation-private-key-marker|synthetic-invocation-private-header-marker|synthetic-invocation-private-path/);
  assert.equal(Object.hasOwn(fact, "errorMessage"), false);
  assert.equal(Object.hasOwn(fact, "error"), false);
  assert.equal(Object.hasOwn(fact, "payload"), false);
});

test("settlement without actual admission cannot manufacture a provider failure", async (t) => {
  const f = await fixture(t);
  observer(f).onProviderInvocationSettled(settled());
  assert.deepEqual(f.failures, []);
});

test("an unbound or cloned provider cannot manufacture an invocation fact", async (t) => {
  const f = await fixture(t);
  for (const provider of [{ ...f.provider }, structuredClone(f.provider), { provider: "inline", model: "inline-model", apiKey: PRIVATE_KEY }]) {
    fail(observer(f, { provider }));
  }
  assert.deepEqual(f.failures, []);
});

test("a provider mutated before admission is unknown rather than a new authoritative connection", async (t) => {
  const f = await fixture(t);
  f.provider.baseUrl = "https://unbound-mutation.example.test/v1";
  fail(observer(f));
  assert.deepEqual(f.failures, []);
});

test("a cloned scope or saved Run snapshot cannot be supplied as invocation authority", async (t) => {
  const f = await fixture(t);
  const provider = { ...f.provider, scope: structuredClone(f.scope), providerSnapshot: { ...f.provider } };
  fail(observer(f, { provider }));
  assert.deepEqual(f.failures, []);
});

for (const [field, value] of [["taskId", "wrong-task"], ["runId", "wrong-run"], ["attemptId", "wrong-attempt"]]) {
  test(`wrong admitted ${field} cannot cross the observer lineage`, async (t) => {
    const f = await fixture(t);
    fail(observer(f), admitted("wrong-lineage-invocation", { [field]: value }));
    assert.deepEqual(f.failures, []);
  });
}

for (const [field, value] of [
  ["taskId", "wrong-task"], ["runId", "wrong-run"], ["attemptId", "wrong-attempt"],
  ["admittedAt", "2026-10-10T00:00:00.500Z"],
]) {
  test(`wrong settled ${field} cannot borrow the same ID's admitted lineage`, async (t) => {
    const f = await fixture(t);
    fail(observer(f), admitted(), { [field]: value });
    assert.deepEqual(f.failures, []);
  });
}

test("unexpected admission fields cannot become retained error text, payload or credentials", async (t) => {
  const f = await fixture(t);
  fail(observer(f), admitted("synthetic-admission-extra", {
    errorMessage: PRIVATE_KEY, payload: { secret: PRIVATE_HEADER, path: PRIVATE_PATH }, credentials: PRIVATE_KEY,
  }));
  assert.equal(f.failures.length, 1);
  const fact = readProviderInvocationFailure(f.failures[0]);
  assert.doesNotMatch(JSON.stringify(fact), /synthetic-invocation-private-key-marker|synthetic-invocation-private-header-marker|synthetic-invocation-private-path/);
  assert.equal(Object.hasOwn(fact, "errorMessage"), false);
  assert.equal(Object.hasOwn(fact, "payload"), false);
  assert.equal(Object.hasOwn(fact, "credentials"), false);
});

test("invalid or unbounded invocation identity cannot become a pending provider request", async (t) => {
  const f = await fixture(t);
  const callbacks = observer(f);
  for (const invocationId of ["", "x".repeat(129), undefined, null, 1]) {
    fail(callbacks, admitted("synthetic-invalid-id", { invocationId }));
  }
  assert.deepEqual(f.failures, []);
});

test("invalid admission and settlement times cannot create a provider fact", async (t) => {
  const f = await fixture(t);
  const callbacks = observer(f);
  fail(callbacks, admitted("bad-admission", { admittedAt: "not-a-time" }));
  fail(callbacks, admitted("bad-settlement"), { settledAt: "not-a-time" });
  fail(callbacks, admitted("backwards-settlement"), { settledAt: "2026-10-09T23:59:59.000Z" });
  assert.deepEqual(f.failures, []);
});

test("a duplicate identity remains invalid after a third admission instead of being resurrected", async (t) => {
  const f = await fixture(t);
  const callbacks = observer(f);
  const receipt = admitted();
  callbacks.onProviderInvocationAdmitted(receipt);
  callbacks.onProviderInvocationAdmitted(receipt);
  callbacks.onProviderInvocationAdmitted(receipt);
  callbacks.onProviderInvocationSettled(settled(receipt));
  assert.deepEqual(f.failures, []);
});

test("a settled identity cannot be reused to create another logical request", async (t) => {
  const f = await fixture(t);
  const callbacks = observer(f);
  const receipt = admitted();
  callbacks.onProviderInvocationAdmitted(receipt);
  callbacks.onProviderInvocationSettled(settled(receipt, { outcome: "succeeded" }));
  fail(callbacks, receipt);
  assert.deepEqual(f.failures, []);
});

test("duplicate settlements produce at most one failure fact", async (t) => {
  const f = await fixture(t);
  const callbacks = observer(f);
  const receipt = admitted();
  fail(callbacks, receipt);
  callbacks.onProviderInvocationSettled(settled(receipt));
  callbacks.onProviderInvocationSettled(settled(receipt));
  assert.equal(f.failures.length, 1);
});

test("bounded pending admission refuses overflow rather than creating an unadmitted error fact", async (t) => {
  const f = await fixture(t);
  const callbacks = observer(f);
  for (let index = 0; index < 130; index += 1) {
    callbacks.onProviderInvocationAdmitted(admitted(`synthetic-bounded-${index}`));
  }
  callbacks.onProviderInvocationSettled(settled(admitted("synthetic-bounded-128")));
  callbacks.onProviderInvocationSettled(settled(admitted("synthetic-bounded-129")));
  assert.deepEqual(f.failures, []);
  callbacks.onProviderInvocationSettled(settled(admitted("synthetic-bounded-0")));
  assert.equal(f.failures.length, 1);
});

for (const outcome of ["succeeded", "cancelled", "local_rejected"]) {
  test(`${outcome} is not a provider failure even with a context-error-like diagnostic`, async (t) => {
    const f = await fixture(t);
    fail(observer(f), admitted(), { outcome });
    assert.deepEqual(f.failures, []);
  });
}

test("cancellation before admission never produces a provider health observation", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  fail(observer(f, { signal: controller.signal }));
  assert.deepEqual(f.failures, []);
});

test("cancellation during the admitted request suppresses late provider-error attribution", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const callbacks = observer(f, { signal: controller.signal });
  const receipt = admitted();
  callbacks.onProviderInvocationAdmitted(receipt);
  controller.abort();
  callbacks.onProviderInvocationSettled(settled(receipt));
  assert.deepEqual(f.failures, []);
});

test("unclassified provider diagnostics cannot be persisted as raw runtime incidents", async (t) => {
  const f = await fixture(t);
  fail(observer(f), admitted(), { errorDiagnostic: diagnostic("unknown"), errorMessage: `${PRIVATE_KEY} at ${PRIVATE_PATH}` });
  assert.deepEqual(f.failures, []);
});

test("unrecognized diagnostic categories and raw old errorMessage fields cannot create a provider failure", async (t) => {
  const f = await fixture(t);
  fail(observer(f), admitted("synthetic-raw-category"), {
    errorDiagnostic: diagnostic(`context_length_error ${PRIVATE_KEY} at ${PRIVATE_PATH}`),
  });
  fail(observer(f), admitted("synthetic-old-raw-field"), {
    errorDiagnostic: undefined, errorMessage: "rate_limited context_length_error",
  });
  assert.deepEqual(f.failures, []);
});

for (const origin of ["task", "reviewer", "reply", "route", "intent"]) {
  test(`${origin} invocation origin retains independent request identity`, async (t) => {
    const f = await fixture(t);
    fail(observer(f, { origin }), admitted(`synthetic-${origin}-invocation`), { errorDiagnostic: diagnostic("rate_limited") });
    const fact = readProviderInvocationFailure(f.failures[0]);
    assert.equal(fact.origin, origin);
    assert.equal(fact.invocationId, `synthetic-${origin}-invocation`);
    assert.equal(fact.classification.state, "rate_limited");
  });
}

test("independent retry requests each retain their own admitted scope rather than an aggregate error", async (t) => {
  const f = await fixture(t);
  const callbacks = observer(f);
  const first = admitted("synthetic-retry-first");
  const second = admitted("synthetic-retry-second");
  callbacks.onProviderInvocationAdmitted(first);
  callbacks.onProviderInvocationAdmitted(second);
  callbacks.onProviderInvocationSettled(settled(second, { errorDiagnostic: diagnostic("provider_unavailable") }));
  callbacks.onProviderInvocationSettled(settled(first, { errorDiagnostic: diagnostic("rate_limited") }));
  const facts = f.failures.map(readProviderInvocationFailure);
  assert.deepEqual(facts.map(fact => fact.invocationId), [second.invocationId, first.invocationId]);
  assert.deepEqual(facts.map(fact => fact.classification.state), ["overloaded", "rate_limited"]);
  assert.ok(facts.every(fact => fact.scope === f.scope));
});

test("synchronous diagnostic sink failures never alter observer admission or settlement", async (t) => {
  const f = await fixture(t);
  const callbacks = observer(f, { onFailure(failure) {
    f.failures.push(failure);
    throw new Error(`${PRIVATE_KEY} at ${PRIVATE_PATH}`);
  } });
  assert.doesNotThrow(() => fail(callbacks));
  assert.equal(f.failures.length, 1);
  assert.equal(readProviderInvocationFailure(f.failures[0]).classification.label, "provider context window retry");
});

test("asynchronous diagnostic sink rejection is contained rather than an unhandled runtime failure", async (t) => {
  const f = await fixture(t);
  const unhandled = [];
  const listener = reason => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  t.after(() => process.removeListener("unhandledRejection", listener));
  const callbacks = observer(f, { async onFailure(failure) {
    f.failures.push(failure);
    throw new Error("synthetic diagnostic sink rejection");
  } });
  assert.doesNotThrow(() => fail(callbacks));
  await new Promise(resolveImmediate => setImmediate(resolveImmediate));
  await new Promise(resolveImmediate => setImmediate(resolveImmediate));
  assert.equal(f.failures.length, 1);
  assert.deepEqual(unhandled, []);
});

/** Production Pi/SDK/auth/transport; only disable hidden HTTP retries in the fixture. */
class NoHttpRetryRunner extends PiRunnerAdapter {
  registerCustomProviderIfNeeded(runtime, provider) {
    super.registerCustomProviderIfNeeded(runtime, provider);
    const registered = runtime.models.getProvider(provider.provider);
    assert.equal(typeof registered?.streamSimple, "function");
    runtime.registerProvider(provider.provider, {
      api: provider.api,
      streamSimple: (model, context, options) => registered.streamSimple(model, context, { ...options, maxRetries: 0 }),
    });
  }
}

async function loopbackProvider(t, options = {}) {
  const requests = [];
  let firstResponse;
  let firstArrived;
  const firstRequest = new Promise(resolveFirst => { firstArrived = resolveFirst; });
  const complete = response => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      'data: {"choices":[{"index":0,"delta":{"content":"Synthetic loopback complete."},"finish_reason":null}]}',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]', "",
    ].join("\n\n"));
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
      if (requests.length === 1) firstArrived(captured);
      if (requests.length === 1 && options.holdFirst) firstResponse = response;
      else complete(response);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    firstResponse?.destroy();
    server.closeAllConnections();
    await new Promise(resolveClose => server.close(resolveClose));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`, requests, firstRequest,
    releaseRateLimit() {
      assert.ok(firstResponse, "the real SDK request must arrive before releasing its response");
      firstResponse.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
      firstResponse.end(JSON.stringify({ error: { message: "rate_limited synthetic loopback quota", code: "rate_limit_exceeded" } }));
      firstResponse = undefined;
    },
  };
}

function actualRunOptions(f, callbacks, controller, events) {
  return {
    cwd: f.cwd, agentDir: resolve(f.cwd, "synthetic-agent"), tools: [],
    task: { id: TASK_ID, title: "Synthetic loopback invocation", prompt: "Finish this isolated synthetic request." },
    provider: f.provider, runId: RUN_ID, runnerAttemptId: ATTEMPT_ID, signal: controller.signal,
    onEvent: event => events.push(event), ...callbacks,
  };
}

test("real Pi preparation makes no request and the completed SDK stream produces no provider failure", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const transport = await loopbackProvider(t);
  f.store.updateProviderPreset(f.preset.id, { baseUrl: transport.url }, NOW);
  f.provider = f.resolveProvider();
  f.scope = runtimeObservationScopeForProvider(f.store, f.provider);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const runner = new NoHttpRetryRunner();
  const events = [], admissions = [], settlements = [];
  const callbacks = observer(f);
  const options = actualRunOptions(f, {
    onProviderInvocationAdmitted(receipt) { admissions.push(receipt); callbacks.onProviderInvocationAdmitted(receipt); },
    onProviderInvocationSettled(receipt) { settlements.push(receipt); callbacks.onProviderInvocationSettled(receipt); },
  }, controller, events);
  const preparedInput = await runner.prepareTaskInput(options);
  assert.deepEqual(transport.requests, []);
  assert.deepEqual(admissions, []);
  assert.deepEqual(settlements, []);
  const result = await runner.runTask({ ...options, preparedInput });
  assert.equal(result.taskId, TASK_ID);
  assert.equal(transport.requests.length, 1);
  assert.equal(transport.requests[0].model, "fixture-model-a");
  assert.equal(transport.requests[0].hasExpectedApiKey, true);
  assert.equal(transport.requests[0].hasExpectedSecretHeader, true);
  assert.equal(admissions.length, 1);
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].outcome, "succeeded");
  assert.equal(settlements[0].invocationId, admissions[0].invocationId);
  assert.deepEqual(f.failures, []);
  assert.equal(JSON.stringify(events).includes(admissions[0].invocationId), false);
});

test("a real blocked A request's late 429 keeps A identity after B replaces it, even when SDK retry completes", { timeout: 25_000 }, async (t) => {
  const f = await fixture(t);
  const transport = await loopbackProvider(t, { holdFirst: true });
  f.store.updateProviderPreset(f.preset.id, { baseUrl: transport.url }, NOW);
  f.provider = f.resolveProvider();
  f.scope = runtimeObservationScopeForProvider(f.store, f.provider);
  const before = f.store.getProviderConfigurationSnapshot(f.preset.id);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const events = [], admissions = [], settlements = [];
  const callbacks = observer(f);
  const options = actualRunOptions(f, {
    onProviderInvocationAdmitted(receipt) { admissions.push(receipt); callbacks.onProviderInvocationAdmitted(receipt); },
    onProviderInvocationSettled(receipt) { settlements.push(receipt); callbacks.onProviderInvocationSettled(receipt); },
  }, controller, events);
  const running = new NoHttpRetryRunner().runTask(options).then(
    result => ({ result }), error => ({ error }),
  );
  const first = await Promise.race([
    transport.firstRequest,
    running.then(outcome => { throw outcome.error ?? new Error("SDK settled before its real loopback request arrived"); }),
  ]);
  assert.equal(first.model, "fixture-model-a");
  assert.equal(admissions.length, 1);
  f.store.updateProviderPreset(f.preset.id, { model: "fixture-model-b", contextWindow: 256_000 }, NOW);
  const providerB = f.resolveProvider();
  const scopeB = runtimeObservationScopeForProvider(f.store, providerB);
  transport.releaseRateLimit();
  const outcome = await running;
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.result.taskId, TASK_ID);
  assert.equal(transport.requests.length, 2, "disable hidden HTTP retries; the second request must be the separate SDK retry");
  assert.equal(admissions.length, 2);
  assert.equal(settlements.length, 2);
  assert.deepEqual(settlements.map(receipt => receipt.outcome), ["provider_error", "succeeded"]);
  assert.equal(f.failures.length, 1);
  const fact = readProviderInvocationFailure(f.failures[0]);
  assert.equal(fact.invocationId, admissions[0].invocationId);
  assert.equal(fact.identity.configRevision, before.configRevision);
  assert.equal(fact.identity.modelId, "fixture-model-a");
  assert.equal(fact.classification.state, "rate_limited");
  assert.equal(compareProviderRuntimeObservationScope({ store: f.store, scope: fact.scope, secretResolver: f.secretResolver }).state, "changed");
  assert.equal(compareProviderRuntimeObservationScope({ store: f.store, scope: scopeB, secretResolver: f.secretResolver }).state, "sampled_value_match");
  assert.doesNotMatch(JSON.stringify(fact), /synthetic-invocation-private-key-marker|synthetic-invocation-private-header-marker|synthetic-invocation-private-path/);
  for (const receipt of settlements) assert.equal(Object.hasOwn(receipt, "errorMessage"), false);
  for (const receipt of admissions) assert.equal(JSON.stringify(events).includes(receipt.invocationId), false);
});
