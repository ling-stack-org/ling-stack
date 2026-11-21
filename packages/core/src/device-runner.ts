import type {
  CapabilityDescriptorV1,
  DeviceContextPackV1,
  DevicePlannerAcceptanceV1,
  DevicePlannerProposalV1,
  DeviceTaskGraphNodeV1,
  DeviceTaskGraphV1,
  DeviceTaskStatusV1,
} from "@ling-stack/contracts";
import type { DevicePlaybookV1 } from "./device-playbooks.js";
import { DeviceModelOrchestrator } from "./device-orchestration.js";

export interface DevicePlanningRunnerInput {
  readonly context: DeviceContextPackV1;
  readonly allowedTargetDeviceIds: readonly string[];
  readonly capabilities: ReadonlyMap<string, CapabilityDescriptorV1>;
  readonly planningInputRefs: readonly string[];
  readonly signal?: AbortSignal;
}

export interface DevicePlanningRunner {
  readonly runnerId: string;
  readonly capabilityRevision: string;
  plan(input: DevicePlanningRunnerInput): Promise<DevicePlannerProposalV1>;
}

export interface DeviceRunnerPlanInput extends DevicePlanningRunnerInput {
  readonly localPlaybook?: {
    readonly playbook: DevicePlaybookV1;
    readonly targetDeviceId: string;
    readonly ownerKind: DeviceTaskGraphNodeV1["ownerKind"];
    readonly ownerId: string;
    readonly capabilitySnapshotId: string;
    readonly now?: string;
  };
  readonly now?: string;
}

export interface DeviceRunnerPlanResult {
  readonly source: "runner" | "local_playbook";
  readonly proposal: DevicePlannerProposalV1;
  readonly acceptance: DevicePlannerAcceptanceV1;
  readonly fallbackReason?: string;
}

/** Connects a verified model runner to typed device proposals and retains a deterministic fallback. */
export class DeviceRunnerPlanningBridge {
  readonly #orchestrator: DeviceModelOrchestrator;

  constructor(orchestrator = new DeviceModelOrchestrator()) {
    this.#orchestrator = orchestrator;
  }

  async plan(input: DeviceRunnerPlanInput, runner?: DevicePlanningRunner): Promise<DeviceRunnerPlanResult> {
    if (runner) {
      let proposal: DevicePlannerProposalV1;
      try {
        proposal = await runner.plan(input);
      } catch (error) {
        if (!input.localPlaybook) throw error;
        const fallbackProposal = createLocalPlaybookProposal({
          context: input.context,
          planningInputRefs: input.planningInputRefs,
          ...input.localPlaybook,
        });
        return {
          source: "local_playbook",
          proposal: fallbackProposal,
          acceptance: this.#orchestrator.acceptProposal({
            proposal: fallbackProposal,
            context: input.context,
            allowedTargetDeviceIds: input.allowedTargetDeviceIds,
            capabilities: input.capabilities,
            now: input.now,
          }),
          fallbackReason: error instanceof Error ? error.message : String(error),
        };
      }
      return {
        source: "runner",
        proposal,
        acceptance: this.#orchestrator.acceptProposal({
          proposal,
          context: input.context,
          allowedTargetDeviceIds: input.allowedTargetDeviceIds,
          capabilities: input.capabilities,
          runnerId: runner.runnerId,
          runnerCapabilityRevision: runner.capabilityRevision,
          now: input.now,
        }),
      };
    }
    if (!input.localPlaybook) throw new Error("device planning runner is unavailable and no local playbook was provided");
    const proposal = createLocalPlaybookProposal({ context: input.context, planningInputRefs: input.planningInputRefs, ...input.localPlaybook });
    return {
      source: "local_playbook",
      proposal,
      acceptance: this.#orchestrator.acceptProposal({ proposal, context: input.context, allowedTargetDeviceIds: input.allowedTargetDeviceIds, capabilities: input.capabilities, now: input.now }),
    };
  }
}

export function createLocalPlaybookProposal(input: {
  readonly context: DeviceContextPackV1;
  readonly planningInputRefs: readonly string[];
  readonly playbook: DevicePlaybookV1;
  readonly targetDeviceId: string;
  readonly ownerKind: DeviceTaskGraphNodeV1["ownerKind"];
  readonly ownerId: string;
  readonly capabilitySnapshotId: string;
  readonly now?: string;
}): DevicePlannerProposalV1 {
  const now = input.now ?? input.context.generatedAt;
  const nodes: DeviceTaskGraphNodeV1[] = input.playbook.steps.map((step, index) => ({
    nodeId: `${input.playbook.id}:${step.id}`,
    targetDeviceId: input.targetDeviceId,
    ownerKind: input.ownerKind,
    ownerId: input.ownerId,
    capabilityId: step.capabilityId,
    capabilitySnapshotId: input.capabilitySnapshotId,
    dependencies: index === 0 ? [] : [`${input.playbook.id}:${input.playbook.steps[index - 1]!.id}`],
    status: "planning" as DeviceTaskStatusV1,
  }));
  const graph: DeviceTaskGraphV1 = { graphId: input.context.taskId, revision: 1, status: "planned", nodes, createdAt: now, updatedAt: now };
  return {
    proposalId: `local:${input.playbook.id}:${input.context.taskId}`,
    taskId: input.context.taskId,
    contextId: input.context.contextId,
    source: "local_playbook",
    graph,
    planningInputRefs: [...new Set(input.planningInputRefs)],
    createdAt: now,
  };
}

