import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID } from "../dist/index.js";
import test from "node:test";
import {
  applyRunnerIdMigration,
  RUNNER_ID_MIGRATION_NAME,
  RUNNER_ID_MIGRATION_VERSION,
} from "../dist/storage/sqlite/runner-id-migration.js";
import { mapRunnerContinuation } from "../dist/storage/sqlite/runner-continuation-mappers.js";
import { mapRuntimeEvent } from "../dist/storage/sqlite/runtime-work-mappers.js";
import { mapControlPlaneEvent } from "../dist/storage/sqlite/control-plane-mappers.js";
import { mapRunEvent } from "../dist/storage/sqlite/run-mappers.js";
import { normalizeRunnerIdsInSnapshot } from "../dist/runner-ids.js";
import { assertUserInputExecutionPlan } from "../dist/storage/sqlite/user-input-preparation-store.js";
import { userInputHash } from "../dist/storage/sqlite/user-input-records.js";

const appliedAt = "2026-10-28T00:00:00.000Z";

test("canonicalizes runner bindings in every operational table and reruns idempotently", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-runner-id-canonicalization-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const database = new DatabaseSync(join(cwd, "fixture.sqlite"));
  t.after(() => database.close());
  createFixture(database);

  assert.equal(applyRunnerIdMigration(migrationInput(database)), true);
  for (const [table, columns] of [
    ["ai_teammates", ["runner_id"]],
    ["work_units", ["runner_id", "requested_runner_id", "effective_runner_id"]],
    ["work_unit_attempts", ["runner_id", "requested_runner_id", "effective_runner_id"]],
    ["runner_continuations", ["runner_id"]],
  ]) {
    for (const column of columns) {
      assert.equal(database.prepare(`SELECT ${column} FROM ${table} WHERE id = 'legacy'`).get()[column], "pi");
    }
  }
  assert.equal(
    database.prepare("SELECT name FROM schema_migrations WHERE version = ?").get(RUNNER_ID_MIGRATION_VERSION).name,
    RUNNER_ID_MIGRATION_NAME,
  );
  assert.equal(applyRunnerIdMigration(migrationInput(database)), false);
});

for (const fault of ["update", "marker"]) {
  test(`canonicalization migration rolls back on ${fault} failure`, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), `ling-runner-id-canonicalization-${fault}-`));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const database = new DatabaseSync(join(cwd, "fixture.sqlite"));
    t.after(() => database.close());
    createFixture(database);
    const wrapped = {
      prepare: (sql) => {
        if (fault === "update" && sql.includes('UPDATE "runner_continuations"')) {
          throw new Error("injected update failure");
        }
        return database.prepare(sql);
      },
      exec: (sql) => database.exec(sql),
    };
    const input = {
      database: wrapped,
      hasMigration: (version) => Boolean(database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version)),
      recordMigration: (version, name) => {
        if (fault === "marker") throw new Error("injected marker failure");
        database.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(version, name, appliedAt);
      },
    };

    assert.throws(() => applyRunnerIdMigration(input), /failure/u);
    assert.equal(database.isTransaction, false);
    assert.equal(database.prepare("SELECT runner_id FROM work_units WHERE id = 'legacy'").get().runner_id, "pi-coding-agent");
    assert.equal(database.prepare("SELECT runner_id FROM runner_continuations WHERE id = 'legacy'").get().runner_id, "pi-coding-agent");
    assert.equal(database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(RUNNER_ID_MIGRATION_VERSION), undefined);
  });
}

test("read boundaries normalize continuation and nested run snapshot aliases", () => {
  const stored = {
    runnerId: "pi-coding-agent",
    nested: [{ requestedRunnerId: "pi-coding-agent", effectiveRunnerId: "pi-coding-agent" }],
  };
  const projected = normalizeRunnerIdsInSnapshot(stored);
  assert.equal(projected.runnerId, "pi");
  assert.equal(projected.nested[0].requestedRunnerId, "pi");
  assert.equal(stored.runnerId, "pi-coding-agent");

  const continuation = mapRunnerContinuation({
    id: "continuation",
    schema_version: 1,
    run_id: "run",
    work_unit_id: "unit",
    source_attempt_id: "source",
    target_attempt_id: null,
    origin: "manual_resume",
    strategy: "native_resume",
    state: "requested",
    runner_id: "pi-coding-agent",
    runner_capability_revision: "pi:v1",
    context_view_id: "view",
    context_snapshot_artifact_id: "artifact",
    runner_handle_ref: null,
    idempotency_key: "key",
    claim_owner: null,
    claim_token: null,
    claim_expires_at: null,
    next_attempt_at: null,
    generation: 0,
    revision: 0,
    failure_code: null,
    failure_detail_artifact_id: null,
    created_at: appliedAt,
    updated_at: appliedAt,
    completed_at: null,
  });
  assert.equal(continuation.runnerId, "pi");

  const runtimeEvent = mapRuntimeEvent({
    id: "event",
    work_unit_id: "unit",
    attempt_id: null,
    runtime_instance_id: null,
    fencing_token: null,
    seq: 1,
    ts: appliedAt,
    type: "work_unit_created",
    actor: "system",
    data_json: JSON.stringify({ runnerResolution: { requestedRunnerId: "pi-coding-agent", effectiveRunnerId: "pi-coding-agent" } }),
  });
  assert.equal(runtimeEvent.data.runnerResolution.requestedRunnerId, "pi");

  const runEvent = mapRunEvent({
    id: "run-event",
    run_id: "run",
    seq: 1,
    ts: appliedAt,
    type: "run_created",
    data_json: JSON.stringify({ runnerResolution: { requestedRunnerId: "pi-coding-agent", effectiveRunnerId: "pi-coding-agent" } }),
  });
  assert.equal(runEvent.data.runnerResolution.requestedRunnerId, "pi");

  const controlPlaneEvent = mapControlPlaneEvent({
    seq: 1,
    workspace_id: "workspace",
    cwd: "/workspace",
    ts: appliedAt,
    domain: "runtime",
    entity_type: "work_unit",
    entity_id: "unit",
    action: "created",
    data_json: JSON.stringify({ runnerId: "pi-coding-agent" }),
    idempotency_key: null,
  });
  assert.equal(controlPlaneEvent.data.runnerId, "pi");
});

test("historical user-input execution plans accept the runner alias and validate its canonical projection", () => {
  const task = { id: "task", title: "Task", prompt: "Prompt", channelId: "channel" };
  const provider = { provider: "fixture", model: "fixture-model" };
  const request = {
    cwd: "/workspace",
    threadId: "thread",
    turnId: "turn",
    teammateId: "teammate",
    task,
    parentRunId: "parent-run",
    continuationReason: "user_input_answer",
  };
  const preparedInput = { taskId: "task", fingerprint: userInputHash({ taskId: "task" }) };
  const plan = {
    schemaVersion: 1,
    runnerId: "pi-coding-agent",
    providerName: provider.provider,
    providerModel: provider.model,
    taskSnapshot: task,
    providerSnapshot: provider,
    requestSnapshot: request,
    preparedInput,
    preparedInputFingerprint: preparedInput.fingerprint,
    runnerExecutionInput: {
      schemaVersion: 1,
      runnerId: "pi-coding-agent",
      toolHydrationEnabled: false,
      input: { cwd: request.cwd, task, provider },
      preparedInput,
    },
  };
  const seed = { source: {
    cwd: request.cwd,
    threadId: request.threadId,
    turnId: request.turnId,
    participantId: request.teammateId,
    channelId: "channel",
    workflowStepId: undefined,
    runId: request.parentRunId,
    taskBinding: { taskId: "task", channelId: "channel" },
  } };
  assert.doesNotThrow(() => assertUserInputExecutionPlan(plan, seed, request));
  assert.equal(normalizeRunnerIdsInSnapshot(plan).runnerId, "pi");
});

function createFixture(database) {
  database.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
    CREATE TABLE ai_teammates (id TEXT PRIMARY KEY, runner_id TEXT);
    CREATE TABLE work_units (id TEXT PRIMARY KEY, runner_id TEXT, requested_runner_id TEXT, effective_runner_id TEXT);
    CREATE TABLE work_unit_attempts (id TEXT PRIMARY KEY, runner_id TEXT, requested_runner_id TEXT, effective_runner_id TEXT);
    CREATE TABLE runner_continuations (id TEXT PRIMARY KEY, runner_id TEXT);
    INSERT INTO ai_teammates VALUES ('legacy', 'pi-coding-agent');
    INSERT INTO work_units VALUES ('legacy', 'pi-coding-agent', 'pi-coding-agent', 'pi-coding-agent');
    INSERT INTO work_unit_attempts VALUES ('legacy', 'pi-coding-agent', 'pi-coding-agent', 'pi-coding-agent');
    INSERT INTO runner_continuations VALUES ('legacy', 'pi-coding-agent');
  `);
}

function migrationInput(database) {
  return {
    database,
    hasMigration: (version) => Boolean(database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version)),
    recordMigration: (version, name) => database
      .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
      .run(version, name, appliedAt),
  };
}


test("new SQLite writes persist canonical runner IDs without changing user text", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-runner-id-write-boundaries-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const now = "2026-10-29T00:00:00.000Z";
  store.createWorkUnit({
    id: "unit", workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "run",
    idempotencyKey: "unit-key", status: "running", createdByActor: "system",
    request: { runnerId: "pi-coding-agent", prompt: "keep pi-coding-agent" }, now,
  });
  const run = store.createRun({
    id: "run", cwd, taskId: "task", workUnitId: "unit", providerName: "fixture", providerModel: "fixture-model",
    taskSnapshot: { runnerId: "pi-coding-agent" },
    providerSnapshot: { runnerId: "pi-coding-agent", apiKey: "fixture-secret" },
    requestSnapshot: { runnerId: "pi-coding-agent", prompt: "keep pi-coding-agent" }, createdAt: now,
  });
  store.appendRuntimeDiagnosticEvent({
    workUnitId: "unit", ts: now, type: "work_unit_created", actor: "system",
    data: { runnerId: "pi-coding-agent", prompt: "keep pi-coding-agent" },
  });
  store.appendEvent(run.id, "run_created", { taskId: "task", runnerId: "pi-coding-agent" }, now);
  store.appendControlPlaneEvent({
    workspaceId: DEFAULT_WORKSPACE_ID, cwd, domain: "runs", entityType: "run", entityId: run.id,
    action: "run.created", data: { runnerId: "pi-coding-agent", prompt: "keep pi-coding-agent" },
  }, now);

  const rawWorkUnit = store.database.prepare("SELECT request_json FROM work_units WHERE id = ?").get("unit");
  const rawRun = store.database.prepare("SELECT task_snapshot_json, provider_snapshot_json, request_snapshot_json FROM run_sessions WHERE id = ?").get("run");
  const rawRunEvent = store.database.prepare("SELECT data_json FROM run_events WHERE run_id = ?").get(run.id);
  const rawControlPlane = store.database.prepare("SELECT data_json FROM control_plane_events WHERE entity_id = ?").get(run.id);
  const rawRuntimeEvent = store.database.prepare("SELECT data_json FROM runtime_events WHERE work_unit_id = ?").get("unit");
  assert.deepEqual(JSON.parse(rawRuntimeEvent.data_json), { runnerId: "pi", prompt: "keep pi-coding-agent" });
  assert.equal(JSON.parse(rawWorkUnit.request_json).runnerId, "pi");
  assert.equal(JSON.parse(rawWorkUnit.request_json).prompt, "keep pi-coding-agent");
  assert.equal(JSON.parse(rawRun.task_snapshot_json).runnerId, "pi");
  assert.equal(JSON.parse(rawRun.provider_snapshot_json).runnerId, "pi");
  assert.notEqual(JSON.parse(rawRun.provider_snapshot_json).apiKey, "fixture-secret");
  assert.equal(JSON.parse(rawRun.request_snapshot_json).runnerId, "pi");
  assert.equal(JSON.parse(rawRun.request_snapshot_json).prompt, "keep pi-coding-agent");
  assert.equal(JSON.parse(rawRunEvent.data_json).runnerId, "pi");
  assert.equal(JSON.parse(rawControlPlane.data_json).runnerId, "pi");
});

test("control-plane idempotency treats legacy and canonical runner IDs as the same event", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-runner-id-control-plane-idempotency-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const input = {
    workspaceId: DEFAULT_WORKSPACE_ID, cwd, domain: "runs", entityType: "run", entityId: "run-idempotent",
    action: "run.created", idempotencyKey: "runner-idempotency",
    data: { runnerId: "pi-coding-agent", prompt: "keep pi-coding-agent" },
  };
  const first = store.appendControlPlaneEvent(input, "2026-10-29T00:00:00.000Z");
  assert.equal(store.appendControlPlaneEvent(input, "2026-10-29T00:00:00.500Z").seq, first.seq);
  assert.equal(store.appendControlPlaneEvent({ ...input, data: { runnerId: "pi", prompt: "keep pi-coding-agent" } }, "2026-10-29T00:00:01.000Z").seq, first.seq);
  assert.throws(() => store.appendControlPlaneEvent({ ...input, data: { runnerId: "pi", prompt: "different" } }, "2026-10-29T00:00:02.000Z"), /idempotency conflict/u);
  assert.throws(() => store.appendControlPlaneEvent({ ...input, data: { runnerId: "codex", prompt: "keep pi-coding-agent" } }, "2026-10-29T00:00:03.000Z"), /idempotency conflict/u);
  assert.equal(store.listControlPlaneEvents({ workspaceId: DEFAULT_WORKSPACE_ID }).length, 1);
});
