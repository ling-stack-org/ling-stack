import assert from "node:assert/strict";
import test from "node:test";

import type { CapabilityDescriptorV1, DeviceContextPackV1, DevicePlannerProposalV1 } from "@ling-stack/contracts";
import { DeviceModelOrchestrator, capabilityMap } from "../dist/device-orchestration.js";

const now = "2026-11-21T00:00:00.000Z";
const readCapability: CapabilityDescriptorV1 = {
  id: "linux.inspect.network", schemaVersion: "1.0", semanticVerb: "inspect.network", inputSchema: { type: "object" }, outputSchema: { type: "object" }, sideEffect: "read_only", approvalClass: "allow", requiredPermissions: ["ssh"], prerequisites: [], timeoutMs: 5000, responseBytesLimit: 4096, idempotency: "request", supportedDeviceKinds: ["linux"], supportedTransports: ["ssh"],
};
const writeCapability: CapabilityDescriptorV1 = { ...readCapability, id: "linux.repair.network", sideEffect: "reversible", approvalClass: "ask" };
const context: DeviceContextPackV1 = { contextId: "context-1", taskId: "task-1", maxBytes: 4096, facts: [{ connected: false }], hypotheses: [{ cause: "wifi" }], observations: ["obs-1"], untrustedTextRefs: [], generatedAt: now };

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
    allowedTargetDeviceIds: ["linux-1"],
    capabilities: capabilityMap([readCapability, writeCapability]),
    now,
  });
  assert.deepEqual(accepted.requiredApprovalNodeIds, ["repair"]);
  assert.equal(accepted.graph.status, "planned");
  assert.equal(accepted.contextDigest.length, 64);
});

test("typed planner rejects context, target, capability and execution-evidence drift", () => {
  const orchestrator = new DeviceModelOrchestrator();
  const base = { proposal: proposal([{ nodeId: "read", targetDeviceId: "linux-1", ownerKind: "edge" as const, ownerId: "edge-1", capabilityId: readCapability.id, capabilitySnapshotId: "snapshot-1", dependencies: [], status: "planning" as const }]), context, allowedTargetDeviceIds: ["linux-1"], capabilities: capabilityMap([readCapability]), now };
  assert.throws(() => orchestrator.acceptProposal({ ...base, proposal: { ...base.proposal, contextId: "other-context" } }), /another context/);
  assert.throws(() => orchestrator.acceptProposal({ ...base, allowedTargetDeviceIds: ["other-device"] }), /unavailable device/);
  assert.throws(() => orchestrator.acceptProposal({ ...base, capabilities: capabilityMap([]) }), /capability is unavailable/);
  assert.throws(() => orchestrator.acceptProposal({ ...base, proposal: { ...base.proposal, graph: { ...base.proposal.graph, nodes: [{ ...base.proposal.graph.nodes[0]!, attemptId: "attempt-1" }] } } }), /execution evidence/);
});
