/** Controlled Core DTOs only: exact factual contract tests, never native/syscall/scope/kernel proof. */
import assert from "node:assert/strict";
import test from "node:test";
import { validateOfficeLocalDirectoryObservationPayloadV2, validateOfficeDirectoryHistoryV2 } from "../dist/index.js";
import { directoryV2Prepared, directoryV2Capture, directoryV2Clone, directoryV2Identity, directoryV2StoreFixture }
  from "./support/host-office-local-directory-v2-fixture.mjs";

const invalid = error => error.code === "host_office_local_directory_v2_evidence_invalid";
const code = expected => error => error.code === expected;
function failureFixture(kind = "create_directory", supplied = {}) {
  const prepared = directoryV2Prepared(), execution = supplied.execution ?? { ...prepared, preparedArtifactId: "prepared",
    preparedDigest: "d".repeat(64), identityDigest: "e".repeat(64), revision: 0 },
    captureEffect = { effectId: "capture", ordinal: 0, kind: "capture_parents", mode: "forward", preparedAt: execution.preparedAt,
      enteredAt: execution.preparedAt, executionId: execution.executionId, effectDigest: "f".repeat(64), revision: 1 },
    capture = supplied.capture ?? directoryV2Capture(execution, captureEffect),
    snapshot = directoryV2Clone(capture.native.result.snapshot), bindings = directoryV2Clone(capture.resourceBindings);
  const lifetime = serial => snapshot.sessionNonce + ":" + serial, tree = execution.members[0], file = execution.members.at(-1);
  if (kind === "create_file") {
    const id = lifetime(snapshot.resources.length + 1), parent = bindings.find(item => item.resourceSlotId === tree.parentResourceSlotId).nativeLifetimeId,
      identity = directoryV2Identity(30);
    snapshot.resources.push({ lifetimeId: id, kind: "created_directory", basename: tree.basename, parentLifetimeId: parent,
      state: "retained", identityObserved: true, device: "1", inode: "30", bytesWritten: "0", fsyncReturned: false,
      initialIdentity: identity, identity: directoryV2Clone(identity), initialObservedAtMonotonicNs: "190", observedAtMonotonicNs: "190" });
    // These parser-only parent refs describe a prior controlled fixture effect,
    // not native acquisition authority or an input for real history settlement.
    bindings.push({ resourceSlotId: tree.resourceSlotId, nativeLifetimeId: id,
      acquisitionCallRef: { effectId: "prior-tree", ordinal: 1 }, firstFstatCallRef: { effectId: "prior-tree", ordinal: 2 } });
  }
  const member = kind === "create_directory" ? tree : file,
    parent = bindings.find(item => item.resourceSlotId === member.parentResourceSlotId).nativeLifetimeId,
    resource = { lifetimeId: lifetime(snapshot.resources.length + 1), kind: member.kind, basename: member.basename, parentLifetimeId: parent,
      state: "not_acquired", identityObserved: false, device: "0", inode: "0", bytesWritten: "0", fsyncReturned: false },
    effect = supplied.effect ?? { effectId: "failed-creator", ordinal: 1, kind, mode: "forward", resourceSlotId: member.resourceSlotId,
      parentResourceSlotId: member.parentResourceSlotId, parentNativeLifetimeId: parent, basename: member.basename,
      preparedAt: execution.preparedAt, enteredAt: execution.preparedAt, executionId: execution.executionId, effectDigest: "0".repeat(64), revision: 1 };
  snapshot.resources.push(resource); snapshot.phase = "blocked"; snapshot.everFailed = true;
  const binding = { resourceSlotId: member.resourceSlotId, nativeLifetimeId: resource.lifetimeId }; bindings.push(binding);
  const call = { syscall: kind === "create_directory" ? "mkdirat" : "openat_create_exclusive", resourceLifetimeId: resource.lifetimeId,
    parentLifetimeId: parent, nativeReturnState: "returned", calledAtMonotonicNs: "200", returnedAtMonotonicNs: "201",
    returned: -1, success: false, errno: 17 };
  const observation = { schemaVersion: 2, protocol: execution.protocol, kind: "office_local_directory_effect_v2",
    executionId: execution.executionId, executionIdentityDigest: execution.identityDigest, source: directoryV2Clone(execution.source),
    effectId: effect.effectId, effectDigest: effect.effectDigest,
    native: { state: "returned", calledAt: effect.enteredAt, returnedAt: effect.enteredAt,
      result: { success: false, nativeOutcome: "returned", hostAcknowledgment: "not_provided", operationId: effect.effectId, calls: [call], snapshot } },
    host: { state: "returned" }, resourceBindings: bindings, completedAt: effect.enteredAt };
  return { execution, effect, observation, resource, binding, call, captureEffect, capture };
}
function validate(f) {
  return validateOfficeLocalDirectoryObservationPayloadV2(f.execution, f.effect, f.observation, f.observation.completedAt);
}
for (const kind of ["create_directory", "create_file"]) {
  test(`${kind} one original returned -1/errno with not-acquired snapshot and no resourceFact remains failed factual return`, () => {
    const f = failureFixture(kind), result = validate(f);
    assert.equal(result.native.state, "returned"); assert.equal(result.native.result.success, false);
    assert.equal(Object.hasOwn(result.native.result, "resourceFact"), false); assert.equal(result.native.result.calls[0].errno, 17);
    assert.equal(f.resource.state, "not_acquired"); assert.equal(Object.hasOwn(f.binding, "acquisitionCallRef"), false);
    assert.equal(Object.hasOwn(f.binding, "firstFstatCallRef"), false);
  });
  for (const [label, mutate] of [
    ["aggregate success", f => { f.observation.native.result.success = true; }],
    ["wrong original basename", f => { f.effect.basename = "other"; }],
    ["wrong original parent", f => { f.effect.parentNativeLifetimeId = f.resource.lifetimeId; }],
    ["different syscall", f => { f.call.syscall = "openat"; }],
    ["extra failed syscall", f => { f.observation.native.result.calls.push({ ...f.call, calledAtMonotonicNs: "202", returnedAtMonotonicNs: "203" }); }],
    ["no failed syscall", f => { f.observation.native.result.calls.length = 0; }],
    ["unreturned syscall", f => { f.call.nativeReturnState = "not_returned"; f.call.returnedAtMonotonicNs = "0"; delete f.call.returned; delete f.call.success; delete f.call.errno; }],
    ["nonfailure return", f => { f.call.returned = 0; f.call.success = true; f.call.errno = 0; }],
    ["erased errno", f => { f.call.errno = 0; }],
    ["claimed acquisition", f => { f.binding.acquisitionCallRef = { effectId: "capture", ordinal: 0 }; }],
    ["claimed first stat", f => { f.binding.firstFstatCallRef = { effectId: "capture", ordinal: 1 }; }],
    ["claimed retained resource", f => { f.resource.state = "retained"; f.binding.acquisitionCallRef = { effectId: "capture", ordinal: 0 }; }],
    ["forged unacquired inode", f => { f.resource.inode = "99"; }],
    ["forged unacquired device", f => { f.resource.device = "1"; }],
    ["claimed write", f => { f.resource.bytesWritten = "1"; }],
    ["claimed fsync", f => { f.resource.fsyncReturned = true; }],
    ["nonblocked snapshot", f => { f.observation.native.result.snapshot.phase = "building"; }],
    ["missing failure latch", f => { f.observation.native.result.snapshot.everFailed = false; }],
    ["missing target binding", f => { f.observation.resourceBindings.pop(); }],
  ]) test(`${kind} missing-resourceFact exception rejects ${label}`, () => {
    const f = failureFixture(kind); mutate(f); assert.throws(() => validate(f), invalid);
  });
  test(`${kind} genuine acquired-success shape still requires resourceFact and keeps its original validator`, () => {
    const f = failureFixture(kind), result = f.observation.native.result, resource = f.resource, identity = directoryV2Identity(31, kind === "create_file"),
      acquisition = kind === "create_directory" ? 1 : 0, firstStat = acquisition + 1;
    Object.assign(resource, { state: "retained", identityObserved: true, device: "1", inode: "31",
      initialIdentity: identity, identity: directoryV2Clone(identity), initialObservedAtMonotonicNs: "205", observedAtMonotonicNs: "205" });
    const makeCall = (syscall, ordinal, returned) => ({ syscall, resourceLifetimeId: resource.lifetimeId, parentLifetimeId: resource.parentLifetimeId,
      nativeReturnState: "returned", calledAtMonotonicNs: String(200 + ordinal * 2), returnedAtMonotonicNs: String(201 + ordinal * 2),
      returned, success: true, errno: 0, ...(syscall === "fstat" ? { identity: directoryV2Clone(identity) } : {}) });
    result.calls = [...(kind === "create_directory" ? [makeCall("mkdirat", 0, 0)] : []),
      makeCall(kind === "create_directory" ? "openat" : "openat_create_exclusive", acquisition, "descriptor_acquired_redacted"),
      makeCall("fstat", firstStat, 0)];
    resource.initialObservedAtMonotonicNs = result.calls.at(-1).returnedAtMonotonicNs; resource.observedAtMonotonicNs = resource.initialObservedAtMonotonicNs;
    Object.assign(f.binding, { acquisitionCallRef: { effectId: f.effect.effectId, ordinal: acquisition },
      firstFstatCallRef: { effectId: f.effect.effectId, ordinal: firstStat } });
    result.success = true; result.snapshot.phase = "building"; result.snapshot.everFailed = false; result.resourceFact = directoryV2Clone(resource);
    assert.equal(validate(f).native.result.success, true);
    delete result.resourceFact; assert.throws(() => validate(f), invalid, "successful creators cannot use the failed-unacquired exception");
  });
}

test("original SQLite directory failed creator saves exact errno without foreign adoption, stops forward and keeps both blockers", async t => {
  const f = await directoryV2StoreFixture(t), descriptor = f.prepare(); let capture;
  f.store.launchHostOfficeLocalDirectoryEffectV2(f.ticket, descriptor.effectId, () => {
    const effect = f.store.listHostOfficeLocalDirectoryEffectsV2(f.ticket.executionId)[0]; capture = directoryV2Capture(f.execution(), effect);
    capture.native.calledAt = f.now(); capture.native.returnedAt = f.now(); capture.completedAt = f.now();
    return capture.native.result;
  });
  const captureArtifact = f.seal(capture), captureEffect = f.store.recordHostOfficeLocalDirectoryObservationV2(f.ticket, descriptor.effectId, captureArtifact.id),
    execution = f.execution(), member = execution.members[0],
    parent = capture.resourceBindings.find(item => item.resourceSlotId === member.parentResourceSlotId).nativeLifetimeId,
    create = f.store.prepareHostOfficeLocalDirectoryEffectV2(f.ticket, { effectId: "failed-creator", ordinal: 1, kind: "create_directory", mode: "forward",
      resourceSlotId: member.resourceSlotId, parentResourceSlotId: member.parentResourceSlotId, parentNativeLifetimeId: parent,
      basename: member.basename, preparedAt: f.now() }); let observation;
  f.store.launchHostOfficeLocalDirectoryEffectV2(f.ticket, create.effectId, () => {
    const effect = f.store.listHostOfficeLocalDirectoryEffectsV2(f.ticket.executionId).at(-1);
    observation = failureFixture("create_directory", { execution: f.execution(), effect, capture }).observation;
    observation.native.calledAt = f.now(); observation.native.returnedAt = f.now(); observation.completedAt = f.now();
    return observation.native.result;
  });
  const artifact = f.seal(observation), effect = f.store.recordHostOfficeLocalDirectoryObservationV2(f.ticket, create.effectId, artifact.id),
    known = validateOfficeDirectoryHistoryV2([{ effect: captureEffect, observation: capture }, { effect, observation }]);
  assert.equal(known.get(member.resourceSlotId).fact.state, "not_acquired");
  assert.equal(Object.hasOwn(known.get(member.resourceSlotId).binding, "acquisitionCallRef"), false);
  assert.equal(f.other.getArtifact(effect.observationArtifactId).sealedPayload.native.result.calls[0].errno, 17);
  assert.throws(() => f.store.prepareHostOfficeLocalDirectoryEffectV2(f.ticket, { effectId: "later", ordinal: 2, kind: "close_session",
    mode: "forward", preparedAt: f.now() }), code("host_office_local_directory_v2_forward_blocked"));
  assert.equal(f.store.listHostOperationBlockers(f.source).length, 2);
});
