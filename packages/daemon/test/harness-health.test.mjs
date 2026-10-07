import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { createDaemonServer } from "../dist/index.js";

for (const mode of ["off", "shadow", "enforce"]) {
  test(`HTTP health exposes only the effective Harness policy (${mode})`, async () => {
    const cwd = await mkdtemp(resolve(tmpdir(), "ling-harness-health-"));
    const daemon = createDaemonServer({
      host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
      harness: {
        continuations: { mode }, toolBroker: { mode: "off" },
        evaluations: { mode: "shadow", modelGate: "shadow" },
        delegations: { mode: "off", maxDepth: 3 },
        privateDiagnostic: "must-not-be-published",
      },
    });
    try {
      await daemon.start();
      const address = daemon.server.address();
      assert.ok(address && typeof address === "object");
      const response = await fetch(`http://127.0.0.1:${address.port}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200);
      const health = await response.json();
      assert.equal(health.ok, true);
      assert.deepEqual(health.features.harness, {
        schemaVersion: 1, continuations: mode, toolBroker: "off",
        evaluations: "shadow", evaluationModelGate: "shadow",
        delegations: "off", delegationMaxDepth: 3,
      });
      assert.equal(JSON.stringify(health).includes("must-not-be-published"), false);
      assert.equal(health.features.channels.autoRoute, daemon.config.channels.autoRoute);
      assert.equal(health.features.transports.localWebSocketRpc, daemon.config.transports.localWebSocketRpc);
    } finally {
      await daemon.stop();
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
