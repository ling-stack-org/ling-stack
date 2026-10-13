import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore, resolveStoragePaths } from "../dist/index.js";

const NOW = "2026-10-10T00:00:02.000Z";
const OBSERVED = "2026-10-10T00:00:01.000Z";
const ADMITTED = "2026-10-10T00:00:00.000Z";
const TABLE = "channel_team_incident_provenance";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-incident-provenance-"));
  const paths = resolveStoragePaths(cwd, { homeDir: join(cwd, "home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  const store = createSqliteRunStore(cwd, paths);
  t.after(async () => { if (store.database.isOpen) store.close(); await rm(cwd, { recursive: true, force: true }); });
  // This is the explicit baseline oracle: old dist lacks the private API.
  assert.equal(typeof store.createProviderRuntimeAvailabilityIncident, "function", "missing Core runtime publication method");
  assert.equal(typeof store.listAvailabilityIncidentCandidates, "function", "missing Core joined candidate keyset method");
  return { store, database: store.database };
}

function incident(id = "incident-a", overrides = {}) {
  return { id, providerPresetId: "provider-a", state: "rate_limited", kind: "quota", severity: "medium",
    summary: "Synthetic provider rate limit.", observedAt: OBSERVED, expiresAt: "2026-10-10T01:00:00.000Z", ...overrides };
}
function source(id = "source-a", overrides = {}) {
  return { observationId: `observation-${id}`, invocationId: `invocation-${id}`, taskId: "task-a", runId: "run-a",
    attemptId: "attempt-a", origin: "task", admittedAt: ADMITTED, settledAt: OBSERVED,
    identity: { providerPresetId: "provider-a", providerKind: "openai-compatible", providerApi: "openai-completions",
      modelId: "synthetic-model-a", configRevision: 7 }, ...overrides };
}
function candidates(store, options = {}) { return store.listAvailabilityIncidentCandidates({ now: NOW, ...options }); }
function rawIncident(database, id, overrides = {}) {
  const input = incident(id, overrides);
  database.prepare(`INSERT INTO channel_team_incidents (id,workspace_id,incident_type,agent_id,provider_preset_id,
    kind,severity,availability_state,model_signature_json,summary,source_refs_json,recovery_required,observed_at,expires_at,created_at,updated_at)
    VALUES (?,?, 'availability',?,?,?,?,?,'{}',?,'[]',0,?,?,?,?)`).run(id, overrides.workspaceId ?? "workspace_default",
    input.agentId ?? null, input.providerPresetId ?? null, input.kind, input.severity, input.state, input.summary,
    input.observedAt, input.expiresAt ?? null, NOW, NOW);
}

test("new generic Provider-bound incidents retain explicit generic provenance without extending public DTOs", async t => {
  const { store } = await fixture(t);
  const created = store.createAvailabilityIncident(incident(), NOW);
  const page = candidates(store);
  assert.equal(page.candidates.length, 1);
  assert.equal(page.candidates[0].provenance, "generic");
  assert.equal(page.candidates[0].source, undefined);
  assert.deepEqual(page.candidates[0].incident, created);
  assert.deepEqual(store.listAvailabilityIncidents({ now: NOW }), [created]);
  assert.equal(Object.hasOwn(created, "provenance"), false);
  assert.equal(Object.hasOwn(created, "source"), false);
});

test("runtime publication atomically retains only exact safe source lineage and leaves public history unchanged", async t => {
  const { store, database } = await fixture(t);
  const input = source();
  const created = store.createProviderRuntimeAvailabilityIncident({ incident: incident(), source: input }, NOW);
  const candidate = candidates(store).candidates[0];
  assert.equal(candidate.provenance, "provider_runtime");
  assert.deepEqual(candidate.source, input);
  assert.deepEqual(candidate.incident, created);
  assert.deepEqual(store.listAvailabilityIncidents({ now: NOW }), [created]);
  assert.equal(database.prepare("SELECT source_refs_json FROM channel_team_incidents WHERE id=?").get(created.id).source_refs_json, "[]");
  assert.equal(Object.hasOwn(created, "observationId"), false);
  assert.equal(Object.hasOwn(created, "configRevision"), false);
});

test("a valid runtime model signature is safely copied and remains the same public DTO on historical reads", async t => {
  const { store } = await fixture(t);
  const signature = { providerPresetId: "provider-a", providerId: "synthetic-provider", model: "synthetic-model-a",
    api: "openai-completions", promptHash: "synthetic-prompt-hash", capabilityHash: "synthetic-capability-hash" };
  const expectedSignature = { ...signature };
  const created = store.createProviderRuntimeAvailabilityIncident({ incident: incident("signature-incident", { modelSignature: signature }), source: source() }, NOW);
  signature.model = "mutated-after-publication";
  assert.deepEqual(created.modelSignature, expectedSignature);
  assert.notEqual(created.modelSignature, signature);
  assert.deepEqual(store.listAvailabilityIncidents({ now: NOW }), [created]);
  assert.deepEqual(candidates(store).candidates[0].incident, created);
});

for (const mismatch of ["model", "api", "providerPresetId"]) {
  test(`runtime model signature must describe the original source identity: ${mismatch}`, async t => {
    const { store } = await fixture(t);
    const signature = { model: "synthetic-model-a", api: "openai-completions", providerPresetId: "provider-a", [mismatch]: "synthetic-other" };
    assert.throws(() => store.createProviderRuntimeAvailabilityIncident({ incident: incident("mismatch", { modelSignature: signature }), source: source() }, NOW),
      error => error.code === "availability_incident_source_invalid");
    assert.deepEqual(store.listAvailabilityIncidents({ includeExpired: true }), []);
  });
}

for (const mutation of ["missing-source", "missing-identity", "missing-observation", "wrong-provider", "invalid-revision",
  "wrong-time", "partial-lineage", "extra-error", "extra-proof", "extra-identity-secret", "accessor"]) {
  test(`invalid/partial runtime source cannot leave a naked incident: ${mutation}`, async t => {
    const { store, database } = await fixture(t);
    let input = source();
    if (mutation === "missing-source") input = undefined;
    if (mutation === "missing-identity") delete input.identity;
    if (mutation === "missing-observation") delete input.observationId;
    if (mutation === "wrong-provider") input.identity.providerPresetId = "provider-b";
    if (mutation === "invalid-revision") input.identity.configRevision = Number.MAX_SAFE_INTEGER + 1;
    if (mutation === "wrong-time") input.settledAt = "2026-10-09T23:59:59.000Z";
    if (mutation === "partial-lineage") delete input.attemptId;
    if (mutation === "extra-error") input.errorMessage = "synthetic-private-error-marker";
    if (mutation === "extra-proof") input.keyedProof = "synthetic-private-proof-marker";
    if (mutation === "extra-identity-secret") input.identity.apiKey = "synthetic-private-key-marker";
    if (mutation === "accessor") Object.defineProperty(input, "observationId", { enumerable: true, get() { throw new Error("must not execute getter"); } });
    assert.throws(() => store.createProviderRuntimeAvailabilityIncident({ incident: incident(), source: input }, NOW),
      error => error.code === "availability_incident_source_invalid");
    assert.deepEqual(store.listAvailabilityIncidents({ includeExpired: true }), []);
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${TABLE}`).get().count, 0);
  });
}

test("generic publication refuses misplaced runtime provenance instead of silently downgrading it", async t => {
  const { store } = await fixture(t);
  for (const extras of [{ source: source() }, { provenance: "provider_runtime" }, { observationId: "observation-a" }]) {
    assert.throws(() => store.createAvailabilityIncident({ ...incident(), ...extras }, NOW),
      error => error.code === "availability_incident_source_invalid");
  }
  assert.deepEqual(store.listAvailabilityIncidents({ includeExpired: true }), []);
});

test("runtime source and envelope rejection never execute getters or object-to-string conversions", async t => {
  const { store } = await fixture(t);
  let executed = 0;
  const invalid = source();
  invalid.origin = { toString() { executed++; return "task"; } };
  const invalidIncident = incident();
  Object.defineProperty(invalidIncident, "providerPresetId", { get() { executed++; return "provider-a"; } });
  const invalidEnvelope = { incident: incident(), source: source() };
  Object.defineProperty(invalidEnvelope, "source", { get() { executed++; return source(); } });
  for (const input of [{ incident: incident(), source: invalid }, { incident: invalidIncident, source: source() }, invalidEnvelope]) {
    assert.throws(() => store.createProviderRuntimeAvailabilityIncident(input, NOW), error => error.code === "availability_incident_source_invalid");
  }
  assert.equal(executed, 0);
  assert.deepEqual(store.listAvailabilityIncidents({ includeExpired: true }), []);
});

test("corrupt runtime sidecar remains unknown and does not expose unsafe fields or rewrite public history", async t => {
  const { store, database } = await fixture(t);
  const created = store.createProviderRuntimeAvailabilityIncident({ incident: incident(), source: source() }, NOW);
  const damaged = { ...source(), errorMessage: "synthetic-private-error", identity: { ...source().identity, apiKey: "synthetic-private-key" } };
  database.prepare(`UPDATE ${TABLE} SET source_json=? WHERE incident_id=?`).run(JSON.stringify(damaged), created.id);
  const candidate = candidates(store).candidates[0];
  assert.equal(candidate.provenance, "legacy_unclassified");
  assert.equal(candidate.source, undefined);
  assert.deepEqual(candidate.incident, created);
  assert.equal(JSON.stringify(candidate).includes("synthetic-private"), false);
  assert.deepEqual(store.listAvailabilityIncidents({ now: NOW }), [created]);
  assert.deepEqual(JSON.parse(database.prepare(`SELECT source_json FROM ${TABLE}`).get().source_json), damaged);
});

for (const mutation of ["nested-getter", "nested-toJSON", "nested-proof", "nested-model-object", "summary-object", "summary-number"]) {
  test(`runtime incident rejects unsafe nested/scalar data before execution or publication: ${mutation}`, async t => {
    const { store, database } = await fixture(t);
    let executed = 0;
    const input = incident("unsafe-incident", { modelSignature: { model: "synthetic-model-a" } });
    if (mutation === "nested-getter") Object.defineProperty(input.modelSignature, "model", { get() { executed++; return "synthetic-model-a"; } });
    if (mutation === "nested-toJSON") input.modelSignature.toJSON = () => { executed++; return { model: "synthetic-model-a", apiKey: "synthetic-private-key" }; };
    if (mutation === "nested-proof") input.modelSignature.keyedProof = "synthetic-private-proof";
    if (mutation === "nested-model-object") input.modelSignature.model = { toJSON() { executed++; return "synthetic-model-a"; } };
    if (mutation === "summary-object") input.summary = { trim() { executed++; return "Synthetic"; }, toString() { executed++; return "Synthetic"; } };
    if (mutation === "summary-number") input.summary = 42;
    assert.throws(() => store.createProviderRuntimeAvailabilityIncident({ incident: input, source: source() }, NOW),
      error => error.code === "availability_incident_source_invalid");
    assert.equal(executed, 0);
    assert.deepEqual(store.listAvailabilityIncidents({ includeExpired: true }), []);
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${TABLE}`).get().count, 0);
  });
}

for (const kind of ["generic", "runtime"]) {
  test(`a failed ${kind} sidecar insertion rolls back the actual incident and preserves surrounding transaction`, async t => {
    const { store, database } = await fixture(t);
    database.exec(`CREATE TRIGGER synthetic_reject_provenance BEFORE INSERT ON ${TABLE} BEGIN SELECT RAISE(ABORT,'synthetic sidecar refusal'); END`);
    database.exec("CREATE TABLE synthetic_outer_transaction(value TEXT)");
    database.exec("BEGIN IMMEDIATE");
    database.prepare("INSERT INTO synthetic_outer_transaction VALUES(?)").run(NOW);
    assert.throws(() => kind === "generic" ? store.createAvailabilityIncident(incident(), NOW)
      : store.createProviderRuntimeAvailabilityIncident({ incident: incident(), source: source() }, NOW), /synthetic sidecar refusal/u);
    assert.deepEqual(store.listAvailabilityIncidents({ includeExpired: true }), []);
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${TABLE}`).get().count, 0);
    assert.ok(database.prepare("SELECT value FROM synthetic_outer_transaction").get());
    database.exec("ROLLBACK");
    assert.equal(database.prepare("SELECT value FROM synthetic_outer_transaction").get(), undefined);
  });
}

test("successful incident publication does not commit its caller's transaction", async t => {
  const { store, database } = await fixture(t);
  database.exec("BEGIN IMMEDIATE");
  store.createAvailabilityIncident(incident("outer-generic"), NOW);
  store.createProviderRuntimeAvailabilityIncident({ incident: incident("outer-runtime"), source: source() }, NOW);
  assert.equal(candidates(store).candidates.length, 2);
  database.exec("ROLLBACK");
  assert.deepEqual(store.listAvailabilityIncidents({ includeExpired: true }), []);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${TABLE}`).get().count, 0);
});

test("legacy unmarked Provider/model and agent-only records are explicit candidates without history rewriting", async t => {
  const { store, database } = await fixture(t);
  rawIncident(database, "legacy-provider");
  rawIncident(database, "legacy-agent", { providerPresetId: undefined, agentId: "agent-a" });
  rawIncident(database, "legacy-model", { providerPresetId: undefined, agentId: "agent-b" });
  database.prepare("UPDATE channel_team_incidents SET model_signature_json=? WHERE id='legacy-model'").run(JSON.stringify({ model: "legacy-model" }));
  const before = database.prepare("SELECT * FROM channel_team_incidents ORDER BY rowid").all();
  const page = candidates(store);
  assert.deepEqual(page.candidates.map(row => row.provenance), ["legacy_unclassified", "legacy_unclassified", "legacy_unclassified"]);
  assert.equal(page.candidates.find(row => row.incident.id === "legacy-agent").incident.providerPresetId, undefined);
  assert.equal(page.candidates.find(row => row.incident.id === "legacy-model").incident.modelSignature.model, "legacy-model");
  assert.deepEqual(database.prepare("SELECT * FROM channel_team_incidents ORDER BY rowid").all(), before);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${TABLE}`).get().count, 0);
});

test("same-time keyset pages have no duplicate/lost incident and keep a fixed row-ID high-water bound", async t => {
  const { store } = await fixture(t);
  for (let index = 1; index <= 7; index++) store.createAvailabilityIncident(incident(`same-${index}`), NOW);
  const first = candidates(store, { pageSize: 2 });
  assert.ok(first.nextCursor);
  store.createAvailabilityIncident(incident("late-same"), NOW);
  store.createAvailabilityIncident(incident("late-older", { observedAt: ADMITTED }), NOW);
  const all = [...first.candidates];
  let cursor = first.nextCursor;
  while (cursor) {
    const page = candidates(store, { pageSize: 2, cursor });
    all.push(...page.candidates); cursor = page.nextCursor;
  }
  assert.deepEqual(all.map(row => row.incident.id), [7, 6, 5, 4, 3, 2, 1].map(index => `same-${index}`));
  assert.equal(new Set(all.map(row => row.incident.id)).size, 7);
  assert.equal(candidates(store, { pageSize: 20 }).candidates.length, 9);
});

test("candidate pages filter workspace, agent/Provider lanes and expiry before page size", async t => {
  const { store, database } = await fixture(t);
  store.createAvailabilityIncident(incident("matches-both", { agentId: "agent-a" }), NOW);
  store.createAvailabilityIncident(incident("provider-only"), NOW);
  store.createAvailabilityIncident(incident("other-provider", { providerPresetId: "provider-b", agentId: "agent-a" }), NOW);
  store.createAvailabilityIncident(incident("expired", { agentId: "agent-a", expiresAt: NOW }), NOW);
  database.prepare("INSERT INTO workspaces(id,name,created_at,updated_at) VALUES(?,?,?,?)")
    .run("workspace-foreign", "Synthetic foreign workspace", NOW, NOW);
  rawIncident(database, "foreign-workspace", { workspaceId: "workspace-foreign", agentId: "agent-a" });
  const both = candidates(store, { agentId: "agent-a", providerPresetId: "provider-a", pageSize: 1 });
  assert.deepEqual(both.candidates.map(row => row.incident.id), ["matches-both"]);
  assert.equal(both.nextCursor, undefined);
  assert.deepEqual(candidates(store, { providerPresetId: "provider-a" }).candidates.map(row => row.incident.id), ["provider-only", "matches-both"]);
  assert.deepEqual(candidates(store, { agentId: "agent-a" }).candidates.map(row => row.incident.id), ["other-provider", "matches-both"]);
});

test("a candidate cursor cannot be cloned, mutated, moved to another Store or reused with different lane/expiry parameters", async t => {
  const { store } = await fixture(t);
  const other = await fixture(t);
  for (let index = 0; index < 3; index++) store.createAvailabilityIncident(incident(`cursor-${index}`, { agentId: "agent-a" }), NOW);
  const page = candidates(store, { agentId: "agent-a", pageSize: 1 });
  assert.ok(page.nextCursor);
  assert.equal(Object.isFrozen(page.nextCursor), true);
  for (const invoke of [
    () => candidates(store, { agentId: "agent-a", cursor: { ...page.nextCursor } }),
    () => candidates(other.store, { agentId: "agent-a", cursor: page.nextCursor }),
    () => candidates(store, { agentId: "agent-b", cursor: page.nextCursor }),
    () => candidates(store, { agentId: "agent-a", now: "2026-10-10T00:00:03.000Z", cursor: page.nextCursor }),
  ]) assert.throws(invoke, error => error.code === "availability_incident_cursor_invalid");
  assert.throws(() => candidates(store, { now: "not-a-time" }), error => error.code === "availability_incident_cursor_invalid");
});

test("bounded candidate pages can traverse beyond the public 500-row limit before Daemon accepts records", async t => {
  const { store } = await fixture(t);
  for (let index = 0; index < 507; index++) store.createAvailabilityIncident(incident(`many-${index}`), NOW);
  assert.equal(store.listAvailabilityIncidents({ now: NOW, limit: 1000 }).length, 500);
  const all = [];
  let cursor;
  do {
    const page = candidates(store, { pageSize: 100, cursor });
    all.push(...page.candidates); cursor = page.nextCursor;
  } while (cursor);
  assert.equal(all.length, 507);
  assert.equal(new Set(all.map(row => row.incident.id)).size, 507);
  assert.equal(all.at(-1).incident.id, "many-0");
});

test("unsafe row IDs reject a candidate scan instead of silently rounding a high-water cursor", async t => {
  const { store, database } = await fixture(t);
  store.createAvailabilityIncident(incident(), NOW);
  database.prepare("UPDATE channel_team_incidents SET rowid=? WHERE id=?").run(9007199254740993n, "incident-a");
  assert.throws(() => candidates(store, { pageSize: 1 }), error => error.code === "availability_incident_cursor_invalid");
});

test("migration adds provenance without classifying legacy rows or changing saved snapshots and rejects conflicting schema", async t => {
  await fixture(t); // Explicit missing-method RED before importing a new dist module.
  const { applyAvailabilityIncidentProvenanceMigration } = await import("../dist/storage/sqlite/availability-incident-provenance-migration.js");
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE channel_team_incidents(id TEXT PRIMARY KEY,workspace_id TEXT,incident_type TEXT,agent_id TEXT,provider_preset_id TEXT,observed_at TEXT);
    CREATE TABLE synthetic_saved_snapshots(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
    INSERT INTO channel_team_incidents VALUES('legacy','workspace_default','availability','agent-a','provider-a','2026-10-10T00:00:01.000Z');
    INSERT INTO synthetic_saved_snapshots VALUES('snapshot-a','{"availabilityIncidentIds":["legacy"]}');`);
  const before = database.prepare("SELECT * FROM channel_team_incidents").all();
  const snapshots = database.prepare("SELECT * FROM synthetic_saved_snapshots").all();
  const options = { database,
    hasMigration: version => Boolean(database.prepare("SELECT version FROM schema_migrations WHERE version=?").get(version)),
    recordMigration: (version, name) => database.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(version, name),
  };
  applyAvailabilityIncidentProvenanceMigration(options);
  applyAvailabilityIncidentProvenanceMigration(options);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${TABLE}`).get().count, 0);
  assert.deepEqual(database.prepare("SELECT * FROM channel_team_incidents").all(), before);
  assert.deepEqual(database.prepare("SELECT * FROM synthetic_saved_snapshots").all(), snapshots);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version=157").get().count, 1);
  database.exec(`DROP TABLE ${TABLE}; CREATE TABLE ${TABLE}(incident_id TEXT PRIMARY KEY,secret TEXT);`);
  assert.throws(() => applyAvailabilityIncidentProvenanceMigration(options), /provenance migration conflicts/u);
});
