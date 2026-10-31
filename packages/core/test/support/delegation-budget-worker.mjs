import { workerData, parentPort } from "node:worker_threads";
import { createBudgetHarness } from "./delegation-budget-fixture.mjs";

const f = createBudgetHarness(workerData.cwd);
const gate = new Int32Array(workerData.gate);
try {
  Atomics.add(gate, 0, 1);
  if (Atomics.wait(gate, 1, 0, 20_000) === "timed-out") throw new Error("bounded concurrency barrier expired");
  const child = f.spawn({ spawnCallId: workerData.id, requestedBudget: { tokenBudget: 70 } });
  parentPort.postMessage({ ok: true, childRunId: child.childRun.id });
} catch (error) { parentPort.postMessage({ ok: false, code: error?.code, message: error?.message }); }
finally { f.store.close(); }
