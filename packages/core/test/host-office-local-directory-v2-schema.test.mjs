import assert from "node:assert/strict";
import test from "node:test";
import { validateOfficeLocalDirectoryPreparedV2, validateOfficeNativeIdentityV2, validateOfficeNativeResultFactsV2 } from "../dist/index.js";
import { validateOfficeLocalDirectoryObservationPayloadV2 } from "../dist/storage/sqlite/host-office-local-directory-v2-observations.js";
import { validateOfficeDirectoryHistoryV2 } from "../dist/storage/sqlite/host-office-local-directory-v2-history.js";
import { directoryV2Prepared, directoryV2Capture, directoryV2Clone, directoryV2Identity } from "./support/host-office-local-directory-v2-fixture.mjs";

const code = error => error.code === "host_office_local_directory_v2_evidence_invalid";
const fixture = () => {
  const prepared = directoryV2Prepared(), execution = { ...prepared, preparedArtifactId: "prepared", preparedDigest: "d".repeat(64), identityDigest: "e".repeat(64), revision: 0 },
    effect = { effectId: "capture", ordinal: 0, kind: "capture_parents", mode: "forward", preparedAt: prepared.preparedAt,
      executionId: execution.executionId, effectDigest: "f".repeat(64), enteredAt: prepared.preparedAt, revision: 1 };
  return { execution, effect, observation: directoryV2Capture(execution, effect) };
};
test("v2 prepared preserves different private top/canonical missing name and two aliased original ancestor inodes", () => {
  const prepared = directoryV2Prepared();
  assert.equal(prepared.stage.ancestors[0].identity.inode, prepared.destination.ancestors[0].identity.inode);
  assert.deepEqual(validateOfficeLocalDirectoryPreparedV2(prepared), prepared);
});
for (const [label, change] of [
  ["extra boolean scope authority", value => { value.scopeRef.verified = true; }],
  ["wrong graph", value => { value.graph = "leaf_file"; }],
  ["nonmissing directory", value => { value.members[0].initial = "directory"; }],
  ["slot alias", value => { value.destination.ancestors[0].resourceSlotId = value.stage.ancestors[0].resourceSlotId; }],
  ["publication slot alias", value => { value.members[0].publicationResourceSlotId = value.members[1].resourceSlotId; }],
  ["missing ancestor", value => { value.stage.ancestors.shift(); }],
  ["wrong canonical name", value => { value.members[0].canonicalPath = "/workspace/other"; }],
  ["nondecimal native size", value => { value.workspaceIdentity.sizeBytes = 4096; }],
  ["out of range native inode", value => { value.workspaceIdentity.inode = "18446744073709551616"; }],
  ["oversized output", value => { value.output.sizeBytes = 50 * 1024 * 1024 + 1; }],
]) test(`v2 prepared rejects ${label}`, () => { const value = directoryV2Prepared(); change(value); assert.throws(() => validateOfficeLocalDirectoryPreparedV2(value), code); });

test("actual monotonic first fstat precedes Host N-API return without invented wall-clock identity time", () => {
  const { execution, effect, observation } = fixture();
  assert.deepEqual(validateOfficeLocalDirectoryObservationPayloadV2(execution, effect, observation, observation.completedAt), observation);
  const resources = validateOfficeDirectoryHistoryV2([{ effect, observation }]);
  assert.equal(resources.size, 4);
  assert.notEqual(observation.resourceBindings[0].nativeLifetimeId, observation.resourceBindings[2].nativeLifetimeId);
});
test("normal returned success=false and exact errno remain failed facts, not native threw or implicit success", () => {
  const { execution, effect } = fixture(), observation = directoryV2Capture(execution, effect, { success: false });
  assert.equal(validateOfficeNativeResultFactsV2(observation.native.result).success, false);
  assert.equal(observation.native.result.calls[0].errno, 2);
  assert.equal(validateOfficeLocalDirectoryObservationPayloadV2(execution, effect, observation, observation.completedAt).native.state, "returned");
});
for (const [label, change] of [
  ["raw cap in history", value => { value.native.result.capability = {}; }],
  ["caller Core safe", value => { value.native.result.snapshot.coreSafe = true; }],
  ["caller packaged", value => { value.native.result.snapshot.packaged = true; }],
  ["fake descriptor integer", value => { value.native.result.calls[0].returned = 7; }],
  ["erased errno", value => { value.native.result.calls[0].errno = 9; }],
  ["wrong source", value => { value.source.fencingToken = "replacement"; }],
  ["wrong effect digest", value => { value.effectDigest = "0".repeat(64); }],
  ["invented capture operation ID", value => { value.native.result.operationId = "capture"; }],
  ["missing original resource", value => { value.resourceBindings.pop(); }],
  ["extra resource", value => { value.resourceBindings.push(directoryV2Clone(value.resourceBindings[0])); }],
  ["clock reversal", value => { value.native.result.calls[1].returnedAtMonotonicNs = "1"; }],
]) test(`v2 actual observation rejects ${label}`, () => {
  const { execution, effect, observation } = fixture(); change(observation);
  assert.throws(() => validateOfficeLocalDirectoryObservationPayloadV2(execution, effect, observation, observation.completedAt), code);
});
test("original batch exact acquisition and first fstat callRefs reject duplicate or unrelated lifetimes", () => {
  const { effect, observation } = fixture();
  observation.resourceBindings[1].acquisitionCallRef = observation.resourceBindings[0].acquisitionCallRef;
  assert.throws(() => validateOfficeDirectoryHistoryV2([{ effect, observation }]), code);
});

function readPacket() {
  const { execution, observation } = fixture(), snapshot = directoryV2Clone(observation.native.result.snapshot), nonce = snapshot.sessionNonce;
  const tree = { lifetimeId: nonce + ":5", kind: "created_directory", basename: "private", parentLifetimeId: snapshot.resources[1].lifetimeId,
    state: "retained", identityObserved: true, device: "1", inode: "30", bytesWritten: "0", fsyncReturned: false,
    initialIdentity: directoryV2Identity(30), identity: directoryV2Identity(30), initialObservedAtMonotonicNs: "190", observedAtMonotonicNs: "190" };
  const identity = directoryV2Identity(31, true, String(execution.output.sizeBytes)), file = { lifetimeId: nonce + ":6", kind: "created_file", basename: "report.docx", parentLifetimeId: tree.lifetimeId,
    state: "retained", identityObserved: true, device: "1", inode: "31", bytesWritten: String(execution.output.sizeBytes), fsyncReturned: true,
    initialIdentity: directoryV2Identity(31, true), identity, initialObservedAtMonotonicNs: "200", observedAtMonotonicNs: "218" };
  const call = (syscall, ordinal, returned, io) => ({ syscall, resourceLifetimeId: file.lifetimeId, parentLifetimeId: tree.lifetimeId,
    nativeReturnState: "returned", calledAtMonotonicNs: String(211 + ordinal * 2), returnedAtMonotonicNs: String(212 + ordinal * 2), returned,
    success: true, errno: 0, ...(syscall === "fstat" ? { identity: directoryV2Clone(identity) } : { requestedBytes: String(io.requested), offset: String(io.offset) }) });
  const calls = [call("fstat", 0, 0), call("pread", 1, execution.output.sizeBytes, { requested: execution.output.sizeBytes, offset: 0 }),
    call("pread_eof_probe", 2, 0, { requested: 1, offset: execution.output.sizeBytes }), call("fstat", 3, 0)];
  const readback = { operationId: "read", resourceLifetimeId: file.lifetimeId, expectedBytes: String(execution.output.sizeBytes), budgetBytes: String(execution.output.sizeBytes + 1),
    bytesRead: String(execution.output.sizeBytes), maximumSyscallAttempts: "34", syscallAttempts: "2", eofObserved: true, identitiesMatch: true,
    success: true, nativeOutcome: "returned_success", calls, identityBefore: directoryV2Clone(identity), identityAfter: directoryV2Clone(identity) };
  snapshot.resources.push(tree, file); snapshot.readbacks = [readback];
  return { success: true, nativeOutcome: "returned", hostAcknowledgment: "not_provided", operationId: "read", calls, snapshot, resourceFact: file, readback };
}
test("original read facts require expected+1 budget, true one-byte EOF and equal full fstat identities", () => {
  const packet = readPacket(); assert.deepEqual(validateOfficeNativeResultFactsV2(packet), packet);
});
for (const [label, change] of [
  ["incorrect read budget", value => { value.readback.budgetBytes = value.readback.expectedBytes; }],
  ["missing EOF syscall", value => { value.calls.splice(2, 1); value.readback.syscallAttempts = "1"; }],
  ["EOF read positive", value => { value.calls[2].returned = 1; }],
  ["before/after identity change", value => { value.readback.identityAfter.changedNs = "2"; }],
  ["unrelated fstat identity", value => { value.calls[0].identity.inode = "99"; }],
  ["unbounded retry count", value => { value.readback.syscallAttempts = "1000000"; }],
]) test(`bounded original read rejects ${label}`, () => { const packet = readPacket(); change(packet); assert.throws(() => validateOfficeNativeResultFactsV2(packet), code); });

for (const [label, mode] of [["foreign FIFO", 0o010600], ["foreign character device", 0o020666]]) {
  test(`returned-false factual projection preserves ${label} original fstat identity without converting it to native threw`, () => {
    const packet = readPacket(), file = packet.resourceFact, foreign = { ...directoryV2Identity(99, true), mode, isFile: false, isDirectory: false };
    assert.deepEqual(validateOfficeNativeIdentityV2(foreign), foreign);
    packet.success = false; packet.readback.success = false; packet.readback.nativeOutcome = "returned_failed";
    packet.readback.blockerCode = "readback_original_node_mismatch"; packet.blockerCode = packet.readback.blockerCode;
    packet.readback.identityBefore = foreign; delete packet.readback.identityAfter; packet.readback.identitiesMatch = false;
    packet.readback.bytesRead = "0"; packet.readback.syscallAttempts = "0"; packet.readback.eofObserved = false;
    packet.calls.splice(1); packet.calls[0].identity = directoryV2Clone(foreign);
    file.identity = foreign; file.device = foreign.device; file.inode = foreign.inode; file.state = "unknown"; file.observedAtMonotonicNs = packet.calls[0].returnedAtMonotonicNs;
    packet.snapshot.phase = "blocked"; packet.snapshot.everFailed = true;
    assert.deepEqual(validateOfficeNativeResultFactsV2(packet), packet);
    assert.equal(packet.nativeOutcome, "returned"); assert.equal(packet.success, false);
    const prepared = directoryV2Prepared(); prepared.workspaceIdentity = foreign;
    assert.throws(() => validateOfficeLocalDirectoryPreparedV2(prepared), code, "historical foreign-node facts cannot satisfy prepared directory authority");
  });
}
