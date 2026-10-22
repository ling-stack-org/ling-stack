import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const workerPath = fileURLToPath(new URL("./support/delegation-process-restart-worker.mjs", import.meta.url));

function runPhase(phase, cwd, seed) {
  return new Promise((resolve, reject) => {
    const child = fork(workerPath, [phase, cwd, ...(seed ? [JSON.stringify(seed)] : [])], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      execArgv: [],
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

test("a fresh daemon process restores the exact parent before dispatching one queued child exactly once", { timeout: 30_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-delegation-process-restart-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const seeded = await runPhase("seed", cwd);
  assert.equal(seeded.type, "seeded");
  assert.notEqual(seeded.pid, process.pid);

  const recovered = await runPhase("recover", cwd, seeded);
  assert.equal(recovered.type, "recovered");
  assert.notEqual(recovered.pid, process.pid);
  assert.notEqual(recovered.pid, seeded.pid);
  assert.deepEqual({ dispatched: recovered.foreign.dispatched, retained: recovered.foreign.retained },
    { dispatched: 0, retained: 1 });
  assert.deepEqual({ dispatched: recovered.exact.dispatched, retained: recovered.exact.retained },
    { dispatched: 1, retained: 0 });
  assert.equal(recovered.immediate.dispatched, 0);
  assert.equal(recovered.dispatches.length, 1);
  assert.equal(recovered.dispatches[0].parentRunId, seeded.parentRunId);
  assert.equal(recovered.dispatches[0].prompt, "Read the isolated child objective.");
  assert.equal(recovered.childKind, "dispatch_outcome_unknown");
  assert.equal(recovered.childAttemptCount, 1);
});
