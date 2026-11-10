import assert from "node:assert/strict";
import test from "node:test";
import { providerForRunPersistence } from "../dist/features/runs/provider-persistence.js";
import { createQueuedRunForConflict } from "../dist/features/runs/queue.js";
import { inlineProviderDescriptor, restorePreparedInlineProvider } from "../dist/features/conversations/normal-conversation-prepared-provider.js";
import { resolveProviderForRun } from "../dist/features/runs/providers.js";

test("Run persistence masks arbitrary materialized headers without mutating the live provider", () => {
  const provider = Object.freeze({
    provider: "synthetic-a", model: "synthetic-model-a", apiKey: "synthetic-api-key-marker",
    headers: Object.freeze({ "X-Tenant": "synthetic-header-marker", "X-Custom": "a", Accept: "application/json" }),
    baseUrl: "https://synthetic.example.test/v1", contextWindow: 128_000, maxTokens: 16_384,
  });
  const persisted = providerForRunPersistence(provider);
  assert.notEqual(persisted, provider);
  assert.notEqual(persisted.headers, provider.headers);
  assert.equal(persisted.apiKey, "[REDACTED]");
  assert.deepEqual(persisted.headers, { "X-Tenant": "[REDACTED]", "X-Custom": "[REDACTED]", Accept: "[REDACTED]" });
  assert.equal(persisted.provider, provider.provider, "short header values cannot rewrite other audit fields");
  assert.equal(persisted.model, provider.model);
  assert.equal(persisted.baseUrl, provider.baseUrl);
  assert.equal(persisted.contextWindow, provider.contextWindow);
  assert.equal(provider.apiKey, "synthetic-api-key-marker");
  assert.equal(provider.headers["X-Tenant"], "synthetic-header-marker");
  assert.doesNotMatch(JSON.stringify(persisted), /synthetic-api-key-marker|synthetic-header-marker|application\/json/u);
});

test("credential-free provider snapshots stay credential-free, not falsely unrecoverable", () => {
  const provider = { provider: "synthetic-anonymous", model: "synthetic-anonymous-model", authHeader: false };
  const persisted = providerForRunPersistence(provider);
  assert.deepEqual(persisted, provider);
  assert.equal(Object.hasOwn(persisted, "apiKey"), false);
  assert.equal(Object.hasOwn(persisted, "headers"), false);
});

test("empty supplied credential fields remain explicit unavailable-credential audit markers", () => {
  const provider = { provider: "synthetic-empty", model: "synthetic-empty-model", apiKey: "", headers: { "X-Tenant": "" } };
  const persisted = providerForRunPersistence(provider);
  assert.equal(persisted.apiKey, "[REDACTED]");
  assert.equal(persisted.headers["X-Tenant"], "[REDACTED]");
  assert.equal(provider.apiKey, "");
  assert.equal(provider.headers["X-Tenant"], "");
});

test("the production queued-Run entry persists only redacted provider snapshots", () => {
  const provider = { provider: "synthetic-queued", model: "synthetic-model", apiKey: "synthetic-queue-key-marker",
    headers: { "X-Tenant": "synthetic-queue-header-marker" } };
  let created;
  const events = [];
  const store = {
    createRun(input) { created = input; return { ...input }; },
    linkRunToWorkUnit() {},
    appendEvent(...args) { events.push(args); },
    appendRuntimeEvent(input) { events.push(input); },
  };
  const run = createQueuedRunForConflict({
    store, storeRegistry: { rememberRun() {} }, provider,
    runRequest: { cwd: "/synthetic/queued-workspace", task: { id: "synthetic-task", title: "Synthetic task", prompt: "Synthetic prompt" }, provider },
    runId: "synthetic-queued-run", workspaceCwd: "/synthetic/queued-workspace",
    workUnit: { id: "synthetic-unit", runnerId: "pi" },
    attempt: { id: "synthetic-attempt", runtimeInstanceId: "synthetic-runtime", fencingToken: 1 },
    queuedAt: "2026-10-10T00:00:00.000Z", reason: "resource_conflict", message: "Synthetic conflict",
  });
  assert.equal(run.id, "synthetic-queued-run");
  assert.equal(created.providerSnapshot.headers["X-Tenant"], "[REDACTED]");
  assert.equal(created.requestSnapshot.provider.headers["X-Tenant"], "[REDACTED]");
  assert.equal(created.requestSnapshot.provider.apiKey, "[REDACTED]");
  assert.doesNotMatch(JSON.stringify({ created, events }), /synthetic-queue-(?:key|header)-marker/u);
  assert.equal(provider.apiKey, "synthetic-queue-key-marker");
  assert.equal(provider.headers["X-Tenant"], "synthetic-queue-header-marker");
});

test("existing inline recovery explicitly rejects masked credentials instead of using them or becoming anonymous", () => {
  const provider = { provider: "synthetic-inline", model: "synthetic-model", authHeader: false,
    headers: { "X-Tenant": "synthetic-inline-header-marker" } };
  const persisted = providerForRunPersistence(provider);
  const source = { id: "synthetic-source-run", threadId: "synthetic-thread", requestSnapshot: { provider: persisted } };
  const store = { getRun: () => source, getLingTurnForRun: () => ({ id: "synthetic-turn", threadId: source.threadId }) };
  const request = { threadId: source.threadId, parentRunId: source.id, provider: inlineProviderDescriptor(provider) };
  assert.throws(() => restorePreparedInlineProvider(store, request, source.id), error => {
    assert.equal(error.code, "prepared_inline_credentials_unavailable");
    assert.match(error.message, /configured provider preset/u);
    assert.doesNotMatch(error.message, /synthetic-inline-header-marker/u);
    return true;
  });
  assert.equal(provider.headers["X-Tenant"], "synthetic-inline-header-marker");
});

for (const credentials of [{ apiKey: "[REDACTED]" }, { authHeader: false, headers: { "X-Tenant": "[REDACTED]" } }]) {
  test(`the common inline resolver rejects a persisted ${credentials.apiKey ? "key" : "header"} mask before model admission`, () => {
    const provider = { provider: "synthetic-inline", model: "synthetic-model", ...credentials };
    assert.throws(() => resolveProviderForRun({}, { provider }, {}), error => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "prepared_inline_credentials_unavailable");
      assert.match(error.message, /configured provider preset/u);
      return true;
    });
  });
}

test("ordinary fresh inline and anonymous connections still resolve unchanged", () => {
  const fresh = { provider: "synthetic-inline", model: "synthetic-model", apiKey: "synthetic-live-key-marker",
    headers: { "X-Tenant": "synthetic-live-header-marker" } };
  assert.deepEqual(resolveProviderForRun({}, { provider: fresh }, {}), fresh);
  const anonymous = { provider: "synthetic-inline", model: "synthetic-model", authHeader: false };
  assert.deepEqual(resolveProviderForRun({}, { provider: anonymous }, {}), anonymous);
});
