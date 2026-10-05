import assert from "node:assert/strict";
import test from "node:test";
import { AttemptHostOperationTracker } from "../dist/runtime/attempt-host-operation-tracker.js";
import { officeDirectoryTrackerFixture, failedOfficeDirectoryTerminal, requiredOfficeDirectoryInput as required }
  from "./support/attempt-host-office-directory-v2-fixture.mjs";

const coreCode = expected => error => error.code === expected;
const trackerCode = expected => coreCode(`attempt_host_operation_${expected}`);
const groupCode = expected => coreCode(`attempt_execution_${expected}`);
async function assertPairBlocked(f) {
  f.group.closeAdmission(required);
  const drain = await f.group.observeDrain(0);
  assert.equal(drain.status, "blocked");
  assert.deepEqual(drain.blockers.map(row => row.operationId).sort(), [f.parent.operationId, f.producer.operationId].sort());
  assert.equal(f.other.listHostOperationBlockers(f.source).length, 2);
}

test("directory-v2 preparation binds the original MCP/binary pair and leaves both real barriers admitted", async t => {
  const f = await officeDirectoryTrackerFixture(t), execution = f.other.getHostOfficeLocalDirectoryExecutionV2(f.ticket.executionId);
  assert.equal(execution.schemaVersion, 2); assert.equal(execution.protocol, "ling-office-local-binary-v2");
  assert.deepEqual(execution.source, f.source);
  assert.equal(execution.parentOperationId, f.parent.operationId); assert.equal(execution.producerOperationId, f.producer.operationId);
  const [parent, producer] = f.pairRows();
  assert.equal(parent.kind, "mcp"); assert.equal(producer.kind, "file_mutation");
  assert.equal(producer.parentOperationId, parent.operationId); assert.equal(producer.producerId, "office-local-binary");
  assert.deepEqual(parent.evidenceRef, { kind: "office_local_chain_execution", id: execution.executionId });
  assert.deepEqual(producer.evidenceRef, { kind: "office_local_binary_execution", id: execution.executionId });
  assert.deepEqual(f.pairStates(), ["admitted", "admitted"]);
  for (const row of f.group.getSnapshot().operations) assert.deepEqual(row.ticket.source, f.source);
  assert.equal(f.other.getHostOfficeLocalExecution(f.ticket.executionId), undefined);
  await assertPairBlocked(f);
});

test("directory-v2 preparation rejects wrong original pair kinds, producer identity, lineage and cloned handles", async t => {
  const f = await officeDirectoryTrackerFixture(t, { prepare: false });
  const wrongProducer = f.tracker.registerProducer(f.parent, "file_mutation", "not-office-local-binary");
  const unrelated = f.tracker.beginHostCall("file_mutation", "unrelated-call");
  const command = f.tracker.beginHostCall("command", "command-call");
  const commandProducer = f.tracker.registerProducer(command, "file_mutation", "office-local-binary");
  for (const [parent, producer] of [[f.parent, wrongProducer], [f.parent, unrelated], [command, commandProducer], [f.producer, f.parent]]) {
    assert.throws(() => f.tracker.prepareOfficeLocalDirectoryExecutionV2(parent, producer, f.input), trackerCode("invalid_office_pair"));
  }
  assert.throws(() => f.tracker.prepareOfficeLocalDirectoryExecutionV2({ ...f.parent }, f.producer, f.input), trackerCode("invalid_handle"));
  assert.throws(() => f.tracker.prepareOfficeLocalDirectoryExecutionV2(f.parent, { ...f.producer }, f.input), trackerCode("invalid_handle"));
  assert.equal(f.other.getHostOfficeLocalDirectoryExecutionV2(f.prepared.executionId), undefined);
  assert.deepEqual(f.pairRows().map(row => row.phase), ["admitted", "admitted"]);
});

test("directory-v2 wrappers reject restored/foreign tickets rather than reconstructing authority from execution IDs", async t => {
  const f = await officeDirectoryTrackerFixture(t), effect = f.effect(); let calls = 0;
  const foreign = await officeDirectoryTrackerFixture(t);
  const otherTracker = new AttemptHostOperationTracker({ store: f.store, source: f.source });
  for (const ticket of [foreign.ticket, { ...f.ticket }, Object.create(f.ticket), undefined]) {
    assert.throws(() => f.tracker.prepareOfficeLocalDirectoryEffectV2(ticket, {}), trackerCode("invalid_office_ticket"));
    assert.throws(() => f.tracker.launchOfficeLocalDirectoryEffectV2(ticket, effect.effectId, () => { calls++; }, "forward"), trackerCode("invalid_office_ticket"));
    assert.throws(() => f.tracker.recordOfficeLocalDirectoryObservationV2(ticket, effect.effectId, "artifact"), trackerCode("invalid_office_ticket"));
    assert.throws(() => f.tracker.sealOfficeLocalDirectoryTerminalV2(ticket, {}), trackerCode("invalid_office_ticket"));
  }
  assert.throws(() => otherTracker.prepareOfficeLocalDirectoryEffectV2(f.ticket, {}), trackerCode("invalid_office_ticket"));
  assert.throws(() => otherTracker.launchOfficeLocalDirectoryEffectV2(f.ticket, effect.effectId, () => { calls++; }, "forward"), trackerCode("invalid_office_ticket"));
  assert.throws(() => foreign.tracker.launchOfficeLocalDirectoryEffectV2(f.ticket, effect.effectId, () => { calls++; }, "forward"), trackerCode("invalid_office_ticket"));
  assert.equal(calls, 0); assert.deepEqual(f.pairStates(), ["admitted", "admitted"]);
  assert.equal(f.other.listHostOfficeLocalDirectoryEffectsV2(f.ticket.executionId)[0].enteredAt, undefined);
  assert.equal(f.tracker.launchOfficeLocalDirectoryEffectV2(f.ticket, effect.effectId, () => { calls++; return "original forward invocation"; }, "forward"), "original forward invocation");
  assert.equal(calls, 1); assert.deepEqual(f.pairStates(), ["launched", "launched"]);
});

test("directory-v2 wrappers reject an actual v1 ticket issued through the same tracker", async t => {
  const f = await officeDirectoryTrackerFixture(t, { version: 1 }); let calls = 0;
  assert.equal(f.other.getHostOfficeLocalExecution(f.ticket.executionId).schemaVersion, 1);
  assert.throws(() => f.tracker.prepareOfficeLocalDirectoryEffectV2(f.ticket, {}), trackerCode("invalid_office_ticket"));
  assert.throws(() => f.tracker.launchOfficeLocalDirectoryEffectV2(f.ticket, "capture", () => { calls++; }, "forward"), trackerCode("invalid_office_effect"));
  assert.throws(() => f.tracker.recordOfficeLocalDirectoryObservationV2(f.ticket, "capture", "artifact"), trackerCode("invalid_office_ticket"));
  assert.throws(() => f.tracker.sealOfficeLocalDirectoryTerminalV2(f.ticket, {}), trackerCode("invalid_office_ticket"));
  assert.equal(calls, 0); assert.deepEqual(f.pairStates(), ["admitted", "admitted"]);
  assert.equal(f.other.getHostOfficeLocalDirectoryExecutionV2(f.ticket.executionId), undefined);
  await assertPairBlocked(f);
});

test("directory-v2 launch requires its exact prepared mode and synchronous callback before either barrier enters", async t => {
  const f = await officeDirectoryTrackerFixture(t), effect = f.effect(); let calls = 0;
  for (const mode of ["cleanup", "rollback", undefined]) {
    assert.throws(() => f.tracker.launchOfficeLocalDirectoryEffectV2(f.ticket, effect.effectId, () => { calls++; }, mode), trackerCode("invalid_office_effect"));
  }
  assert.throws(() => f.tracker.launchOfficeLocalDirectoryEffectV2(f.ticket, "not-prepared", () => { calls++; }, "forward"), trackerCode("invalid_office_effect"));
  assert.throws(() => f.tracker.launchOfficeLocalDirectoryEffectV2(f.ticket, effect.effectId, async () => { calls++; }, "forward"), trackerCode("effect_must_be_synchronous"));
  assert.equal(calls, 0); assert.deepEqual(f.pairStates(), ["admitted", "admitted"]);
  assert.equal(f.other.listHostOfficeLocalDirectoryEffectsV2(f.ticket.executionId)[0].enteredAt, undefined);
  assert.equal(f.tracker.launchOfficeLocalDirectoryEffectV2(f.ticket, effect.effectId, () => { calls++; return "original forward invocation"; }, "forward"), "original forward invocation");
  assert.equal(calls, 1); assert.deepEqual(f.pairStates(), ["launched", "launched"]);
});

test("directory-v2 actual invocation enters both original barriers inside the real Core pair transaction exactly once", async t => {
  const f = await officeDirectoryTrackerFixture(t); let calls = 0;
  const item = f.capture({ beforeReturn: () => {
    calls++;
    assert.deepEqual(f.pairStates(), ["launched", "launched"]);
    assert.deepEqual(f.pairRows(f.store).map(row => row.phase), ["launched", "launched"]);
    assert.deepEqual(f.pairRows().map(row => row.phase), ["admitted", "admitted"], "other connection cannot see the uncommitted launch");
  } });
  assert.equal(item.result.nativeOutcome, "returned"); assert.equal(item.result.hostAcknowledgment, "not_provided");
  assert.equal(item.result.snapshot.scopeBinding, "unbound"); assert.equal(item.result.snapshot.coreSafe, false);
  assert.deepEqual(f.pairRows().map(row => row.phase), ["launched", "launched"]);
  assert.throws(() => f.tracker.launchOfficeLocalDirectoryEffectV2(f.ticket, item.effect.effectId, () => { calls++; }, "forward"), coreCode("host_office_local_effect_already_entered"));
  for (const handle of [f.parent, f.producer]) assert.throws(() => f.tracker.settleNoStart(handle), trackerCode("launched_no_start"));
  assert.equal(calls, 1); await assertPairBlocked(f);
});

test("directory-v2 local admission close blocks a prepared forward invocation with zero callback", async t => {
  const f = await officeDirectoryTrackerFixture(t), effect = f.effect(); let calls = 0;
  f.group.closeAdmission(required);
  assert.throws(() => f.tracker.launchOfficeLocalDirectoryEffectV2(f.ticket, effect.effectId, () => { calls++; }, "forward"), groupCode("admission_closed"));
  assert.equal(calls, 0); assert.deepEqual(f.pairStates(), ["admitted", "admitted"]);
  assert.equal(f.other.listHostOfficeLocalDirectoryEffectsV2(f.ticket.executionId)[0].enteredAt, undefined);
  await assertPairBlocked(f);
});

test("directory-v2 rechecks both local barriers after tracker preflight inside Core's original synchronous gate", async t => {
  const f = await officeDirectoryTrackerFixture(t), effect = f.effect(); let calls = 0, gates = 0;
  const launch = f.store.launchHostOfficeLocalDirectoryEffectV2.bind(f.store);
  f.store.launchHostOfficeLocalDirectoryEffectV2 = (...args) => { gates++; f.group.closeAdmission(required); return launch(...args); };
  try {
    assert.throws(() => f.tracker.launchOfficeLocalDirectoryEffectV2(f.ticket, effect.effectId, () => { calls++; }, "forward"), groupCode("admission_closed"));
  } finally { f.store.launchHostOfficeLocalDirectoryEffectV2 = launch; }
  assert.equal(gates, 1); assert.equal(calls, 0);
  assert.deepEqual(f.pairRows().map(row => row.phase), ["admitted", "admitted"]);
  assert.equal(f.other.listHostOfficeLocalDirectoryEffectsV2(f.ticket.executionId)[0].enteredAt, undefined);
  await assertPairBlocked(f);
});

test("directory-v2 Core rejects a real replacement owner after tracker preflight without borrowing its authority", async t => {
  const f = await officeDirectoryTrackerFixture(t), effect = f.effect(); let calls = 0, gates = 0;
  const launch = f.store.launchHostOfficeLocalDirectoryEffectV2.bind(f.store);
  f.store.launchHostOfficeLocalDirectoryEffectV2 = (...args) => { gates++; f.replaceOwner(); return launch(...args); };
  try {
    assert.throws(() => f.tracker.launchOfficeLocalDirectoryEffectV2(f.ticket, effect.effectId, () => { calls++; }, "forward"), coreCode("host_operation_stale_owner"));
  } finally { f.store.launchHostOfficeLocalDirectoryEffectV2 = launch; }
  assert.equal(gates, 1); assert.equal(calls, 0); assert.deepEqual(f.pairStates(), ["admitted", "admitted"]);
  assert.deepEqual(f.pairRows().map(row => row.phase), ["admitted", "admitted"]);
  assert.equal(f.other.listHostOfficeLocalDirectoryEffectsV2(f.ticket.executionId)[0].enteredAt, undefined);
  await assertPairBlocked(f);
});

test("directory-v2 cleanup requires prior original entry and remains bounded cleanup after local admission closes", async t => {
  const f = await officeDirectoryTrackerFixture(t), effect = f.effect(); let calls = 0, cleanups = 0;
  assert.throws(() => f.cleanup(), coreCode("host_office_local_cleanup_not_entered"));
  assert.equal(f.other.listHostOfficeLocalDirectoryEffectsV2(f.ticket.executionId).length, 1);
  f.tracker.launchOfficeLocalDirectoryEffectV2(f.ticket, effect.effectId, () => { calls++; return "controlled invocation returned"; }, "forward");
  f.group.closeAdmission(required);
  const cleanup = f.cleanup();
  assert.throws(() => f.tracker.launchOfficeLocalDirectoryEffectV2(f.ticket, cleanup.effectId, () => { cleanups++; }, "forward"), trackerCode("invalid_office_effect"));
  assert.equal(f.tracker.launchOfficeLocalDirectoryEffectV2(f.ticket, cleanup.effectId, () => { cleanups++; return "controlled cleanup returned"; }, "cleanup"), "controlled cleanup returned");
  assert.equal(calls, 1); assert.equal(cleanups, 1); assert.deepEqual(f.pairStates(), ["launched", "launched"]);
  assert.deepEqual(f.pairRows().map(row => row.phase), ["launched", "launched"]);
  assert.equal(f.group.getSnapshot().operations.length, 2, "cleanup cannot enroll or release a third barrier member");
  assert.throws(() => f.tracker.prepareOfficeLocalDirectoryEffectV2(f.ticket, { effectId: "late", ordinal: 2, kind: "close_session", mode: "forward", preparedAt: f.now() }), groupCode("admission_closed"));
  await assertPairBlocked(f);
});

test("directory-v2 entered cleanup cannot borrow a real successor's owner authority", async t => {
  const f = await officeDirectoryTrackerFixture(t), effect = f.effect(); let cleanups = 0;
  f.tracker.launchOfficeLocalDirectoryEffectV2(f.ticket, effect.effectId, () => "controlled invocation returned", "forward");
  const cleanup = f.cleanup(); f.replaceOwner();
  assert.throws(() => f.tracker.launchOfficeLocalDirectoryEffectV2(f.ticket, cleanup.effectId, () => { cleanups++; }, "cleanup"), coreCode("host_operation_stale_owner"));
  assert.equal(cleanups, 0); assert.deepEqual(f.pairStates(), ["launched", "launched"]);
  assert.equal(f.other.listHostOfficeLocalDirectoryEffectsV2(f.ticket.executionId)[1].enteredAt, undefined);
  await assertPairBlocked(f);
});

for (const failure of ["throw", "COMMIT"]) {
  test(`directory-v2 entered invocation then ${failure} keeps both local latches and cannot replay or claim no-start`, async t => {
    const f = await officeDirectoryTrackerFixture(t), effect = f.effect(); let calls = 0, armed = false, injected = false;
    const exec = f.store.database.exec.bind(f.store.database);
    if (failure === "COMMIT") f.store.database.exec = sql => {
      if (sql === "COMMIT" && armed && !injected) { injected = true; throw new Error("actual directory tracker launch COMMIT refused"); }
      return exec(sql);
    };
    try {
      assert.throws(() => f.tracker.launchOfficeLocalDirectoryEffectV2(f.ticket, effect.effectId, () => {
        calls++;
        assert.deepEqual(f.pairStates(), ["launched", "launched"]);
        assert.deepEqual(f.pairRows(f.store).map(row => row.phase), ["launched", "launched"]);
        if (failure === "throw") throw new Error("actual directory tracker invocation threw");
        armed = true; return "controlled invocation returned";
      }, "forward"), failure === "throw" ? /actual directory tracker invocation threw/ : /actual directory tracker launch COMMIT refused/);
    } finally { f.store.database.exec = exec; }
    if (failure === "COMMIT") assert.equal(injected, true);
    assert.equal(calls, 1); assert.deepEqual(f.pairStates(), ["launched", "launched"]);
    assert.deepEqual(f.pairRows().map(row => row.phase), ["admitted", "admitted"]);
    assert.equal(f.other.listHostOfficeLocalDirectoryEffectsV2(f.ticket.executionId)[0].enteredAt, undefined);
    for (const handle of [f.parent, f.producer]) assert.throws(() => f.tracker.settleNoStart(handle), trackerCode("launched_no_start"));
    assert.throws(() => f.tracker.launchOfficeLocalDirectoryEffectV2(f.ticket, effect.effectId, () => { calls++; }, "forward"), coreCode("host_office_local_effect_already_entered"));
    assert.equal(calls, 1); await assertPairBlocked(f);
  });
}

test("directory-v2 sealed failed terminal cannot use v1 settlement to release either original journal or local barrier", async t => {
  const f = await officeDirectoryTrackerFixture(t), item = f.capture({ success: false });
  f.group.closeAdmission(required);
  const manifest = failedOfficeDirectoryTerminal(f, item), artifact = f.seal(manifest);
  const claim = { terminalArtifactId: artifact.id, terminalDigest: artifact.contentSha256 }, before = f.pairRows();
  const terminal = f.tracker.sealOfficeLocalDirectoryTerminalV2(f.ticket, claim);
  assert.equal(terminal.outcome, "failed"); assert.equal(terminal.canonicalVisibility.state, "unverified");
  assert.deepEqual(f.other.getHostOfficeLocalDirectoryTerminalV2(f.ticket.executionId), terminal);
  assert.deepEqual(f.tracker.sealOfficeLocalDirectoryTerminalV2(f.ticket, claim), terminal);
  assert.throws(() => f.tracker.settleOfficeLocalFromStore(f.ticket), coreCode("host_office_local_invalid_ticket"));
  assert.throws(() => f.store.settleHostOfficeLocalExecution(f.ticket), coreCode("host_office_local_invalid_ticket"));
  for (const handle of [f.parent, f.producer]) {
    assert.throws(() => f.tracker.settleFromStore(handle), trackerCode("settlement_unconfirmed"));
    assert.throws(() => f.tracker.settleNoStart(handle), trackerCode("launched_no_start"));
  }
  assert.throws(() => f.cleanup(), coreCode("host_office_local_execution_sealed"));
  assert.deepEqual(f.pairRows(), before); assert.deepEqual(f.pairStates(), ["launched", "launched"]);
  await assertPairBlocked(f);
});
