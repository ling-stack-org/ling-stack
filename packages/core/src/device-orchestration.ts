import { createHash } from "node:crypto";
import type {
  CapabilityDescriptorV1,
  DeviceContextPackV1,
  DevicePlannerAcceptanceV1,
  DevicePlannerProposalV1,
} from "@ling-stack/contracts";
import { DeviceFabricError, DeviceTaskGraphCoordinator } from "./device-fabric.js";

export interface DevicePlannerAcceptanceInput {
  readonly proposal: DevicePlannerProposalV1;
  readonly context: DeviceContextPackV1;
  readonly allowedTargetDeviceIds: readonly string[];
  readonly capabilities: ReadonlyMap<string, CapabilityDescriptorV1>;
  readonly runnerId?: string;
  readonly runnerCapabilityRevision?: string;
  readonly now?: string;
}

export class DeviceModelOrchestrator {
  readonly #graph = new DeviceTaskGraphCoordinator();

  acceptProposal(input: DevicePlannerAcceptanceInput): DevicePlannerAcceptanceV1 {
    const { proposal, context } = input;
    if (!proposal.proposalId.trim() || !proposal.taskId.trim() || !proposal.contextId.trim() || !proposal.createdAt.trim() || proposal.planningInputRefs.length === 0) {
      throw new DeviceFabricError("invalid_graph", "device planner proposal is incomplete");
    }
    if (proposal.taskId !== context.taskId || proposal.contextId !== context.contextId) throw new DeviceFabricError("revision_conflict", "planner proposal is bound to another context");
    if (input.runnerId !== undefined && proposal.runnerId !== input.runnerId) throw new DeviceFabricError("revision_conflict", "planner proposal is bound to another runner");
    if (input.runnerCapabilityRevision !== undefined && proposal.runnerCapabilityRevision !== input.runnerCapabilityRevision) throw new DeviceFabricError("revision_conflict", "planner runner capability revision changed");
    if (proposal.graph.graphId !== proposal.taskId || proposal.graph.status !== "planned") throw new DeviceFabricError("invalid_graph", "planner proposal graph is not a planned task graph");
    if (new Set(proposal.planningInputRefs).size !== proposal.planningInputRefs.length) throw new DeviceFabricError("revision_conflict", "planner input references must be unique");
    this.#graph.validateGraph(proposal.graph);
    const allowedTargets = new Set(input.allowedTargetDeviceIds);
    const requiredApprovalNodeIds: string[] = [];
    for (const node of proposal.graph.nodes) {
      if (!allowedTargets.has(node.targetDeviceId)) throw new DeviceFabricError("safety_denied", "planner proposal targets an unavailable device");
      if (!node.ownerId.trim() || !node.capabilityId.trim() || !node.capabilitySnapshotId.trim()) throw new DeviceFabricError("invalid_graph", "planner node is incomplete");
      const capability = input.capabilities.get(node.capabilityId);
      if (!capability || !capability.supportedDeviceKinds.length) throw new DeviceFabricError("target_missing", "planner node capability is unavailable");
      if (capability.sideEffect !== "read_only" || capability.approvalClass !== "allow") requiredApprovalNodeIds.push(node.nodeId);
      if (node.attemptId || node.resultRef) throw new DeviceFabricError("safety_denied", "planner proposal cannot include execution evidence");
    }
    const contextDigest = createHash("sha256").update(JSON.stringify({ context, proposal: { ...proposal, graph: proposal.graph } })).digest("hex");
    return {
      proposalId: proposal.proposalId,
      taskId: proposal.taskId,
      contextId: proposal.contextId,
      graph: proposal.graph,
      contextDigest,
      requiredApprovalNodeIds,
      acceptedAt: input.now ?? new Date().toISOString(),
      ...(proposal.runnerId ? { runnerId: proposal.runnerId } : {}),
      ...(proposal.runnerCapabilityRevision ? { runnerCapabilityRevision: proposal.runnerCapabilityRevision } : {}),
    };
  }
}

export function capabilityMap(capabilities: readonly CapabilityDescriptorV1[]): ReadonlyMap<string, CapabilityDescriptorV1> {
  return new Map(capabilities.map(capability => [capability.id, capability]));
}
