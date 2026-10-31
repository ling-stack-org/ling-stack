import assert from "node:assert/strict";
import test from "node:test";

import { runBoundedCommand } from "../scripts/cua-driver-signing/final-artifact-extractor.mjs";

// Genuine child-process transport only; no image, mount, signer or App is used.
test("final artifact command retains stdout/stderr and sends bounded stdin", async () => {
  const result = await runBoundedCommand(process.execPath, ["-e", `
    let value = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => value += chunk);
    process.stdin.on('end', () => {
      process.stdout.write(value);
      process.stderr.write('diagnostic');
    });
  `], { stdin: "原始 plist input" });
  assert.deepEqual(result, { stdout: "原始 plist input", stderr: "diagnostic" });
  assert.equal(Object.isFrozen(result), true);
});

test("completed nonzero exit retains complete bounded output without turning failure green", async () => {
  await assert.rejects(runBoundedCommand(process.execPath, ["-e", `
    process.stdout.write('<plist>partial receipt</plist>');
    process.stderr.write('nonzero diagnostic');
    process.exitCode = 7;
  `]), error => {
    assert.equal(error.code, "final_artifact_command_failed");
    assert.equal(error.cause.code, 7);
    assert.deepEqual(error.commandReceipt, {
      stdout: "<plist>partial receipt</plist>", stderr: "nonzero diagnostic", outputComplete: true,
    });
    assert.equal(Object.isFrozen(error.commandReceipt), true);
    assert.equal(error.commandDiagnostic.command, process.execPath.split("/").at(-1));
    assert.equal(error.commandDiagnostic.exitCode, 7);
    assert.equal(error.commandDiagnostic.signal, null);
    assert.equal(error.commandDiagnostic.killed, false);
    assert.equal(error.commandDiagnostic.outputComplete, true);
    assert.equal(error.commandDiagnostic.timeoutMs, 120_000);
    assert.equal(error.commandDiagnostic.stdoutBytes, Buffer.byteLength(error.commandReceipt.stdout));
    assert.equal(error.commandDiagnostic.stderrBytes, Buffer.byteLength(error.commandReceipt.stderr));
    assert.ok(Number.isInteger(error.commandDiagnostic.pid) && error.commandDiagnostic.pid > 0);
    assert.ok(Number.isFinite(error.commandDiagnostic.elapsedMs) && error.commandDiagnostic.elapsedMs >= 0);
    assert.ok(Number.isFinite(Date.parse(error.commandDiagnostic.startedAt)));
    assert.equal(Object.isFrozen(error.commandDiagnostic), true);
    assert.ok(error.message.includes(JSON.stringify(error.commandDiagnostic)));
    assert.equal(error.message.includes("partial receipt"), false);
    assert.equal(error.message.includes("nonzero diagnostic"), false);
    return true;
  });
});

for (const [label, script, options] of [
  ["timeout", "process.stdout.write('<plist>'); setInterval(() => {}, 1000)", { timeoutMs: 100 }],
  ["stdout overflow", "process.stdout.write('x'.repeat(1024 * 1024 + 1))", {}],
  ["stderr overflow", "process.stderr.write('x'.repeat(1024 * 1024 + 1))", {}],
  ["signal", "process.stdout.write('<plist>'); process.kill(process.pid, 'SIGTERM')", {}],
]) {
  test(`${label} cannot mint a complete command receipt`, async () => {
    await assert.rejects(runBoundedCommand(process.execPath, ["-e", script], options), error => {
      assert.equal(error.code, "final_artifact_command_failed");
      assert.equal(error.commandReceipt.outputComplete, false);
      assert.equal(error.commandDiagnostic.outputComplete, false);
      if (label === "timeout" || label === "signal") {
        assert.equal(error.commandDiagnostic.signal, "SIGTERM");
        assert.equal(error.commandDiagnostic.killed, label === "timeout");
        assert.equal(error.commandDiagnostic.timeoutMs, options.timeoutMs ?? 120_000);
      }
      return true;
    });
  });
}

test("spawn failure is unknown, not a complete output receipt", async () => {
  await assert.rejects(runBoundedCommand("/explicit-test-only/missing-command", []), error => {
    assert.equal(error.cause.code, "ENOENT");
    assert.equal(error.commandReceipt.outputComplete, false);
    assert.equal(error.commandDiagnostic.pid, null);
    assert.equal(error.commandDiagnostic.exitCode, null);
    assert.equal(error.commandDiagnostic.errorCode, "ENOENT");
    return true;
  });
});

test("command input type and byte budget reject before spawn", async () => {
  await assert.rejects(runBoundedCommand("/explicit-test-only/missing-command", [], { stdin: null }),
    { code: "final_artifact_command_input_invalid" });
  await assert.rejects(runBoundedCommand("/explicit-test-only/missing-command", [], { stdin: "界".repeat(400_000) }),
    { code: "final_artifact_command_input_oversized" });
});
