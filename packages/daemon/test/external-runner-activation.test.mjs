import assert from "node:assert/strict";
import test from "node:test";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { listExternalRunnerRegistrations } from "../dist/runtime/external-runners.js";
import { buildRunnerReadinessReport } from "../dist/runtime/runner-readiness.js";

const legacyConfig = {
  runners: {
    codexAppServer: {
      enabled: true,
      baseUrl: "http://127.0.0.1:12345",
      readinessPassed: true,
      conformancePassed: true,
    },
    openclawAcp: {
      enabled: true,
      endpoint: "http://127.0.0.1:23456",
      readinessPassed: true,
      conformancePassed: true,
    },
  },
};

for (const runnerId of ["codex-app-server", "openclaw-acp"]) {
  test(`${runnerId}: legacy booleans cannot activate a private-protocol adapter`, async () => {
    const registry = createLegacyRegistry();
    const runner = registry.get(runnerId);
    assert.equal(runner.status, "disabled");
    assert.match(runner.disabledReason, /legacy_runner_migration_required/);
    assert.throws(
      () => registry.resolve({ requestedRunnerId: runnerId, explicitFallbackPolicy: "disabled" }),
      (error) => error.fallbackReason?.code === "disabled_requested_runner",
    );
    await assert.rejects(() => runner.adapter.runTask({}), /legacy_runner_migration_required/);
    assert.equal(registry.resolve().effectiveRunnerId, "pi");
    assert.equal(registry.resolve({ requestedRunnerId: runnerId, explicitFallbackPolicy: "allow_to_default" }).effectiveRunnerId, "pi");
    assert.throws(
      () => registry.resolve({ requestedRunnerId: runnerId, allowedRunnerIds: ["pi"], explicitFallbackPolicy: "allow_to_default" }),
      /not allowed in this workspace/i,
    );
  });

  test(`${runnerId}: readiness cannot certify or contact a configured private endpoint`, async () => {
    const registry = createLegacyRegistry();
    let calls = 0;
    const report = await buildRunnerReadinessReport(registry.get(runnerId), legacyConfig, {
      fetchImpl: async () => {
        calls += 1;
        throw new Error("legacy endpoints must not be contacted");
      },
    });
    assert.equal(calls, 0);
    assert.equal(report.status, "blocked");
    assert.equal(report.toolExecutionConformance.status, "blocked");
    assert.equal(report.capabilityNegotiated, false);
    assert.equal(report.toolExecutionConformance.approvalBridgeVerified, false);
    assert.equal(report.toolExecutionConformance.workspaceBoundaryVerified, false);
    assert.equal(report.toolExecutionConformance.artifactImportVerified, false);
    assert.equal(report.blockingReasons.some((reason) => reason.code === "legacy_runner_migration_required"), true);
  });
}

function createLegacyRegistry() {
  return createRunnerRegistry([
    { id: "pi", displayName: "Pi", status: "enabled", adapter: { async runTask() { throw new Error("unexpected Pi execution"); } } },
    ...listExternalRunnerRegistrations(legacyConfig),
  ]);
}
