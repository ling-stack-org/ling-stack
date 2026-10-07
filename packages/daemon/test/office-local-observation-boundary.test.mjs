import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createSqliteRunStore, HOST_OFFICE_LOCAL_PROTOCOL } from "@ling-stack/core";
import { executeOfficeLocalWrite, OfficeLocalWriterError } from "../dist/features/office-documents/office-local-writer.js";
import { createOfficeSettlementFixture, officeSettlementNow as now, patchOfficeSettlementFs,
  readOfficePairRows, requiredOfficeSettlementInput as required } from "./support/office-local-settlement-fixture.mjs";

const code = expected => error => error.code === expected;
const MUTATORS = ["mkdirSync", "openSync", "writeSync", "fsyncSync", "linkSync", "renameSync", "unlinkSync", "rmdirSync"];
const OPEN_MUTATION_FLAGS = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT
  | fs.constants.O_TRUNC | fs.constants.O_APPEND;
const isMutatingOpen = flags => typeof flags === "number" ? (flags & OPEN_MUTATION_FLAGS) !== 0
  : typeof flags === "string" && /[wa+]/u.test(flags);

/** Native bindings stay real; only the exact original readonly target close may be refused before native entry. */
function nativeBoundary(t, f, retainTarget = false) {
  const nativeClose = fs.closeSync, nativeFstat = fs.fstatSync;
  const counts = Object.fromEntries(MUTATORS.map(name => [name, 0])), restores = [];
  let readonlyOpens = 0, targetFd, targetCloseRefusals = 0, delegatedCloses = 0;
  for (const name of MUTATORS) restores.push(patchOfficeSettlementFs(t, name, original => (...args) => {
    if (name !== "openSync" || isMutatingOpen(args[1])) counts[name]++;
    else readonlyOpens++;
    const result = original(...args);
    if (retainTarget && name === "openSync" && args[0] === f.prepared.targetPath && !isMutatingOpen(args[1])) {
      assert.equal(targetFd, undefined, "the original readonly target FD must not be reopened or substituted");
      targetFd = result;
    }
    return result;
  }));
  restores.push(patchOfficeSettlementFs(t, "closeSync", original => fd => {
    if (retainTarget && fd === targetFd) {
      targetCloseRefusals++;
      throw Object.assign(new Error("original readonly close refused before native"), { code: "EINTR" });
    }
    delegatedCloses++;
    return original(fd);
  }));
  let closed = false;
  const boundary = {
    counts, get readonlyOpens() { return readonlyOpens; }, get targetFd() { return targetFd; },
    get targetCloseRefusals() { return targetCloseRefusals; }, get delegatedCloses() { return delegatedCloses; },
    fstat: () => nativeFstat(targetFd, { bigint: true }),
    restore: () => { for (const restore of restores.reverse()) restore(); },
    release: () => {
      if (targetFd === undefined || closed) return;
      nativeClose(targetFd); closed = true;
      assert.throws(() => nativeFstat(targetFd), code("EBADF"), "finally must release the real original descriptor");
    },
  };
  t.after(() => { boundary.restore(); boundary.release(); });
  return boundary;
}

function assertZeroMutation(native) {
  assert.deepEqual(native.counts, Object.fromEntries(MUTATORS.map(name => [name, 0])));
}

function assertZeroNative(native) {
  assertZeroMutation(native); assert.equal(native.readonlyOpens, 0);
  assert.equal(native.targetCloseRefusals, 0); assert.equal(native.delegatedCloses, 0);
}

/** Observe the actual callback and local barrier release points, never inferred outer method entry. */
function countHostBoundary(t, f) {
  const launch = f.store.launchHostOfficeLocalEffect.bind(f.store);
  const settleHostCall = f.tracker.executorGroup.settleHostCall.bind(f.tracker.executorGroup);
  const begin = f.store.beginHostOfficeLocalWriterObservation.bind(f.store);
  let launchCalls = 0, callbackEntries = 0, observationBegins = 0;
  const releases = [];
  f.store.beginHostOfficeLocalWriterObservation = ticket => {
    assert.equal(ticket, f.state.ticket);
    const result = begin(ticket); observationBegins++; return result;
  };
  f.store.launchHostOfficeLocalEffect = (ticket, effectId, callback) => {
    launchCalls++;
    return launch(ticket, effectId, () => { callbackEntries++; return callback(); });
  };
  f.tracker.executorGroup.settleHostCall = (ticket, proof) => {
    releases.push({ operationId: ticket.id, proofKind: proof.kind });
    return settleHostCall(ticket, proof);
  };
  t.after(() => {
    f.store.beginHostOfficeLocalWriterObservation = begin;
    f.store.launchHostOfficeLocalEffect = launch;
    f.tracker.executorGroup.settleHostCall = settleHostCall;
  });
  return { releases, get launchCalls() { return launchCalls; }, get callbackEntries() { return callbackEntries; },
    get observationBegins() { return observationBegins; } };
}

function assertAdmittedPair(f, before, host) {
  assert.deepEqual(readOfficePairRows(f), before);
  assert.ok(before.every(row => row.phase === "admitted" && row.launched_at === null && row.settled_at === null));
  assert.equal(f.store.getHostOfficeLocalNoStartReceipt(f.plan.executionId), undefined);
  const blockers = f.store.listHostOperationBlockers(f.source).map(row => row.operationId).sort();
  assert.deepEqual(blockers, [f.state.parent.operationId, f.state.producer.operationId].sort());
  assert.deepEqual(host.releases, []);
}

function effectInput(effectId = "late-effect") {
  return { effectId, ordinal: 0, memberId: "temporary", kind: "open", mode: "forward",
    resourceLifetimeId: `resource-${effectId}`, preparedAt: now() };
}

/** Exact original ticket latches must remain closed after rejected settlement, not merely roll back SQL rows. */
function assertObservationAndEffectsClosed(f) {
  assert.throws(() => f.store.beginHostOfficeLocalWriterObservation(f.state.ticket), code("host_office_local_execution_closed"));
  assert.throws(() => f.store.prepareHostOfficeLocalEffect(f.state.ticket, effectInput()), code("host_office_local_execution_closed"));
  assert.throws(() => f.tracker.beginOfficeLocalWriterObservation(f.state.ticket), /closed/u);
  assert.throws(() => executeOfficeLocalWrite(f.plan), /closed|already_entered/u);
  assert.deepEqual(f.store.listHostOfficeLocalEffects(f.plan.executionId), []);
}

for (const persistence of ["terminal COMMIT rollback", "terminal artifact precreate failure"]) {
  test(`Office started observation retains a real readonly FD through ${persistence} and cannot mint no-start safety`, async t => {
    const f = await createOfficeSettlementFixture(t, { overwrite: true }), before = readOfficePairRows(f);
    const native = nativeBoundary(t, f, true), host = countHostBoundary(t, f);
    const prepareSql = f.store.database.prepare.bind(f.store.database), exec = f.store.database.exec.bind(f.store.database);
    const createArtifact = f.store.createArtifact.bind(f.store), seal = f.store.sealHostOfficeLocalTerminal.bind(f.store);
    let effectInsertRefusals = 0, terminalCommitRefusals = 0, artifactRefusals = 0, rollbackCount = 0, sealCalls = 0;
    const terminalInputs = [];
    // The real prepare method reaches its exact first descriptor INSERT after
    // the original observation latch succeeds; no replacement writer is used.
    f.store.database.prepare = sql => {
      if (/^INSERT INTO host_office_local_effects\(/u.test(sql)) {
        assert.equal(host.observationBegins, 1);
        effectInsertRefusals++;
        throw Object.assign(new Error("first original descriptor INSERT refused before persistence"), { code: "EIO" });
      }
      return prepareSql(sql);
    };
    f.store.createArtifact = input => {
      if (input.runId === f.source.runId && input.type === "json"
        && input.path === `office/${f.plan.executionId}/terminal.json`
        && input.sealedPayload?.protocol === HOST_OFFICE_LOCAL_PROTOCOL
        && input.sealedPayload?.kind === "office_local_terminal_v1"
        && input.sealedPayload?.executionId === f.plan.executionId
        && input.sealedPayload?.executionIdentityDigest === f.prepared.identityDigest) {
        terminalInputs.push(input);
        assert.equal(input.sealedPayload.resources.length, 1);
        assert.equal(input.sealedPayload.resources[0].origin, "member_read");
        assert.equal(input.sealedPayload.resources[0].state, "unknown");
        if (persistence === "terminal artifact precreate failure") {
          artifactRefusals++;
          throw Object.assign(new Error("exact writer terminal artifact refused before persistence"), { code: "EIO" });
        }
      }
      return createArtifact(input);
    };
    f.store.sealHostOfficeLocalTerminal = (ticket, input) => { sealCalls++; return seal(ticket, input); };
    f.store.database.exec = sql => {
      if (sql === "ROLLBACK") rollbackCount++;
      if (persistence === "terminal COMMIT rollback" && sql === "COMMIT" && terminalCommitRefusals === 0
        && prepareSql("SELECT * FROM host_office_local_terminals WHERE execution_id=?").get(f.plan.executionId)) {
        terminalCommitRefusals++;
        throw Object.assign(new Error("exact terminal COMMIT refused before native COMMIT"), { code: "EIO" });
      }
      return exec(sql);
    };
    let failure;
    try {
      assert.equal(f.tracker.executorGroup.getSnapshot().admission, "open");
      assert.throws(() => {
        try { executeOfficeLocalWrite(f.plan); } catch (error) { failure = error; throw error; }
      }, OfficeLocalWriterError);
      assert.equal(host.observationBegins, 1, "admission was open and the original writer truly entered observation");
      assert.equal(effectInsertRefusals, 1, "failure must reach the actual first effect INSERT, not early admission refusal");
      assert.equal(host.callbackEntries, 0); assert.equal(host.launchCalls, 0); assertZeroMutation(native);
      assert.equal(native.readonlyOpens, 1); assert.equal(native.targetCloseRefusals, 1); assert.equal(native.delegatedCloses, 0);
      assert.ok(Number.isSafeInteger(native.targetFd));
      const retainedBefore = native.fstat();
      assert.equal(retainedBefore.isFile(), true);
      assert.equal(failure.observation.outcome, "failed"); assert.equal(failure.observation.publicationEntered, false);
      assert.deepEqual(failure.observation.effectIds, []); assert.equal(failure.terminalSealConfirmed, false);
      const resource = failure.observation.resources[0];
      assert.equal(failure.observation.resources.length, 1);
      assert.equal(resource.origin, "member_read"); assert.equal(resource.memberId, "target"); assert.equal(resource.state, "unknown");
      assert.equal(resource.identity.device, String(retainedBefore.dev)); assert.equal(resource.identity.inode, String(retainedBefore.ino));
      assert.equal(terminalInputs.length, 1);
      assert.equal(f.store.getHostOfficeLocalTerminal(f.plan.executionId), undefined);
      assert.deepEqual(f.store.listHostOfficeLocalEffects(f.plan.executionId), []);
      assertAdmittedPair(f, before, host);
      if (persistence === "terminal COMMIT rollback") {
        assert.equal(terminalCommitRefusals, 1); assert.equal(artifactRefusals, 0); assert.equal(sealCalls, 1);
        assert.ok(rollbackCount >= 2, "both first-effect INSERT and terminal COMMIT failures roll back real SQLite transactions");
        assert.ok(f.store.getArtifact(failure.observationArtifactId));
        assert.throws(() => f.store.prepareHostOfficeLocalEffect(f.state.ticket, effectInput("claim-probe")),
          code("host_office_local_execution_sealed"), "the original private terminal claim must survive COMMIT rollback");
      } else {
        assert.equal(artifactRefusals, 1); assert.equal(terminalCommitRefusals, 0); assert.equal(sealCalls, 0);
        assert.equal(failure.observationArtifactId, undefined);
      }

      // Close the actual admission only AFTER the real observation/read/close
      // failure. The resource invariant cannot pass by denying the readonly read.
      f.tracker.executorGroup.closeAdmission(required);
      assert.equal(f.tracker.executorGroup.getSnapshot().admission, "closed");
      assert.throws(() => f.store.settleHostOfficeLocalExecution(f.state.ticket), code("host_office_local_terminal_missing"));
      assert.throws(() => f.tracker.settleOfficeLocalFromStore(f.state.ticket), code("host_office_local_terminal_missing"));
      const retainedAfter = native.fstat();
      assert.equal(retainedAfter.dev, retainedBefore.dev); assert.equal(retainedAfter.ino, retainedBefore.ino);
      assert.equal(retainedAfter.size, retainedBefore.size);
      assertAdmittedPair(f, before, host);
      assertObservationAndEffectsClosed(f);
      assertAdmittedPair(f, before, host);
      assert.equal(host.observationBegins, 1); assert.equal(host.callbackEntries, 0);
      assertZeroMutation(native); assert.equal(native.readonlyOpens, 1);
      t.diagnostic(JSON.stringify({ persistence, observationBegins: host.observationBegins,
        effectInsertRefusals, callbackEntries: host.callbackEntries, readonlyOpens: native.readonlyOpens,
        readonlyFd: native.targetFd, readonlyInode: String(retainedAfter.ino), resourceState: resource.state,
        terminalCommitRefusals, artifactRefusals, sealCalls,
        terminalRowCount: prepareSql("SELECT count(*) n FROM host_office_local_terminals WHERE execution_id=?").get(f.plan.executionId).n,
        receiptRowCount: prepareSql("SELECT count(*) n FROM host_office_local_no_start_receipts WHERE execution_id=?").get(f.plan.executionId).n,
        blockers: f.store.listHostOperationBlockers(f.source).length, releases: host.releases.length }));
    } finally {
      f.store.database.prepare = prepareSql; f.store.database.exec = exec;
      f.store.createArtifact = createArtifact; f.store.sealHostOfficeLocalTerminal = seal;
      native.restore(); native.release();
    }
  });
}

test("Office closed admission refuses the writer before any readonly resource or observation latch", async t => {
  const f = await createOfficeSettlementFixture(t, { overwrite: true }), before = readOfficePairRows(f);
  const native = nativeBoundary(t, f), host = countHostBoundary(t, f);
  f.tracker.executorGroup.closeAdmission(required);
  assert.throws(() => executeOfficeLocalWrite(f.plan), code("attempt_execution_admission_closed"));
  assert.equal(host.observationBegins, 0); assert.equal(host.launchCalls, 0); assert.equal(host.callbackEntries, 0);
  assertZeroNative(native);
  assert.deepEqual(f.store.listHostOfficeLocalEffects(f.plan.executionId), []);
  assert.equal(f.store.getHostOfficeLocalTerminal(f.plan.executionId), undefined);
  assertAdmittedPair(f, before, host);
  const pair = f.tracker.settleOfficeLocalFromStore(f.state.ticket);
  assert.equal(pair.parent.settlementKind, "known_no_start"); assert.equal(pair.producer.settlementKind, "known_no_start");
  assert.equal(pair.parent.phase, "safe"); assert.equal(pair.producer.phase, "safe");
  assert.ok(f.store.getHostOfficeLocalNoStartReceipt(f.plan.executionId));
  assert.deepEqual(f.store.listHostOperationBlockers(f.source), []);
  assert.deepEqual(host.releases.map(row => row.operationId), [f.state.producer.operationId, f.state.parent.operationId]);
  assertZeroNative(native); native.restore();
});

test("Office genuinely unused original plan still commits no-start pair before either local barrier release", async t => {
  const f = await createOfficeSettlementFixture(t, { overwrite: true }), observer = createSqliteRunStore(f.cwd);
  t.after(() => observer.close());
  const native = nativeBoundary(t, f), host = countHostBoundary(t, f);
  const settleHostCall = f.tracker.executorGroup.settleHostCall.bind(f.tracker.executorGroup);
  f.tracker.executorGroup.settleHostCall = (ticket, proof) => {
    assert.ok(readOfficePairRows(f, observer).every(row => row.phase === "safe" && row.launched_at === null
      && row.settlement_kind === "known_no_start"));
    assert.ok(observer.getHostOfficeLocalNoStartReceipt(f.plan.executionId));
    return settleHostCall(ticket, proof);
  };
  t.after(() => { f.tracker.executorGroup.settleHostCall = settleHostCall; });
  assert.equal(f.state.used, false); assert.equal(host.observationBegins, 0);
  f.tracker.executorGroup.closeAdmission(required);
  const pair = f.tracker.settleOfficeLocalFromStore(f.state.ticket);
  for (const role of ["parent", "producer"]) {
    assert.equal(pair[role].operationId, f.state[role].operationId); assert.equal(pair[role].phase, "safe");
    assert.equal(pair[role].settlementKind, "known_no_start"); assert.equal(pair[role].launchedAt, undefined);
    assert.deepEqual(f.store.getHostOperation(pair[role].operationId), pair[role]);
  }
  const receipt = f.store.getHostOfficeLocalNoStartReceipt(f.plan.executionId);
  assert.equal(receipt.executionIdentityDigest, f.prepared.identityDigest); assert.deepEqual(receipt.effects, []);
  assert.deepEqual(receipt.requiredDescendants, []); assert.deepEqual(observer.getHostOfficeLocalNoStartReceipt(f.plan.executionId), receipt);
  assert.equal(f.state.used, false); assert.equal(host.observationBegins, 0);
  assert.deepEqual(host.releases.map(row => row.operationId), [f.state.producer.operationId, f.state.parent.operationId]);
  assert.deepEqual(f.store.listHostOperationBlockers(f.source), []);
  assert.throws(() => executeOfficeLocalWrite(f.plan), code("attempt_host_operation_already_settled"));
  assertZeroNative(native); native.restore();
});

test("Office started observation without terminal rejects no-start then irreversibly closes its original marker and effects", async t => {
  const f = await createOfficeSettlementFixture(t), before = readOfficePairRows(f);
  const native = nativeBoundary(t, f), host = countHostBoundary(t, f);
  f.tracker.beginOfficeLocalWriterObservation(f.state.ticket);
  assert.equal(host.observationBegins, 1);
  assert.throws(() => f.store.beginHostOfficeLocalWriterObservation(f.state.ticket), code("host_office_local_observation_already_started"));
  assert.equal(f.store.getHostOfficeLocalTerminal(f.plan.executionId), undefined);
  assert.deepEqual(f.store.listHostOfficeLocalEffects(f.plan.executionId), []);
  assertAdmittedPair(f, before, host);
  f.tracker.executorGroup.closeAdmission(required);
  assert.throws(() => f.store.settleHostOfficeLocalExecution(f.state.ticket), code("host_office_local_terminal_missing"));
  assert.throws(() => f.tracker.settleOfficeLocalFromStore(f.state.ticket), code("host_office_local_terminal_missing"));
  assertAdmittedPair(f, before, host);
  assertObservationAndEffectsClosed(f);
  assertAdmittedPair(f, before, host);
  assert.equal(host.observationBegins, 1); assert.equal(host.callbackEntries, 0); assert.equal(host.launchCalls, 0);
  assertZeroNative(native); native.restore();
});
