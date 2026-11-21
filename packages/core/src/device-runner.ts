import type {
  DeviceContextPackV1,
  DevicePlannerAcceptanceV1,
  DevicePlannerProposalV1,
  DeviceTaskGraphNodeV1,
  DeviceTaskGraphV1,
  DeviceTaskStatusV1,
} from "@ling-stack/contracts";
import { isDevicePlaybookV1, type DevicePlaybookV1 } from "./device-playbooks.js";
import { DeviceModelOrchestrator, type DevicePlanningTarget } from "./device-orchestration.js";

export interface DevicePlanningRunnerInput {
  readonly context: DeviceContextPackV1;
  readonly targets: readonly DevicePlanningTarget[];
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
  readonly fallbackReason?: "runner_unavailable";
}

/** Connects a verified model runner to typed device proposals and retains a deterministic fallback. */
export class DeviceRunnerPlanningBridge {
  readonly #orchestrator: DeviceModelOrchestrator;

  constructor(orchestrator = new DeviceModelOrchestrator()) {
    this.#orchestrator = orchestrator;
  }

  async plan(input: DeviceRunnerPlanInput, runner?: DevicePlanningRunner): Promise<DeviceRunnerPlanResult> {
    input.signal?.throwIfAborted();
    if (runner) {
      let proposal: DevicePlannerProposalV1;
      try {
        const { context, targets, planningInputRefs, signal } = input;
        proposal = await runner.plan({ context, targets, planningInputRefs, signal });
      } catch (error) {
        input.signal?.throwIfAborted();
        if (!input.localPlaybook || (error instanceof Error && error.name === "AbortError")) throw error;
        return this.planLocal(input, "runner_unavailable");
      }
      input.signal?.throwIfAborted();
      return {
        source: "runner",
        proposal,
        acceptance: this.#orchestrator.acceptProposal({
          ...input,
          proposal,
          runnerId: runner.runnerId,
          runnerCapabilityRevision: runner.capabilityRevision,
        }),
      };
    }
    return this.planLocal(input);
  }

  private planLocal(input: DeviceRunnerPlanInput, fallbackReason?: DeviceRunnerPlanResult["fallbackReason"]): DeviceRunnerPlanResult {
    const local = input.localPlaybook;
    if (!local || !local.playbook.localFallback || !isDevicePlaybookV1(local.playbook)) {
      throw new Error("device planning requires a supported local fallback playbook");
    }
    const proposal = createLocalPlaybookProposal({ context: input.context, planningInputRefs: input.planningInputRefs, ...local });
    return {
      source: "local_playbook",
      proposal,
      acceptance: this.#orchestrator.acceptProposal({ ...input, proposal }),
      ...(fallbackReason ? { fallbackReason } : {}),
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
