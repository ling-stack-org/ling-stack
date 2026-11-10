import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { HostAttemptEffectObservation } from "../../dist/host-attempt-completion-types.js";
import type { HostOperationSource } from "../../dist/host-operation-journal-types.js";
import type { HostRunCapacityWorkspaceIdentitySnapshot } from "../../dist/host-run-capacity-workspace-identity.js";
import type { RunStatus } from "../../dist/run-types.js";
import type { RuntimeHostCapacityIntentRecord } from "../../dist/runtime-host-capacity-types.js";
import { HostRunCapacityStore } from "../../dist/storage/host-run-capacity-store.js";
import { captureHostRunCapacityWorkspaceIdentity } from "../../dist/host-run-capacity-workspace-identity.js";
import { RuntimeHostCapacityBridge } from "../../dist/runtime-host-capacity-bridge.js";
import { applyRuntimeHostCapacityMigration } from "../../dist/storage/sqlite/runtime-host-capacity-migration.js";
import { SqliteRuntimeHostCapacityStore } from "../../dist/storage/sqlite/runtime-host-capacity-store.js";
import { SqliteRuntimeSemaphoreStore } from "../../dist/storage/sqlite/runtime-semaphore-store.js";
import { runtimeRunQueueFixture } from "./runtime-run-queue-fixture.ts";
import { testDatabase } from "./sqlite-test-database.ts";

type QueueFixture = Awaited<ReturnType<typeof runtimeRunQueueFixture>>;
type Current = ReturnType<QueueFixture["prepare"]>;
type Store = QueueFixture["store"];
type ConsumeOptions = { journal?: SqliteRuntimeHostCapacityStore; now?: string; source?: HostOperationSource; token?: string };
type HostCapacityExtensions = {
  identity: HostRunCapacityWorkspaceIdentitySnapshot;
  journalFor(store?: Store): SqliteRuntimeHostCapacityStore;
  journal: SqliteRuntimeHostCapacityStore;
  bridgeFor(journal?: SqliteRuntimeHostCapacityStore): RuntimeHostCapacityBridge;
  bridge: RuntimeHostCapacityBridge;
  source(current: Current): HostOperationSource;
  intent(current: Current): RuntimeHostCapacityIntentRecord;
  reserve(current: Current): RuntimeHostCapacityIntentRecord;
  consume(current: Current, record: RuntimeHostCapacityIntentRecord, options?: ConsumeOptions): boolean;
  localAdmission(current: Current, record: RuntimeHostCapacityIntentRecord,
    options?: { now?: string; rollback?: boolean; omit?: readonly string[]; journal?: SqliteRuntimeHostCapacityStore }): boolean;
  terminal(current: Current, options?: { status?: RunStatus; started?: boolean; now?: string }): void;
  begin(current: Current, record: RuntimeHostCapacityIntentRecord, options?: { coverage?: HostAttemptEffectObservation }): {
    lifetime: ReturnType<typeof deferred>;
    completion: ReturnType<Store["trackHostAttemptCompletion"]>;
  };
  hostSnapshot(): ReturnType<QueueFixture["rows"]>;
  journalSnapshot(): ReturnType<QueueFixture["rows"]>[];
};
type HostCapacityWorkspace = QueueFixture & HostCapacityExtensions;

export const realNow = () => new Date().toISOString();
export const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
};

export function hostCapacityFixture(t: TestContext, { maximum = 4, configured = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-runtime-host-capacity-")));
  const databasePath = join(root, "home", "global.sqlite"), stores = new Set<HostRunCapacityStore>();
  mkdirSync(join(root, "home"));
  t.after(() => {
    for (const store of stores) if (store.database.isOpen) store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const open = () => {
    const store = new HostRunCapacityStore({ globalDatabasePath: databasePath });
    stores.add(store);
    return store;
  };
  const f = { root, databasePath, host: open(), open,
    reopen() { f.host.close(); return f.host = open(); } };
  if (configured) assert.equal(f.host.installPolicy({ expectedRevision: 0, maxConcurrentRuns: maximum,
    installedAt: new Date(Date.now() - 60_000).toISOString() }).status, "installed");
  return f;
}

/** A real workspace database plus the same resource APIs used by ordinary Pi admission. */
export async function hostCapacityWorkspace(t: TestContext, host: ReturnType<typeof hostCapacityFixture>): Promise<HostCapacityWorkspace> {
  const queue = await runtimeRunQueueFixture(t, { clockStart: Date.now() - 30_000 });
  const migrate = (store: Store) => applyRuntimeHostCapacityMigration({ database: testDatabase(store),
    hasMigration: version => !!testDatabase(store).prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version),
    recordMigration: (version, name) => testDatabase(store).prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)")
      .run(version, name, realNow()) });
  migrate(queue.store);
  const identity = captureHostRunCapacityWorkspaceIdentity({ workspaceId: queue.workspaceId, cwd: queue.cwd, databasePath: queue.paths.databasePath });
  const journalFor = (store = queue.store) => new SqliteRuntimeHostCapacityStore({ database: testDatabase(store) }, store, identity);
  const journal = journalFor();
  const bridgeFor = (journal = f.journal) => new RuntimeHostCapacityBridge(journal, host.host);
  const source: HostCapacityExtensions["source"] = current => ({ runId: current.run.id, ...current.fence });
  const intent: HostCapacityExtensions["intent"] = current => {
    const prepared = f.journal.prepareAttempt({ source: f.source(current), now: f.at(3) });
    assert.ok(prepared.status === "prepared" || prepared.status === "duplicate", JSON.stringify(prepared));
    return prepared.record;
  };
  const reserve: HostCapacityExtensions["reserve"] = current => {
    const reserved = f.bridge.reserveAttempt({ source: f.source(current), now: f.at(3) });
    assert.ok(reserved.status === "reserved" || reserved.status === "duplicate", JSON.stringify(reserved));
    return reserved.record;
  };
  const consume: HostCapacityExtensions["consume"] = (current, record, { journal = f.journal, now = f.at(4), source = f.source(current), token = record.dispatchToken } = {}) =>
    journal.consumeDispatchGateWithinTransaction({ intentId: record.intent.intentId, token: token!, source, now });
  const localAdmission: HostCapacityExtensions["localAdmission"] = (current, record, { now = f.at(4), rollback = false, omit = [], journal = f.journal } = {}) => {
    const db = testDatabase(f.store), group = f.resources(current, now);
    const semaphores = new SqliteRuntimeSemaphoreStore({ database: db }, f.store);
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const lease of group.leases) if (!omit.includes(lease.resourceType)) assert.ok(f.store.acquireResourceLease(lease));
      for (const slot of group.semaphores) if (!omit.includes(slot.resourceType)) {
        assert.equal(semaphores.ensureRuntimeSemaphoreSlotForAttemptWithinTransaction(slot).status, "acquired");
      }
      const consumed = f.consume(current, record, { journal, now });
      db.exec(rollback || !consumed ? "ROLLBACK" : "COMMIT");
      return consumed;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  };
  const terminal: HostCapacityExtensions["terminal"] = (current, { status = "cancelled", started = true, now = realNow() } = {}) => {
    testDatabase(f.store).prepare("UPDATE run_sessions SET status=?,started_at=?,ended_at=? WHERE id=?")
      .run(status, started ? f.at(5) : null, now, current.run.id);
    testDatabase(f.store).prepare("UPDATE work_units SET status=?,started_at=?,ended_at=? WHERE id=?")
      .run(status, started ? f.at(5) : null, now, current.unit.id);
    testDatabase(f.store).prepare("UPDATE work_unit_attempts SET status=?,started_at=?,ended_at=? WHERE id=?")
      .run(status, started ? f.at(5) : null, now, current.attempt.id);
  };
  const begin: HostCapacityExtensions["begin"] = (current, record, { coverage = true } = {}) => {
    assert.equal(f.localAdmission(current, record), true);
    testDatabase(f.store).prepare("UPDATE work_units SET status='running',started_at=? WHERE id=?").run(f.at(5), current.unit.id);
    testDatabase(f.store).prepare("UPDATE work_unit_attempts SET status='started',started_at=? WHERE id=?").run(f.at(5), current.attempt.id);
    f.store.markRunStarted(current.run.id, f.at(5));
    const lifetime = deferred();
    const completion = f.store.trackHostAttemptCompletion(f.source(current), lifetime.promise, () => coverage);
    return { lifetime, completion };
  };
  const f: HostCapacityWorkspace = Object.assign(queue, { identity, journalFor, journal, bridgeFor,
    bridge: bridgeFor(journal), source, intent, reserve, consume, localAdmission, terminal, begin,
    hostSnapshot: () => host.host.database.prepare("SELECT * FROM host_run_capacity_reservations ORDER BY reservation_id").all(),
    journalSnapshot: () => ["runtime_host_capacity_intents", "runtime_host_capacity_releases"].map(table => f.rows(table)) });
  const reopen = f.reopen;
  f.reopen = (which = "store") => {
    const store = reopen(which);
    migrate(store);
    if (which === "store") { f.journal = journalFor(store); f.bridge = f.bridgeFor(); }
    return store;
  };
  return f;
}
