import assert from "node:assert/strict";
import test from "node:test";

import type { CapabilityDescriptorV1, DeviceContextPackV1, DevicePlannerProposalV1 } from "@ling-stack/contracts";
import { DeviceModelOrchestrator, type DevicePlanningTarget } from "../dist/device-orchestration.js";
import { DeviceRunnerPlanningBridge, createLocalPlaybookProposal } from "../dist/device-runner.js";
import { createPcSoftwareDiagnosisPlaybook } from "../dist/device-playbooks.js";

const now = "2026-11-21T00:00:00.000Z";
const readCapability: CapabilityDescriptorV1 = {
  id: "linux.inspect.network", schemaVersion: "1.0", semanticVerb: "inspect.network", inputSchema: { type: "object" }, outputSchema: { type: "object" }, sideEffect: "read_only", approvalClass: "allow", requiredPermissions: ["ssh"], prerequisites: [], timeoutMs: 5000, responseBytesLimit: 4096, idempotency: "request", supportedDeviceKinds: ["linux"], supportedTransports: ["ssh"],
};
const writeCapability: CapabilityDescriptorV1 = { ...readCapability, id: "linux.repair.network", sideEffect: "reversible", approvalClass: "ask" };
const context: DeviceContextPackV1 = { contextId: "context-1", taskId: "task-1", maxBytes: 4096, facts: [{ connected: false }], hypotheses: [{ cause: "wifi" }], observations: ["obs-1"], untrustedTextRefs: [], generatedAt: now };
const planningInputRefs = ["obs-1"];

function target(capabilities: readonly CapabilityDescriptorV1[]): DevicePlanningTarget {
  return {
    ownerKind: "edge", ownerId: "edge-1",
    snapshot: {
      snapshotId: "snapshot-1", deviceId: "linux-1", adapterId: "ssh", adapterVersion: "1.0.0", contractMajor: 1,
      connectionRevision: "connection-1", capabilities, observedAt: now, freshnessUntil: "2026-11-21T00:01:00.000Z",
    },
  };
}

function proposal(nodes: DevicePlannerProposalV1["graph"]["nodes"]): DevicePlannerProposalV1 {
  return { proposalId: "proposal-1", taskId: "task-1", contextId: "context-1", source: "model", providerId: "provider-1", modelTurnId: "turn-1", planningInputRefs: ["obs-1"], createdAt: now, graph: { graphId: "task-1", revision: 1, status: "planned", nodes, createdAt: now, updatedAt: now } };
}

test("typed planner accepts a bounded graph and identifies approval nodes", () => {
  const accepted = new DeviceModelOrchestrator().acceptProposal({
    proposal: proposal([
      { nodeId: "read", targetDeviceId: "linux-1", ownerKind: "edge", ownerId: "edge-1", capabilityId: readCapability.id, capabilitySnapshotId: "snapshot-1", dependencies: [], status: "planning" },
      { nodeId: "repair", targetDeviceId: "linux-1", ownerKind: "edge", ownerId: "edge-1", capabilityId: writeCapability.id, capabilitySnapshotId: "snapshot-1", dependencies: ["read"], status: "planning" },
    ]),
    context,
    targets: [target([readCapability, writeCapability])],
    planningInputRefs,
    now,
  });
  assert.deepEqual(accepted.requiredApprovalNodeIds, ["repair"]);
  assert.equal(accepted.graph.status, "planned");
  assert.equal(accepted.contextDigest.length, 64);
});

test("typed planner rejects context, target, capability and execution-evidence drift", () => {
  const orchestrator = new DeviceModelOrchestrator();
  const node = { nodeId: "read", targetDeviceId: "linux-1", ownerKind: "edge" as const, ownerId: "edge-1",
    capabilityId: readCapability.id, capabilitySnapshotId: "snapshot-1", dependencies: [], status: "planning" as const };
  const base = { proposal: proposal([node]), context, targets: [target([readCapability])], planningInputRefs, now };
  assert.throws(() => orchestrator.acceptProposal({ ...base, proposal: { ...base.proposal, contextId: "other-context" } }), /another context/);
  assert.throws(() => orchestrator.acceptProposal({ ...base, targets: [] }), /unavailable device/);
  const otherTarget = target([readCapability]);
  assert.throws(() => orchestrator.acceptProposal({
    ...base, targets: [target([]), { ...otherTarget, snapshot: { ...otherTarget.snapshot, deviceId: "other-device" } }],
  }), /capability is unavailable/);
  assert.throws(() => orchestrator.acceptProposal({ ...base, proposal: proposal([{ ...node, attemptId: "attempt-1" }]) }), /execution evidence/);
  assert.throws(() => orchestrator.acceptProposal({ ...base, proposal: proposal([{ ...node, status: "succeeded" }]) }), /execution evidence/);
  assert.throws(() => orchestrator.acceptProposal({ ...base, proposal: proposal([{ ...node, ownerKind: "mobile", ownerId: "phone-1" }]) }), /outside the owner/);
  assert.throws(() => orchestrator.acceptProposal({ ...base, proposal: proposal([{ ...node, capabilitySnapshotId: "old-snapshot" }]) }), /current capability snapshot/);
  assert.throws(() => orchestrator.acceptProposal({ ...base, now: "2026-11-21T00:01:01.000Z" }), /current capability snapshot/);
  assert.throws(() => orchestrator.acceptProposal({ ...base, proposal: { ...base.proposal, planningInputRefs: ["foreign-observation"] } }), /outside its supplied context/);
});

test("runner planning bridge binds runner identity and falls back to a typed local playbook", async () => {
  const runner = {
    runnerId: "pi",
    capabilityRevision: "pi:device-plan:v1",
    async plan() {
      throw new Error("model service unavailable");
    },
  };
  const bridge = new DeviceRunnerPlanningBridge();
  const result = await bridge.plan({
    context,
    targets: [target([readCapability])],
    planningInputRefs,
    localPlaybook: {
      playbook: { ...createPcSoftwareDiagnosisPlaybook(), steps: [{ id: "inspect-network", capabilityId: readCapability.id, input: {} }] },
      targetDeviceId: "linux-1",
      ownerKind: "edge",
      ownerId: "edge-1",
      capabilitySnapshotId: "snapshot-1",
      now,
    },
    now,
  }, runner);
  assert.equal(result.source, "local_playbook");
  assert.equal(result.acceptance.graph.nodes[0]?.capabilityId, readCapability.id);
  assert.equal(result.fallbackReason, "runner_unavailable");

  const runnerProposal = createLocalPlaybookProposal({
    context,
    planningInputRefs: ["obs-1"],
    playbook: { ...createPcSoftwareDiagnosisPlaybook(), steps: [{ id: "inspect-network", capabilityId: readCapability.id, input: {} }] },
    targetDeviceId: "linux-1",
    ownerKind: "edge",
    ownerId: "edge-1",
    capabilitySnapshotId: "snapshot-1",
    now,
  });
  const accepted = new DeviceModelOrchestrator().acceptProposal({
    proposal: { ...runnerProposal, source: "model", runnerId: "pi", runnerCapabilityRevision: "pi:device-plan:v1" },
    context, targets: [target([readCapability])], planningInputRefs, runnerId: "pi", runnerCapabilityRevision: "pi:device-plan:v1", now,
  });
  assert.equal(accepted.runnerId, "pi");
});

test("runner planning bridge does not hide an invalid typed proposal behind the local fallback", async () => {
  const bridge = new DeviceRunnerPlanningBridge();
  await assert.rejects(() => bridge.plan({
    context,
    targets: [target([readCapability])],
    planningInputRefs,
    localPlaybook: {
      playbook: { ...createPcSoftwareDiagnosisPlaybook(), steps: [{ id: "inspect-network", capabilityId: readCapability.id, input: {} }] },
      targetDeviceId: "linux-1",
      ownerKind: "edge",
      ownerId: "edge-1",
      capabilitySnapshotId: "snapshot-1",
      now,
    },
    now,
  }, {
    runnerId: "pi",
    capabilityRevision: "pi:device-plan:v1",
    async plan() {
      return { proposalId: "invalid", taskId: "task-1", contextId: "context-1", source: "model" as const, graph: { graphId: "task-1", revision: 1, status: "planned" as const, nodes: [], createdAt: now, updatedAt: now }, planningInputRefs: [], createdAt: now, runnerId: "other-runner" };
    },
  }), /another runner|incomplete/);
});

test("cancelling a planner prevents its fallback", async () => {
  const abort = new AbortController();
  const reason = new Error("owner cancelled");
  const bridge = new DeviceRunnerPlanningBridge();
  await assert.rejects(bridge.plan({
    context,
    targets: [target([readCapability])],
    planningInputRefs,
    localPlaybook: {
      playbook: { ...createPcSoftwareDiagnosisPlaybook(), steps: [{ id: "inspect-network", capabilityId: readCapability.id, input: {} }] },
      targetDeviceId: "linux-1", ownerKind: "edge", ownerId: "edge-1", capabilitySnapshotId: "snapshot-1",
    },
    now,
    signal: abort.signal,
  }, {
    runnerId: "pi", capabilityRevision: "pi:device-plan:v1",
    async plan() {
      abort.abort(reason);
      throw new Error("interrupted request");
    },
  }), error => error === reason);
});
