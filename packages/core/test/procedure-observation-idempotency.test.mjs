import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { createProcedureObservationInputFromJob, createProcedureObservationJobKey, createSqliteRunStore } from "../dist/index.js";

const now = "2026-10-01T00:00:00.000Z";
const job = { source: "explicit_user_request", signals: ["save_as_skill"], runId: "run_source", channelId: "channel",
  teammateId: "agent", taskId: "task", effectiveAttemptId: "attempt_1", evidenceVersion: "evidence_1", userConfirmed: true,
  title: "Amber ledger", summary: "Reconcile amber ledger evidence", normalizedGoal: "reconcile amber ledger" };
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-observation-unique-"));
  let store = createSqliteRunStore(cwd);
  const database = new DatabaseSync(store.paths.databasePath);
  t.after(async () => { database.close(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  return { cwd, database, get store() { return store; }, reopen() { store.close(); store = createSqliteRunStore(cwd); } };
}

test("source keys distinguish workspace, scope, Attempt and evidence revision without delimiter collisions", () => {
  const key = createProcedureObservationJobKey(job);
  for (const values of [{ workspaceId: "other" }, { channelId: "other" }, { teammateId: "other" }, { taskId: "other" },
    { effectiveAttemptId: "attempt_2" }, { evidenceVersion: "evidence_2" }]) assert.notEqual(createProcedureObservationJobKey({ ...job, ...values }), key);
  assert.notEqual(createProcedureObservationJobKey({ ...job, channelId: "a|b", teammateId: "c" }),
    createProcedureObservationJobKey({ ...job, channelId: "a", teammateId: "b|c" }));
  assert.equal(createProcedureObservationJobKey({ ...job, id: "different_client_retry_id" }), key);
});

test("job replay beyond the 500-row listing window and after restart returns the same observation", async t => {
  const f = await fixture(t);
  const built = createProcedureObservationInputFromJob(job);
  const first = f.store.createProcedureObservation({ ...built.observationInput, id: "original" }, now);
  const insert = f.database.prepare(`INSERT INTO procedure_observations SELECT ? AS id, workspace_id, cluster_id, channel_id,
    teammate_id, task_id, run_id, source, signals_json, title, summary, normalized_goal, positive_triggers_json,
    negative_triggers_json, procedure_steps_json, validation_steps_json, '[]', confidence, reusable_score,
    route_kind, route_reason_code, route_blockers_json, ? AS created_at FROM procedure_observations WHERE id = ?`);
  f.database.exec("BEGIN IMMEDIATE");
  for (let i = 0; i < 501; i++) insert.run(`newer_${i}`, "2026-10-02T00:00:00.000Z", first.id);
  f.database.exec("COMMIT");
  assert.ok(!f.store.listProcedureObservations({ limit: 500 }).some(item => item.id === first.id));
  assert.equal(f.store.getProcedureObservationByJobKey(built.jobKey).id, first.id);
  assert.equal(f.store.createProcedureObservation({ ...built.observationInput, id: "retry" }, now).id, first.id);
  f.reopen();
  assert.equal(f.store.createProcedureObservation({ ...built.observationInput, id: "restart_retry" }, now).id, first.id);
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM procedure_observation_jobs").get().n, 1);
});

test("migration maps legacy source keys without inventing or deleting historical observations", async t => {
  const f = await fixture(t);
  const built = createProcedureObservationInputFromJob({ ...job, effectiveAttemptId: undefined, evidenceVersion: undefined });
  f.store.createProcedureObservation({ ...built.observationInput, id: "legacy", sourceRefs: [{ type: "observation-job", id: built.legacyJobKey }] }, now);
  f.database.exec("DELETE FROM procedure_observation_jobs; DELETE FROM schema_migrations WHERE version = 179");
  f.reopen();
  assert.equal(f.store.getProcedureObservationByJobKey(built.legacyJobKey).id, "legacy");
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM procedure_observations").get().n, 1);
});

test("two independent SQLite writers concurrently commit only one observation for a source", async t => {
  const f = await fixture(t);
  const built = createProcedureObservationInputFromJob(job);
  const moduleUrl = new URL("../dist/index.js", import.meta.url).href;
  const code = `import { workerData, parentPort } from 'node:worker_threads';
    const { createSqliteRunStore } = await import(workerData.moduleUrl);
    const store = createSqliteRunStore(workerData.cwd);
    try { parentPort.postMessage(store.createProcedureObservation(workerData.input, workerData.now).id); }
    finally { store.close(); }`;
  const create = id => new Promise((resolve, reject) => {
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(code)}`), {
      workerData: { cwd: f.cwd, input: { ...built.observationInput, id }, now, moduleUrl } });
    worker.on("message", resolve); worker.on("error", reject);
    worker.on("exit", code => { if (code !== 0) reject(new Error(`Writer exited ${code}`)); });
  });
  const results = await Promise.all([create("writer_a"), create("writer_b")]);
  assert.equal(results[0], results[1]);
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM procedure_observations").get().n, 1);
});

test("failed source commits roll back all rows and reject asynchronous mutations before invocation", async t => {
  const f = await fixture(t);
  const built = createProcedureObservationInputFromJob(job);
  assert.throws(() => f.store.withProcedureObservationJobTransaction(() => {
    f.store.createProcedureObservation(built.observationInput, now);
    throw new Error("synthetic downstream failure");
  }), /synthetic downstream/);
  assert.equal(f.store.getProcedureObservationByJobKey(built.jobKey), undefined);
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM procedure_observations").get().n, 0);
  let invoked = false;
  assert.throws(() => f.store.withProcedureObservationJobTransaction(async () => { invoked = true; }), /must be synchronous/);
  assert.equal(invoked, false);
});
