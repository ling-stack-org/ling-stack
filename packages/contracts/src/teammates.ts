import type { ToolName } from "./shared.js";
import type { SkillApprovalProfile } from "./approvals.js";
import type { ChannelAttachmentKind } from "./channels.js";
import type { McpToolDefaultApproval } from "./mcp.js";
import type { WorkUnit } from "./runtime.js";

export interface TeammatePersonaDraftRequest {
  readonly content: string;
  readonly sourcePath?: string;
}

export interface TeammatePersonaDraft {
  readonly teammateId: string;
  readonly sourceKind: "agents-md" | "persona-md" | "markdown";
  readonly sourcePath?: string;
  readonly displayName: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly appendSystemPrompt: readonly string[];
  readonly warnings: readonly string[];
}

export interface TeammatePersonaDraftResponse {
  readonly cwd: string;
  readonly teammateId: string;
  readonly draft: TeammatePersonaDraft;
}

export type AiTeammateRoleKey =
  | "product"
  | "architect"
  | "engineer"
  | "designer"
  | "qa"
  | "security"
  | "release"
  | "docs"
  | "custom";

export type AiTeammateStatus = "active" | "paused" | "disabled";

export interface AiTeammate {
  readonly id: string;
  readonly workspaceId: string;
  readonly templateId?: string;
  readonly roleKey: AiTeammateRoleKey;
  readonly displayName: string;
  readonly description: string;
  readonly avatarTone?: string;
  readonly avatarImageAttachmentId?: string;
  readonly providerPresetId?: string;
  readonly systemPrompt?: string;
  readonly appendSystemPrompt: readonly string[];
  readonly allowedTools: readonly ToolName[];
  readonly approvalProfile: SkillApprovalProfile;
  readonly status: AiTeammateStatus;
  readonly pinned: boolean;
  readonly hidden: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateAiTeammateRequest {
  readonly templateId?: string;
  readonly roleKey: AiTeammateRoleKey;
  readonly displayName: string;
  readonly description: string;
  readonly avatarTone?: string;
  readonly avatarImageAttachmentId?: string;
  readonly providerPresetId?: string;
  readonly systemPrompt?: string;
  readonly appendSystemPrompt?: readonly string[];
  readonly allowedTools?: readonly ToolName[];
  readonly approvalProfile: SkillApprovalProfile;
  readonly status?: AiTeammateStatus;
  readonly pinned?: boolean;
  readonly hidden?: boolean;
}

export interface UpdateAiTeammateRequest {
  readonly templateId?: string | null;
  readonly roleKey?: AiTeammateRoleKey;
  readonly displayName?: string;
  readonly description?: string;
  readonly avatarTone?: string | null;
  readonly avatarImageAttachmentId?: string | null;
  readonly providerPresetId?: string | null;
  readonly systemPrompt?: string | null;
  readonly appendSystemPrompt?: readonly string[];
  readonly allowedTools?: readonly ToolName[];
  readonly approvalProfile?: SkillApprovalProfile;
  readonly status?: AiTeammateStatus;
  readonly pinned?: boolean;
  readonly hidden?: boolean;
}

export interface AiTeammateListResponse {
  readonly cwd: string;
  readonly teammates: readonly AiTeammate[];
}

export interface AiTeammateMutationResponse {
  readonly teammate: AiTeammate;
}

export interface RetentionTombstone {
  readonly id: string;
  readonly workspaceId: string;
  readonly entityType: "ai-teammate";
  readonly entityId: string;
  readonly reason?: string;
  readonly deletedCounts: Readonly<Record<string, number>>;
  readonly createdAt: string;
}

export interface HardDeleteAiTeammateRequest {
  readonly reason?: string;
}

export interface HardDeleteAiTeammateResponse {
  readonly tombstone: RetentionTombstone;
}

export interface TeammateChannelMembership {
  readonly teammateId: string;
  readonly channelId: string;
  readonly isDefault: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReplaceTeammateChannelMembershipRequest {
  readonly memberships: readonly {
    readonly channelId: string;
    readonly isDefault?: boolean;
  }[];
}

export interface TeammateChannelMembershipListResponse {
  readonly cwd: string;
  readonly teammateId: string;
  readonly memberships: readonly TeammateChannelMembership[];
}

export type TeammateMcpBindingMode = "selected" | "all_current_tools";

export interface TeammateMcpBinding {
  readonly teammateId: string;
  readonly serverId: string;
  readonly mode: TeammateMcpBindingMode;
  readonly selectedToolNames: readonly string[];
  readonly approvalOverrides: Readonly<Record<string, McpToolDefaultApproval>>;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReplaceTeammateMcpBindingsRequest {
  readonly bindings: readonly {
    readonly serverId: string;
    readonly mode: TeammateMcpBindingMode;
    readonly selectedToolNames?: readonly string[];
    readonly approvalOverrides?: Readonly<Record<string, McpToolDefaultApproval>>;
    readonly enabled?: boolean;
  }[];
}

export interface TeammateMcpBindingListResponse {
  readonly cwd: string;
  readonly teammateId: string;
  readonly bindings: readonly TeammateMcpBinding[];
}

export type TeammateMemoryScopeKind = "channel-brief" | "channel-decisions" | "private-chat-summary" | "private-notes";

export interface TeammateMemoryScope {
  readonly id: string;
  readonly teammateId: string;
  readonly kind: TeammateMemoryScopeKind;
  readonly channelId?: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReplaceTeammateMemoryScopesRequest {
  readonly scopes: readonly {
    readonly id?: string;
    readonly kind: TeammateMemoryScopeKind;
    readonly channelId?: string;
    readonly enabled?: boolean;
  }[];
}

export interface TeammateMemoryScopeListResponse {
  readonly cwd: string;
  readonly teammateId: string;
  readonly scopes: readonly TeammateMemoryScope[];
}

export interface TeammateDirectThread {
  readonly id: string;
  readonly workspaceId: string;
  readonly teammateId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type TeammateDirectMessageAuthorType = "local-user" | "ai-teammate" | "system";

export type TeammateDirectMessageStatus = "pending" | "ready" | "blocked" | "failed" | "cancelled";

export interface TeammateDirectMessage {
  readonly id: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly teammateId: string;
  readonly authorType: TeammateDirectMessageAuthorType;
  readonly authorId?: string;
  readonly body: string;
  readonly attachmentIds: readonly string[];
  readonly status: TeammateDirectMessageStatus;
  readonly errorMessage?: string;
  readonly linkedTaskId?: string;
  readonly linkedRunId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateTeammateDirectMessageRequest {
  readonly body: string;
  readonly attachmentIds?: readonly string[];
  readonly requestAiReply?: boolean;
  readonly providerPresetId?: string;
}

export type TeammateDirectReplyInterventionMode = "queue_followup" | "interrupt_redirect";

export type TeammateDirectReplyInterventionStatus =
  | "queued"
  | "cancelling_source"
  | "starting_continuation"
  | "started"
  | "cancelled"
  | "failed";

export interface TeammateDirectReplyIntervention {
  readonly id: string;
  readonly workspaceId: string;
  readonly teammateId: string;
  readonly threadId: string;
  readonly sourceMessageId: string;
  readonly sourceWorkUnitId?: string;
  readonly mode: TeammateDirectReplyInterventionMode;
  readonly status: TeammateDirectReplyInterventionStatus;
  readonly instruction: string;
  readonly idempotencyKey: string;
  readonly requestedBy: "local-user" | "system";
  readonly continuationMessageId?: string;
  readonly continuationWorkUnitId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly failureReason?: string;
}

export interface CreateTeammateDirectReplyInterventionRequest {
  readonly mode: TeammateDirectReplyInterventionMode;
  readonly instruction: string;
  readonly idempotencyKey?: string;
}

export interface CancelTeammateDirectReplyRequest {
  readonly reason?: string;
}

export interface CancelTeammateDirectReplyInterventionRequest {
  readonly reason?: string;
}

export interface TeammateDirectRuntimeResponse {
  readonly cwd: string;
  readonly teammateId: string;
  readonly thread: TeammateDirectThread;
  readonly activeReply?: {
    readonly status: "running" | "cancelling";
    readonly workUnitId: string;
    readonly messageId: string;
    readonly sourceMessageId: string;
    readonly workUnit: WorkUnit;
    readonly message?: TeammateDirectMessage;
  };
  readonly interventions: readonly TeammateDirectReplyIntervention[];
}

export interface TeammateDirectInterventionListResponse {
  readonly cwd: string;
  readonly teammateId: string;
  readonly thread: TeammateDirectThread;
  readonly interventions: readonly TeammateDirectReplyIntervention[];
}

export interface TeammateDirectInterventionResponse {
  readonly cwd: string;
  readonly teammateId?: string;
  readonly intervention: TeammateDirectReplyIntervention;
  readonly runtime?: TeammateDirectRuntimeResponse;
}

export interface TeammateDirectReplyCancelResponse {
  readonly cwd: string;
  readonly workUnit: WorkUnit;
  readonly message?: TeammateDirectMessage;
}

export type TeammatePrivateAttachmentScope = "teammate_direct_thread" | "teammate_profile_avatar";

export interface TeammatePrivateAttachment {
  readonly id: string;
  readonly workspaceId: string;
  readonly teammateId: string;
  readonly threadId?: string;
  readonly messageId?: string;
  readonly scope: TeammatePrivateAttachmentScope;
  readonly kind: ChannelAttachmentKind;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly path: string;
  readonly createdAt: string;
}

export interface CreateTeammatePrivateAttachmentRequest {
  readonly fileName: string;
  readonly contentType?: string;
  readonly contentBase64: string;
  readonly scope?: TeammatePrivateAttachmentScope;
  readonly messageId?: string;
}

export interface TeammatePrivateAttachmentListResponse {
  readonly cwd: string;
  readonly teammateId: string;
  readonly thread: TeammateDirectThread;
  readonly attachments: readonly TeammatePrivateAttachment[];
}

export interface TeammatePrivateAttachmentMutationResponse {
  readonly attachment: TeammatePrivateAttachment;
}

export interface TeammateDirectMessageStreamReadyEvent {
  readonly message: TeammateDirectMessage;
  readonly aiReply: TeammateDirectMessage;
}

export interface TeammateDirectMessageStreamDeltaEvent {
  readonly messageId: string;
  readonly delta: string;
  readonly body: string;
}

export interface TeammateDirectMessageStreamDoneEvent {
  readonly message: TeammateDirectMessage;
  readonly aiReply: TeammateDirectMessage;
}

export interface TeammateDirectMessageStreamBlockedEvent {
  readonly message: TeammateDirectMessage;
  readonly aiReply: TeammateDirectMessage;
}

export interface TeammateDirectMessageStreamErrorEvent {
  readonly message?: TeammateDirectMessage;
  readonly aiReply?: TeammateDirectMessage;
  readonly error: string;
}

export interface TeammateDirectThreadResponse {
  readonly cwd: string;
  readonly teammateId: string;
  readonly thread: TeammateDirectThread;
}

export interface TeammateDirectMessageListResponse {
  readonly cwd: string;
  readonly teammateId: string;
  readonly thread: TeammateDirectThread;
  readonly messages: readonly TeammateDirectMessage[];
}

export interface TeammateDirectMessageMutationResponse {
  readonly message: TeammateDirectMessage;
  readonly aiReply?: TeammateDirectMessage;
}

export interface TeammateActivityItem {
  readonly id: string;
  readonly kind: "direct-message" | "task" | "run" | "approval" | "channel-message";
  readonly title: string;
  readonly subtitle?: string;
  readonly status?: string;
  readonly createdAt: string;
  readonly sourceId: string;
}

export interface TeammateActivityListResponse {
  readonly cwd: string;
  readonly teammateId: string;
  readonly items: readonly TeammateActivityItem[];
}
