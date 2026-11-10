import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "../dist/index.js";
import { SqliteHostOperationJournalStore } from "../dist/storage/sqlite/host-operation-journal-store.js";

const now = () => new Date().toISOString();
const code = expected => error => error.code === expected;
const contains = (error, message) => error?.message?.includes(message)
  || error instanceof AggregateError && error.errors.some(cause => contains(cause, message));

/** Two real connections to a fully migrated isolated store, with real original journal tickets. */
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-host-journal-transaction-"));
  const store = createSqliteRunStore(cwd), other = createSqliteRunStore(cwd), database = store.database;
  other.database.exec("PRAGMA busy_timeout=20");
  t.after(async () => { other.close(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  const at = now(), thread = store.createLingThread({ kind: "conversation", title: "Transaction ownership", objective: "Isolated rollback" }, at);
  const turn = store.appendConversationUserTurn({ threadId: thread.id, title: "Run", userInstruction: "Run",
    idempotencyKey: "transaction-turn", payload: { body: "Run", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, at);
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "run",
    idempotencyKey: "transaction-unit", status: "running", createdByActor: "system", request: {}, now: at });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "transaction-original",
    runnerId: "pi", status: "started", now: at }), fence = toRuntimeAttemptFence(attempt);
  const run = store.createRun({ id: "run", cwd, workUnitId: unit.id, threadId: thread.id, turnId: turn.turnId, taskId: "task",
    providerName: "test", providerModel: "test", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: at });
  store.linkRunToWorkUnit(run.id, unit.id, at); store.markRunStarted(run.id, at);
  const source = { runId: run.id, ...fence };
  database.exec("CREATE TABLE journal_transaction_probe(id TEXT PRIMARY KEY)");
  const admit = call => store.admitHostOperation({ operationId: `transaction-${call}`, source, kind: "mcp", toolCallId: call });
  const ticket = admit("original"), retainedStatement = database.prepare("SELECT phase FROM host_operations WHERE operation_id=?");
  return { cwd, store, other, database, source, run, ticket, admit, retainedStatement,
    originalExec: database.exec.bind(database), intent: { kind: "known_no_start", settledAt: now() } };
}

/** Closing the shared DatabaseSync must invalidate every retained SQL/module reference, not just the journal. */
function assertSharedConnectionQuarantined(f) {
  assert.equal(f.database.isOpen, false);
  assert.throws(() => f.retainedStatement.get(f.ticket.operationId));
  assert.throws(() => f.database.prepare("SELECT 1").get());
  assert.throws(() => f.database.exec("INSERT INTO journal_transaction_probe VALUES('unsafe-write')"));
  assert.throws(() => f.store.getHostOperation(f.ticket.operationId));
  assert.throws(() => f.store.getRun(f.run.id));
  assert.throws(() => f.store.listProviderPresets());
  assert.throws(() => f.admit("unsafe-admission"));
  assert.throws(() => f.store.settleHostOperation(f.ticket, f.intent));
}

/** Node 22's native accessor is non-configurable; proxy only the observation, not transaction execution. */
function journalWithReportedTransaction(f, reported) {
  const database = new Proxy(f.database, { get(target, name) {
    if (name === "isTransaction") return reported;
    const value = Reflect.get(target, name, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const journal = new SqliteHostOperationJournalStore({ database });
  const ticket = journal.admitHostOperation({ operationId: "transaction-reported", source: f.source, kind: "mcp", toolCallId: "reported" });
  f.intent.settledAt = now();
  return { journal, ticket };
}

test("journal owned rollback failure quarantines shared connection and discards uncommitted settlement", async t => {
  const f = await fixture(t);
  f.database.exec = sql => {
    if (sql === "COMMIT") throw new Error("owned_commit_unavailable");
    if (sql === "ROLLBACK") throw new Error("owned_rollback_unavailable");
    return f.originalExec(sql);
  };
  assert.throws(() => f.store.settleHostOperation(f.ticket, f.intent), error => error instanceof AggregateError
    && contains(error, "owned_commit_unavailable") && contains(error, "owned_rollback_unavailable"));
  assertSharedConnectionQuarantined(f);
  const persisted = f.other.getHostOperation(f.ticket.operationId);
  assert.equal(persisted.phase, "admitted"); assert.equal(persisted.revision, 0);
  assert.equal(f.other.listHostOperationBlockers(f.source).length, 1);
  assert.equal(f.other.database.prepare("SELECT count(*) n FROM journal_transaction_probe").get().n, 0);
  // Quarantine releases the writer lock, but never transfers this live capability to another connection.
  assert.throws(() => f.other.settleHostOperation(f.ticket, f.intent), code("host_operation_invalid_ticket"));
  assert.throws(() => f.other.settleHostOperation({ ...f.ticket }, f.intent), code("host_operation_invalid_ticket"));
  const next = f.other.admitHostOperation({ operationId: "healthy-connection", source: f.source, kind: "mcp", toolCallId: "healthy" });
  assert.equal(f.other.getHostOperation(next.operationId).phase, "admitted");
});

for (const operation of ["admission", "settlement"]) {
  test(`journal rejects caller-owned ${operation} without closing, rolling back or committing the outer transaction`, async t => {
    const f = await fixture(t); f.originalExec("BEGIN IMMEDIATE; INSERT INTO journal_transaction_probe VALUES('caller-owned')");
    let rollbacks = 0, commits = 0;
    f.database.exec = sql => {
      if (sql === "ROLLBACK") ++rollbacks;
      if (sql === "COMMIT") ++commits;
      return f.originalExec(sql);
    };
    assert.throws(() => operation === "admission" ? f.admit("nested") : f.store.settleHostOperation(f.ticket, f.intent));
    assert.equal(f.database.isOpen, true);
    assert.equal(rollbacks, 0); assert.equal(commits, 0);
    assert.equal(f.database.prepare("SELECT id FROM journal_transaction_probe").get().id, "caller-owned");
    assert.equal(f.other.database.prepare("SELECT count(*) n FROM journal_transaction_probe").get().n, 0);
    assert.equal(f.database.prepare("SELECT phase FROM host_operations WHERE operation_id=?").get(f.ticket.operationId).phase, "admitted");
    assert.equal(f.database.prepare("SELECT count(*) n FROM host_operations WHERE operation_id='transaction-nested'").get().n, 0);
    // Only the caller decides to end its transaction. A rejected nested settlement did not latch an intent.
    f.database.exec = f.originalExec; f.originalExec("COMMIT");
    assert.equal(f.other.database.prepare("SELECT id FROM journal_transaction_probe").get().id, "caller-owned");
    assert.equal(f.store.settleHostOperation(f.ticket, f.intent).phase, "safe");
  });
}

test("journal rejected BEGIN before ownership leaves healthy shared connection and original ticket retryable", async t => {
  const f = await fixture(t); let injected = false, rollbacks = 0;
  f.database.exec = sql => {
    if (sql === "BEGIN IMMEDIATE" && !injected) { injected = true; throw new Error("begin_unavailable"); }
    if (sql === "ROLLBACK") ++rollbacks;
    return f.originalExec(sql);
  };
  assert.throws(() => f.store.settleHostOperation(f.ticket, f.intent), error => contains(error, "begin_unavailable"));
  assert.equal(f.database.isOpen, true); assert.equal(rollbacks, 0);
  assert.equal(f.retainedStatement.get(f.ticket.operationId).phase, "admitted");
  assert.equal(f.store.settleHostOperation(f.ticket, f.intent).phase, "safe");
});

test("journal successful owned rollback keeps original-ticket same-intent retry but forbids changing intent", async t => {
  const f = await fixture(t); let injected = false, rollbacks = 0;
  f.database.exec = sql => {
    if (sql === "COMMIT" && !injected) { injected = true; throw new Error("retryable_commit_unavailable"); }
    if (sql === "ROLLBACK") ++rollbacks;
    return f.originalExec(sql);
  };
  assert.throws(() => f.store.settleHostOperation(f.ticket, f.intent), error => contains(error, "retryable_commit_unavailable"));
  assert.equal(f.database.isOpen, true); assert.equal(rollbacks, 1);
  assert.equal(f.retainedStatement.get(f.ticket.operationId).phase, "admitted");
  assert.equal(f.other.getHostOperation(f.ticket.operationId).phase, "admitted");
  assert.throws(() => f.store.settleHostOperation(f.ticket, { ...f.intent,
    settledAt: new Date(Date.parse(f.intent.settledAt) + 1000).toISOString() }), code("host_operation_settlement_conflict"));
  const settled = f.store.settleHostOperation(f.ticket, f.intent);
  assert.equal(settled.phase, "safe"); assert.equal(settled.revision, 1);
  assert.deepEqual(f.store.settleHostOperation(f.ticket, f.intent), settled);
  assert.deepEqual(f.other.getHostOperation(f.ticket.operationId), settled);
});

test("journal real COMMIT followed by return loss keeps healthy shared connection and same-intent replay", async t => {
  const f = await fixture(t); let injected = false, rollbacks = 0;
  f.database.exec = sql => {
    if (sql === "ROLLBACK") ++rollbacks;
    const result = f.originalExec(sql);
    if (sql === "COMMIT" && !injected) { injected = true; throw new Error("commit_return_lost"); }
    return result;
  };
  assert.throws(() => f.store.settleHostOperation(f.ticket, f.intent), error => contains(error, "commit_return_lost"));
  // The actual native ROLLBACK error, not an optional/misreported property, proves COMMIT ended our transaction.
  assert.equal(f.database.isOpen, true); assert.equal(rollbacks, 1);
  assert.equal(f.retainedStatement.get(f.ticket.operationId).phase, "safe");
  const persisted = f.other.getHostOperation(f.ticket.operationId);
  assert.equal(persisted.phase, "safe"); assert.equal(persisted.revision, 1);
  assert.deepEqual(f.store.settleHostOperation(f.ticket, f.intent), persisted);
  assert.deepEqual(f.store.settleHostOperation(f.ticket, f.intent), persisted);
  assert.throws(() => f.store.settleHostOperation(f.ticket, { ...f.intent,
    settledAt: new Date(Date.parse(f.intent.settledAt) + 1000).toISOString() }), code("host_operation_settlement_conflict"));
});

test("journal physical callback plus rollback failure quarantines without manufacturing safe or no-start", async t => {
  const f = await fixture(t), target = join(f.cwd, "physical-effect.txt"); let callbacks = 0;
  f.database.exec = sql => { if (sql === "ROLLBACK") throw new Error("physical_rollback_unavailable"); return f.originalExec(sql); };
  assert.throws(() => f.store.launchHostOperation(f.ticket, () => {
    ++callbacks; writeFileSync(target, "actual physical effect", "utf8"); throw new Error("physical_callback_failed");
  }), error => error instanceof AggregateError && contains(error, "physical_callback_failed") && contains(error, "physical_rollback_unavailable"));
  assert.equal(await readFile(target, "utf8"), "actual physical effect");
  assertSharedConnectionQuarantined(f);
  assert.throws(() => f.store.launchHostOperation(f.ticket, () => ++callbacks)); assert.equal(callbacks, 1);
  assert.equal(f.other.getHostOperation(f.ticket.operationId).phase, "admitted");
  assert.equal(f.other.listHostOperationBlockers(f.source).length, 1);
  assert.throws(() => f.other.settleHostOperation({ operationId: f.ticket.operationId }, f.intent), code("host_operation_invalid_ticket"));
});

for (const reported of [false, undefined]) {
  test(`journal owned rollback must execute when isTransaction incorrectly reports ${String(reported)}`, async t => {
    const f = await fixture(t); let injected = false, rollbacks = 0;
    const { journal, ticket } = journalWithReportedTransaction(f, reported);
    f.database.exec = sql => {
      if (sql === "COMMIT" && !injected) { injected = true; throw new Error("misreported_commit_unavailable"); }
      if (sql === "ROLLBACK") ++rollbacks;
      return f.originalExec(sql);
    };
    assert.throws(() => journal.settleHostOperation(ticket, f.intent), error => contains(error, "misreported_commit_unavailable"));
    assert.equal(f.database.isOpen, true); assert.equal(rollbacks, 1);
    assert.equal(f.retainedStatement.get(ticket.operationId).phase, "admitted");
    assert.equal(f.other.getHostOperation(ticket.operationId).phase, "admitted");
    assert.equal(journal.settleHostOperation(ticket, f.intent).phase, "safe");
  });

  test(`journal owned rollback failure must quarantine even when isTransaction reports ${String(reported)}`, async t => {
    const f = await fixture(t);
    const { journal, ticket } = journalWithReportedTransaction(f, reported);
    f.database.exec = sql => {
      if (sql === "COMMIT") throw new Error("misreported_owned_commit_unavailable");
      if (sql === "ROLLBACK") throw new Error("misreported_owned_rollback_unavailable");
      return f.originalExec(sql);
    };
    assert.throws(() => journal.settleHostOperation(ticket, f.intent), error => error instanceof AggregateError
      && contains(error, "misreported_owned_commit_unavailable") && contains(error, "misreported_owned_rollback_unavailable"));
    assertSharedConnectionQuarantined(f);
    assert.throws(() => journal.getHostOperation(ticket.operationId));
    assert.throws(() => journal.settleHostOperation(ticket, f.intent));
    assert.equal(f.other.getHostOperation(ticket.operationId).phase, "admitted");
  });

  test(`journal caller-owned transaction remains caller-owned when isTransaction reports ${String(reported)}`, async t => {
    const f = await fixture(t); let rollbacks = 0;
    const { journal, ticket } = journalWithReportedTransaction(f, reported);
    f.originalExec("BEGIN IMMEDIATE; INSERT INTO journal_transaction_probe VALUES('caller-owned')");
    f.database.exec = sql => { if (sql === "ROLLBACK") ++rollbacks; return f.originalExec(sql); };
    assert.throws(() => journal.settleHostOperation(ticket, f.intent));
    assert.equal(f.database.isOpen, true); assert.equal(rollbacks, 0);
    assert.equal(f.database.prepare("SELECT id FROM journal_transaction_probe").get().id, "caller-owned");
    assert.equal(f.other.database.prepare("SELECT count(*) n FROM journal_transaction_probe").get().n, 0);
    f.database.exec = f.originalExec; f.originalExec("COMMIT");
    assert.equal(f.other.database.prepare("SELECT id FROM journal_transaction_probe").get().id, "caller-owned");
    assert.equal(journal.settleHostOperation(ticket, f.intent).phase, "safe");
  });
}

for (const [label, fields] of [
  ["plain message", {}], ["wrong errcode", { code: "ERR_SQLITE_ERROR", errcode: 2 }],
  ["wrong code", { code: "NON_SQLITE_ERROR", errcode: 1 }],
]) {
  test(`journal ambiguous rollback ${label} must quarantine rather than treating matching text as no-active proof`, async t => {
    const f = await fixture(t);
    f.database.exec = sql => {
      if (sql === "COMMIT") throw new Error("ambiguous_commit_unavailable");
      if (sql === "ROLLBACK") throw Object.assign(new Error("cannot rollback - no transaction is active"), fields);
      return f.originalExec(sql);
    };
    assert.throws(() => f.store.settleHostOperation(f.ticket, f.intent), error => error instanceof AggregateError
      && contains(error, "ambiguous_commit_unavailable") && contains(error, "cannot rollback - no transaction is active"));
    assertSharedConnectionQuarantined(f);
    assert.equal(f.other.getHostOperation(f.ticket.operationId).phase, "admitted");
  });
}

for (const closedBeforeFailure of [false, true]) {
  test(`journal owned rollback close ${closedBeforeFailure ? "return loss" : "failure before closing"} isolates shared connection without double-close`, async t => {
    const f = await fixture(t), originalClose = f.database.close.bind(f.database);
    const commitError = new Error("close_case_commit_unavailable"), rollbackError = new Error("close_case_rollback_unavailable");
    const closeError = new Error(closedBeforeFailure ? "close_return_lost" : "close_before_closing_failed");
    let closeCalls = 0, caught;
    f.database.exec = sql => {
      if (sql === "COMMIT") throw commitError;
      if (sql === "ROLLBACK") throw rollbackError;
      return f.originalExec(sql);
    };
    f.database.close = () => { ++closeCalls; if (closedBeforeFailure) originalClose(); throw closeError; };
    try {
      assert.throws(() => f.store.settleHostOperation(f.ticket, f.intent), error => {
        caught = error;
        return error instanceof AggregateError && contains(error, commitError.message)
          && contains(error, rollbackError.message) && contains(error, closeError.message);
      });
    } finally {
      // A RED implementation still receives deterministic fixture cleanup, not a second injected close error.
      f.database.close = originalClose;
    }
    const leafErrors = error => error instanceof AggregateError ? error.errors.flatMap(leafErrors) : [error];
    // A native fallback on an already-closed handle would add a spurious no-open error here.
    assert.deepEqual(leafErrors(caught), [commitError, rollbackError, closeError]);
    assert.equal(closeCalls, 1);
    assertSharedConnectionQuarantined(f);
    assert.equal(f.other.database.isOpen, true);
    assert.equal(f.other.getHostOperation(f.ticket.operationId).phase, "admitted");
    assert.equal(f.other.listHostOperationBlockers(f.source).length, 1);
    assert.throws(() => f.other.settleHostOperation(f.ticket, f.intent), code("host_operation_invalid_ticket"));
    const healthy = f.other.admitHostOperation({ operationId: "close-fallback-healthy", source: f.source, kind: "mcp", toolCallId: "close-fallback-healthy" });
    assert.equal(f.other.getHostOperation(healthy.operationId).phase, "admitted");
  });
}

for (const [label, message] of [
  ["suffix", "cannot rollback - no transaction is active: stale report"],
  ["leading space", " cannot rollback - no transaction is active"],
  ["trailing space", "cannot rollback - no transaction is active "],
]) {
  test(`journal SQLite-shaped rollback with message ${label} quarantines instead of accepting non-exact no-active proof`, async t => {
    const f = await fixture(t), rollbackError = Object.assign(new Error(message),
      { code: "ERR_SQLITE_ERROR", errcode: 1, errstr: "SQL logic error" });
    f.database.exec = sql => {
      if (sql === "COMMIT") throw new Error("non_exact_commit_unavailable");
      if (sql === "ROLLBACK") throw rollbackError;
      return f.originalExec(sql);
    };
    assert.throws(() => f.store.settleHostOperation(f.ticket, f.intent), error => error instanceof AggregateError
      && contains(error, "non_exact_commit_unavailable") && contains(error, message));
    assertSharedConnectionQuarantined(f);
    assert.equal(f.other.getHostOperation(f.ticket.operationId).phase, "admitted");
  });
}

test("journal forged exact no-active rollback report cannot keep a still-active shared connection alive", async t => {
  const f = await fixture(t), commitError = new Error("forged_no_active_commit_unavailable");
  const rollbackError = Object.assign(new Error("cannot rollback - no transaction is active"),
    { code: "ERR_SQLITE_ERROR", errcode: 1, errstr: "SQL logic error" });
  let publicRollbacks = 0, caught;
  f.database.exec = sql => {
    if (sql === "COMMIT") throw commitError;
    // Do not invoke native ROLLBACK: the real transaction and its uncommitted safe row remain active.
    if (sql === "ROLLBACK") { ++publicRollbacks; throw rollbackError; }
    return f.originalExec(sql);
  };
  assert.throws(() => f.store.settleHostOperation(f.ticket, f.intent), error => {
    caught = error;
    return error instanceof AggregateError && contains(error, commitError.message) && contains(error, rollbackError.message);
  });
  const leafErrors = error => error instanceof AggregateError ? error.errors.flatMap(leafErrors) : [error];
  assert.equal(leafErrors(caught).includes(commitError), true);
  assert.equal(leafErrors(caught).includes(rollbackError), true);
  assert.equal(publicRollbacks, 1);
  assertSharedConnectionQuarantined(f);
  const persisted = f.other.getHostOperation(f.ticket.operationId);
  assert.equal(persisted.phase, "admitted"); assert.equal(persisted.revision, 0);
  assert.equal(f.other.listHostOperationBlockers(f.source).length, 1);
  assert.throws(() => f.other.settleHostOperation(f.ticket, f.intent), code("host_operation_invalid_ticket"));
  const healthy = f.other.admitHostOperation({ operationId: "forged-report-healthy", source: f.source, kind: "mcp", toolCallId: "forged-report-healthy" });
  assert.equal(f.other.getHostOperation(healthy.operationId).phase, "admitted");
});
