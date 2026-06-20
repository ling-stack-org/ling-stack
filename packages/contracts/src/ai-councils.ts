import type { AiTeammate } from "./teammates.js";

export type AiCouncilStatus = "active" | "paused" | "archived";
export type AiCouncilSource = "builtin" | "template" | "user";
export type AiCouncilRoutingMode = "advisory" | "handoff" | "parallel_review";

export interface AiCouncilRoutingPolicy {
  readonly defaultMode: AiCouncilRoutingMode;
  readonly maxActiveMembers?: number;
  readonly notes: readonly string[];
}

export interface AiCouncilGovernanceProfile {
  readonly permissionBoundary: "restrict_only";
  readonly approvalBoundary: "cannot_bypass";
  readonly toolGrantBoundary: "cannot_grant";
  readonly credentialBoundary: "cannot_grant";
  readonly notes: readonly string[];
}

export interface AiCouncil {
  readonly id: string;
  readonly workspaceId: string;
  readonly source: AiCouncilSource;
  readonly templateId?: string;
  readonly displayName: string;
  readonly description: string;
  readonly routingPolicy: AiCouncilRoutingPolicy;
  readonly governanceProfile: AiCouncilGovernanceProfile;
  readonly status: AiCouncilStatus;
  readonly pinned: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AiCouncilMember {
  readonly councilId: string;
  readonly teammateId: string;
  readonly slotKey?: string;
  readonly label?: string;
  readonly position: number;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AiCouncilListResponse {
  readonly cwd: string;
  readonly councils: readonly AiCouncil[];
}

export interface AiCouncilResponse {
  readonly cwd: string;
  readonly council: AiCouncil;
}

export interface AiCouncilMemberListResponse {
  readonly cwd: string;
  readonly councilId: string;
  readonly members: readonly AiCouncilMember[];
}

export interface ReplaceAiCouncilMembersRequest {
  readonly members: readonly {
    readonly teammateId: string;
    readonly slotKey?: string;
    readonly label?: string;
    readonly position?: number;
    readonly enabled?: boolean;
  }[];
}

export interface ChannelCouncilPolicy {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly attachedCouncilIds: readonly string[];
  readonly preferredCouncilId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChannelCouncilPolicyResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly policy: ChannelCouncilPolicy;
}

export interface UpdateChannelCouncilPolicyRequest {
  readonly attachedCouncilIds?: readonly string[];
  readonly preferredCouncilId?: string | null;
}

export interface EffectiveChannelSpecialistSource {
  readonly kind: "direct" | "council";
  readonly councilId?: string;
  readonly councilDisplayName?: string;
  readonly slotKey?: string;
  readonly label?: string;
  readonly isDefault?: boolean;
}

export interface EffectiveChannelSpecialist {
  readonly teammateId: string;
  readonly teammate: AiTeammate;
  readonly sources: readonly EffectiveChannelSpecialistSource[];
  readonly isDefault: boolean;
}

export interface EffectiveChannelCouncilMember {
  readonly member: AiCouncilMember;
  readonly teammate?: AiTeammate;
  readonly enabled: boolean;
  readonly blockedReason?: string;
}

export interface EffectiveChannelCouncil {
  readonly council: AiCouncil;
  readonly members: readonly EffectiveChannelCouncilMember[];
}

export interface EffectiveChannelCouncilProjection {
  readonly channelId: string;
  readonly policy: ChannelCouncilPolicy;
  readonly councils: readonly EffectiveChannelCouncil[];
  readonly specialists: readonly EffectiveChannelSpecialist[];
}

export interface EffectiveChannelCouncilResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly effectiveCouncil: EffectiveChannelCouncilProjection;
}
