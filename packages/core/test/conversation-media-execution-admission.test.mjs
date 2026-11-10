import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "../dist/index.js";
import {
  assertConversationMediaExecutionAdmission,
  redactConversationMediaWorkUnitRequest,
} from "../dist/storage/sqlite/conversation-media-execution-admission.js";

const now = () => new Date().toISOString();
const code = expected => error => error.code === expected;

/** Isolated migrated SQLite; parent lineage is created through real Core APIs. */
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-media-execution-admission-"));
  let store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const createdAt = now();
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run",
    ownerId: "source-run", idempotencyKey: "source-unit", status: "running", createdByActor: "system", request: {}, now: createdAt });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "source-runtime",
    runnerId: "pi", status: "started", now: createdAt });
  const run = store.createRun({ id: "source-run", cwd, workUnitId: unit.id, taskId: "media-task",
    providerName: "test", providerModel: "test", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt });
  store.linkRunToWorkUnit(run.id, unit.id, createdAt);
  store.markRunStarted(run.id, createdAt);
  const source = { runId: run.id, ...toRuntimeAttemptFence(attempt) };
  const input = { runId: run.id, idempotencyKey: "media-call-source", toolCallId: "image-call",
    executionAdmission: { schemaVersion: 1, source, requestDigest: "a".repeat(64) },
    target: { id: "provider:image", ref: { kind: "provider", providerPresetId: "image" },
      generationKind: "image", displayName: "Scoped image provider" },
    mediaJob: { providerPresetId: "image", operation: "image_generate", prompt: "A local fixture image", input: { count: 1 } } };
  return { cwd, unit, attempt, run, source, input, get store() { return store; },
    create: (overrides = {}) => store.createOrReuseConversationMediaJob({ ...input, ...overrides }, now()),
    snapshot: () => ({ jobs: store.listMediaJobs(), children: store.listWorkUnits({ kind: "media_job", limit: 100 }) }),
    reopen: () => { store.close(); store = createSqliteRunStore(cwd); },
    replace: () => store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 2,
      runtimeInstanceId: "replacement-runtime", runnerId: "pi", status: "started", now: now() }),
  };
}

test("conversation media admission persists only on the child and exact reuse survives SQLite reopen", async t => {
  const f = await fixture(t);
  const first = f.create();
  assert.equal(first.reused, false);
  assert.deepEqual(first.workUnit.request.executionAdmission, f.input.executionAdmission);
  assert.equal(Object.hasOwn(first.mediaJob.input, "executionAdmission"), false,
    "Host source cannot leak into the vendor request");
  const before = f.snapshot();
  f.reopen();
  const reused = f.create();
  assert.equal(reused.reused, true);
  assert.equal(reused.mediaJob.id, first.mediaJob.id);
  assert.equal(reused.workUnit.id, first.workUnit.id);
  assert.deepEqual(f.snapshot(), before, "reuse reads immutable metadata without rewriting it");
});

test("trusted media admission survives persistence while adjacent secrets remain redacted", async t => {
  const f = await fixture(t);
  const secret = "sk-local-media-fixture-secret12345";
  const first = f.create({ target: { ...f.input.target,
    apiKey: secret, accessToken: secret, authorization: `Bearer ${secret}`,
    displayName: `Provider ${secret}`, nested: { password: secret, fencingToken: secret },
  } });
  assert.deepEqual(first.workUnit.request.executionAdmission, f.input.executionAdmission);
  const row = f.store.database.prepare("SELECT request_json FROM work_units WHERE id=?").get(first.workUnit.id);
  assert.equal(row.request_json.includes(secret), false, "ordinary credentials cannot be persisted by the trusted seam");
  const request = JSON.parse(row.request_json);
  for (const field of ["apiKey", "accessToken", "authorization"]) {
    assert.equal(request.target[field], "[REDACTED]");
  }
  assert.deepEqual(request.target.nested, { password: "[REDACTED]", fencingToken: "[REDACTED]" });
  f.reopen();
  assert.equal(f.create().reused, true);
  assert.deepEqual(f.store.getWorkUnit(first.workUnit.id).request, request);
});

test("generic WorkUnit requests cannot exempt a caller-shaped executionAdmission from redaction", async t => {
  const f = await fixture(t);
  const unit = f.store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "media_job",
    ownerType: "conversation_run", ownerId: f.run.id, linkedRunId: f.run.id,
    idempotencyKey: "untrusted-media-request", createdByActor: "user", now: now(),
    request: { source: "conversation_media_tool", executionAdmission: f.input.executionAdmission,
      token: "not-a-trusted-token" },
  }, f.input.executionAdmission);
  assert.equal(unit.request.executionAdmission.source.fencingToken, "[REDACTED]");
  assert.equal(unit.request.token, "[REDACTED]");
});

function persistenceInput(f, admission) {
  return { workspaceId: DEFAULT_WORKSPACE_ID, kind: "media_job", ownerType: "conversation_run",
    ownerId: f.run.id, linkedRunId: f.run.id, idempotencyKey: "trusted-request", createdByActor: "user", now: now(),
    request: { source: "conversation_media_tool", toolCallId: f.input.toolCallId, executionAdmission: admission } };
}

test("trusted serializer rejects unvalidated, cloned, foreign and consumed admission snapshots", async t => {
  const f = await fixture(t);
  const other = await fixture(t);
  assert.throws(() => assertConversationMediaExecutionAdmission(f.store.database, f.input),
    code("media_execution_admission_invalid"));
  f.store.database.exec("BEGIN IMMEDIATE");
  try {
    assert.throws(() => redactConversationMediaWorkUnitRequest(f.store.database,
      persistenceInput(f, f.input.executionAdmission), f.input.executionAdmission), code("media_execution_admission_invalid"));
    const admission = assertConversationMediaExecutionAdmission(f.store.database, f.input);
    const clone = structuredClone(admission);
    assert.throws(() => redactConversationMediaWorkUnitRequest(f.store.database,
      persistenceInput(f, clone), clone), code("media_execution_admission_invalid"));
    assert.throws(() => redactConversationMediaWorkUnitRequest(other.store.database,
      persistenceInput(f, admission), admission), code("media_execution_admission_invalid"));
    assert.throws(() => { admission.source.fencingToken = "999999"; }, TypeError);
    assert.throws(() => { admission.requestDigest = "b".repeat(64); }, TypeError);
    const request = redactConversationMediaWorkUnitRequest(f.store.database, persistenceInput(f, admission), admission);
    assert.deepEqual(request.executionAdmission, f.input.executionAdmission);
    assert.throws(() => redactConversationMediaWorkUnitRequest(f.store.database,
      persistenceInput(f, admission), admission), code("media_execution_admission_invalid"));
  } finally { f.store.database.exec("ROLLBACK"); }
  assert.deepEqual(f.snapshot(), { jobs: [], children: [] });
});

test("serializer revalidates actual SQLite transaction and owner, not an old validation marker", async t => {
  const f = await fixture(t);
  f.store.database.exec("BEGIN IMMEDIATE");
  const admission = assertConversationMediaExecutionAdmission(f.store.database, f.input);
  f.store.database.exec("ROLLBACK");
  assert.throws(() => redactConversationMediaWorkUnitRequest(f.store.database,
    persistenceInput(f, admission), admission), code("media_execution_admission_invalid"));
  f.replace();
  f.store.database.exec("BEGIN IMMEDIATE");
  try {
    assert.throws(() => redactConversationMediaWorkUnitRequest(f.store.database,
      persistenceInput(f, admission), admission), code("media_execution_admission_stale_owner"));
  } finally { f.store.database.exec("ROLLBACK"); }
});

test("media persistence uses SQLite ownership when the runtime transaction flag is unavailable", async t => {
  const f = await fixture(t);
  const database = new Proxy(f.store.database, { get(target, key) {
    if (key === "isTransaction") throw new Error("JS transaction flag is unavailable");
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  database.exec("BEGIN IMMEDIATE");
  try {
    const admission = assertConversationMediaExecutionAdmission(database, f.input);
    assert.deepEqual(redactConversationMediaWorkUnitRequest(database,
      persistenceInput(f, admission), admission).executionAdmission, f.input.executionAdmission);
  } finally { database.exec("ROLLBACK"); }
});

test("admission reads mutable accessors exactly once and persists the validated primitive snapshot", async t => {
  const f = await fixture(t);
  let digestReads = 0;
  let fenceReads = 0;
  const admission = { schemaVersion: 1,
    get requestDigest() { return ++digestReads === 1 ? "a".repeat(64) : "sk-unvalidated-secret12345"; },
    source: { ...f.source,
      get fencingToken() { return ++fenceReads === 1 ? f.source.fencingToken : "sk-unvalidated-secret12345"; },
    },
  };
  const first = f.create({ executionAdmission: admission });
  assert.deepEqual(first.workUnit.request.executionAdmission, f.input.executionAdmission);
  assert.equal(digestReads, 1);
  assert.equal(fenceReads, 1);
});

test("adjacent request getters cannot replace the parent after trusted admission validation", async t => {
  const f = await fixture(t);
  f.store.database.exec("BEGIN IMMEDIATE");
  try {
    const admission = assertConversationMediaExecutionAdmission(f.store.database, f.input);
    const input = persistenceInput(f, admission);
    Object.defineProperty(input.request, "target", { enumerable: true, get() {
      f.store.database.prepare("UPDATE work_units SET active_attempt_id=NULL WHERE id=?").run(f.unit.id);
      return {};
    } });
    assert.throws(() => redactConversationMediaWorkUnitRequest(f.store.database, input, admission),
      code("media_execution_admission_stale_owner"));
  } finally { f.store.database.exec("ROLLBACK"); }
});

for (const mode of ["ABORT", "ROLLBACK"]) {
  test(`Media child insertion failure preserves the original error and rolls back the job: ${mode}`, async t => {
    const f = await fixture(t);
    f.store.database.exec(`CREATE TRIGGER media_child_failure BEFORE INSERT ON work_units
      WHEN NEW.kind='media_job' BEGIN SELECT RAISE(${mode}, 'media_child_failed'); END`);
    assert.throws(() => f.create(), /media_child_failed/);
    assert.deepEqual(f.snapshot(), { jobs: [], children: [] });
  });
}

test("untracked conversation media creation and reuse do not manufacture admission metadata", async t => {
  const f = await fixture(t);
  const first = f.create({ executionAdmission: undefined });
  const reused = f.create({ executionAdmission: undefined });
  assert.equal(reused.reused, true);
  assert.equal(Object.hasOwn(first.workUnit.request, "executionAdmission"), false);
  assert.deepEqual(f.store.getWorkUnit(first.workUnit.id), first.workUnit);
});

for (const originalCaptured of [false, true]) {
  test(`reuse rejects ${originalCaptured ? "captured-to-missing" : "missing-to-captured"} admission without changing SQLite`, async t => {
    const f = await fixture(t);
    f.create({ executionAdmission: originalCaptured ? f.input.executionAdmission : undefined });
    const before = f.snapshot();
    assert.throws(() => f.create({ executionAdmission: originalCaptured ? undefined : f.input.executionAdmission }),
      code("media_execution_admission_conflict"));
    assert.deepEqual(f.snapshot(), before);
  });
}

for (const field of ["requestDigest", "toolCallId"]) {
  test(`reuse rejects a changed ${field} even with the original source`, async t => {
    const f = await fixture(t);
    f.create();
    const before = f.snapshot();
    const overrides = field === "requestDigest"
      ? { executionAdmission: { ...f.input.executionAdmission, requestDigest: "b".repeat(64) } }
      : { toolCallId: "another-image-call" };
    assert.throws(() => f.create(overrides), code("media_execution_admission_conflict"));
    assert.deepEqual(f.snapshot(), before);
  });
}

test("a current replacement Attempt cannot adopt the previous child's admission", async t => {
  const f = await fixture(t);
  f.create();
  const replacement = f.replace();
  const before = f.snapshot();
  assert.throws(() => f.create(), code("media_execution_admission_stale_owner"));
  assert.throws(() => f.create({ executionAdmission: { ...f.input.executionAdmission,
    source: { runId: f.run.id, ...toRuntimeAttemptFence(replacement) } } }), code("media_execution_admission_conflict"));
  assert.deepEqual(f.snapshot(), before);
});

for (const obsolete of ["replacement", "parent-terminal"]) {
  test(`creation rejects ${obsolete} before inserting a MediaJob or child`, async t => {
    const f = await fixture(t);
    if (obsolete === "replacement") f.replace();
    else f.store.markRunSucceeded(f.run.id, now());
    assert.throws(() => f.create(), code("media_execution_admission_stale_owner"));
    assert.deepEqual(f.snapshot(), { jobs: [], children: [] });
  });
}

for (const field of ["runId", "workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"]) {
  test(`creation verifies actual Core source ${field} before any domain insert`, async t => {
    const f = await fixture(t);
    const source = { ...f.source, [field]: field === "fencingToken" ? "999999" : `wrong-${field}` };
    assert.throws(() => f.create({ executionAdmission: { ...f.input.executionAdmission, source } }),
      error => ["media_execution_admission_invalid", "host_operation_invalid_source"].includes(error.code));
    assert.deepEqual(f.snapshot(), { jobs: [], children: [] });
  });
}

for (const [label, change] of [
  ["null", () => null],
  ["schema", value => ({ ...value, schemaVersion: 2 })],
  ["digest", value => ({ ...value, requestDigest: "not-a-digest" })],
  ["extra-admission-field", value => ({ ...value, extra: "not-admission" })],
  ["extra-source-field", value => ({ ...value, source: { ...value.source, extra: "not-source" } })],
  ["missing-source-field", value => ({ ...value, source: { ...value.source, attemptId: undefined } })],
  ["invalid-fence", value => ({ ...value, source: { ...value.source, fencingToken: "not-a-fence" } })],
]) {
  test(`creation fails closed for malformed ${label} admission`, async t => {
    const f = await fixture(t);
    assert.throws(() => f.create({ executionAdmission: change(f.input.executionAdmission) }),
      code("media_execution_admission_invalid"));
    assert.deepEqual(f.snapshot(), { jobs: [], children: [] });
  });
}

test("a corrupted saved admission cannot be replaced by a valid caller snapshot", async t => {
  const f = await fixture(t);
  const first = f.create();
  // Controlled tampering of an isolated fixture proves strict persisted read-back.
  const request = { ...first.workUnit.request, executionAdmission: { ...f.input.executionAdmission, schemaVersion: 2 } };
  f.store.database.prepare("UPDATE work_units SET request_json=? WHERE id=?").run(JSON.stringify(request), first.workUnit.id);
  const before = f.snapshot();
  assert.throws(() => f.create(), code("media_execution_admission_invalid"));
  assert.deepEqual(f.snapshot(), before);
});

for (const field of ["linkedRunId", "mediaJobId", "source"]) {
  test(`captured reuse rejects corrupted child ${field} without rewriting the job`, async t => {
    const f = await fixture(t);
    const first = f.create();
    if (field === "linkedRunId") {
      f.store.database.prepare("UPDATE work_units SET linked_run_id=NULL WHERE id=?").run(first.workUnit.id);
    } else {
      const request = { ...first.workUnit.request, [field]: "another-child" };
      f.store.database.prepare("UPDATE work_units SET request_json=? WHERE id=?").run(JSON.stringify(request), first.workUnit.id);
    }
    const before = f.snapshot();
    assert.throws(() => f.create(), code("media_execution_admission_invalid"));
    assert.deepEqual(f.snapshot(), before);
  });
}
