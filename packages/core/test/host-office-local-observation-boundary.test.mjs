import assert from "node:assert/strict";
import test from "node:test";
import { officeTerminalFixture, officeTerminalError as code } from "./support/host-office-local-terminal-fixture.mjs";

const rows = f => f.store.database.prepare("SELECT * FROM host_operations ORDER BY operation_id").all();

function assertBlocked(f, before) {
  assert.deepEqual(rows(f), before);
  assert.equal(f.store.getHostOfficeLocalNoStartReceipt(f.ticket.executionId), undefined);
  assert.equal(f.other.listHostOperationBlockers(f.source).length, 2);
}

test("Office original observation latch requires a completed terminal before no-start and closes on rejection", async t => {
  const f = await officeTerminalFixture(t), before = rows(f);
  f.store.beginHostOfficeLocalWriterObservation(f.ticket);
  assert.deepEqual(rows(f), before, "read-only observation is not a mutating launch");
  assert.throws(() => f.store.beginHostOfficeLocalWriterObservation(f.ticket), code("host_office_local_observation_already_started"));
  assert.throws(() => f.store.settleHostOfficeLocalExecution(f.ticket), code("host_office_local_terminal_missing"));
  assertBlocked(f, before);
  assert.throws(() => f.store.beginHostOfficeLocalWriterObservation(f.ticket), code("host_office_local_execution_closed"));
  assert.throws(() => f.prepareEffect(), code("host_office_local_execution_closed"));
  const claim = f.claim(f.manifest());
  assert.throws(() => f.store.sealHostOfficeLocalTerminal(f.ticket, claim), code("host_office_local_execution_closed"));
  assertBlocked(f, before);
});

test("Office observation latch survives actual COMMIT rollback without manufacturing an empty no-start proof", async t => {
  const f = await officeTerminalFixture(t), before = rows(f), exec = f.store.database.exec.bind(f.store.database);
  let failed = false;
  f.store.database.exec = sql => {
    if (sql === "COMMIT" && !failed) { failed = true; throw new Error("observation commit refused before native COMMIT"); }
    return exec(sql);
  };
  try { assert.throws(() => f.store.beginHostOfficeLocalWriterObservation(f.ticket), /observation commit refused/); }
  finally { f.store.database.exec = exec; }
  assert.equal(failed, true);
  assert.throws(() => f.store.beginHostOfficeLocalWriterObservation(f.ticket), code("host_office_local_observation_already_started"));
  assert.throws(() => f.store.settleHostOfficeLocalExecution(f.ticket), code("host_office_local_terminal_missing"));
  assertBlocked(f, before);
});

for (const afterCommit of [false, true]) {
  test(`Office observed failed terminal ${afterCommit ? "ACK loss" : "rollback"} reconciles only its original seal after no-start closure`, async t => {
    const f = await officeTerminalFixture(t), before = rows(f);
    f.store.beginHostOfficeLocalWriterObservation(f.ticket);
    const manifest = f.manifest(), claim = f.claim(manifest), alternate = f.claim(manifest);
    const exec = f.store.database.exec.bind(f.store.database); let injected = false;
    f.store.database.exec = sql => {
      if (sql === "COMMIT" && !injected
        && f.store.database.prepare("SELECT count(*) n FROM host_office_local_terminals").get().n === 1) {
        injected = true;
        if (afterCommit) exec(sql);
        throw new Error("terminal persistence fault");
      }
      return exec(sql);
    };
    try { assert.throws(() => f.store.sealHostOfficeLocalTerminal(f.ticket, claim), /terminal persistence fault/); }
    finally { f.store.database.exec = exec; }
    assert.equal(injected, true);
    assert.equal(!!f.other.getHostOfficeLocalTerminal(f.ticket.executionId), afterCommit);
    if (!afterCommit) {
      assert.throws(() => f.store.settleHostOfficeLocalExecution(f.ticket), code("host_office_local_terminal_missing"));
      assertBlocked(f, before);
      assert.throws(() => f.store.beginHostOfficeLocalWriterObservation(f.ticket), code("host_office_local_execution_closed"));
      assert.throws(() => f.prepareEffect(), code("host_office_local_execution_closed"));
      assert.throws(() => f.store.sealHostOfficeLocalTerminal(f.ticket, alternate), code("host_office_local_execution_closed"));
    }
    const terminal = f.store.sealHostOfficeLocalTerminal(f.ticket, claim);
    assert.equal(terminal.terminalArtifactId, claim.terminalArtifactId);
    const pair = f.store.settleHostOfficeLocalExecution(f.ticket);
    assert.equal(pair.parent.settlementKind, "known_no_start");
    assert.equal(pair.producer.settlementKind, "known_no_start");
    const receipt = f.store.getHostOfficeLocalNoStartReceipt(f.ticket.executionId);
    assert.deepEqual(receipt.terminal, claim);
    assert.deepEqual(f.other.getHostOfficeLocalNoStartReceipt(f.ticket.executionId), receipt);
    assert.deepEqual(f.other.listHostOperationBlockers(f.source), []);
    assert.throws(() => f.store.sealHostOfficeLocalTerminal(f.ticket, claim), code("host_operation_settlement_conflict"));
  });
}

test("Office observed original seal repair rejects an actual replacement owner", async t => {
  const f = await officeTerminalFixture(t);
  f.store.beginHostOfficeLocalWriterObservation(f.ticket);
  const claim = f.claim(f.manifest()), exec = f.store.database.exec.bind(f.store.database);
  f.store.database.exec = sql => {
    if (sql === "COMMIT" && f.store.database.prepare("SELECT count(*) n FROM host_office_local_terminals").get().n) {
      throw new Error("original terminal not committed");
    }
    return exec(sql);
  };
  try { assert.throws(() => f.store.sealHostOfficeLocalTerminal(f.ticket, claim), /not committed/); }
  finally { f.store.database.exec = exec; }
  assert.throws(() => f.store.settleHostOfficeLocalExecution(f.ticket), code("host_office_local_terminal_missing"));
  const before = rows(f); f.replace();
  assert.throws(() => f.store.sealHostOfficeLocalTerminal(f.ticket, claim), code("host_operation_stale_owner"));
  assert.throws(() => f.store.settleHostOfficeLocalExecution(f.ticket), code("host_operation_stale_owner"));
  assert.deepEqual(rows(f), before);
  assert.equal(f.store.getHostOfficeLocalTerminal(f.ticket.executionId), undefined);
  assert.equal(f.store.getHostOfficeLocalNoStartReceipt(f.ticket.executionId), undefined);
});

test("Office copied foreign and replaced-owner capabilities never enter the observation latch", async t => {
  const f = await officeTerminalFixture(t);
  assert.throws(() => f.store.beginHostOfficeLocalWriterObservation({ ...f.ticket }), code("host_office_local_invalid_ticket"));
  assert.throws(() => f.other.beginHostOfficeLocalWriterObservation(f.ticket), code("host_office_local_invalid_ticket"));
  const before = rows(f); f.replace();
  assert.throws(() => f.store.beginHostOfficeLocalWriterObservation(f.ticket), code("host_operation_stale_owner"));
  assert.deepEqual(rows(f), before);
  assert.equal(f.store.getHostOfficeLocalNoStartReceipt(f.ticket.executionId), undefined);
});

test("Office no-start history binds the exact failed terminal and rejects its disappearance", async t => {
  const f = await officeTerminalFixture(t);
  f.store.beginHostOfficeLocalWriterObservation(f.ticket);
  const claim = f.claim(f.manifest());
  f.store.sealHostOfficeLocalTerminal(f.ticket, claim);
  const pair = f.store.settleHostOfficeLocalExecution(f.ticket);
  assert.deepEqual(f.store.getHostOfficeLocalNoStartReceipt(f.ticket.executionId).terminal, claim);
  assert.throws(() => f.store.database.prepare("DELETE FROM host_office_local_terminals WHERE execution_id=?")
    .run(f.ticket.executionId), /host_office_local_terminal_append_only/);
  // Isolated corruption injection only, after proving the actual production
  // trigger prevents deletion. Public verifiers must also distrust damaged history.
  f.store.database.exec("DROP TRIGGER host_office_local_terminal_no_delete");
  f.store.database.prepare("DELETE FROM host_office_local_terminals WHERE execution_id=?").run(f.ticket.executionId);
  assert.throws(() => f.store.getHostOfficeLocalNoStartReceipt(f.ticket.executionId), code("host_office_local_evidence_invalid"));
  assert.throws(() => f.other.getHostOfficeLocalNoStartReceipt(f.ticket.executionId), code("host_office_local_evidence_invalid"));
  for (const operation of [pair.parent, pair.producer]) assert.throws(() => f.store.getHostOperation(operation.operationId));
  assert.throws(() => f.store.listHostOperationBlockers(f.source));
});
