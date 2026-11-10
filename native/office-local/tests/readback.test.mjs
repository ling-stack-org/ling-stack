import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixture, succeeded } from "./test-helpers.mjs";

const addon = createRequire(import.meta.url)(process.env.OFFICE_LOCAL_ADDON);
const maximum = 50 * 1024 * 1024;
const evidence = facts => console.log(JSON.stringify({ kind: "office_native_readback_test_evidence", ...facts }));

function openFile(t, bytes = Buffer.from("original-native-file")) {
  const f = fixture(t, addon), held = succeeded(f.open());
  const tree = succeeded(addon.createDirectory(held.session, held.stageParent, "native-tree", "mkdir-tree"));
  const file = succeeded(addon.createFile(held.session, tree.capability, "file", "create-file"));
  succeeded(addon.writeFile(held.session, file.capability, bytes, "write-file"));
  succeeded(addon.fsyncResource(held.session, file.capability, "sync-file"));
  return { f, held, tree, file, bytes, path: join(f.stage, "native-tree/file") };
}

function completeRead(result, expected) {
  succeeded(result);
  assert.equal(addon.protocolVersion, 2);
  assert.deepEqual(result.bytes, expected);
  assert.equal(result.readback.expectedBytes, String(expected.length));
  assert.equal(result.readback.budgetBytes, String(expected.length + 1));
  assert.equal(result.readback.bytesRead, String(expected.length));
  assert.equal(result.readback.nativeOutcome, "returned_success");
  assert.equal(result.readback.eofObserved, true); assert.equal(result.readback.identitiesMatch, true);
  assert.deepEqual(result.readback.identityBefore, result.readback.identityAfter);
  assert.equal(result.readback.identityBefore.sizeBytes, String(expected.length));
  assert.equal(result.readback.identityBefore.isFile, true); assert.equal(result.readback.identityBefore.isDirectory, false);
  assert.match(result.readback.identityBefore.modifiedNs, /^-?\d+$/); assert.match(result.readback.identityBefore.changedNs, /^-?\d+$/);
  assert.equal(result.calls[0].syscall, "fstat"); assert.equal(result.calls.at(-1).syscall, "fstat");
  const eof = result.calls.find(call => call.syscall === "pread_eof_probe");
  assert.equal(eof.returned, 0); assert.equal(eof.success, true); assert.equal(eof.errno, 0);
  assert.equal(eof.requestedBytes, "1"); assert.equal(eof.offset, String(expected.length));
  for (const call of result.calls) {
    assert.equal(call.nativeReturnState, "returned"); assert.equal(call.success, true); assert.equal(call.errno, 0);
    assert.ok(BigInt(call.calledAtMonotonicNs) > 0n); assert.ok(BigInt(call.returnedAtMonotonicNs) >= BigInt(call.calledAtMonotonicNs));
    assert.equal(call.resourceLifetimeId, result.resourceFact.lifetimeId);
  }
  assert.equal(result.snapshot.readbacks.at(-1).operationId, result.operationId);
  assert.deepEqual(result.snapshot.readbacks.at(-1).calls, result.calls);
  // The native history preserves facts, not a replayable/cached payload result.
  assert.equal(Object.hasOwn(result.snapshot.readbacks.at(-1), "bytes"), false);
  return result;
}

test("readback: real leaf path ABA reads original held FD, never foreign canonical replacement", t => {
  const owned = openFile(t);
  const displaced = owned.path + "-original";
  renameSync(owned.path, displaced); writeFileSync(owned.path, Buffer.alloc(owned.bytes.length, 0x66));
  const foreign = lstatSync(owned.path, { bigint: true }), original = lstatSync(displaced, { bigint: true });
  assert.notEqual(foreign.ino, original.ino);
  const result = completeRead(addon.readFile(owned.held.session, owned.file.capability,
    owned.bytes.length, owned.bytes.length + 1, "read-original-once"), owned.bytes);
  assert.equal(result.readback.identityBefore.inode, String(original.ino));
  assert.equal(result.resourceFact.initialIdentity.inode, String(original.ino));
  assert.equal(result.resourceFact.initialIdentity.sizeBytes, "0");
  assert.equal(result.calls.some(call => call.syscall === "open" || call.syscall.startsWith("openat")), false);
  assert.deepEqual(readFileSync(owned.path), Buffer.alloc(owned.bytes.length, 0x66));
  assert.throws(() => addon.readFile(owned.held.session, owned.file.capability,
    owned.bytes.length, owned.bytes.length + 1, "read-original-once"), /operation_already_consumed/);
  evidence({ case: "real-leaf-ABA-original-pread", originalInode: String(original.ino), foreignInode: String(foreign.ino),
    readback: result.readback, foreignContentsUnchanged: true, pathReopen: false });
});

test("readback: zero bytes still uses a real EOF probe and complete original identity window", t => {
  const owned = openFile(t, Buffer.alloc(0));
  const result = completeRead(addon.readFile(owned.held.session, owned.file.capability, 0, 1, "read-empty"), owned.bytes);
  assert.deepEqual(result.calls.map(call => call.syscall), ["fstat", "pread_eof_probe", "fstat"]);
});

test("readback: exact budget, type and 50 MiB ceiling are checked before fstat/pread entry", t => {
  const owned = openFile(t);
  const before = addon.inspectSession(owned.held.session);
  for (const [expected, budget] of [[owned.bytes.length, owned.bytes.length], [owned.bytes.length, owned.bytes.length + 2],
    [maximum + 1, maximum + 2], [-1, 0], [NaN, 1], [Infinity, 1], [1.5, 2.5], ["1", 2]]) {
    assert.throws(() => addon.readFile(owned.held.session, owned.file.capability, expected, budget,
      `bad-budget-${String(expected)}-${String(budget)}`), /invalid_read_budget/);
  }
  assert.deepEqual(addon.inspectSession(owned.held.session).readbacks, before.readbacks);
  assert.equal(addon.inspectSession(owned.held.session).phase, "building");
  completeRead(addon.readFile(owned.held.session, owned.file.capability,
    owned.bytes.length, owned.bytes.length + 1, "valid-budget"), owned.bytes);
});

test("readback: expected-size mismatch is an explicit failed native result, not a successful returned packet", t => {
  const owned = openFile(t);
  const result = addon.readFile(owned.held.session, owned.file.capability, owned.bytes.length - 1,
    owned.bytes.length, "expected-size-wrong");
  assert.equal(result.nativeOutcome, "returned"); assert.equal(result.success, false);
  assert.equal(result.readback.nativeOutcome, "returned_failed");
  assert.equal(result.readback.blockerCode, "readback_size_mismatch");
  assert.equal(result.calls.length, 1); assert.equal(result.calls[0].syscall, "fstat");
  assert.equal(result.calls[0].success, true); assert.equal(result.calls[0].errno, 0);
  assert.equal(result.bytes, undefined); assert.equal(result.snapshot.phase, "blocked");
  assert.equal(result.resourceFact.state, "retained");
  assert.throws(() => addon.readFile(owned.held.session, owned.file.capability,
    owned.bytes.length, owned.bytes.length + 1, "new-source"), /session_not_building/);
  evidence({ case: "genuine-fstat-size-mismatch", readback: result.readback, noPreadEntered: true });
});

test("readback: actual same-inode appended bytes fail exact size before any pread", t => {
  const owned = openFile(t);
  writeFileSync(owned.path, Buffer.concat([owned.bytes, Buffer.from(" foreign append")]));
  const originalInode = owned.file.resourceFact.inode;
  assert.equal(String(lstatSync(owned.path, { bigint: true }).ino), originalInode);
  const result = addon.readFile(owned.held.session, owned.file.capability,
    owned.bytes.length, owned.bytes.length + 1, "same-inode-modified");
  assert.equal(result.success, false); assert.equal(result.readback.blockerCode, "readback_size_mismatch");
  assert.equal(result.readback.identityBefore.inode, originalInode);
  assert.notEqual(result.readback.identityBefore.sizeBytes, String(owned.bytes.length));
  assert.equal(result.calls.some(call => call.syscall.startsWith("pread")), false);
});

test("readback: multi-chunk original FD reads stay in exact budget and close before install", t => {
  const bytes = Buffer.alloc(131079, 0x5a), owned = openFile(t, bytes);
  const result = completeRead(addon.readFile(owned.held.session, owned.file.capability, bytes.length, bytes.length + 1, "read-chunks"), bytes);
  const chunks = result.calls.filter(call => call.syscall === "pread");
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map(call => call.offset), ["0", "65536", "131072"]);
  assert.equal(chunks.reduce((sum, call) => sum + call.returned, 0), bytes.length);
  assert.throws(() => addon.installTree(owned.held.session, owned.tree.capability, "published", "install-before-close"), /file_not_synced_and_closed|directory_not_synced_and_retained/);
  succeeded(addon.closeResource(owned.held.session, owned.file.capability, "original-close"));
  const before = addon.inspectSession(owned.held.session).readbacks.length;
  assert.throws(() => addon.readFile(owned.held.session, owned.file.capability, bytes.length, bytes.length + 1, "closed-read"), /resource_not_retained/);
  assert.equal(addon.inspectSession(owned.held.session).readbacks.length, before);
  succeeded(addon.fsyncResource(owned.held.session, owned.tree.capability, "sync-tree"));
  succeeded(addon.installTree(owned.held.session, owned.tree.capability, "published", "install-after-close"));
  assert.deepEqual(readFileSync(join(owned.f.workspace, "published/file")), bytes);
});

test("readback: cancellation rejects fstat/pread without erasing prior original native facts", t => {
  const owned = openFile(t);
  const first = completeRead(addon.readFile(owned.held.session, owned.file.capability,
    owned.bytes.length, owned.bytes.length + 1, "before-cancel"), owned.bytes);
  addon.cancelSession(owned.held.session);
  assert.throws(() => addon.readFile(owned.held.session, owned.file.capability,
    owned.bytes.length, owned.bytes.length + 1, "after-cancel"), /session_not_building/);
  const current = addon.inspectSession(owned.held.session);
  assert.equal(current.readbacks.length, 1); assert.deepEqual(current.readbacks[0], first.readback);
  const closed = succeeded(addon.closeSession(owned.held.session));
  assert.deepEqual(closed.snapshot.readbacks[0], first.readback);
});

test("readback: real 50 MiB boundary succeeds with exactly one additional EOF probe byte", t => {
  const bytes = Buffer.alloc(maximum, 0x51), owned = openFile(t, bytes);
  const result = completeRead(addon.readFile(owned.held.session, owned.file.capability, maximum, maximum + 1, "read-maximum"), bytes);
  assert.equal(result.calls.filter(call => call.syscall === "pread").length, 800);
  assert.equal(result.bytes.length, maximum);
  assert.equal(result.readback.syscallAttempts, "801");
  assert.equal(result.readback.maximumSyscallAttempts, "833");
  evidence({ case: "real-50MiB-budget-boundary", expectedBytes: result.readback.expectedBytes,
    budgetBytes: result.readback.budgetBytes, bytesRead: result.readback.bytesRead,
    eofActualReturned: result.calls.find(call => call.syscall === "pread_eof_probe").returned,
    identitiesMatch: result.readback.identitiesMatch });
});

test("readback: opaque/foreign caps and fake caller identity never establish read authority", t => {
  const owned = openFile(t), other = succeeded(owned.f.open());
  assert.throws(() => addon.readFile(owned.held.session, structuredClone(owned.file.capability),
    owned.bytes.length, owned.bytes.length + 1, "cloned-read"), /invalid_capability/);
  assert.throws(() => addon.readFile(other.session, owned.file.capability,
    owned.bytes.length, owned.bytes.length + 1, "foreign-read"), /foreign_session_capability/);
  assert.throws(() => addon.readFile(owned.held.session, { ...owned.file.resourceFact, private: true, coreSafe: true },
    owned.bytes.length, owned.bytes.length + 1, "fake-proof-read"), /invalid_capability/);
  assert.equal(addon.inspectSession(owned.held.session).readbacks.length, 0);
});

test("readback: real EBADF then descriptor reuse remains unreadable before fstat/pread entry", t => {
  const f = fixture(t, addon);
  const result = spawnSync(process.env.OFFICE_LOCAL_LIFETIME_TEST, [f.stage, f.workspace], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.signal, null);
  const native = JSON.parse(result.stdout.trim());
  assert.equal(native.readbackRejectedBeforeFstatPread, true); assert.equal(native.foreignDescriptorStillOpen, true);
  assert.equal(native.retainedReusedFDOriginalNodeMismatchBeforePread, true);
  evidence({ case: "real-unknown-close-read-refused", native });
});

test("readback: real fstat EBADF tombstones before FD reuse and both closeSession and abandonment", t => {
  const f = fixture(t, addon);
  const result = spawnSync(process.env.OFFICE_LOCAL_LIFETIME_TEST,
    [f.stage, f.workspace, "read-fstat-ebadf"], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`); assert.equal(result.signal, null);
  const native = JSON.parse(result.stdout.trim());
  assert.equal(native.originalFstatActualEBADF, true); assert.equal(native.tombstonedBeforeReuse, true);
  assert.equal(native.explicitCloseSkippedOriginal, true); assert.equal(native.foreignDescriptorStillOpenAfterCloseSession, true);
  assert.equal(native.abandonOriginalFstatActualEBADF, true); assert.equal(native.abandonTombstonedBeforeReuse, true);
  assert.equal(native.foreignDescriptorStillOpenAfterAbandon, true);
  evidence({ case: "real-read-fstat-EBADF-before-reuse", native });
});

test("readback: injected test-only short-I/O wrappers hit finite attempt/trace budgets", t => {
  const f = fixture(t, addon);
  const result = spawnSync(process.env.OFFICE_LOCAL_BUDGET_INJECTED_TEST, [f.stage, f.workspace], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.signal, null);
  const injected = JSON.parse(result.stdout.trim());
  assert.equal(injected.classification, "injected-test-only-libc-short-io-wrapper-not-actual-kernel-short-io");
  assert.equal(injected.readAttempts, injected.readAttemptLimit); assert.equal(injected.writeAttempts, injected.writeAttemptLimit);
  assert.equal(injected.readTraceCount, injected.readAttemptLimit + 2);
  assert.equal(injected.writeTraceCount, injected.writeAttemptLimit);
  assert.equal(injected.blocked, true); assert.equal(injected.originalFactsRetained, true);
  evidence({ case: "injected-short-io-budget-not-kernel-fault", injected });
});
