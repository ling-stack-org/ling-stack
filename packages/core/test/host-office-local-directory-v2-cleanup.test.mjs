import assert from "node:assert/strict";
import test from "node:test";
import { validateOfficeLocalDirectoryObservationPayloadV2 } from "../dist/storage/sqlite/host-office-local-directory-v2-observations.js";
import { validateOfficeNativeResultFactsV2 } from "../dist/storage/sqlite/host-office-local-native-v2-schema.js";
import { directoryV2Capture, directoryV2Clone, directoryV2Identity, directoryV2Prepared } from "./support/host-office-local-directory-v2-fixture.mjs";

const invalid = error => error.code === "host_office_local_directory_v2_evidence_invalid";

/** DTO contract fixture only. It does not execute native code or issue a Host/safe capability. */
function cleanupFixture() {
  const prepared = directoryV2Prepared(), execution = { ...prepared, preparedArtifactId: "prepared", preparedDigest: "d".repeat(64),
    identityDigest: "e".repeat(64), revision: 0 };
  const capture = { effectId: "capture", ordinal: 0, kind: "capture_parents", mode: "forward", preparedAt: prepared.preparedAt,
    executionId: execution.executionId, effectDigest: "f".repeat(64), enteredAt: prepared.preparedAt, revision: 1 };
  const observation = directoryV2Capture(execution, capture), resources = observation.native.result.snapshot.resources;
  const nonce = observation.native.result.snapshot.sessionNonce;
  const observer = (slot, kind, name, parent, number) => {
    const lifetimeId = `${nonce}:${number}`, identity = directoryV2Identity(number, kind === "publication_file");
    resources.push({ lifetimeId, kind, basename: name, parentLifetimeId: parent, state: "closed", identityObserved: true,
      device: identity.device, inode: identity.inode, bytesWritten: "0", fsyncReturned: false,
      initialIdentity: directoryV2Clone(identity), identity: directoryV2Clone(identity), initialObservedAtMonotonicNs: "200",
      observedAtMonotonicNs: "200" });
    observation.resourceBindings.push({ resourceSlotId: slot, nativeLifetimeId: lifetimeId,
      acquisitionCallRef: { effectId: "publication", ordinal: number }, firstFstatCallRef: { effectId: "publication", ordinal: number + 1 } });
    return lifetimeId;
  };
  const tree = observer("tree-publication", "publication_directory", "new", resources.at(-1).lifetimeId, 5);
  observer("file-publication", "publication_file", "report.docx", tree, 6);
  let clock = 300n;
  const calls = [];
  for (const resource of [...resources].reverse()) {
    resource.state = "closed";
    if (resource.kind.startsWith("publication_")) {
      calls.push({ syscall: "fstat", resourceLifetimeId: resource.lifetimeId, parentLifetimeId: resource.parentLifetimeId,
        nativeReturnState: "returned", calledAtMonotonicNs: String(++clock), returnedAtMonotonicNs: String(++clock),
        returned: 0, success: true, errno: 0, identity: directoryV2Clone(resource.identity) });
      resource.observedAtMonotonicNs = calls.at(-1).returnedAtMonotonicNs;
    }
    calls.push({ syscall: "close", resourceLifetimeId: resource.lifetimeId, parentLifetimeId: resource.parentLifetimeId,
      nativeReturnState: "returned", calledAtMonotonicNs: String(++clock), returnedAtMonotonicNs: String(++clock), returned: 0, success: true, errno: 0 });
  }
  const effect = { ...capture, effectId: "cleanup", ordinal: 1, kind: "close_session", mode: "cleanup" };
  observation.effectId = effect.effectId;
  observation.native.result.calls = calls;
  observation.native.result.snapshot.phase = "closed";
  return { execution, effect, observation };
}
function check({ execution, effect, observation }) {
  return validateOfficeLocalDirectoryObservationPayloadV2(execution, effect, observation, observation.completedAt);
}
test("close_session preserves original guarded publication cleanup after a failed forward operation", () => {
  const fixture = cleanupFixture();
  fixture.observation.native.result.snapshot.everFailed = true;
  assert.deepEqual(check(fixture), fixture.observation);
  assert.equal(check(fixture).native.result.snapshot.coreSafe, false);
});

test("a failed observer guard records unknown and never invents a close on the reused descriptor", () => {
  const fixture = cleanupFixture(), result = fixture.observation.native.result, file = result.snapshot.resources.at(-1);
  result.calls.shift();
  result.calls[0] = { ...result.calls[0], syscall: "fstat", returned: -1, success: false, errno: 9 };
  file.state = "unknown";
  file.observedAtMonotonicNs = file.initialObservedAtMonotonicNs;
  result.success = false; result.snapshot.everFailed = true;
  assert.deepEqual(check(fixture), fixture.observation);
});

test("non-EBADF observer guard failure preserves retained lifetime and exact errno", () => {
  const fixture = cleanupFixture(), result = fixture.observation.native.result, file = result.snapshot.resources.at(-1);
  result.calls.splice(1, 1);
  Object.assign(result.calls[0], { returned: -1, success: false, errno: 5 }); delete result.calls[0].identity;
  file.state = "retained"; file.observedAtMonotonicNs = file.initialObservedAtMonotonicNs;
  result.success = false; result.snapshot.everFailed = true;
  assert.deepEqual(check(fixture), fixture.observation);
});

test("close failure tombstones one original lifetime while cleanup continues to the remaining resources", () => {
  const fixture = cleanupFixture(), result = fixture.observation.native.result;
  Object.assign(result.calls[1], { returned: -1, success: false, errno: 4 });
  result.snapshot.resources.at(-1).state = "unknown";
  result.success = false; result.snapshot.everFailed = true;
  assert.deepEqual(check(fixture), fixture.observation);
});

test("already closed and unacquired lifetimes need no invented close in a returned cleanup", () => {
  const fixture = cleanupFixture(), result = fixture.observation.native.result;
  result.calls = [];
  const unacquired = result.snapshot.resources.at(-1);
  Object.assign(unacquired, { state: "not_acquired", identityObserved: false, device: "0", inode: "0" });
  for (const key of ["initialIdentity", "identity", "initialObservedAtMonotonicNs", "observedAtMonotonicNs"]) delete unacquired[key];
  const binding = fixture.observation.resourceBindings.at(-1);
  delete binding.acquisitionCallRef; delete binding.firstFstatCallRef;
  assert.deepEqual(check(fixture), fixture.observation);
  result.snapshot.resources[0].state = "unknown"; result.success = false;
  assert.deepEqual(check(fixture), fixture.observation);
});

for (const [label, change] of [
  ["observer close without original guard", result => { result.calls.shift(); }],
  ["guard borrowed from ordinary ancestor", result => {
    const resource = result.snapshot.resources[0];
    Object.assign(result.calls[0], { resourceLifetimeId: resource.lifetimeId, parentLifetimeId: resource.parentLifetimeId,
      identity: directoryV2Clone(resource.identity) });
  }],
  ["extra guarded close retry", result => {
    const retry = { ...result.calls[1], calledAtMonotonicNs: "305", returnedAtMonotonicNs: "306" };
    result.calls.splice(2, 0, retry);
    for (let index = 3; index < result.calls.length; index++) {
      result.calls[index].calledAtMonotonicNs = String(307 + index * 2);
      result.calls[index].returnedAtMonotonicNs = String(308 + index * 2);
    }
  }],
  ["guard failure followed by descriptor close", result => {
    Object.assign(result.calls[0], { returned: -1, success: false, errno: 9 }); delete result.calls[0].identity;
    result.snapshot.resources.at(-1).state = "unknown"; result.success = false;
  }],
  ["successful close but unknown resource", result => { result.snapshot.resources.at(-1).state = "unknown"; }],
  ["same-node guard omits required close", result => { result.calls.splice(1, 1); result.success = false; }],
  ["skipped retained ancestor", result => { result.calls.pop(); result.snapshot.resources[0].state = "retained"; result.success = false; }],
  ["snapshot phase alone claims closure", result => { result.snapshot.phase = "blocked"; }],
  ["normal ancestor gains an extra fstat", result => {
    const resource = result.snapshot.resources[0], call = result.calls.at(-1);
    result.calls.splice(-1, 0, { ...call, syscall: "fstat", identity: directoryV2Clone(resource.identity),
      calledAtMonotonicNs: call.calledAtMonotonicNs, returnedAtMonotonicNs: String(BigInt(call.calledAtMonotonicNs) + 1n) });
    call.calledAtMonotonicNs = String(BigInt(call.calledAtMonotonicNs) + 2n);
    call.returnedAtMonotonicNs = String(BigInt(call.returnedAtMonotonicNs) + 2n);
  }],
]) test(`close_session rejects ${label}`, () => {
  const fixture = cleanupFixture(); change(fixture.observation.native.result);
  assert.doesNotThrow(() => validateOfficeNativeResultFactsV2(fixture.observation.native.result), "the cleanup guard must be the rejecting layer, not a malformed primitive packet");
  assert.throws(() => check(fixture), invalid);
});
