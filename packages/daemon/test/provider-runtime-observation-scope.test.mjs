import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { inspect } from "node:util";
import test from "node:test";
import {
  createSqliteRunStore,
  providerThinkingModesToLevelMap,
  resolveStoragePaths,
} from "@ling-stack/core";
import {
  bindResolvedProviderObservationScope,
  captureProviderConfigurationTicket,
  compareProviderRuntimeObservationScope,
  providerPresetForConfigurationTicket,
  runtimeObservationScopeForProvider,
} from "../dist/features/providers/runtime-observation-scope.js";
import { materializeProviderSecrets } from "../dist/features/providers/secret-materializer.js";
import { resolveProviderForRun } from "../dist/features/runs/providers.js";

// These are synthetic fixture values, never reads of process.env or Keychain.
const NOW = "2026-10-10T00:00:00.000Z";
const API_REF = "env:LING_RUNTIME_SCOPE_SYNTHETIC_KEY";
const HEADER_REFS = {
  "X-Tenant": "env:LING_RUNTIME_SCOPE_SYNTHETIC_TENANT",
  "X-Route": "keychain:LING_RUNTIME_SCOPE_SYNTHETIC_ROUTE",
};
const PRIVATE_MARKER = "synthetic-private-key-marker";
const PRIVATE_PATH = "/private/synthetic-runtime-scope-path";
const INPUT = {
  kind: "openai-compatible",
  displayName: "Synthetic observation scope fixture",
  providerId: "fixture-provider",
  model: "fixture-model",
  api: "openai-completions",
  baseUrl: "https://provider-a.example.test/v1",
  apiKeyRef: API_REF,
  headers: { "X-Static": "static-header-a" },
  contextWindow: 128_000,
  maxTokens: 4_000,
  compat: { supportsDeveloperRole: false },
  input: ["text"],
  capabilities: ["chat"],
  enabled: true,
};

async function fixture(t, options = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), "ling-runtime-observation-scope-"));
  const stores = [];
  const open = (suffix = "workspace") => {
    const cwd = resolve(directory, suffix);
    const paths = resolveStoragePaths(cwd, {
      homeDir: resolve(directory, "home"), env: {}, workspaceStateLocation: "repo-local",
    }).workspace;
    const store = createSqliteRunStore(cwd, paths);
    stores.push(store);
    return store;
  };
  t.after(async () => {
    for (const store of stores.reverse()) if (store.database.isOpen) store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const store = open();
  let preset = store.createProviderPreset({
    ...INPUT,
    ...(options.keyKind === "keychain" ? { apiKeyRef: "keychain:LING_RUNTIME_SCOPE_SYNTHETIC_KEY" } : {}),
    ...(options.secretHeaders ? { secretHeaderRefs: HEADER_REFS } : {}),
    ...(options.input ?? {}),
  }, NOW);
  if (options.keyKind === "local") {
    store.setProviderSecret(preset.id, "managed-key-a", NOW);
    preset = store.updateProviderPreset(preset.id, { apiKeyRef: `local:${preset.id}` }, NOW);
  }
  const values = new Map([
    [API_REF, "external-key-a"],
    ["keychain:LING_RUNTIME_SCOPE_SYNTHETIC_KEY", "external-keychain-a"],
    [HEADER_REFS["X-Tenant"], "external-tenant-a"],
    [HEADER_REFS["X-Route"], "external-route-a"],
  ]);
  const calls = [];
  const f = { store, open, preset, values, calls, onResolve: undefined, resolver: undefined };
  f.resolver = {
    status(ref, purpose) {
      calls.push({ kind: "status", ref, purpose });
      return { ref, kind: ref.startsWith("keychain:") ? "keychain" : "env", configured: values.has(ref) };
    },
    resolve(ref, purpose) {
      calls.push({ kind: "resolve", ref, purpose });
      f.onResolve?.(ref, purpose);
      const value = values.get(ref);
      return {
        ref, configured: typeof value === "string" && value.length > 0, value,
        status: {
          ref, kind: ref.startsWith("keychain:") ? "keychain" : "env",
          configured: typeof value === "string" && value.length > 0,
        },
      };
    },
  };
  return f;
}

function runnerProvider(preset, materialized) {
  return Object.fromEntries(Object.entries({
    provider: preset.providerId,
    model: preset.model,
    displayName: preset.displayName,
    apiKey: materialized.apiKeySecret.value,
    baseUrl: preset.baseUrl,
    api: preset.api,
    providerTransport: preset.api === "openai-codex-responses" ? preset.providerTransport ?? "sse" : undefined,
    headers: materialized.headers,
    authHeader: preset.authHeader,
    reasoning: preset.reasoning,
    thinkingLevelMap: providerThinkingModesToLevelMap(preset.thinkingModes),
    input: structuredClone(preset.input),
    contextWindow: preset.contextWindow,
    maxTokens: preset.maxTokens,
    compat: structuredClone(preset.compat),
  }).filter(([, value]) => value !== undefined));
}

function resolved(f, overrides = {}) {
  const store = overrides.store ?? f.store;
  const ticket = overrides.ticket ?? captureProviderConfigurationTicket(store, f.preset.id);
  assert.ok(ticket, "a live atomic configuration must produce a ticket");
  const preset = providerPresetForConfigurationTicket(ticket);
  assert.ok(preset);
  const materialized = overrides.materialized ?? materializeProviderSecrets({
    store, preset, secretResolver: f.resolver,
  });
  const provider = overrides.provider ?? runnerProvider(preset, materialized);
  const scope = bindResolvedProviderObservationScope({ store, ticket, provider, materialized, materializedPreset: preset });
  return { ticket, preset, provider, materialized, scope };
}

function compare(f, scope, overrides = {}) {
  return compareProviderRuntimeObservationScope({
    store: f.store, scope, secretResolver: f.resolver, ...overrides,
  });
}

function copyProviderRow(source, target, providerId) {
  const row = source.database.prepare("SELECT * FROM provider_presets WHERE id=?").get(providerId);
  assert.ok(row);
  const columns = Object.keys(row);
  target.database.prepare(`INSERT INTO provider_presets (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
    .run(...columns.map(column => row[column]));
}

test("configuration tickets come from the atomic authority and have no inspectable payload", async (t) => {
  const f = await fixture(t);
  const snapshot = f.store.getProviderConfigurationSnapshot(f.preset.id);
  const ticket = captureProviderConfigurationTicket(f.store, f.preset.id);
  assert.ok(ticket);
  assert.deepEqual(providerPresetForConfigurationTicket(ticket), snapshot.provider);
  assert.equal(Object.isFrozen(ticket), true);
  assert.deepEqual(Reflect.ownKeys(ticket), []);
  assert.deepEqual(Object.getOwnPropertyDescriptors(ticket), {});
  assert.equal(JSON.stringify(ticket), "{}");
  assert.equal(captureProviderConfigurationTicket(f.store, "missing-provider"), undefined);
});

test("capture never falls back to the non-atomic preset getter", async (t) => {
  const f = await fixture(t);
  const store = Object.create(f.store);
  store.getProviderPreset = () => { throw new Error("separate getter was called"); };
  const ticket = captureProviderConfigurationTicket(store, f.preset.id);
  assert.ok(ticket);
  assert.deepEqual(providerPresetForConfigurationTicket(ticket), f.preset);
});

test("unavailable or invalid atomic authority cannot fabricate a configuration ticket", async (t) => {
  const f = await fixture(t);
  const snapshot = f.store.getProviderConfigurationSnapshot(f.preset.id);
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined]) {
    const store = Object.create(f.store);
    store.getProviderConfigurationSnapshot = () => ({ ...snapshot, configRevision: value });
    assert.equal(captureProviderConfigurationTicket(store, f.preset.id), undefined);
  }
  const failing = Object.create(f.store);
  failing.getProviderConfigurationSnapshot = () => { throw new Error(`${PRIVATE_MARKER} at ${PRIVATE_PATH}`); };
  assert.equal(captureProviderConfigurationTicket(failing, f.preset.id), undefined);
  const absent = Object.create(f.store);
  absent.getProviderConfigurationSnapshot = undefined;
  assert.equal(captureProviderConfigurationTicket(absent, f.preset.id), undefined);
});

test("cloned and fabricated tickets cannot acquire configuration authority", async (t) => {
  const f = await fixture(t);
  const r = resolved(f);
  for (const ticket of [{}, Object.freeze({}), { ...r.ticket }, structuredClone(r.ticket), JSON.parse(JSON.stringify(r.ticket))]) {
    assert.equal(providerPresetForConfigurationTicket(ticket), undefined);
    assert.equal(bindResolvedProviderObservationScope({ store: f.store, ticket, provider: r.provider, materialized: r.materialized, materializedPreset: r.preset }), undefined);
  }
  assert.equal(providerPresetForConfigurationTicket(undefined), undefined);
});

test("reading the ticket preset cannot mutate the captured configuration", async (t) => {
  const f = await fixture(t);
  const ticket = captureProviderConfigurationTicket(f.store, f.preset.id);
  const exposed = providerPresetForConfigurationTicket(ticket);
  Reflect.set(exposed.headers, "X-Static", "attempted-ticket-mutation");
  Reflect.set(exposed.compat, "supportsDeveloperRole", true);
  Reflect.set(exposed, "baseUrl", "https://forged.example.test/v1");
  assert.deepEqual(providerPresetForConfigurationTicket(ticket), f.preset);
  assert.deepEqual(f.store.getProviderPreset(f.preset.id), f.preset);
});

test("scopes are frozen empty nominal values and serialize no proof, secret or configuration", async (t) => {
  const f = await fixture(t, { secretHeaders: true });
  f.values.set(API_REF, PRIVATE_MARKER);
  const r = resolved(f);
  assert.ok(r.scope);
  assert.equal(runtimeObservationScopeForProvider(f.store, r.provider), r.scope);
  assert.equal(Object.isFrozen(r.scope), true);
  assert.deepEqual(Reflect.ownKeys(r.scope), []);
  assert.deepEqual(Object.getOwnPropertyDescriptors(r.scope), {});
  assert.equal(JSON.stringify(r.scope), "{}");
  const reflected = inspect(r.scope, { showHidden: true });
  assert.doesNotMatch(reflected, /synthetic-private-key-marker|external-tenant|external-route|provider-a|configRevision|proof|digest/);
  for (const scope of [{}, { ...r.scope }, structuredClone(r.scope), JSON.parse(JSON.stringify(r.scope)), undefined]) {
    assert.equal(compare(f, scope).state, "unknown");
  }
});

test("managed credentials match their durable generation without reading external secrets", async (t) => {
  const f = await fixture(t, { keyKind: "local" });
  const r = resolved(f);
  assert.ok(r.scope);
  assert.equal(compare(f, r.scope).state, "managed_generation_match");
  assert.deepEqual(f.calls, []);
});

test("managed key A to B to A invalidates the original scope even at the same timestamp", async (t) => {
  const f = await fixture(t, { keyKind: "local" });
  const before = f.store.getProviderConfigurationSnapshot(f.preset.id);
  const r = resolved(f);
  f.store.setProviderSecret(f.preset.id, "managed-key-b", NOW);
  f.store.setProviderSecret(f.preset.id, "managed-key-a", NOW);
  const after = f.store.getProviderConfigurationSnapshot(f.preset.id);
  assert.deepEqual(after.provider, before.provider);
  assert.ok(after.configRevision > before.configRevision);
  assert.equal(compare(f, r.scope).state, "changed");
});

for (const [name, input] of [
  ["endpoint", { baseUrl: "https://provider-b.example.test/v1" }],
  ["context window", { contextWindow: 256_000 }],
  ["configured headers", { headers: { "X-Static": "static-header-b" } }],
  ["model", { model: "replacement-model" }],
]) {
  test(`a changed ${name} cannot consume the original scope`, async (t) => {
    const f = await fixture(t);
    const r = resolved(f);
    f.store.updateProviderPreset(f.preset.id, input, NOW);
    assert.equal(compare(f, r.scope).state, "changed");
    assert.equal(resolved(f, { ticket: r.ticket }).scope, undefined, "a captured preset cannot be rebound to a later revision");
  });
}

test("deletion and same-ID recreation cannot revive an old scope", async (t) => {
  const f = await fixture(t);
  const r = resolved(f);
  const snapshot = f.store.getProviderConfigurationSnapshot(f.preset.id);
  const backup = f.open("backup-workspace");
  copyProviderRow(f.store, backup, f.preset.id);
  f.store.deleteProviderPreset(f.preset.id);
  assert.equal(compare(f, r.scope).state, "changed");
  assert.equal(captureProviderConfigurationTicket(f.store, f.preset.id), undefined);
  copyProviderRow(backup, f.store, f.preset.id);
  const recreated = f.store.getProviderConfigurationSnapshot(f.preset.id);
  assert.deepEqual(recreated.provider, snapshot.provider);
  assert.ok(recreated.configRevision > snapshot.configRevision);
  assert.equal(compare(f, r.scope).state, "changed");
});

test("same provider ID, revision and effective values in another store do not share authority", async (t) => {
  const f = await fixture(t);
  const r = resolved(f);
  const other = f.open("other-workspace");
  copyProviderRow(f.store, other, f.preset.id);
  assert.deepEqual(other.getProviderConfigurationSnapshot(f.preset.id), f.store.getProviderConfigurationSnapshot(f.preset.id));
  assert.equal(runtimeObservationScopeForProvider(other, r.provider), undefined);
  assert.equal(compare(f, r.scope, { store: other }).state, "unknown");
  assert.equal(bindResolvedProviderObservationScope({ store: other, ticket: r.ticket, provider: r.provider, materialized: r.materialized, materializedPreset: r.preset }), undefined);
  assert.equal(compare(f, r.scope).state, "sampled_value_match", "cross-store probes must not damage the owner's scope");
});

test("reopening the same SQLite workspace is a new Host store authority", async (t) => {
  const f = await fixture(t);
  const r = resolved(f);
  const reopened = f.open();
  assert.deepEqual(reopened.getProviderConfigurationSnapshot(f.preset.id), f.store.getProviderConfigurationSnapshot(f.preset.id));
  assert.equal(runtimeObservationScopeForProvider(reopened, r.provider), undefined);
  assert.equal(compare(f, r.scope, { store: reopened }).state, "unknown");
  assert.equal(compare(f, resolved(f, { store: reopened }).scope, { store: reopened }).state, "sampled_value_match");
});

for (const keyKind of ["env", "keychain"]) {
  test(`${keyKind} keys compare the current effective value and label external A to B to A as sampled only`, async (t) => {
    const f = await fixture(t, { keyKind });
    const r = resolved(f);
    const ref = f.preset.apiKeyRef;
    const original = f.values.get(ref);
    assert.equal(compare(f, r.scope).state, "sampled_value_match");
    f.values.set(ref, "external-replacement-key");
    assert.equal(compare(f, r.scope).state, "changed");
    f.values.set(ref, original);
    assert.equal(compare(f, r.scope).state, "sampled_value_match", "external sampled equality is not a durable generation guarantee");
  });
}

test("comparison samples every effective secret header, including mixed local API keys and external headers", async (t) => {
  const f = await fixture(t, { keyKind: "local", secretHeaders: true });
  const r = resolved(f);
  assert.equal(compare(f, r.scope).state, "sampled_value_match");
  for (const ref of Object.values(HEADER_REFS)) {
    const original = f.values.get(ref);
    f.values.set(ref, "replacement-header-value");
    assert.equal(compare(f, r.scope).state, "changed", `header ${ref} must not be omitted from the proof`);
    f.values.set(ref, original);
    assert.equal(compare(f, r.scope).state, "sampled_value_match");
  }
  const readRefs = f.calls.filter(call => call.kind === "resolve").map(call => call.ref);
  for (const ref of Object.values(HEADER_REFS)) assert.ok(readRefs.includes(ref));
});

test("missing external API-key proof is unknown rather than a match or a thrown credential error", async (t) => {
  const f = await fixture(t);
  const r = resolved(f);
  f.values.delete(API_REF);
  assert.equal(compare(f, r.scope).state, "unknown");
});

test("missing external header proof is unknown even when the local API-key generation matches", async (t) => {
  const f = await fixture(t, { keyKind: "local", secretHeaders: true });
  const r = resolved(f);
  f.values.delete(HEADER_REFS["X-Route"]);
  assert.equal(compare(f, r.scope).state, "unknown");
});

test("resolver failures stay bounded, private and unknown without forbidding normal future calls", async (t) => {
  const f = await fixture(t, { secretHeaders: true });
  const r = resolved(f);
  f.onResolve = () => { throw new Error(`${PRIVATE_MARKER} at ${PRIVATE_PATH}`); };
  const comparison = compare(f, r.scope);
  assert.equal(comparison.state, "unknown");
  assert.doesNotMatch(JSON.stringify(comparison), /synthetic-private-key-marker|synthetic-runtime-scope-path/);
  assert.ok(comparison.reason === undefined || comparison.reason.length <= 160);
  f.onResolve = undefined;
  assert.equal(compare(f, r.scope).state, "sampled_value_match");
  const provider = resolveProviderForRun(f.store, { providerPresetId: f.preset.id, skipProviderPreflight: true }, f.resolver);
  assert.equal(provider.apiKey, "external-key-a");
});

test("current atomic read failures are private unknown observations and a later valid read can recover", async (t) => {
  const f = await fixture(t);
  const r = resolved(f);
  const originalRead = f.store.getProviderConfigurationSnapshot.bind(f.store);
  f.store.getProviderConfigurationSnapshot = () => { throw new Error(`${PRIVATE_MARKER} at ${PRIVATE_PATH}`); };
  try {
    const comparison = compare(f, r.scope);
    assert.equal(comparison.state, "unknown");
    assert.doesNotMatch(JSON.stringify(comparison), /synthetic-private-key-marker|synthetic-runtime-scope-path/);
  } finally {
    f.store.getProviderConfigurationSnapshot = originalRead;
  }
  assert.equal(compare(f, r.scope).state, "sampled_value_match");
});

test("readiness check publications do not invalidate unchanged runtime configuration authority", async (t) => {
  const f = await fixture(t);
  const r = resolved(f);
  const before = f.store.getProviderConfigurationSnapshot(f.preset.id);
  f.store.recordProviderCheckResult(f.preset.id, {
    ok: true, message: "synthetic check completed", checkedAt: "2026-10-10T00:01:00.000Z",
  });
  assert.equal(f.store.getProviderConfigurationSnapshot(f.preset.id).configRevision, before.configRevision);
  assert.equal(compare(f, r.scope).state, "sampled_value_match");
});

test("incomplete initial key materialization cannot grant proof but preserves the resolver's existing behavior", async (t) => {
  const f = await fixture(t);
  f.values.delete(API_REF);
  const r = resolved(f);
  assert.equal(r.scope, undefined);
  const provider = resolveProviderForRun(f.store, { providerPresetId: f.preset.id, skipProviderPreflight: true }, f.resolver);
  assert.equal(provider.apiKey, undefined);
  assert.equal(runtimeObservationScopeForProvider(f.store, provider), undefined);
});

test("configuration changes during materialization cannot bind a former preset with a later revision", async (t) => {
  const f = await fixture(t);
  const ticket = captureProviderConfigurationTicket(f.store, f.preset.id);
  let changed = false;
  f.onResolve = () => {
    if (changed) return;
    changed = true;
    f.store.updateProviderPreset(f.preset.id, { contextWindow: 256_000 }, NOW);
  };
  const r = resolved(f, { ticket });
  assert.equal(r.provider.contextWindow, 128_000);
  assert.equal(f.store.getProviderPreset(f.preset.id).contextWindow, 256_000);
  assert.equal(r.scope, undefined);
});

test("configuration changes during current sampling fail the revision sandwich even if key values match", async (t) => {
  const f = await fixture(t, { secretHeaders: true });
  const r = resolved(f);
  let changed = false;
  f.onResolve = (ref) => {
    if (ref !== HEADER_REFS["X-Route"] || changed) return;
    changed = true;
    f.store.updateProviderPreset(f.preset.id, { baseUrl: "https://provider-b.example.test/v1" }, NOW);
  };
  assert.equal(compare(f, r.scope).state, "changed");
});

test("external values can prove sampled equality but do not pretend to prove multi-read mutation history", async (t) => {
  const f = await fixture(t, { secretHeaders: true });
  const r = resolved(f);
  f.onResolve = (ref) => {
    const value = f.values.get(ref);
    f.values.set(ref, "transient-external-value");
    f.values.set(ref, value);
  };
  assert.equal(compare(f, r.scope).state, "sampled_value_match");
});

test("a no-key preset remains callable but does not grant proof of ambient SDK credentials", async (t) => {
  const f = await fixture(t, { input: { apiKeyRef: undefined, authHeader: false } });
  const r = resolved(f);
  assert.equal(r.scope, undefined);
  assert.equal(compare(f, r.scope).state, "unknown");
  const provider = resolveProviderForRun(f.store, { providerPresetId: f.preset.id, skipProviderPreflight: true }, f.resolver);
  assert.equal(provider.authHeader, false);
  assert.equal(provider.apiKey, undefined);
  assert.equal(runtimeObservationScopeForProvider(f.store, provider), undefined);
  assert.deepEqual(f.calls, []);
});

test("binding requires the actual materialized API key and all effective headers", async (t) => {
  const f = await fixture(t, { secretHeaders: true });
  const r = resolved(f);
  for (const provider of [
    { ...r.provider, apiKey: "forged-materialization" },
    { ...r.provider, headers: { ...r.provider.headers, "X-Extra": "extra" } },
    { ...r.provider, headers: { "X-Static": r.provider.headers["X-Static"], "X-Tenant": r.provider.headers["X-Tenant"] } },
    { ...r.provider, headers: { ...r.provider.headers, "X-Route": "forged-route" } },
  ]) {
    assert.equal(bindResolvedProviderObservationScope({ store: f.store, ticket: r.ticket, provider, materialized: r.materialized, materializedPreset: r.preset }), undefined);
  }
});

test("binding rejects a mismatched Runner connection even when its materialized credentials match", async (t) => {
  const f = await fixture(t);
  const r = resolved(f);
  for (const replacement of [
    { baseUrl: "https://unrelated.example.test/v1" },
    { contextWindow: 256_000 },
    { model: "different-model" },
    { providerTransport: "websocket" },
    { compat: { supportsDeveloperRole: true } },
  ]) {
    const provider = { ...r.provider, ...replacement };
    assert.equal(bindResolvedProviderObservationScope({ store: f.store, ticket: r.ticket, provider, materialized: r.materialized, materializedPreset: r.preset }), undefined);
  }
});

test("a mutable preset copy cannot change the private ticket fact or authorize a changed Runner", async (t) => {
  const f = await fixture(t);
  const ticket = captureProviderConfigurationTicket(f.store, f.preset.id);
  const exposed = providerPresetForConfigurationTicket(ticket);
  exposed.model = "modified-ticket-copy-model";
  exposed.headers["X-Static"] = "modified-ticket-copy-header";
  const materialized = materializeProviderSecrets({ store: f.store, preset: exposed, secretResolver: f.resolver });
  const provider = runnerProvider(exposed, materialized);
  assert.equal(bindResolvedProviderObservationScope({ store: f.store, ticket, provider, materialized, materializedPreset: exposed }), undefined);
  assert.deepEqual(providerPresetForConfigurationTicket(ticket), f.preset);
});

test("materialization from a header-only edited ticket copy is rejected even when the model is unchanged", async (t) => {
  const f = await fixture(t);
  const ticket = captureProviderConfigurationTicket(f.store, f.preset.id);
  const exposed = providerPresetForConfigurationTicket(ticket);
  exposed.headers["X-Static"] = "header-only-materialization-source-change";
  assert.equal(exposed.model, f.preset.model);
  const materialized = materializeProviderSecrets({ store: f.store, preset: exposed, secretResolver: f.resolver });
  const provider = runnerProvider(exposed, materialized);
  assert.equal(bindResolvedProviderObservationScope({
    store: f.store, ticket, provider, materialized, materializedPreset: exposed,
  }), undefined, "the actual materialization configuration must match the ticket's private configuration");
});

test("materialization from an apiKeyRef-only edited ticket copy is rejected even when the model is unchanged", async (t) => {
  const f = await fixture(t);
  const ticket = captureProviderConfigurationTicket(f.store, f.preset.id);
  const exposed = providerPresetForConfigurationTicket(ticket);
  exposed.apiKeyRef = "keychain:LING_RUNTIME_SCOPE_SYNTHETIC_KEY";
  assert.equal(exposed.model, f.preset.model);
  const materialized = materializeProviderSecrets({ store: f.store, preset: exposed, secretResolver: f.resolver });
  const provider = runnerProvider(exposed, materialized);
  assert.equal(provider.apiKey, "external-keychain-a");
  assert.equal(bindResolvedProviderObservationScope({
    store: f.store, ticket, provider, materialized, materializedPreset: exposed,
  }), undefined, "matching Runner fields cannot substitute a different API-key source for the captured configuration");
});

test("rebinding a mutated Runner cannot let the previous scope borrow the newer connection proof", async (t) => {
  const f = await fixture(t, { input: { api: "openai-codex-responses" } });
  const r = resolved(f);
  assert.equal(r.provider.providerTransport, "sse");
  assert.equal(compare(f, r.scope).state, "sampled_value_match");
  r.provider.providerTransport = "auto";
  const replacement = bindResolvedProviderObservationScope({
    store: f.store, ticket: r.ticket, provider: r.provider, materialized: r.materialized, materializedPreset: r.preset,
  });
  assert.ok(replacement);
  assert.notEqual(replacement, r.scope);
  assert.equal(runtimeObservationScopeForProvider(f.store, r.provider), replacement);
  assert.equal(compare(f, replacement).state, "sampled_value_match");
  assert.ok(["unknown", "changed"].includes(compare(f, r.scope).state));
});

test("cloned provider objects do not inherit the original private resolution binding", async (t) => {
  const f = await fixture(t);
  const r = resolved(f);
  for (const provider of [{ ...r.provider }, structuredClone(r.provider), JSON.parse(JSON.stringify(r.provider))]) {
    assert.equal(runtimeObservationScopeForProvider(f.store, provider), undefined);
  }
  assert.equal(runtimeObservationScopeForProvider(f.store, r.provider), r.scope);
});

for (const [name, mutate] of [
  ["API key", provider => { provider.apiKey = "mutated-effective-key"; }],
  ["endpoint", provider => { provider.baseUrl = "https://mutated.example.test/v1"; }],
  ["headers", provider => { provider.headers["X-Static"] = "mutated-header"; }],
  ["context window", provider => { provider.contextWindow = 256_000; }],
  ["nested compatibility", provider => { provider.compat.supportsDeveloperRole = true; }],
  ["input capabilities", provider => { provider.input.push("image"); }],
]) {
  test(`mutation of the bound Runner ${name} invalidates its resolution binding`, async (t) => {
    const f = await fixture(t);
    const r = resolved(f);
    mutate(r.provider);
    assert.equal(runtimeObservationScopeForProvider(f.store, r.provider), undefined);
    assert.ok(["changed", "unknown"].includes(compare(f, r.scope).state));
  });
}

test("a fresh scope-module Host epoch cannot validate a prior epoch's nominal scope or ticket", async (t) => {
  const f = await fixture(t);
  const r = resolved(f);
  const fresh = await import(`../dist/features/providers/runtime-observation-scope.js?synthetic-fresh-host-epoch=${Date.now()}`);
  assert.equal(fresh.providerPresetForConfigurationTicket(r.ticket), undefined);
  assert.equal(fresh.runtimeObservationScopeForProvider(f.store, r.provider), undefined);
  assert.equal(fresh.compareProviderRuntimeObservationScope({ store: f.store, scope: r.scope, secretResolver: f.resolver }).state, "unknown");
  assert.equal(compare(f, r.scope).state, "sampled_value_match");
});

test("the production saved-preset resolver binds the exact returned object and actual single materialization", async (t) => {
  const f = await fixture(t, { secretHeaders: true });
  const provider = resolveProviderForRun(f.store, { providerPresetId: f.preset.id, skipProviderPreflight: true }, f.resolver);
  const scope = runtimeObservationScopeForProvider(f.store, provider);
  assert.ok(scope);
  assert.equal(provider.apiKey, "external-key-a");
  assert.equal(provider.headers["X-Tenant"], "external-tenant-a");
  assert.equal(provider.headers["X-Route"], "external-route-a");
  assert.deepEqual(f.calls.filter(call => call.kind === "resolve").map(call => call.ref), [API_REF, ...Object.values(HEADER_REFS)]);
  assert.equal(compare(f, scope).state, "sampled_value_match");
});

test("Codex transport policy binds both the explicit preset transport and runtime-forced SSE", async (t) => {
  const f = await fixture(t, { input: { api: "openai-codex-responses", providerTransport: "websocket" } });
  for (const fallback of [false, true]) {
    const provider = resolveProviderForRun(f.store, {
      providerPresetId: f.preset.id, skipProviderPreflight: true,
    }, f.resolver, { providerWebSocketFallbackEnabled: fallback });
    assert.equal(provider.providerTransport, fallback ? "websocket" : "sse");
    const scope = runtimeObservationScopeForProvider(f.store, provider);
    assert.ok(scope);
    assert.equal(compare(f, scope).state, "sampled_value_match");
  }
});

test("inline providers remain unbound and missing proof never creates preset authority", async (t) => {
  const f = await fixture(t);
  const provider = resolveProviderForRun(f.store, { provider: { provider: "inline-provider", model: "inline-model", apiKey: "synthetic-inline-key" } }, f.resolver);
  assert.equal(runtimeObservationScopeForProvider(f.store, provider), undefined);
});

test("an unprovable saved-preset resolution preserves normal resolver output without granting a stale scope", async (t) => {
  const f = await fixture(t);
  let changed = false;
  f.onResolve = () => {
    if (changed) return;
    changed = true;
    f.store.updateProviderPreset(f.preset.id, { contextWindow: 256_000 }, NOW);
  };
  const provider = resolveProviderForRun(f.store, { providerPresetId: f.preset.id, skipProviderPreflight: true }, f.resolver);
  assert.equal(provider.apiKey, "external-key-a");
  assert.equal(provider.contextWindow, 128_000);
  assert.equal(runtimeObservationScopeForProvider(f.store, provider), undefined);
});
