import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";
import { CuaDriverClientPool } from "../dist/features/plugins/cua-driver-client-pool.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";

// Regression: R03 — final pool disposal is conditional on successful Host drain.
// Found by /qa on 2026-10-26
// Report: output/r03-host-lease-drain-20261026/qa-report.md
for (const refuseStopProof of [false, true]) {
  test(`Daemon pool final cleanup requires successful original Host drain: refused=${refuseStopProof}`, {
    timeout: 10_000,
  }, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "ling-r03-pool-host-drain-"));
    const store = createSqliteRunStore(cwd);
    const failure = new Error("r03_original_source_stop_refused");
    let stops = 0;
    let finalCloses = 0;
    let storeClosed = false;
    const beginShutdown = CuaDriverClientPool.prototype.beginShutdown;
    const closeAll = CuaDriverClientPool.prototype.closeAll;
    const closeStore = store.close.bind(store);
    t.mock.method(CuaDriverClientPool.prototype, "beginShutdown", function () {
      stops += 1;
      return beginShutdown.call(this);
    });
    t.mock.method(CuaDriverClientPool.prototype, "closeAll", function (options) {
      if (options?.afterHostDrain) finalCloses += 1;
      return closeAll.call(this, options);
    });
    t.mock.method(store, "close", () => { storeClosed = true; closeStore(); });
    if (refuseStopProof) {
      // Inject at the existing original-source boundary, not the final close
      // result. The real lifecycle must decide whether disposal is authorized.
      t.mock.method(ActiveRunRegistry.prototype, "requestGracefulSuspension", () => { throw failure; });
    }
    const daemon = createDaemonServer({
      host: "127.0.0.1",
      port: 0,
      defaultWorkspaceCwd: cwd,
      channels: { autoRoute: false, intentSelector: false, terminalReports: false },
      harness: { continuations: { mode: "off" }, evaluations: { mode: "off" }, delegations: { mode: "off" } },
    }, {
      storeFactory: () => store,
      chromeBrowserNativeMessagingEnabled: false,
      remoteReplyDispatcher: null,
      runner: { async runTask() { assert.fail("Host drain regression must not invoke a model"); } },
      secretResolver: {
        status: (ref) => ({ ref, kind: "env", configured: false }),
        resolve: (ref) => ({ ref, configured: false }),
      },
    });
    t.after(async () => {
      daemon.server.closeAllConnections();
      await daemon.stop().catch(() => undefined);
      if (!storeClosed) store.close();
      await rm(cwd, { recursive: true, force: true });
    });
    await daemon.start();
    if (refuseStopProof) {
      await assert.rejects(daemon.stop(), /harness_shutdown_incomplete_stores_retained/);
      assert.equal(finalCloses, 0, "a refused stop proof cannot authorize physical pool disposal");
      assert.equal(storeClosed, false);
    } else {
      await daemon.stop();
      assert.ok(finalCloses > 0, "successful Host drain must still finish physical cleanup");
      assert.equal(storeClosed, true);
    }
    assert.ok(stops > 0, "admission must close regardless of the final stop-proof result");
  });
}
