import assert from "node:assert/strict";
import test from "node:test";
import { NativeInputCaptureDecoder } from "../dist/runtime/sandbox/native-input-capture-protocol.js";
import { captureNativeCommandInput } from "../dist/runtime/sandbox/native-input-capture.js";
const expected = { requestId: "request", nonce: "c".repeat(64), identity: { workspaceId: "w", runId: "r", workUnitId: "u", attemptId: "a", runtimeInstanceId: "i", fencingToken: "f" },
  rootDevice: "1", rootInode: "2", path: "src/file.js", maxBytes: 32768 };
const started = () => ({ type: "input_started", protocolVersion: 1, requestId: expected.requestId, nonce: expected.nonce, identity: { ...expected.identity } });
const ended = (sizeBytes = 3) => ({ type: "input_completed", rootDevice: "1", rootInode: "2", path: expected.path, sizeBytes,
  metadata: { device: "1", inode: "3", links: "1", sizeBytes, mode: 0o100600, modifiedSec: "1", modifiedNsec: "2", changedSec: "3", changedNsec: "4" } });
const chunk = (hex = "616263", index = 0) => ({ type: "input_chunk", index, hex });
const frame = value => { const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4); header.writeUInt32BE(body.length); return Buffer.concat([header, body]); };
const frames = values => Buffer.concat(values.map(frame));
function decode(values, changes = {}) { const decoder = new NativeInputCaptureDecoder({ ...expected, ...changes }); decoder.push(frames(values)); return decoder.finish(); }
test("native input decoder accepts fragmented frames only after a matching completion", () => {
  const decoder = new NativeInputCaptureDecoder(expected), wire = frames([started(), chunk(), ended()]);
  for (const byte of wire) decoder.push(Buffer.from([byte]));
  const result = decoder.finish(); assert.equal(result.bytes.toString(), "abc");
  assert.equal(result.sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.ok(Object.isFrozen(result.metadata));
});
test("empty capture and exactly bounded multi-frame data are supported", () => {
  assert.equal(decode([started(), ended(0)]).bytes.length, 0);
  assert.equal(decode([started(), chunk("ab".repeat(16384)), chunk("cd".repeat(16384), 1), ended(32768)]).bytes.length, 32768);
});
test("missing, duplicate, reordered and extra response frames fail closed", () => {
  for (const values of [[], [started()], [started(), chunk()], [chunk(), started(), ended()], [started(), started()],
    [started(), chunk("616263", 1), ended()], [started(), chunk(), ended(), ended()], [started(), chunk("61"), chunk("62", 1), ended(2)]]) {
    assert.throws(() => decode(values), /native_input_/);
  }
});
test("wrong source nonce, owner, path, root and file metadata cannot be accepted", () => {
  for (const start of [{ ...started(), nonce: "a".repeat(64) }, { ...started(), identity: { ...expected.identity, attemptId: "other" } }, { ...started(), verified: true }]) {
    assert.throws(() => decode([start, chunk(), ended()]), /native_input_/);
  }
  for (const end of [{ ...ended(), path: "other" }, { ...ended(), rootInode: "other" }, ended(4),
    { ...ended(), metadata: { ...ended().metadata, links: "2" } }, { ...ended(), metadata: { ...ended().metadata, mode: 0o040700 } },
    { ...ended(), metadata: { ...ended().metadata, changedNsec: "1000000000" } }, { ...ended(), granted: true }]) {
    assert.throws(() => decode([started(), chunk(), end]), /native_input_/);
  }
});
test("malformed payloads, invalid budgets and overflow never become partial success", () => {
  for (const hex of ["", "1", "GG", "aa".repeat(16385)]) assert.throws(() => decode([started(), chunk(hex), ended()]), /native_input_/);
  for (const maxBytes of [0, -1, Infinity, 67108865]) assert.throws(() => new NativeInputCaptureDecoder({ ...expected, maxBytes }), /native_input_/);
  assert.throws(() => decode([started(), chunk(), ended()], { maxBytes: 2 }), /native_input_/);
  for (const wire of [Buffer.from([255,255,255,255]), Buffer.from([0,0,0,0]), Buffer.from([0,0,0,1,255])]) {
    const decoder = new NativeInputCaptureDecoder(expected); assert.throws(() => { decoder.push(wire); decoder.finish(); }, /native_input_/);
  }
  const decoder = new NativeInputCaptureDecoder(expected); decoder.push(frame(started()).subarray(0, 10));
  assert.throws(() => decoder.finish(), /native_input_/);
});
test("native error codes are bounded diagnostics, never an input echo", () => {
  for (const code of ["input_hardlink_rejected", "PRIVATE_VALUE"]) {
    assert.throws(() => decode([{ type: "error", protocolVersion: 1, enforcementReady: false, code }]), error => {
      assert.ok(!error.message.includes("PRIVATE_VALUE")); return /native_input_/.test(error.message);
    });
  }
});
test("authority rejection or pre-cancellation prevents even a helper launch", async () => {
  const options = { helper: { path: "/missing/never-spawn", sha256: "a".repeat(64), version: "0.1.0-dev.0" },
    root: "/private/tmp", path: "input", maxBytes: 1, identity: expected.identity,
    assertCurrentAuthority() { throw new Error("source-owner-rejected"); } };
  await assert.rejects(captureNativeCommandInput(options), /source-owner-rejected/);
  await assert.rejects(captureNativeCommandInput({ ...options, signal: AbortSignal.abort(), assertCurrentAuthority() {} }), /native_input_cancelled/);
  await assert.rejects(captureNativeCommandInput({ ...options, assertCurrentAuthority: async () => {} }), /native_input_authority_must_be_synchronous/);
  await assert.rejects(captureNativeCommandInput({ ...options, assertCurrentAuthority: async () => { throw new Error("fixture-rejected-authority"); } }), /native_input_authority_must_be_synchronous/);
  const controller = new AbortController();
  await assert.rejects(captureNativeCommandInput({ ...options, signal: controller.signal, assertCurrentAuthority() { controller.abort(); } }), /native_input_cancelled/);
});
