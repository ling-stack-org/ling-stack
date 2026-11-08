import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Worker } from "node:worker_threads";
import type { HostRunCapacityIntent, HostRunCapacityReservation, HostRunCapacityStoreOptions,
  ReleaseHostRunCapacityInput } from "../dist/host-run-capacity-types.js";
import type { HostRunCapacityStore as CapacityStore } from "../dist/storage/host-run-capacity-store.js";

type MutableIntent = { -readonly [K in keyof HostRunCapacityIntent]: HostRunCapacityIntent[K] };
type Fixture = ReturnType<typeof fixture>;
type WorkerOperation = "installPolicy" | "reserve" | "release";

const sourceUrl = new URL("../src/storage/host-run-capacity-store.ts", import.meta.url);
const source = stripTypeScriptTypes(await readFile(sourceUrl, "utf8"), { mode: "strip" });
const moduleUrl = `data:text/javascript,${encodeURIComponent(`${source}\n//# sourceURL=${sourceUrl.href}`)}`;
const { HostRunCapacityStore, createHostRunCapacityStore }:
  typeof import("../dist/storage/host-run-capacity-store.js") = await import(moduleUrl);
const now = "2026-11-04T00:00:00.000Z", later = "2026-11-04T01:00:00.000Z";
const future = "2099-12-31T23:59:59.999Z", proofDigest = "b".repeat(64);
const tables = ["host_run_capacity_schema", "host_run_capacity_policy", "host_run_capacity_reservations"];
const changes = (db: DatabaseSync) => db.prepare("SELECT total_changes() AS n").get()!.n;
const rows = (db: DatabaseSync, table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const data = (db: DatabaseSync) => tables.map(table => rows(db, table));
const ownedObjects = (db: DatabaseSync) => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'host_run_capacity_%' OR tbl_name LIKE 'host_run_capacity_%' ORDER BY type,name").all();

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-host-capacity-")));
  const globalDatabasePath = join(root, "global.sqlite"), stores: CapacityStore[] = [], peers: DatabaseSync[] = [];
  t.after(() => {
    for (const store of stores) if (store.database.isOpen) store.close();
    for (const peer of peers) if (peer.isOpen) peer.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, globalDatabasePath,
    open(options: Partial<HostRunCapacityStoreOptions> = {}) {
      const store = createHostRunCapacityStore({ globalDatabasePath, ...options });
      stores.push(store);
      return store;
    },
    peer() {
      const db = new DatabaseSync(globalDatabasePath);
      db.exec("PRAGMA busy_timeout=1");
      peers.push(db);
      return db;
    },
    intent(intentId = "intent-one", overrides: Partial<HostRunCapacityIntent> = {}): MutableIntent {
      return { intentId, workspaceKey: "workspace-one:physical-one", canonicalCwd: join(root, "workspace-one"),
        databasePath: join(root, "workspace-one", "workspace.sqlite"), databaseFileIdentity: "device:1:inode:100",
        ownerKind: "attempt", ownerKey: `attempt:${intentId}`, authorityDigest: "a".repeat(64), ...overrides };
    },
  };
}

function install(store: CapacityStore, maximum = 1, expectedRevision = 0, installedAt = now) {
  return store.installPolicy({ expectedRevision, maxConcurrentRuns: maximum, installedAt });
}

function reserve(store: CapacityStore, intent: HostRunCapacityIntent, at = now) {
  const result = store.reserve({ intent, now: at });
  assert.equal(result.status, "reserved");
  return result.reservation;
}

function releaseInput(reservation: HostRunCapacityReservation, overrides: Partial<ReleaseHostRunCapacityInput> = {}): ReleaseHostRunCapacityInput {
  return { reservationId: reservation.reservationId, token: reservation.token, intent: reservation.intent,
    kind: "stopped", proofDigest, now: later, ...overrides };
}

async function race<K extends WorkerOperation>(t: TestContext, f: Fixture,
  operations: readonly { operation: K; input: Parameters<CapacityStore[K]>[0] }[]): Promise<ReturnType<CapacityStore[K]>[]> {
  const gate = new SharedArrayBuffer(4);
  const code = `import {parentPort,workerData as d} from 'node:worker_threads';
    const {createHostRunCapacityStore}=await import(d.moduleUrl);
    const store=createHostRunCapacityStore({globalDatabasePath:d.path,busyTimeoutMs:5000});
    try {
      parentPort.postMessage({type:'ready'});
      Atomics.wait(new Int32Array(d.gate),0,0);
      parentPort.postMessage({type:'result',result:store[d.operation](d.input)});
    } finally {store.close();}`;
  const workers = operations.map(operation => {
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(code)}`), {
      workerData: { ...operation, moduleUrl, path: f.globalDatabasePath, gate },
    });
    let readyResolve!: () => void, readyReject!: (error: unknown) => void;
    let resultResolve!: (value: ReturnType<CapacityStore[K]>) => void, resultReject!: (error: unknown) => void;
    const ready = new Promise<void>((yes, no) => { readyResolve = yes; readyReject = no; });
    const result = new Promise<ReturnType<CapacityStore[K]>>((yes, no) => { resultResolve = yes; resultReject = no; });
    void result.catch(() => {});
    worker.on("message", (message: { type: "ready" } | { type: "result"; result: ReturnType<CapacityStore[K]> }) => {
      if (message.type === "ready") readyResolve();
      else if (message.type === "result") resultResolve(message.result);
    });
    worker.on("error", error => { readyReject(error); resultReject(error); });
    worker.on("exit", code => {
      if (code !== 0) { const error = new Error(`capacity worker exited ${code}`); readyReject(error); resultReject(error); }
    });
    t.after(() => worker.terminate());
    return { ready, result };
  });
  await Promise.all(workers.map(worker => worker.ready));
  Atomics.store(new Int32Array(gate), 0, 1);
  Atomics.notify(new Int32Array(gate), 0);
  return Promise.all(workers.map(worker => worker.result));
}

test("dedicated global schema preserves unrelated tables and configures its own connections", t => {
  const f = fixture(t), db = f.peer();
  db.exec(`CREATE TABLE workspaces_registry(workspace_id TEXT PRIMARY KEY,payload TEXT);
    INSERT INTO workspaces_registry VALUES('existing','keep');
    CREATE TABLE execution_engine_profiles(engine_id TEXT PRIMARY KEY,payload TEXT);
    INSERT INTO execution_engine_profiles VALUES('engine','keep-profile');
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT);
    INSERT INTO schema_migrations VALUES(900,'unrelated');`);
  const before = ["workspaces_registry", "execution_engine_profiles", "schema_migrations"].map(table => ({
    rows: rows(db, table), sql: db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table)!.sql,
  }));
  const first = f.open();
  assert.ok(first instanceof HostRunCapacityStore);
  assert.equal(first.database.prepare("PRAGMA busy_timeout").get()!.timeout, 5_000);
  assert.equal(first.database.prepare("PRAGMA journal_mode").get()!.journal_mode, "wal");
  assert.equal(first.database.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
  assert.equal(first.getPolicy(), undefined);
  assert.equal(first.reserve({ intent: f.intent(), now }).status, "unconfigured");
  assert.deepEqual(first.counts(), { held: 0, released: 0, total: 0 });
  assert.deepEqual(first.listHeld(), { reservations: [] });
  assert.deepEqual(rows(db, tables[0]).map(row => ({ ...row })), [{ version: 2, name: "host_run_capacity" }]);
  const schema = ownedObjects(db), second = f.open({ busyTimeoutMs: 23 });
  assert.equal(second.database.prepare("PRAGMA busy_timeout").get()!.timeout, 23);
  assert.equal(changes(second.database), 0, "reopening does not rewrite the schema marker");
  assert.deepEqual(ownedObjects(db), schema);
  assert.deepEqual(["workspaces_registry", "execution_engine_profiles", "schema_migrations"].map(table => ({
    rows: rows(db, table), sql: db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table)!.sql,
  })), before);
});

test("policy CAS starts at zero; same-limit duplicates preserve revision and timestamp without writes", t => {
  const f = fixture(t), store = f.open(), peer = f.open();
  assert.equal(install(store, 2, 1).status, "changed");
  assert.equal(store.getPolicy(), undefined);
  const first = install(store, 2);
  assert.deepEqual(first, { status: "installed", policy: { revision: 1, maxConcurrentRuns: 2, installedAt: now } });
  assert.equal(first.status, "installed");
  const before = changes(store.database);
  for (const revision of [0, 1, 99]) {
    assert.deepEqual(install(store, 2, revision, future), { status: "duplicate", policy: first.policy });
  }
  assert.equal(changes(store.database), before);
  assert.equal(install(peer, 3, 0).status, "changed");
  assert.deepEqual(install(peer, 3, 1, later), {
    status: "installed", policy: { revision: 2, maxConcurrentRuns: 3, installedAt: later },
  });
  assert.equal(install(store, 4, 1).status, "changed");
  assert.deepEqual(store.getPolicy(), peer.getPolicy());
  store.close();
  assert.deepEqual(f.open().getPolicy(), peer.getPolicy());
});

test("independent Workers competing on one policy revision cannot both update it", { timeout: 15_000 }, async t => {
  const f = fixture(t), store = f.open();
  install(store, 1);
  const results = await race(t, f, [2, 3].map(maxConcurrentRuns => ({ operation: "installPolicy",
    input: { expectedRevision: 1, maxConcurrentRuns, installedAt: later } })));
  assert.deepEqual(results.map(result => result.status).sort(), ["changed", "installed"]);
  assert.equal(store.getPolicy()!.revision, 2);
  const winner = results.find(result => result.status === "installed");
  assert.ok(winner && "policy" in winner);
  assert.equal(store.getPolicy()!.maxConcurrentRuns, winner.policy.maxConcurrentRuns);
});

test("reopen and peer Stores recover the same frozen credentials and copied intent", t => {
  const f = fixture(t), store = f.open();
  const installed = install(store, 2);
  assert.equal(installed.status, "installed");
  const policy = installed.policy, intent = f.intent();
  const reservation = reserve(store, intent);
  intent.ownerKey = "mutated";
  assert.equal(reservation.intent.ownerKey, "attempt:intent-one");
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(Object.isFrozen(reservation), true);
  assert.equal(Object.isFrozen(reservation.intent), true);
  assert.throws(() => {
    // @ts-expect-error Deliberately mutate the frozen public intent.
    reservation.intent.ownerKey = "forged";
  }, TypeError);
  assert.throws(() => {
    // @ts-expect-error Deliberately mutate the frozen reservation credential.
    reservation.token = "forged";
  }, TypeError);
  const peer = f.open();
  assert.deepEqual(peer.getReservation(reservation.intent.workspaceKey, reservation.intent.intentId), reservation);
  store.close();
  const reopened = f.open();
  assert.deepEqual(reopened.getReservation(reservation.intent.workspaceKey, reservation.intent.intentId), reservation);
  const before = changes(reopened.database);
  assert.deepEqual(reopened.reserve({ intent: { ...reservation.intent }, now: future }), { status: "duplicate", reservation });
  assert.equal(changes(reopened.database), before);
  assert.match(reservation.token, /^[0-9a-f]{64}$/);
});

test("all owner kinds and workspaces share one held total; exact duplicate precedes lowered-capacity rejection", t => {
  const f = fixture(t), store = f.open();
  const ownerKinds = ["attempt", "workflow_start", "delegation_spawn", "approval_resume_pending", "user_input_continuation"] as const;
  install(store, ownerKinds.length);
  const accepted = ownerKinds.map((ownerKind, index) => reserve(store,
    f.intent(`intent-${index}`, { ownerKind, workspaceKey: `workspace-${index}:physical` })));
  assert.deepEqual(store.counts(), { held: 5, released: 0, total: 5 });
  const before = data(store.database)[2];
  assert.equal(install(store, 1, 1, later).status, "installed");
  assert.deepEqual(data(store.database)[2], before, "lowering a policy never rewrites held rows");
  for (const reservation of accepted) {
    assert.deepEqual(store.reserve({ intent: reservation.intent, now: future }), { status: "duplicate", reservation });
    assert.equal(reservation.policyRevision, 1);
  }
  assert.equal(store.reserve({ intent: f.intent("new"), now: future }).status, "full");
  for (const reservation of accepted.slice(0, -1)) assert.equal(store.release(releaseInput(reservation)).status, "released");
  assert.equal(store.reserve({ intent: f.intent("new"), now: future }).status, "full", "held equal to the new cap is still full");
  assert.equal(store.release(releaseInput(accepted.at(-1)!)).status, "released");
  assert.equal(reserve(store, f.intent("new"), future).policyRevision, 2);
  assert.deepEqual(store.counts(), { held: 1, released: 5, total: 6 });
});

test("Workers contending for the final global slot admit exactly one workspace", { timeout: 15_000 }, async t => {
  const f = fixture(t), store = f.open();
  install(store, 2);
  reserve(store, f.intent("occupied"));
  const results = await race(t, f, ["left", "right"].map(label => ({ operation: "reserve",
    input: { intent: f.intent(label, { workspaceKey: `workspace-${label}:physical` }), now } })));
  assert.deepEqual(results.map(result => result.status).sort(), ["full", "reserved"]);
  assert.deepEqual(store.counts(), { held: 2, released: 0, total: 2 });
  const result = results.find(result => result.status === "reserved")!;
  assert.equal(result.status, "reserved");
  const winner = result.reservation;
  assert.deepEqual(f.open().getReservation(winner.intent.workspaceKey, winner.intent.intentId), winner);
});

test("same workspace and intent ID conflict on every changed binding, even when already full", t => {
  const f = fixture(t), store = f.open();
  install(store, 1);
  const reservation = reserve(store, f.intent());
  const variants = { canonicalCwd: join(f.root, "other"), databasePath: join(f.root, "other.sqlite"),
    databaseFileIdentity: "device:1:inode:101", ownerKind: "workflow_start", ownerKey: "different-owner",
    authorityDigest: "c".repeat(64) };
  const before = changes(store.database);
  for (const [key, value] of Object.entries(variants)) {
    assert.equal(store.reserve({ intent: { ...reservation.intent, [key]: value }, now }).status, "conflict", key);
  }
  assert.equal(changes(store.database), before);
  assert.deepEqual(store.getReservation(reservation.intent.workspaceKey, reservation.intent.intentId), reservation);
  install(store, 2, 1);
  const other = reserve(store, { ...reservation.intent, workspaceKey: "workspace-two:physical" });
  assert.notEqual(other.reservationId, reservation.reservationId);
});

test("release requires every original fence field and token, and rejects unknown release kinds", t => {
  const f = fixture(t), store = f.open();
  install(store);
  const reservation = reserve(store, f.intent()), original = data(store.database);
  for (const [key, value] of Object.entries({ intentId: "other-intent", workspaceKey: "other-workspace",
    canonicalCwd: join(f.root, "other"), databasePath: join(f.root, "other.sqlite"), databaseFileIdentity: "other-inode",
    ownerKind: "delegation_spawn", ownerKey: "other-owner", authorityDigest: "c".repeat(64) })) {
    assert.equal(store.release(releaseInput(reservation, { intent: { ...reservation.intent, [key]: value } })).status, "changed", key);
  }
  assert.equal(store.release(releaseInput(reservation, { reservationId: "unknown-reservation" })).status, "changed");
  assert.equal(store.release(releaseInput(reservation, { token: "c".repeat(64) })).status, "changed");
  assert.throws(() => store.release(releaseInput(reservation, {
    // @ts-expect-error Exercise rejection of an unsupported release kind.
    kind: "unknown",
  })), RangeError);
  assert.deepEqual(data(store.database), original);
  assert.deepEqual(store.counts(), { held: 1, released: 0, total: 1 });
});

for (const kind of ["no_dispatch", "stopped"] as const) {
  test(`${kind} release rejects time before reservation on both held and duplicate paths without writes`, t => {
    const f = fixture(t), store = f.open();
    install(store);
    const held = reserve(store, f.intent(), later), before = data(store.database), count = changes(store.database);
    const beforeReservation = "2026-11-04T00:59:59.999Z";
    for (const at of [now, beforeReservation]) {
      assert.throws(() => store.release(releaseInput(held, { kind, now: at })), RangeError);
    }
    assert.deepEqual(data(store.database), before);
    assert.equal(changes(store.database), count);
    assert.deepEqual(store.counts(), { held: 1, released: 0, total: 1 });
    const released = store.release(releaseInput(held, { kind, now: later }));
    assert.equal(released.status, "released");
    assert.equal(released.reservation.releasedAt, held.reservedAt, "equal reservation and release times are valid");
    store.close();
    const reopened = f.open(), afterRelease = data(reopened.database), reopenedCount = changes(reopened.database);
    assert.throws(() => reopened.release(releaseInput(held, { kind, now: beforeReservation })), RangeError);
    assert.deepEqual(reopened.release(releaseInput(held, { kind, now: later })), { status: "duplicate", reservation: released.reservation });
    assert.deepEqual(data(reopened.database), afterRelease);
    assert.equal(changes(reopened.database), reopenedCount);
  });

  test(`${kind} persisted release before reservation fails closed on reads and replays after reopen`, t => {
    const f = fixture(t), store = f.open();
    install(store);
    const held = reserve(store, f.intent(), later), db = f.peer();
    db.prepare(`UPDATE host_run_capacity_reservations SET state='released',released_at=?,release_kind=?,release_proof_digest=?
      WHERE reservation_id=?`).run(now, kind, proofDigest, held.reservationId);
    const before = data(db), count = changes(store.database), reopened = f.open();
    for (const connection of [store, reopened]) {
      assert.throws(() => connection.getReservation(held.intent.workspaceKey, held.intent.intentId), /host_run_capacity\.reservation_invalid/);
      assert.throws(() => connection.reserve({ intent: held.intent, now: future }), /host_run_capacity\.reservation_invalid/);
      assert.throws(() => connection.release(releaseInput(held, { kind, now: future })), /host_run_capacity\.reservation_invalid/);
    }
    assert.deepEqual(data(db), before, "invalid persisted chronology is never repaired or replayed");
    assert.equal(changes(store.database), count);
    assert.equal(changes(reopened.database), 0);
  });

  test(`${kind} release is durable and idempotent, and a released intent can never reserve again`, t => {
    const f = fixture(t), store = f.open();
    install(store);
    const held = reserve(store, f.intent()), input = releaseInput(held, { kind });
    const result = store.release(input);
    assert.equal(result.status, "released");
    assert.deepEqual(result.reservation, { ...held, state: "released", releasedAt: later, releaseKind: kind, releaseProofDigest: proofDigest });
    assert.equal(held.state, "held", "previously returned snapshots remain immutable");
    const peer = f.open(), before = changes(peer.database);
    assert.deepEqual(peer.release({ ...input, now: future }), { status: "duplicate", reservation: result.reservation });
    assert.equal(peer.release({ ...input, proofDigest: "c".repeat(64) }).status, "changed");
    assert.equal(peer.release({ ...input, kind: kind === "stopped" ? "no_dispatch" : "stopped" }).status, "changed");
    assert.deepEqual(peer.reserve({ intent: held.intent, now: future }), { status: "released", reservation: result.reservation });
    assert.equal(changes(peer.database), before);
    store.close();
    assert.deepEqual(f.open().getReservation(held.intent.workspaceKey, held.intent.intentId), result.reservation);
    assert.deepEqual(peer.counts(), { held: 0, released: 1, total: 1 });
    assert.equal(reserve(peer, f.intent("new")).state, "held");
  });
}

test("concurrent exact releases return one released and one duplicate, never a second credit", { timeout: 15_000 }, async t => {
  const f = fixture(t), store = f.open();
  install(store);
  const held = reserve(store, f.intent()), input = releaseInput(held);
  const results = await race(t, f, [0, 1].map(() => ({ operation: "release", input })));
  assert.deepEqual(results.map(result => result.status).sort(), ["duplicate", "released"]);
  assert.ok("reservation" in results[0] && "reservation" in results[1]);
  assert.deepEqual(results[0].reservation, results[1].reservation);
  assert.deepEqual(store.counts(), { held: 0, released: 1, total: 1 });
});

test("held rows have no expiry or automatic reclaim across far-future requests and reopen", t => {
  const f = fixture(t), store = f.open();
  install(store);
  const held = reserve(store, f.intent());
  assert.equal(store.reserve({ intent: f.intent("after-many-years"), now: future }).status, "full");
  store.close();
  const peer = f.open();
  assert.deepEqual(peer.getReservation(held.intent.workspaceKey, held.intent.intentId), held);
  assert.equal(peer.reserve({ intent: f.intent("after-restart"), now: future }).status, "full");
  assert.deepEqual(peer.counts(), { held: 1, released: 0, total: 1 });
  assert.deepEqual(peer.listHeld().reservations, [held]);
});

test("held keyset pagination is explicit, complete and frozen, while counts include released history", t => {
  const f = fixture(t), store = f.open();
  install(store, 64);
  const accepted = Array.from({ length: 64 }, (_, index) => reserve(store, f.intent(`page-${index}`)));
  for (const held of accepted.slice(0, 4)) store.release(releaseInput(held));
  const all: HostRunCapacityReservation[] = [], cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = store.listHeld({ ...(cursor ? { afterReservationId: cursor } : {}), limit: 7 });
    assert.ok(page.reservations.length <= 7);
    assert.equal(Object.isFrozen(page), true);
    assert.equal(Object.isFrozen(page.reservations), true);
    all.push(...page.reservations);
    cursor = page.nextCursor;
    if (cursor) { assert.equal(cursors.has(cursor), false); cursors.add(cursor); assert.equal(cursor, page.reservations.at(-1)!.reservationId); }
  } while (cursor);
  assert.equal(all.length, 60);
  assert.equal(new Set(all.map(row => row.reservationId)).size, 60);
  assert.deepEqual(all.map(row => row.reservationId), all.map(row => row.reservationId).sort());
  assert.deepEqual(all, store.listHeld().reservations);
  assert.deepEqual(store.listHeld({ afterReservationId: all.at(-1)!.reservationId }), { reservations: [] });
  assert.deepEqual(store.counts(), { held: 60, released: 4, total: 64 });
});

test("invalid inputs never mutate data or invoke accessor properties", t => {
  const f = fixture(t), store = f.open();
  install(store);
  const held = reserve(store, f.intent()), before = data(store.database), count = changes(store.database);
  const invalid = (operation: () => void) => assert.throws(operation, error => error instanceof TypeError || error instanceof RangeError);
  for (const field of Object.keys(held.intent)) {
    for (const value of [undefined, null, 1, "", " \t", "x\0y", "x\ny"]) {
      invalid(() => store.reserve({ intent: { ...held.intent, [field]: value }, now }));
    }
    const missing: Partial<HostRunCapacityIntent> = { ...held.intent }; delete missing[field as keyof HostRunCapacityIntent];
    invalid(() => store.reserve({ intent: missing as HostRunCapacityIntent, now }));
  }
  for (const intent of [null, [], new Date(), Object.create(held.intent), { ...held.intent, extra: true },
    { ...held.intent, authorityDigest: "A".repeat(64) }, { ...held.intent, authorityDigest: "a".repeat(63) },
    { ...held.intent, canonicalCwd: "relative" }, { ...held.intent, databasePath: `${f.root}/x/../data.sqlite` },
    { ...held.intent, ownerKind: "unknown" }]) invalid(() => store.reserve({ intent: intent as HostRunCapacityIntent, now }));
  let accessed = false;
  const accessor = { ...held.intent };
  Object.defineProperty(accessor, "ownerKey", { get() { accessed = true; return "forged"; } });
  invalid(() => store.reserve({ intent: accessor, now }));
  invalid(() => store.reserve({ get intent() { accessed = true; return held.intent; }, now }));
  assert.equal(accessed, false);
  invalid(() => store.reserve({ intent: { ...held.intent, [Symbol("hidden")]: true }, now }));
  for (const maxConcurrentRuns of [0, 65, 1.5, NaN, Infinity, "1", Number.MAX_SAFE_INTEGER + 1]) {
    invalid(() => store.installPolicy({ expectedRevision: 1, maxConcurrentRuns: maxConcurrentRuns as number, installedAt: now }));
  }
  for (const expectedRevision of [-1, 0.1, NaN, Infinity, "1", Number.MAX_SAFE_INTEGER + 1]) {
    invalid(() => store.installPolicy({ expectedRevision: expectedRevision as number, maxConcurrentRuns: 2, installedAt: now }));
  }
  for (const value of ["", null, "not-a-time", "2026-11-04", "2026-02-30T00:00:00.000Z", "2026-11-04T00:00:00Z"]) {
    invalid(() => store.installPolicy({ expectedRevision: 1, maxConcurrentRuns: 2, installedAt: value as string }));
    invalid(() => store.reserve({ intent: held.intent, now: value as string }));
    invalid(() => store.release(releaseInput(held, { now: value as string })));
  }
  for (const field of ["reservationId", "token", "proofDigest", "kind", "intent"]) {
    invalid(() => store.release(releaseInput(held, { [field]: null })));
  }
  for (const input of [null, [], { limit: 0 }, { limit: 1.5 }, { limit: 1001 }, { afterReservationId: "" }, { extra: true }]) {
    invalid(() => store.listHeld(input as Parameters<CapacityStore["listHeld"]>[0]));
  }
  invalid(() => store.getReservation("", held.intent.intentId));
  invalid(() => store.getReservation(held.intent.workspaceKey, ""));
  // @ts-expect-error Exercise the runtime's unknown-field validation.
  invalid(() => store.reserve({ intent: held.intent, now, extra: true }));
  // @ts-expect-error Exercise rejection of expiry-based release inputs.
  invalid(() => store.release({ ...releaseInput(held), ttl: 1 }));
  assert.deepEqual(data(store.database), before);
  assert.equal(changes(store.database), count);
});

test("persisted timestamps require canonical calendar dates beyond their SQLite shape checks", async t => {
  const invalidTime = "2026-02-30T00:00:00.000Z";
  for (const column of ["installed_at", "reserved_at", "released_at"]) {
    await t.test(column, t => {
      const f = fixture(t), store = f.open();
      install(store);
      const held = reserve(store, f.intent());
      if (column === "released_at") store.release(releaseInput(held));
      const db = f.peer(), table = column === "installed_at" ? "host_run_capacity_policy" : "host_run_capacity_reservations";
      db.prepare(`UPDATE ${table} SET ${column}=?`).run(invalidTime);
      const before = data(db), reopened = f.open();
      for (const connection of [store, reopened]) {
        if (column === "installed_at") {
          assert.throws(() => connection.getPolicy(), RangeError);
          assert.throws(() => install(connection, 2, 1), RangeError);
        } else {
          assert.throws(() => connection.getReservation(held.intent.workspaceKey, held.intent.intentId), RangeError);
          assert.throws(() => connection.reserve({ intent: held.intent, now: future }), RangeError);
          assert.throws(() => connection.release(releaseInput(held, { now: future })), RangeError);
          if (column === "reserved_at") assert.throws(() => connection.listHeld(), RangeError);
        }
      }
      assert.deepEqual(data(db), before);
    });
  }
});

test("constructor requires an explicit absolute path and validates timeout before creating a database", t => {
  const f = fixture(t);
  for (const options of [undefined, {}, null, [], { globalDatabasePath: "relative.sqlite" }, { globalDatabasePath: ":memory:" },
    { globalDatabasePath: "" }, { globalDatabasePath: `${f.root}/x/../global.sqlite` },
    ...[-1, 0.5, 60_001, NaN, "1"].map(busyTimeoutMs => ({ globalDatabasePath: f.globalDatabasePath, busyTimeoutMs }))]) {
    assert.throws(() => createHostRunCapacityStore(options as HostRunCapacityStoreOptions), error => error instanceof TypeError || error instanceof RangeError);
  }
  assert.deepEqual(ownedObjects(f.peer()), []);
});

test("SQLite CHECK and UNIQUE constraints protect the stored protocol", async t => {
  const f = fixture(t), store = f.open();
  install(store);
  const held = reserve(store, f.intent()), db = f.peer(), before = data(db);
  const invalidRows = { reservation_id: [null, "", "a\0b"], token: ["", "A".repeat(64), "a".repeat(63), Buffer.from("a".repeat(64))],
    intent_id: [null, ""], workspace_key: [null, ""], canonical_cwd: [null, ""], database_path: [null, ""],
    database_file_identity: [null, ""], owner_kind: ["unknown"], owner_key: [null, ""], authority_digest: ["A".repeat(64), "a".repeat(64) + "\0x"],
    policy_revision: [0, 1.5, 9007199254740992], reserved_at: [null, ""], state: ["unknown", "released"],
    released_at: [later], release_kind: ["stopped", "unknown"], release_proof_digest: [proofDigest] };
  for (const [column, values] of Object.entries(invalidRows)) {
    await t.test(column, () => {
      for (const value of values) assert.throws(() => db.prepare(`UPDATE host_run_capacity_reservations SET ${column}=? WHERE reservation_id=?`).run(value, held.reservationId), /constraint/i);
    });
  }
  for (const [column, values] of Object.entries({ singleton: [0, 2], revision: [0, 1.5, 9007199254740992], max_concurrent_runs: [0, 65, 1.5], installed_at: [null, ""] })) {
    for (const value of values) assert.throws(() => db.prepare(`UPDATE host_run_capacity_policy SET ${column}=?`).run(value), /constraint/i);
  }
  assert.throws(() => db.prepare(`INSERT INTO host_run_capacity_reservations SELECT 'another-reservation',token,intent_id,workspace_key,canonical_cwd,database_path,
    database_file_identity,owner_kind,owner_key,authority_digest,policy_revision,reserved_at,state,released_at,release_kind,release_proof_digest
    FROM host_run_capacity_reservations`).run(), /UNIQUE/i);
  assert.deepEqual(data(db), before);
});

test("schema marker, table, view, index and trigger tampering fail closed without repairing or deleting data", async t => {
  const mutations = {
    "deleted marker": "DELETE FROM host_run_capacity_schema",
    "wrong version": "PRAGMA ignore_check_constraints=ON; UPDATE host_run_capacity_schema SET version=3",
    "wrong marker name": "PRAGMA ignore_check_constraints=ON; UPDATE host_run_capacity_schema SET name='other'",
    "missing reservation table": "DROP TABLE host_run_capacity_reservations",
    "same-name view": "DROP TABLE host_run_capacity_policy; CREATE VIEW host_run_capacity_policy AS SELECT 1 AS singleton",
    "extra column": "ALTER TABLE host_run_capacity_reservations ADD COLUMN unexpected TEXT",
    "missing index": "DROP INDEX host_run_capacity_reservations_by_state",
    "extra index": "CREATE INDEX unexpected_capacity_index ON host_run_capacity_policy(revision)",
    "extra trigger": "CREATE TRIGGER unexpected_capacity_trigger AFTER UPDATE ON host_run_capacity_policy BEGIN SELECT 1; END",
  };
  for (const [name, sql] of Object.entries(mutations)) {
    await t.test(name, t => {
      const f = fixture(t), store = f.open();
      install(store); reserve(store, f.intent());
      const db = f.peer(); db.exec(sql);
      const before = ownedObjects(db);
      assert.throws(() => f.open(), /host_run_capacity\.schema/);
      assert.throws(() => store.getPolicy(), /host_run_capacity\.schema/);
      assert.throws(() => store.reserve({ intent: f.intent("other"), now }), /host_run_capacity\.schema/);
      assert.deepEqual(ownedObjects(db), before);
    });
  }
});

test("unmarked partial schema and same-name view collisions are never adopted", async t => {
  for (const sql of ["CREATE TABLE host_run_capacity_policy(singleton INTEGER)",
    "CREATE VIEW host_run_capacity_schema AS SELECT 1 AS version,'host_run_capacity' AS name",
    "CREATE TABLE HOST_RUN_CAPACITY_POLICY(singleton INTEGER)"]) {
    await t.test(sql, t => {
      const f = fixture(t), db = f.peer(); db.exec(sql);
      const before = ownedObjects(db);
      assert.throws(() => f.open(), /host_run_capacity\.schema/);
      assert.deepEqual(ownedObjects(db), before);
    });
  }
});

test("temporary shadows and triggers cannot replace or redirect durable Host capacity operations", async t => {
  for (const sql of [
    ...tables.map(table => `CREATE TEMP TABLE ${table} AS SELECT * FROM main.${table} WHERE 0`),
    "CREATE TEMP VIEW HOST_RUN_CAPACITY_POLICY AS SELECT 1 AS singleton",
    "CREATE TEMP TRIGGER unexpected_capacity_trigger AFTER UPDATE ON main.host_run_capacity_policy BEGIN SELECT 1; END",
  ]) {
    await t.test(sql, t => {
      const f = fixture(t), store = f.open();
      install(store);
      const held = reserve(store, f.intent()), before = data(store.database);
      store.database.exec(sql);
      for (const operation of [() => store.getPolicy(), () => install(store, 2, 1),
        () => store.reserve({ intent: f.intent("second"), now }), () => store.release(releaseInput(held)),
        () => store.getReservation(held.intent.workspaceKey, held.intent.intentId), () => store.listHeld(), () => store.counts()]) {
        assert.throws(operation, /host_run_capacity\.schema/);
      }
      const peer = f.open();
      assert.deepEqual(data(peer.database), before, "main database rows remain unchanged");
      assert.deepEqual(peer.counts(), { held: 1, released: 0, total: 1 });
    });
  }
});

test("schema installation rolls back its own partial DDL and leaves unrelated global rows intact", t => {
  const f = fixture(t), db = f.peer();
  db.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('keep')");
  const exec = DatabaseSync.prototype.exec;
  let observed = false;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql.startsWith("CREATE INDEX host_run_capacity_reservations_by_state")) {
      observed = this.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='host_run_capacity_reservations'").get()!.n === 1;
      throw new Error("injected schema write failure");
    }
    return exec.call(this, sql);
  });
  assert.throws(() => f.open(), /injected schema write failure/);
  assert.equal(observed, true, "the transaction already created its reservation table before failing");
  assert.deepEqual(ownedObjects(db), []);
  assert.equal(db.prepare("SELECT value FROM sentinel").get()!.value, "keep");
});

test("policy, reservation and release writes roll back on commit failure", async t => {
  for (const operation of ["policy", "reserve", "release"]) {
    await t.test(operation, t => {
      const f = fixture(t), store = f.open();
      install(store, 2);
      const held = reserve(store, f.intent()), before = data(store.database), exec = store.database.exec.bind(store.database);
      let observed = false, armed = true;
      t.mock.method(store.database, "exec", (sql: string) => {
        if (sql === "COMMIT" && armed) {
          armed = false;
          if (operation === "policy") observed = store.getPolicy()!.revision === 2;
          else if (operation === "reserve") observed = store.getReservation(held.intent.workspaceKey, "second")?.state === "held";
          else observed = store.getReservation(held.intent.workspaceKey, held.intent.intentId)?.state === "released";
          throw new Error("injected commit failure");
        }
        return exec(sql);
      });
      const action = operation === "policy" ? () => install(store, 3, 1)
        : operation === "reserve" ? () => store.reserve({ intent: f.intent("second"), now })
          : () => store.release(releaseInput(held));
      assert.throws(action, /injected commit failure/);
      assert.equal(observed, true, "real SQLite writes were visible inside the owned transaction");
      assert.deepEqual(data(store.database), before);
      assert.deepEqual(f.open().counts(), { held: 1, released: 0, total: 1 });
      assert.equal(action().status, operation === "policy" ? "installed" : operation === "reserve" ? "reserved" : "released");
    });
  }
});

test("failed nested operations never commit or roll back caller transactions without isTransaction", async t => {
  for (const finish of ["COMMIT", "ROLLBACK"]) {
    await t.test(finish, t => {
      const f = fixture(t), store = f.open({ busyTimeoutMs: 1 }), peer = f.peer();
      install(store, 2);
      const held = reserve(store, f.intent()), before = data(store.database);
      store.database.exec("CREATE TABLE transaction_sentinel(value TEXT); INSERT INTO transaction_sentinel VALUES('before')");
      const database = store.database;
      // @ts-expect-error Deliberately replace the readonly fixture connection to hide transaction metadata.
      store.database = new Proxy(Object.create(null) as DatabaseSync, {
        get(_target, key) {
          if (key === "isTransaction") return undefined;
          const value = Reflect.get(database, key, database);
          return typeof value === "function" ? value.bind(database) : value;
        },
      });
      assert.equal(store.database.isTransaction, undefined);
      store.database.exec("BEGIN IMMEDIATE");
      try {
        store.database.exec("UPDATE transaction_sentinel SET value='pending'");
        for (const operation of [() => install(store, 3, 1), () => store.reserve({ intent: f.intent("second"), now }),
          () => store.release(releaseInput(held))]) assert.throws(operation, /transaction/i);
        assert.equal(store.database.prepare("SELECT value FROM transaction_sentinel").get()!.value, "pending");
        assert.equal(peer.prepare("SELECT value FROM transaction_sentinel").get()!.value, "before", "the caller's transaction was not committed");
        assert.throws(() => peer.exec("BEGIN IMMEDIATE"), /locked|busy/i);
        assert.deepEqual(data(store.database), before);
        store.database.exec(finish);
      } catch (error) { try { store.database.exec("ROLLBACK"); } catch {} throw error; }
      assert.equal(peer.prepare("SELECT value FROM transaction_sentinel").get()!.value, finish === "COMMIT" ? "pending" : "before");
    });
  }
});

test("busy write failure does not mutate either connection or release another writer's lock", t => {
  const f = fixture(t), store = f.open({ busyTimeoutMs: 1 }), peer = f.peer();
  install(store);
  peer.exec("BEGIN IMMEDIATE");
  try {
    assert.throws(() => store.reserve({ intent: f.intent(), now }), /locked|busy/i);
    assert.deepEqual(store.counts(), { held: 0, released: 0, total: 0 });
    assert.throws(() => f.open({ busyTimeoutMs: 1 }), /locked|busy/i);
    assert.throws(() => store.database.exec("BEGIN IMMEDIATE"), /locked|busy/i);
  } finally { peer.exec("ROLLBACK"); }
  assert.equal(reserve(store, f.intent()).state, "held");
});
