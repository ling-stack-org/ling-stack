import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createSqliteRunStore, resolveStoragePaths } from "@ling-stack/core";
import { createProviderInvocationObserver, readProviderInvocationFailure } from "../dist/features/providers/runtime-invocations.js";
import { resolveProviderForRun } from "../dist/features/runs/providers.js";
import { runtimeObservationScopeForProvider } from "../dist/features/providers/runtime-observation-scope.js";

const NOW = "2026-10-10T00:00:00.000Z";
const SIX_HOURS = 6 * 60 * 60 * 1_000;
const PRIVATE_KEY = "synthetic-cache-private-key";
const PRIVATE_HEADER = "synthetic-cache-private-header";
const loadDomain = () => import("../dist/features/providers/runtime-failure-observations.js");
const at = ms => new Date(Date.parse(NOW) + ms).toISOString();

async function fixture(t) {
  const directory = await mkdtemp(resolve(tmpdir(), "ling-runtime-failure-domain-"));
  const cwd = resolve(directory, "workspace");
  const paths = resolveStoragePaths(cwd, { homeDir: resolve(directory, "home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  const store = createSqliteRunStore(cwd, paths);
  t.after(async () => { if (store.database.isOpen) store.close(); await rm(directory, { recursive: true, force: true }); });
  const preset = store.createProviderPreset({ kind: "openai-compatible", displayName: "Synthetic domain fixture", providerId: "domain-fixture",
    model: "fixture-model-a", api: "openai-completions", baseUrl: "https://fixture.invalid/v1", contextWindow: 8_192, maxTokens: 1_024,
    apiKeyRef: "env:SYNTHETIC_CACHE_KEY", secretHeaderRefs: { "X-Secret-Tenant": "keychain:SYNTHETIC_CACHE_HEADER" },
    capabilities: ["chat"], enabled: true }, NOW);
  const values = { key: PRIVATE_KEY, header: PRIVATE_HEADER, unavailable: false };
  const secretResolver = {
    status(ref) { return { ref, kind: ref.startsWith("keychain:") ? "keychain" : "env", configured: !values.unavailable }; },
    resolve(ref) {
      if (values.unavailable) throw new Error("Synthetic resolver unavailable");
      return { ref, configured: true, status: this.status(ref), value: ref.startsWith("keychain:") ? values.header : values.key };
    },
  };
  const f = { directory, cwd, paths, store, preset, values, secretResolver };
  f.resolveProvider = () => resolveProviderForRun(f.store, { providerPresetId: preset.id, skipProviderPreflight: true }, secretResolver);
  f.provider = f.resolveProvider();
  return f;
}

function budget(estimatedInputTokens = 500) {
  return { schemaVersion: 1, basis: "pi_projected_context_estimate", estimatedInputTokens, contextWindowTokens: 8_192,
    reservedOutputTokens: 1_024, reservedRuntimeOverheadTokens: 512, inputBudgetTokens: 6_656 };
}

/** Authentic Host fold fixture. It is not a network-dispatch or completed-run claim. */
function syntheticFailureFact(f, options = {}) {
  let failure;
  const settledAt = options.settledAt ?? NOW;
  const callbacks = createProviderInvocationObserver({ store: f.store, provider: options.provider ?? f.provider,
    taskId: "domain-task", runId: "domain-run", attemptId: "domain-attempt", origin: "task", onFailure: value => { failure = value; } });
  const receipt = { invocationId: options.id ?? "synthetic-domain-invocation", taskId: "domain-task", runId: "domain-run",
    attemptId: "domain-attempt", admittedAt: new Date(Date.parse(settledAt) - 1_000).toISOString(),
    ...(options.contextBudget === null ? {} : { contextBudget: options.contextBudget ?? budget() }) };
  callbacks.onProviderInvocationAdmitted(receipt);
  options.afterAdmission?.();
  callbacks.onProviderInvocationSettled({ ...receipt, settledAt, outcome: "provider_error",
    errorDiagnostic: { schemaVersion: 1, category: options.category ?? "context_limit", basis: "sdk_error_marker" } });
  assert.ok(failure, "the real Host fold must produce the private failure handle");
  return failure;
}

function readInput(f, options = {}) { return { store: f.store, secretResolver: f.secretResolver, providerPresetId: f.preset.id, now: NOW, ...options }; }
function generic(f, options = {}) {
  return f.store.createAvailabilityIncident({ state: "slow", kind: "timeout", summary: "Synthetic generic incident", observedAt: NOW,
    expiresAt: at(SIX_HOURS + 60_000), ...options }, NOW);
}

test("scope-aware domain interface is available independently of old production consumers", async () => {
  const domain = await loadDomain();
  for (const name of ["recordProviderInvocationFailureObservations", "providerRuntimeContextObservationForPreset",
    "listCurrentlyApplicableAvailabilityIncidents"]) assert.equal(typeof domain[name], "function");
});

test("an authentic current failure publishes safe lineage once and learns its actual numeric window", async t => {
  const f = await fixture(t), domain = await loadDomain();
  const failure = syntheticFailureFact(f);
  const result = domain.recordProviderInvocationFailureObservations({ ...readInput(f), failure });
  assert.ok(result.incident);
  assert.equal(result.contextObservation.observedContextWindowTokens, 2_048);
  assert.equal(domain.recordProviderInvocationFailureObservations({ ...readInput(f), failure }).incident.id, result.incident.id);
  assert.equal(f.store.listAvailabilityIncidents({ includeExpired: true }).length, 1);
  assert.deepEqual(domain.providerRuntimeContextObservationForPreset(readInput(f)), result.contextObservation);
  assert.deepEqual(domain.listCurrentlyApplicableAvailabilityIncidents(readInput(f)).map(incident => incident.id), [result.incident.id]);
  const candidates = f.store.listAvailabilityIncidentCandidates({ now: NOW }).candidates;
  assert.equal(candidates[0].provenance, "provider_runtime");
  assert.equal(candidates[0].source.invocationId, readProviderInvocationFailure(failure).invocationId);
  assert.equal(candidates[0].source.identity.configRevision, readProviderInvocationFailure(failure).identity.configRevision);
  const serialized = JSON.stringify([result, candidates]);
  assert.equal(serialized.includes(PRIVATE_KEY), false);
  assert.equal(serialized.includes(PRIVATE_HEADER), false);
  assert.equal(serialized.includes("credentialProof"), false);
});

test("A's late authentic failure remains A history and cannot poison current B", async t => {
  const f = await fixture(t), domain = await loadDomain();
  const failure = syntheticFailureFact(f, { afterAdmission: () => {
    f.store.updateProviderPreset(f.preset.id, { model: "fixture-model-b", baseUrl: "https://b.invalid/v1", contextWindow: 16_384 }, NOW);
  } });
  const result = domain.recordProviderInvocationFailureObservations({ ...readInput(f), failure });
  assert.ok(result.incident);
  assert.equal(result.incident.modelSignature.model, "fixture-model-a");
  assert.equal(result.contextObservation, undefined);
  assert.equal(domain.providerRuntimeContextObservationForPreset(readInput(f)), undefined);
  assert.deepEqual(domain.listCurrentlyApplicableAvailabilityIncidents(readInput(f)), []);
  assert.equal(f.store.listAvailabilityIncidents({ includeExpired: true }).length, 1);
});

test("a configuration A to B to A cannot restore an old runtime observation", async t => {
  const f = await fixture(t), domain = await loadDomain();
  domain.recordProviderInvocationFailureObservations({ ...readInput(f), failure: syntheticFailureFact(f) });
  f.store.updateProviderPreset(f.preset.id, { model: "fixture-model-b" }, NOW);
  f.store.updateProviderPreset(f.preset.id, { model: "fixture-model-a" }, NOW);
  assert.equal(domain.providerRuntimeContextObservationForPreset(readInput(f)), undefined);
  assert.deepEqual(domain.listCurrentlyApplicableAvailabilityIncidents(readInput(f)), []);
  assert.equal(f.store.listAvailabilityIncidents({ includeExpired: true }).length, 1);
});

test("publication failure remains diagnostic unknown and the same authentic fact may retry", async t => {
  const f = await fixture(t), domain = await loadDomain();
  const failure = syntheticFailureFact(f);
  const original = f.store.createProviderRuntimeAvailabilityIncident.bind(f.store);
  f.store.createProviderRuntimeAvailabilityIncident = () => { throw new Error("Synthetic publication unavailable"); };
  assert.deepEqual(domain.recordProviderInvocationFailureObservations({ ...readInput(f), failure }), {});
  assert.equal(domain.providerRuntimeContextObservationForPreset(readInput(f)), undefined);
  assert.deepEqual(f.store.listAvailabilityIncidents({ includeExpired: true }), []);
  f.store.createProviderRuntimeAvailabilityIncident = original;
  const result = domain.recordProviderInvocationFailureObservations({ ...readInput(f), failure });
  assert.ok(result.incident);
  assert.ok(result.contextObservation);
  assert.deepEqual(domain.listCurrentlyApplicableAvailabilityIncidents(readInput(f)).map(row => row.id), [result.incident.id]);
});

test("a private fact cannot publish to another Store object even with identical preset IDs", async t => {
  const f = await fixture(t), domain = await loadDomain();
  const secondStore = createSqliteRunStore(f.cwd, f.paths);
  t.after(() => secondStore.close());
  const failure = syntheticFailureFact(f);
  assert.ok(secondStore.getProviderPreset(f.preset.id));
  assert.deepEqual(domain.recordProviderInvocationFailureObservations({ store: secondStore, secretResolver: f.secretResolver, failure, now: NOW }), {});
  assert.deepEqual(secondStore.listAvailabilityIncidents({ includeExpired: true }), []);
  assert.equal(domain.providerRuntimeContextObservationForPreset({ ...readInput(f), store: secondStore }), undefined);
});

test("forged and cloned failure handles cannot publish or learn", async t => {
  const f = await fixture(t), domain = await loadDomain();
  const failure = syntheticFailureFact(f);
  for (const invalid of [{}, structuredClone(failure), { invocationId: "forged", rawError: PRIVATE_KEY }]) {
    assert.deepEqual(domain.recordProviderInvocationFailureObservations({ ...readInput(f), failure: invalid }), {});
  }
  assert.deepEqual(f.store.listAvailabilityIncidents({ includeExpired: true }), []);
});

for (const [name, mutate] of [["endpoint", f => f.store.updateProviderPreset(f.preset.id, { baseUrl: "https://different.invalid/v1" }, NOW)],
  ["window", f => f.store.updateProviderPreset(f.preset.id, { contextWindow: 16_384 }, NOW)],
  ["external key", f => { f.values.key = "synthetic-rotated-key"; }],
  ["secret header", f => { f.values.header = "synthetic-rotated-header"; }],
  ["resolver outage", f => { f.values.unavailable = true; }]]) {
  test(`current ${name} drift makes both window and runtime health inapplicable`, async t => {
    const f = await fixture(t), domain = await loadDomain();
    domain.recordProviderInvocationFailureObservations({ ...readInput(f), failure: syntheticFailureFact(f) });
    mutate(f);
    assert.equal(domain.providerRuntimeContextObservationForPreset(readInput(f)), undefined);
    assert.deepEqual(domain.listCurrentlyApplicableAvailabilityIncidents(readInput(f)), []);
    assert.equal(f.store.listAvailabilityIncidents({ includeExpired: true }).length, 1);
  });
}

test("missing optional resolver is unknown without erasing proof or changing generic semantics", async t => {
  const f = await fixture(t), domain = await loadDomain();
  const result = domain.recordProviderInvocationFailureObservations({ ...readInput(f), failure: syntheticFailureFact(f) });
  const manual = generic(f, { providerPresetId: f.preset.id });
  assert.equal(domain.providerRuntimeContextObservationForPreset({ store: f.store, providerPresetId: f.preset.id, now: NOW }), undefined);
  assert.deepEqual(domain.listCurrentlyApplicableAvailabilityIncidents({ store: f.store, providerPresetId: f.preset.id, now: NOW }).map(row => row.id), [manual.id]);
  assert.deepEqual(domain.providerRuntimeContextObservationForPreset(readInput(f)), result.contextObservation);
  assert.ok(domain.listCurrentlyApplicableAvailabilityIncidents(readInput(f)).some(row => row.id === result.incident.id));
});

test("external A to B to A is only a sampled match and restores current applicability", async t => {
  const f = await fixture(t), domain = await loadDomain();
  const result = domain.recordProviderInvocationFailureObservations({ ...readInput(f), failure: syntheticFailureFact(f) });
  f.values.key = "synthetic-intermediate-key";
  assert.equal(domain.providerRuntimeContextObservationForPreset(readInput(f)), undefined);
  f.values.key = PRIVATE_KEY;
  assert.deepEqual(domain.providerRuntimeContextObservationForPreset(readInput(f)), result.contextObservation);
});

test("an expected Attempt scope must be authentic and equivalent to the cache's original scope", async t => {
  const f = await fixture(t), domain = await loadDomain();
  const scopeA = runtimeObservationScopeForProvider(f.store, f.provider);
  const result = domain.recordProviderInvocationFailureObservations({ ...readInput(f), failure: syntheticFailureFact(f) });
  const equivalentProvider = f.resolveProvider();
  const equivalentScope = runtimeObservationScopeForProvider(f.store, equivalentProvider);
  assert.notEqual(equivalentScope, scopeA);
  assert.deepEqual(domain.providerRuntimeContextObservationForPreset(readInput(f, { expectedScope: equivalentScope })), result.contextObservation);
  for (const expectedScope of [{}, structuredClone(scopeA), null]) {
    assert.equal(domain.providerRuntimeContextObservationForPreset(readInput(f, { expectedScope })), undefined);
  }
  f.values.key = "synthetic-cache-key-b";
  const providerB = f.resolveProvider();
  const scopeB = runtimeObservationScopeForProvider(f.store, providerB);
  f.values.key = PRIVATE_KEY;
  assert.equal(domain.providerRuntimeContextObservationForPreset(readInput(f, { expectedScope: scopeB })), undefined);
  assert.deepEqual(domain.providerRuntimeContextObservationForPreset(readInput(f, { expectedScope: scopeA })), result.contextObservation);
});

test("agent runtime target changes are filtered before the accepted limit without excluding generic incidents", async t => {
  const f = await fixture(t), domain = await loadDomain();
  const manual = generic(f, { agentId: "target-agent" });
  const runtime = domain.recordProviderInvocationFailureObservations({ ...readInput(f), agentId: "target-agent", failure: syntheticFailureFact(f) });
  const providerB = f.store.createProviderPreset({ kind: "openai-compatible", displayName: "Synthetic Provider B", providerId: "domain-fixture-b",
    model: "fixture-model-b", api: "openai-completions", baseUrl: "https://b.invalid/v1", contextWindow: 8_192, maxTokens: 1_024,
    apiKeyRef: "env:SYNTHETIC_CACHE_KEY", capabilities: ["chat"], enabled: true }, NOW);
  const lane = readInput(f, { providerPresetId: undefined, agentId: "target-agent", limit: 1 });
  assert.deepEqual(domain.listCurrentlyApplicableAvailabilityIncidents({ ...lane, applicableProviderPresetId: f.preset.id }).map(row => row.id), [runtime.incident.id]);
  assert.deepEqual(domain.listCurrentlyApplicableAvailabilityIncidents({ ...lane, applicableProviderPresetId: providerB.id }).map(row => row.id), [manual.id]);
  assert.deepEqual(domain.listCurrentlyApplicableAvailabilityIncidents({ ...lane, applicableProviderPresetId: null }).map(row => row.id), [manual.id]);
  assert.deepEqual(domain.listCurrentlyApplicableAvailabilityIncidents(lane).map(row => row.id), [runtime.incident.id], "omitted target is the global projection");
});

test("wall-clock rollback makes future runtime health and windows unknown without erasing their proof", async t => {
  const f = await fixture(t), domain = await loadDomain();
  const result = domain.recordProviderInvocationFailureObservations({ ...readInput(f), failure: syntheticFailureFact(f) });
  assert.equal(domain.providerRuntimeContextObservationForPreset(readInput(f, { now: at(-1) })), undefined);
  assert.deepEqual(domain.listCurrentlyApplicableAvailabilityIncidents(readInput(f, { now: at(-1) })), []);
  assert.deepEqual(domain.providerRuntimeContextObservationForPreset(readInput(f)), result.contextObservation);
  assert.deepEqual(domain.listCurrentlyApplicableAvailabilityIncidents(readInput(f)).map(row => row.id), [result.incident.id]);
  assert.equal(f.store.listAvailabilityIncidents({ includeExpired: true }).length, 1);
});

test("a future-settled authentic fact is durable history but cannot learn at an earlier current time", async t => {
  const f = await fixture(t), domain = await loadDomain();
  const result = domain.recordProviderInvocationFailureObservations({ ...readInput(f, { now: at(-1) }), failure: syntheticFailureFact(f) });
  assert.ok(result.incident);
  assert.equal(result.contextObservation, undefined);
  assert.deepEqual(domain.listCurrentlyApplicableAvailabilityIncidents(readInput(f, { now: at(-1) })), []);
  assert.equal(domain.providerRuntimeContextObservationForPreset(readInput(f)), undefined, "publication did not learn a future value");
});

test("six-hour strict greater-than expiry applies to reads and expires old minima before merging", async t => {
  const f = await fixture(t), domain = await loadDomain();
  domain.recordProviderInvocationFailureObservations({ ...readInput(f), failure: syntheticFailureFact(f) });
  assert.equal(domain.providerRuntimeContextObservationForPreset(readInput(f, { now: at(SIX_HOURS) })).observedContextWindowTokens, 2_048);
  assert.equal(domain.providerRuntimeContextObservationForPreset(readInput(f, { now: at(SIX_HOURS + 1) })), undefined);
  const second = syntheticFailureFact(f, { id: "second-window", settledAt: at(SIX_HOURS + 1), contextBudget: budget(6_000) });
  const result = domain.recordProviderInvocationFailureObservations({ ...readInput(f, { now: at(SIX_HOURS + 1) }), failure: second });
  assert.equal(result.contextObservation.observedContextWindowTokens, 5_652);
  assert.equal(result.contextObservation.observedAt, at(SIX_HOURS + 1));
});

test("minimum merging itself expires an old smaller value even without an intervening read", async t => {
  const f = await fixture(t), domain = await loadDomain();
  domain.recordProviderInvocationFailureObservations({ ...readInput(f), failure: syntheticFailureFact(f) });
  const later = syntheticFailureFact(f, { id: "later-window", settledAt: at(SIX_HOURS + 1), contextBudget: budget(6_000) });
  const result = domain.recordProviderInvocationFailureObservations({ ...readInput(f, { now: at(SIX_HOURS + 1) }), failure: later });
  assert.equal(result.contextObservation.observedContextWindowTokens, 5_652);
});

test("old failure publication anchors history to its settled time and cannot learn after expiry", async t => {
  const f = await fixture(t), domain = await loadDomain();
  const result = domain.recordProviderInvocationFailureObservations({ ...readInput(f, { now: at(SIX_HOURS + 1) }), failure: syntheticFailureFact(f) });
  assert.equal(result.incident.observedAt, NOW);
  assert.equal(result.contextObservation, undefined);
  assert.deepEqual(domain.listCurrentlyApplicableAvailabilityIncidents(readInput(f, { now: at(SIX_HOURS + 1) })), []);
});

test("missing or invalid numeric evidence still publishes availability but never learns a window", async t => {
  const f = await fixture(t), domain = await loadDomain();
  for (const [index, contextBudget] of [null, { ...budget(), estimatedInputTokens: NaN }, { ...budget(), rawPrompt: PRIVATE_KEY }].entries()) {
    const result = domain.recordProviderInvocationFailureObservations({ ...readInput(f), failure: syntheticFailureFact(f, { id: `invalid-budget-${index}`, contextBudget }) });
    assert.ok(result.incident);
    assert.equal(result.contextObservation, undefined);
  }
  assert.equal(domain.providerRuntimeContextObservationForPreset(readInput(f)), undefined);
});

test("a non-context bounded failure does not learn even when it carries a valid budget", async t => {
  const f = await fixture(t), domain = await loadDomain();
  const result = domain.recordProviderInvocationFailureObservations({ ...readInput(f), failure: syntheticFailureFact(f, { category: "rate_limited" }) });
  assert.equal(result.incident.state, "rate_limited");
  assert.equal(result.contextObservation, undefined);
});

test("generic provider rows pass while provider/model legacy rows are unknown and old agent-only rows pass", async t => {
  const f = await fixture(t), domain = await loadDomain();
  const manual = generic(f, { providerPresetId: f.preset.id });
  const legacyProvider = generic(f, { providerPresetId: f.preset.id });
  const legacyModel = generic(f, { modelSignature: { model: "old-model" } });
  const legacyAgent = generic(f, { agentId: "old-agent" });
  for (const incident of [legacyProvider, legacyModel, legacyAgent]) {
    f.store.database.prepare("DELETE FROM channel_team_incident_provenance WHERE incident_id = ?").run(incident.id);
  }
  f.values.key = "synthetic-new-key";
  assert.deepEqual(domain.listCurrentlyApplicableAvailabilityIncidents({ store: f.store, now: NOW, secretResolver: f.secretResolver })
    .map(row => row.id), [legacyAgent.id, manual.id]);
  assert.deepEqual(domain.listCurrentlyApplicableAvailabilityIncidents({ store: f.store, now: NOW, secretResolver: f.secretResolver,
    applicableProviderPresetId: null }).map(row => row.id), [legacyAgent.id, manual.id]);
});

test("reopened Host authority preserves incident history but cannot reconstruct private runtime applicability", async t => {
  const f = await fixture(t), domain = await loadDomain();
  const result = domain.recordProviderInvocationFailureObservations({ ...readInput(f), failure: syntheticFailureFact(f) });
  const reopened = createSqliteRunStore(f.cwd, f.paths);
  t.after(() => reopened.close());
  assert.equal(reopened.listAvailabilityIncidents({ includeExpired: true })[0].id, result.incident.id);
  assert.deepEqual(domain.listCurrentlyApplicableAvailabilityIncidents({ ...readInput(f), store: reopened }), []);
  assert.equal(domain.providerRuntimeContextObservationForPreset({ ...readInput(f), store: reopened }), undefined);
});

test("filtering scans beyond 500 rejected candidates before applying the accepted limit", async t => {
  const f = await fixture(t), domain = await loadDomain();
  const accepted = generic(f, { agentId: "target-agent" });
  const failure = syntheticFailureFact(f);
  const fact = readProviderInvocationFailure(failure);
  for (let index = 0; index < 650; index += 1) {
    f.store.createProviderRuntimeAvailabilityIncident({ incident: { agentId: "target-agent", providerPresetId: f.preset.id,
      state: "slow", kind: "timeout", summary: "Synthetic unknown runtime history", observedAt: NOW, expiresAt: at(60_000) },
      source: { observationId: `unregistered-${index}`, invocationId: `unregistered-invocation-${index}`, taskId: fact.taskId,
        runId: fact.runId, attemptId: fact.attemptId, origin: fact.origin, admittedAt: fact.admittedAt, settledAt: fact.settledAt, identity: fact.identity } }, NOW);
  }
  let pages = 0;
  const original = f.store.listAvailabilityIncidentCandidates.bind(f.store);
  f.store.listAvailabilityIncidentCandidates = options => { pages += 1; return original(options); };
  assert.deepEqual(domain.listCurrentlyApplicableAvailabilityIncidents({ store: f.store, secretResolver: f.secretResolver,
    now: NOW, agentId: "target-agent", limit: 1 }).map(row => row.id), [accepted.id]);
  assert.equal(pages, 2);
});

test("a later candidate page failure cannot publish a partial current-health snapshot", async t => {
  const f = await fixture(t), domain = await loadDomain();
  generic(f, { agentId: "page-reader-agent" });
  const original = f.store.listAvailabilityIncidentCandidates.bind(f.store);
  let pages = 0;
  f.store.listAvailabilityIncidentCandidates = options => {
    pages += 1;
    if (pages > 1) throw new Error("Synthetic candidate reader unavailable");
    return { ...original(options), nextCursor: Object.freeze({}) };
  };
  assert.deepEqual(domain.listCurrentlyApplicableAvailabilityIncidents(readInput(f, { providerPresetId: undefined, limit: 2 })), []);
  assert.equal(pages, 2);
  assert.equal(f.store.listAvailabilityIncidents({ includeExpired: true }).length, 1);
});

test("the 4096-entry private registry evicts applicability rather than replaying old proof", async t => {
  const f = await fixture(t), domain = await loadDomain();
  let first, last;
  for (let index = 0; index < 4_097; index += 1) {
    const result = domain.recordProviderInvocationFailureObservations({ ...readInput(f), failure: syntheticFailureFact(f, { id: `bounded-${index}`, category: "rate_limited", contextBudget: null }) });
    first ??= result.incident;
    last = result.incident;
  }
  const rows = domain.listCurrentlyApplicableAvailabilityIncidents(readInput(f, { limit: 4_097 }));
  assert.equal(rows.length, 4_096);
  assert.equal(rows.some(row => row.id === first.id), false);
  assert.equal(rows.some(row => row.id === last.id), true);
  assert.equal(f.store.database.prepare("SELECT COUNT(*) AS count FROM channel_team_incidents WHERE incident_type='availability'").get().count,
    4_097, "private registry eviction must not delete durable history");
});

test("one actual SDK loopback context failure publishes scoped facts without leaking request contents", { timeout: 20_000 }, async t => {
  const f = await fixture(t), domain = await loadDomain();
  let requests = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests += 1;
      assert.equal(request.headers.authorization === `Bearer ${PRIVATE_KEY}`, true);
      assert.equal(request.headers["x-secret-tenant"] === PRIVATE_HEADER, true);
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "context_length_exceeded", message: `context length exceeded ${PRIVATE_KEY} ${PRIVATE_HEADER}` } }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });
  f.store.updateProviderPreset(f.preset.id, { baseUrl: `http://127.0.0.1:${server.address().port}/v1` }, NOW);
  f.provider = f.resolveProvider();
  // Pi owns the SDK dependency. Resolve its installed ESM entrypoint here
  // rather than assuming the Daemon has a direct dependency or require export.
  const { ModelRuntime } = await import(new URL("../../runner-pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js", import.meta.url));
  const { InMemoryCredentialStore, InMemoryModelsStore } = await import(new URL("../../runner-pi/node_modules/@earendil-works/pi-ai/dist/index.js", import.meta.url));
  const { createPiTaskBoundary } = await import("../../runner-pi/dist/task-boundary.js");
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider(f.provider.provider, { api: f.provider.api, apiKey: f.provider.apiKey, headers: f.provider.headers, baseUrl: f.provider.baseUrl });
  const composed = runtime.getProvider(f.provider.provider);
  runtime.registerProvider(f.provider.provider, { api: f.provider.api,
    streamSimple: (model, context, options) => composed.streamSimple(model, context, { ...options, maxRetries: 0 }) });
  let failure;
  const callbacks = createProviderInvocationObserver({ store: f.store, provider: f.provider, taskId: "actual-domain-task",
    runId: "actual-domain-run", attemptId: "actual-domain-attempt", origin: "task", onFailure: value => { failure = value; } });
  const options = { cwd: f.cwd, task: { id: "actual-domain-task", title: "Actual domain SDK", prompt: "Synthetic fixture only." },
    provider: f.provider, runId: "actual-domain-run", runnerAttemptId: "actual-domain-attempt", ...callbacks };
  createPiTaskBoundary(options).bindModelRuntime(runtime);
  const model = { provider: f.provider.provider, id: f.provider.model, api: f.provider.api, baseUrl: f.provider.baseUrl,
    reasoning: false, input: ["text"], contextWindow: f.provider.contextWindow, maxTokens: f.provider.maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const result = await runtime.streamSimple(model, { systemPrompt: "Synthetic only", messages: [{ role: "user", content: "Finish synthetic request", timestamp: 0 }] }, {}).result();
  assert.equal(result.stopReason, "error");
  assert.equal(requests, 1, "actual SDK transport, not a fabricated public receipt");
  assert.ok(failure);
  const observed = domain.recordProviderInvocationFailureObservations({ store: f.store, secretResolver: f.secretResolver, failure });
  assert.ok(observed.incident);
  assert.ok(observed.contextObservation);
  assert.equal(JSON.stringify(observed).includes(PRIVATE_KEY), false);
  assert.equal(JSON.stringify(observed).includes(PRIVATE_HEADER), false);
});
