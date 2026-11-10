import assert from "node:assert/strict";
import test from "node:test";
import { readOriginalOfficeDirectoryCommittedPairV2, assertOriginalOfficeDirectoryCommittedPairV2,
  assertOriginalOfficeDirectoryCommittedPairAuthorityV2 } from "../dist/original-office-committed-pair-v2.js";
import { mintOriginalOfficeDirectoryAuthorityV2 } from "../dist/original-office-host-bridge.js";
import { originalOfficeDirectorySettlementV2Fixture as fixture } from "./support/original-office-directory-settlement-v2-fixture.mjs";

// Actual SQLite and original Core capabilities. Native graph / bridge endpoints
// remain trusted transport mechanisms, not genuine Host, kernel or OOXML proof.
const code = expected => error => error?.code === expected;
const rejected = error => typeof error?.code === "string" && /^(host_office_local|host_operation)_/.test(error.code);
const copies = value => [{ ...value }, JSON.parse(JSON.stringify(value)), new Proxy(value, {})];
const pair = (f, handle) => readOriginalOfficeDirectoryCommittedPairV2(f.store, handle, f.claim, f.expected);
const deepFrozen = value => {
  if (!value || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) deepFrozen(child);
};
const noSafePair = f => {
  assert.deepEqual(f.rawPair().map(row => row.phase), ["launched", "launched"]);
  assert.equal(f.certificates().length, 0);
  assert.equal(f.other.listHostOperationBlockers(f.source).filter(row => [f.parent.operationId, f.producer.operationId].includes(row.operationId)).length, 2);
};

test("complete original V2 mechanism graph atomically commits one certificate and both original roles", async t => {
  const f = await fixture(t), native = f.counts.native, handle = f.settle(), committed = pair(f, handle);
  assert.ok(Object.isFrozen(handle)); assert.deepEqual(Reflect.ownKeys(handle), []);
  assert.deepEqual(Object.keys(committed).sort(), ["parent", "producer"]); deepFrozen(committed);
  assert.equal(committed.parent.operationId, f.parent.operationId); assert.equal(committed.producer.operationId, f.producer.operationId);
  assert.equal(committed.parent.phase, "safe"); assert.equal(committed.producer.phase, "safe");
  assert.equal(committed.parent.settlementKind, "office_local_chain_completed");
  assert.equal(committed.producer.settlementKind, "office_local_binary_completed");
  assert.equal(committed.parent.settledAt, committed.producer.settledAt);
  assert.notEqual(committed.parent.evidenceDigest, committed.producer.evidenceDigest);
  assert.equal(f.certificates().length, 1); assert.equal(f.certificates()[0].settled_at, committed.parent.settledAt);
  assert.equal(f.settle(), handle); assert.deepEqual(pair(f, handle), committed);
  assert.equal(assertOriginalOfficeDirectoryCommittedPairV2(f.store, handle, f.claim, f.expected), undefined);
  assert.equal(f.counts.native, native); assert.equal(f.counts.close, 1);
  assert.equal(f.terminal.outcome, "published_native_only"); assert.equal(f.terminal.canonicalVisibility.state, "unverified");
  assert.deepEqual(f.other.getHostOperation(f.parent.operationId), committed.parent);
  assert.deepEqual(f.other.getHostOperation(f.producer.operationId), committed.producer);
  assert.deepEqual(f.other.listHostOperationBlockers(f.source), []);
});

test("copied, foreign and reopened original tickets cannot issue V2 settlement", async t => {
  const f = await fixture(t), foreign = await fixture(t);
  for (const ticket of [...copies(f.ticket), foreign.ticket]) {
    assert.throws(() => f.store.settleHostOfficeLocalDirectoryExecutionV2(ticket), code("host_office_local_invalid_ticket"));
  }
  assert.throws(() => f.other.settleHostOfficeLocalDirectoryExecutionV2(f.ticket), code("host_office_local_invalid_ticket"));
  assert.throws(() => f.store.settleHostOfficeLocalExecution(f.ticket), code("host_office_local_invalid_ticket"), "V1 settlement cannot adopt V2");
  noSafePair(f);
});

test("generic settlement cannot independently release either V2 original role", async t => {
  const f = await fixture(t);
  for (const [ticket, kind] of [[f.parent, "office_local_chain_completed"], [f.producer, "office_local_binary_completed"]]) {
    assert.throws(() => f.store.settleHostOperation(ticket, { kind, settledAt: f.now() }), code("host_office_local_pair_settlement_required"));
  }
  noSafePair(f);
});

test("only the exact original owner, committed handle, close claim and expected execution can read the pair", async t => {
  const f = await fixture(t), foreign = await fixture(t), handle = f.settle(), foreignHandle = foreign.settle();
  for (const changed of [...copies(handle), foreignHandle, JSON.parse(f.certificates()[0].certificate_json)]) {
    assert.throws(() => pair(f, changed), code("host_office_local_committed_pair_invalid"));
  }
  assert.throws(() => readOriginalOfficeDirectoryCommittedPairV2(f.other, handle, f.claim, f.expected), rejected);
  assert.throws(() => readOriginalOfficeDirectoryCommittedPairV2(foreign.store, handle, f.claim, f.expected), rejected);
  for (const claim of [...copies(f.claim), foreign.claim]) {
    assert.throws(() => readOriginalOfficeDirectoryCommittedPairV2(f.store, handle, claim, f.expected), code("host_office_local_close_claim_invalid"));
  }
  for (const expected of [foreign.expected, { ...f.expected, executionId: "foreign-execution" },
    { ...f.expected, parentOperationId: "foreign-parent" }, { ...f.expected, producerOperationId: "foreign-producer" },
    { ...f.expected, source: { ...f.expected.source, runtimeInstanceId: "successor" } }]) {
    assert.throws(() => readOriginalOfficeDirectoryCommittedPairV2(f.store, handle, f.claim, expected), rejected);
  }
  assert.deepEqual(pair(f, handle).parent, f.store.getHostOperation(f.parent.operationId));
});

test("fixed committed authority assertion binds the grant to the exact original close-claim custody without Host IO", async t => {
  const f = await fixture(t), foreign = await fixture(t), handle = f.settle();
  const verify = (authority = f.authority, owner = f.store, grant = handle, claim = f.claim, expected = f.expected) =>
    assertOriginalOfficeDirectoryCommittedPairAuthorityV2(owner, grant, claim, authority, expected);
  const counts = { ...f.counts };
  assert.equal(verify(), undefined);
  const newAuthority = mintOriginalOfficeDirectoryAuthorityV2(f.bridge.setup, Object.freeze({}));
  for (const authority of [...copies(f.authority), foreign.authority, newAuthority]) {
    assert.throws(() => verify(authority), code("host_office_local_committed_pair_authority_invalid"));
  }
  for (const grant of copies(handle)) assert.throws(() => verify(f.authority, f.store, grant), rejected);
  assert.throws(() => verify(f.authority, f.other), rejected);
  assert.throws(() => verify(f.authority, f.store, handle, { ...f.claim }), code("host_office_local_close_claim_invalid"));
  assert.throws(() => verify(f.authority, f.store, handle, f.claim,
    { ...f.expected, executionId: "borrowed-window" }), rejected);
  assert.deepEqual(f.counts, counts);
  f.retire();
  assert.equal(verify(), undefined, "retirement cannot make a historical grant adopt a new authority or require current Host IO");
  assert.deepEqual(f.counts, counts);
});

test("native-only and open/unbound window facts cannot be upgraded into an independent certificate", async t => {
  const open = await fixture(t, { closed: false });
  assert.throws(() => open.settle(), rejected); noSafePair(open);
  const unbound = await fixture(t, { bind: false, closed: false });
  assert.throws(() => unbound.settle(), rejected); noSafePair(unbound);
  const empty = await fixture(t, { complete: false });
  assert.throws(() => empty.settle(), rejected);
  assert.equal(empty.certificates().length, 0); assert.deepEqual(empty.rawPair().map(row => row.phase), ["admitted", "admitted"]);
});

test("replacement source or retired original bridge cannot certify an already closed native graph", async t => {
  const replaced = await fixture(t);
  replaced.store.createWorkUnitAttempt({ workUnitId: replaced.source.workUnitId, attemptNumber: 2,
    runtimeInstanceId: "replacement", runnerId: "pi", status: "started", now: replaced.now() });
  assert.throws(() => replaced.settle(), code("host_operation_stale_owner")); noSafePair(replaced);
  const retired = await fixture(t); retired.retire();
  assert.throws(() => retired.settle(), rejected); noSafePair(retired);
});

test("unknown original closure cannot acquire a certificate and never repeats the physical close", async t => {
  const f = await fixture(t, { closed: false, close(current) {
    current.state.phase = "unknown"; throw new Error("original mechanism closure unknown");
  } });
  assert.throws(() => f.close(), /original mechanism closure unknown/);
  assert.throws(() => f.settle(), rejected); noSafePair(f);
  assert.equal(f.counts.close, 1); assert.equal(f.claim, undefined);
});

test("full raw descendants include the producer subtree and every reserved nested sibling", async t => {
  const f = await fixture(t, { closed: false });
  const child = f.reserve("producer-required-child", f.producer.operationId);
  const nested = f.reserve("producer-required-grandchild", child.operationId, f.store, "cleanup");
  const sibling = f.reserve("parent-required-sibling");
  f.finish(nested); f.finish(child); f.finish(sibling); f.close();
  const handle = f.settle();
  assert.equal(pair(f, handle).parent.phase, "safe"); assert.deepEqual(f.other.listHostOperationBlockers(f.source), []);
});

test("cross-Store late pending child is re-read under the certificate write transaction and blocks both roles", async t => {
  const f = await fixture(t), before = { ...f.counts };
  const child = f.reserve("cross-store-late-child", f.producer.operationId, f.other);
  assert.throws(() => f.settle(), code("host_office_local_required_child_not_ready")); noSafePair(f);
  assert.equal(f.counts.close, before.close); assert.equal(f.counts.native, before.native);
  f.finish(child, f.other);
  assert.equal(pair(f, f.settle()).parent.phase, "safe", "failed roster preflight must not retain a premature settlement clock");
});

test("committed pair safe phases durably refuse new child admission on another original SQLite connection", async t => {
  const f = await fixture(t), handle = f.settle(), before = f.certificates();
  for (const role of [f.parent, f.producer]) {
    assert.throws(() => f.reserve("after-commit-" + role.operationId, role.operationId, f.other), code("host_operation_invalid_parent"));
  }
  assert.deepEqual(f.certificates(), before); assert.equal(pair(f, handle).parent.phase, "safe");
});

test("actual second-role SQLite UPDATE failure rolls back certificate and producer instead of exposing half-safe", async t => {
  const f = await fixture(t), native = f.counts.native;
  f.store.database.exec(`CREATE TRIGGER test_office_directory_parent_abort BEFORE UPDATE ON host_operations
    WHEN NEW.operation_id='directory-settlement-parent' AND NEW.phase='safe'
    BEGIN SELECT RAISE(ABORT,'office directory pair second write fault'); END`);
  assert.throws(() => f.settle(), /office directory pair second write fault/); noSafePair(f);
  f.store.database.exec("DROP TRIGGER test_office_directory_parent_abort");
  assert.equal(pair(f, f.settle()).producer.phase, "safe");
  assert.equal(f.counts.native, native); assert.equal(f.counts.close, 1);
});

for (const commitFirst of [false, true]) test(`V2 settlement actual COMMIT ${commitFirst ? "reply loss" : "rollback"} retains first certificate intent and never replays native or close`, async t => {
  const f = await fixture(t), exec = f.store.database.exec.bind(f.store.database), native = f.counts.native;
  let injected = false, retained;
  f.store.database.exec = sql => {
    if (sql === "COMMIT" && !injected) {
      injected = true; retained = f.certificates(f.store)[0];
      assert.ok(retained, "the fault occurs after original certificate and atomic pair writes");
      if (commitFirst) exec(sql);
      throw new Error("office directory settlement COMMIT acknowledgement lost");
    }
    return exec(sql);
  };
  try { assert.throws(() => f.settle(), /office directory settlement COMMIT acknowledgement lost/); }
  finally { f.store.database.exec = exec; }
  assert.equal(injected, true);
  assert.deepEqual(f.rawPair().map(row => row.phase), commitFirst ? ["safe", "safe"] : ["launched", "launched"]);
  assert.equal(f.certificates().length, commitFirst ? 1 : 0);
  const handle = f.settle(), committed = pair(f, handle);
  assert.equal(f.settle(), handle); assert.equal(committed.parent.settledAt, retained.settled_at);
  const actual = f.certificates()[0];
  for (const field of ["certificate_json", "certificate_digest", "settled_at"]) assert.equal(actual[field], retained[field]);
  assert.equal(f.counts.native, native); assert.equal(f.counts.close, 1);
  assert.deepEqual(f.other.getHostOperation(f.producer.operationId), committed.producer);
});

test("actual COMMIT reply loss reconciles only the original ticket through pure SQL after bridge retirement and owner replacement", async t => {
  const f = await fixture(t), exec = f.store.database.exec.bind(f.store.database);
  let injected = false, retained;
  f.store.database.exec = sql => {
    if (sql === "COMMIT" && !injected) {
      injected = true; retained = f.certificates(f.store)[0];
      assert.ok(retained, "original certificate and both role writes precede actual COMMIT");
      exec(sql);
      throw new Error("retired office directory settlement COMMIT acknowledgement lost");
    }
    return exec(sql);
  };
  try { assert.throws(() => f.settle(), /retired office directory settlement COMMIT acknowledgement lost/); }
  finally { f.store.database.exec = exec; }
  assert.equal(injected, true);
  assert.deepEqual(f.rawPair().map(row => row.phase), ["safe", "safe"]);
  assert.deepEqual(f.certificates(), [retained]);
  const counts = { ...f.counts };
  f.retire();
  f.store.createWorkUnitAttempt({ workUnitId: f.source.workUnitId, attemptNumber: 2,
    runtimeInstanceId: "replacement-after-commit", runnerId: "pi", status: "started", now: f.now() });
  const handle = f.settle(), committed = pair(f, handle);
  assert.equal(f.settle(), handle);
  assert.equal(committed.parent.settledAt, retained.settled_at);
  assert.equal(committed.producer.settledAt, retained.settled_at);
  for (const field of ["certificate_json", "certificate_digest", "settled_at"]) {
    assert.equal(f.certificates()[0][field], retained[field]);
  }
  assert.equal(f.certificates().length, 1);
  assert.deepEqual(f.other.getHostOperation(f.parent.operationId), committed.parent);
  assert.deepEqual(f.other.getHostOperation(f.producer.operationId), committed.producer);
  assert.throws(() => f.other.settleHostOfficeLocalDirectoryExecutionV2(f.ticket), code("host_office_local_invalid_ticket"));
  for (const ticket of copies(f.ticket)) {
    assert.throws(() => f.store.settleHostOfficeLocalDirectoryExecutionV2(ticket), code("host_office_local_invalid_ticket"));
  }
  assert.deepEqual(f.counts, counts, "SQL reconciliation must not call retired Host endpoints or replay native effects or physical close");
});

test("raw certificate INSERT outside the private exact issuance latch is refused and consumes no safe intent", async t => {
  const f = await fixture(t);
  assert.throws(() => f.store.database.prepare(`INSERT INTO host_office_local_directory_v2_certificates
    (execution_id,schema_version,protocol,certificate_json,certificate_digest,settled_at) VALUES(?,2,?,?,?,?)`)
    .run(f.ticket.executionId, f.expected.protocol, "{}", "f".repeat(64), f.now()), /certificate|ling_office_directory_v2_certificate_insert/);
  noSafePair(f);
  assert.equal(pair(f, f.settle()).producer.phase, "safe");
});

test("committed certificate rows reject UPDATE, DELETE and OR REPLACE with either recursive-trigger setting", async t => {
  const f = await fixture(t), handle = f.settle(), original = f.certificates()[0];
  for (const recursive of [0, 1]) {
    f.store.database.exec(`PRAGMA recursive_triggers=${recursive}`);
    for (const sql of ["UPDATE host_office_local_directory_v2_certificates SET certificate_digest=certificate_digest",
      "DELETE FROM host_office_local_directory_v2_certificates"]) {
      assert.throws(() => f.store.database.exec(sql), /immutable|append_only|certificate/);
    }
    assert.throws(() => f.store.database.prepare(`INSERT OR REPLACE INTO host_office_local_directory_v2_certificates
      (execution_id,schema_version,protocol,certificate_json,certificate_digest,settled_at) VALUES(?,?,?,?,?,?)`)
      .run(original.execution_id, original.schema_version, original.protocol, original.certificate_json,
        original.certificate_digest, original.settled_at), /append_only|certificate|ling_office_directory_v2_certificate_insert/);
    assert.deepEqual(f.certificates(), [original]); assert.equal(pair(f, handle).parent.phase, "safe");
  }
});

test("ordinary public safe getters and reopened readers independently reverify without calling the Host endpoint", async t => {
  const f = await fixture(t), handle = f.settle(), committed = pair(f, handle), counts = { ...f.counts };
  f.retire();
  for (const reader of [f.store, f.other]) {
    assert.deepEqual(reader.getHostOperation(f.parent.operationId), committed.parent);
    assert.deepEqual(reader.getHostOperation(f.producer.operationId), committed.producer);
    assert.deepEqual(reader.listHostOperationBlockers(f.source), []);
    assert.equal(reader.getHostOfficeLocalDirectoryTerminalV2(f.ticket.executionId).canonicalVisibility.state, "unverified");
  }
  assert.deepEqual(f.counts, counts);
});

test("fixed committed reader ignores an overridden public getter and returns the canonical SQLite pair", async t => {
  const f = await fixture(t), handle = f.settle(), canonical = pair(f, handle), counts = { ...f.counts };
  const originalGetter = f.store.getHostOperation;
  let getterCalls = 0;
  f.store.getHostOperation = () => {
    getterCalls++;
    return { ...canonical.parent, operationId: "forged-public-operation", phase: "launched", evidenceDigest: "f".repeat(64) };
  };
  try {
    const actual = pair(f, handle);
    assert.deepEqual(actual, canonical); deepFrozen(actual);
    assert.equal(assertOriginalOfficeDirectoryCommittedPairV2(f.store, handle, f.claim, f.expected), undefined);
    assert.equal(getterCalls, 0, "fixed reader must not delegate to a replaceable public getter");
    assert.deepEqual(f.counts, counts);
  } finally { f.store.getHostOperation = originalGetter; }
  assert.deepEqual(f.store.getHostOperation(f.parent.operationId), canonical.parent);
  assert.deepEqual(f.store.getHostOperation(f.producer.operationId), canonical.producer);
  assert.deepEqual(f.counts, counts);
});

test("public binary safe reads do not accept a surviving certificate beside a corrupt half-safe original pair", async t => {
  const f = await fixture(t); f.settle();
  // Explicit corruption fixture only. Production never drops its immutable trigger.
  f.store.database.exec("DROP TRIGGER host_operations_immutable_settlement");
  f.store.database.prepare(`UPDATE host_operations SET phase='launched',settled_at=NULL,settlement_kind=NULL,
    evidence_digest=NULL,settlement_signature=NULL,code=NULL,revision=revision+1 WHERE operation_id=?`).run(f.parent.operationId);
  assert.equal(f.certificates().length, 1);
  for (const reader of [f.store, f.other]) assert.throws(() => reader.getHostOperation(f.producer.operationId), rejected);
});

test("ordinary V2 parent and producer safe reads retain recursive verification of every required child receipt", async t => {
  const f = await fixture(t, { closed: false }), child = f.reserve("required-parent-child");
  const nested = f.reserve("required-parent-grandchild", child.operationId, f.store, "cleanup");
  f.finish(nested); f.finish(child); f.close(); f.settle();
  // Explicit historical corruption, not an alternative production settlement API.
  f.store.database.exec("DROP TRIGGER host_operations_immutable_settlement");
  f.store.database.prepare("UPDATE host_operations SET evidence_digest=? WHERE operation_id=?").run("e".repeat(64), nested.operationId);
  for (const reader of [f.store, f.other]) {
    assert.throws(() => reader.getHostOperation(f.parent.operationId), rejected);
    assert.throws(() => reader.getHostOperation(f.producer.operationId), rejected);
  }
});
