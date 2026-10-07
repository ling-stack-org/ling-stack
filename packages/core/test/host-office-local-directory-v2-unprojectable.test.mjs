/** Synthetic Core contract inputs only; never native/kernel, scope or packaged evidence. */
import assert from "node:assert/strict";
import test from "node:test";
import { officeDirectorySlotsV2, validateOfficeDirectoryHistoryV2, validateOfficeLocalDirectoryObservationPayloadV2,
  verifyOfficeLocalDirectoryReplayV2 } from "../dist/index.js";
import { verifyHostOfficeReceipt } from "../dist/storage/sqlite/host-office-local-journal-evidence.js";
import { readHostOperation } from "../dist/storage/sqlite/host-operation-journal-evidence.js";
import { directoryV2Prepared, directoryV2Capture, directoryV2Clone, directoryV2StoreFixture }
  from "./support/host-office-local-directory-v2-fixture.mjs";

const invalid = error => error.code === "host_office_local_directory_v2_evidence_invalid";
const code = expected => error => error.code === expected;
function unprojectable(execution, effect, at = effect.enteredAt) {
  return { schemaVersion: 2, protocol: execution.protocol, kind: "office_local_directory_effect_v2",
    executionId: execution.executionId, executionIdentityDigest: execution.identityDigest, source: directoryV2Clone(execution.source),
    effectId: effect.effectId, effectDigest: effect.effectDigest,
    native: { state: "returned_unprojectable", calledAt: at, returnedAt: at, errorCode: "office_local_native_packet_invalid" },
    host: { state: "unconfirmed", errorCode: "office_local_native_packet_invalid" }, resourceBindings: [], completedAt: at };
}
function fixture() {
  const prepared = directoryV2Prepared(), execution = { ...prepared, preparedArtifactId: "prepared", preparedDigest: "d".repeat(64),
    identityDigest: "e".repeat(64), revision: 0 }, effect = { effectId: "capture", ordinal: 0, kind: "capture_parents", mode: "forward",
      preparedAt: prepared.preparedAt, enteredAt: prepared.preparedAt, executionId: execution.executionId, effectDigest: "f".repeat(64), revision: 1 };
  return { execution, effect, observation: unprojectable(execution, effect) };
}

test("normal returned but unprojectable is a separate exact axis, never a native throw or not-entered", () => {
  const { execution, effect, observation } = fixture();
  assert.deepEqual(validateOfficeLocalDirectoryObservationPayloadV2(execution, effect, observation, observation.completedAt), observation);
  assert.equal(observation.native.state, "returned_unprojectable");
  assert.equal(validateOfficeDirectoryHistoryV2([{ effect, observation }]).size, 0, "unknown raw facts cannot invent resources or closure");
});

for (const [label, mutate] of [
  ["raw result", value => { value.native.result = {}; }],
  ["raw capability", value => { value.native.capability = {}; }],
  ["raw calls", value => { value.native.calls = []; }],
  ["fabricated bindings", value => { value.resourceBindings.push({ resourceSlotId: "fake", nativeLifetimeId: "fake" }); }],
  ["fabricated read bytes", value => { value.readbackBytes = { bytesSha256: "0".repeat(64), sizeBytes: 1 }; }],
  ["fabricated publication bytes", value => { value.publicationBytes = []; }],
  ["host returned", value => { value.host = { state: "returned" }; }],
  ["missing calledAt", value => { delete value.native.calledAt; }],
  ["empty error", value => { value.native.errorCode = ""; }],
  ["called before entry", value => { value.native.calledAt = "2026-10-04T23:59:59.999Z"; }],
  ["return before call", value => { value.native.calledAt = "2026-10-05T00:00:00.001Z"; }],
  ["return after completion", value => { value.native.returnedAt = "2026-10-05T00:00:00.001Z"; }],
]) test(`unprojectable rejects ${label}`, () => {
  const { execution, effect, observation } = fixture(); mutate(observation);
  assert.throws(() => validateOfficeLocalDirectoryObservationPayloadV2(execution, effect, observation, observation.completedAt), invalid);
});

test("unprojectable requires original entered effect, not a fabricated no-start callback", () => {
  const { execution, effect, observation } = fixture(); delete effect.enteredAt;
  assert.throws(() => validateOfficeLocalDirectoryObservationPayloadV2(execution, effect, observation, observation.completedAt), invalid);
});

test("unprojectable later effect preserves prior known lifetimes without adopting its unknown new resource", () => {
  const { execution, effect } = fixture(), capture = directoryV2Capture(execution, effect), next = { ...effect,
    effectId: "create-tree", ordinal: 1, kind: "create_directory", resourceSlotId: execution.members[0].resourceSlotId,
    parentResourceSlotId: execution.stage.parentResourceSlotId,
    parentNativeLifetimeId: capture.resourceBindings.find(item => item.resourceSlotId === execution.stage.parentResourceSlotId).nativeLifetimeId,
    basename: execution.members[0].basename }, unknown = unprojectable(execution, next);
  const history = validateOfficeDirectoryHistoryV2([{ effect, observation: capture }, { effect: next, observation: unknown }]);
  assert.equal(history.size, capture.resourceBindings.length);
  assert.equal(history.has(execution.members[0].resourceSlotId), false);
  assert.ok([...history.values()].every(item => item.fact.state === "retained"));
});

test("real original SQLite pair stores unknown reply, blocks forward, seals unknown and never replays or releases safe", async t => {
  const f = await directoryV2StoreFixture(t), descriptor = f.prepare(); let callbacks = 0, observation;
  f.store.launchHostOfficeLocalDirectoryEffectV2(f.ticket, descriptor.effectId, () => {
    callbacks++;
    const effect = f.store.listHostOfficeLocalDirectoryEffectsV2(f.ticket.executionId)[0];
    observation = unprojectable(f.execution(), effect, f.now());
    return "controlled Core callback returned; no native syscall asserted";
  });
  const artifact = f.seal(observation), effect = f.store.recordHostOfficeLocalDirectoryObservationV2(f.ticket, descriptor.effectId, artifact.id);
  assert.equal(f.other.getArtifact(effect.observationArtifactId).sealedPayload.native.state, "returned_unprojectable");
  assert.throws(() => f.store.launchHostOfficeLocalDirectoryEffectV2(f.ticket, effect.effectId, () => { callbacks++; }),
    code("host_office_local_effect_already_entered"));
  assert.equal(callbacks, 1);
  assert.throws(() => f.store.prepareHostOfficeLocalDirectoryEffectV2(f.ticket,
    { effectId: "later", ordinal: 1, kind: "close_session", mode: "forward", preparedAt: f.now() }),
    code("host_office_local_directory_v2_forward_blocked"));
  const execution = f.execution(), ancestors = new Set([...execution.stage.ancestors, ...execution.destination.ancestors].map(item => item.resourceSlotId));
  const manifest = { schemaVersion: 2, protocol: execution.protocol, kind: "office_local_directory_terminal_v2",
    executionId: execution.executionId, executionIdentityDigest: execution.identityDigest, source: directoryV2Clone(execution.source),
    preparedArtifactId: execution.preparedArtifactId, preparedDigest: execution.preparedDigest, outcome: "unknown", installationEntered: false,
    effects: [{ ordinal: effect.ordinal, effectId: effect.effectId, effectDigest: effect.effectDigest, enteredAt: effect.enteredAt,
      observation: { artifactId: artifact.id, digest: artifact.contentSha256 } }],
    resources: officeDirectorySlotsV2(execution).map(slot => ancestors.has(slot.resourceSlotId)
      ? { resourceSlotId: slot.resourceSlotId, state: "unknown", unknownCause: "native_reply_unknown" }
      : { resourceSlotId: slot.resourceSlotId, state: "not_acquired" }),
    canonicalVisibility: { state: "unverified", blockerCode: "original_native_reply_unknown" }, completedAt: f.now() };
  for (const outcome of ["failed", "published_native_only"]) {
    const invalidArtifact = f.seal({ ...manifest, outcome });
    assert.throws(() => f.store.sealHostOfficeLocalDirectoryTerminalV2(f.ticket,
      { terminalArtifactId: invalidArtifact.id, terminalDigest: invalidArtifact.contentSha256 }), invalid);
  }
  const terminalArtifact = f.seal(manifest), terminal = f.store.sealHostOfficeLocalDirectoryTerminalV2(f.ticket,
    { terminalArtifactId: terminalArtifact.id, terminalDigest: terminalArtifact.contentSha256 });
  assert.equal(terminal.outcome, "unknown"); assert.deepEqual(f.other.getHostOfficeLocalDirectoryTerminalV2(f.ticket.executionId), terminal);
  assert.ok(terminal.resources.filter(item => ancestors.has(item.resourceSlotId)).every(item => item.state === "unknown"));
  assert.throws(() => verifyOfficeLocalDirectoryReplayV2({ execution, terminal, effects: [{ effect, observation }] }), invalid);
  assert.throws(() => verifyHostOfficeReceipt(f.store.database, readHostOperation(f.store.database, f.parent.operationId)),
    code("host_office_local_directory_v2_safe_unavailable"));
  assert.equal(f.store.listHostOperationBlockers(f.source).length, 2);
});
