import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const workerPath = fileURLToPath(new URL("./support/node-rerun-process-restart-worker.mjs", import.meta.url));

function runPhase(phase, home, cwd, recordId) {
  return new Promise((resolve, reject) => {
    const child = fork(workerPath, [phase, home, ...(cwd ? [cwd] : []), ...(recordId ? [recordId] : [])], {
      env: { ...process.env, LING_STACK_HOME: home },
      execArgv: ["--experimental-strip-types"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const stderr = [];
    let receipt;
    child.stderr.on("data", chunk => {
      if (stderr.length < 20) stderr.push(String(chunk).slice(0, 2_000));
    });
    child.on("message", message => { receipt = message; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && receipt?.type !== "error") resolve(receipt);
      else reject(new Error(JSON.stringify({ phase, code, signal, receipt, stderr })));
    });
  });
}

test("fresh daemon processes retain an unknown dispatched rerun and never replay it", { timeout: 60_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), "ling-node-rerun-process-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const seeded = await runPhase("seed", home);
  assert.equal(seeded.type, "seeded");
  assert.ok(seeded.cwd);
  t.after(() => rm(seeded.cwd, { recursive: true, force: true }));
  assert.notEqual(seeded.pid, process.pid);

  const first = await runPhase("recover", home, seeded.cwd, seeded.recordId);
  assert.equal(first.type, "recovered");
  assert.notEqual(first.pid, process.pid);
  assert.notEqual(first.pid, seeded.pid);
  assert.deepEqual(first.recovery, { observed: 1, released: 0, unknown: 1 });
  assert.deepEqual(first.capacity, { held: 1, released: 0, total: 1 });
  assert.deepEqual(first.target, { runStatus: "queued", workUnitStatus: "claimed", attemptStatus: "created" });
  assert.equal(first.unknownDiagnostics, 1);

  const second = await runPhase("recover", home, seeded.cwd, seeded.recordId);
  assert.equal(second.type, "recovered");
  assert.notEqual(second.pid, first.pid);
  assert.deepEqual(second.recovery, { observed: 1, released: 0, unknown: 1 });
  assert.deepEqual(second.capacity, { held: 1, released: 0, total: 1 });
  assert.deepEqual(second.target, first.target);
  assert.equal(second.unknownDiagnostics, 1, "restart recovery must be reentrant");
});
