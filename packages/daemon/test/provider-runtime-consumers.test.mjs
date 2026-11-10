import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createSqliteRunStore, resolveStoragePaths } from "@ling-stack/core";
import { appendChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import { createDaemonServer } from "../dist/index.js";
import { buildContextPack, resolveProviderContextBudget, resolveProviderContextCapabilities } from "../dist/features/channels/context-packs.js";
import { buildLingAgentTurnEnvelope } from "../dist/features/channels/ling-agent-turn-envelope.js";
import { runChannelObserverBusForTurn } from "../dist/features/channels/observer-bus.js";
import { createProviderInvocationObserver } from "../dist/features/providers/runtime-invocations.js";
import { recordProviderInvocationFailureObservations } from "../dist/features/providers/runtime-failure-observations.js";
import { resolveProviderForRun } from "../dist/features/runs/providers.js";

const PRIVATE_KEY = "synthetic-consumer-key-marker";
const PRIVATE_HEADER = "synthetic-consumer-header-marker";
const MODEL = "synthetic-consumer-model";

async function fixture(t, { explicitBudget = false } = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), "ling-runtime-consumers-"));
  const cwd = resolve(directory, "workspace");
  const paths = resolveStoragePaths(cwd, { homeDir: resolve(directory, "home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  const store = createSqliteRunStore(cwd, paths);
  const f = { directory, cwd, paths, store, now: new Date().toISOString(), daemons: [], reopenedStores: [] };
  t.after(async () => {
    for (const daemon of f.daemons) await daemon.stop();
    for (const reopened of f.reopenedStores) if (reopened.database.isOpen) reopened.close();
    if (store.database.isOpen) store.close();
    await rm(directory, { recursive: true, force: true });
  });
  f.values = { key: PRIVATE_KEY, header: PRIVATE_HEADER, unavailable: false };
  f.secretResolver = {
    status(ref) { return { ref, kind: ref.startsWith("keychain:") ? "keychain" : "env", configured: !f.values.unavailable }; },
    resolve(ref) {
      if (f.values.unavailable) throw new Error("Synthetic consumer resolver unavailable");
      return { ref, configured: true, status: this.status(ref), value: ref.startsWith("keychain:") ? f.values.header : f.values.key };
    },
  };
  f.preset = store.createProviderPreset({ kind: "openai-compatible", displayName: "Synthetic consumer Provider X",
    providerId: "synthetic-consumer-provider", model: MODEL, api: "openai-completions", baseUrl: "https://fixture.invalid/v1",
    apiKeyRef: "env:SYNTHETIC_CONSUMER_KEY", secretHeaderRefs: { "X-Secret-Tenant": "keychain:SYNTHETIC_CONSUMER_HEADER" },
    ...(explicitBudget ? { contextWindow: 8_192, maxTokens: 1_024 } : {}), capabilities: ["chat"], enabled: true }, f.now);
  // A fresh recorded check keeps daemon startup from issuing any provider request.
  store.recordProviderCheckResult(f.preset.id, { ok: true, code: "ready", message: "Synthetic fixture, no transport claim", checkedAt: f.now });
  f.resolveProvider = () => resolveProviderForRun(store, { providerPresetId: f.preset.id, skipProviderPreflight: true }, f.secretResolver);
  f.provider = f.resolveProvider();
  f.currentPreset = () => store.getProviderPreset(f.preset.id);
  f.host = () => ({ store, secretResolver: f.secretResolver });
  return f;
}

/** The authentic Host fold makes a private handle. This is neither a fake Runner event nor proof of an HTTP request. */
function publishFailure(f, { id = "consumer-invocation", agentId, category = "context_limit", contextBudget = true } = {}) {
  let failure;
  const observer = createProviderInvocationObserver({ store: f.store, provider: f.provider, taskId: "consumer-task",
    runId: "consumer-run", attemptId: "consumer-attempt", origin: "task", onFailure: value => { failure = value; } });
  const admission = { invocationId: id, taskId: "consumer-task", runId: "consumer-run", attemptId: "consumer-attempt",
    admittedAt: new Date(Date.parse(f.now) - 1_000).toISOString(), ...(contextBudget ? { contextBudget: {
      schemaVersion: 1, basis: "pi_projected_context_estimate", estimatedInputTokens: 500, contextWindowTokens: 8_192,
      reservedOutputTokens: 1_024, reservedRuntimeOverheadTokens: 512, inputBudgetTokens: 6_656,
    } } : {}) };
  observer.onProviderInvocationAdmitted(admission);
  observer.onProviderInvocationSettled({ ...admission, settledAt: f.now, outcome: "provider_error",
    errorDiagnostic: { schemaVersion: 1, category, basis: "sdk_error_marker" } });
  assert.ok(failure, "the actual Host fold, not a public event, must issue the private handle");
  const result = recordProviderInvocationFailureObservations({ store: f.store, secretResolver: f.secretResolver, failure,
    ...(agentId ? { agentId } : {}), now: f.now });
  assert.ok(result.incident, "the domain must publish the genuine handle through Core's atomic runtime entry");
  return result;
}

function generic(f, options = {}) {
  return f.store.createAvailabilityIncident({ providerPresetId: f.preset.id, state: "slow", kind: "timeout",
    summary: "Synthetic manual availability", observedAt: f.now,
    expiresAt: new Date(Date.parse(f.now) + 3_600_000).toISOString(), ...options }, f.now);
}

function pack(f, host = f.host()) {
  return buildContextPack({ ...host, providerPreset: f.currentPreset(), kind: "channel_reply", sections: [
    { id: "synthetic-required", role: "system", priority: "must_keep", text: "Synthetic system", estimatedTokens: 20 },
    { id: "synthetic-memory", role: "memory", priority: "low", text: "Synthetic optional memory", estimatedTokens: 1_500 },
  ] });
}

function makeAgentChannel(f) {
  const teammate = f.store.createAiTeammate({ id: "consumer-agent", roleKey: "engineer", displayName: "Synthetic engineer",
    description: "Disposable consumer observer", modelBindingMode: "fixed", providerPresetId: f.preset.id,
    approvalProfile: { mode: "standard" }, status: "active" }, f.now);
  const channel = f.store.createChannel({ name: "Synthetic consumer channel", boundPath: f.cwd,
    defaultTeammateId: teammate.id, defaultProviderPresetId: f.preset.id, autoReplyMode: "default_teammate" }, f.now);
  let turns = 0;
  const observe = (...args) => {
    const secretResolver = args.length === 0 ? f.secretResolver : args[0];
    turns++;
    const message = appendChannelItemFixture(f.store, { channelId: channel.id, authorType: "local-user",
      body: `Inspect this synthetic code change ${turns}.` }, f.now);
    return runChannelObserverBusForTurn({ enabled: true, store: f.store, secretResolver, channel: f.store.getChannel(channel.id),
      sourceMessageId: message.id, turnEnvelope: buildLingAgentTurnEnvelope({ store: f.store, channel, sourceMessage: message }), now: f.now });
  };
  const state = result => {
    assert.ok(result.attentionPlan, "the real observer must select the default channel participant");
    const selected = result.attentionPlan.observers.find(row => row.agentId === teammate.id);
    assert.ok(selected, "fixture must exercise an actual selected participant rather than an empty plan");
    return selected.availabilityState;
  };
  return { teammate, channel, observe, state };
}

function providerB(f) {
  return f.store.createProviderPreset({ kind: "openai-compatible", displayName: "Synthetic consumer Provider Y",
    providerId: "synthetic-consumer-provider-y", model: "synthetic-model-y", api: "openai-completions",
    baseUrl: "https://y.fixture.invalid/v1", apiKeyRef: "env:SYNTHETIC_CONSUMER_KEY", capabilities: ["chat"], enabled: true }, f.now);
}

test("budget and actual context-pack projection consume only an explicit live resolver observation", async t => {
  const f = await fixture(t);
  const baseline = resolveProviderContextBudget(f.currentPreset(), "channel_reply");
  assert.equal(baseline.contextWindowTokens, 8_192);
  assert.equal(pack(f).droppedSectionIds.length, 0);
  const learned = publishFailure(f);
  assert.equal(learned.contextObservation.observedContextWindowTokens, 2_048);
  assert.equal(resolveProviderContextCapabilities(f.currentPreset(), f.host()).capabilitySource, "runtime_observed");
  assert.equal(resolveProviderContextBudget(f.currentPreset(), "channel_reply", f.host()).contextWindowTokens, 2_048);
  assert.deepEqual(pack(f).droppedSectionIds, ["synthetic-memory"]);
  assert.equal(resolveProviderContextBudget(f.currentPreset(), "channel_reply").contextWindowTokens, baseline.contextWindowTokens);
  assert.equal(resolveProviderContextBudget(f.currentPreset(), "channel_reply", { store: f.store }).contextWindowTokens, baseline.contextWindowTokens);
  assert.deepEqual(pack(f, { store: f.store }).droppedSectionIds, []);
  assert.deepEqual(pack(f, {}).droppedSectionIds, []);
});

test("explicit manual token overrides retain precedence over automatic runtime window learning", async t => {
  const f = await fixture(t, { explicitBudget: true });
  const learned = publishFailure(f);
  assert.equal(learned.contextObservation.observedContextWindowTokens, 2_048);
  const current = resolveProviderContextBudget(f.currentPreset(), "channel_reply", f.host());
  assert.equal(current.capabilitySource, "user_override");
  assert.equal(current.contextWindowTokens, 8_192);
  assert.equal(current.inputBudgetTokens, 6_656);
});

for (const [name, mutate, expectedWindow = 8_192, expectedSource = "conservative_default"] of [
  ["configuration", f => f.store.updateProviderPreset(f.preset.id, { baseUrl: "https://changed.fixture.invalid/v1" }, f.now)],
  ["window configuration", f => f.store.updateProviderPreset(f.preset.id, { contextWindow: 16_384 }, f.now), 16_384, "user_override"],
  ["external API key", f => { f.values.key = "synthetic-consumer-new-key"; }],
  ["external secret header", f => { f.values.header = "synthetic-consumer-new-header"; }],
  ["resolver outage", f => { f.values.unavailable = true; }],
]) {
  test(`budget/context-pack ${name} drift restores static capabilities without changing durable history`, async t => {
    const f = await fixture(t);
    const result = publishFailure(f);
    const history = JSON.stringify(f.store.listAvailabilityIncidents({ includeExpired: true }));
    assert.equal(pack(f).budget.contextWindowTokens, 2_048);
    mutate(f);
    assert.equal(resolveProviderContextCapabilities(f.currentPreset(), f.host()).capabilitySource, expectedSource);
    assert.equal(pack(f).budget.contextWindowTokens, expectedWindow);
    assert.deepEqual(pack(f).droppedSectionIds, []);
    assert.equal(JSON.stringify(f.store.listAvailabilityIncidents({ includeExpired: true })), history);
    assert.equal(f.store.listAvailabilityIncidents({ includeExpired: true })[0].id, result.incident.id);
  });
}

test("a reopened owning Store cannot borrow another Host's learned budget even with the same database and preset ID", async t => {
  const f = await fixture(t);
  publishFailure(f);
  assert.equal(pack(f).budget.contextWindowTokens, 2_048);
  const reopened = createSqliteRunStore(f.cwd, f.paths);
  f.reopenedStores.push(reopened);
  const current = resolveProviderContextBudget(reopened.getProviderPreset(f.preset.id), "channel_reply",
    { store: reopened, secretResolver: f.secretResolver });
  assert.equal(current.contextWindowTokens, 8_192);
  assert.equal(current.capabilitySource, "conservative_default");
  assert.equal(f.store.listAvailabilityIncidents({ includeExpired: true }).length, 1);
});

test("observer's actual agent and Provider lanes follow X to Y while preserving generic facts", async t => {
  const f = await fixture(t), c = makeAgentChannel(f);
  generic(f, { agentId: c.teammate.id });
  publishFailure(f, { agentId: c.teammate.id, category: "rate_limited", contextBudget: false });
  assert.equal(c.state(c.observe()), "rate_limited");
  const y = providerB(f);
  f.store.updateAiTeammate(c.teammate.id, { providerPresetId: y.id }, f.now);
  assert.equal(c.state(c.observe()), "slow");
  assert.equal(c.state(c.observe(undefined)), "slow");
  assert.equal(f.store.listAvailabilityIncidents({ includeExpired: true }).length, 2);
});

test("observer resolver drift excludes runtime health but keeps manual Provider-bound health", async t => {
  const f = await fixture(t), c = makeAgentChannel(f);
  generic(f);
  publishFailure(f, { category: "rate_limited", contextBudget: false });
  assert.equal(c.state(c.observe()), "rate_limited");
  f.values.key = "synthetic-observer-new-key";
  assert.equal(c.state(c.observe()), "slow");
});

test("the observer scans past more than 500 stale authentic runtime facts before its accepted limit", { timeout: 20_000 }, async t => {
  const f = await fixture(t), c = makeAgentChannel(f);
  const manual = generic(f, { agentId: c.teammate.id });
  for (let index = 0; index < 511; index++) publishFailure(f, { id: `stale-observer-${index}`, agentId: c.teammate.id,
    category: "rate_limited", contextBudget: false });
  assert.equal(f.store.listAvailabilityIncidents({ now: f.now, limit: 500 }).some(row => row.id === manual.id), false);
  f.values.key = "synthetic-after-511-key";
  const original = f.store.listAvailabilityIncidentCandidates.bind(f.store);
  const pageLanes = [];
  f.store.listAvailabilityIncidentCandidates = options => { pageLanes.push({ agentId: options.agentId, providerPresetId: options.providerPresetId }); return original(options); };
  try { assert.equal(c.state(c.observe()), "slow"); } finally { f.store.listAvailabilityIncidentCandidates = original; }
  assert.ok(pageLanes.filter(row => row.agentId === c.teammate.id).length >= 2, "the actual agent lane must reach its second page");
  assert.ok(pageLanes.filter(row => row.providerPresetId === f.preset.id).length >= 2, "the actual Provider lane must reach its second page");
  assert.equal(f.store.database.prepare("SELECT COUNT(*) AS count FROM channel_team_incidents WHERE incident_type='availability'").get().count, 512);
});

async function startHttpConsumer(f) {
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: f.cwd,
    channels: { autoRoute: false, intentSelector: false, teamObserverBus: false, terminalReports: false } }, {
    storeFactory: cwd => { assert.equal(cwd, f.cwd, "the daemon must remain in the disposable workspace"); return f.store; },
    secretResolver: f.secretResolver,
    externalSecretStore: { ...f.secretResolver, setSecret() { throw new Error("No external secret writes in consumer tests"); },
      deleteSecret() { throw new Error("No external secret deletes in consumer tests"); } },
    remoteAccessStateDir: resolve(f.directory, "remote-access"),
  });
  f.daemons.push(daemon);
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function requestJson(url, body) {
  const response = await fetch(url, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  assert.equal(response.status, body === undefined ? 200 : 201, text);
  return JSON.parse(text);
}

function snapshotBytes(store, snapshotId) {
  return JSON.stringify(store.database.prepare("SELECT * FROM channel_team_snapshots WHERE id=?").get(snapshotId));
}

test("real HTTP router metrics and newly created snapshots use current scope, without rewriting old snapshots/history", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const channel = f.store.createChannel({ name: "HTTP scoped consumer", boundPath: f.cwd, autoReplyMode: "mentions_only" }, f.now);
  const manual = generic(f);
  const runtime = publishFailure(f, { category: "rate_limited", contextBudget: false });
  const url = await startHttpConsumer(f);
  const metricsUrl = `${url}/channels/${encodeURIComponent(channel.id)}/team-metrics?cwd=${encodeURIComponent(f.cwd)}`;
  const snapshotsUrl = `${url}/channels/${encodeURIComponent(channel.id)}/team-snapshots?cwd=${encodeURIComponent(f.cwd)}`;
  const initialMetrics = await requestJson(metricsUrl);
  assert.equal(initialMetrics.metrics.summary.availabilityIncidentCount, 2, "actual router must forward its resolver to the metric handler");
  const before = await requestJson(snapshotsUrl, { reason: "Before synthetic credential rotation", createdBy: "local-user" });
  assert.deepEqual(new Set(before.snapshot.state.availabilityIncidentIds), new Set([manual.id, runtime.incident.id]));
  const persistedBefore = snapshotBytes(f.store, before.snapshot.id);
  const historyBefore = JSON.stringify(f.store.listAvailabilityIncidents({ includeExpired: true }));
  f.values.header = "synthetic-http-new-header";
  const afterMetrics = await requestJson(metricsUrl);
  assert.equal(afterMetrics.metrics.summary.availabilityIncidentCount, 1);
  const after = await requestJson(snapshotsUrl, { reason: "After synthetic credential rotation" });
  assert.deepEqual(after.snapshot.state.availabilityIncidentIds, [manual.id]);
  assert.equal(after.snapshot.state.metrics.summary.availabilityIncidentCount, 1);
  const listed = await requestJson(snapshotsUrl);
  assert.deepEqual(new Set(listed.snapshots.find(row => row.id === before.snapshot.id).state.availabilityIncidentIds),
    new Set([manual.id, runtime.incident.id]));
  assert.equal(snapshotBytes(f.store, before.snapshot.id), persistedBefore);
  assert.equal(JSON.stringify(f.store.listAvailabilityIncidents({ includeExpired: true })), historyBefore);
  const publicJson = JSON.stringify([initialMetrics, afterMetrics, before, after, listed]);
  assert.equal(publicJson.includes(PRIVATE_KEY), false);
  assert.equal(publicJson.includes(PRIVATE_HEADER), false);
  assert.equal(publicJson.includes("observationId"), false);
  assert.equal(publicJson.includes("configRevision"), false);
});

test("real HTTP metrics and snapshot creation ignore runtime history from another Store epoch but retain generic history", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const channel = f.store.createChannel({ name: "Reopened HTTP scope", boundPath: f.cwd, autoReplyMode: "mentions_only" }, f.now);
  const manual = generic(f);
  const runtime = publishFailure(f, { category: "rate_limited", contextBudget: false });
  const historical = f.store.createChannelTeamSnapshot({ channelId: channel.id, reason: "Saved original history", state: {
    availabilityIncidentIds: [manual.id, runtime.incident.id], reliabilityIncidentIds: [], activeProvisionalRules: [], patterns: [], messageCount: 0,
  } }, f.now);
  const bytes = snapshotBytes(f.store, historical.id);
  const reopened = createSqliteRunStore(f.cwd, f.paths);
  f.reopenedStores.push(reopened);
  const sameEpochFixture = { ...f, store: reopened };
  const url = await startHttpConsumer(sameEpochFixture);
  const endpoint = `${url}/channels/${encodeURIComponent(channel.id)}`;
  const metrics = await requestJson(`${endpoint}/team-metrics?cwd=${encodeURIComponent(f.cwd)}`);
  assert.equal(metrics.metrics.summary.availabilityIncidentCount, 1);
  const snapshot = await requestJson(`${endpoint}/team-snapshots?cwd=${encodeURIComponent(f.cwd)}`, { reason: "New Host epoch" });
  assert.deepEqual(snapshot.snapshot.state.availabilityIncidentIds, [manual.id]);
  assert.equal(snapshotBytes(reopened, historical.id), bytes);
  assert.equal(reopened.listAvailabilityIncidents({ includeExpired: true }).length, 2);
});
