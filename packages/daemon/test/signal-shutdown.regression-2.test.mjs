import assert from "node:assert/strict";
import test from "node:test";
import { createDaemonSignalShutdown } from "../dist/runtime/signal-shutdown.js";

// Regression: E6-R03 — the private observer must hear draining before stop closes HTTP.
// Found by /qa on 2026-10-26
// Report: output/e6-20260928/r03-daemon-restart-packaged-20261026/repair-status.md
// Value: protects=single-flight Host drain notification before HTTP shutdown;
// fails_when=stop begins without notifying its private lifecycle observer;
// why_new=signal regression-1 checks process retention, not observer event ordering;
// seam=none; no_claim=Desktop or real effect-proof acceptance (stop is controlled).
test("signal publishes draining once before owned stop and blocked after its rejection", async () => {
  const events = [];
  let reject;
  const pending = new Promise((_, fail) => { reject = fail; });
  const stop = createDaemonSignalShutdown({
    onDraining: () => events.push("draining"),
    stop: () => { events.push("stop"); return pending; },
    exit: () => events.push("exit"),
    onBlocked: () => events.push("blocked"),
  });
  const first = stop();
  assert.equal(stop(), first);
  assert.deepEqual(events, ["draining", "stop"]);
  reject(new Error("unverified"));
  await first;
  assert.deepEqual(events, ["draining", "stop", "blocked"]);
});

test("observer failure cannot skip the original stop, manufacture blocked or prevent exit", async () => {
  const events = [];
  const stop = createDaemonSignalShutdown({
    onDraining: () => { events.push("observer"); throw new Error("pipe unavailable"); },
    stop: async () => { events.push("stop"); },
    exit: code => events.push(code),
    onBlocked: () => events.push("blocked"),
  });
  await stop();
  await stop();
  assert.deepEqual(events, ["observer", "stop", 0]);
});
