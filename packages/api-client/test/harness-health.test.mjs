import assert from "node:assert/strict";
import test from "node:test";
import { LingDaemonClient } from "../dist/index.js";

const snapshot = {
  schemaVersion: 1,
  continuations: "enforce",
  toolBroker: "shadow",
  evaluations: "off",
  evaluationModelGate: "shadow",
  delegations: "enforce",
  delegationMaxDepth: 4,
  delegationSelectedWorkflowIds: ["workflow-explicit-qa"],
};

function healthClient(harness, features = {}) {
  return new LingDaemonClient({
    baseUrl: "http://daemon.test",
    fetch: async (url) => {
      assert.equal(String(url), "http://daemon.test/health");
      return new Response(JSON.stringify({
        ok: true,
        features: {
          channels: { autoRoute: true, intentSelector: true },
          transports: { providerWebSocketFallback: true, localWebSocketRpc: false },
          ...features,
          harness,
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
}

test("health projects only the validated Harness snapshot fields", async () => {
  const health = await healthClient({
    ...snapshot,
    privateConfig: { providerKey: "must-not-project" },
    environment: { LING_STACK_HARNESS_CONTINUATIONS_MODE: "enforce" },
  }).getHealth();

  assert.deepEqual(health.features, {
    channels: { autoRoute: true, intentSelector: true },
    transports: { providerWebSocketFallback: true, localWebSocketRpc: false },
    harness: snapshot,
  });
});

for (const mode of ["off", "shadow", "enforce"]) {
  for (const depth of [1, 16]) {
    test(`health preserves Harness mode ${mode} and depth ${depth}`, async () => {
      const expected = {
        ...snapshot,
        continuations: mode,
        toolBroker: mode,
        evaluations: mode,
        evaluationModelGate: "enforce",
        delegations: mode,
        delegationMaxDepth: depth,
      };
      assert.deepEqual((await healthClient(expected).getHealth()).features.harness, expected);
    });
  }
}

const invalidSnapshots = [
  ["missing", undefined],
  ["null", null],
  ["array", []],
  ["string", "enforce"],
  ["empty object", {}],
  ["wrong schema", { ...snapshot, schemaVersion: 2 }],
  ["string schema", { ...snapshot, schemaVersion: "1" }],
  ["missing schema", { ...snapshot, schemaVersion: undefined }],
  ["invalid continuations", { ...snapshot, continuations: "enabled" }],
  ["missing continuations", { ...snapshot, continuations: undefined }],
  ["invalid tool broker", { ...snapshot, toolBroker: true }],
  ["missing tool broker", { ...snapshot, toolBroker: undefined }],
  ["invalid evaluations", { ...snapshot, evaluations: "ENFORCE" }],
  ["missing evaluations", { ...snapshot, evaluations: undefined }],
  ["off model gate", { ...snapshot, evaluationModelGate: "off" }],
  ["missing model gate", { ...snapshot, evaluationModelGate: undefined }],
  ["invalid delegations", { ...snapshot, delegations: false }],
  ["missing delegations", { ...snapshot, delegations: undefined }],
  ["depth below range", { ...snapshot, delegationMaxDepth: 0 }],
  ["depth above range", { ...snapshot, delegationMaxDepth: 17 }],
  ["fractional depth", { ...snapshot, delegationMaxDepth: 1.5 }],
  ["string depth", { ...snapshot, delegationMaxDepth: "4" }],
  ["missing depth", { ...snapshot, delegationMaxDepth: undefined }],
  ["workflow selection string", { ...snapshot, delegationSelectedWorkflowIds: "workflow-explicit-qa" }],
  ["workflow selection wildcard", { ...snapshot, delegationSelectedWorkflowIds: ["*"] }],
  ["workflow selection duplicate", { ...snapshot, delegationSelectedWorkflowIds: ["workflow-a", "workflow-a"] }],
  ["workflow selection too large", { ...snapshot,
    delegationSelectedWorkflowIds: Array.from({ length: 101 }, (_value, index) => `workflow-${index}`) }],
];

for (const [name, harness] of invalidSnapshots) {
  test(`health treats ${name} Harness snapshot as unavailable without defaults`, async () => {
    const health = await healthClient(harness).getHealth();
    assert.equal(health.features.harness, undefined);
    assert.deepEqual(health.features.channels, { autoRoute: true, intentSelector: true });
    assert.deepEqual(health.features.transports, {
      providerWebSocketFallback: true,
      localWebSocketRpc: false,
    });
  });
}

test("Harness projection does not change existing channel or transport parsing", async () => {
  const health = await healthClient(snapshot, {
    channels: { autoRoute: "true", intentSelector: 1, teamObserverBus: true, terminalReports: true },
    transports: null,
  }).getHealth();

  assert.deepEqual(health.features, {
    channels: { autoRoute: false, intentSelector: false },
    transports: { providerWebSocketFallback: false, localWebSocketRpc: false },
    harness: snapshot,
  });
});

test("health accepts a historical Harness snapshot without frozen workflow selection", async () => {
  const { delegationSelectedWorkflowIds: _selection, ...historical } = snapshot;
  assert.deepEqual((await healthClient(historical).getHealth()).features.harness, historical);
});
