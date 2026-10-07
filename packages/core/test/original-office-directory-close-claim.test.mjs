import assert from "node:assert/strict";
import test from "node:test";
import { createOriginalOfficeHostBridgeForComposition, sealOriginalOfficeHostBridgeForComposition,
  mintOriginalOfficeDirectoryAuthorityV2 } from "../dist/original-office-host-bridge.js";
import { verifyHostOfficeReceipt } from "../dist/storage/sqlite/host-office-local-journal-evidence.js";
import { readHostOperation } from "../dist/storage/sqlite/host-operation-journal-evidence.js";
import { directoryV2StoreFixture, directoryV2Capture, directoryV2Clone } from "./support/host-office-local-directory-v2-fixture.mjs";

// Genuine original SQLite tickets and transactions; endpoint/native DTOs below
// are transport/grammar mechanism fixtures, not genuine Host or kernel proof.
const code = expected => error => error?.code === expected;
const copies = value => [{ ...value }, JSON.parse(JSON.stringify(value)), new Proxy(value, {})];
async function fixture(t, { bind = true, close, assertClosed } = {}) {
  const pair = createOriginalOfficeHostBridgeForComposition(), f = await directoryV2StoreFixture(t, { originalOfficeHostBridge: pair.reader });
  const custody = Object.freeze({}), counts = { binding: 0, close: 0, assert: 0 }, state = { phase: "active" };
  const check = (received, expected) => {
    assert.equal(received, custody); assert.deepEqual(expected, f.execution());
    assert.ok(Object.isFrozen(expected) && Object.isFrozen(expected.source) && Object.isFrozen(expected.stage.ancestors));
    assert.throws(() => f.store.database.exec("CREATE TABLE forbidden_close_write(value TEXT)"), /readonly/i);
  };
  const current = { ...f, ...pair, counts, state, close: () => f.store.closeHostOfficeLocalDirectoryWindowV2(f.ticket) };
  sealOriginalOfficeHostBridgeForComposition(pair.setup, f.store, Object.freeze({
    assertBinding(received, expected) { check(received, expected); counts.binding++; },
    closeBoundWindow(received, expected) {
      check(received, expected); counts.close++;
      if (close) return close(current);
      state.phase = "closed_pending";
    },
    assertClosedBoundWindow(received, expected) {
      check(received, expected); counts.assert++;
      if (assertClosed) return assertClosed(current);
      assert.equal(state.phase, "closed_pending", "original window closure is unknown");
    },
  }));
  current.authority = mintOriginalOfficeDirectoryAuthorityV2(pair.setup, custody);
  if (bind) f.store.bindHostOfficeLocalDirectoryScopeAuthorityV2(f.ticket, current.authority);
  return current;
}
function child(f, operationId, parentOperationId = f.parent.operationId, kind = "hydration") {
  return f.store.admitHostOperation({ operationId, source: f.source, kind, toolCallId: f.execution().toolCallId,
    parentOperationId, producerId: operationId });
}
const finish = (f, ticket) => f.store.settleHostOperation(ticket, { kind: "known_no_start", settledAt: f.now() });
const noSafe = f => {
  assert.equal(f.store.listHostOperationBlockers(f.source).filter(row => [f.parent.operationId, f.producer.operationId].includes(row.operationId)).length, 2);
  assert.throws(() => verifyHostOfficeReceipt(f.store.database, readHostOperation(f.store.database, f.parent.operationId)), code("host_office_local_directory_v2_safe_unavailable"));
};
function observedCapture(f, { success = true } = {}) {
  const effect = f.prepare(); let observation;
  f.store.launchHostOfficeLocalDirectoryEffectV2(f.ticket, effect.effectId, () => {
    const entered = f.store.listHostOfficeLocalDirectoryEffectsV2(f.ticket.executionId)[0];
    observation = directoryV2Capture(f.execution(), entered, { success });
    observation.native.calledAt = f.now(); observation.native.returnedAt = f.now(); observation.completedAt = f.now();
  });
  const artifact = f.seal(observation);
  f.store.recordHostOfficeLocalDirectoryObservationV2(f.ticket, effect.effectId, artifact.id);
  return observation;
}
function observedNativeClose(f, capture, { seal = true } = {}) {
  const effect = f.store.prepareHostOfficeLocalDirectoryEffectV2(f.ticket, {
    effectId: "native-close", ordinal: 1, kind: "close_session", mode: "cleanup", preparedAt: f.now(),
  });
  let observation, closeRefs = new Map();
  f.store.launchHostOfficeLocalDirectoryEffectV2(f.ticket, effect.effectId, () => {
    const entered = f.store.listHostOfficeLocalDirectoryEffectsV2(f.ticket.executionId)[1];
    observation = directoryV2Clone(capture); observation.effectId = entered.effectId; observation.effectDigest = entered.effectDigest;
    observation.native.calledAt = f.now(); observation.native.returnedAt = f.now(); observation.completedAt = f.now();
    const result = observation.native.result; result.success = true; result.calls = []; result.snapshot.phase = "closed";
    let clock = 1000n;
    for (const resource of result.snapshot.resources.slice().reverse()) {
      if (resource.state !== "retained") continue;
      closeRefs.set(resource.lifetimeId, { effectId: entered.effectId, ordinal: result.calls.length });
      result.calls.push({ syscall: "close", resourceLifetimeId: resource.lifetimeId, parentLifetimeId: resource.parentLifetimeId,
        nativeReturnState: "returned", calledAtMonotonicNs: String(++clock), returnedAtMonotonicNs: String(++clock),
        returned: 0, success: true, errno: 0 });
      resource.state = "closed";
    }
  });
  const artifact = f.seal(observation);
  f.store.recordHostOfficeLocalDirectoryObservationV2(f.ticket, effect.effectId, artifact.id);
  const execution = f.execution(), bindings = new Map(observation.resourceBindings.map(binding => [binding.resourceSlotId, binding]));
  const resources = [...execution.stage.ancestors, ...execution.destination.ancestors,
    ...execution.members.flatMap(member => [{ resourceSlotId: member.resourceSlotId }, { resourceSlotId: member.publicationResourceSlotId }])]
    .map(slot => {
      const binding = bindings.get(slot.resourceSlotId), closeCallRef = binding && closeRefs.get(binding.nativeLifetimeId);
      return closeCallRef ? { ...binding, state: "closed", closeCallRef } : { resourceSlotId: slot.resourceSlotId, state: "not_acquired" };
    });
  const manifest = { schemaVersion: 2, protocol: execution.protocol, kind: "office_local_directory_terminal_v2", executionId: execution.executionId,
    executionIdentityDigest: execution.identityDigest, source: execution.source, preparedArtifactId: execution.preparedArtifactId,
    preparedDigest: execution.preparedDigest, outcome: "failed", installationEntered: false,
    effects: f.store.listHostOfficeLocalDirectoryEffectsV2(f.ticket.executionId).map(item => ({ ordinal: item.ordinal, effectId: item.effectId,
      effectDigest: item.effectDigest, enteredAt: item.enteredAt, observation: { artifactId: item.observationArtifactId,
        digest: f.store.getArtifact(item.observationArtifactId).contentSha256 } })),
    resources, canonicalVisibility: { state: "unverified", blockerCode: "controlled_native_history_only" }, completedAt: f.now() };
  const terminalArtifact = f.seal(manifest), claim = { terminalArtifactId: terminalArtifact.id, terminalDigest: terminalArtifact.contentSha256 };
  if (seal) f.store.sealHostOfficeLocalDirectoryTerminalV2(f.ticket, claim);
  return claim;
}

test("original SQLite close returns one frozen opaque Core history, reasserts without reclose and retains blockers", async t => {
  const f = await fixture(t), before = f.store.listHostOperationBlockers(f.source), claim = f.close();
  assert.ok(Object.isFrozen(claim)); assert.deepEqual(Reflect.ownKeys(claim), []);
  assert.equal(f.close(), claim); assert.deepEqual(f.counts, { binding: 1, close: 1, assert: 2 });
  assert.deepEqual(f.store.listHostOperationBlockers(f.source), before);
  for (const ticket of [claim, ...copies(claim)]) assert.throws(() => f.store.closeHostOfficeLocalDirectoryWindowV2(ticket), code("host_office_local_invalid_ticket"));
  assert.throws(() => f.prepare(), code("host_office_local_execution_closed"));
  assert.throws(() => f.store.recordHostOfficeLocalDirectoryObservationV2(f.ticket, "invented", "invented"), code("host_office_local_execution_closed"));
  assert.throws(() => f.store.sealHostOfficeLocalDirectoryTerminalV2(f.ticket, {}), code("host_office_local_execution_closed"));
  for (const parent of [f.parent, f.producer]) assert.throws(() => child(f, "late-" + parent.operationId, parent.operationId), code("host_office_local_execution_closed"));
  noSafe(f);
});
test("clone/foreign/unbound tickets and replacement source never reach the close endpoint", async t => {
  const f = await fixture(t, { bind: false });
  for (const ticket of copies(f.ticket)) assert.throws(() => f.store.closeHostOfficeLocalDirectoryWindowV2(ticket), code("host_office_local_invalid_ticket"));
  assert.throws(() => f.other.closeHostOfficeLocalDirectoryWindowV2(f.ticket), code("host_office_local_invalid_ticket"));
  assert.throws(() => f.close(), code("host_office_local_scope_binding_closed"));
  f.store.bindHostOfficeLocalDirectoryScopeAuthorityV2(f.ticket, f.authority);
  f.store.createWorkUnitAttempt({ workUnitId: f.source.workUnitId, attemptNumber: 2, runtimeInstanceId: "replacement", runnerId: "pi", status: "started", now: f.now() });
  assert.throws(() => f.close(), code("host_operation_stale_owner")); assert.equal(f.counts.close, 0);
});
test("complete parent/producer/grandchild roster must be ready before latching, then fresh retry closes once", async t => {
  const f = await fixture(t), extra = child(f, "parent-extra"), below = child(f, "producer-extra", f.producer.operationId);
  const nested = child(f, "nested-cleanup", below.operationId, "cleanup");
  assert.throws(() => f.close(), code("host_office_local_required_child_not_ready")); assert.equal(f.counts.close, 0);
  const afterFailure = child(f, "after-readiness-failure"); finish(f, afterFailure); finish(f, extra);
  assert.throws(() => f.close(), code("host_office_local_required_child_not_ready")); assert.equal(f.counts.close, 0);
  finish(f, nested); finish(f, below); f.close(); assert.equal(f.counts.close, 1);
  assert.throws(() => child(f, "late-nested", nested.operationId), code("host_operation_invalid_parent")); noSafe(f);
});
for (const outcome of ["launched", "unknown_outcome", "corrupt_digest"]) test(`required child ${outcome} cannot be hidden by ready sibling or producer exclusion`, async t => {
  const f = await fixture(t), ready = child(f, "ready"), pending = child(f, "blocked", f.producer.operationId); finish(f, ready);
  if (outcome === "corrupt_digest") {
    // Inject a corrupt first settlement through actual SQLite. Its immutable
    // guard remains installed; do not delete a trigger or rewrite an existing seal.
    const settledAt = f.now();
    f.store.database.prepare(`UPDATE host_operations SET phase='safe',settled_at=?,settlement_kind='known_no_start',
      evidence_digest=?,settlement_signature=?,revision=revision+1 WHERE operation_id=? AND phase='admitted'`)
      .run(settledAt, "e".repeat(64), JSON.stringify({ kind: "known_no_start", settledAt }), pending.operationId);
  } else {
    f.store.launchHostOperation(pending, () => undefined);
    if (outcome === "unknown_outcome") f.store.settleHostOperation(pending, { kind: "unknown_outcome", code: "original_unknown", settledAt: f.now() });
  }
  assert.throws(() => f.close(), /host_office_local_required_child_not_ready|host_operation_evidence_invalid/);
  assert.equal(f.counts.close, 0); finish(f, child(f, "still-admissible"));
});
test("active native capture rejects Core close before latching and original cleanup remains admissible", async t => {
  const f = await fixture(t), capture = observedCapture(f);
  assert.throws(() => f.close(), code("host_office_local_native_close_not_ready")); assert.equal(f.counts.close, 0);
  observedNativeClose(f, capture); f.close(); assert.equal(f.counts.close, 1); noSafe(f);
});
test("raw mismatched child is never omitted by a source-filtered roster and validation leaves admission open", async t => {
  const f = await fixture(t), row = readHostOperation(f.store.database, f.parent.operationId);
  f.store.database.prepare(`INSERT INTO host_operations(operation_id,schema_version,run_id,work_unit_id,attempt_id,runtime_instance_id,
    fencing_token,kind,tool_call_id,parent_operation_id,producer_id,phase,admitted_at)
    VALUES('raw-mismatched',1,?,?,?,?,?,'hydration','wrong-tool',?,'raw','admitted',?)`)
    .run(row.source.runId, row.source.workUnitId, row.source.attemptId, row.source.runtimeInstanceId, row.source.fencingToken, f.producer.operationId, f.now());
  assert.throws(() => f.close(), code("host_operation_evidence_invalid")); assert.equal(f.counts.close, 0);
  finish(f, child(f, "after-invalid-raw-roster"));
});
test("bounded complete raw roster rejects excessive depth before recursive receipt verification or Host entry", async t => {
  const f = await fixture(t); let parent = f.producer;
  for (let index = 0; index < 129; index++) parent = child(f, "depth-" + index, parent.operationId);
  assert.throws(() => f.close(), code("host_operation_evidence_invalid")); assert.equal(f.counts.close, 0);
  finish(f, child(f, "after-depth-refusal"));
});
test("known failed native capture plus complete returned cleanup is close history, never success replay", async t => {
  const f = await fixture(t), capture = observedCapture(f, { success: false }); observedNativeClose(f, capture);
  f.close(); assert.equal(f.counts.close, 1); assert.equal(f.store.getHostOfficeLocalDirectoryTerminalV2(f.ticket.executionId).outcome, "failed"); noSafe(f);
});
test("native close observation without persisted terminal refuses closure without consuming admission", async t => {
  const f = await fixture(t), claim = observedNativeClose(f, observedCapture(f), { seal: false });
  assert.throws(() => f.close(), code("host_office_local_native_close_not_ready")); assert.equal(f.counts.close, 0);
  f.store.sealHostOfficeLocalDirectoryTerminalV2(f.ticket, claim); f.close(); assert.equal(f.counts.close, 1);
});
test("terminal COMMIT rollback leaves the retained seal intent but cannot claim a nonexistent terminal", async t => {
  const f = await fixture(t), claim = observedNativeClose(f, observedCapture(f), { seal: false });
  const exec = f.store.database.exec.bind(f.store.database); let once = false;
  f.store.database.exec = sql => { if (sql === "COMMIT" && !once) { once = true; throw Error("terminal COMMIT lost"); } return exec(sql); };
  try { assert.throws(() => f.store.sealHostOfficeLocalDirectoryTerminalV2(f.ticket, claim), /terminal COMMIT lost/); }
  finally { f.store.database.exec = exec; }
  assert.equal(f.store.getHostOfficeLocalDirectoryTerminalV2(f.ticket.executionId), undefined);
  assert.throws(() => f.close(), code("host_office_local_native_close_not_ready")); assert.equal(f.counts.close, 0);
  f.store.sealHostOfficeLocalDirectoryTerminalV2(f.ticket, claim); f.close(); assert.equal(f.counts.close, 1);
});
test("rolled-back original native entry stays unknown even when its SQL enteredAt is absent", async t => {
  const f = await fixture(t), effect = f.prepare(), exec = f.store.database.exec.bind(f.store.database); let once = false;
  f.store.database.exec = sql => { if (sql === "COMMIT" && !once) { once = true; throw Error("native entry COMMIT lost"); } return exec(sql); };
  try { assert.throws(() => f.store.launchHostOfficeLocalDirectoryEffectV2(f.ticket, effect.effectId, () => undefined), /native entry COMMIT lost/); }
  finally { f.store.database.exec = exec; }
  assert.equal(f.store.listHostOfficeLocalDirectoryEffectsV2(f.ticket.executionId)[0].enteredAt, undefined);
  assert.throws(() => f.close(), code("host_office_local_native_close_not_ready")); assert.equal(f.counts.close, 0);
  f.store.prepareHostOfficeLocalDirectoryEffectV2(f.ticket, { effectId: "original-cleanup", ordinal: 1, kind: "close_session", mode: "cleanup", preparedAt: f.now() });
});
for (const outcome of ["missing", "not_entered", "threw", "returned_unprojectable", "unconfirmed"]) {
  test(`original native ${outcome} observation cannot close and does not consume the remaining cleanup gate`, async t => {
    const f = await fixture(t), effect = f.prepare(); let entered, observation;
    f.store.launchHostOfficeLocalDirectoryEffectV2(f.ticket, effect.effectId, () => {
      entered = f.store.listHostOfficeLocalDirectoryEffectsV2(f.ticket.executionId)[0];
      observation = directoryV2Capture(f.execution(), entered);
      observation.native.calledAt = f.now(); observation.native.returnedAt = f.now(); observation.completedAt = f.now();
    });
    if (outcome !== "missing") {
      if (outcome === "unconfirmed") observation.host = { state: "unconfirmed", errorCode: "original_ack_unknown" };
      else {
        observation.native = outcome === "not_entered" ? { state: outcome }
          : { state: outcome, calledAt: entered.enteredAt,
            [outcome === "threw" ? "completedAt" : "returnedAt"]: f.now(), errorCode: "original_native_unknown" };
        observation.host = { state: "unconfirmed", errorCode: "original_ack_unknown" };
        observation.resourceBindings = [];
      }
      observation.completedAt = f.now(); const artifact = f.seal(observation);
      f.store.recordHostOfficeLocalDirectoryObservationV2(f.ticket, effect.effectId, artifact.id);
    }
    assert.throws(() => f.close(), code("host_office_local_native_close_not_ready")); assert.equal(f.counts.close, 0);
    f.store.prepareHostOfficeLocalDirectoryEffectV2(f.ticket, { effectId: "still-original-cleanup", ordinal: 1,
      kind: "close_session", mode: "cleanup", preparedAt: f.now() });
  });
}
test("endpoint reentry sees latched admission and recursive close cannot reach a second endpoint", async t => {
  const f = await fixture(t, { close(current) {
    assert.throws(() => current.close(), code("host_office_local_window_close_reentry"));
    assert.throws(() => current.prepare(), code("host_office_local_execution_closed"));
    assert.throws(() => child(current, "recursive-child"), /readonly|transaction|host_office_local_execution_closed/i);
    current.state.phase = "closed_pending";
  } });
  f.close(); assert.equal(f.counts.close, 1);
});
test("read-only endpoint window setup failure is pre-entry refusal and consumes neither admission nor physical close", async t => {
  const f = await fixture(t), exec = f.store.database.exec.bind(f.store.database); let windows = 0;
  f.store.database.exec = sql => {
    if (sql === "PRAGMA query_only=ON" && ++windows === 2) throw Error("endpoint read-window unavailable");
    return exec(sql);
  };
  try { assert.throws(() => f.close(), /endpoint read-window unavailable/); }
  finally { f.store.database.exec = exec; }
  assert.equal(f.counts.close, 0); f.prepare(); f.close(); assert.equal(f.counts.close, 1);
});
for (const commitFirst of [false, true]) test(`actual outer COMMIT ${commitFirst ? "reply loss" : "rollback"} reasserts original claim without physical close replay`, async t => {
  const f = await fixture(t), exec = f.store.database.exec.bind(f.store.database); let once = false;
  f.store.database.exec = sql => { if (sql === "COMMIT" && !once) { once = true; if (commitFirst) exec(sql); throw Error("close COMMIT acknowledgement lost"); } return exec(sql); };
  try { assert.throws(() => f.close(), /close COMMIT acknowledgement lost/); }
  finally { f.store.database.exec = exec; }
  assert.throws(() => f.prepare(), code("host_office_local_execution_closed"));
  const claim = f.close(); assert.equal(f.close(), claim); assert.equal(f.counts.close, 1); assert.equal(f.counts.assert, 3); noSafe(f);
});
test("Host close return loss reconciles only through same original assertion, never repeating close", async t => {
  const f = await fixture(t, { close(current) { current.state.phase = "closed_pending"; throw Error("original close return lost"); } });
  assert.throws(() => f.close(), /original close return lost/); assert.throws(() => f.prepare(), code("host_office_local_execution_closed"));
  const claim = f.close(); assert.equal(f.close(), claim); assert.equal(f.counts.close, 1); assert.equal(f.counts.assert, 2); noSafe(f);
});
test("genuine closure unknown never repairs into a claim and retains the no-reclose tombstone", async t => {
  const f = await fixture(t, { close(current) { current.state.phase = "unknown"; throw Error("original lifetime unknown"); } });
  assert.throws(() => f.close(), /original lifetime unknown/);
  for (let i = 0; i < 2; i++) assert.throws(() => f.close(), /original window closure is unknown/);
  assert.equal(f.counts.close, 1); assert.equal(f.counts.assert, 2); assert.throws(() => f.prepare(), code("host_office_local_execution_closed")); noSafe(f);
});
test("another SQLite connection cannot adopt original claim but can add a durable pending child: future certificate must re-read raw roster", async t => {
  const f = await fixture(t), claim = f.close();
  assert.throws(() => f.other.closeHostOfficeLocalDirectoryWindowV2(f.ticket), code("host_office_local_invalid_ticket"));
  assert.throws(() => f.other.closeHostOfficeLocalDirectoryWindowV2(claim), code("host_office_local_invalid_ticket"));
  const pending = f.other.admitHostOperation({ operationId: "cross-store-pending", source: f.source, kind: "hydration",
    toolCallId: f.execution().toolCallId, parentOperationId: f.producer.operationId, producerId: "other-connection" });
  assert.ok(pending); assert.throws(() => f.close(), code("host_office_local_required_child_not_ready"));
  assert.equal(f.counts.close, 1); noSafe(f);
});
