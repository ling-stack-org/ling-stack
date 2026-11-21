import { createHash } from "node:crypto";
import type {
  DeviceCapabilitySnapshotV1,
  DeviceContextPackV1,
  DevicePlannerAcceptanceV1,
  DevicePlannerProposalV1,
  DeviceTaskGraphNodeV1,
} from "@ling-stack/contracts";
import { DeviceFabricError, DeviceTaskGraphCoordinator } from "./device-fabric.js";

export interface DevicePlanningTarget {
  readonly ownerKind: DeviceTaskGraphNodeV1["ownerKind"];
  readonly ownerId: string;
  readonly snapshot: DeviceCapabilitySnapshotV1;
}

export interface DevicePlannerAcceptanceInput {
  readonly proposal: DevicePlannerProposalV1;
  readonly context: DeviceContextPackV1;
  readonly targets: readonly DevicePlanningTarget[];
  readonly planningInputRefs: readonly string[];
  readonly runnerId?: string;
  readonly runnerCapabilityRevision?: string;
  readonly now?: string;
}

export class DeviceModelOrchestrator {
  readonly #graph = new DeviceTaskGraphCoordinator();

  acceptProposal(input: DevicePlannerAcceptanceInput): DevicePlannerAcceptanceV1 {
    const { proposal, context } = input;
    if (!proposal.proposalId.trim() || !proposal.taskId.trim() || !proposal.contextId.trim()
      || !Number.isFinite(Date.parse(proposal.createdAt)) || proposal.planningInputRefs.length === 0) {
      throw new DeviceFabricError("invalid_graph", "device planner proposal is incomplete");
    }
    if (proposal.taskId !== context.taskId || proposal.contextId !== context.contextId) throw new DeviceFabricError("revision_conflict", "planner proposal is bound to another context");
    if (input.runnerId !== undefined && (proposal.runnerId !== input.runnerId || proposal.source !== "model")) {
      throw new DeviceFabricError("revision_conflict", "planner proposal is bound to another runner or source");
    }
    if (input.runnerCapabilityRevision !== undefined && proposal.runnerCapabilityRevision !== input.runnerCapabilityRevision) throw new DeviceFabricError("revision_conflict", "planner runner capability revision changed");
    if (proposal.graph.graphId !== proposal.taskId || proposal.graph.status !== "planned" || proposal.graph.nodes.length === 0) {
      throw new DeviceFabricError("invalid_graph", "planner proposal graph is not a planned task graph");
    }
    if (new Set(proposal.planningInputRefs).size !== proposal.planningInputRefs.length) throw new DeviceFabricError("revision_conflict", "planner input references must be unique");
    this.#graph.validateGraph(proposal.graph);
    const allowedRefs = new Set(input.planningInputRefs);
    if (proposal.planningInputRefs.some(ref => !allowedRefs.has(ref))) {
      throw new DeviceFabricError("safety_denied", "planner references evidence outside its supplied context");
    }
    const targets = new Map(input.targets.map(target => [target.snapshot.deviceId, target]));
    if (targets.size !== input.targets.length) throw new DeviceFabricError("invalid_graph", "device planning targets are ambiguous");
    const now = input.now ?? new Date().toISOString();
    const nowMs = Date.parse(now);
    const requiredApprovalNodeIds: string[] = [];
    for (const node of proposal.graph.nodes) {
      const target = targets.get(node.targetDeviceId);
      if (!target) throw new DeviceFabricError("safety_denied", "planner proposal targets an unavailable device");
      if (node.ownerId !== target.ownerId || node.ownerKind !== target.ownerKind
        || node.capabilitySnapshotId !== target.snapshot.snapshotId
        || !(Date.parse(target.snapshot.observedAt) <= nowMs && nowMs < Date.parse(target.snapshot.freshnessUntil))) {
        throw new DeviceFabricError("target_changed", "planner node is outside the owner and current capability snapshot");
      }
      const capability = target.snapshot.capabilities.find(item => item.id === node.capabilityId);
      if (!capability) throw new DeviceFabricError("target_missing", "planner node capability is unavailable on this target");
      if (node.attemptId || node.resultRef || (node.status !== "created" && node.status !== "planning")) {
        throw new DeviceFabricError("safety_denied", "planner proposal cannot include execution evidence");
      }
      if (capability.sideEffect !== "read_only" || capability.approvalClass !== "allow") requiredApprovalNodeIds.push(node.nodeId);
    }
    const contextDigest = createHash("sha256").update(JSON.stringify({ context, proposal, targets: input.targets })).digest("hex");
    return {
      proposalId: proposal.proposalId,
      taskId: proposal.taskId,
      contextId: proposal.contextId,
      graph: proposal.graph,
      contextDigest,
      requiredApprovalNodeIds,
      acceptedAt: now,
      ...(proposal.runnerId ? { runnerId: proposal.runnerId } : {}),
      ...(proposal.runnerCapabilityRevision ? { runnerCapabilityRevision: proposal.runnerCapabilityRevision } : {}),
    };
  }
}
