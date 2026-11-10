import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { projectOfficeLocalNativePacket } from "../dist/features/office-documents/office-local-native-facts.js";

const nonce = "a".repeat(32), lifetime = nonce + ":1";
const identity = size => ({ device: "1", inode: "2", sizeBytes: String(size), modifiedNs: "1", changedNs: "2",
  mode: 0o100600, isFile: true, isDirectory: false });
function snapshot(resources = [], readbacks = []) {
  return { sessionNonce: nonce, phase: "building", resources, installationEntered: false, residualCreation: false,
    everFailed: false, readbacks, publicationObservationClaimed: false, cancelRequested: false,
    scopeBinding: "unbound", protectedStageVerified: false, coreSafe: false, packaged: false };
}
function failedPacket() {
  const resource = { lifetimeId: lifetime, kind: "ancestor", basename: "/", parentLifetimeId: "", state: "not_acquired",
    identityObserved: false, device: "0", inode: "0", bytesWritten: "0", fsyncReturned: false };
  return { success: false, nativeOutcome: "returned", hostAcknowledgment: "not_provided", operationId: "",
    calls: [{ syscall: "open", resourceLifetimeId: lifetime, parentLifetimeId: "", nativeReturnState: "returned",
      returned: -1, success: false, errno: 13, calledAtMonotonicNs: "1", returnedAtMonotonicNs: "2" }],
    snapshot: { ...snapshot([resource]), phase: "blocked", everFailed: true }, blockerCode: "ancestor_open_failed",
    session: {}, stageParent: {}, destinationParent: {} };
}
function readPacket(bytes = Buffer.from("abc")) {
  const resource = { lifetimeId: lifetime, kind: "created_file", basename: "report.docx", parentLifetimeId: "", state: "retained",
    identityObserved: true, device: "1", inode: "2", bytesWritten: "3", fsyncReturned: true, initialIdentity: identity(0),
    identity: identity(3), initialObservedAtMonotonicNs: "1", observedAtMonotonicNs: "8" };
  const call = (syscall, returned, n, io = {}) => ({ syscall, resourceLifetimeId: lifetime, parentLifetimeId: "",
    nativeReturnState: "returned", returned, success: true, errno: 0, calledAtMonotonicNs: String(n),
    returnedAtMonotonicNs: String(n + 1), ...io });
  const calls = [call("fstat", 0, 1, { identity: identity(3) }), call("pread", 3, 3, { requestedBytes: "3", offset: "0" }),
    call("pread_eof_probe", 0, 5, { requestedBytes: "1", offset: "3" }), call("fstat", 0, 7, { identity: identity(3) })];
  const readback = { operationId: "read-original", resourceLifetimeId: lifetime, expectedBytes: "3", budgetBytes: "4",
    bytesRead: "3", maximumSyscallAttempts: "34", syscallAttempts: "2", eofObserved: true, identitiesMatch: true,
    success: true, nativeOutcome: "returned_success", calls, identityBefore: identity(3), identityAfter: identity(3) };
  return { success: true, nativeOutcome: "returned", hostAcknowledgment: "not_provided", operationId: "read-original",
    calls, snapshot: snapshot([resource], [readback]), resourceFact: resource, readback, bytes };
}

test("native false is a returned partial fact, not a thrown call or a safe receipt", () => {
  const { facts } = projectOfficeLocalNativePacket(failedPacket());
  assert.equal(facts.nativeOutcome, "returned"); assert.equal(facts.success, false);
  assert.equal(facts.calls[0].errno, 13); assert.equal(facts.operationId, "");
  assert.equal(facts.snapshot.scopeBinding, "unbound"); assert.equal(facts.snapshot.coreSafe, false);
  assert.equal("session" in facts, false); assert.equal("stageParent" in facts, false);
});

test("actual returned read Buffer is hashed without serializing payload or opaque capabilities", () => {
  const packet = readPacket(), projected = projectOfficeLocalNativePacket(packet);
  assert.deepEqual(projected.readbackBytes, { bytesSha256: createHash("sha256").update(packet.bytes).digest("hex"), sizeBytes: 3 });
  assert.equal("bytes" in projected.facts, false); assert.equal("capability" in projected.facts, false);
  packet.bytes.fill(0); packet.calls[1].returned = 2; packet.snapshot.resources[0].state = "closed";
  assert.equal(projected.facts.calls[1].returned, 3); assert.equal(projected.facts.snapshot.resources[0].state, "retained");
  assert.ok(Object.isFrozen(projected.facts.snapshot.resources[0]));
  assert.throws(() => { projected.facts.snapshot.resources[0].state = "closed"; }, TypeError);
});

test("native projection rejects top-level and nested accessors without invoking them", () => {
  for (const path of ["capability", "snapshot", "nested"]) {
    let reads = 0; const packet = failedPacket();
    const object = path === "nested" ? packet.snapshot.resources[0] : packet;
    const key = path === "nested" ? "state" : path;
    Object.defineProperty(object, key, { enumerable: true, configurable: true, get() { reads++; return "retained"; } });
    assert.throws(() => projectOfficeLocalNativePacket(packet), /office_local_native_packet_invalid/);
    assert.equal(reads, 0);
  }
});

test("extra fields, cycles, symbols and oversized history are rejected before persistence", () => {
  const extra = failedPacket(); extra.callerDigest = "a".repeat(64);
  assert.throws(() => projectOfficeLocalNativePacket(extra), /evidence_invalid/);
  const cycle = failedPacket(); cycle.snapshot.cycle = cycle.snapshot;
  assert.throws(() => projectOfficeLocalNativePacket(cycle), /packet_invalid/);
  const symbol = failedPacket(); symbol[Symbol("unsafe")] = true;
  assert.throws(() => projectOfficeLocalNativePacket(symbol), /packet_invalid/);
  const large = failedPacket(); large.calls = new Array(4097).fill(large.calls[0]);
  assert.throws(() => projectOfficeLocalNativePacket(large), /packet_invalid/);
});

test("readback cannot substitute a supplied digest, non-Buffer, missing or mismatched bytes", () => {
  for (const bytes of [undefined, new Uint8Array([97, 98, 99]), Buffer.from("ab")]) {
    const packet = readPacket(bytes); packet.bytes = bytes;
    assert.throws(() => projectOfficeLocalNativePacket(packet), /packet_invalid/);
  }
  const packet = readPacket(); delete packet.bytes; packet.bytesSha256 = "b".repeat(64);
  assert.throws(() => projectOfficeLocalNativePacket(packet), /evidence_invalid/);
  const failed = failedPacket(); failed.bytes = Buffer.from("abc");
  assert.throws(() => projectOfficeLocalNativePacket(failed), /packet_invalid/);
});

test("native capture/close batches retain their actual empty operation ID", () => {
  const packet = failedPacket(), result = projectOfficeLocalNativePacket(packet);
  assert.equal(result.facts.operationId, ""); assert.equal(result.facts.calls.length, 1);
  assert.equal("effectId" in result.facts.calls[0], false);
  assert.equal("calledAt" in result.facts.calls[0], false);
});

test("Buffer shadowed length/buffer/offset cannot run accessors or falsify the actual byte span", () => {
  const bytes = Buffer.from("abc"); let accesses = 0;
  for (const key of ["length", "buffer", "byteOffset"]) {
    Object.defineProperty(bytes, key, { get() { accesses++; return key === "length" ? 0 : undefined; } });
  }
  const projected = projectOfficeLocalNativePacket(readPacket(bytes));
  assert.equal(accesses, 0);
  assert.deepEqual(projected.readbackBytes, { bytesSha256: createHash("sha256").update("abc").digest("hex"), sizeBytes: 3 });
  const oversized = Buffer.alloc(50 * 1024 * 1024 + 1);
  Object.defineProperty(oversized, "length", { get() { accesses++; return 3; } });
  assert.throws(() => projectOfficeLocalNativePacket(readPacket(oversized)), /packet_invalid/);
  assert.equal(accesses, 0);
});

test("packet/Buffer proxies are rejected before invoking any traps", () => {
  let accesses = 0;
  const handler = { get() { accesses++; throw new Error("proxy getter executed"); },
    getPrototypeOf() { accesses++; throw new Error("proxy prototype executed"); },
    ownKeys() { accesses++; throw new Error("proxy enumeration executed"); } };
  assert.throws(() => projectOfficeLocalNativePacket(new Proxy(failedPacket(), handler)), /packet_invalid/);
  assert.throws(() => projectOfficeLocalNativePacket(readPacket(new Proxy(Buffer.from("abc"), handler))), /packet_invalid/);
  assert.equal(accesses, 0);
});
