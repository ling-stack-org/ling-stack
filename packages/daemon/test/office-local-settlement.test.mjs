import assert from "node:assert/strict";
import fs, { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { AttemptHostOperationTracker } from "../dist/runtime/attempt-host-operation-tracker.js";
import { executeOfficeLocalWrite, OfficeLocalWriterError } from "../dist/features/office-documents/office-local-writer.js";
import { assertOfficePairSafe, createOfficeSettlementFixture, officeSettlementNow as now,
  patchOfficeSettlementFs, readOfficePairRows, requiredOfficeSettlementInput as required } from "./support/office-local-settlement-fixture.mjs";

const code = expected => error => error.code === expected;
const later = at => new Date(Date.parse(at) + 60_000).toISOString();

function assertPairStillBlocks(f, expected = "launched") {
  for (const role of ["parent", "producer"]) {
    const row = f.store.getHostOperation(f.state[role].operationId);
    assert.equal(row.phase, expected); assert.equal(row.settledAt, undefined);
    assert.equal(row.evidenceDigest, undefined); assert.equal(row.settlementSignature, undefined);
  }
  const blocked = new Set(f.store.listHostOperationBlockers(f.source).map(row => row.operationId));
  assert.ok(blocked.has(f.state.parent.operationId)); assert.ok(blocked.has(f.state.producer.operationId));
}

test("Office prepare binds the two distinct evidence scopes atomically with its real execution", async t => {
  const f = await createOfficeSettlementFixture(t, { prepare: false });
  const admitted = [...f.durableTickets.keys()].map(id => f.store.getHostOperation(id));
  assert.equal(admitted.length, 2); assert.ok(admitted.every(row => !row.evidenceRef));
  f.store.database.exec(`CREATE TRIGGER office_test_reject_binary_binding BEFORE UPDATE OF evidence_kind ON host_operations
    WHEN NEW.evidence_kind='office_local_binary_execution'
    BEGIN SELECT RAISE(ABORT,'injected_office_binary_binding_failure'); END`);
  assert.throws(() => f.prepare(), /injected_office_binary_binding_failure/);
  assert.equal(f.store.database.prepare("SELECT count(*) n FROM host_office_local_executions").get().n, 0,
    "binary binding failure must roll back the execution and parent binding together");
  assert.deepEqual([...f.durableTickets.keys()].map(id => f.store.getHostOperation(id)), admitted);
  f.store.database.exec("DROP TRIGGER office_test_reject_binary_binding");
  // A lost preparation return is an irreversible original-reservation claim,
  // not permission to create a second artifact/ticket after rollback.
  assert.throws(() => f.prepare(), /office_local_reservation_invalid/);
  assert.equal(f.store.database.prepare("SELECT count(*) n FROM host_office_local_executions").get().n, 0);
  assert.deepEqual([...f.durableTickets.keys()].map(id => f.store.getHostOperation(id)), admitted);
  const bound = await createOfficeSettlementFixture(t);
  for (const [role, kind] of [["parent", "office_local_chain_execution"], ["producer", "office_local_binary_execution"]]) {
    const row = bound.store.getHostOperation(bound.state[role].operationId);
    assert.equal(row.phase, "admitted");
    assert.deepEqual(row.evidenceRef, { kind, id: bound.plan.executionId });
    assert.match(row.domainIdentityDigest, /^[a-f0-9]{64}$/);
    assert.throws(() => bound.store.database.prepare("UPDATE host_operations SET evidence_id=? WHERE operation_id=?")
      .run("borrowed-execution", row.operationId), /host_operation_binding_immutable/);
  }
  assertPairStillBlocks(bound, "admitted");
});

for (const variant of ["create", "overwrite", "short-write", "existing-directory"]) {
  test(`Office atomic ${variant} settlement releases binary before chain and rereads historical safe after disk changes`, async t => {
    const f = await createOfficeSettlementFixture(t, { overwrite: variant === "overwrite",
      ...(variant === "existing-directory" ? { path: "existing/nested/result.docx", existingDirectories: true } : {}) });
    let writes = 0;
    const restoreWrites = patchOfficeSettlementFs(t, "writeSync", original => (fd, bytes, offset, length, position) => {
      writes++; return original(fd, bytes, offset, variant === "short-write" ? Math.min(length, 1024) : length, position);
    });
    const result = executeOfficeLocalWrite(f.plan);
    assert.equal(result.observation.outcome, "published");
    assert.deepEqual(readFileSync(result.path), f.artifact.bytes);
    if (variant === "overwrite") assert.deepEqual(readFileSync(result.recoveryPath), f.initialBytes);
    if (variant === "short-write") assert.ok(writes > 1, "the real native writer must consume actual short-write returns");
    assertPairStillBlocks(f);
    const nativeWrites = writes, originalEffects = f.store.listHostOfficeLocalEffects(f.plan.executionId);
    const released = [], settle = f.tracker.executorGroup.settleHostCall.bind(f.tracker.executorGroup);
    f.tracker.executorGroup.settleHostCall = (ticket, proof) => {
      assert.equal(f.store.getHostOperation(f.state.parent.operationId).phase, "safe");
      assert.equal(f.store.getHostOperation(f.state.producer.operationId).phase, "safe",
        "neither in-memory role may release before both journal rows committed");
      assert.equal(proof.kind, "completed_persisted");
      assert.equal(proof.physicalScope, "entire_operation"); assert.equal(proof.effects, "persisted");
      released.push(ticket.id); return settle(ticket, proof);
    };
    t.after(() => { f.tracker.executorGroup.settleHostCall = settle; });
    f.tracker.executorGroup.closeAdmission(required);
    const pair = f.tracker.settleOfficeLocalFromStore(f.state.ticket);
    assertOfficePairSafe(f, pair);
    assert.deepEqual(released, [f.state.producer.operationId, f.state.parent.operationId]);
    assert.equal((await f.tracker.executorGroup.observeDrain(0)).status, "settled");
    assert.equal(writes, nativeWrites, "settlement must not repeat the real writer");
    assert.deepEqual(f.store.listHostOfficeLocalEffects(f.plan.executionId), originalEffects);
    restoreWrites();
    // Break today's path identity and bytes, then remove the paths. Historical SQLite
    // evidence must stay independently readable without adopting or reopening them.
    writeFileSync(result.path, "unrelated replacement written after settlement");
    fs.unlinkSync(result.path);
    if (result.recoveryPath) fs.unlinkSync(result.recoveryPath);
    const memberPaths = new Set([f.cwd, ...f.prepared.members.map(member => member.path)]);
    for (const name of ["openSync", "lstatSync", "readFileSync", "readSync", "fstatSync"]) {
      patchOfficeSettlementFs(t, name, original => (...args) => {
        if (memberPaths.has(args[0]) || typeof args[0] === "number") assert.fail(`historical Office safety consulted native ${name}`);
        return original(...args);
      });
    }
    assertOfficePairSafe(f, pair);
    assert.deepEqual(f.store.settleHostOfficeLocalExecution(f.state.ticket, { settledAt: pair.parent.settledAt }), pair);
    const reopened = createSqliteRunStore(f.cwd);
    try {
      assertOfficePairSafe(f, pair, reopened);
      assert.deepEqual(reopened.listHostOperationBlockers(f.source, pair.parent.settledAt), []);
      assert.equal(existsSync(result.path), false);
    } finally { reopened.close(); }
  });
}

test("Office copied, forged, foreign-store and reopened tickets cannot settle even a persisted successful pair", async t => {
  const f = await createOfficeSettlementFixture(t);
  executeOfficeLocalWrite(f.plan);
  for (const ticket of [{ ...f.state.ticket }, Object.create(f.state.ticket), { executionId: f.plan.executionId }, undefined]) {
    assert.throws(() => f.store.settleHostOfficeLocalExecution(ticket), code("host_office_local_invalid_ticket"));
    assert.throws(() => f.tracker.settleOfficeLocalFromStore(ticket), code("attempt_host_operation_invalid_office_ticket"));
  }
  const otherTracker = new AttemptHostOperationTracker({ store: f.store, source: f.source });
  assert.throws(() => otherTracker.settleOfficeLocalFromStore(f.state.ticket), code("attempt_host_operation_invalid_office_ticket"));
  assertPairStillBlocks(f);
  const pair = f.tracker.settleOfficeLocalFromStore(f.state.ticket);
  const reopened = createSqliteRunStore(f.cwd);
  try {
    assert.throws(() => reopened.settleHostOfficeLocalExecution(f.state.ticket), code("host_office_local_invalid_ticket"));
    assert.throws(() => reopened.settleHostOfficeLocalExecution({ executionId: f.plan.executionId }), code("host_office_local_invalid_ticket"));
    assertOfficePairSafe(f, pair, reopened);
  } finally { reopened.close(); }
});

test("Office generic safe and no-start paths reject each bound role without partially settling it", async t => {
  const f = await createOfficeSettlementFixture(t);
  for (const role of ["parent", "producer"]) {
    const ticket = f.durableTickets.get(f.state[role].operationId);
    for (const kind of ["known_no_start", "file_completed", "office_local_chain_completed", "office_local_binary_completed"]) {
      assert.throws(() => f.store.settleHostOperation(ticket, { kind }), code("host_office_local_pair_settlement_required"));
    }
    assert.throws(() => f.tracker.settleNoStart(f.state[role]), code("host_office_local_pair_settlement_required"));
  }
  assertPairStillBlocks(f, "admitted");
  executeOfficeLocalWrite(f.plan);
  for (const role of ["parent", "producer"]) {
    assert.throws(() => f.store.settleHostOperation(f.durableTickets.get(f.state[role].operationId),
      { kind: role === "parent" ? "office_local_chain_completed" : "office_local_binary_completed" }),
    code("host_office_local_pair_settlement_required"));
  }
  assertPairStillBlocks(f);
  assertOfficePairSafe(f, f.tracker.settleOfficeLocalFromStore(f.state.ticket));
});

for (const role of ["parent", "producer"]) {
  test(`Office bound original tickets reject generic launch bypass: ${role} after preparation`, async t => {
    const f = await createOfficeSettlementFixture(t), before = readOfficePairRows(f);
    const sentinel = join(f.cwd, `generic-launch-${role}-bypass.txt`);
    let callbacks = 0, failure;
    try {
      f.store.launchHostOperation(f.durableTickets.get(f.state[role].operationId), () => {
        callbacks++; writeFileSync(sentinel, "unauthorized generic Office launch");
      });
    } catch (error) { failure = error; }
    assert.equal(callbacks, 0, "a prepared Office original ticket must not enter a generic physical callback");
    assert.equal(failure?.code, "host_office_local_pair_effect_required");
    assert.equal(existsSync(sentinel), false);
    assert.deepEqual(readOfficePairRows(f), before, "generic rejection cannot launch or revise either Office role");
    assertPairStillBlocks(f, "admitted");
  });
}

for (const phase of ["unsealed", "sealed"]) {
  for (const role of ["parent", "producer"]) {
    for (const mode of ["forward", "cleanup"]) {
      test(`Office bound original tickets reject generic continue bypass: ${role} ${mode} after writer ${phase}`, async t => {
        const f = await createOfficeSettlementFixture(t);
        if (phase === "unsealed") {
          // Enter the actual SDK/native writer and every physical effect, but hold
          // the last Host seal gate. This is not a fabricated journal launch row.
          const seal = f.tracker.sealOfficeLocalTerminal.bind(f.tracker);
          f.tracker.sealOfficeLocalTerminal = () => { throw new Error("office_test_hold_before_terminal_seal"); };
          let writerFailure;
          try {
            assert.throws(() => {
              try { executeOfficeLocalWrite(f.plan); } catch (error) { writerFailure = error; throw error; }
            }, OfficeLocalWriterError);
          } finally { f.tracker.sealOfficeLocalTerminal = seal; }
          assert.equal(writerFailure.observation.outcome, "published");
          assert.equal(writerFailure.terminalSealConfirmed, false);
          assert.equal(f.store.getHostOfficeLocalTerminal(f.plan.executionId), undefined);
        } else {
          const result = executeOfficeLocalWrite(f.plan);
          assert.equal(result.observation.outcome, "published");
          assert.ok(f.store.getHostOfficeLocalTerminal(f.plan.executionId));
        }
        assert.deepEqual(readFileSync(f.prepared.targetPath), f.artifact.bytes);
        assertPairStillBlocks(f);
        const before = readOfficePairRows(f), effects = f.store.listHostOfficeLocalEffects(f.plan.executionId);
        const sentinel = join(f.cwd, `generic-continue-${role}-${mode}-bypass.txt`);
        let callbacks = 0, failure;
        try {
          f.store.continueHostOperationEffect(f.durableTickets.get(f.state[role].operationId), () => {
            callbacks++; writeFileSync(sentinel, "unauthorized generic Office continuation");
          }, mode);
        } catch (error) { failure = error; }
        assert.equal(callbacks, 0, "an entered Office original ticket cannot bypass its exact effect graph even through cleanup");
        assert.equal(failure?.code, "host_office_local_pair_effect_required");
        assert.equal(existsSync(sentinel), false);
        assert.deepEqual(readOfficePairRows(f), before, "generic rejection cannot change either original Office journal row");
        assert.deepEqual(f.store.listHostOfficeLocalEffects(f.plan.executionId), effects);
        assertPairStillBlocks(f);
      });
    }
  }
}

test("Office observed-but-unsealed execution remains an admitted blocker", async t => {
  const f = await createOfficeSettlementFixture(t);
  f.tracker.beginOfficeLocalWriterObservation(f.state.ticket);
  assert.throws(() => f.store.settleHostOfficeLocalExecution(f.state.ticket), code("host_office_local_terminal_missing"));
  assert.throws(() => f.tracker.settleOfficeLocalFromStore(f.state.ticket), code("host_office_local_terminal_missing"));
  assertPairStillBlocks(f, "admitted");
  assert.equal(f.store.getHostOfficeLocalTerminal(f.plan.executionId), undefined);
});

test("Office stale original owner cannot settle its complete real writer or release either local role", async t => {
  const f = await createOfficeSettlementFixture(t);
  executeOfficeLocalWrite(f.plan); f.replaceOwner();
  assert.throws(() => f.store.settleHostOfficeLocalExecution(f.state.ticket), code("host_operation_stale_owner"));
  assert.throws(() => f.tracker.settleOfficeLocalFromStore(f.state.ticket), code("host_operation_stale_owner"));
  assertPairStillBlocks(f);
  assert.ok(f.tracker.executorGroup.getSnapshot().operations.every(row => row.state === "launched"));
});

test("Office same-bytes external final replacement is sealed failed residue, never pair safety", async t => {
  const f = await createOfficeSettlementFixture(t), ledger = f.state.ledger;
  const observeFinal = ledger.observeFinal.bind(ledger);
  ledger.observeFinal = (...args) => {
    renameSync(f.prepared.targetPath, join(f.cwd, "writer-original.docx"));
    writeFileSync(f.prepared.targetPath, f.artifact.bytes);
    return observeFinal(...args);
  };
  t.after(() => { ledger.observeFinal = observeFinal; });
  let failure;
  assert.throws(() => { try { executeOfficeLocalWrite(f.plan); } catch (error) { failure = error; throw error; } }, OfficeLocalWriterError);
  assert.equal(failure.observation.outcome, "failed"); assert.equal(failure.terminalSealConfirmed, true);
  assert.ok(f.store.getHostOfficeLocalTerminal(f.plan.executionId));
  assert.throws(() => f.store.settleHostOfficeLocalExecution(f.state.ticket));
  assert.throws(() => f.tracker.settleOfficeLocalFromStore(f.state.ticket));
  assertPairStillBlocks(f);
  assert.deepEqual(readFileSync(f.prepared.targetPath), f.artifact.bytes);
  assert.deepEqual(readFileSync(join(f.cwd, "writer-original.docx")), f.artifact.bytes);
});

test("Office actual native write with unconfirmed Host COMMIT cannot become a safe pair", async t => {
  const f = await createOfficeSettlementFixture(t), exec = f.store.database.exec.bind(f.store.database);
  let writes = 0, injected = false;
  patchOfficeSettlementFs(t, "writeSync", original => (...args) => { const count = original(...args); writes++; return count; });
  f.store.database.exec = sql => {
    if (sql === "COMMIT" && writes > 0 && !injected) {
      injected = true; throw Object.assign(new Error("native_write_host_commit_unconfirmed"), { code: "EIO" });
    }
    return exec(sql);
  };
  t.after(() => { f.store.database.exec = exec; });
  assert.throws(() => executeOfficeLocalWrite(f.plan), OfficeLocalWriterError);
  assert.equal(injected, true); assert.equal(writes, 1);
  const write = f.store.listHostOfficeLocalEffects(f.plan.executionId).find(effect => effect.kind === "write");
  const fact = f.store.getArtifact(write.observationArtifactId).sealedPayload;
  assert.equal(fact.native.state, "returned"); assert.equal(fact.native.result.bytesWritten, f.artifact.bytes.length);
  assert.equal(fact.host.state, "unconfirmed");
  assert.throws(() => f.store.settleHostOfficeLocalExecution(f.state.ticket), code("host_office_local_launch_unknown"));
  assert.throws(() => f.tracker.settleOfficeLocalFromStore(f.state.ticket), code("host_office_local_launch_unknown"));
  assertPairStillBlocks(f);
});

test("Office native close unknown and an explicit journal unknown both remain pair blockers", async t => {
  const f = await createOfficeSettlementFixture(t);
  let writerFd, injected = false;
  patchOfficeSettlementFs(t, "openSync", original => (...args) => {
    const fd = original(...args);
    if (args[0] === f.temporary && (args[1] & fs.constants.O_WRONLY) !== 0) writerFd = fd;
    return fd;
  });
  patchOfficeSettlementFs(t, "closeSync", original => fd => {
    const result = original(fd);
    if (fd === writerFd && !injected) {
      injected = true; throw Object.assign(new Error("actual_close_return_lost"), { code: "EINTR" });
    }
    return result;
  });
  let failure;
  assert.throws(() => { try { executeOfficeLocalWrite(f.plan); } catch (error) { failure = error; throw error; } }, OfficeLocalWriterError);
  assert.equal(injected, true); assert.ok(failure.observation.resources.some(resource => resource.state === "unknown"));
  assert.throws(() => f.store.settleHostOfficeLocalExecution(f.state.ticket));
  assert.throws(() => f.tracker.settleOfficeLocalFromStore(f.state.ticket));
  assertPairStillBlocks(f);
  f.tracker.markUnknown(f.state.producer, "office_actual_close_unknown");
  assert.throws(() => f.store.settleHostOfficeLocalExecution(f.state.ticket));
  assert.throws(() => f.tracker.settleOfficeLocalFromStore(f.state.ticket));
  assert.equal(f.store.getHostOperation(f.state.producer.operationId).phase, "unknown_outcome");
  assert.equal(f.store.getHostOperation(f.state.parent.operationId).phase, "launched");
  assert.equal(f.store.listHostOperationBlockers(f.source).length, 2);
});

test("Office every extra required child must be safe, and validation failure does not lock an obsolete settlement timestamp", async t => {
  const f = await createOfficeSettlementFixture(t);
  const first = f.tracker.registerProducer(f.state.parent, "hydration", "extra-parent-one");
  const second = f.tracker.registerProducer(f.state.parent, "sdk_tool", "extra-parent-two");
  const nested = f.tracker.registerProducer(f.state.producer, "hydration", "extra-binary-child");
  const nestedChild = f.tracker.registerProducer(nested, "cleanup", "extra-nested-child");
  executeOfficeLocalWrite(f.plan);
  const firstIntent = now();
  assert.throws(() => f.store.settleHostOfficeLocalExecution(f.state.ticket, { settledAt: firstIntent }));
  assertPairStillBlocks(f);
  f.tracker.settleNoStart(first);
  assert.throws(() => f.store.settleHostOfficeLocalExecution(f.state.ticket, { settledAt: firstIntent }));
  assertPairStillBlocks(f);
  f.tracker.settleNoStart(second);
  assert.throws(() => f.store.settleHostOfficeLocalExecution(f.state.ticket, { settledAt: firstIntent }));
  assertPairStillBlocks(f);
  f.tracker.settleNoStart(nestedChild); f.tracker.settleNoStart(nested);
  const freshIntent = later(firstIntent);
  const pair = f.store.settleHostOfficeLocalExecution(f.state.ticket, { settledAt: freshIntent });
  assertOfficePairSafe(f, pair);
  assert.equal(pair.parent.settledAt, freshIntent,
    "a prevalidation failure cannot retain the timestamp from before children actually settled");
  f.tracker.executorGroup.closeAdmission(required);
  assert.deepEqual(f.tracker.settleOfficeLocalFromStore(f.state.ticket), pair);
  assert.equal((await f.tracker.executorGroup.observeDrain(0)).status, "settled");
});

for (const childState of ["launched", "unknown_outcome"]) {
  test(`Office an additional ${childState} required child prevents published pair safety`, async t => {
    const f = await createOfficeSettlementFixture(t);
    const extra = f.tracker.registerProducer(f.state.parent, "hydration", "extra-required-child");
    if (childState === "launched") {
      f.tracker.launchHostEffect(extra, () => writeFileSync(join(f.cwd, "actual-extra-effect.txt"), "entered extra effect"));
    } else f.tracker.markUnknown(extra, "extra_required_unknown");
    executeOfficeLocalWrite(f.plan);
    assert.throws(() => f.store.settleHostOfficeLocalExecution(f.state.ticket));
    assert.throws(() => f.tracker.settleOfficeLocalFromStore(f.state.ticket));
    assertPairStillBlocks(f);
    assert.equal(f.store.getHostOperation(extra.operationId).phase, childState);
    assert.equal(f.store.listHostOperationBlockers(f.source).length, 3);
  });
}

test("Office producer-safe write followed by actual parent SQL failure rolls back the complete pair", async t => {
  const f = await createOfficeSettlementFixture(t);
  executeOfficeLocalWrite(f.plan);
  const before = readOfficePairRows(f), settledAt = now();
  f.store.database.exec(`CREATE TRIGGER office_test_reject_parent_settlement BEFORE UPDATE OF phase ON host_operations
    WHEN NEW.operation_id='${f.state.parent.operationId}' AND NEW.phase='safe'
      AND (SELECT phase FROM host_operations WHERE operation_id='${f.state.producer.operationId}')='safe'
    BEGIN SELECT RAISE(ABORT,'injected_parent_pair_failure_after_producer_safe'); END`);
  assert.throws(() => f.store.settleHostOfficeLocalExecution(f.state.ticket, { settledAt }), /injected_parent_pair_failure_after_producer_safe/);
  assert.deepEqual(readOfficePairRows(f), before, "producer digest, phase, timestamp and revision must all roll back with parent failure");
  assertPairStillBlocks(f);
  assert.ok(f.tracker.executorGroup.getSnapshot().operations.every(row => row.state === "launched"));
  f.store.database.exec("DROP TRIGGER office_test_reject_parent_settlement");
  assert.throws(() => f.store.settleHostOfficeLocalExecution(f.state.ticket, { settledAt: later(settledAt) }),
    code("host_operation_settlement_conflict"), "once SQL writes begin, the original intent must survive rollback");
  const pair = f.store.settleHostOfficeLocalExecution(f.state.ticket, { settledAt });
  assertOfficePairSafe(f, pair);
  assert.deepEqual(f.store.settleHostOfficeLocalExecution(f.state.ticket, { settledAt }), pair);
});

for (const afterCommit of [false, true]) {
  for (const throughTracker of [false, true]) {
    test(`Office pair ${afterCommit ? "post-COMMIT return loss" : "COMMIT rollback"} ${throughTracker ? "tracker reconciles" : "same-intent retry is idempotent"} without repeating native effects`, async t => {
      const f = await createOfficeSettlementFixture(t), observer = createSqliteRunStore(f.cwd);
      const exec = f.store.database.exec.bind(f.store.database);
      let writes = 0, injected = false;
      patchOfficeSettlementFs(t, "writeSync", original => (...args) => { const count = original(...args); writes++; return count; });
      executeOfficeLocalWrite(f.plan);
      const nativeWrites = writes, before = readOfficePairRows(f), effects = f.store.listHostOfficeLocalEffects(f.plan.executionId);
      f.store.database.exec = sql => {
        if (sql === "COMMIT" && !injected && readOfficePairRows(f).every(row => row.phase === "safe")) {
          injected = true;
          assert.deepEqual(readOfficePairRows(f, observer), before,
            "an independent SQLite connection must see neither uncommitted safe role");
          if (afterCommit) exec(sql);
          throw Object.assign(new Error("office_pair_commit_return_lost"), { code: "EIO" });
        }
        return exec(sql);
      };
      t.after(() => { f.store.database.exec = exec; });
      try {
        let pair;
        if (throughTracker) {
          f.tracker.executorGroup.closeAdmission(required);
          pair = f.tracker.settleOfficeLocalFromStore(f.state.ticket);
          assert.equal((await f.tracker.executorGroup.observeDrain(0)).status, "settled");
        } else {
          const settledAt = now();
          assert.throws(() => f.store.settleHostOfficeLocalExecution(f.state.ticket, { settledAt }), /office_pair_commit_return_lost/);
          assert.equal(injected, true);
          if (afterCommit) assert.ok(readOfficePairRows(f, observer).every(row => row.phase === "safe"));
          else { assert.deepEqual(readOfficePairRows(f, observer), before); assertPairStillBlocks(f); }
          assert.throws(() => f.store.settleHostOfficeLocalExecution(f.state.ticket, { settledAt: later(settledAt) }),
            code("host_operation_settlement_conflict"));
          pair = f.store.settleHostOfficeLocalExecution(f.state.ticket, { settledAt });
        }
        assert.equal(injected, true);
        assertOfficePairSafe(f, pair); assertOfficePairSafe(f, pair, observer);
        const committed = readOfficePairRows(f);
        assert.deepEqual(f.store.settleHostOfficeLocalExecution(f.state.ticket, { settledAt: pair.parent.settledAt }), pair);
        assert.deepEqual(readOfficePairRows(f), committed, "same-intent retry cannot increment either settled revision");
        assert.equal(writes, nativeWrites); assert.deepEqual(f.store.listHostOfficeLocalEffects(f.plan.executionId), effects);
      } finally { f.store.database.exec = exec; observer.close(); }
    });
  }
}

test("Office terminal COMMIT rollback keeps a published physical file blocked until the exact original seal is confirmed", async t => {
  const f = await createOfficeSettlementFixture(t), exec = f.store.database.exec.bind(f.store.database);
  let injected = false, failure;
  f.store.database.exec = sql => {
    if (sql === "COMMIT" && !injected && f.store.database.prepare(
      "SELECT count(*) n FROM host_office_local_terminals WHERE execution_id=?").get(f.plan.executionId).n === 1) {
      injected = true; throw Object.assign(new Error("terminal_seal_commit_rollback"), { code: "EIO" });
    }
    return exec(sql);
  };
  t.after(() => { f.store.database.exec = exec; });
  assert.throws(() => { try { executeOfficeLocalWrite(f.plan); } catch (error) { failure = error; throw error; } }, OfficeLocalWriterError);
  assert.equal(injected, true); assert.equal(failure.terminalSealConfirmed, false);
  assert.equal(failure.observation.outcome, "published");
  assert.deepEqual(readFileSync(f.prepared.targetPath), f.artifact.bytes);
  assert.equal(f.store.getHostOfficeLocalTerminal(f.plan.executionId), undefined);
  assert.throws(() => f.store.settleHostOfficeLocalExecution(f.state.ticket));
  assertPairStillBlocks(f);
  const seal = f.store.getArtifact(failure.observationArtifactId);
  f.store.database.exec = exec;
  f.tracker.sealOfficeLocalTerminal(f.state.ticket, { terminalArtifactId: seal.id, terminalDigest: seal.contentSha256 });
  assertOfficePairSafe(f, f.tracker.settleOfficeLocalFromStore(f.state.ticket));
  assert.throws(() => executeOfficeLocalWrite(f.plan), /already_entered/);
});
