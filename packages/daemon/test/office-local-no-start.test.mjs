import assert from "node:assert/strict";
import fs, { existsSync } from "node:fs";
import test from "node:test";
import { createSqliteRunStore, HOST_OFFICE_LOCAL_PROTOCOL } from "@ling-stack/core";
import { AttemptHostOperationTracker } from "../dist/runtime/attempt-host-operation-tracker.js";
import { closeOfficeLocalReservation } from "../dist/features/office-documents/office-local-authority.js";
import { executeOfficeLocalWrite, OfficeLocalWriterError } from "../dist/features/office-documents/office-local-writer.js";
import { createOfficeSettlementFixture, officeSettlementNow as now, patchOfficeSettlementFs,
  readOfficePairRows, requiredOfficeSettlementInput as required } from "./support/office-local-settlement-fixture.mjs";

const code = expected => error => error.code === expected;
const later = at => new Date(Date.parse(at) + 60_000).toISOString();
const MUTATORS = ["mkdirSync", "openSync", "writeSync", "fsyncSync", "closeSync", "linkSync", "renameSync", "unlinkSync", "rmdirSync"];
const OPEN_MUTATION_FLAGS = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND;
const isMutatingOpen = flags => typeof flags === "number" ? (flags & OPEN_MUTATION_FLAGS) !== 0
  : typeof flags === "string" && /[wa+]/u.test(flags);

/** Count real native calls; every wrapper delegates without changing its return/throw behavior. */
function countNative(t) {
  const counts = Object.fromEntries(MUTATORS.map(name => [name, 0]));
  let readonlyOpens = 0;
  const restores = MUTATORS.map(name => patchOfficeSettlementFs(t, name, original => (...args) => {
    if (name !== "openSync" || isMutatingOpen(args[1])) counts[name]++;
    else readonlyOpens++;
    return original(...args);
  }));
  return { counts, get readonlyOpens() { return readonlyOpens; }, restore: () => { for (const restore of restores.reverse()) restore(); } };
}

function assertZeroNative(native) {
  assert.deepEqual(native.counts, Object.fromEntries(MUTATORS.map(name => [name, 0])));
  assert.equal(native.readonlyOpens, 0);
}

/** Public receipt assertions use the independent getter, never a failed terminal or caller boolean. */
function assertNoStartPair(f, pair, store = f.store) {
  const receipt = store.getHostOfficeLocalNoStartReceipt(f.plan.executionId);
  assert.ok(receipt, "the original closed pair needs its own independently verified no-start receipt");
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.protocol, HOST_OFFICE_LOCAL_PROTOCOL);
  assert.equal(receipt.kind, "office_local_no_start_v1"); assert.equal(receipt.executionId, f.plan.executionId);
  assert.equal(receipt.executionIdentityDigest, f.prepared.identityDigest); assert.deepEqual(receipt.source, f.source);
  assert.equal(receipt.parentOperationId, f.state.parent.operationId); assert.equal(receipt.producerOperationId, f.state.producer.operationId);
  assert.equal(receipt.toolCallId, f.prepared.toolCallId);
  assert.equal(receipt.preparedArtifactId, f.prepared.preparedArtifactId); assert.equal(receipt.preparedDigest, f.prepared.preparedDigest);
  assert.match(receipt.receiptDigest, /^[a-f0-9]{64}$/); assert.equal(new Date(receipt.closedAt).toISOString(), receipt.closedAt);
  assert.ok(receipt.closedAt >= f.prepared.preparedAt);
  assert.deepEqual(receipt.effects, store.listHostOfficeLocalEffects(f.plan.executionId).map(effect => ({
    ordinal: effect.ordinal, effectId: effect.effectId, effectDigest: effect.effectDigest,
  })));
  for (const effect of store.listHostOfficeLocalEffects(f.plan.executionId)) {
    assert.equal(effect.enteredAt, undefined); assert.ok(receipt.closedAt >= effect.preparedAt);
  }
  for (const descendant of receipt.requiredDescendants) {
    const row = store.getHostOperation(descendant.operationId);
    assert.equal(row.phase, "safe"); assert.equal(row.settlementKind, "known_no_start");
    assert.equal(row.evidenceDigest, descendant.evidenceDigest); assert.deepEqual(row.source, f.source);
    assert.ok(receipt.closedAt >= row.settledAt);
  }
  for (const [role, kind] of [["parent", "office_local_chain_execution"], ["producer", "office_local_binary_execution"]]) {
    const row = pair[role];
    assert.equal(row.operationId, f.state[role].operationId); assert.equal(row.phase, "safe");
    assert.equal(row.settlementKind, "known_no_start"); assert.equal(row.launchedAt, undefined);
    assert.deepEqual(row.source, f.source); assert.deepEqual(row.evidenceRef, { kind, id: f.plan.executionId });
    assert.match(row.evidenceDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(store.getHostOperation(row.operationId), row);
  }
  assert.equal(pair.parent.settledAt, pair.producer.settledAt);
  for (const row of readOfficePairRows(f, store)) {
    assert.equal(row.phase, "safe"); assert.equal(row.launched_at, null); assert.equal(row.settlement_kind, "known_no_start");
    assert.equal(row.settlement_signature, JSON.stringify({ kind: "known_no_start", settledAt: pair.parent.settledAt }));
  }
  assert.deepEqual(store.listHostOperationBlockers(f.source), []);
  return receipt;
}

function assertAdmittedPair(f, before) {
  assert.deepEqual(readOfficePairRows(f), before);
  assert.ok(before.every(row => row.phase === "admitted" && row.launched_at === null && row.settled_at === null));
  assert.equal(f.store.getHostOfficeLocalNoStartReceipt(f.plan.executionId), undefined);
  const blockers = new Set(f.store.listHostOperationBlockers(f.source).map(row => row.operationId));
  assert.ok(blockers.has(f.state.parent.operationId)); assert.ok(blockers.has(f.state.producer.operationId));
}

/** A second real connection proves both rows and the receipt COMMIT before either local release. */
function recordCommittedReleases(t, f, observer) {
  const released = [], settle = f.tracker.executorGroup.settleHostCall.bind(f.tracker.executorGroup);
  f.tracker.executorGroup.settleHostCall = (ticket, proof) => {
    assert.ok(readOfficePairRows(f, observer).every(row => row.phase === "safe" && row.settlement_kind === "known_no_start"
      && row.launched_at === null && row.settled_at !== null));
    assert.ok(observer.getHostOfficeLocalNoStartReceipt(f.plan.executionId));
    assert.equal(proof.kind, "known_no_start"); released.push(ticket.id);
    return settle(ticket, proof);
  };
  t.after(() => { f.tracker.executorGroup.settleHostCall = settle; });
  return released;
}

function unenteredEffect(f, effectId = "never-entered-open") {
  return f.tracker.prepareOfficeLocalEffect(f.state.ticket, { effectId, ordinal: 0, memberId: "temporary",
    kind: "open", mode: "forward", resourceLifetimeId: `resource-${effectId}`, preparedAt: now() });
}

/** Permanent version of the actual ignored-output repro; missing new APIs are not product RED evidence. */
test("Office no-start required-close refuses the real writer then commits the original pair before local release", async t => {
  const f = await createOfficeSettlementFixture(t, { path: "never-started/result.docx" }), before = readOfficePairRows(f);
  const observer = createSqliteRunStore(f.cwd); t.after(() => observer.close());
  assert.equal(before.length, 2); assert.ok(before.every(row => row.phase === "admitted" && row.launched_at === null));
  assert.deepEqual(f.store.listHostOfficeLocalEffects(f.plan.executionId), []);
  const native = countNative(t), released = recordCommittedReleases(t, f, observer);
  const launch = f.store.launchHostOfficeLocalEffect.bind(f.store);
  let launchApiCalls = 0, callbackEntries = 0, writerFailure;
  f.store.launchHostOfficeLocalEffect = (ticket, effectId, callback) => {
    launchApiCalls++;
    return launch(ticket, effectId, () => { callbackEntries++; return callback(); });
  };
  t.after(() => { f.store.launchHostOfficeLocalEffect = launch; });
  f.tracker.executorGroup.closeAdmission(required);
  assert.throws(() => {
    try { executeOfficeLocalWrite(f.plan); } catch (error) { writerFailure = error; throw error; }
  }, OfficeLocalWriterError);
  assert.equal(writerFailure.cause?.code, "attempt_execution_admission_closed");
  assert.equal(writerFailure.observation.outcome, "failed"); assert.equal(writerFailure.observation.publicationEntered, false);
  assert.deepEqual(writerFailure.observation.effectIds, []); assert.deepEqual(writerFailure.observation.resources, []);
  assert.equal(writerFailure.terminalSealConfirmed, true, "a failed terminal seal is not itself a no-start receipt");
  assert.equal(callbackEntries, 0); assert.equal(launchApiCalls, 0); assertZeroNative(native);
  assert.equal(existsSync(f.prepared.targetPath), false); assert.equal(existsSync(f.temporary), false);
  for (const directory of f.prepared.members.filter(member => member.role === "directory")) assert.equal(existsSync(directory.path), false);
  assertAdmittedPair(f, before); assert.deepEqual(released, []);
  const pair = f.tracker.settleOfficeLocalFromStore(f.state.ticket), receipt = assertNoStartPair(f, pair);
  assert.deepEqual(receipt.requiredDescendants, []); assert.deepEqual(receipt.effects, []);
  assertNoStartPair(f, pair, observer);
  assert.deepEqual(released, [f.state.producer.operationId, f.state.parent.operationId]);
  assert.equal((await f.tracker.executorGroup.observeDrain(0)).status, "settled");
  assert.throws(() => executeOfficeLocalWrite(f.plan), /already_entered|closed|sealed|settled/u);
  assert.equal(callbackEntries, 0); assertZeroNative(native); native.restore();
});

test("Office no-start original live ticket closes a prepared unentered effect roster and survives reopen without native reads", async t => {
  const f = await createOfficeSettlementFixture(t), effect = unenteredEffect(f), native = countNative(t);
  assert.equal(f.store.getHostOfficeLocalTerminal(f.plan.executionId), undefined);
  const pair = f.tracker.settleOfficeLocalFromStore(f.state.ticket), receipt = assertNoStartPair(f, pair);
  assert.deepEqual(receipt.effects, [{ ordinal: 0, effectId: effect.effectId, effectDigest: effect.effectDigest }]);
  assert.deepEqual(receipt.requiredDescendants, []); assertZeroNative(native); native.restore();
  const reopened = createSqliteRunStore(f.cwd); t.after(() => reopened.close());
  const memberPaths = new Set([f.cwd, ...f.prepared.members.map(member => member.path)]);
  for (const name of ["openSync", "lstatSync", "readFileSync", "readSync", "fstatSync"]) {
    patchOfficeSettlementFs(t, name, original => (...args) => {
      if (memberPaths.has(args[0]) || typeof args[0] === "number") assert.fail(`historical no-start getter consulted ${name}`);
      return original(...args);
    });
  }
  assert.deepEqual(reopened.getHostOfficeLocalNoStartReceipt(f.plan.executionId), receipt);
  assertNoStartPair(f, pair, reopened);
  assert.equal(reopened.getHostOfficeLocalNoStartReceipt("foreign-execution"), undefined);
});

test("Office no-start unprepared reservation closure rejects a late serializer preparation without binding either role", async t => {
  const f = await createOfficeSettlementFixture(t, { prepare: false });
  const ids = [...f.durableTickets.keys()], before = ids.map(id => f.store.getHostOperation(id)), native = countNative(t);
  closeOfficeLocalReservation(f.reservation);
  assert.throws(() => f.prepare(), /closed/u); assertZeroNative(native);
  assert.deepEqual(ids.map(id => f.store.getHostOperation(id)), before);
  assert.equal(f.store.database.prepare("SELECT count(*) n FROM host_office_local_executions").get().n, 0);
  assert.ok(before.every(row => row.phase === "admitted" && row.evidenceRef === undefined)); native.restore();
});

test("Office no-start prepared reservation and unused plan share irreversible closure before any native launch", async t => {
  const f = await createOfficeSettlementFixture(t), before = readOfficePairRows(f), native = countNative(t);
  closeOfficeLocalReservation(f.reservation); closeOfficeLocalReservation(f.reservation);
  assert.equal(f.state.used, false);
  assert.throws(() => executeOfficeLocalWrite(f.plan), /closed/u);
  assert.throws(() => f.prepare(), /closed|invalid/u);
  assert.equal(f.state.used, false); assertZeroNative(native); assertAdmittedPair(f, before);
  assert.deepEqual(f.store.listHostOfficeLocalEffects(f.plan.executionId), []);
  assertNoStartPair(f, f.tracker.settleOfficeLocalFromStore(f.state.ticket)); assertZeroNative(native); native.restore();
});

test("Office no-start pending complete descendant roster blocks early receipt and closes only after every original child", async t => {
  const f = await createOfficeSettlementFixture(t);
  const first = f.tracker.registerProducer(f.state.parent, "hydration", "extra-parent");
  const nested = f.tracker.registerProducer(f.state.producer, "hydration", "extra-binary");
  const leaf = f.tracker.registerProducer(nested, "cleanup", "extra-nested");
  const before = readOfficePairRows(f), early = now(); closeOfficeLocalReservation(f.reservation);
  assert.throws(() => f.store.settleHostOfficeLocalExecution(f.state.ticket, { settledAt: early })); assertAdmittedPair(f, before);
  f.tracker.settleNoStart(first);
  assert.throws(() => f.store.settleHostOfficeLocalExecution(f.state.ticket, { settledAt: early })); assertAdmittedPair(f, before);
  f.tracker.settleNoStart(leaf);
  assert.throws(() => f.store.settleHostOfficeLocalExecution(f.state.ticket, { settledAt: early })); assertAdmittedPair(f, before);
  const nestedRow = f.tracker.settleNoStart(nested), pair = f.tracker.settleOfficeLocalFromStore(f.state.ticket);
  const receipt = assertNoStartPair(f, pair);
  const expected = [first, nested, leaf].map(handle => f.store.getHostOperation(handle.operationId)).map(row => ({
    operationId: row.operationId, evidenceDigest: row.evidenceDigest,
  })).sort((a, b) => a.operationId.localeCompare(b.operationId));
  assert.deepEqual([...receipt.requiredDescendants].sort((a, b) => a.operationId.localeCompare(b.operationId)), expected);
  assert.equal(receipt.requiredDescendants.some(row => row.operationId === f.state.producer.operationId), false);
  assert.ok(receipt.closedAt >= nestedRow.settledAt, "early private closure cannot freeze a receipt before the last child is safe");
});

test("Office no-start unknown required child remains a blocker and cannot mint an original pair receipt", async t => {
  const f = await createOfficeSettlementFixture(t), child = f.tracker.registerProducer(f.state.parent, "hydration", "unknown-extra");
  f.tracker.markUnknown(child, "no_start_extra_unknown"); const before = readOfficePairRows(f);
  assert.throws(() => f.store.settleHostOfficeLocalExecution(f.state.ticket));
  assert.throws(() => f.tracker.settleOfficeLocalFromStore(f.state.ticket)); assertAdmittedPair(f, before);
  assert.equal(f.store.getHostOperation(child.operationId).phase, "unknown_outcome");
  assert.equal(f.store.listHostOperationBlockers(f.source).length, 3);
});

test("Office no-start callback entry with native not-entered cannot be relabeled as known no-start", async t => {
  const f = await createOfficeSettlementFixture(t), guard = f.state.ledger.assertCurrent.bind(f.state.ledger);
  let guards = 0, nativeOpens = 0, failure;
  f.state.ledger.assertCurrent = () => {
    if (++guards === 2) throw Object.assign(new Error("pre-native ledger guard refused"), { code: "EIO" });
    return guard();
  };
  patchOfficeSettlementFs(t, "openSync", original => (...args) => {
    if (args[0] === f.temporary && isMutatingOpen(args[1])) nativeOpens++;
    return original(...args);
  });
  assert.throws(() => { try { executeOfficeLocalWrite(f.plan); } catch (error) { failure = error; throw error; } }, OfficeLocalWriterError);
  assert.equal(nativeOpens, 0);
  const effect = f.store.listHostOfficeLocalEffects(f.plan.executionId)[0];
  assert.ok(effect.enteredAt); assert.deepEqual(f.store.getArtifact(effect.observationArtifactId).sealedPayload.native, { state: "not_entered" });
  assert.equal(failure.observation.outcome, "failed");
  assert.throws(() => f.store.settleHostOfficeLocalExecution(f.state.ticket));
  assert.throws(() => f.tracker.settleOfficeLocalFromStore(f.state.ticket));
  assert.equal(f.store.getHostOfficeLocalNoStartReceipt(f.plan.executionId), undefined);
  assert.equal(f.store.listHostOperationBlockers(f.source).length, 2);
});

for (const afterCommit of [false, true]) {
  test(`Office no-start ${afterCommit ? "actual COMMIT return loss" : "COMMIT rollback"} retains original intent without releasing or repeating native work`, async t => {
    const f = await createOfficeSettlementFixture(t), observer = createSqliteRunStore(f.cwd), before = readOfficePairRows(f);
    t.after(() => observer.close()); const exec = f.store.database.exec.bind(f.store.database), native = countNative(t), settledAt = now();
    const released = recordCommittedReleases(t, f, observer); let injected = false;
    f.store.database.exec = sql => {
      if (sql === "COMMIT" && !injected && readOfficePairRows(f).every(row => row.phase === "safe")) {
        injected = true;
        assert.deepEqual(readOfficePairRows(f, observer), before, "the independent connection sees neither uncommitted safe role");
        assert.equal(observer.getHostOfficeLocalNoStartReceipt(f.plan.executionId), undefined);
        if (afterCommit) exec(sql);
        throw Object.assign(new Error("no_start_pair_commit_return_lost"), { code: "EIO" });
      }
      return exec(sql);
    };
    t.after(() => { f.store.database.exec = exec; });
    assert.throws(() => f.store.settleHostOfficeLocalExecution(f.state.ticket, { settledAt }), /no_start_pair_commit_return_lost/u);
    assert.equal(injected, true); assert.deepEqual(released, []); assertZeroNative(native);
    if (afterCommit) {
      assert.ok(readOfficePairRows(f, observer).every(row => row.phase === "safe"));
      assert.ok(observer.getHostOfficeLocalNoStartReceipt(f.plan.executionId));
    } else assertAdmittedPair(f, before);
    assert.throws(() => f.store.settleHostOfficeLocalExecution(f.state.ticket, { settledAt: later(settledAt) }), code("host_operation_settlement_conflict"));
    const pair = f.store.settleHostOfficeLocalExecution(f.state.ticket, { settledAt }), receipt = assertNoStartPair(f, pair, observer);
    const committed = readOfficePairRows(f);
    assert.deepEqual(f.store.settleHostOfficeLocalExecution(f.state.ticket, { settledAt }), pair);
    assert.deepEqual(readOfficePairRows(f), committed); assert.deepEqual(released, []);
    f.tracker.executorGroup.closeAdmission(required);
    assert.deepEqual(f.tracker.settleOfficeLocalFromStore(f.state.ticket), pair);
    assert.deepEqual(released, [f.state.producer.operationId, f.state.parent.operationId]);
    assert.deepEqual(f.store.getHostOfficeLocalNoStartReceipt(f.plan.executionId), receipt); assertZeroNative(native); native.restore();
  });
}

test("Office no-start tracker reconciles a real COMMIT return loss before either original local barrier releases", async t => {
  const f = await createOfficeSettlementFixture(t), observer = createSqliteRunStore(f.cwd), before = readOfficePairRows(f);
  t.after(() => observer.close()); const exec = f.store.database.exec.bind(f.store.database), released = recordCommittedReleases(t, f, observer);
  let injected = false;
  f.store.database.exec = sql => {
    if (sql === "COMMIT" && !injected && readOfficePairRows(f).every(row => row.phase === "safe")) {
      injected = true; assert.deepEqual(readOfficePairRows(f, observer), before); assert.deepEqual(released, []);
      exec(sql); throw Object.assign(new Error("no_start_tracker_commit_return_lost"), { code: "EIO" });
    }
    return exec(sql);
  };
  t.after(() => { f.store.database.exec = exec; }); f.tracker.executorGroup.closeAdmission(required);
  const pair = f.tracker.settleOfficeLocalFromStore(f.state.ticket); assert.equal(injected, true);
  assertNoStartPair(f, pair, observer); assert.deepEqual(released, [f.state.producer.operationId, f.state.parent.operationId]);
  assert.equal((await f.tracker.executorGroup.observeDrain(0)).status, "settled");
});

test("Office no-start copied foreign and reopened capabilities cannot issue a receipt from admitted zero-effect rows", async t => {
  const f = await createOfficeSettlementFixture(t), before = readOfficePairRows(f), reopened = createSqliteRunStore(f.cwd);
  t.after(() => reopened.close());
  for (const ticket of [{ ...f.state.ticket }, Object.create(f.state.ticket), { executionId: f.plan.executionId }, undefined]) {
    assert.throws(() => f.store.settleHostOfficeLocalExecution(ticket), code("host_office_local_invalid_ticket"));
    assert.throws(() => f.tracker.settleOfficeLocalFromStore(ticket), code("attempt_host_operation_invalid_office_ticket"));
  }
  const foreign = new AttemptHostOperationTracker({ store: f.store, source: { ...f.source, attemptId: "foreign-attempt" } });
  assert.throws(() => foreign.settleOfficeLocalFromStore(f.state.ticket), code("attempt_host_operation_invalid_office_ticket"));
  assert.throws(() => reopened.settleHostOfficeLocalExecution(f.state.ticket), code("host_office_local_invalid_ticket"));
  assert.throws(() => reopened.settleHostOfficeLocalExecution({ executionId: f.plan.executionId }), code("host_office_local_invalid_ticket"));
  assert.equal(reopened.getHostOfficeLocalNoStartReceipt(f.plan.executionId), undefined); assertAdmittedPair(f, before);
});

test("Office no-start obsolete original source cannot settle after a real successor replaces its owner", async t => {
  const f = await createOfficeSettlementFixture(t), before = readOfficePairRows(f), native = countNative(t);
  f.replaceOwner();
  assert.throws(() => f.store.settleHostOfficeLocalExecution(f.state.ticket), code("host_operation_stale_owner"));
  assert.throws(() => f.tracker.settleOfficeLocalFromStore(f.state.ticket), code("host_operation_stale_owner"));
  assertAdmittedPair(f, before); assertZeroNative(native); native.restore();
});

test("Office no-start committed closure forbids original plan effect launch preparation and additional children", async t => {
  const f = await createOfficeSettlementFixture(t), effect = unenteredEffect(f), pair = f.tracker.settleOfficeLocalFromStore(f.state.ticket);
  const receipt = assertNoStartPair(f, pair), before = readOfficePairRows(f), roster = f.store.listHostOfficeLocalEffects(f.plan.executionId);
  const native = countNative(t); let callbacks = 0;
  assert.equal(f.state.used, false); assert.throws(() => executeOfficeLocalWrite(f.plan), /closed|sealed|settled/u);
  assert.throws(() => f.prepare(), /closed|invalid/u);
  assert.throws(() => f.store.launchHostOfficeLocalEffect(f.state.ticket, effect.effectId, () => { callbacks++; }));
  assert.throws(() => f.tracker.launchOfficeLocalEffect(f.state.ticket, effect.effectId, () => { callbacks++; }));
  const late = { effectId: "late-effect", ordinal: 1, memberId: "temporary", kind: "open", mode: "forward",
    resourceLifetimeId: "resource-late-effect", preparedAt: now() };
  assert.throws(() => f.tracker.prepareOfficeLocalEffect(f.state.ticket, late));
  assert.throws(() => f.store.prepareHostOfficeLocalEffect(f.state.ticket, late));
  for (const role of ["parent", "producer"]) {
    assert.throws(() => f.tracker.registerProducer(f.state[role], "hydration", `late-${role}`));
    assert.throws(() => f.store.admitHostOperation({ operationId: `late-${role}`, source: f.source, kind: "hydration",
      toolCallId: f.prepared.toolCallId, parentOperationId: f.state[role].operationId, producerId: `late-${role}` }));
  }
  assert.equal(callbacks, 0); assertZeroNative(native); assert.deepEqual(readOfficePairRows(f), before);
  assert.deepEqual(f.store.listHostOfficeLocalEffects(f.plan.executionId), roster);
  assert.deepEqual(f.store.getHostOfficeLocalNoStartReceipt(f.plan.executionId), receipt); native.restore();
});

test("Office no-start retained real readonly resource prevents safety despite zero mutating callback entry", async t => {
  const f = await createOfficeSettlementFixture(t, { overwrite: true }), nativeClose = fs.closeSync, nativeFstat = fs.fstatSync;
  let retainedFd, callbackEntries = 0, failure;
  const launch = f.store.launchHostOfficeLocalEffect.bind(f.store);
  f.store.launchHostOfficeLocalEffect = (ticket, effectId, callback) => launch(ticket, effectId, () => { callbackEntries++; return callback(); });
  t.after(() => { f.store.launchHostOfficeLocalEffect = launch; });
  patchOfficeSettlementFs(t, "openSync", original => (...args) => {
    const fd = original(...args);
    if (args[0] === f.prepared.targetPath && !isMutatingOpen(args[1])) retainedFd = fd;
    return fd;
  });
  patchOfficeSettlementFs(t, "closeSync", original => fd => {
    if (fd === retainedFd) throw Object.assign(new Error("readonly close refused before native"), { code: "EINTR" });
    return original(fd);
  });
  t.after(() => { if (retainedFd !== undefined) nativeClose(retainedFd); });
  f.tracker.executorGroup.closeAdmission(required);
  assert.throws(() => { try { executeOfficeLocalWrite(f.plan); } catch (error) { failure = error; throw error; } }, OfficeLocalWriterError);
  assert.equal(callbackEntries, 0); assert.deepEqual(f.store.listHostOfficeLocalEffects(f.plan.executionId), []);
  assert.ok(Number.isSafeInteger(retainedFd)); assert.doesNotThrow(() => nativeFstat(retainedFd));
  assert.ok(failure.observation.resources.some(resource => resource.origin === "member_read" && resource.state !== "closed"));
  const before = readOfficePairRows(f);
  assert.throws(() => f.store.settleHostOfficeLocalExecution(f.state.ticket));
  assert.throws(() => f.tracker.settleOfficeLocalFromStore(f.state.ticket)); assertAdmittedPair(f, before);
});

test("Office no-start public and reopened getters reject a corrupted original settlement signature", async t => {
  const f = await createOfficeSettlementFixture(t), pair = f.tracker.settleOfficeLocalFromStore(f.state.ticket);
  assertNoStartPair(f, pair);
  f.store.database.prepare("UPDATE host_operations SET settlement_signature=? WHERE operation_id=?")
    .run("invented-no-start-intent", f.state.producer.operationId);
  const reopened = createSqliteRunStore(f.cwd); t.after(() => reopened.close());
  for (const store of [f.store, reopened]) {
    assert.throws(() => store.getHostOfficeLocalNoStartReceipt(f.plan.executionId));
    assert.throws(() => store.getHostOperation(f.state.parent.operationId));
    assert.throws(() => store.getHostOperation(f.state.producer.operationId));
    assert.throws(() => store.listHostOperationBlockers(f.source));
  }
});
