import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { test } from "node:test";

// Parser/framing refusal only. This suite does not run codesign or claim OS
// capability closure; the source-bound actual probe remains a separate gate.
const executable = process.argv[2];
assert.ok(executable && isAbsolute(executable));
assert.equal(process.platform, "darwin");
const base = () => ({ protocolVersion: 1, operation: "packaged_codesign_v1",
  requestId: "fixed-codesign-protocol-test", nonce: "a".repeat(64),
  expectedHelperVersion: "0.1.0-dev.0", parentPid: process.pid,
  hostProcessEpoch: "protocol-fixture-not-authority",
  appBundlePath: "/private/tmp/LingNonexistentProtocolFixture.app", appDevice: "0", appInode: "0" });
function frame(value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
function invoke(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["--verify-packaged-codesign"], {
      stdio: ["pipe", "pipe", "pipe"], cwd: "/", env: {},
    });
    const chunks = [], diagnostics = [];
    let size = 0, failed = false;
    const refuse = error => { if (!failed) { failed = true; child.kill("SIGKILL"); reject(error); } };
    const timer = setTimeout(() => refuse(new Error("codesign parser exceeded deadline")), 3000);
    child.on("error", refuse);
    child.stdin.on("error", error => { if (error.code !== "EPIPE") refuse(error); });
    child.stdout.on("data", chunk => {
      size += chunk.length;
      if (size > 262148) refuse(new Error("codesign parser response exceeded bound"));
      else chunks.push(chunk);
    });
    child.stderr.on("data", chunk => diagnostics.push(chunk));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (failed) return;
      try {
        assert.equal(signal, null);
        assert.equal(Buffer.concat(diagnostics).length, 0);
        const output = Buffer.concat(chunks);
        assert.ok(output.length >= 4);
        assert.equal(output.readUInt32BE(0), output.length - 4);
        resolve({ code, body: JSON.parse(output.subarray(4).toString("utf8")), raw: output.toString("utf8") });
      } catch (error) { reject(error); }
    });
    child.stdin.end(input);
  });
}

for (const [name, mutate, expected] of [
  ["wrong parent", value => { value.parentPid = 1; }, "parent_mismatch"],
  ["wrong protocol", value => { value.protocolVersion = 2; }, "unsupported_protocol_version"],
  ["wrong role", value => { value.operation = "execute"; }, "unsupported_operation"],
  ["wrong helper", value => { value.expectedHelperVersion = "0.0.0"; }, "helper_version_mismatch"],
  ["bad nonce", value => { value.nonce = "incorrect"; }, "invalid_codesign_request"],
  ["bad path", value => { value.appBundlePath = "/a/../Ling.app"; }, "invalid_codesign_request"],
  ["noncanonical identity", value => { value.appInode = "01"; }, "invalid_codesign_request"],
  ["caller certificate", value => { value.certified = true; }, "invalid_codesign_request"],
  ["Run identity", value => { value.identity = { runId: "never-authority" }; }, "invalid_codesign_request"],
  ["caller command", value => { value.argv = ["/bin/echo", "MUST_NOT_EXECUTE"]; }, "invalid_codesign_request"],
  ["caller profile", value => { value.profile = "(allow default)"; }, "invalid_codesign_request"],
  ["caller env", value => { value.env = { DYLD_INSERT_LIBRARIES: "MUST_NOT_LOAD" }; }, "invalid_codesign_request"],
]) test(name + " is refused before native preparation", async () => {
  const value = base(); mutate(value);
  const result = await invoke(frame(value));
  assert.equal(result.code, 2);
  assert.deepEqual(result.body, { type: "error", protocolVersion: 1, code: expected, enforcementReady: false });
  assert.ok(!result.raw.includes("MUST_NOT_EXECUTE") && !result.raw.includes("MUST_NOT_LOAD"));
});
for (const [name, bytes, expected] of [
  ["trailing second request", Buffer.concat([frame(base()), frame(base())]), "invalid_codesign_request"],
  ["trailing garbage", Buffer.concat([frame(base()), Buffer.from([1])]), "invalid_codesign_request"],
  ["duplicate parent", frame(Buffer.from(JSON.stringify(base()).replace("{", '{"parentPid":1,'))), "invalid_codesign_request"],
  ["invalid UTF-8", frame(Buffer.from([255])), "invalid_codesign_request"],
  ["empty request", Buffer.alloc(0), "missing_request"],
  ["unchecked allocation", Buffer.from([255, 255, 255, 255]), "invalid_frame_length"],
]) test(name + " returns one bounded typed refusal", async () => {
  const result = await invoke(bytes);
  assert.equal(result.code, 2);
  assert.deepEqual(result.body, { type: "error", protocolVersion: 1, code: expected, enforcementReady: false });
});
