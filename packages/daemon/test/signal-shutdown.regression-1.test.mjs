import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

async function within(promise, message, ms = 3_000) {
  const controller = new AbortController();
  try {
    return await Promise.race([promise, delay(ms, undefined, { signal: controller.signal }).then(() => {
      throw new Error(message);
    })]);
  } finally { controller.abort(); }
}

// Regression: E6-R03 — a refused stop must not become an unhandled CLI crash.
// Found by /qa on 2026-10-26
// Report: output/e6-20260928/r03-daemon-restart-packaged-20261026/repair-status.md
// Value: protects=actual CLI handles stop rejection without exit/restart or repeat stop;
// fails_when=signal handler leaves stop rejection unhandled;
// why_new=existing lifecycle tests call daemon.stop directly, not real process signals;
// seam=none; no_claim=real Daemon effect proof (only server startup is stubbed).
for (const outcome of ["blocked", "closed", "late-drain"]) test(`actual CLI signal shutdown: ${outcome}`, { timeout: 10_000 }, async t => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./support/signal-shutdown-worker.mjs", import.meta.url)), outcome], {
    env: { PATH: process.env.PATH, LING_STACK_HOST: "127.0.0.1", LING_STACK_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "", exited;
  const closed = new Promise(resolve => child.once("close", (code, signal) => { exited = { code, signal }; resolve(exited); }));
  const failure = new Promise((_, reject) => child.once("error", reject));
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  const until = async (check, description) => within(Promise.race([failure, (async () => {
    while (!check()) {
      if (exited) throw new Error(`${description}: child exited ${JSON.stringify(exited)}; stderr=${stderr}`);
      await delay(5);
    }
  })()]), description);
  t.after(async () => {
    if (!exited) child.kill("SIGKILL");
    await closed;
  });
  await until(() => stdout.includes("Ling Stack daemon listening"), "actual CLI ready");
  child.kill("SIGTERM");
  if (outcome !== "blocked") {
    assert.deepEqual(await within(closed, "successful CLI close"), { code: 0, signal: null });
    assert.doesNotMatch(stderr, /daemon_shutdown_blocked/);
    if (outcome === "late-drain") assert.match(stdout, /owned-actual-drain-completed/);
  } else {
    await until(() => stderr.includes("daemon_shutdown_blocked"), "explicit blocked lifecycle rather than unhandled crash");
    child.kill("SIGTERM"); child.kill("SIGINT");
    await delay(100);
    assert.equal(exited, undefined, "blocked stop is not an unexpected exit authorizing automatic recovery");
    assert.equal(stderr.split("daemon_shutdown_blocked").length - 1, 1);
    assert.doesNotMatch(stderr, /UnhandledPromiseRejection|owned-stop-proof-unverified/);
  }
  assert.equal(stdout.split("owned-stop-called").length - 1, 1);
  t.diagnostic(JSON.stringify({ outcome, exit: exited ?? "Host retained", stopCalls: 1 }));
});
