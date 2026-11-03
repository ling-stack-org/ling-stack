import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { captureProductionRead, persistentScans, runHarnessReliabilityQueryPlans } from "../../../scripts/harness-reliability-query-plans.mjs";

test("query evidence captures executed SQL and bindings and restores the native connection", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE facts(id TEXT PRIMARY KEY, scope TEXT); CREATE INDEX facts_scope ON facts(scope)");
    database.prepare("INSERT INTO facts VALUES(?,?)").run("one", "target");
    const prepare = database.prepare;
    const evidence = captureProductionRead(database, () => database.prepare("SELECT id FROM facts WHERE scope=? LIMIT ?").all("target", 2));
    assert.equal(database.prepare, prepare);
    assert.equal(evidence.value[0].id, "one");
    assert.equal(evidence.queries.length, 1);
    assert.equal(evidence.queries[0].sql, "SELECT id FROM facts WHERE scope=? LIMIT ?");
    assert.deepEqual(evidence.queries[0].bindings, ["target", 2]);
    assert.equal(evidence.queries[0].rowCount, 1);
    assert.match(evidence.queries[0].plan.map(row => row.detail).join(" "), /SEARCH facts USING INDEX facts_scope/);
    assert.throws(() => captureProductionRead(database, () => { throw new Error("read failed"); }), /read failed/);
    assert.equal(database.prepare, prepare);
  } finally { database.close(); }
});

test("scan classification includes full index walks but excludes recursive and JSON temporary relations", () => {
  const sql = "WITH tree(id) AS (SELECT value FROM json_each(?)) SELECT r.id FROM run_sessions r JOIN tree t ON t.id=r.id";
  const plans = [{ detail: "SCAN json_each VIRTUAL TABLE INDEX 1:" }, { detail: "SCAN t" },
    { detail: "SCAN r USING COVERING INDEX sqlite_autoindex_run_sessions_1" }];
  assert.deepEqual(persistentScans(sql, plans), [plans[2].detail]);
});

test("synthetic structural evidence exercises real delegation and startup discovery without a Provider", async () => {
  const report = await runHarnessReliabilityQueryPlans({ scales: [4, 8], pageSize: 2 });
  assert.equal(report.externalProviderCalls, 0);
  assert.equal(report.scope, "synthetic_on_disk_production_query_plans_and_predicate_counts");
  assert.deepEqual(report.measurements.map(row => row.scale), [4, 8]);
  for (const row of report.measurements) {
    assert.equal(row.delegation.children.returned, 2);
    assert.equal(row.delegation.messages.returned, 2);
    assert.equal(row.delegation.children.queries.length, 1);
    assert.equal(row.delegation.messages.queries.length, 1);
    assert.equal(row.delegation.children.queries[0].rowCount, 3);
    assert.equal(row.delegation.messages.queries[0].rowCount, 3);
    assert.ok(row.delegation.children.queries[0].plan.some(plan => /SEARCH.*idx_delegation_steps_parent_delegation_created/.test(plan.detail)));
    assert.ok(row.delegation.messages.queries[0].plan.some(plan => /SEARCH.*idx_delegation_messages_step_created/.test(plan.detail)));
    assert.equal(row.startup.staleWorkUnits.returned, 2);
    assert.deepEqual(row.startup.staleWorkUnits.queries[0].bindings, ["stale", "task_run", report.corpus.time, 2]);
    assert.equal(row.startup.staleWorkUnitsAfter.queries[0].bindings.at(-2), `corpus-target-${String(row.scale - 2).padStart(5, "0")}:unit`);
    assert.equal(row.startup.scheduledContinuations.returned, 2);
    for (const [first, next] of [[row.delegation.children, row.delegation.childrenAfter],
      [row.delegation.messages, row.delegation.messagesAfter], [row.startup.staleWorkUnits, row.startup.staleWorkUnitsAfter],
      [row.startup.scheduledContinuations, row.startup.scheduledContinuationsAfter],
      [row.startup.delegatedRecovery, row.startup.delegatedRecoveryAfter]]) {
      assert.equal(next.returned, 2);
      assert.notDeepEqual(next.queries[0].bindings, first.queries[0].bindings);
    }
    assert.ok(row.completion.queries.length > 0);
    assert.ok(row.completion.predicateWork.totalInvocations > 0);
    assert.equal(row.cardinality.delegation_steps, row.scale * 2 + 1);
  }
  assert.ok(report.environment.sourceDigests["packages/core/src/storage/sqlite/delegation-completion-evidence.ts"]);
  assert.ok(report.environment.sourceDigests["packages/core/dist/storage/sqlite/delegation-completion-evidence.js"]);
  assert.match(report.environment.sqlite, /^\d+\.\d+/);
  assert.ok(report.schema.indexDefinitions.some(index => index.name === "idx_delegation_messages_step_created"));
  // Existing production gaps are findings, never silently removed or waived by the harness.
  assert.equal(typeof report.passed, "boolean");
  assert.ok(report.limits.some(value => /not.*latency/i.test(value)));
});

test("scale evidence rejects insufficient or unbounded populations before opening a corpus", async () => {
  for (const options of [{ scales: [4] }, { scales: [8, 4], pageSize: 2 }, { scales: [2, 4], pageSize: 2 },
    { scales: [4, 2_001], pageSize: 2 }, { scales: [4, 8], pageSize: 0 }]) {
    await assert.rejects(runHarnessReliabilityQueryPlans(options), /harness_query_scale_invalid/);
  }
});
