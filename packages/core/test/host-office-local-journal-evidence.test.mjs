import assert from "node:assert/strict";
import test from "node:test";
import { hostOperationDomainIdentity, verifyHostOperationSafe,
  verifyHostOperationSettlementCandidate } from "../dist/storage/sqlite/host-operation-journal-evidence.js";
import { verifyHostOfficeReceipt } from "../dist/storage/sqlite/host-office-local-journal-evidence.js";
import { officeJournalClone, officeJournalFixture } from "./support/host-office-local-journal-fixture.mjs";

const rejected = error => typeof error.code === "string" && /^host_(office_local_(replay|evidence)_invalid|operation_(evidence_invalid|invalid_source|invalid_timestamp|journal_corrupt))$/.test(error.code);
const candidate = (f, id = "producer", change = {}) => ({ ...f.read(id), phase: "safe", settledAt: f.settledAt,
  settlementKind: id === "parent" ? "office_local_chain_completed" : "office_local_binary_completed",
  settlementSignature: JSON.stringify({ kind: id === "parent" ? "office_local_chain_completed" : "office_local_binary_completed", settledAt: f.settledAt }), ...change });
const receipt = (f, change = {}) => verifyHostOfficeReceipt(f.database, candidate(f, "producer", change), "settlement_candidate");

for (const options of [{}, { overwrite: true }, { shortWrite: true }, { overwrite: true, shortWrite: true }]) {
  test(`Office role consumers verify complete sealed SQLite history ${JSON.stringify(options)}`, async t => {
    const f = await officeJournalFixture(t, options);
    const parent = f.read("parent"), producer = f.read("producer");
    assert.equal(parent.evidenceRef.id, producer.evidenceRef.id);
    assert.notEqual(parent.evidenceRef.kind, producer.evidenceRef.kind);
    assert.notEqual(parent.domainIdentityDigest, producer.domainIdentityDigest, "role binding cannot alias one generic receipt");
    assert.throws(() => verifyHostOperationSafe(f.database, candidate(f, "parent")), rejected, "reserved binary must fan in first");
    const binary = f.settleRecord("producer");
    assert.throws(() => f.store.getHostOperation("producer"), rejected, "an intermediate internal row is not a public whole-pair safe receipt");
    assert.throws(() => f.store.listHostOperationBlockers(f.source), rejected);
    const chain = f.settleRecord("parent");
    assert.equal(f.store.getHostOperation("producer").evidenceDigest, binary.evidenceDigest);
    assert.notEqual(verifyHostOfficeReceipt(f.database, chain), verifyHostOfficeReceipt(f.database, binary));
    assert.deepEqual(f.store.listHostOperationBlockers(f.source), []);
    const restarted = f.reopen();
    assert.deepEqual(restarted.getHostOperation("parent"), f.store.getHostOperation("parent"));
    assert.deepEqual(restarted.listHostOperationBlockers(f.source), []);
    assert.throws(() => restarted.launchHostOperation({ operationId: "parent" }, () => 1), error => error.code === "host_operation_invalid_ticket");
  });
}

for (const [label, id, change] of [
  ["chain evidence on binary", "producer", { evidenceRef: { kind: "office_local_chain_execution", id: "exec" } }],
  ["binary evidence on root", "parent", { evidenceRef: { kind: "office_local_binary_execution", id: "exec" } }],
  ["wrong execution", "producer", { evidenceRef: { kind: "office_local_binary_execution", id: "foreign" } }],
  ["wrong binary operation", "producer", { operationId: "foreign" }],
  ["wrong root operation", "parent", { operationId: "foreign" }],
  ["binary wrong kind", "producer", { kind: "mcp" }],
  ["root wrong kind", "parent", { kind: "file_mutation" }],
  ["binary wrong parent", "producer", { parentOperationId: "foreign" }],
  ["binary wrong producer", "producer", { producerId: "some-file-writer" }],
  ["root cannot be a child", "parent", { parentOperationId: "foreign", producerId: "nested" }],
  ["wrong original tool call", "producer", { toolCallId: "foreign" }],
]) {
  test(`Office domain scope rejects ${label}`, async t => {
    const f = await officeJournalFixture(t), operation = { ...f.read(id), ...change };
    assert.throws(() => hostOperationDomainIdentity(f.database, operation, operation.evidenceRef, false), rejected);
    assert.throws(() => verifyHostOfficeReceipt(f.database, candidate(f, id, change)), rejected);
  });
}
for (const field of ["runId", "workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"]) {
  test(`Office receipt never borrows successor/foreign source ${field}`, async t => {
    const f = await officeJournalFixture(t), operation = candidate(f, "producer", { source: { ...f.source, [field]: "foreign" } });
    assert.throws(() => verifyHostOfficeReceipt(f.database, operation), rejected);
  });
}

test("Office binding is too late once any effect descriptor or terminal exists", async t => {
  const f = await officeJournalFixture(t), operation = { ...f.read("producer"), phase: "admitted", launchedAt: undefined };
  assert.throws(() => hostOperationDomainIdentity(f.database, operation, operation.evidenceRef, true), rejected);
  f.database.prepare("DELETE FROM host_office_local_effects").run();
  assert.throws(() => hostOperationDomainIdentity(f.database, operation, operation.evidenceRef, true), rejected);
});
for (const [label, sql, parameters] of [
  ["parent bound as binary", "UPDATE host_operations SET evidence_kind=? WHERE operation_id='parent'", ["office_local_binary_execution"]],
  ["binary bound as chain", "UPDATE host_operations SET evidence_kind=? WHERE operation_id='producer'", ["office_local_chain_execution"]],
  ["parent evidence points elsewhere", "UPDATE host_operations SET evidence_id=? WHERE operation_id='parent'", ["foreign"]],
  ["parent domain digest corrupt", "UPDATE host_operations SET domain_identity_digest=? WHERE operation_id='parent'", ["e".repeat(64)]],
  ["binary domain digest corrupt", "UPDATE host_operations SET domain_identity_digest=? WHERE operation_id='producer'", ["e".repeat(64)]],
  ["original producer identity corrupt", "UPDATE host_operations SET producer_id=? WHERE operation_id='producer'", ["not-office"]],
  ["original pair parent corrupt", "UPDATE host_operations SET parent_operation_id=? WHERE operation_id='producer'", ["foreign"]],
]) {
  test(`Office receipt requires both original persisted role bindings: ${label}`, async t => {
    const f = await officeJournalFixture(t); f.database.prepare(sql).run(...parameters);
    assert.throws(() => receipt(f), rejected);
  });
}

test("Office callback entry before launch is valid; actual native call must follow both launch marks", async t => {
  const f = await officeJournalFixture(t), first = f.effects[0];
  assert.ok(first.effect.enteredAt < f.launchedAt);
  assert.ok(f.launchedAt < first.observation.native.calledAt);
  assert.match(receipt(f), /^[a-f0-9]{64}$/);
  f.database.prepare("UPDATE host_operations SET launched_at=? WHERE operation_id='parent'")
    .run(new Date(Date.parse(first.observation.native.calledAt) + 1).toISOString());
  assert.throws(() => receipt(f), rejected, "binary cannot hide a late root launch");
});
test("Office resealed native call before launch is rejected without relying on stale observation hashes", async t => {
  const f = await officeJournalFixture(t), first = f.effects[0];
  first.observation.native.calledAt = first.effect.enteredAt;
  f.writeHistory();
  assert.throws(() => receipt(f), rejected);
});
for (const [label, change] of [
  ["known no-start", { settlementKind: "known_no_start", launchedAt: undefined }],
  ["old file terminal", { settlementKind: "file_completed" }],
  ["opposite Office settlement", { settlementKind: "office_local_chain_completed" }],
  ["unknown outcome", { settlementKind: "unknown_outcome" }],
  ["missing launch", { launchedAt: undefined }],
  ["missing settlement clock", { settledAt: undefined }],
]) {
  test(`Office published receipt does not accept ${label}`, async t => {
    const f = await officeJournalFixture(t);
    assert.throws(() => receipt(f, change), rejected);
    assert.throws(() => verifyHostOperationSafe(f.database, candidate(f, "producer", change)), rejected);
  });
}
test("Office completion cannot be safe without an Office evidence scope", async t => {
  const f = await officeJournalFixture(t);
  assert.throws(() => verifyHostOperationSafe(f.database, candidate(f, "producer", { evidenceRef: undefined })), rejected);
});

for (const [label, change] of [
  ["failed terminal", f => { f.terminal.outcome = "failed"; }],
  ["unknown terminal", f => { f.terminal.outcome = "unknown"; }],
  ["publication never entered", f => { f.terminal.publicationEntered = false; }],
  ["Host unconfirmed", f => { f.effects[0].observation.host = { state: "unconfirmed", errorCode: "commit" }; }],
  ["missing observation", f => { f.effects[0].observation = null; delete f.effects[0].effect.observationArtifactId; }],
  ["missing fsync", f => { f.effects[2].effect.kind = "close"; f.effects[2].observation.native.result.kind = "close"; }],
  ["missing first FD fstat", f => { delete f.effects[0].observation.openResource; }],
  ["retained resource", f => { f.terminal.resources[0].state = "retained"; delete f.terminal.resources[0].closeEffectId; }],
  ["incomplete final read roster", f => { f.terminal.resources.pop(); }],
]) {
  test(`Office incomplete/uncertain resealed history remains unsafe: ${label}`, async t => {
    const f = await officeJournalFixture(t); change(f); f.writeHistory();
    assert.throws(() => receipt(f), rejected);
    assert.throws(() => verifyHostOperationSafe(f.database, candidate(f)), rejected);
    assert.equal(f.store.listHostOperationBlockers(f.source).length, 2);
  });
}
for (const [label, sql, parameters] of [
  ["no terminal row", "DELETE FROM host_office_local_terminals", []],
  ["unsealed terminal artifact", "UPDATE artifacts SET sealed_payload_json=NULL WHERE id='terminal-artifact'", []],
  ["terminal digest", "UPDATE artifacts SET content_sha256=? WHERE id='terminal-artifact'", ["e".repeat(64)]],
  ["terminal row effect count", "UPDATE host_office_local_terminals SET effect_count=effect_count+1", []],
  ["terminal effect-set digest", "UPDATE host_office_local_terminals SET effect_set_digest=?", ["e".repeat(64)]],
  ["unsealed original observation", "UPDATE artifacts SET sealed_payload_json=NULL WHERE id='observation-0'", []],
  ["original observation digest", "UPDATE artifacts SET content_sha256=? WHERE id='observation-0'", ["e".repeat(64)]],
  ["sealed after settlement", "UPDATE artifacts SET created_at=? WHERE id='terminal-artifact'", ["2026-09-02T00:00:00.000Z"]],
]) {
  test(`Office unsealed/tampered SQLite proof cannot settle: ${label}`, async t => {
    const f = await officeJournalFixture(t); f.database.prepare(sql).run(...parameters);
    assert.throws(() => receipt(f), rejected);
  });
}

test("safe getter, blockers and restarted getter all reverify the same Office terminal", async t => {
  const f = await officeJournalFixture(t); f.settleRecord("producer"); f.settleRecord("parent");
  const restarted = f.reopen();
  f.database.prepare("UPDATE artifacts SET content_sha256=? WHERE id='terminal-artifact'").run("e".repeat(64));
  for (const store of [f.store, restarted]) {
    assert.throws(() => store.getHostOperation("producer"), rejected);
    assert.throws(() => store.getHostOperation("parent"), rejected);
    assert.throws(() => store.listHostOperationBlockers(f.source), rejected);
  }
});

test("Office consumer preserves recursively reserved nested legacy no-start children", async t => {
  const f = await officeJournalFixture(t);
  f.insertOperation("legacy-child", "hydration", "producer", "resolver");
  f.insertOperation("legacy-grandchild", "cleanup", "legacy-child", "bounded-cleanup");
  assert.throws(() => f.settleRecord("producer"), rejected);
  f.settleRecord("legacy-grandchild", "known_no_start");
  assert.throws(() => f.settleRecord("producer"), rejected);
  f.settleRecord("legacy-child", "known_no_start");
  f.settleRecord("producer"); f.settleRecord("parent");
  assert.deepEqual(f.reopen().listHostOperationBlockers(f.source), []);
  f.database.prepare("UPDATE host_operations SET evidence_digest=? WHERE operation_id='legacy-grandchild'").run("e".repeat(64));
  assert.throws(() => f.store.getHostOperation("parent"), rejected);
});

test("Office terminal seal cannot omit or alias exact original effect refs", async t => {
  const f = await officeJournalFixture(t); f.settleRecord("producer"); f.settleRecord("parent");
  const changed = officeJournalClone(f.terminal);
  changed.effects[1].observation.artifactId = changed.effects[0].observation.artifactId;
  f.seal("terminal-artifact", changed, changed.completedAt);
  assert.throws(() => f.reopen().getHostOperation("parent"), rejected);
});

test("Office public safe verification rejects an uncommitted internal binary candidate", async t => {
  const f = await officeJournalFixture(t);
  assert.match(verifyHostOperationSettlementCandidate(f.database, candidate(f)), /^[a-f0-9]{64}$/,
    "the explicitly internal calculator can prove facts without issuing a public safe row");
  assert.throws(() => verifyHostOperationSafe(f.database, candidate(f)), rejected,
    "a synthetic safe candidate is not an already committed whole pair");
  assert.throws(() => verifyHostOfficeReceipt(f.database, candidate(f)), rejected,
    "the domain consumer also defaults to committed history, not a detached candidate");
  f.settleRecord("producer"); f.settleRecord("parent");
  const detached = { ...f.read("producer"), admittedAt: new Date(Date.parse(f.admittedAt) - 10).toISOString() };
  assert.throws(() => verifyHostOperationSafe(f.database, detached), rejected,
    "a changed candidate must not borrow an already committed pair's safe receipt");
  assert.throws(() => verifyHostOfficeReceipt(f.database, detached), rejected);
});

test("Office internal settlement candidate still rejects an unknown original counterpart", async t => {
  const f = await officeJournalFixture(t);
  f.database.prepare(`UPDATE host_operations SET phase='unknown_outcome',settled_at=?,settlement_kind='unknown_outcome',
    settlement_signature=?,code='commit_return_lost' WHERE operation_id='parent'`)
    .run(f.settledAt, JSON.stringify({ kind: "unknown_outcome", settledAt: f.settledAt, code: "commit_return_lost" }));
  assert.throws(() => receipt(f), rejected);
  assert.throws(() => verifyHostOperationSettlementCandidate(f.database, candidate(f)), rejected,
    "internal digest calculation cannot relabel the original unknown pair as a successful candidate");
});

for (const [label, change] of [
  ["retained launched counterpart", f => f.database.prepare(`UPDATE host_operations SET phase='launched',settled_at=NULL,
    settlement_kind=NULL,evidence_digest=NULL,settlement_signature=NULL,code=NULL WHERE operation_id='parent'`).run()],
  ["unknown counterpart", f => f.database.prepare(`UPDATE host_operations SET phase='unknown_outcome',settlement_kind='unknown_outcome',
    evidence_digest=NULL,settlement_signature=?,code='commit_return_lost' WHERE operation_id='parent'`)
    .run(JSON.stringify({ kind: "unknown_outcome", settledAt: f.settledAt, code: "commit_return_lost" }))],
  ["malformed safe counterpart digest", f => f.database.prepare("UPDATE host_operations SET evidence_digest=? WHERE operation_id='parent'")
    .run("e".repeat(64))],
  ["wrong safe counterpart settlement", f => f.database.prepare("UPDATE host_operations SET settlement_kind='file_completed' WHERE operation_id='parent'").run()],
  ["malformed safe counterpart signature", f => f.database.prepare("UPDATE host_operations SET settlement_signature='not-a-settlement-intent' WHERE operation_id='parent'").run()],
  ["different safe counterpart settlement clock", f => {
    const settledAt = new Date(Date.parse(f.settledAt) + 10).toISOString();
    f.database.prepare("UPDATE host_operations SET settled_at=?,settlement_signature=? WHERE operation_id='parent'")
      .run(settledAt, JSON.stringify({ kind: "office_local_chain_completed", settledAt }));
  }],
]) {
  test(`Office public binary safe receipt rejects ${label}`, async t => {
    const f = await officeJournalFixture(t); f.settleRecord("producer"); f.settleRecord("parent");
    change(f);
    for (const store of [f.store, f.reopen()]) {
      assert.throws(() => store.getHostOperation("producer"), rejected,
        "the original binary role must not remain independently safe");
    }
  });
}

test("Office public binary safe receipt retains complete parent extra-child fan-in", async t => {
  const f = await officeJournalFixture(t); f.settleRecord("producer"); f.settleRecord("parent");
  // The narrow fixture permits an adversarial historical row. Production
  // admission guards forbid adding a child after settlement; public reads must
  // still refuse a supposedly safe pair whose reserved roster is incomplete.
  f.insertOperation("reserved-parent-extra", "hydration", "parent", "resolver-extra");
  for (const store of [f.store, f.reopen()]) {
    assert.throws(() => store.getHostOperation("parent"), rejected);
    assert.throws(() => store.getHostOperation("producer"), rejected,
      "binary's public read must include the chain's additional reserved child");
  }
});

test("Office public binary safe receipt detects a corrupt parent extra-child recursive digest", async t => {
  const f = await officeJournalFixture(t);
  f.insertOperation("reserved-parent-extra", "hydration", "parent", "resolver-extra");
  f.insertOperation("reserved-parent-grandchild", "cleanup", "reserved-parent-extra", "cleanup-extra");
  f.settleRecord("reserved-parent-grandchild", "known_no_start");
  f.settleRecord("reserved-parent-extra", "known_no_start");
  f.settleRecord("producer"); f.settleRecord("parent");
  f.database.prepare("UPDATE host_operations SET evidence_digest=? WHERE operation_id='reserved-parent-grandchild'").run("e".repeat(64));
  for (const store of [f.store, f.reopen()]) {
    assert.throws(() => store.getHostOperation("producer"), rejected,
      "public binary cannot bypass a corrupt grandchild under the chain's other producer");
  }
});
