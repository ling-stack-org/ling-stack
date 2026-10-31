import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { observeDaemonShutdown } from "@ling-stack/core/daemon-shutdown-observer";

// Regression: E6-R03 — stderr is discarded by Desktop and cannot carry lifecycle facts.
// Found by /qa on 2026-10-26
// Report: output/e6-20260928/r03-daemon-restart-packaged-20261026/repair-status.md
// Value: protects=actual CLI signal reports private draining/blocked with one stop;
// fails_when=CLI does not wire FD5 or treats closed observer as a crash;
// why_new=regression-1 sees only stderr and regression-2 only callback order;
// seam=none; no_claim=packaged Desktop/UI acceptance (server startup is stubbed).
for (const outcome of ["blocked", "closed", "late-drain", "lost-observer"]) {
  test(`actual CLI private shutdown observation: ${outcome}`, { timeout: 8000 }, async t => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./support/signal-shutdown-worker.mjs", import.meta.url)),
      outcome === "lost-observer" ? "blocked" : outcome], {
      env: { PATH: process.env.PATH, LING_STACK_HOST: "127.0.0.1", LING_STACK_PORT: "0", LING_STACK_SHUTDOWN_OBSERVER_FD: "5" },
      stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "pipe"],
    });
    let stdout = "", stderr = "", exit;
    const phases = [], failures = [];
    const exited = new Promise(resolve => child.once("exit", (code, signal) => { exit = { code, signal }; resolve(exit); }));
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const dispose = observeDaemonShutdown({ channel: child.stdio[5], pid: child.pid,
      onPhase: phase => phases.push(phase), onUnavailable: code => failures.push(code) });
    t.after(async () => { dispose(); if (!exit) child.kill("SIGKILL"); await exited; });
    async function until(check) {
      const deadline = Date.now() + 3000;
      while (!check()) {
        if (exit) throw new Error(`CLI exited before observation: ${JSON.stringify(exit)}; ${stderr}`);
        if (Date.now() >= deadline) throw new Error(`CLI observation timeout; phases=${JSON.stringify(phases)}; ${stderr}`);
        await delay(5);
      }
    }
    await until(() => stdout.includes("Ling Stack daemon listening"));
    if (outcome === "lost-observer") dispose();
    child.kill("SIGTERM");
    if (outcome === "closed" || outcome === "late-drain") {
      await exited;
      assert.deepEqual(exit, { code: 0, signal: null });
      assert.deepEqual(phases, ["draining"]);
      assert.doesNotMatch(stderr, /daemon_shutdown_blocked/);
    } else {
      await until(() => stderr.includes("daemon_shutdown_blocked"));
      child.kill("SIGTERM"); child.kill("SIGINT");
      await delay(50);
      assert.equal(exit, undefined);
      assert.deepEqual(phases, outcome === "lost-observer" ? [] : ["draining", "blocked"]);
      assert.deepEqual(failures, []);
      assert.equal(stderr.split("daemon_shutdown_blocked").length - 1, 1);
    }
    assert.equal(stdout.split("owned-stop-called").length - 1, 1);
  });
}
