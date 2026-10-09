import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, resolveStoragePaths, toRuntimeAttemptFence } from "@ling-stack/core";
import { recordProviderInvocationFailureObservations } from "../dist/features/providers/runtime-failure-observations.js";
import { createProviderInvocationObserver } from "../dist/features/providers/runtime-invocations.js";
import { runtimeObservationScopeForProvider } from "../dist/features/providers/runtime-observation-scope.js";
import { resolveProviderForRun } from "../dist/features/runs/providers.js";
import { hydrateRunnerToolSurface } from "../dist/features/runs/tool-surfaces.js";

const loadBudget = () => import("../dist/features/runs/tool-context-budget.js");
const loadScope = () => import("../dist/features/providers/runtime-observation-scope.js");
const KEY = "synthetic-tool-budget-private-key";
const HEADER = "synthetic-tool-budget-private-header";

async function fixture(t, presetInput = {}) {
  const now = new Date().toISOString();
  const directory = await mkdtemp(resolve(tmpdir(), "ling-tool-context-budget-"));
  const cwd = resolve(directory, "workspace");
  const paths = resolveStoragePaths(cwd, { homeDir: resolve(directory, "home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  const store = createSqliteRunStore(cwd, paths);
  t.after(async () => { if (store.database.isOpen) store.close(); await rm(directory, { recursive: true, force: true }); });
  const preset = store.createProviderPreset({ kind: "openai-compatible", displayName: "Synthetic tool budget fixture", providerId: "tool-budget-fixture",
    model: "tool-budget-model-a", api: "openai-completions", baseUrl: "https://a.invalid/v1", apiKeyRef: "env:SYNTHETIC_TOOL_BUDGET_KEY",
    secretHeaderRefs: { "X-Tenant": "env:SYNTHETIC_TOOL_BUDGET_HEADER" }, capabilities: ["chat", "tool_call"], enabled: true,
    ...presetInput }, now);
  const values = { key: KEY, header: HEADER, unavailable: false };
  const secretResolver = {
    status(ref) { return { ref, kind: "env", configured: !values.unavailable }; },
    resolve(ref) {
      if (values.unavailable) throw new Error("Synthetic resolver unavailable");
      return { ref, configured: true, status: this.status(ref), value: ref.endsWith("HEADER") ? values.header : values.key };
    },
  };
  const provider = resolveProviderForRun(store, { providerPresetId: preset.id, skipProviderPreflight: true }, secretResolver);
  const scope = runtimeObservationScopeForProvider(store, provider);
  assert.ok(scope);
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "budget-run",
    idempotencyKey: "budget-run", status: "running", providerPresetId: preset.id, createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "budget-runtime",
    providerPresetId: preset.id, runnerId: "runner_pi_embedded", status: "started", now });
  const run = store.createRun({ id: "budget-run", cwd, workUnitId: unit.id, taskId: "budget-task", providerPresetId: preset.id,
    providerName: provider.provider, providerModel: provider.model, taskSnapshot: {},
    providerSnapshot: { providerPresetId: preset.id, provider: provider.provider, model: provider.model, api: provider.api,
      ...(provider.contextWindow === undefined ? {} : { contextWindow: provider.contextWindow }),
      ...(provider.maxTokens === undefined ? {} : { maxTokens: provider.maxTokens }) }, requestSnapshot: {}, createdAt: now });
  store.linkRunToWorkUnit(run.id, unit.id, now);
  store.markRunStarted(run.id, now);
  const f = { now, directory, cwd, paths, store, preset, values, secretResolver, provider, scope, unit, attempt, run };
  f.input = (overrides = {}) => ({ store, run, actualProvider: provider, observationScope: scope, secretResolver, now, ...overrides });
  f.hydrate = (overrides = {}) => hydrateRunnerToolSurface({ ...f.input(), sourceFence: toRuntimeAttemptFence(attempt),
    runnerRegistry: { list: () => [{ id: "runner_pi_embedded", displayName: "Pi", status: "enabled", supportedTools: ["read"] }] },
    request: { runId: run.id, runnerAttemptId: attempt.id, scope: { kind: "tool", toolId: "core:read" }, reason: "Synthetic read schema" }, ...overrides });
  return f;
}

/** Authentic Host-fold fixture, not a network-call or completed execution claim. */
function learnWindow(f, provider = f.provider) {
  let failure;
  const callbacks = createProviderInvocationObserver({ store: f.store, provider, taskId: f.run.taskId,
    runId: f.run.id, attemptId: f.attempt.id, origin: "task", onFailure: value => { failure = value; } });
  const contextBudget = { schemaVersion: 1, basis: "pi_projected_context_estimate", estimatedInputTokens: 500,
    contextWindowTokens: 8_192, reservedOutputTokens: 1_024, reservedRuntimeOverheadTokens: 512, inputBudgetTokens: 6_656 };
  const receipt = { invocationId: "tool-budget-invocation", taskId: f.run.taskId, runId: f.run.id, attemptId: f.attempt.id,
    admittedAt: f.now, contextBudget };
  callbacks.onProviderInvocationAdmitted(receipt);
  callbacks.onProviderInvocationSettled({ ...receipt, settledAt: f.now, outcome: "provider_error",
    errorDiagnostic: { schemaVersion: 1, category: "context_limit", basis: "sdk_error_marker" } });
  assert.ok(failure);
  const result = recordProviderInvocationFailureObservations({ store: f.store, secretResolver: f.secretResolver, failure, now: f.now });
  assert.equal(result.contextObservation?.observedContextWindowTokens, 2_048);
  return result;
}

function moveToB(f) {
  f.store.updateProviderPreset(f.preset.id, { baseUrl: "https://b.invalid/v1", model: "tool-budget-model-b" }, f.now);
  const providerB = resolveProviderForRun(f.store, { providerPresetId: f.preset.id, skipProviderPreflight: true }, f.secretResolver);
  learnWindow(f, providerB);
  return providerB;
}

test("active Attempt hydration cannot consume replacement B's learned window", async t => {
  const f = await fixture(t);
  moveToB(f);
  const response = f.hydrate();
  assert.equal(response.ok, true);
  assert.equal(response.materialization.budget.inputBudgetTokens, 6_656,
    "the live A Attempt owns its original static budget, not current B's runtime window");
});

test("the original scope yields an isolated configuration clone without materialized credentials", async t => {
  const f = await fixture(t);
  const { providerPresetForRuntimeObservationScope } = await loadScope();
  const captured = providerPresetForRuntimeObservationScope(f.scope);
  assert.equal(captured.model, "tool-budget-model-a");
  assert.equal(JSON.stringify(captured).includes(KEY), false);
  assert.equal(JSON.stringify(captured).includes(HEADER), false);
  captured.model = "mutated-test-clone";
  captured.headers["X-Test"] = "mutated-test-header";
  assert.equal(providerPresetForRuntimeObservationScope(f.scope).model, "tool-budget-model-a");
  assert.equal(providerPresetForRuntimeObservationScope(f.scope).headers["X-Test"], undefined);
  assert.equal(providerPresetForRuntimeObservationScope(structuredClone(f.scope)), undefined);
  assert.equal(providerPresetForRuntimeObservationScope({}), undefined);
});

test("a matching actual Provider and original scope may consume a current learned window", async t => {
  const f = await fixture(t), { resolveRunToolContextBudget } = await loadBudget();
  learnWindow(f);
  const budget = resolveRunToolContextBudget(f.input());
  assert.equal(budget.contextWindowTokens, 2_048);
  assert.equal(budget.inputBudgetTokens, 1_024);
  assert.equal(budget.capabilitySource, "runtime_observed");
});

test("a stale actual Provider remains on its captured static budget after B learns", async t => {
  const f = await fixture(t), { resolveRunToolContextBudget } = await loadBudget();
  moveToB(f);
  const budget = resolveRunToolContextBudget(f.input());
  assert.equal(budget.contextWindowTokens, 8_192);
  assert.equal(budget.inputBudgetTokens, 6_656);
  assert.notEqual(budget.capabilitySource, "runtime_observed");
});

test("one Attempt cannot borrow B's cache when two external credential samples would match different scopes", async t => {
  const f = await fixture(t), { resolveRunToolContextBudget } = await loadBudget();
  const keyB = "synthetic-tool-budget-key-b";
  f.values.key = keyB;
  const providerB = resolveProviderForRun(f.store, { providerPresetId: f.preset.id, skipProviderPreflight: true }, f.secretResolver);
  learnWindow(f, providerB);
  let keyReads = 0;
  f.secretResolver.resolve = ref => ({ ref, configured: true, status: f.secretResolver.status(ref),
    value: ref.endsWith("HEADER") ? HEADER : keyReads++ === 0 ? KEY : keyB });
  const budget = resolveRunToolContextBudget(f.input());
  assert.equal(budget.inputBudgetTokens, 6_656, "two independent current samples cannot make B's window belong to A");
  assert.equal(keyReads, 0, "scope equivalence rejects B's cache before sampling external credentials");
});

test("external value drift and resolver outage remove runtime reuse without banning static budgeting", async t => {
  const f = await fixture(t), { resolveRunToolContextBudget } = await loadBudget();
  learnWindow(f);
  f.values.key = "synthetic-rotated-tool-key";
  assert.equal(resolveRunToolContextBudget(f.input()).inputBudgetTokens, 6_656);
  f.values.key = KEY;
  assert.equal(resolveRunToolContextBudget(f.input()).inputBudgetTokens, 1_024);
  f.values.unavailable = true;
  assert.equal(resolveRunToolContextBudget(f.input()).inputBudgetTokens, 6_656);
  assert.equal(resolveRunToolContextBudget(f.input({ secretResolver: undefined })).inputBudgetTokens, 6_656);
});

test("an unproven actual Provider uses its own numeric static capacity instead of the Run or current preset", async t => {
  const f = await fixture(t), { resolveRunToolContextBudget } = await loadBudget();
  moveToB(f);
  const provider = { provider: "static-actual", model: "static-model", api: "anthropic-messages", contextWindow: 32_768, maxTokens: 4_096 };
  const budget = resolveRunToolContextBudget(f.input({ actualProvider: provider, observationScope: undefined }));
  assert.equal(budget.contextWindowTokens, 32_768);
  assert.equal(budget.reservedOutputTokens, 4_096);
  assert.equal(budget.inputBudgetTokens, 28_160);
  assert.equal(budget.tokenizer, "anthropic-compatible");
  assert.notEqual(budget.capabilitySource, "runtime_observed");
});

test("a cloned actual Provider or a different owning Store cannot borrow the original scope", async t => {
  const f = await fixture(t), { resolveRunToolContextBudget } = await loadBudget();
  learnWindow(f);
  const clone = structuredClone(f.provider);
  assert.equal(resolveRunToolContextBudget(f.input({ actualProvider: clone })).inputBudgetTokens, 6_656);
  const reopened = createSqliteRunStore(f.cwd, f.paths);
  t.after(() => reopened.close());
  assert.equal(resolveRunToolContextBudget(f.input({ store: reopened })).inputBudgetTokens, 6_656);
});

test("HTTP-style reads use frozen Run numeric values without touching current configuration or runtime cache", async t => {
  const f = await fixture(t), { resolveRunToolContextBudget } = await loadBudget();
  moveToB(f);
  const run = { ...f.run, providerSnapshot: { provider: "snapshot-provider", model: "snapshot-model", api: "openai-responses",
    contextWindow: 32_768, maxTokens: 2_048 } };
  f.store.getProviderPreset = () => { throw new Error("Current preset must not be reread"); };
  f.store.getProviderConfigurationSnapshot = () => { throw new Error("Current authority must not be sampled"); };
  const budget = resolveRunToolContextBudget(f.input({ run, actualProvider: undefined, observationScope: undefined }));
  assert.equal(budget.contextWindowTokens, 32_768);
  assert.equal(budget.inputBudgetTokens, 30_208);
  assert.notEqual(budget.capabilitySource, "runtime_observed");
});

test("snapshot static selection never invokes accessors, toJSON, or reads materialized secret fields", async t => {
  const f = await fixture(t), { resolveRunToolContextBudget } = await loadBudget();
  let reads = 0;
  const snapshot = { provider: "snapshot-provider", model: "snapshot-model", api: "openai-completions", contextWindow: 16_384, maxTokens: 1_024,
    toJSON() { reads += 1; throw new Error("Must not serialize snapshot"); } };
  for (const key of ["apiKey", "headers", "secretHeaderRefs", "baseUrl"]) Object.defineProperty(snapshot, key, { get() { reads += 1; throw new Error("Must not read private field"); } });
  const budget = resolveRunToolContextBudget(f.input({ run: { ...f.run, providerSnapshot: snapshot }, actualProvider: undefined, observationScope: undefined }));
  assert.equal(reads, 0);
  assert.equal(budget.inputBudgetTokens, 14_848);
  Object.defineProperty(snapshot, "contextWindow", { get() { reads += 1; throw new Error("Must not invoke a numeric accessor"); } });
  const conservative = resolveRunToolContextBudget(f.input({ run: { ...f.run, providerSnapshot: snapshot }, actualProvider: undefined, observationScope: undefined }));
  assert.equal(reads, 0);
  assert.equal(conservative.contextWindowTokens, 8_192);
});

test("missing or malformed frozen numeric evidence uses conservative static defaults, never current B", async t => {
  const f = await fixture(t), { resolveRunToolContextBudget } = await loadBudget();
  moveToB(f);
  for (const snapshot of [undefined, {}, { contextWindow: NaN, maxTokens: Infinity }, { contextWindow: -1, maxTokens: 0 }]) {
    const budget = resolveRunToolContextBudget(f.input({ run: { ...f.run, providerSnapshot: snapshot }, actualProvider: undefined, observationScope: undefined }));
    assert.equal(budget.contextWindowTokens, 8_192);
    assert.equal(budget.inputBudgetTokens, 6_656);
    assert.notEqual(budget.capabilitySource, "runtime_observed");
  }
});
