import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Worker } from "node:worker_threads";
import { createHostRunCapacityStore } from "../dist/storage/host-run-capacity-store.js";
import type { HostRunCapacityIntent } from "../dist/host-run-capacity-types.js";

const marker = "host_run_capacity_schema", policy = "host_run_capacity_policy", reservations = "host_run_capacity_reservations";
const index = "host_run_capacity_reservations_by_state", tables = [marker, policy, reservations];
const now = "2026-11-07T00:00:00.000Z", later = "2026-11-07T01:00:00.000Z";
const text = (column: string) => `typeof(${column})='text' AND length(trim(${column}))>0 AND instr(${column},char(0))=0`;
const digest = (column: string) => `typeof(${column})='text' AND length(${column})=64 AND ${column} NOT GLOB '*[^0-9a-f]*' AND instr(${column},char(0))=0`;
const time = (column: string) => `${text(column)} AND length(${column})=24 AND ${column} GLOB '????-??-??T??:??:??.???Z'`;
const integer = (column: string, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) =>
  `typeof(${column})='integer' AND ${column} BETWEEN ${minimum} AND ${maximum}`;
// Version 1 is a frozen predecessor contract, independent of the current Store's definitions.
const legacySchema = [
  `CREATE TABLE ${marker} (
    version INTEGER PRIMARY KEY NOT NULL CHECK(${integer("version", 1, 1)}),
    name TEXT NOT NULL UNIQUE CHECK(name='host_run_capacity')
  )`,
  `CREATE TABLE ${policy} (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK(${integer("singleton", 1, 1)}),
    revision INTEGER NOT NULL CHECK(${integer("revision")}),
    max_concurrent_runs INTEGER NOT NULL CHECK(${integer("max_concurrent_runs", 1, 64)}),
    installed_at TEXT NOT NULL CHECK(${time("installed_at")})
  )`,
  `CREATE TABLE ${reservations} (
    reservation_id TEXT PRIMARY KEY NOT NULL CHECK(${text("reservation_id")}),
    token TEXT NOT NULL UNIQUE CHECK(${digest("token")}),
    intent_id TEXT NOT NULL CHECK(${text("intent_id")}),
    workspace_key TEXT NOT NULL CHECK(${text("workspace_key")}),
    canonical_cwd TEXT NOT NULL CHECK(${text("canonical_cwd")}),
    database_path TEXT NOT NULL CHECK(${text("database_path")}),
    database_file_identity TEXT NOT NULL CHECK(${text("database_file_identity")}),
    owner_kind TEXT NOT NULL CHECK(owner_kind IN ('attempt','workflow_start','delegation_spawn')),
    owner_key TEXT NOT NULL CHECK(${text("owner_key")}),
    authority_digest TEXT NOT NULL CHECK(${digest("authority_digest")}),
    policy_revision INTEGER NOT NULL CHECK(${integer("policy_revision")}),
    reserved_at TEXT NOT NULL CHECK(${time("reserved_at")}),
    state TEXT NOT NULL CHECK(state IN ('held','released')),
    released_at TEXT CHECK(released_at IS NULL OR (${time("released_at")})),
    release_kind TEXT CHECK(release_kind IS NULL OR release_kind IN ('no_dispatch','stopped')),
    release_proof_digest TEXT CHECK(release_proof_digest IS NULL OR (${digest("release_proof_digest")})),
    UNIQUE(workspace_key,intent_id),
    CHECK((state='held' AND released_at IS NULL AND release_kind IS NULL AND release_proof_digest IS NULL)
      OR (state='released' AND released_at IS NOT NULL AND release_kind IS NOT NULL AND release_proof_digest IS NOT NULL))
  )`,
  `CREATE INDEX ${index} ON ${reservations}(state,reservation_id)`,
];
const rows = (db: DatabaseSync, table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const snapshot = (db: DatabaseSync) => {
  const objects = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
  return { objects, data: Object.fromEntries(objects.filter(row => row.type === "table").map(row => [String(row.name), rows(db, String(row.name))])) };
};

function fixture(t: TestContext, { populated = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-global-host-upgrade-"))), globalDatabasePath = join(root, "global.sqlite");
  const db = new DatabaseSync(globalDatabasePath), stores: ReturnType<typeof createHostRunCapacityStore>[] = [];
  t.after(() => { for (const store of stores) if (store.database.isOpen) store.close(); if (db.isOpen) db.close(); rmSync(root, { recursive: true, force: true }); });
  for (const definition of legacySchema) db.exec(definition);
  db.exec(`INSERT INTO ${marker} VALUES(1,'host_run_capacity');
    CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('keep');
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT); INSERT INTO schema_migrations VALUES(900,'unrelated');`);
  const intent = (id: string, ownerKind: HostRunCapacityIntent["ownerKind"] = "attempt"): HostRunCapacityIntent => ({ intentId: id,
    workspaceKey: `workspace:${id}`, canonicalCwd: join(root, `workspace-${id}`), databasePath: join(root, id, "workspace.sqlite"),
    databaseFileIdentity: `file:${id}`, ownerKind, ownerKey: `owner:${id}`, authorityDigest: "a".repeat(64) });
  if (populated) {
    db.prepare(`INSERT INTO ${policy} VALUES(1,7,2,?)`).run(now);
    for (const [id, ownerKind, state] of [["held", "attempt", "held"], ["released", "workflow_start", "released"]] as const) {
      const i = intent(id, ownerKind);
      db.prepare(`INSERT INTO ${reservations} VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`reservation:${id}`, (state === "held" ? "b" : "c").repeat(64),
        i.intentId, i.workspaceKey, i.canonicalCwd, i.databasePath, i.databaseFileIdentity, i.ownerKind, i.ownerKey, i.authorityDigest, 6, now, state,
        state === "held" ? null : later, state === "held" ? null : "stopped", state === "held" ? null : "d".repeat(64));
    }
  }
  return { db, globalDatabasePath, intent, open() {
    const store = createHostRunCapacityStore({ globalDatabasePath, busyTimeoutMs: 5000 }); stores.push(store); return store;
  } };
}

test("global v1 upgrade preserves credentials, held/released history, policy revisions and unrelated rows, then reopens read-only", t => {
  const f = fixture(t), before = snapshot(f.db), store = f.open();
  assert.deepEqual(rows(f.db, reservations), before.data[reservations]);
  assert.deepEqual(rows(f.db, policy), before.data[policy]);
  assert.deepEqual(rows(f.db, "schema_migrations"), before.data.schema_migrations);
  assert.deepEqual(rows(f.db, "sentinel"), before.data.sentinel);
  assert.deepEqual(rows(f.db, marker).map(row => ({ ...row })), [{ version: 2, name: "host_run_capacity" }]);
  assert.deepEqual(store.getPolicy(), { revision: 7, maxConcurrentRuns: 2, installedAt: now });
  assert.deepEqual(store.counts(), { held: 1, released: 1, total: 2 });
  assert.equal(store.database.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
  const held = store.getReservation("workspace:held", "held")!, released = store.getReservation("workspace:released", "released")!;
  assert.equal(held.token, "b".repeat(64)); assert.equal(held.policyRevision, 6);
  assert.equal(released.releaseProofDigest, "d".repeat(64));
  assert.equal(store.reserve({ intent: f.intent("held"), now: later }).status, "duplicate");
  assert.equal(store.reserve({ intent: f.intent("released", "workflow_start"), now: later }).status, "released");
  const after = snapshot(f.db), peer = f.open();
  assert.equal(peer.database.prepare("SELECT total_changes() AS n").get()!.n, 0);
  assert.deepEqual(snapshot(f.db), after);
  assert.deepEqual(peer.getReservation("workspace:held", "held"), held);
  assert.deepEqual(peer.getReservation("workspace:released", "released"), released);
  const approval = store.reserve({ intent: f.intent("approval", "approval_resume_pending"), now: later });
  assert.equal(approval.status, "reserved");
  assert.equal(approval.reservation.policyRevision, 7);
  assert.equal(store.reserve({ intent: f.intent("answer", "user_input_continuation"), now: later }).status, "full");
  assert.equal(store.release({ reservationId: held.reservationId, token: held.token, intent: held.intent,
    kind: "stopped", proofDigest: "e".repeat(64), now: later }).status, "released");
  assert.equal(peer.reserve({ intent: f.intent("answer", "user_input_continuation"), now: later }).status, "reserved");
  assert.deepEqual(store.counts(), { held: 2, released: 2, total: 4 });
});

test("global v1 with only its schema upgrades without manufacturing a policy or reservation", t => {
  const f = fixture(t, { populated: false }), store = f.open();
  assert.equal(store.getPolicy(), undefined);
  assert.deepEqual(store.counts(), { held: 0, released: 0, total: 0 });
  assert.equal(store.reserve({ intent: f.intent("answer", "user_input_continuation"), now }).status, "unconfigured");
  assert.deepEqual(rows(f.db, marker).map(row => row.version), [2]);
});

test("global upgrade rejects corrupt markers, mixed schemas, unmarked data and unexpected objects without repairs", async t => {
  const mutations = {
    "unmarked populated": `DELETE FROM ${marker}`,
    "bad marker name": `PRAGMA ignore_check_constraints=ON; UPDATE ${marker} SET name='foreign'`,
    "bad marker version": `PRAGMA ignore_check_constraints=ON; UPDATE ${marker} SET version=2`,
    "duplicate markers": `PRAGMA ignore_check_constraints=ON; INSERT INTO ${marker} VALUES(2,'foreign')`,
    "missing table": `DROP TABLE ${reservations}`,
    "unexpected column": `ALTER TABLE ${reservations} ADD COLUMN foreign_column TEXT`,
    "missing index": `DROP INDEX ${index}`,
    "extra index": `CREATE INDEX foreign_host_index ON ${reservations}(owner_key)`,
    "extra trigger": `CREATE TRIGGER foreign_host_trigger AFTER INSERT ON ${reservations} BEGIN SELECT 1; END`,
    "replacement collision": "CREATE TABLE host_run_capacity_reservations_upgrade(value TEXT); INSERT INTO host_run_capacity_reservations_upgrade VALUES('keep')",
  };
  for (const [name, sql] of Object.entries(mutations)) await t.test(name, t => {
    const f = fixture(t); f.db.exec(sql);
    const before = snapshot(f.db);
    assert.throws(() => f.open(), /host_run_capacity\.schema|already exists/u);
    assert.deepEqual(snapshot(f.db), before);
  });
  for (const populated of [false, true]) await t.test(`mixed owner schema/${populated}`, t => {
    const f = fixture(t, { populated });
    const data = rows(f.db, reservations);
    f.db.exec(`DROP TABLE ${reservations}`);
    f.db.exec(legacySchema[2].replace("'delegation_spawn'", "'delegation_spawn','approval_resume_pending','user_input_continuation'"));
    f.db.exec(legacySchema[3]);
    for (const row of data) f.db.prepare(`INSERT INTO ${reservations} VALUES(${Object.keys(row).map(() => "?").join(",")})`)
      .run(...Object.values(row) as SQLInputValue[]);
    const before = snapshot(f.db);
    assert.throws(() => f.open(), /host_run_capacity\.schema/u);
    assert.deepEqual(snapshot(f.db), before);
  });
  await t.test("unmarked empty", t => {
    const f = fixture(t, { populated: false }); f.db.exec(`DELETE FROM ${marker}`);
    const before = snapshot(f.db); assert.throws(() => f.open(), /host_run_capacity\.schema/u); assert.deepEqual(snapshot(f.db), before);
  });
});

test("global upgrade rolls back copied tables, credentials, marker and index on DDL/postcondition/COMMIT faults", async t => {
  for (const fault of ["create", "copy", "drop", "rename", "marker", "index", "postcondition", "commit"]) await t.test(fault, t => {
    const f = fixture(t), before = snapshot(f.db), exec = DatabaseSync.prototype.exec;
    let reached = false;
    const mock = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      if (fault === "commit" && sql === "COMMIT") { reached = true; throw new Error("injected-global-upgrade-failure"); }
      const result = exec.call(this, sql);
      if ((fault === "create" && sql.startsWith("CREATE TABLE host_run_capacity_reservations_upgrade"))
        || (fault === "copy" && sql.startsWith("INSERT INTO host_run_capacity_reservations_upgrade"))
        || (fault === "drop" && sql === `DROP TABLE main.${reservations}`)
        || (fault === "rename" && sql.startsWith("ALTER TABLE host_run_capacity_reservations_upgrade"))
        || (fault === "marker" && sql.startsWith("ALTER TABLE host_run_capacity_schema_upgrade"))
        || (fault === "index" && sql.startsWith(`CREATE INDEX ${index}`))) {
        reached = true; throw new Error("injected-global-upgrade-failure");
      }
      if (fault === "postcondition" && sql.startsWith(`CREATE INDEX ${index}`)) {
        reached = true; this.prepare(`DELETE FROM ${marker}`).run();
      }
      return result;
    });
    try { assert.throws(() => f.open(), /injected-global-upgrade-failure|host_run_capacity\.schema/u); }
    finally { mock.mock.restore(); }
    assert.equal(reached, true);
    assert.deepEqual(snapshot(f.db), before);
    assert.deepEqual(f.open().counts(), { held: 1, released: 1, total: 2 });
  });
});

test("global upgrade waits for a competing DELETE-mode writer before switching to WAL", { timeout: 15_000 }, async t => {
  const f = fixture(t), before = snapshot(f.db), lockGate = new SharedArrayBuffer(4);
  const moduleUrl = new URL("../dist/storage/host-run-capacity-store.js", import.meta.url).href;
  f.db.exec("BEGIN IMMEDIATE");
  const source = `import {parentPort,workerData as d} from 'node:worker_threads';
    import {DatabaseSync} from 'node:sqlite';
    import {createHostRunCapacityStore} from ${JSON.stringify(moduleUrl)};
    const exec=DatabaseSync.prototype.exec; let observed=false;
    DatabaseSync.prototype.exec=function(sql){
      try{return exec.call(this,sql);}catch(error){
        if(!observed && sql.includes('journal_mode=WAL') && error.errcode===5){
          observed=true; parentPort.postMessage({type:'blocked'}); Atomics.wait(new Int32Array(d.gate),0,0);
        }
        throw error;
      }
    };
    const store=createHostRunCapacityStore({globalDatabasePath:d.path});
    try{parentPort.postMessage({type:'result',counts:store.counts(),observed,
      mode:store.database.prepare('PRAGMA journal_mode').get().journal_mode,
      timeout:store.database.prepare('PRAGMA busy_timeout').get().timeout});}finally{store.close();}`;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), {
    workerData: { gate: lockGate, path: f.globalDatabasePath },
  });
  const exited = new Promise<void>((resolve, reject) => {
    worker.on("error", reject);
    worker.on("exit", code => code === 0 ? resolve() : reject(new Error(`WAL upgrade worker exited ${code}`)));
  });
  void exited.catch(() => {});
  t.after(async () => {
    if (f.db.isOpen && f.db.isTransaction) f.db.exec("ROLLBACK");
    Atomics.store(new Int32Array(lockGate), 0, 1); Atomics.notify(new Int32Array(lockGate), 0);
    await worker.terminate();
  });
  const result = await new Promise<{ counts: unknown; observed: boolean; mode: string; timeout: number }>((resolve, reject) => {
    worker.on("message", message => {
      if (message.type === "blocked") {
        assert.deepEqual(snapshot(f.db), before);
        f.db.exec("ROLLBACK");
        Atomics.store(new Int32Array(lockGate), 0, 1); Atomics.notify(new Int32Array(lockGate), 0);
      } else if (message.type === "result") resolve(message);
    });
    worker.on("error", reject);
    worker.on("exit", code => { if (code !== 0) reject(new Error(`WAL upgrade worker exited ${code}`)); });
  });
  await exited;
  assert.equal(result.observed, true);
  assert.equal(result.mode, "wal");
  assert.equal(result.timeout, 5_000);
  assert.deepEqual(result.counts, { held: 1, released: 1, total: 2 });
  assert.deepEqual(rows(f.db, reservations), before.data[reservations]);
});

test("global upgrade preserves the predecessor when a WAL lock exceeds the configured budget", t => {
  const f = fixture(t), before = snapshot(f.db);
  f.db.exec("BEGIN IMMEDIATE");
  try {
    assert.throws(() => createHostRunCapacityStore({ globalDatabasePath: f.globalDatabasePath, busyTimeoutMs: 0 }),
      (error: unknown) => error instanceof Error && "errcode" in error && error.errcode === 5);
    assert.equal(f.db.isTransaction, true);
    assert.deepEqual(snapshot(f.db), before);
  } finally { f.db.exec("ROLLBACK"); }
  assert.deepEqual(f.open().counts(), { held: 1, released: 1, total: 2 });
});

test("independent workers upgrading v1 admit only one continuation into the last shared slot", { timeout: 15_000 }, async t => {
  const f = fixture(t), gate = new SharedArrayBuffer(4);
  const moduleUrl = new URL("../dist/storage/host-run-capacity-store.js", import.meta.url).href;
  const workers = (["approval_resume_pending", "user_input_continuation"] as const).map(ownerKind => {
    const source = `import {parentPort,workerData as d} from 'node:worker_threads';
      import {createHostRunCapacityStore} from ${JSON.stringify(moduleUrl)};
      parentPort.postMessage({type:'ready'}); Atomics.wait(new Int32Array(d.gate),0,0);
      const store=createHostRunCapacityStore({globalDatabasePath:d.path});
      try {parentPort.postMessage({type:'result',status:store.reserve({intent:d.intent,now:d.now}).status});}
      finally {store.close();}`;
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), {
      workerData: { gate, path: f.globalDatabasePath, now, intent: f.intent(ownerKind, ownerKind) },
    });
    t.after(() => worker.terminate());
    let readyResolve!: () => void, readyReject!: (error: unknown) => void;
    let resultResolve!: (status: string) => void, resultReject!: (error: unknown) => void;
    const ready = new Promise<void>((yes, no) => { readyResolve = yes; readyReject = no; });
    const result = new Promise<string>((yes, no) => { resultResolve = yes; resultReject = no; });
    void result.catch(() => {});
    worker.on("message", (message: { type: string; status: string }) => {
      if (message.type === "ready") readyResolve(); else if (message.type === "result") resultResolve(message.status);
    });
    worker.on("error", error => { readyReject(error); resultReject(error); });
    worker.on("exit", code => { if (code !== 0) { const error = new Error(`upgrade worker exited ${code}`); readyReject(error); resultReject(error); } });
    return { ready, result };
  });
  await Promise.all(workers.map(worker => worker.ready));
  Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
  assert.deepEqual((await Promise.all(workers.map(worker => worker.result))).sort(), ["full", "reserved"]);
  assert.deepEqual(f.open().counts(), { held: 2, released: 1, total: 3 });
  assert.deepEqual(rows(f.db, marker).map(row => row.version), [2]);
});
