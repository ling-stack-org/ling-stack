import type {
  AiCouncil,
  AiCouncilMember,
  AiCouncilRoutingMode,
  AiTeammate,
  CloneAiCouncilRequest,
  CreateAiCouncilRequest,
} from "../../types.js";

export const councilCreateRoutingModes: readonly AiCouncilRoutingMode[] = [
  "advisory",
  "handoff",
  "parallel_review",
];

export interface CouncilCreateDraft {
  readonly displayName: string;
  readonly description: string;
  readonly routingMode: AiCouncilRoutingMode;
  readonly memberIds: readonly string[];
}

export interface CouncilCloneDraft {
  readonly displayName: string;
  readonly description: string;
  readonly pinned: boolean;
}

export interface CouncilCloneMemberSummary {
  readonly id: string;
  readonly displayName: string;
  readonly enabled: boolean;
}

export function createInitialCouncilDraft(defaultName: string): CouncilCreateDraft {
  return {
    displayName: defaultName,
    description: "",
    routingMode: "advisory",
    memberIds: [],
  };
}

export function createInitialCloneDraft(source: AiCouncil, copyName: string): CouncilCloneDraft {
  return {
    displayName: copyName,
    description: source.description,
    pinned: false,
  };
}

export function listEligibleCouncilTeammates(teammates: readonly AiTeammate[]): readonly AiTeammate[] {
  return teammates
    .filter((teammate) => (
      teammate.status === "active" &&
      !teammate.hidden &&
      !isLingAgentTeammate(teammate)
    ))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export function toggleCouncilDraftMember(
  memberIds: readonly string[],
  teammateId: string,
): readonly string[] {
  return memberIds.includes(teammateId)
    ? memberIds.filter((id) => id !== teammateId)
    : [...memberIds, teammateId];
}

export function buildCreateAiCouncilRequest(
  draft: CouncilCreateDraft,
  eligibleTeammates: readonly AiTeammate[],
): CreateAiCouncilRequest {
  const selectedIds = new Set(draft.memberIds);
  const members = eligibleTeammates
    .filter((teammate) => selectedIds.has(teammate.id))
    .map((teammate, position) => ({
      teammateId: teammate.id,
      slotKey: teammate.roleKey,
      position,
      enabled: true,
    }));
  return {
    displayName: draft.displayName.trim(),
    description: draft.description.trim() || undefined,
    routingPolicy: { defaultMode: draft.routingMode },
    members,
  };
}

export function buildCloneAiCouncilRequest(draft: CouncilCloneDraft): CloneAiCouncilRequest {
  return {
    displayName: draft.displayName.trim(),
    description: draft.description.trim(),
    pinned: draft.pinned,
  };
}

export function buildCloneMemberSummaries(
  members: readonly AiCouncilMember[],
  teammates: readonly AiTeammate[],
): readonly CouncilCloneMemberSummary[] {
  const teammateById = new Map(teammates.map((teammate) => [teammate.id, teammate]));
  return [...members]
    .sort((left, right) => left.position - right.position)
    .map((member) => ({
      id: member.teammateId,
      displayName: teammateById.get(member.teammateId)?.displayName ?? member.label ?? member.teammateId,
      enabled: member.enabled,
    }));
}

export function buildCouncilCloneSourceSignature(
  source: AiCouncil,
  members: readonly AiCouncilMember[],
): string {
  const memberSnapshot = [...members]
    .sort((left, right) => left.position - right.position || left.teammateId.localeCompare(right.teammateId))
    .map((member) => ({
      teammateId: member.teammateId,
      slotKey: member.slotKey ?? null,
      label: member.label ?? null,
      position: member.position,
      enabled: member.enabled,
    }));
  return JSON.stringify({
    routingPolicy: {
      defaultMode: source.routingPolicy.defaultMode,
      maxActiveMembers: source.routingPolicy.maxActiveMembers ?? null,
      notes: source.routingPolicy.notes,
    },
    members: memberSnapshot,
  });
}

function isLingAgentTeammate(teammate: AiTeammate): boolean {
  return teammate.id === "ling_agent" || teammate.id === "ling-agent" || teammate.systemRole === "ling_agent";
}
