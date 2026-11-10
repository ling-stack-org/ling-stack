import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, symlinkSync, linkSync, renameSync, realpathSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { test } from "node:test";
const executable = process.argv[2];
assert.ok(executable && isAbsolute(executable), "Pass the absolute trusted build output path.");
assert.equal(process.platform, "darwin", "Explicit real-macOS input boundary suite.");
const root = realpathSync(mkdtempSync("/private/tmp/ling-native-input-read-"));
const workspace = join(root, "workspace"), outside = join(root, "outside");
mkdirSync(workspace); mkdirSync(outside); mkdirSync(join(workspace, "src"));
writeFileSync(join(workspace, "src", "proof.js"), "export const formatProof = value => 'proof:' + value;\n");
const sentinel = join(outside, "sentinel.txt");
writeFileSync(sentinel, "PRIVATE_FIXTURE_MUST_NOT_LEAK");
const request = (path = "src/proof.js") => {
  const stat = statSync(workspace, { bigint: true });
  return { handshake: { protocolVersion: 1, operation: "handshake", requestId: "input-read-test",
    nonce: "b".repeat(64), expectedHelperVersion: "0.1.0-dev.0", parentPid: process.pid,
    identity: { workspaceId: "fixture", runId: "run", workUnitId: "unit", attemptId: "attempt",
      runtimeInstanceId: "runtime", fencingToken: "fence" } },
    root: workspace, rootDevice: String(stat.dev), rootInode: String(stat.ino), path, maxBytes: 2 * 1024 * 1024 };
};
function invoke(value) {
  const body = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
  const result = spawnSync(executable, ["--read-input"], { env: {}, input: Buffer.concat([header, body]),
    timeout: 5000, maxBuffer: 5 * 1024 * 1024 });
  assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.stderr.length, 0);
  const bytes = result.stdout, frames = [];
  for (let offset = 0; offset < bytes.length;) {
    assert.ok(offset + 4 <= bytes.length);
    const length = bytes.readUInt32BE(offset); offset += 4;
    assert.ok(length > 0 && length <= 262144 && offset + length <= bytes.length);
    frames.push(JSON.parse(bytes.subarray(offset, offset + length).toString("utf8"))); offset += length;
  }
  return { code: result.status, frames, raw: bytes.toString("utf8") };
}
function content(result, expectedRequest) {
  assert.equal(result.code, 0, JSON.stringify(result.frames));
  const [started, ...rest] = result.frames, ended = rest.pop();
  assert.equal(started.type, "input_started");
  assert.equal(started.requestId, expectedRequest.handshake.requestId);
  assert.equal(started.nonce, expectedRequest.handshake.nonce);
  assert.deepEqual(started.identity, expectedRequest.handshake.identity);
  assert.equal(ended.type, "input_completed"); assert.equal(ended.path, expectedRequest.path);
  assert.equal(ended.rootDevice, expectedRequest.rootDevice); assert.equal(ended.rootInode, expectedRequest.rootInode);
  assert.equal(ended.metadata.links, "1");
  const bytes = Buffer.concat(rest.map((chunk, index) => {
    assert.equal(chunk.type, "input_chunk"); assert.equal(chunk.index, index);
    assert.match(chunk.hex, /^(?:[0-9a-f]{2})+$/u); return Buffer.from(chunk.hex, "hex");
  }));
  assert.equal(ended.sizeBytes, bytes.length); return bytes;
}
function denied(value, code) {
  const result = invoke(value); assert.equal(result.code, 2);
  assert.deepEqual(result.frames, [{ type: "error", protocolVersion: 1, code, enforcementReady: false }]);
  assert.ok(!result.raw.includes("PRIVATE_FIXTURE_MUST_NOT_LEAK"));
}
test("native reader returns a complete anchored file without changing the workspace", () => {
  const value = request(), expected = readFileSync(join(workspace, value.path));
  assert.deepEqual(content(invoke(value), value), expected); assert.deepEqual(readFileSync(join(workspace, value.path)), expected);
});
test("empty and multi-frame binary inputs preserve every byte", () => {
  for (const [path, bytes] of [["empty", Buffer.alloc(0)], ["binary", Buffer.alloc(1024 * 1024, 0xad)]]) {
    writeFileSync(join(workspace, path), bytes); const value = request(path);
    assert.deepEqual(content(invoke(value), value), bytes);
  }
});
test("an existing cross-root hardlink is rejected before any content frame", () => {
  linkSync(sentinel, join(workspace, "alias")); denied(request("alias"), "input_hardlink_rejected");
  assert.equal(readFileSync(sentinel, "utf8"), "PRIVATE_FIXTURE_MUST_NOT_LEAK");
});
test("final and intermediate symbolic links are not followed", () => {
  symlinkSync(sentinel, join(workspace, "file-link")); symlinkSync(outside, join(workspace, "dir-link"));
  for (const path of ["file-link", "dir-link/sentinel.txt"]) denied(request(path), "input_path_unavailable");
});
test("absolute paths, traversal, empty components and control characters are rejected", () => {
  for (const path of [sentinel, "../outside/sentinel.txt", "src/../src/proof.js", "src//proof.js", "src/./proof.js", "", "src/proof.js\u0000", "src\\proof.js"]) denied(request(path), "invalid_input_request");
});
test("root identity mismatch and a symbolic root cannot borrow the requested scope", () => {
  denied({ ...request(), rootInode: "1" }, "input_root_identity_changed");
  const alias = join(root, "root-alias"); symlinkSync(workspace, alias);
  denied({ ...request(), root: alias }, "input_path_unavailable");
});
test("replacement of the authorized root is rejected using its original inode", () => {
  const replaceable = join(root, "replaceable"); mkdirSync(replaceable);
  const stat = statSync(replaceable, { bigint: true });
  const value = { ...request("sentinel.txt"), root: replaceable, rootDevice: String(stat.dev), rootInode: String(stat.ino) };
  renameSync(replaceable, replaceable + "-original"); mkdirSync(replaceable);
  writeFileSync(join(replaceable, "sentinel.txt"), "PRIVATE_FIXTURE_MUST_NOT_LEAK"); denied(value, "input_root_identity_changed");
});
test("directories, missing paths and files exceeding the declared budget fail explicitly", () => {
  denied(request("src"), "input_not_regular"); denied(request("missing"), "input_path_unavailable");
  denied({ ...request(), maxBytes: 1 }, "input_budget_exceeded");
  for (const maxBytes of [0, -1, 64 * 1024 * 1024 + 1]) denied({ ...request(), maxBytes }, "invalid_input_request");
});
test("a FIFO input is rejected without waiting for a writer", () => {
  const fifo = join(workspace, "pipe");
  const made = spawnSync("/usr/bin/mkfifo", [fifo], { timeout: 1000 });
  assert.ifError(made.error); assert.equal(made.status, 0);
  denied(request("pipe"), "input_not_regular");
});
test("source identity cannot come from another parent or an unchecked wire field", () => {
  const value = request(); value.handshake.parentPid = 1; denied(value, "parent_mismatch");
  denied({ ...request(), verified: true }, "invalid_input_request");
  denied(JSON.stringify(request()).replace("{", '{"path":"private",'), "invalid_input_request");
});
test.after(() => process.stdout.write(`NATIVE_INPUT_FIXTURE=${root}\n`));
