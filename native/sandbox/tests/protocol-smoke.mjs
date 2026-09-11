import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { test } from "node:test";

const executable = process.argv[2];
assert.ok(executable && isAbsolute(executable), "Pass the absolute trusted build output path.");
const base = () => ({
  protocolVersion: 1, operation: "handshake", requestId: "native-protocol-test",
  nonce: "a".repeat(64), expectedHelperVersion: "0.1.0-dev.0", parentPid: process.pid,
  identity: { workspaceId: "fixture", runId: "fixture-run", workUnitId: "fixture-unit",
    attemptId: "fixture-attempt", runtimeInstanceId: "fixture-runtime", fencingToken: "fixture-fence" },
});
function frame(body) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  return Buffer.concat([header, bytes]);
}
function invoke(input, args = ["--stdio-handshake"]) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], env: {} });
    const chunks = [];
    const errors = [];
    let size = 0;
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("protocol handshake exceeded deadline")); }, 3000);
    child.on("error", reject);
    child.stdin.on("error", error => { if (error.code !== "EPIPE") reject(error); });
    child.stdout.on("data", chunk => {
      size += chunk.length;
      if (size > 262148) { child.kill("SIGKILL"); reject(new Error("helper response exceeded bound")); }
      else chunks.push(chunk);
    });
    child.stderr.on("data", chunk => errors.push(chunk));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      try {
        assert.equal(signal, null);
        assert.equal(Buffer.concat(errors).length, 0, "no request or diagnostics on stderr");
        const output = Buffer.concat(chunks);
        assert.ok(output.length >= 4);
        assert.equal(output.readUInt32BE(0), output.length - 4, "exactly one framed response");
        resolve({ code, body: JSON.parse(output.subarray(4).toString("utf8")), raw: output.toString("utf8") });
      } catch (error) { reject(error); }
    });
    child.stdin.end(input);
  });
}

test("built native helper validates its real parent and reports no execution capability", async () => {
  const result = await invoke(frame(base()));
  assert.equal(result.code, 0);
  assert.equal(result.body.type, "hello");
  assert.equal(result.body.parentPid, process.pid);
  assert.equal(result.body.requestId, base().requestId);
  assert.equal(result.body.nonce, base().nonce);
  assert.deepEqual(result.body.identity, base().identity);
  assert.equal(result.body.enforcementReady, false);
  assert.equal(result.body.executionSupported, false);
  assert.deepEqual(result.body.capabilities, []);
});

for (const [name, mutate, expected] of [
  ["wrong parent", value => { value.parentPid = 1; }, "parent_mismatch"],
  ["wrong protocol", value => { value.protocolVersion = 99; }, "unsupported_protocol_version"],
  ["wrong helper", value => { value.expectedHelperVersion = "0.0.0"; }, "helper_version_mismatch"],
  ["execute operation", value => { value.operation = "execute"; }, "unsupported_operation"],
  ["invalid nonce", value => { value.nonce = "not-a-nonce"; }, "invalid_request"],
  ["missing fence", value => { delete value.identity.fencingToken; }, "invalid_request"],
  ["control character", value => { value.identity.runId = "bad\nrun"; }, "invalid_request"],
  ["unknown permission", value => { value.identity.approvalId = "cannot-grant"; }, "invalid_request"],
  ["oversized identifier", value => { value.requestId = "x".repeat(257); }, "invalid_request"],
  ["raw command ignored nowhere", value => { value.command = ["touch", "/must-not-run"]; }, "invalid_request"],
]) {
  test(name + " fails closed in the real helper process", async () => {
    const value = base();
    mutate(value);
    const result = await invoke(frame(value));
    assert.equal(result.code, 2);
    assert.equal(result.body.code, expected);
    assert.equal(result.body.enforcementReady, false);
  });
}
for (const [name, input, expected] of [
  ["empty input", Buffer.alloc(0), "missing_request"],
  ["partial header", Buffer.from([0]), "truncated_frame"],
  ["oversized length", Buffer.from([255, 255, 255, 255]), "invalid_frame_length"],
  ["truncated body", Buffer.from([0, 0, 0, 2, 123]), "truncated_frame"],
  ["invalid UTF-8", frame(Buffer.from([255])), "invalid_request"],
  ["duplicate field", frame(Buffer.from(JSON.stringify(base()).replace("{", '{"protocolVersion":1,'))), "invalid_request"],
  ["secret-like invalid body", frame({ fakeSecret: "NEVER_ECHO_THIS_FIXTURE_VALUE" }), "invalid_request"],
]) {
  test(name + " returns a bounded fixed diagnostic", async () => {
    const result = await invoke(input);
    assert.equal(result.code, 2);
    assert.equal(result.body.code, expected);
    assert.ok(!result.raw.includes("NEVER_ECHO_THIS_FIXTURE_VALUE"));
  });
}
test("unreviewed command line modes cannot start execution", async () => {
  const result = await invoke(Buffer.alloc(0), ["--execute", "/bin/echo", "must-not-run"]);
  assert.equal(result.code, 2);
  assert.equal(result.body.code, "unsupported_invocation");
  assert.ok(!result.raw.includes("must-not-run"));
});
