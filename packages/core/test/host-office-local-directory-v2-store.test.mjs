import assert from "node:assert/strict";
import test from "node:test";
import { verifyHostOfficeReceipt } from "../dist/storage/sqlite/host-office-local-journal-evidence.js";
import { readHostOperation } from "../dist/storage/sqlite/host-operation-journal-evidence.js";
import { directoryV2StoreFixture, directoryV2Capture, directoryV2Clone } from "./support/host-office-local-directory-v2-fixture.mjs";

const code = expected => error => error.code === expected;
const operations = f => f.store.database.prepare("SELECT * FROM host_operations ORDER BY operation_id").all();
function capture(f, success) {
  const effect = f.prepare(); let observation;
  f.store.launchHostOfficeLocalDirectoryEffectV2(f.ticket, effect.effectId, () => {
    const current = f.store.listHostOfficeLocalDirectoryEffectsV2(f.ticket.executionId)[0];
    observation = directoryV2Capture(f.execution(), current, { success });
    observation.native.calledAt = f.now(); observation.native.returnedAt = f.now(); observation.completedAt = f.now();
    return observation.native.result;
  });
  const artifact = f.seal(observation);
  const row = f.store.recordHostOfficeLocalDirectoryObservationV2(f.ticket, effect.effectId, artifact.id);
  return { effect: row, observation, artifact };
}
function failedTerminal(f, item) {
  const execution = f.execution(), resources = [...execution.stage.ancestors, ...execution.destination.ancestors,
    ...execution.members.flatMap(member => [{ resourceSlotId: member.resourceSlotId }, { resourceSlotId: member.publicationResourceSlotId }])]
    .map(slot => ({ resourceSlotId: slot.resourceSlotId, state: "not_acquired" }));
  return { schemaVersion: 2, protocol: execution.protocol, kind: "office_local_directory_terminal_v2", executionId: execution.executionId,
    executionIdentityDigest: execution.identityDigest, source: directoryV2Clone(execution.source), preparedArtifactId: execution.preparedArtifactId,
    preparedDigest: execution.preparedDigest, outcome: "failed", installationEntered: false,
    effects: [{ ordinal: item.effect.ordinal, effectId: item.effect.effectId, effectDigest: item.effect.effectDigest,
      enteredAt: item.effect.enteredAt, observation: { artifactId: item.artifact.id, digest: item.artifact.contentSha256 } }],
    resources, canonicalVisibility: { state: "unverified", blockerCode: "original_destination_ancestor_window_unissued" }, completedAt: f.now() };
}
test("v2 real SQLite preparation binds both original journal roles to its distinct protocol domain", async t => {
  const f = await directoryV2StoreFixture(t), execution = f.execution();
  assert.equal(execution.schemaVersion, 2); assert.equal(execution.protocol, "ling-office-local-binary-v2");
  const rows = operations(f);
  assert.deepEqual(rows.map(row => row.evidence_kind).sort(), ["office_local_binary_execution", "office_local_chain_execution"]);
  assert.ok(rows.every(row => row.evidence_id === execution.executionId && row.domain_identity_digest.length === 64 && row.phase === "admitted"));
  assert.equal(f.store.getHostOfficeLocalExecution(execution.executionId), undefined, "v1 reader must not cast v2 history");
  assert.deepEqual(f.other.getHostOfficeLocalDirectoryExecutionV2(execution.executionId), execution);
});
test("v2 complete capture batch accepts actual aliasing ancestor lifetimes and preserves first original fstat", async t => {
  const f = await directoryV2StoreFixture(t), { observation } = capture(f, true);
  assert.equal(f.other.listHostOfficeLocalDirectoryEffectsV2(f.ticket.executionId).length, 1);
  assert.equal(observation.native.result.operationId, "");
  assert.equal(observation.native.result.snapshot.resources[0].identity.inode,
    observation.native.result.snapshot.resources[f.execution().stage.ancestors.length].identity.inode);
  assert.ok(operations(f).every(row => row.phase === "launched"));
});
test("returned false/errno facts stop forward and sealed failed terminal never settles or releases blockers", async t => {
  const f = await directoryV2StoreFixture(t), item = capture(f, false), before = operations(f);
  assert.equal(item.observation.native.result.success, false); assert.equal(item.observation.native.result.calls[0].errno, 2);
  assert.throws(() => f.store.prepareHostOfficeLocalDirectoryEffectV2(f.ticket, { effectId: "later", ordinal: 1, kind: "close_session", mode: "forward", preparedAt: f.now() }), code("host_office_local_directory_v2_forward_blocked"));
  const manifest = failedTerminal(f, item), artifact = f.seal(manifest), claim = { terminalArtifactId: artifact.id, terminalDigest: artifact.contentSha256 };
  const terminal = f.store.sealHostOfficeLocalDirectoryTerminalV2(f.ticket, claim);
  assert.equal(terminal.outcome, "failed"); assert.equal(terminal.canonicalVisibility.state, "unverified");
  assert.deepEqual(f.other.getHostOfficeLocalDirectoryTerminalV2(f.ticket.executionId), terminal);
  assert.deepEqual(operations(f), before); assert.equal(f.store.listHostOperationBlockers(f.source).length, 2);
  assert.throws(() => verifyHostOfficeReceipt(f.store.database, readHostOperation(f.store.database, f.parent.operationId)), code("host_office_local_directory_v2_safe_unavailable"));
  assert.throws(() => f.store.settleHostOfficeLocalExecution(f.ticket), code("host_office_local_invalid_ticket"));
  assert.throws(() => f.store.prepareHostOfficeLocalDirectoryEffectV2(f.ticket, { effectId: "cleanup-after-seal", ordinal: 1, kind: "close_session", mode: "cleanup", preparedAt: f.now() }), code("host_office_local_execution_sealed"));
});
test("v2 copied/foreign tickets and actual replacement owner cannot enter the original synchronous effect gate", async t => {
  const f = await directoryV2StoreFixture(t), effect = f.prepare(); let count = 0;
  for (const [store, ticket] of [[f.store, { ...f.ticket }], [f.other, f.ticket]]) {
    assert.throws(() => store.launchHostOfficeLocalDirectoryEffectV2(ticket, effect.effectId, () => { count++; }), code("host_office_local_invalid_ticket"));
  }
  f.store.createWorkUnitAttempt({ workUnitId: f.source.workUnitId, attemptNumber: 2, runtimeInstanceId: "replacement", runnerId: "pi", status: "started", now: f.now() });
  assert.throws(() => f.store.launchHostOfficeLocalDirectoryEffectV2(f.ticket, effect.effectId, () => { count++; }), code("host_operation_stale_owner"));
  assert.equal(count, 0);
});
test("v2 real launch COMMIT rollback preserves original entered latch and forbids syscall replay", async t => {
  const f = await directoryV2StoreFixture(t), effect = f.prepare(), exec = f.store.database.exec.bind(f.store.database); let injected = false, count = 0;
  f.store.database.exec = sql => {
    if (sql === "COMMIT" && !injected) { injected = true; throw new Error("actual Core launch commit refused"); }
    return exec(sql);
  };
  try { assert.throws(() => f.store.launchHostOfficeLocalDirectoryEffectV2(f.ticket, effect.effectId, () => { count++; return { physicalCallbackReturned: true }; }), /actual Core launch commit refused/); }
  finally { f.store.database.exec = exec; }
  assert.equal(injected, true); assert.equal(count, 1);
  assert.throws(() => f.store.launchHostOfficeLocalDirectoryEffectV2(f.ticket, effect.effectId, () => { count++; }), code("host_office_local_effect_already_entered"));
  assert.equal(count, 1); assert.equal(f.other.listHostOfficeLocalDirectoryEffectsV2(f.ticket.executionId)[0].enteredAt, undefined);
  assert.equal(f.store.listHostOperationBlockers(f.source).length, 2);
});
test("v2 immutable terminal consumes exact source/effect/hash and entire roster, never only its count", async t => {
  const f = await directoryV2StoreFixture(t), item = capture(f, false);
  for (const change of [value => { value.resources[1].resourceSlotId = value.resources[0].resourceSlotId; },
    value => { value.effects[0].effectDigest = "0".repeat(64); }, value => { value.source.runtimeInstanceId = "replacement"; },
    value => { value.canonicalVisibility = { state: "verified", verified: true }; }, value => { value.outcome = "published_native_only"; }]) {
    const manifest = failedTerminal(f, item); change(manifest); const artifact = f.seal(manifest);
    assert.throws(() => f.store.sealHostOfficeLocalDirectoryTerminalV2(f.ticket, { terminalArtifactId: artifact.id, terminalDigest: artifact.contentSha256 }), code("host_office_local_directory_v2_evidence_invalid"));
  }
  assert.equal(f.store.getHostOfficeLocalDirectoryTerminalV2(f.ticket.executionId), undefined);
});
