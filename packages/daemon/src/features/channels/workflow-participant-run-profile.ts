import type {
  AiTeammate,
  Channel,
  ChannelWorkflowStep,
  RunStore,
  RunTool,
  SkillApprovalProfile,
} from "@ling-stack/core";
import { isWorkflowParticipantAuthorityV1 } from "@ling-stack/contracts";
import { resolveAiTeammateReference } from "../teammates/identity.js";
import { teammateCanWorkInEffectiveChannel } from "./channel-teammate-availability.js";

export type WorkflowParticipantRunProfileBlockerCode =
  | "workflow_participant_authority_invalid"
  | "workflow_participant_override_forbidden"
  | "workflow_participant_not_found"
  | "workflow_participant_unavailable"
  | "workflow_participant_required_tools_unavailable";

export type WorkflowParticipantRunProfileResolution =
  | {
      readonly kind: "ready";
      readonly teammateId: string;
      readonly teammate: AiTeammate;
      readonly systemPrompt?: string;
      readonly appendSystemPrompt: readonly string[];
      readonly approvalProfile: SkillApprovalProfile;
    }
  | {
      readonly kind: "blocked";
      readonly code: WorkflowParticipantRunProfileBlockerCode;
      readonly reason: string;
      readonly missingRequirements: readonly string[];
    };

export function resolveWorkflowParticipantRunProfile(input: {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly step: ChannelWorkflowStep;
  readonly requestedAssigneeTeammateId?: string;
  readonly requiredTools: readonly RunTool[];
}): WorkflowParticipantRunProfileResolution {
  const teammateId = input.requestedAssigneeTeammateId ?? input.step.toParticipantId;
  const authority = input.step.participantAuthority;
  if (!isWorkflowParticipantAuthorityV1(authority)
    || authority.participantId !== input.step.toParticipantId) {
    return {
      kind: "blocked",
      code: "workflow_participant_authority_invalid",
      reason: `Workflow step ${input.step.id} has invalid participant authority provenance.`,
      missingRequirements: ["participant_authority"],
    };
  }
  if (teammateId !== input.step.toParticipantId) {
    return {
      kind: "blocked",
      code: "workflow_participant_override_forbidden",
      reason: `Manifest-backed workflow step ${input.step.id} is assigned to ${input.step.toParticipantId}; assignee override ${teammateId} is forbidden.`,
      missingRequirements: ["assigned_participant"],
    };
  }

  const teammate = resolveAiTeammateReference(input.store, teammateId);
  if (!teammate) {
    return {
      kind: "blocked",
      code: "workflow_participant_not_found",
      reason: `Workflow participant not found: ${teammateId}.`,
      missingRequirements: ["participant_profile"],
    };
  }
  const requiresChannelMembership = authority.kind === "channel_selection";
  if (teammate.status !== "active" || teammate.hidden
    || (requiresChannelMembership
      && !teammateCanWorkInEffectiveChannel(input.store, input.channel, teammate.id))) {
    return {
      kind: "blocked",
      code: "workflow_participant_unavailable",
      reason: `Workflow participant ${teammate.displayName} is not currently available in this channel.`,
      missingRequirements: ["participant_availability"],
    };
  }

  const missingTools = input.requiredTools.filter((tool) => !teammate.allowedTools.includes(tool));
  if (missingTools.length > 0) {
    return {
      kind: "blocked",
      code: "workflow_participant_required_tools_unavailable",
      reason: `Workflow participant ${teammate.displayName} no longer allows required tools: ${missingTools.join(", ")}.`,
      missingRequirements: missingTools.map((tool) => `tool:${tool}`),
    };
  }

  return {
    kind: "ready",
    teammateId: teammate.id,
    teammate,
    systemPrompt: teammate.systemPrompt,
    appendSystemPrompt: teammate.appendSystemPrompt,
    approvalProfile: teammate.approvalProfile,
  };
}
