import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DesktopDaemonLifecycle } from "../dist/main/daemon-lifecycle.js";

// Regression: E6-R03 — default Desktop spawn must preserve FD3/FD4 holes and private FD5.
// Found by /qa on 2026-10-26
// Report: output/e6-20260928/r03-daemon-restart-packaged-20261026/repair-status.md
// Value: protects=production spawn FD5 wiring and real blocked child retention;
// fails_when=FD5 is absent/shifted or a failed stop kills/replaces its child;
// why_new=regression-1 controls child/health rather than testing default spawn;
// seam=none; no_claim=GUI/core effect proof (isolated worker with no Store/model).
for (const outcome of ["blocked", "closed"]) test(`default spawn observes a real ${outcome} Host`, { timeout: 8000 }, async t => {
  const parent = await mkdtemp(join(tmpdir(), "ling-r03-default-spawn-"));
  const workspace = join(parent, outcome);
  await mkdir(workspace);
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const diagnostics = [], unexpected = [];
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl: `http://127.0.0.1:${port}`,
    daemonEntryPath: fileURLToPath(new URL("./support/r03-owned-host-worker.mjs", import.meta.url)),
    defaultWorkspaceCwd: workspace, startupTimeoutMs: 2500, shutdownTimeoutMs: 1000,
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
    onUnexpectedExit: exit => unexpected.push(exit),
  });
  let child, rawKill;
  t.after(async () => {
    // Exact child handle from this fixture only; no user App/Store is touched.
    const owned = child ?? lifecycle.child;
    if (owned && owned.exitCode === null && owned.signalCode === null) {
      const exited = once(owned, "exit");
      (rawKill ?? owned.kill.bind(owned))("SIGKILL");
      await exited;
    }
    await rm(parent, { recursive: true });
  });
  assert.equal((await lifecycle.ensureStarted()).state, "connected");
  child = lifecycle.child;
  assert.ok(child?.pid);
  const signals = [];
  rawKill = child.kill.bind(child);
  child.kill = signal => { signals.push(signal); return rawKill(signal); };
  if (outcome === "blocked") {
    await assert.rejects(lifecycle.stopOwnedDaemon(), error => error?.code === "stop_blocked");
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    assert.equal(lifecycle.child, child);
    assert.equal(lifecycle.status.reason, "stop_blocked");
    await assert.rejects(lifecycle.restart(), error => error?.code === "stop_blocked");
    assert.equal(diagnostics.filter(x => x.event === "daemon.spawned").length, 1);
  } else {
    await lifecycle.stopOwnedDaemon();
    assert.equal(child.exitCode, 0);
    assert.equal(child.signalCode, null);
    assert.equal(lifecycle.status.state, "disconnected");
  }
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.deepEqual(unexpected, []);
});
