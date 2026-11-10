import assert from "node:assert/strict";
import test from "node:test";
import { AttemptExecutorGroup, readOriginalAttemptExecutorGroupSnapshot, settleOriginalAttemptExecutorGroupHostCall }
  from "../dist/runtime/attempt-execution-quiescence.js";
import { AttemptHostOperationTracker, closeOriginalAttemptHostOfficeLocalDirectoryWindowV2,
  settleOriginalAttemptHostOfficeLocalDirectoryFromStoreV2, bindOriginalAttemptHostOfficeDirectoryLeaseRequirementV2 }
  from "../dist/runtime/attempt-host-operation-tracker.js";
import { officeDirectoryTrackerFixture, requiredOfficeDirectoryInput as required }
  from "./support/attempt-host-office-directory-v2-fixture.mjs";
import { officeDirectoryTrackerSettlementFixture } from "./support/attempt-host-office-directory-v2-settlement-fixture.mjs";

// Real Core/Tracker authority and SQLite readback, but explicit virtual native
// history and Host endpoint fixtures. These are mechanism tests, not genuine
// Registry/native/product/packaged acceptance or a test permit mint seam.
const code = expected => error => error?.code === expected;
const trackerCode = expected => code(`attempt_host_operation_${expected}`);
const groupCode = expected => code(`attempt_execution_${expected}`);
const snapshot = f => readOriginalAttemptExecutorGroupSnapshot(f.group);
const states = f => snapshot(f).operations.map(row => row.state);
const member = (f, handle) => snapshot(f).operations.find(row => row.ticket.id === handle.operationId);
const proof = (f, handle, digest = "a".repeat(64), at = f.now()) => Object.freeze({ schemaVersion: 1, source: f.source,
  operationId: handle.operationId, evidenceRef: `host_operation:${handle.operationId}:${digest}`, settledAt: at,
  kind: "completed_persisted", physicalScope: "entire_operation", effects: "persisted" });
function assertNoLocalSafe(f) { assert.ok(snapshot(f).operations.every(row => row.state !== "settled")); }

test("V2 caches the original close claim and settles only the fixed committed canonical pair", async t => {
  const f = await officeDirectoryTrackerSettlementFixture(t), before = f.counts.invocations;
  const claim = f.tracker.closeOfficeLocalDirectoryWindowV2(f.ticket);
  assert.ok(Object.isFrozen(claim)); assert.deepEqual(Reflect.ownKeys(claim), []);
  assert.equal(f.tracker.closeOfficeLocalDirectoryWindowV2(f.ticket), claim);
  assert.equal(f.counts.close, 1); assert.deepEqual(states(f), ["launched", "launched"]);
  f.group.closeAdmission(required);
  const publicRead = t.mock.method(f.store, "getHostOperation", () => assert.fail("V2 must not read a public Host getter"));
  const pair = f.tracker.settleOfficeLocalDirectoryFromStoreV2(f.ticket);
  assert.equal(publicRead.mock.callCount(), 0);
  assert.deepEqual(pair, { parent: f.pairRows()[0], producer: f.pairRows()[1] });
  assert.deepEqual(states(f), ["settled", "settled"]);
  assert.equal(pair.parent.settlementKind, "office_local_chain_completed");
  assert.equal(pair.producer.settlementKind, "office_local_binary_completed");
  for (const [handle, row] of [[f.parent, pair.parent], [f.producer, pair.producer]]) {
    assert.deepEqual(member(f, handle).settlement, proof(f, handle, row.evidenceDigest, row.settledAt));
  }
  const counts = { ...f.counts }; f.retire();
  assert.equal(f.tracker.closeOfficeLocalDirectoryWindowV2(f.ticket), claim);
  assert.deepEqual(f.tracker.settleOfficeLocalDirectoryFromStoreV2(f.ticket), pair);
  assert.deepEqual(f.counts, counts, "committed retry must not call Host close/current proof or replay any invocation");
  assert.equal(f.counts.invocations, before);
  assert.equal((await f.group.observeDrain(0)).status, "settled");
});

for (const target of ["instance", "prototype"]) {
  test(`fixed original V2 entries ignore ${target} public close/settle no-ops and close actual local barriers`, async t => {
    const f = await officeDirectoryTrackerSettlementFixture(t), replaced = target === "instance" ? f.tracker : AttemptHostOperationTracker.prototype;
    const close = t.mock.method(replaced, "closeOfficeLocalDirectoryWindowV2", () => assert.fail("fixed close cannot consult a public method"));
    const settle = t.mock.method(replaced, "settleOfficeLocalDirectoryFromStoreV2", () => ({ parent: f.pairRows()[0], producer: f.pairRows()[1] }));
    const claim = closeOriginalAttemptHostOfficeLocalDirectoryWindowV2(f.tracker, f.ticket);
    assert.ok(claim); f.store.settleHostOfficeLocalDirectoryExecutionV2(f.ticket);
    assert.deepEqual(states(f), ["launched", "launched"], "Core safe alone does not close these real local members");
    const pair = settleOriginalAttemptHostOfficeLocalDirectoryFromStoreV2(f.tracker, f.ticket);
    assert.equal(pair.parent.phase, "safe"); assert.equal(pair.producer.phase, "safe"); assert.deepEqual(states(f), ["settled", "settled"]);
    assert.deepEqual([close.mock.callCount(), settle.mock.callCount()], [0, 0]);
  });
}

test("fixed V2 entries reject unowned trackers and fake production lease authorities", async t => {
  const f = await officeDirectoryTrackerSettlementFixture(t, { complete: false });
  for (const tracker of [Object.freeze({ ...f.tracker }), new Proxy(f.tracker, {}), Object.create(AttemptHostOperationTracker.prototype), undefined]) {
    assert.throws(() => closeOriginalAttemptHostOfficeLocalDirectoryWindowV2(tracker, f.ticket), trackerCode("invalid_tracker"));
    assert.throws(() => settleOriginalAttemptHostOfficeLocalDirectoryFromStoreV2(tracker, f.ticket), trackerCode("invalid_tracker"));
    assert.throws(() => bindOriginalAttemptHostOfficeDirectoryLeaseRequirementV2(tracker, f.ticket, Object.freeze({})), trackerCode("invalid_tracker"));
  }
  assert.throws(() => bindOriginalAttemptHostOfficeDirectoryLeaseRequirementV2(f.tracker, f.ticket, f.authority),
    /office_local_directory_core_composition_invalid/u, "an explicit mechanism endpoint is not production native lease custody");
  assertNoLocalSafe(f);
});

test("V2 close/settlement reject foreign, cloned, Proxy and real V1 tickets", async t => {
  const f = await officeDirectoryTrackerSettlementFixture(t, { complete: false });
  const foreign = await officeDirectoryTrackerSettlementFixture(t, { complete: false });
  const v1 = await officeDirectoryTrackerFixture(t, { version: 1 });
  for (const ticket of [foreign.ticket, { ...f.ticket }, Object.create(f.ticket), new Proxy(f.ticket, {}), v1.ticket, undefined]) {
    assert.throws(() => f.tracker.closeOfficeLocalDirectoryWindowV2(ticket), trackerCode("invalid_office_ticket"));
    assert.throws(() => f.tracker.settleOfficeLocalDirectoryFromStoreV2(ticket), trackerCode("invalid_office_ticket"));
  }
  assert.throws(() => v1.tracker.closeOfficeLocalDirectoryWindowV2(v1.ticket), trackerCode("invalid_office_ticket"));
  assert.throws(() => v1.tracker.settleOfficeLocalDirectoryFromStoreV2(v1.ticket), trackerCode("invalid_office_ticket"));
  assert.equal(f.counts.close, 0); assertNoLocalSafe(f);
});

test("V2 settlement without its retained close claim does not consult Store settlement or public getters", async t => {
  const f = await officeDirectoryTrackerSettlementFixture(t);
  const settlement = t.mock.method(f.store, "settleHostOfficeLocalDirectoryExecutionV2", () => assert.fail("missing close claim must refuse before Core settlement"));
  const getter = t.mock.method(f.store, "getHostOperation", () => assert.fail("public getter cannot provide an original claim"));
  assert.throws(() => f.tracker.settleOfficeLocalDirectoryFromStoreV2(f.ticket), trackerCode("office_directory_close_claim_missing"));
  assert.deepEqual([settlement.mock.callCount(), getter.mock.callCount()], [0, 0]);
  assert.deepEqual(states(f), ["launched", "launched"]);
});

test("V2 members cannot accept fake public safe rows through generic or direct group settlement", async t => {
  const f = await officeDirectoryTrackerSettlementFixture(t), rows = f.pairRows();
  const forgedAt = f.now(), forgedDigest = "a".repeat(64);
  const getter = t.mock.method(f.store, "getHostOperation", id => {
    const row = rows.find(value => value.operationId === id);
    return { ...row, phase: "safe", evidenceDigest: forgedDigest, settledAt: forgedAt,
      settlementKind: row.kind === "mcp" ? "office_local_chain_completed" : "office_local_binary_completed" };
  });
  for (const handle of [f.parent, f.producer]) {
    assert.throws(() => f.tracker.settleFromStore(handle), trackerCode("settlement_unconfirmed"));
    assert.throws(() => settleOriginalAttemptExecutorGroupHostCall(f.group, member(f, handle).ticket,
      proof(f, handle, forgedDigest, forgedAt)), groupCode("unverified_settlement"));
  }
  assert.equal(getter.mock.callCount(), 0);
  assert.throws(() => f.tracker.settleOfficeLocalFromStore(f.ticket), trackerCode("invalid_office_ticket"));
  assertNoLocalSafe(f); assert.ok(f.pairRows().every(row => row.phase === "launched"));
});

for (const injection of ["owner preflight", "prepare", "prepare return-loss"]) {
  test(`V2 reservation blocks V1/public getter fallback during ${injection}`, async t => {
    const f = await officeDirectoryTrackerFixture(t, { prepare: false }), realRows = f.pairRows();
    const forgedAt = f.now(), forgedDigest = "a".repeat(64);
    let entered = 0;
    const getter = t.mock.method(f.store, "getHostOperation", id => {
      const row = realRows.find(value => value.operationId === id);
      return { ...row, phase: "safe", evidenceDigest: forgedDigest, launchedAt: forgedAt, settledAt: forgedAt,
        evidenceRef: { kind: row.kind === "mcp" ? "office_local_chain_execution" : "office_local_binary_execution", id: f.input.executionId },
        settlementKind: row.kind === "mcp" ? "office_local_chain_completed" : "office_local_binary_completed" };
    });
    const reenter = () => {
      entered++;
      for (const handle of [f.parent, f.producer]) {
        assert.throws(() => f.tracker.settleFromStore(handle), trackerCode("settlement_unconfirmed"));
        assert.throws(() => settleOriginalAttemptExecutorGroupHostCall(f.group, member(f, handle).ticket,
          proof(f, handle, forgedDigest, forgedAt)), groupCode("unverified_settlement"));
      }
    };
    const original = injection === "owner preflight" ? f.store.isCurrentRunExecutionOwner.bind(f.store)
      : f.store.prepareHostOfficeLocalDirectoryExecutionV2.bind(f.store);
    const patch = injection === "owner preflight" ? t.mock.method(f.store, "isCurrentRunExecutionOwner", (...args) => {
      if (entered === 0) reenter(); return original(...args);
    }) : t.mock.method(f.store, "prepareHostOfficeLocalDirectoryExecutionV2", (...args) => {
      const ticket = original(...args); reenter();
      if (injection === "prepare return-loss") throw new Error("original V2 preparation return lost");
      return ticket;
    });
    if (injection === "prepare return-loss") assert.throws(() => f.prepare(), /original V2 preparation return lost/u);
    else f.prepare();
    patch.mock.restore(); getter.mock.restore();
    assert.equal(entered, 1); assertNoLocalSafe(f);
    for (const handle of [f.parent, f.producer]) {
      assert.throws(() => f.tracker.settleFromStore(handle), trackerCode("settlement_unconfirmed"));
      assert.throws(() => settleOriginalAttemptExecutorGroupHostCall(f.group, member(f, handle).ticket,
        proof(f, handle, forgedDigest, forgedAt)), groupCode("unverified_settlement"));
    }
    assert.ok(f.pairRows().every(row => row.phase === "admitted"));
  });
}

test("mistaken V2 preparation cannot poison an already legitimate V1 pair", async t => {
  const f = await officeDirectoryTrackerFixture(t, { version: 1 });
  assert.throws(() => f.tracker.prepareOfficeLocalDirectoryExecutionV2(f.parent, f.producer, f.input), trackerCode("invalid_office_pair"));
  const pair = f.tracker.settleOfficeLocalFromStore(f.ticket);
  assert.equal(pair.parent.settlementKind, "known_no_start"); assert.equal(pair.producer.settlementKind, "known_no_start");
  assert.deepEqual(states(f), ["settled", "settled"]);
});

test("V2 reconciles original close return-loss once and thereafter never calls public close", async t => {
  const f = await officeDirectoryTrackerSettlementFixture(t), close = f.store.closeHostOfficeLocalDirectoryWindowV2.bind(f.store);
  let returns = 0;
  const lost = t.mock.method(f.store, "closeHostOfficeLocalDirectoryWindowV2", ticket => {
    const claim = close(ticket); if (++returns === 1) throw new Error("original close claim return lost"); return claim;
  });
  const claim = f.tracker.closeOfficeLocalDirectoryWindowV2(f.ticket);
  assert.equal(returns, 2); assert.equal(f.counts.close, 1);
  lost.mock.restore();
  const noop = t.mock.method(f.store, "closeHostOfficeLocalDirectoryWindowV2", () => assert.fail("cached claim must avoid the public close endpoint"));
  assert.equal(f.tracker.closeOfficeLocalDirectoryWindowV2(f.ticket), claim);
  f.tracker.settleOfficeLocalDirectoryFromStoreV2(f.ticket); f.retire();
  assert.equal(f.tracker.closeOfficeLocalDirectoryWindowV2(f.ticket), claim);
  assert.equal(noop.mock.callCount(), 0);
});

test("V2 reconciles committed Core return-loss after Host retirement without native/Host reentry", async t => {
  const f = await officeDirectoryTrackerSettlementFixture(t);
  f.tracker.closeOfficeLocalDirectoryWindowV2(f.ticket);
  const settle = f.store.settleHostOfficeLocalDirectoryExecutionV2.bind(f.store);
  let returns = 0, counts;
  t.mock.method(f.store, "settleHostOfficeLocalDirectoryExecutionV2", ticket => {
    const grant = settle(ticket);
    if (++returns === 1) { counts = { ...f.counts }; f.retire(); throw new Error("original committed grant return lost"); }
    return grant;
  });
  const pair = f.tracker.settleOfficeLocalDirectoryFromStoreV2(f.ticket);
  assert.equal(returns, 2); assert.deepEqual(f.counts, counts);
  assert.deepEqual(states(f), ["settled", "settled"]); assert.equal(pair.parent.phase, "safe");
});

test("V2 two actual COMMIT rollbacks retain both local barriers and the same certificate intent for retry", async t => {
  const f = await officeDirectoryTrackerSettlementFixture(t); f.tracker.closeOfficeLocalDirectoryWindowV2(f.ticket);
  const exec = f.store.database.exec.bind(f.store.database); let injected = 0, retained;
  const patch = t.mock.method(f.store.database, "exec", sql => {
    if (sql === "COMMIT" && injected < 2) {
      const candidate = f.store.database.prepare("SELECT * FROM host_office_local_directory_v2_certificates").get();
      // Core reconciliation also commits a readonly snapshot after rollback.
      // Fault only a real write candidate, never that historical read window.
      if (!candidate) return exec(sql);
      assert.ok(f.store.database.prepare("SELECT phase FROM host_operations WHERE operation_id IN (?,?)")
        .all(f.parent.operationId, f.producer.operationId).every(row => row.phase === "safe"));
      if (retained) assert.deepEqual(candidate, retained); else retained = candidate;
      injected++; throw new Error("original Tracker V2 COMMIT rolled back");
    }
    return exec(sql);
  });
  try { assert.throws(() => f.tracker.settleOfficeLocalDirectoryFromStoreV2(f.ticket), /original Tracker V2 COMMIT rolled back/u); }
  finally { patch.mock.restore(); }
  assert.equal(injected, 2); assert.deepEqual(states(f), ["launched", "launched"]);
  assert.ok(f.rawPair().every(row => row.phase === "launched"));
  assert.equal(f.other.database.prepare("SELECT COUNT(*) AS count FROM host_office_local_directory_v2_certificates").get().count, 0);
  const invocations = f.counts.invocations, pair = f.tracker.settleOfficeLocalDirectoryFromStoreV2(f.ticket);
  assert.equal(pair.parent.settledAt, retained.settled_at); assert.deepEqual(states(f), ["settled", "settled"]);
  assert.equal(f.counts.close, 1); assert.equal(f.counts.invocations, invocations);
});

test("V2 actual COMMIT acknowledgement loss retries canonical SQL after Host retirement", async t => {
  const f = await officeDirectoryTrackerSettlementFixture(t); f.tracker.closeOfficeLocalDirectoryWindowV2(f.ticket);
  const exec = f.store.database.exec.bind(f.store.database); let injected = 0, counts, retained;
  const patch = t.mock.method(f.store.database, "exec", sql => {
    if (sql === "COMMIT" && injected === 0) {
      retained = f.store.database.prepare("SELECT * FROM host_office_local_directory_v2_certificates").get();
      assert.ok(retained); injected++; exec(sql); counts = { ...f.counts }; f.retire();
      throw new Error("original Tracker V2 committed acknowledgement lost");
    }
    return exec(sql);
  });
  let pair;
  try { pair = f.tracker.settleOfficeLocalDirectoryFromStoreV2(f.ticket); }
  finally { patch.mock.restore(); }
  assert.equal(injected, 1); assert.equal(pair.parent.settledAt, retained.settled_at);
  assert.deepEqual(states(f), ["settled", "settled"]); assert.deepEqual(f.counts, counts);
  assert.deepEqual(f.other.database.prepare("SELECT * FROM host_office_local_directory_v2_certificates").get(), retained);
});

for (const counterfeit of ["empty", "cloned grant", "foreign grant", "cloned close claim"]) {
  test(`V2 fixed readback rejects ${counterfeit} even when public getters report safe`, async t => {
    const f = await officeDirectoryTrackerSettlementFixture(t), realClose = f.store.closeHostOfficeLocalDirectoryWindowV2.bind(f.store);
    if (counterfeit === "cloned close claim") {
      t.mock.method(f.store, "closeHostOfficeLocalDirectoryWindowV2", ticket => Object.freeze({ ...realClose(ticket) }));
    }
    f.tracker.closeOfficeLocalDirectoryWindowV2(f.ticket);
    const realSettle = f.store.settleHostOfficeLocalDirectoryExecutionV2.bind(f.store);
    let grant;
    if (counterfeit === "foreign grant") {
      const foreign = await officeDirectoryTrackerSettlementFixture(t);
      foreign.tracker.closeOfficeLocalDirectoryWindowV2(foreign.ticket);
      grant = foreign.store.settleHostOfficeLocalDirectoryExecutionV2(foreign.ticket);
    }
    const rows = f.pairRows();
    const getter = t.mock.method(f.store, "getHostOperation", id => ({ ...rows.find(row => row.operationId === id), phase: "safe",
      settledAt: f.now(), evidenceDigest: "a".repeat(64) }));
    if (counterfeit !== "cloned close claim") t.mock.method(f.store, "settleHostOfficeLocalDirectoryExecutionV2", ticket => {
      if (counterfeit === "empty") return Object.freeze({});
      const original = realSettle(ticket);
      return counterfeit === "cloned grant" ? Object.freeze({ ...original }) : grant;
    });
    assert.throws(() => f.tracker.settleOfficeLocalDirectoryFromStoreV2(f.ticket),
      code(counterfeit === "cloned close claim" ? "host_office_local_close_claim_invalid" : "host_office_local_committed_pair_invalid"));
    assert.equal(getter.mock.callCount(), 0); assert.deepEqual(states(f), ["launched", "launched"]);
  });
}

test("V2 producer local success survives a parent verifier failure and retries only the remaining barrier", async t => {
  const f = await officeDirectoryTrackerSettlementFixture(t); f.tracker.closeOfficeLocalDirectoryWindowV2(f.ticket);
  const prepare = f.store.database.prepare.bind(f.store.database); let injected = 0;
  const patch = t.mock.method(f.store.database, "prepare", sql => {
    if (injected === 0 && states(f).join(",") === "launched,settled") {
      injected++; throw new Error("original parent fixed readback temporarily unavailable");
    }
    return prepare(sql);
  });
  assert.throws(() => f.tracker.settleOfficeLocalDirectoryFromStoreV2(f.ticket), groupCode("unverified_settlement"));
  patch.mock.restore(); assert.equal(injected, 1);
  assert.deepEqual(states(f), ["launched", "settled"]); assert.ok(f.pairRows().every(row => row.phase === "safe"));
  const counts = { ...f.counts }, producerProof = member(f, f.producer).settlement; f.retire();
  const pair = f.tracker.settleOfficeLocalDirectoryFromStoreV2(f.ticket);
  assert.deepEqual(states(f), ["settled", "settled"]); assert.deepEqual(member(f, f.producer).settlement, producerProof);
  assert.deepEqual(f.counts, counts); assert.equal(pair.parent.phase, "safe");
});

test("V2 real group notification return-loss retains producer success without fabricating unknown", async t => {
  const f = await officeDirectoryTrackerSettlementFixture(t); f.tracker.closeOfficeLocalDirectoryWindowV2(f.ticket);
  const iteratorDescriptor = Object.getOwnPropertyDescriptor(Set.prototype, Symbol.iterator);
  const iterator = iteratorDescriptor.value; let injected = 0;
  // Fault injection at the genuine private #notify Set iteration, after it
  // stores producer settlement. No caller verifier or public settle replacement.
  // Node 22 symbol-method mock.restore is not descriptor-safe; explicitly
  // restore this exact builtin descriptor, including on an assertion failure.
  Object.defineProperty(Set.prototype, Symbol.iterator, { ...iteratorDescriptor, value: function () {
    if (injected === 0 && states(f).join(",") === "launched,settled") {
      injected++; throw new Error("original group notification return lost");
    }
    return iterator.call(this);
  } });
  try { assert.throws(() => f.tracker.settleOfficeLocalDirectoryFromStoreV2(f.ticket), /original group notification return lost/u); }
  finally { Object.defineProperty(Set.prototype, Symbol.iterator, iteratorDescriptor); }
  assert.equal(injected, 1); assert.deepEqual(states(f), ["launched", "settled"]);
  const producerProof = member(f, f.producer).settlement, counts = { ...f.counts }; f.retire();
  f.tracker.settleOfficeLocalDirectoryFromStoreV2(f.ticket);
  assert.deepEqual(states(f), ["settled", "settled"]); assert.deepEqual(member(f, f.producer).settlement, producerProof);
  assert.deepEqual(f.counts, counts);
});

test("V2 producer notification reentry cannot prematurely close parent even with its exact committed proof", async t => {
  const f = await officeDirectoryTrackerSettlementFixture(t); f.tracker.closeOfficeLocalDirectoryWindowV2(f.ticket);
  const iteratorDescriptor = Object.getOwnPropertyDescriptor(Set.prototype, Symbol.iterator);
  const iterator = iteratorDescriptor.value; let entered = 0;
  Object.defineProperty(Set.prototype, Symbol.iterator, { ...iteratorDescriptor, value: function () {
    if (entered === 0 && states(f).join(",") === "launched,settled") {
      entered++;
      const parent = f.pairRows()[0];
      assert.throws(() => f.tracker.closeOfficeLocalDirectoryWindowV2(f.ticket), trackerCode("settlement_in_progress"));
      assert.throws(() => f.tracker.settleOfficeLocalDirectoryFromStoreV2(f.ticket), trackerCode("settlement_in_progress"));
      assert.throws(() => settleOriginalAttemptExecutorGroupHostCall(f.group, member(f, f.parent).ticket,
        proof(f, f.parent, parent.evidenceDigest, parent.settledAt)), groupCode("unverified_settlement"));
      assert.deepEqual(states(f), ["launched", "settled"], "grant/proof exists, but only the current original member may enter verification");
    }
    return iterator.call(this);
  } });
  try { f.tracker.settleOfficeLocalDirectoryFromStoreV2(f.ticket); }
  finally { Object.defineProperty(Set.prototype, Symbol.iterator, iteratorDescriptor); }
  assert.equal(entered, 1); assert.deepEqual(states(f), ["settled", "settled"]);
});

test("V2 synchronous fixed readback reentry cannot settle either member with a direct proof", async t => {
  const f = await officeDirectoryTrackerSettlementFixture(t); f.tracker.closeOfficeLocalDirectoryWindowV2(f.ticket);
  const prepare = f.store.database.prepare.bind(f.store.database); let entered = 0;
  const patch = t.mock.method(f.store.database, "prepare", sql => {
    if (entered === 0 && f.pairRows().every(row => row.phase === "safe")) {
      entered++;
      assert.throws(() => f.tracker.closeOfficeLocalDirectoryWindowV2(f.ticket), trackerCode("settlement_in_progress"));
      assert.throws(() => f.tracker.settleOfficeLocalDirectoryFromStoreV2(f.ticket), trackerCode("settlement_in_progress"));
      for (const handle of [f.parent, f.producer]) {
        const row = f.pairRows().find(value => value.operationId === handle.operationId);
        assert.throws(() => settleOriginalAttemptExecutorGroupHostCall(f.group, member(f, handle).ticket,
          proof(f, handle, row.evidenceDigest, row.settledAt)), groupCode("unverified_settlement"));
      }
      assert.deepEqual(states(f), ["launched", "launched"]);
    }
    return prepare(sql);
  });
  try { f.tracker.settleOfficeLocalDirectoryFromStoreV2(f.ticket); }
  finally { patch.mock.restore(); }
  assert.equal(entered, 1); assert.deepEqual(states(f), ["settled", "settled"]);
});

for (const timing of ["before construction", "after construction"]) {
  test(`V2 fixed group reader ignores public prototype no-ops ${timing}`, async t => {
    let f, publicCalls = 0;
    if (timing === "after construction") f = await officeDirectoryTrackerSettlementFixture(t);
    const readPatch = t.mock.method(AttemptExecutorGroup.prototype, "getSnapshot", () => { publicCalls++; return { operations: [] }; });
    const settlePatch = t.mock.method(AttemptExecutorGroup.prototype, "settleHostCall", () => { publicCalls++; });
    const sourceDescriptor = Object.getOwnPropertyDescriptor(AttemptExecutorGroup.prototype, "source");
    Object.defineProperty(AttemptExecutorGroup.prototype, "source", { configurable: true,
      get() { publicCalls++; return Object.freeze({ runId: "fake-source" }); } });
    try {
      if (!f) f = await officeDirectoryTrackerSettlementFixture(t);
      const before = publicCalls;
      f.tracker.closeOfficeLocalDirectoryWindowV2(f.ticket);
      f.tracker.settleOfficeLocalDirectoryFromStoreV2(f.ticket);
      assert.deepEqual(states(f), ["settled", "settled"]);
      assert.equal(publicCalls, before, "V2 close/readback must use the original constructor-private group entry");
    } finally {
      readPatch.mock.restore(); settlePatch.mock.restore();
      Object.defineProperty(AttemptExecutorGroup.prototype, "source", sourceDescriptor);
    }
  });
}

test("fixed group entries reject fake/clone/Proxy groups and foreign original tickets", async t => {
  const f = await officeDirectoryTrackerSettlementFixture(t, { complete: false });
  const foreign = await officeDirectoryTrackerSettlementFixture(t, { complete: false });
  let reads = 0;
  const fake = { getSnapshot() { reads++; }, settleHostCall() { reads++; } };
  for (const group of [fake, { ...f.group }, Object.create(f.group), new Proxy(f.group, {})]) {
    assert.throws(() => readOriginalAttemptExecutorGroupSnapshot(group), groupCode("invalid_group"));
    assert.throws(() => settleOriginalAttemptExecutorGroupHostCall(group, member(f, f.parent).ticket, proof(f, f.parent)), groupCode("invalid_group"));
  }
  assert.throws(() => settleOriginalAttemptExecutorGroupHostCall(f.group, member(foreign, foreign.parent).ticket,
    proof(foreign, foreign.parent)), groupCode("invalid_ticket"));
  assert.equal(reads, 0); assertNoLocalSafe(f);
});

for (const role of ["parent", "producer"]) for (const entry of ["tracker", "group"]) {
  test(`unknown ${role} via original ${entry} cannot upgrade a V2 local barrier despite a genuine committed Core pair`, async t => {
    const f = await officeDirectoryTrackerSettlementFixture(t); f.tracker.closeOfficeLocalDirectoryWindowV2(f.ticket);
    f.store.settleHostOfficeLocalDirectoryExecutionV2(f.ticket);
    const handle = f[role];
    if (entry === "tracker") assert.throws(() => f.tracker.markUnknown(handle, "original_tracker_unknown"));
    else {
      assert.throws(() => settleOriginalAttemptExecutorGroupHostCall(f.group, member(f, handle).ticket,
        { schemaVersion: 1, source: f.source, operationId: handle.operationId,
          evidenceRef: `host_operation:${handle.operationId}:unknown`, settledAt: f.now(),
          kind: "unknown_outcome", code: "original_group_unknown" }), groupCode("blocked_persistence"));
    }
    assert.equal(member(f, handle).state, "blocked");
    assert.throws(() => f.tracker.settleOfficeLocalDirectoryFromStoreV2(f.ticket), trackerCode("already_settled"));
    assert.deepEqual(states(f), role === "parent" ? ["blocked", "launched"] : ["launched", "blocked"]);
  });
}
