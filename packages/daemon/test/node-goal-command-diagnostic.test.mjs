import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { channel, hasSubscribers } from "node:diagnostics_channel";
import { EventEmitter } from "node:events";
import test from "node:test";
import { captureNodeGoalCommandDiagnostic } from "./support/node-goal-command-diagnostic.mjs";

test("command diagnostics retain failure evidence but exclude command, environment and output payloads", async () => {
  const secret = "private-diagnostic-sentinel";
  const result = { status: "timed_out", startedAt: "2026-11-02T00:00:00Z", endedAt: "2026-11-02T00:00:04Z",
    durationMs: 4001, signal: "SIGTERM", timedOut: true, cancelled: false,
    command: { command: secret }, cwd: secret, environmentSummary: { keys: [secret], extraEnv: { TOKEN: secret } },
    processObservation: { scope: "process_group", leaderExited: true, stdioClosed: true,
      descendants: "unverified", stopReason: "timeout", settledBy: "close", signalFailures: ["SIGTERM:group:EPERM"], private: secret },
    stdout: { byteCount: 0, truncated: false, preview: secret, artifactId: secret },
    stderr: { byteCount: 12, truncated: true, preview: secret }, artifacts: [{ path: secret }], reason: secret };
  const handled = { details: { unifiedExec: result, private: secret }, content: [{ text: secret }] };
  const records = [];
  assert.equal(await captureNodeGoalCommandDiagnostic({ sequence: 1, timeoutMs: 4000,
    execute: async () => handled, record: value => records.push(value) }), handled);
  assert.equal(records.length, 1);
  const diagnostic = records[0];
  assert.equal(diagnostic.kind, "node_goal_command_diagnostic_v1");
  assert.equal(diagnostic.timeoutMs, 4000);
  assert.equal(diagnostic.result.status, "timed_out");
  assert.equal(diagnostic.result.durationMs, 4001);
  assert.equal(diagnostic.result.exitCode, null);
  assert.equal(diagnostic.result.signal, "SIGTERM");
  assert.deepEqual(diagnostic.result.processObservation, { scope: "process_group", leaderExited: true,
    stdioClosed: true, descendants: "unverified", stopReason: "timeout", settledBy: "close", signalFailures: ["SIGTERM:group:EPERM"] });
  assert.deepEqual(diagnostic.result.stdout, { byteCount: 0, truncated: false });
  assert.deepEqual(diagnostic.result.stderr, { byteCount: 12, truncated: true });
  assert.equal(JSON.stringify(diagnostic).includes(secret), false);
});

test("diagnostics distinguish no-start denial from a returned process result", async () => {
  let diagnostic;
  await captureNodeGoalCommandDiagnostic({ sequence: 2, timeoutMs: 4000,
    execute: async () => ({ details: { unifiedExec: { status: "failed", denied: true, reason: "private denial" } } }),
    record: value => { diagnostic = value; } });
  assert.equal(diagnostic.returned, true);
  assert.equal(diagnostic.result.denied, true);
  assert.equal(diagnostic.result.processObservation, null);
  assert.equal(diagnostic.result.durationMs, null);
  assert.deepEqual(diagnostic.processes, []);
  assert.equal(JSON.stringify(diagnostic).includes("private denial"), false);
});

test("real process lifecycle timings do not consume or alter output", async () => {
  const subscribed = hasSubscribers("child_process");
  let diagnostic;
  let stdout = "", stderr = "";
  await captureNodeGoalCommandDiagnostic({ sequence: 3, timeoutMs: 4000,
    execute: () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", 'process.stdout.write("fixture-out");process.stderr.write("fixture-err");']);
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", code => {
        if (code === 0) resolve({});
        else reject(new Error(`fixture exited with code ${code}`));
      });
    }), record: value => { diagnostic = value; } });
  assert.equal(hasSubscribers("child_process"), subscribed);
  assert.equal(stdout, "fixture-out");
  assert.equal(stderr, "fixture-err");
  assert.equal(diagnostic.processes.length, 1);
  const timing = diagnostic.processes[0];
  for (const key of ["createdMs", "spawnedMs", "firstStdoutMs", "firstStderrMs", "exitMs", "closeMs"]) {
    assert.equal(typeof timing[key], "number", key);
    assert.ok(timing[key] >= 0, key);
  }
  assert.ok(timing.createdMs <= timing.spawnedMs);
  assert.ok(timing.spawnedMs <= timing.firstStdoutMs);
  assert.ok(timing.spawnedMs <= timing.firstStderrMs);
  assert.ok(timing.exitMs <= timing.closeMs);
  assert.ok(timing.closeMs <= diagnostic.elapsedMs);
  assert.equal(timing.exitCode, 0);
  assert.equal(timing.signal, null);
  assert.equal(JSON.stringify(diagnostic).includes("fixture-out"), false);
  assert.equal(JSON.stringify(diagnostic).includes("fixture-err"), false);
});

test("thrown execution keeps its original error and detaches every diagnostic listener", async () => {
  const subscribed = hasSubscribers("child_process");
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
  const error = new Error("original private error");
  let diagnostic;
  await assert.rejects(captureNodeGoalCommandDiagnostic({ sequence: 4, timeoutMs: 4000,
    execute: async () => {
      channel("child_process").publish({ process: child });
      child.emit("spawn");
      child.emit("error", { code: "ENOENT", message: "private spawn error" });
      throw error;
    }, record: value => { diagnostic = value; } }), cause => cause === error);
  assert.equal(hasSubscribers("child_process"), subscribed);
  for (const emitter of [child, child.stdout, child.stderr]) assert.deepEqual(emitter.eventNames(), []);
  assert.equal(diagnostic.returned, false);
  assert.equal(diagnostic.result.status, null);
  assert.equal(diagnostic.processes[0].errorCode, "ENOENT");
  assert.equal(diagnostic.processes[0].firstStdoutMs, null);
  assert.equal(diagnostic.processes[0].exitMs, null);
  assert.equal(diagnostic.processes[0].closeMs, null);
  assert.equal(JSON.stringify(diagnostic).includes("private"), false);
});
