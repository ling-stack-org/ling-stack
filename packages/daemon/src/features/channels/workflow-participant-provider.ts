import {
  resolveEffectiveTeammateProvider,
  type AiTeammate,
  type Channel,
  type RunStore,
  type RunTool,
} from "@ling-stack/core";
import {
  isWorkflowParticipantProviderBindingV1,
  type WorkflowParticipantProviderBindingV1,
  type WorkflowParticipantProviderBlockerReasonV1,
  type WorkflowParticipantProviderBlockerV1,
} from "@ling-stack/contracts";
import { HttpError } from "../../errors.js";
import type { WorkflowStepRunRequest } from "./workflows.js";

export type ValidateWorkflowParticipantProviderRequest = (request: WorkflowStepRunRequest) => void;

export type WorkflowParticipantProviderPreflight =
  | {
      readonly kind: "ready";
      readonly binding: WorkflowParticipantProviderBindingV1;
    }
  | {
      readonly kind: "blocked";
      readonly blocker: WorkflowParticipantProviderBlockerV1;
    };

export class WorkflowParticipantProviderPreflightError extends HttpError {
  readonly blocker: WorkflowParticipantProviderBlockerV1;

  constructor(blocker: WorkflowParticipantProviderBlockerV1) {
    super(400, blocker.code, blocker.message);
    this.name = "WorkflowParticipantProviderPreflightError";
    this.blocker = blocker;
  }
}

export function preflightWorkflowParticipantProvider(input: {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly teammate: AiTeammate;
  readonly cwd: string;
  readonly validateRunRequest: ValidateWorkflowParticipantProviderRequest;
  readonly requiredTools?: readonly RunTool[];
  readonly frozenBinding?: WorkflowParticipantProviderBindingV1;
}): WorkflowParticipantProviderPreflight {
  const bindingResolution = resolveBinding(input);
  if (bindingResolution.kind === "blocked") return bindingResolution;

  const binding = bindingResolution.binding;
  try {
    input.validateRunRequest({
      workspaceCwd: input.cwd,
      cwd: input.cwd,
      providerPresetId: binding.providerPresetId,
      teammateId: input.teammate.id,
      task: {
        id: `workflow-provider-preflight:${input.teammate.id}`,
        title: `Validate ${input.teammate.displayName} workflow model`,
        prompt: "Validate the selected workflow participant model without starting a run.",
        channelId: input.channel.id,
      },
      tools: input.requiredTools ?? [],
      thinkingLevel: "off",
    });
  } catch (error) {
    const reasonCode = providerFailureReason(error);
    return {
      kind: "blocked",
      blocker: createProviderBlocker({
        binding,
        reasonCode,
        owner: ownerForSource(binding.source),
        repairTarget: repairTargetForSource(binding.source),
        message: `${input.teammate.displayName} cannot use model ${binding.providerPresetId}: ${errorMessage(error)}`,
      }),
    };
  }
  return { kind: "ready", binding };
}

function resolveBinding(
  input: Parameters<typeof preflightWorkflowParticipantProvider>[0],
): WorkflowParticipantProviderPreflight {
  if (input.frozenBinding !== undefined) {
    if (!isWorkflowParticipantProviderBindingV1(input.frozenBinding)
      || input.frozenBinding.participantId !== input.teammate.id) {
      return {
        kind: "blocked",
        blocker: createProviderBlocker({
          binding: {
            schemaVersion: 1,
            participantId: input.teammate.id,
            bindingMode: input.teammate.modelBindingMode,
            source: input.teammate.modelBindingMode === "fixed" ? "teammate_fixed" : "workspace_default",
            providerPresetId: "invalid",
          },
          reasonCode: "provider_unavailable",
          owner: input.teammate.modelBindingMode === "fixed" ? "teammate" : "workspace",
          repairTarget: input.teammate.modelBindingMode === "fixed" ? "teammate_settings" : "model_workbench",
          message: `Workflow participant ${input.teammate.displayName} has invalid frozen model binding provenance.`,
          omitProviderPresetId: true,
        }),
      };
    }
    return { kind: "ready", binding: input.frozenBinding };
  }

  const resolution = resolveEffectiveTeammateProvider({
    teammate: input.teammate,
    surface: "channel",
    workspaceDefaultProviderPresetId: input.store.getWorkspaceSettings().defaultProviderPresetId,
    channelDefaultProviderPresetId: input.channel.defaultProviderPresetId,
  });
  if (resolution.kind === "resolved") return { kind: "ready", binding: resolution.binding };
  return {
    kind: "blocked",
    blocker: createProviderBlocker({
      binding: {
        schemaVersion: 1,
        participantId: resolution.participantId,
        bindingMode: resolution.bindingMode,
        source: resolution.source,
        providerPresetId: "missing",
      },
      reasonCode: resolution.reasonCode,
      owner: resolution.owner,
      repairTarget: resolution.repairTarget,
      message: missingBindingMessage(input.teammate, resolution.reasonCode),
      omitProviderPresetId: true,
    }),
  };
}

function createProviderBlocker(input: {
  readonly binding: WorkflowParticipantProviderBindingV1;
  readonly reasonCode: WorkflowParticipantProviderBlockerReasonV1;
  readonly owner: WorkflowParticipantProviderBlockerV1["owner"];
  readonly repairTarget: WorkflowParticipantProviderBlockerV1["repairTarget"];
  readonly message: string;
  readonly omitProviderPresetId?: boolean;
}): WorkflowParticipantProviderBlockerV1 {
  return {
    schemaVersion: 1,
    code: "workflow_participant_provider_unavailable",
    reasonCode: input.reasonCode,
    participantId: input.binding.participantId,
    bindingMode: input.binding.bindingMode,
    source: input.binding.source,
    owner: input.owner,
    repairTarget: input.repairTarget,
    ...(!input.omitProviderPresetId ? { providerPresetId: input.binding.providerPresetId } : {}),
    message: input.message,
  };
}

function missingBindingMessage(
  teammate: AiTeammate,
  reasonCode: WorkflowParticipantProviderBlockerReasonV1,
): string {
  if (reasonCode === "workspace_default_provider_missing") {
    return `${teammate.displayName} follows the workspace default model, but no workspace default is configured. Open Model Workbench and set one before retrying.`;
  }
  if (reasonCode === "channel_ling_agent_provider_missing") {
    return `${teammate.displayName} requires the Channel Ling Agent model, but this Channel has none. Open Channel Settings and select one before retrying.`;
  }
  return `${teammate.displayName} requires a fixed model, but none is configured. Open the teammate Model settings before retrying.`;
}

function providerFailureReason(error: unknown): WorkflowParticipantProviderBlockerReasonV1 {
  return error instanceof HttpError && error.code === "unsupported_capability"
    ? "provider_capability_missing"
    : "provider_unavailable";
}

function ownerForSource(
  source: WorkflowParticipantProviderBindingV1["source"],
): WorkflowParticipantProviderBlockerV1["owner"] {
  if (source === "channel_ling_agent_model") return "channel";
  if (source === "teammate_fixed") return "teammate";
  return "workspace";
}

function repairTargetForSource(
  source: WorkflowParticipantProviderBindingV1["source"],
): WorkflowParticipantProviderBlockerV1["repairTarget"] {
  if (source === "channel_ling_agent_model") return "channel_settings";
  if (source === "teammate_fixed") return "teammate_settings";
  return "model_workbench";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
