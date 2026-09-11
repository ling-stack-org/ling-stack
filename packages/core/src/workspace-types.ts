import { randomUUID } from "node:crypto";
import {
  SUPPORTED_LOCALES,
  type InterfaceLocale,
  type ResponseLanguagePreference as SharedResponseLanguagePreference,
  type SupportedLocale,
} from "@ling-stack/localization";
import type { RunTool } from "./approval-policy.js";
import type { ProcedureObservationStep, ProcedureObservationValidationStep } from "./procedure-observation-types.js";
import type { RunnerFallbackReason, RunnerRequestSource } from "./runtime-supervisor-types.js";
import type { AuthorizationMode, PermissionPreset, SessionPermissionMode, WorkspaceAccessMode } from "./session-permissions.js";
import type { SkillCandidateSourceRef } from "./skill-candidate-types.js";
import type { AiTeammateRoleKey, SkillApprovalProfile } from "./skill-types.js";
import type { WorkflowGraph, WorkflowTerminationPolicy } from "./workflow-graph-types.js";
import {
  channelIntentDecisionV2Actions,
  channelIntentDecisionV2CreatedByValues,
  channelIntentDecisionV2Statuses,
  type ChannelIntentClarificationV2,
  type ChannelIntentDecisionV2,
  type ChannelIntentDecisionV2Action,
  type ChannelIntentDecisionV2CreatedBy,
  type ChannelIntentDecisionV2Status,
  type ChannelIntentExecutionPlanV1,
  type ConversationContextProjectionMetadata,
  type RequiredParticipantManifestV1,
  type WorkflowParticipantAuthorityV1,
  type WorkflowParticipantProviderBindingV1,
  type WorkflowParticipantProviderBlockerV1,
} from "@ling-stack/contracts";

export const DEFAULT_WORKSPACE_ID = "workspace_default";

export type TaskStatus =
  | "todo"
  | "claimed"
  | "running"
  | "waiting_for_input"
  | "blocked"
  | "review"
  | "done"
  | "failed"
  | "cancelled";

export const taskStatuses: readonly TaskStatus[] = [
  "todo",
  "claimed",
  "running",
  "waiting_for_input",
  "blocked",
  "review",
  "done",
  "failed",
  "cancelled",
];

export type ChannelStatus = "active" | "paused" | "archived";

export const channelStatuses: readonly ChannelStatus[] = ["active", "paused", "archived"];

export type ChannelBranchStatus = "active" | "archived";

export const channelBranchStatuses: readonly ChannelBranchStatus[] = ["active", "archived"];

export type ChannelAutoReplyMode = "mentions_only" | "default_teammate" | "auto_route";

export const channelAutoReplyModes: readonly ChannelAutoReplyMode[] = ["mentions_only", "default_teammate", "auto_route"];

export type ResponseLanguage = SupportedLocale;

export const responseLanguages: readonly ResponseLanguage[] = SUPPORTED_LOCALES;

export type ResponseLanguagePreference = SharedResponseLanguagePreference;

export const responseLanguagePreferences: readonly ResponseLanguagePreference[] = ["follow_user", ...SUPPORTED_LOCALES];

export type LingConversationTone = "friendly" | "pragmatic" | "none";

export const lingConversationTones: readonly LingConversationTone[] = ["friendly", "pragmatic", "none"];

/** Provider-designated public reasoning summary verbosity; never raw chain-of-thought. */
export type ReasoningSummaryMode = "auto" | "concise" | "detailed" | "none";

export const reasoningSummaryModes: readonly ReasoningSummaryMode[] = ["auto", "concise", "detailed", "none"];

export const DEFAULT_LING_CONVERSATION_TONE: LingConversationTone = "pragmatic";

export type SkillGovernanceGenerationMode = "off" | "approval_only" | "semi_auto" | "auto_candidate";

export const skillGovernanceGenerationModes: readonly SkillGovernanceGenerationMode[] = [
  "off",
  "approval_only",
  "semi_auto",
  "auto_candidate",
];

export type SkillGovernanceRecordingMode = "disabled" | "user_initiated";

export const skillGovernanceRecordingModes: readonly SkillGovernanceRecordingMode[] = ["disabled", "user_initiated"];

export interface SkillGovernancePolicy {
  readonly generationMode: SkillGovernanceGenerationMode;
  readonly recordingMode: SkillGovernanceRecordingMode;
  readonly invocationMode: "explicit_only";
  readonly publishMode: "manual_review";
  readonly bindMode: "manual_review";
}

export const DEFAULT_SKILL_GOVERNANCE_POLICY: SkillGovernancePolicy = {
  generationMode: "semi_auto",
  recordingMode: "user_initiated",
  invocationMode: "explicit_only",
  publishMode: "manual_review",
  bindMode: "manual_review",
};

export type ChannelResponseLanguage = "workspace" | ResponseLanguagePreference;

export const channelResponseLanguages: readonly ChannelResponseLanguage[] = ["workspace", "follow_user", ...SUPPORTED_LOCALES];

export type ChannelWorkflowPreference = "manual" | "architect_engineer_qa";

export const channelWorkflowPreferences: readonly ChannelWorkflowPreference[] = ["manual", "architect_engineer_qa"];

export type ChannelProtocolSourceRefType =
  | "message"
  | "channel_decision"
  | "context_summary"
  | "task"
  | "run"
  | "workflow"
  | "workflow_step";

export interface ChannelProtocolSourceRef {
  readonly type: ChannelProtocolSourceRefType;
  readonly id: string;
  readonly label?: string;
}

export type ChannelProtocolDraftStatus = "draft" | "applied" | "cancelled" | "stale";

export const channelProtocolDraftStatuses: readonly ChannelProtocolDraftStatus[] = ["draft", "applied", "cancelled", "stale"];

export type ChannelProtocolDraftCreatedBy = "local-user" | "ai-draft";

export const channelProtocolDraftCreatedByValues: readonly ChannelProtocolDraftCreatedBy[] = ["local-user", "ai-draft"];

export interface ChannelCollaborationProtocolOverride {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly version: number;
  readonly defaultWorkflowPreference: ChannelWorkflowPreference;
  readonly visibleMultiReplyMaxParticipants: number;
  readonly privacyRules: readonly string[];
  readonly reviewRules: readonly string[];
  readonly sourceRefs: readonly ChannelProtocolSourceRef[];
  readonly updatedBy: ChannelProtocolDraftCreatedBy;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChannelCollaborationProtocolPatch {
  readonly responseLanguage?: ChannelResponseLanguage | null;
  readonly autoReplyMode?: ChannelAutoReplyMode | null;
  readonly defaultTeammateId?: string | null;
  readonly defaultWorkflowPreference?: ChannelWorkflowPreference;
  readonly visibleMultiReplyMaxParticipants?: number;
  readonly privacyRules?: readonly string[];
  readonly reviewRules?: readonly string[];
}

export interface ChannelCollaborationProtocolDraft {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly baseVersion?: number;
  readonly proposedPatch: ChannelCollaborationProtocolPatch;
  readonly reason: string;
  readonly createdBy: ChannelProtocolDraftCreatedBy;
  readonly sourceRefs: readonly ChannelProtocolSourceRef[];
  readonly status: ChannelProtocolDraftStatus;
  readonly appliedProtocolVersion?: number;
  readonly expiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChannelCollaborationProtocolDraftInput {
  readonly channelId: string;
  readonly baseVersion?: number;
  readonly proposedPatch: ChannelCollaborationProtocolPatch;
  readonly reason: string;
  readonly createdBy: ChannelProtocolDraftCreatedBy;
  readonly sourceRefs?: readonly ChannelProtocolSourceRef[];
  readonly expiresAt?: string;
}

export interface UpsertChannelCollaborationProtocolOverrideInput {
  readonly channelId: string;
  readonly defaultWorkflowPreference?: ChannelWorkflowPreference;
  readonly visibleMultiReplyMaxParticipants?: number;
  readonly privacyRules?: readonly string[];
  readonly reviewRules?: readonly string[];
  readonly sourceRefs?: readonly ChannelProtocolSourceRef[];
  readonly updatedBy: ChannelProtocolDraftCreatedBy;
}

export type ChannelPlaybookCandidateStatus = "draft" | "active" | "cancelled" | "stale";

export const channelPlaybookCandidateStatuses: readonly ChannelPlaybookCandidateStatus[] = ["draft", "active", "cancelled", "stale"];

export type ChannelPlaybookCandidateCreatedBy = "local-user" | "ai-draft";

export const channelPlaybookCandidateCreatedByValues: readonly ChannelPlaybookCandidateCreatedBy[] = ["local-user", "ai-draft"];

export interface ChannelPlaybookCandidate {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly title: string;
  readonly summary: string;
  readonly normalizedGoal: string;
  readonly procedureSteps: readonly ProcedureObservationStep[];
  readonly validationSteps: readonly ProcedureObservationValidationStep[];
  readonly positiveTriggers: readonly string[];
  readonly negativeTriggers: readonly string[];
  readonly sourceRefs: readonly SkillCandidateSourceRef[];
  readonly reason: string;
  readonly createdBy: ChannelPlaybookCandidateCreatedBy;
  readonly status: ChannelPlaybookCandidateStatus;
  readonly activatedAt?: string;
  readonly expiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChannelPlaybookCandidateInput {
  readonly channelId: string;
  readonly title: string;
  readonly summary: string;
  readonly normalizedGoal: string;
  readonly procedureSteps: readonly ProcedureObservationStep[];
  readonly validationSteps?: readonly ProcedureObservationValidationStep[];
  readonly positiveTriggers?: readonly string[];
  readonly negativeTriggers?: readonly string[];
  readonly sourceRefs?: readonly SkillCandidateSourceRef[];
  readonly reason: string;
  readonly createdBy: ChannelPlaybookCandidateCreatedBy;
  readonly expiresAt?: string;
}

export interface UpdateChannelPlaybookCandidateInput {
  readonly status?: ChannelPlaybookCandidateStatus;
  readonly activatedAt?: string | null;
}

export type ChannelSchedulingMode = "smart";

export type ChannelWriteLockScope = "channel" | "boundPath" | "workspace";

export type ChannelWorkspaceMode = "local" | "managed_worktree" | "external_path";

export type ChannelWorkspaceStatus = "ready" | "not_created" | "missing" | "unsupported" | "blocked";

export interface ChannelWorkspaceBinding {
  readonly mode: ChannelWorkspaceMode;
  readonly status: ChannelWorkspaceStatus;
  readonly executionPath?: string;
  readonly worktreePath?: string;
  readonly branchName?: string;
  readonly baseBranch?: string;
  readonly baseCommit?: string;
  readonly errorMessage?: string;
  readonly createdAt?: string;
  readonly checkedAt?: string;
  readonly updatedAt: string;
}

export interface ChannelWorkspaceSnapshot {
  readonly mode: ChannelWorkspaceMode;
  readonly status: ChannelWorkspaceStatus;
  readonly workspaceCwd: string;
  readonly executionCwd: string;
  readonly boundPath?: string;
  readonly worktreePath?: string;
  readonly branchName?: string;
  readonly baseBranch?: string;
  readonly baseCommit?: string;
  readonly checkedAt?: string;
}

export type DirectWorkspaceMode = ChannelWorkspaceMode;

export type DirectWorkspaceStatus = ChannelWorkspaceStatus;

export interface DirectWorkspaceBinding {
  readonly mode: DirectWorkspaceMode;
  readonly status: DirectWorkspaceStatus;
  readonly executionPath?: string;
  readonly worktreePath?: string;
  readonly branchName?: string;
  readonly baseBranch?: string;
  readonly baseCommit?: string;
  readonly errorMessage?: string;
  readonly createdAt?: string;
  readonly checkedAt?: string;
  readonly updatedAt: string;
}

export interface DirectWorkspaceSnapshot {
  readonly mode: DirectWorkspaceMode;
  readonly status: DirectWorkspaceStatus;
  readonly workspaceCwd: string;
  readonly executionCwd: string;
  readonly worktreePath?: string;
  readonly branchName?: string;
  readonly baseBranch?: string;
  readonly baseCommit?: string;
  readonly checkedAt?: string;
}

export function teammateDirectLinkPreviewNamespace(teammateId: string, threadId: string): string {
  return `teammate_direct:${teammateId}:${threadId}`;
}

export function resolveDirectExecutionCwd(thread: TeammateDirectThread, workspaceCwd: string): string {
  const binding = thread.workspaceBinding;
  if (binding?.mode === "managed_worktree" && binding.worktreePath) {
    return binding.worktreePath;
  }
  if (binding?.mode === "external_path" && binding.executionPath) {
    return binding.executionPath;
  }
  return workspaceCwd;
}

export function createDirectWorkspaceSnapshot(thread: TeammateDirectThread, workspaceCwd: string): DirectWorkspaceSnapshot {
  const binding = thread.workspaceBinding;
  const executionCwd = resolveDirectExecutionCwd(thread, workspaceCwd);
  return {
    mode: binding?.mode ?? "managed_worktree",
    status: binding?.status ?? "not_created",
    workspaceCwd,
    executionCwd,
    worktreePath: binding?.worktreePath,
    branchName: binding?.branchName,
    baseBranch: binding?.baseBranch,
    baseCommit: binding?.baseCommit,
    checkedAt: binding?.checkedAt,
  };
}

export interface ChannelRuntimePolicy {
  readonly maxConcurrentRuns: number;
  readonly schedulingMode: ChannelSchedulingMode;
  readonly writeLockScope: ChannelWriteLockScope;
  readonly allowReadOnlyParallel: boolean;
  readonly queueOnConflict: boolean;
}

export const defaultChannelRuntimePolicy: ChannelRuntimePolicy = {
  maxConcurrentRuns: 1,
  schedulingMode: "smart",
  writeLockScope: "boundPath",
  allowReadOnlyParallel: true,
  queueOnConflict: true,
};

export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly defaultProviderPresetId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Channel {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly status: ChannelStatus;
  readonly boundPath?: string;
  readonly workspaceBinding?: ChannelWorkspaceBinding;
  readonly defaultProviderPresetId?: string;
  readonly defaultTeammateId?: string;
  readonly autoReplyMode: ChannelAutoReplyMode;
  readonly responseLanguage?: ChannelResponseLanguage;
  readonly allowedTools: readonly RunTool[];
  readonly runtimePolicy: ChannelRuntimePolicy;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChannelBranch {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly name: string;
  readonly status: ChannelBranchStatus;
  readonly rootThreadId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt?: string;
  readonly deletedAt?: string;
}

export interface CreateChannelInput {
  /** Internal use: callers that must prepare external resources before persistence can preallocate the channel id. */
  readonly id?: string;
  readonly name: string;
  readonly status?: ChannelStatus;
  readonly boundPath?: string;
  readonly workspaceBinding?: ChannelWorkspaceBinding;
  readonly defaultProviderPresetId?: string;
  readonly defaultTeammateId?: string;
  readonly autoReplyMode?: ChannelAutoReplyMode;
  readonly responseLanguage?: ChannelResponseLanguage;
  readonly allowedTools?: readonly RunTool[];
  readonly runtimePolicy?: Partial<ChannelRuntimePolicy>;
}

export interface CreateChannelBranchInput {
  readonly id?: string;
  readonly channelId: string;
  readonly name: string;
  readonly status?: ChannelBranchStatus;
  readonly rootThreadId?: string;
  readonly archivedAt?: string;
  readonly deletedAt?: string;
}

export interface ChannelUpdateInput {
  readonly name?: string;
  readonly status?: ChannelStatus;
  readonly boundPath?: string | null;
  readonly workspaceBinding?: ChannelWorkspaceBinding | null;
  readonly defaultProviderPresetId?: string | null;
  readonly defaultTeammateId?: string | null;
  readonly autoReplyMode?: ChannelAutoReplyMode | null;
  readonly responseLanguage?: ChannelResponseLanguage | null;
  readonly allowedTools?: readonly RunTool[];
  readonly runtimePolicy?: Partial<ChannelRuntimePolicy>;
}

export interface ChannelBranchUpdateInput {
  readonly name?: string;
  readonly status?: ChannelBranchStatus;
  readonly rootThreadId?: string | null;
  readonly archivedAt?: string | null;
  readonly deletedAt?: string | null;
}

export interface ListChannelsOptions {
  readonly archived?: boolean;
  readonly defaultProviderPresetId?: string;
  readonly limit?: number;
}

export interface ListChannelBranchesOptions {
  readonly channelId?: string;
  readonly archived?: boolean;
  readonly status?: ChannelBranchStatus;
  readonly limit?: number;
}

export function resolveChannelExecutionCwd(channel: Channel, workspaceCwd: string): string {
  const binding = channel.workspaceBinding;
  if (binding?.mode === "managed_worktree" && binding.worktreePath) {
    return binding.worktreePath;
  }
  if (binding?.mode === "external_path" && binding.executionPath) {
    return binding.executionPath;
  }
  return channel.boundPath ?? workspaceCwd;
}

export function createChannelWorkspaceSnapshot(channel: Channel, workspaceCwd: string): ChannelWorkspaceSnapshot {
  const binding = channel.workspaceBinding;
  const executionCwd = resolveChannelExecutionCwd(channel, workspaceCwd);
  return {
    mode: binding?.mode ?? "local",
    status: binding?.status ?? "ready",
    workspaceCwd,
    executionCwd,
    boundPath: channel.boundPath,
    worktreePath: binding?.worktreePath,
    branchName: binding?.branchName,
    baseBranch: binding?.baseBranch,
    baseCommit: binding?.baseCommit,
    checkedAt: binding?.checkedAt,
  };
}

export interface WorkspaceSettings {
  readonly schemaVersion: 1;
  readonly workspaceCwd?: string;
  readonly theme?: "light" | "dark" | "system";
  readonly locale?: InterfaceLocale;
  readonly responseLanguage?: ResponseLanguagePreference;
  readonly lingConversationTone?: LingConversationTone;
  readonly defaultReasoningSummary?: ReasoningSummaryMode;
  readonly defaultProviderPresetId?: string;
  readonly mediaGenerationDefaults?: import("./media-generation-routing-types.js").WorkspaceMediaGenerationDefaults;
  readonly defaultAuthorizationMode?: AuthorizationMode;
  readonly defaultWorkspaceAccessMode?: WorkspaceAccessMode;
  readonly defaultPermissionMode?: SessionPermissionMode;
  readonly defaultPermissionPreset?: PermissionPreset;
  readonly channelNotifications?: Record<string, string>;
  readonly channelActivityViews?: Record<string, unknown>;
  readonly skillGovernancePolicy: SkillGovernancePolicy;
  readonly updatedAt: string;
}

export interface UpdateWorkspaceSettingsInput {
  readonly workspaceCwd?: string | null;
  readonly theme?: "light" | "dark" | "system" | null;
  readonly locale?: InterfaceLocale | null;
  readonly responseLanguage?: ResponseLanguagePreference | null;
  readonly lingConversationTone?: LingConversationTone | null;
  readonly defaultReasoningSummary?: ReasoningSummaryMode | null;
  readonly defaultProviderPresetId?: string | null;
  readonly mediaGenerationDefaults?: import("./media-generation-routing-types.js").WorkspaceMediaGenerationDefaults | null;
  readonly defaultAuthorizationMode?: AuthorizationMode | null;
  readonly defaultWorkspaceAccessMode?: WorkspaceAccessMode | null;
  readonly defaultPermissionMode?: SessionPermissionMode | null;
  readonly defaultPermissionPreset?: PermissionPreset | null;
  readonly channelNotifications?: Record<string, string> | null;
  readonly channelActivityViews?: Record<string, unknown> | null;
  readonly skillGovernancePolicy?: SkillGovernancePolicy | null;
}

export interface Task {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly title: string;
  readonly prompt: string;
  readonly status: TaskStatus;
  readonly assigneeTeammateId?: string;
  readonly requestedSkillId?: string;
  readonly attachmentIds: readonly string[];
  readonly currentRunId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateTaskInput {
  readonly channelId: string;
  readonly title: string;
  readonly prompt: string;
  readonly status?: TaskStatus;
  readonly assigneeTeammateId?: string;
  readonly requestedSkillId?: string;
  readonly attachmentIds?: readonly string[];
}

export interface TaskUpdateInput {
  readonly channelId?: string;
  readonly title?: string;
  readonly prompt?: string;
  readonly status?: TaskStatus;
  readonly assigneeTeammateId?: string | null;
  readonly requestedSkillId?: string | null;
  readonly attachmentIds?: readonly string[];
  readonly currentRunId?: string | null;
}

export interface ListTasksOptions {
  readonly channelId?: string;
  readonly assigneeTeammateId?: string;
  readonly status?: TaskStatus;
  readonly limit?: number;
}

export type AiTeammateStatus = "active" | "paused" | "disabled";

export const aiTeammateStatuses: readonly AiTeammateStatus[] = ["active", "paused", "disabled"];

export const LING_AGENT_ID = "ling_agent";

export type AiTeammateKind = "ai_teammate" | "system_teammate";
export type AiTeammateSystemRole = "ling_agent";
export type AiTeammateModelBindingMode = "workspace_default" | "fixed";
export type AiTeammateEditableField =
  | "displayName"
  | "description"
  | "avatarTone"
  | "avatarImageAttachmentId"
  | "appendSystemPrompt";

export const lingAgentEditableFields: readonly AiTeammateEditableField[] = [
  "displayName",
  "description",
  "avatarTone",
  "avatarImageAttachmentId",
  "appendSystemPrompt",
];

export const lingAgentAllowedTools: readonly RunTool[] = ["read", "grep", "find", "ls", "bash", "edit", "write"];

export const LING_AGENT_SYSTEM_PROMPT = [
  "You are Ling Agent, Ling Stack's built-in coordinator.",
  "You are the default visible agent for channels and private chat.",
  "Classify user messages as chat, executable work, continuation, approval response, or clarification.",
  "For executable work, prepare scoped task confirmation and use the existing workflow, run, approval, and evidence paths.",
  "Use specialist teammates when they are explicitly mentioned or materially improve the work, but do not require them for safe bounded work.",
  "Never self-grant tools, credentials, provider access, write scope, deployment authority, external-send authority, memory authority beyond protected defaults, or approval bypass.",
].join("\n");

export function isLingAgentTeammateId(teammateId: string | undefined): boolean {
  return teammateId === LING_AGENT_ID;
}

export function createLingAgentSystemTeammate(now: string, overrides: Partial<Pick<
  AiTeammate,
  "displayName" | "description" | "avatarTone" | "avatarImageAttachmentId" | "appendSystemPrompt"
>> = {}): AiTeammate {
  return {
    id: LING_AGENT_ID,
    workspaceId: DEFAULT_WORKSPACE_ID,
    templateId: LING_AGENT_ID,
    roleKey: "custom",
    displayName: overrides.displayName ?? "Ling Agent",
    description: overrides.description ?? "Built-in coordinator for channels, private chat, tasks, permissions, and specialist collaboration.",
    avatarTone: overrides.avatarTone ?? "violet",
    avatarImageAttachmentId: overrides.avatarImageAttachmentId,
    modelBindingMode: "workspace_default",
    systemPrompt: LING_AGENT_SYSTEM_PROMPT,
    appendSystemPrompt: overrides.appendSystemPrompt ?? [],
    allowedTools: lingAgentAllowedTools,
    approvalProfile: { mode: "standard", risk: "medium" },
    status: "active",
    pinned: true,
    hidden: false,
    kind: "system_teammate",
    systemRole: "ling_agent",
    protectedProfile: true,
    editableFields: lingAgentEditableFields,
    createdAt: now,
    updatedAt: now,
  };
}

export interface AiTeammate {
  readonly id: string;
  readonly workspaceId: string;
  readonly templateId?: string;
  readonly kind?: AiTeammateKind;
  readonly systemRole?: AiTeammateSystemRole;
  readonly protectedProfile?: boolean;
  readonly editableFields?: readonly AiTeammateEditableField[];
  readonly roleKey: AiTeammateRoleKey;
  readonly displayName: string;
  readonly description: string;
  readonly avatarTone?: string;
  readonly avatarImageAttachmentId?: string;
  readonly modelBindingMode: AiTeammateModelBindingMode;
  readonly providerPresetId?: string;
  readonly runnerId?: string;
  readonly systemPrompt?: string;
  readonly appendSystemPrompt: readonly string[];
  readonly allowedTools: readonly RunTool[];
  readonly approvalProfile: SkillApprovalProfile;
  readonly status: AiTeammateStatus;
  readonly pinned: boolean;
  readonly hidden: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateAiTeammateInput {
  readonly id?: string;
  readonly templateId?: string;
  readonly roleKey: AiTeammateRoleKey;
  readonly displayName: string;
  readonly description: string;
  readonly avatarTone?: string;
  readonly avatarImageAttachmentId?: string;
  readonly modelBindingMode?: AiTeammateModelBindingMode;
  readonly providerPresetId?: string;
  readonly runnerId?: string;
  readonly systemPrompt?: string;
  readonly appendSystemPrompt?: readonly string[];
  readonly allowedTools?: readonly RunTool[];
  readonly approvalProfile: SkillApprovalProfile;
  readonly status?: AiTeammateStatus;
  readonly pinned?: boolean;
  readonly hidden?: boolean;
}

export interface AiTeammateUpdateInput {
  readonly templateId?: string | null;
  readonly roleKey?: AiTeammateRoleKey;
  readonly displayName?: string;
  readonly description?: string;
  readonly avatarTone?: string | null;
  readonly avatarImageAttachmentId?: string | null;
  readonly modelBindingMode?: AiTeammateModelBindingMode;
  readonly providerPresetId?: string | null;
  readonly runnerId?: string | null;
  readonly systemPrompt?: string | null;
  readonly appendSystemPrompt?: readonly string[];
  readonly allowedTools?: readonly RunTool[];
  readonly approvalProfile?: SkillApprovalProfile;
  readonly status?: AiTeammateStatus;
  readonly pinned?: boolean;
  readonly hidden?: boolean;
}

export interface ListAiTeammatesOptions {
  readonly status?: AiTeammateStatus;
  readonly includeHidden?: boolean;
  readonly includeDisabled?: boolean;
  readonly providerPresetId?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export type AiCouncilStatus = "active" | "paused" | "archived";

export const aiCouncilStatuses: readonly AiCouncilStatus[] = ["active", "paused", "archived"];

export type AiCouncilSource = "builtin" | "template" | "user";

export const aiCouncilSources: readonly AiCouncilSource[] = ["builtin", "template", "user"];

export type AiCouncilRoutingMode = "advisory" | "handoff" | "parallel_review";

export const aiCouncilRoutingModes: readonly AiCouncilRoutingMode[] = ["advisory", "handoff", "parallel_review"];

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

export interface ListAiCouncilsOptions {
  readonly status?: AiCouncilStatus;
  readonly includeArchived?: boolean;
  readonly limit?: number;
}

export interface ReplaceAiCouncilMemberInput {
  readonly teammateId: string;
  readonly slotKey?: string;
  readonly label?: string;
  readonly position?: number;
  readonly enabled?: boolean;
}

export interface CreateAiCouncilRoutingPolicyInput {
  readonly defaultMode?: AiCouncilRoutingMode;
  readonly maxActiveMembers?: number;
  readonly notes?: readonly string[];
}

export interface CreateAiCouncilInput {
  readonly displayName: string;
  readonly description?: string;
  readonly routingPolicy?: CreateAiCouncilRoutingPolicyInput;
  readonly members?: readonly ReplaceAiCouncilMemberInput[];
  readonly pinned?: boolean;
}

export interface CloneAiCouncilInput {
  readonly displayName?: string;
  readonly description?: string;
  readonly pinned?: boolean;
}

export interface UpdateAiCouncilInput {
  readonly displayName?: string;
  readonly description?: string;
  readonly status?: AiCouncilStatus;
  readonly pinned?: boolean;
}

export interface ChannelCouncilPolicy {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly attachedCouncilIds: readonly string[];
  readonly preferredCouncilId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpsertChannelCouncilPolicyInput {
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

export type AiCouncilHealthSeverity = "info" | "warning" | "critical";

export type AiCouncilHealthFindingKind =
  | "council_not_active"
  | "council_empty"
  | "council_no_available_members"
  | "member_disabled"
  | "teammate_missing"
  | "teammate_not_active"
  | "teammate_hidden"
  | "system_teammate_excluded";

export interface AiCouncilHealthFinding {
  readonly id: string;
  readonly kind: AiCouncilHealthFindingKind;
  readonly severity: AiCouncilHealthSeverity;
  readonly councilId: string;
  readonly councilDisplayName: string;
  readonly teammateId?: string;
  readonly slotKey?: string;
  readonly label?: string;
  readonly title: string;
  readonly message: string;
}

export interface AiCouncilHealthSummary {
  readonly totalCouncils: number;
  readonly activeCouncils: number;
  readonly totalMembers: number;
  readonly availableMembers: number;
  readonly blockedMembers: number;
  readonly findings: Record<AiCouncilHealthSeverity, number>;
}

export interface AiCouncilHealthReport {
  readonly workspaceId: string;
  readonly generatedAt: string;
  readonly summary: AiCouncilHealthSummary;
  readonly findings: readonly AiCouncilHealthFinding[];
}

export interface AiCouncilHealthReportOptions {
  readonly limit?: number;
}

export function createAiCouncilId(): string {
  return `council_${randomUUID()}`;
}

export interface TeammateChannelMembership {
  readonly teammateId: string;
  readonly channelId: string;
  readonly isDefault: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReplaceTeammateChannelMembershipInput {
  readonly channelId: string;
  readonly isDefault?: boolean;
}

export type TeammateSkillBindingSource = "template" | "user";

export interface TeammateSkillBinding {
  readonly teammateId: string;
  readonly skillId: string;
  readonly source: TeammateSkillBindingSource;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReplaceTeammateSkillBindingInput {
  readonly skillId: string;
  readonly source?: TeammateSkillBindingSource;
  readonly enabled?: boolean;
}

export type TeammateMemoryScopeKind =
  | "channel-brief"
  | "channel-decisions"
  | "private-chat-summary"
  | "private-notes";

export const defaultPrivateTeammateMemoryScopeKinds: readonly TeammateMemoryScopeKind[] = [
  "private-chat-summary",
  "private-notes",
];

export const defaultChannelTeammateMemoryScopeKinds: readonly TeammateMemoryScopeKind[] = [
  "channel-brief",
  "channel-decisions",
];

export interface TeammateMemoryScope {
  readonly id: string;
  readonly teammateId: string;
  readonly kind: TeammateMemoryScopeKind;
  readonly channelId?: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReplaceTeammateMemoryScopeInput {
  readonly id?: string;
  readonly kind: TeammateMemoryScopeKind;
  readonly channelId?: string;
  readonly enabled?: boolean;
}

export interface TeammateDirectThread {
  readonly id: string;
  readonly workspaceId: string;
  readonly teammateId: string;
  readonly title: string;
  readonly workspaceBinding?: DirectWorkspaceBinding;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ListTeammateDirectThreadsOptions {
  readonly teammateId?: string;
  readonly limit?: number;
}

export type TeammateDirectMessageStatus = "pending" | "ready" | "blocked" | "failed" | "cancelled";

export type TeammateDirectMessageAuthorType = "local-user" | "ai-teammate" | "system";

export interface ConversationPendingReplacement {
  readonly supersessionId: string;
  readonly idempotencyKey: string;
  readonly failureReason?: string;
}

export interface TeammateDirectMessage {
  readonly id: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly teammateId: string;
  readonly authorType: TeammateDirectMessageAuthorType;
  readonly authorId?: string;
  readonly body: string;
  readonly attachmentIds: readonly string[];
  readonly linkPreviewIds: readonly string[];
  readonly fileRefs: readonly ChannelMessageFileRef[];
  readonly status: TeammateDirectMessageStatus;
  readonly errorMessage?: string;
  readonly linkedTaskId?: string;
  readonly linkedRunId?: string;
  readonly revision?: number;
  readonly editedAt?: string;
  readonly pendingReplacement?: ConversationPendingReplacement;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly webEvidence?: MessageWebEvidence;
}

export interface CreateTeammateDirectMessageInput {
  /** Server-owned callers may preallocate an id for durable dispatch idempotency. */
  readonly id?: string;
  readonly threadId: string;
  readonly teammateId: string;
  readonly authorType: TeammateDirectMessageAuthorType;
  readonly authorId?: string;
  readonly body: string;
  readonly attachmentIds?: readonly string[];
  readonly linkPreviewIds?: readonly string[];
  readonly fileRefs?: readonly ChannelMessageFileRef[];
  readonly status?: TeammateDirectMessageStatus;
  readonly errorMessage?: string;
  readonly linkedTaskId?: string;
  readonly linkedRunId?: string;
}

export interface ListTeammateDirectMessagesOptions {
  readonly teammateId: string;
  readonly threadId?: string;
  readonly beforeMessageId?: string;
  readonly limit?: number;
}

export interface TeammateDirectMessageListPage {
  readonly messages: readonly TeammateDirectMessage[];
  readonly hasMore: boolean;
  readonly nextBeforeMessageId?: string;
}

export interface TeammateDirectLinkPreview {
  readonly id: string;
  readonly workspaceId: string;
  readonly teammateId: string;
  readonly threadId: string;
  readonly messageId?: string;
  readonly url: string;
  readonly normalizedUrl: string;
  readonly title?: string;
  readonly description?: string;
  readonly imageUrl?: string;
  readonly siteName?: string;
  readonly status: ChannelLinkPreviewStatus;
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateTeammateDirectLinkPreviewInput {
  readonly teammateId: string;
  readonly threadId: string;
  readonly messageId?: string;
  readonly url: string;
  readonly normalizedUrl: string;
  readonly title?: string;
  readonly description?: string;
  readonly imageUrl?: string;
  readonly siteName?: string;
  readonly status: ChannelLinkPreviewStatus;
  readonly errorMessage?: string;
}

export interface UpdateTeammateDirectLinkPreviewInput {
  readonly title?: string | null;
  readonly description?: string | null;
  readonly imageUrl?: string | null;
  readonly siteName?: string | null;
  readonly status?: ChannelLinkPreviewStatus;
  readonly errorMessage?: string | null;
}

export interface ListTeammateDirectLinkPreviewsOptions {
  readonly teammateId: string;
  readonly threadId: string;
  readonly limit?: number;
}

export type TeammateDirectReplyInterventionMode = "queue_followup" | "interrupt_redirect";

export type TeammateDirectReplyInterventionStatus =
  | "queued"
  | "cancelling_source"
  | "starting_continuation"
  | "started"
  | "cancelled"
  | "failed";

export interface TeammateDirectReplyInterventionMessagePayload {
  readonly body: string;
  readonly attachmentIds: readonly string[];
  readonly linkPreviewIds: readonly string[];
  readonly fileRefs?: readonly ChannelMessageFileRef[];
}

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
  readonly messagePayload?: TeammateDirectReplyInterventionMessagePayload;
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

export interface CreateTeammateDirectReplyInterventionInput {
  readonly id?: string;
  readonly teammateId: string;
  readonly threadId: string;
  readonly sourceMessageId: string;
  readonly sourceWorkUnitId?: string;
  readonly mode: TeammateDirectReplyInterventionMode;
  readonly instruction: string;
  readonly messagePayload?: TeammateDirectReplyInterventionMessagePayload;
  readonly idempotencyKey: string;
  readonly requestedBy?: TeammateDirectReplyIntervention["requestedBy"];
}

export interface ListTeammateDirectReplyInterventionsOptions {
  readonly teammateId?: string;
  readonly threadId?: string;
  readonly sourceWorkUnitId?: string;
  readonly status?: TeammateDirectReplyInterventionStatus;
  readonly mode?: TeammateDirectReplyInterventionMode;
  readonly limit?: number;
}

export interface UpdateTeammateDirectReplyInterventionStatusInput {
  readonly interventionId: string;
  readonly status: TeammateDirectReplyInterventionStatus;
  readonly continuationMessageId?: string | null;
  readonly continuationWorkUnitId?: string | null;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
  readonly failureReason?: string | null;
  readonly now: string;
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

export interface CreateTeammatePrivateAttachmentInput {
  readonly teammateId: string;
  readonly threadId?: string;
  readonly messageId?: string;
  readonly scope: TeammatePrivateAttachmentScope;
  readonly kind: ChannelAttachmentKind;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly path: string;
  readonly createdAt?: string;
}

export interface ListTeammatePrivateAttachmentsOptions {
  readonly teammateId: string;
  readonly threadId?: string;
  readonly scope?: TeammatePrivateAttachmentScope;
  readonly limit?: number;
}

export interface UserProfile {
  readonly schemaVersion: 1;
  readonly displayName: string;
  readonly handle?: string;
  readonly avatarDataUrl?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpdateUserProfileInput {
  readonly displayName?: string;
  readonly handle?: string | null;
  readonly avatarDataUrl?: string | null;
}

export interface RetentionTombstone {
  readonly id: string;
  readonly workspaceId: string;
  readonly entityType: "ai-teammate" | "conversation-thread";
  readonly entityId: string;
  readonly reason?: string;
  readonly deletedCounts: Readonly<Record<string, number>>;
  readonly createdAt: string;
}

export interface HardDeleteAiTeammateInput {
  readonly reason?: string;
}

export interface HardDeleteAiTeammateResult {
  readonly tombstone: RetentionTombstone;
  readonly deletedAttachmentPaths: readonly string[];
}

export interface HardDeleteLingThreadInput {
  readonly reason?: string;
}

export interface HardDeleteLingThreadResult {
  readonly tombstone: RetentionTombstone;
  readonly deletedAttachmentPaths: readonly string[];
}

export type ChannelMessageKind = "message" | "ai_reply" | "system" | "task_link";

export type ChannelMessageIntent = "discuss" | "task";

export type ChannelMessageAuthorType = "local-user" | "ai-teammate" | "system";

export interface ChannelMention {
  readonly id: string;
  readonly label: string;
  readonly kind: "ai-teammate" | "local-user" | "channel";
}

export type ChannelMessageFileRefSource = "composer" | "explicit_text" | "api";

export interface ChannelMessageFileRef {
  readonly path: string;
  readonly label?: string;
  readonly source?: ChannelMessageFileRefSource;
  readonly line?: number;
}

export type MessageWebEvidenceStatus = "available" | "degraded" | "blocked";

export interface MessageWebEvidenceProvider {
  readonly adapterId: string;
  readonly providerPresetId: string;
  readonly displayName: string;
}

export interface MessageWebEvidenceSource {
  readonly url: string;
  readonly title?: string;
  readonly snippet?: string;
}

export interface MessageWebEvidenceReadUrl {
  readonly url: string;
  readonly status: "available" | "blocked";
  readonly finalUrl?: string;
  readonly title?: string;
  readonly reason?: string;
}

export interface MessageWebEvidence {
  readonly status: MessageWebEvidenceStatus;
  readonly query?: string;
  readonly queries?: readonly string[];
  readonly provider?: MessageWebEvidenceProvider;
  readonly reason?: string;
  readonly sources: readonly MessageWebEvidenceSource[];
  readonly readUrls: readonly MessageWebEvidenceReadUrl[];
  readonly updatedAt: string;
}

export interface ChannelMessage {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly kind: ChannelMessageKind;
  readonly intent: ChannelMessageIntent;
  readonly authorType: ChannelMessageAuthorType;
  readonly authorId?: string;
  readonly body: string;
  readonly mentions: readonly ChannelMention[];
  readonly attachmentIds: readonly string[];
  readonly linkPreviewIds: readonly string[];
  readonly fileRefs: readonly ChannelMessageFileRef[];
  readonly linkedTaskId?: string;
  readonly linkedRunId?: string;
  readonly status: "pending" | "ready" | "blocked" | "failed";
  readonly errorMessage?: string;
  readonly revision?: number;
  readonly editedAt?: string;
  readonly pendingReplacement?: ConversationPendingReplacement;
  readonly webEvidence?: MessageWebEvidence;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ChannelMessageRouteAction = "reply" | "no_reply";

export type ChannelMessageRouteDecisionStatus = "accepted" | "suppressed" | "failed";

export const channelMessageRouteDecisionStatuses: readonly ChannelMessageRouteDecisionStatus[] = ["accepted", "suppressed", "failed"];

export type ChannelMessageRouteDecisionCreatedBy = "explicit_mention" | "deterministic" | "model";

export const channelMessageRouteDecisionCreatedByValues: readonly ChannelMessageRouteDecisionCreatedBy[] = [
  "explicit_mention",
  "deterministic",
  "model",
];

export interface ChannelMessageRouteAlternative {
  readonly teammateId?: string;
  readonly label: string;
  readonly score?: number;
  readonly reason: string;
}

export interface ChannelMessageRouteContextPackMetadata {
  readonly schemaVersion: 1;
  readonly kind: string;
  readonly providerPresetId?: string;
  readonly modelId?: string;
  readonly sectionIds: readonly string[];
  readonly droppedSectionIds: readonly string[];
  readonly sourceRefCounts: Readonly<Record<string, number>>;
  readonly compactionIds: readonly string[];
  readonly contextProjection?: ConversationContextProjectionMetadata;
}

export interface ChannelMessageRouteDecision {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly sourceMessageId: string;
  readonly replyMessageId?: string;
  readonly mode: ChannelAutoReplyMode;
  readonly action: ChannelMessageRouteAction;
  readonly selectedTeammateId?: string;
  readonly selectedProviderPresetId?: string;
  readonly confidence?: number;
  readonly reason: string;
  readonly alternativesConsidered: readonly ChannelMessageRouteAlternative[];
  readonly contextPack?: ChannelMessageRouteContextPackMetadata;
  readonly status: ChannelMessageRouteDecisionStatus;
  readonly createdBy: ChannelMessageRouteDecisionCreatedBy;
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChannelMessageRouteDecisionInput {
  readonly channelId: string;
  readonly sourceMessageId: string;
  readonly replyMessageId?: string;
  readonly mode: ChannelAutoReplyMode;
  readonly action: ChannelMessageRouteAction;
  readonly selectedTeammateId?: string;
  readonly selectedProviderPresetId?: string;
  readonly confidence?: number;
  readonly reason: string;
  readonly alternativesConsidered?: readonly ChannelMessageRouteAlternative[];
  readonly contextPack?: ChannelMessageRouteContextPackMetadata;
  readonly status: ChannelMessageRouteDecisionStatus;
  readonly createdBy: ChannelMessageRouteDecisionCreatedBy;
  readonly errorMessage?: string;
}

export interface UpdateChannelMessageRouteDecisionInput {
  readonly replyMessageId?: string | null;
  readonly selectedProviderPresetId?: string | null;
  readonly confidence?: number | null;
  readonly reason?: string;
  readonly alternativesConsidered?: readonly ChannelMessageRouteAlternative[];
  readonly contextPack?: ChannelMessageRouteContextPackMetadata | null;
  readonly status?: ChannelMessageRouteDecisionStatus;
  readonly errorMessage?: string | null;
}

export interface ListChannelMessageRouteDecisionsOptions {
  readonly channelId?: string;
  readonly sourceMessageId?: string;
  readonly status?: ChannelMessageRouteDecisionStatus;
  readonly limit?: number;
}

export type ChannelIntentDecisionAction = ChannelIntentDecisionV2Action;
export const channelIntentDecisionActions: readonly ChannelIntentDecisionAction[] = channelIntentDecisionV2Actions;
export type ChannelIntentDecisionStatus = ChannelIntentDecisionV2Status;
export const channelIntentDecisionStatuses: readonly ChannelIntentDecisionStatus[] = channelIntentDecisionV2Statuses;
export type ChannelIntentDecisionCreatedBy = ChannelIntentDecisionV2CreatedBy;
export const channelIntentDecisionCreatedByValues: readonly ChannelIntentDecisionCreatedBy[] = channelIntentDecisionV2CreatedByValues;
export type ChannelIntentDecision = ChannelIntentDecisionV2;

export interface CreateChannelIntentDecisionInput {
  readonly channelId: string;
  readonly sourceItemId: string;
  readonly contextProjection: ConversationContextProjectionMetadata;
  readonly action: ChannelIntentDecisionAction;
  readonly selectedTeammateIds?: readonly string[];
  readonly participantManifest?: RequiredParticipantManifestV1;
  readonly proposalId?: string;
  readonly resultItemIds?: readonly string[];
  readonly workflowId?: string;
  readonly reason: string;
  readonly clarification?: ChannelIntentClarificationV2;
  readonly execution?: ChannelIntentExecutionPlanV1;
  readonly status: ChannelIntentDecisionStatus;
  readonly createdBy: ChannelIntentDecisionCreatedBy;
  readonly errorCode?: string;
}

export interface ListChannelIntentDecisionsOptions {
  readonly channelId?: string;
  readonly sourceItemId?: string;
  readonly action?: ChannelIntentDecisionAction;
  readonly status?: ChannelIntentDecisionStatus;
  readonly limit?: number;
}

export type ChannelExecutionProposalStatus = "draft" | "accepted" | "cancelled" | "superseded" | "blocked" | "run_failed";

export type ChannelExecutionProposalStepAction = "coordinated" | "consulted" | "reviewed" | "flagged_risk";

export type ChannelExecutionProposalStepSource = EffectiveChannelSpecialistSource;

export interface ChannelExecutionProposalStep {
  readonly teammateId: string;
  readonly action: ChannelExecutionProposalStepAction;
  readonly summary: string;
  readonly sources?: readonly ChannelExecutionProposalStepSource[];
}

export type ChannelRequirementShapingStatus =
  | "collecting_context"
  | "collecting_teammate_input"
  | "needs_user_clarification"
  | "ready_for_confirmation"
  | "converted_to_task"
  | "dismissed";

export type ChannelRequirementShapingClarificationAuthor = "local-user" | "ai-teammate" | "system";

export interface ChannelRequirementShapingClarification {
  readonly id: string;
  readonly authorType: ChannelRequirementShapingClarificationAuthor;
  readonly authorId?: string;
  readonly body: string;
  readonly sourceMessageId?: string;
  readonly createdAt: string;
}

export interface ChannelRequirementShaping {
  readonly status: ChannelRequirementShapingStatus;
  readonly summary?: string;
  readonly openQuestions: readonly string[];
  readonly clarifications: readonly ChannelRequirementShapingClarification[];
  readonly sourceRefs: readonly ChannelProtocolSourceRef[];
  readonly updatedAt?: string;
}

export interface ChannelExecutionProposal {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly sourceMessageId: string;
  readonly proposedByTeammateId: string;
  readonly title: string;
  readonly prompt: string;
  readonly assigneeTeammateId: string;
  readonly acceptanceCriteria: readonly string[];
  readonly collaborationSteps: readonly ChannelExecutionProposalStep[];
  readonly requiredTools: readonly ("read" | "grep" | "find" | "ls" | "bash" | "edit" | "write")[];
  readonly riskSummary?: string;
  readonly responseLanguage?: ResponseLanguagePreference;
  readonly shaping?: ChannelRequirementShaping;
  readonly status: ChannelExecutionProposalStatus;
  readonly linkedTaskId?: string;
  readonly linkedRunId?: string;
  readonly linkedWorkflowId?: string;
  readonly errorMessage?: string;
  readonly blocker?: WorkflowParticipantProviderBlockerV1;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChannelExecutionProposalInput {
  readonly channelId: string;
  readonly sourceMessageId: string;
  readonly proposedByTeammateId: string;
  readonly title: string;
  readonly prompt: string;
  readonly assigneeTeammateId: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly collaborationSteps?: readonly ChannelExecutionProposalStep[];
  readonly requiredTools?: readonly ChannelExecutionProposal["requiredTools"][number][];
  readonly riskSummary?: string;
  readonly responseLanguage?: ResponseLanguagePreference;
  readonly shaping?: ChannelRequirementShaping;
  readonly status?: ChannelExecutionProposalStatus;
  readonly linkedTaskId?: string;
  readonly linkedRunId?: string;
  readonly linkedWorkflowId?: string;
  readonly errorMessage?: string;
  readonly blocker?: WorkflowParticipantProviderBlockerV1;
}

export interface UpdateChannelExecutionProposalInput {
  readonly title?: string;
  readonly prompt?: string;
  readonly assigneeTeammateId?: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly collaborationSteps?: readonly ChannelExecutionProposalStep[];
  readonly requiredTools?: readonly ChannelExecutionProposal["requiredTools"][number][];
  readonly riskSummary?: string | null;
  readonly responseLanguage?: ResponseLanguagePreference | null;
  readonly shaping?: ChannelRequirementShaping | null;
  readonly status?: ChannelExecutionProposalStatus;
  readonly linkedTaskId?: string | null;
  readonly linkedRunId?: string | null;
  readonly linkedWorkflowId?: string | null;
  readonly errorMessage?: string | null;
  readonly blocker?: WorkflowParticipantProviderBlockerV1 | null;
}

export interface ListChannelExecutionProposalsOptions {
  readonly channelId: string;
  readonly sourceMessageId?: string;
  readonly status?: ChannelExecutionProposalStatus;
  readonly limit?: number;
}

export type ChannelAttachmentKind = "image" | "pdf" | "office" | "text";

export interface ChannelAttachment {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly messageId?: string;
  readonly kind: ChannelAttachmentKind;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly path: string;
  readonly createdAt: string;
}

export interface CreateChannelAttachmentInput {
  readonly channelId: string;
  readonly messageId?: string;
  readonly kind: ChannelAttachmentKind;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly path: string;
  readonly createdAt?: string;
}

export interface ListChannelAttachmentsOptions {
  readonly channelId: string;
  readonly limit?: number;
}

export interface ConversationAttachment {
  readonly id: string;
  readonly workspaceId: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly kind: ChannelAttachmentKind;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly path: string;
  readonly createdAt: string;
}

export interface CreateConversationAttachmentInput {
  readonly threadId?: string;
  readonly turnId?: string;
  readonly kind: ChannelAttachmentKind;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly path: string;
  readonly createdAt?: string;
}

export interface ListConversationAttachmentsOptions {
  readonly threadId?: string;
  readonly turnId?: string;
  readonly limit?: number;
}

export interface AssignConversationAttachmentInput {
  readonly attachmentId: string;
  readonly threadId: string;
  readonly turnId: string;
}

export type ChannelLinkPreviewStatus = "ready" | "blocked" | "failed";

export interface ChannelLinkPreview {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly messageId?: string;
  readonly url: string;
  readonly normalizedUrl: string;
  readonly title?: string;
  readonly description?: string;
  readonly imageUrl?: string;
  readonly siteName?: string;
  readonly status: ChannelLinkPreviewStatus;
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChannelLinkPreviewInput {
  readonly channelId: string;
  readonly messageId?: string;
  readonly url: string;
  readonly normalizedUrl: string;
  readonly title?: string;
  readonly description?: string;
  readonly imageUrl?: string;
  readonly siteName?: string;
  readonly status: ChannelLinkPreviewStatus;
  readonly errorMessage?: string;
}

export interface UpdateChannelLinkPreviewInput {
  readonly title?: string | null;
  readonly description?: string | null;
  readonly imageUrl?: string | null;
  readonly siteName?: string | null;
  readonly status?: ChannelLinkPreviewStatus;
  readonly errorMessage?: string | null;
}

export interface ListChannelLinkPreviewsOptions {
  readonly channelId: string;
  readonly limit?: number;
}

export interface ChannelBrief {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly objective: string;
  readonly scope: string;
  readonly acceptanceCriteria: readonly string[];
  readonly openQuestions: readonly string[];
  readonly risks: readonly string[];
  readonly decisionIds: readonly string[];
  readonly attachmentIds: readonly string[];
  readonly linkPreviewIds: readonly string[];
  readonly updatedBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpdateChannelBriefInput {
  readonly objective: string;
  readonly scope: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly openQuestions?: readonly string[];
  readonly risks?: readonly string[];
  readonly decisionIds?: readonly string[];
  readonly attachmentIds?: readonly string[];
  readonly linkPreviewIds?: readonly string[];
  readonly updatedBy: string;
}

export type ChannelDecisionStatus = "active" | "superseded" | "rejected";

export const channelDecisionStatuses: readonly ChannelDecisionStatus[] = ["active", "superseded", "rejected"];

export interface ChannelDecision {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly sourceMessageId?: string;
  readonly sourceTaskId?: string;
  readonly sourceRunId?: string;
  readonly title: string;
  readonly decision: string;
  readonly rationale: string;
  readonly alternatives: readonly string[];
  readonly status: ChannelDecisionStatus;
  readonly supersedesDecisionId?: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChannelDecisionInput {
  readonly channelId: string;
  readonly sourceMessageId?: string;
  readonly sourceTaskId?: string;
  readonly sourceRunId?: string;
  readonly title: string;
  readonly decision: string;
  readonly rationale?: string;
  readonly alternatives?: readonly string[];
  readonly status?: ChannelDecisionStatus;
  readonly supersedesDecisionId?: string;
  readonly createdBy: string;
}

export type CreateSupersedingChannelDecisionInput = CreateChannelDecisionInput & {
  readonly supersedesDecisionId: string;
};

export interface CreateOrReuseSupersedingChannelDecisionResult {
  readonly decision: ChannelDecision;
  readonly reused: boolean;
}

export class ChannelDecisionSupersessionConflictError extends Error {
  readonly code = "decision_supersession_conflict";

  constructor(
    readonly supersededDecisionId: string,
    readonly successorDecisionId?: string,
  ) {
    super(successorDecisionId
      ? `Channel decision ${supersededDecisionId} already has a different successor: ${successorDecisionId}`
      : `Channel decision is not active and cannot be superseded: ${supersededDecisionId}`);
    this.name = "ChannelDecisionSupersessionConflictError";
  }
}

export class ChannelDecisionStatusConflictError extends Error {
  readonly code = "decision_status_conflict";

  constructor(
    readonly decisionId: string,
    readonly expectedStatus: ChannelDecisionStatus,
    readonly actualStatus: ChannelDecisionStatus,
  ) {
    super(`Channel decision ${decisionId} must be ${expectedStatus}, but is ${actualStatus}`);
    this.name = "ChannelDecisionStatusConflictError";
  }
}

export interface UpdateChannelDecisionInput {
  readonly title?: string;
  readonly decision?: string;
  readonly rationale?: string;
  readonly alternatives?: readonly string[];
  readonly status?: ChannelDecisionStatus;
}

export type RejectActiveChannelDecisionInput = Omit<UpdateChannelDecisionInput, "status">;

export interface ListChannelDecisionsOptions {
  readonly channelId: string;
  readonly status?: ChannelDecisionStatus;
  readonly limit?: number;
}

export type ChannelHandoffStatus = "proposed" | "accepted" | "declined" | "completed" | "cancelled";

export const channelHandoffStatuses: readonly ChannelHandoffStatus[] = [
  "proposed",
  "accepted",
  "declined",
  "completed",
  "cancelled",
];

export interface ChannelHandoff {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly sourceMessageId?: string;
  readonly sourceTaskId?: string;
  readonly sourceRunId?: string;
  readonly fromParticipantId: string;
  readonly fromParticipantLabel: string;
  readonly toParticipantId: string;
  readonly toParticipantLabel: string;
  readonly reason: string;
  readonly requiredInput: string;
  readonly expectedOutput: string;
  readonly status: ChannelHandoffStatus;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChannelHandoffInput {
  readonly channelId: string;
  readonly sourceMessageId?: string;
  readonly sourceTaskId?: string;
  readonly sourceRunId?: string;
  readonly fromParticipantId: string;
  readonly fromParticipantLabel: string;
  readonly toParticipantId: string;
  readonly toParticipantLabel: string;
  readonly reason: string;
  readonly requiredInput: string;
  readonly expectedOutput: string;
  readonly status?: ChannelHandoffStatus;
  readonly createdBy: string;
}

export interface UpdateChannelHandoffInput {
  readonly fromParticipantId?: string;
  readonly fromParticipantLabel?: string;
  readonly toParticipantId?: string;
  readonly toParticipantLabel?: string;
  readonly reason?: string;
  readonly requiredInput?: string;
  readonly expectedOutput?: string;
  readonly status?: ChannelHandoffStatus;
}

export interface ListChannelHandoffsOptions {
  readonly channelId: string;
  readonly status?: ChannelHandoffStatus;
  readonly limit?: number;
}

export type ChannelContextSummaryTargetType = "thread" | "task";
export type ChannelContextSummaryAuthorType = "local-user" | "ai-teammate" | "system";

export const channelContextSummaryTargetTypes: readonly ChannelContextSummaryTargetType[] = ["thread", "task"];
export const channelContextSummaryAuthorTypes: readonly ChannelContextSummaryAuthorType[] = [
  "local-user",
  "ai-teammate",
  "system",
];

export interface ChannelContextSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly targetType: ChannelContextSummaryTargetType;
  readonly targetId: string;
  readonly sourceMessageIds: readonly string[];
  readonly decisionIds: readonly string[];
  readonly summary: string;
  readonly acceptanceCriteria: readonly string[];
  readonly openQuestions: readonly string[];
  readonly authorType: ChannelContextSummaryAuthorType;
  readonly authorId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChannelContextSummaryInput {
  readonly channelId: string;
  readonly targetType: ChannelContextSummaryTargetType;
  readonly targetId: string;
  readonly sourceMessageIds?: readonly string[];
  readonly decisionIds?: readonly string[];
  readonly summary: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly openQuestions?: readonly string[];
  readonly authorType: ChannelContextSummaryAuthorType;
  readonly authorId?: string;
}

export interface UpdateChannelContextSummaryInput {
  readonly targetType?: ChannelContextSummaryTargetType;
  readonly targetId?: string;
  readonly sourceMessageIds?: readonly string[];
  readonly decisionIds?: readonly string[];
  readonly summary?: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly openQuestions?: readonly string[];
  readonly authorType?: ChannelContextSummaryAuthorType;
  readonly authorId?: string | null;
}

export interface ListChannelContextSummariesOptions {
  readonly channelId: string;
  readonly targetType?: ChannelContextSummaryTargetType;
  readonly targetId?: string;
  readonly limit?: number;
}

export type ChannelWorkflowStatus =
  | "draft"
  | "ready"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled";

export const channelWorkflowStatuses: readonly ChannelWorkflowStatus[] = [
  "draft",
  "ready",
  "running",
  "waiting_for_approval",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
];

export type ChannelWorkflowStepStatus =
  | "queued"
  | "claimed"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "blocked"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export const channelWorkflowStepStatuses: readonly ChannelWorkflowStepStatus[] = [
  "queued",
  "claimed",
  "running",
  "waiting_for_approval",
  "blocked",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
];

export type ChannelWorkflowStepStartMode = "create_task" | "create_and_run_task";

export type WorkflowStepFailurePolicy =
  | "block_for_user"
  | "fail_workflow"
  | "cancel_workflow"
  | "skip_if_optional";

export interface WorkflowStepPolicy {
  readonly onRunFailed: WorkflowStepFailurePolicy;
  readonly onRunCancelled: WorkflowStepFailurePolicy;
  readonly onApprovalDenied: WorkflowStepFailurePolicy;
  readonly retryable: boolean;
  readonly maxRetries?: number;
}

export interface WorkflowStepGate {
  readonly stage: "pre" | "post";
  readonly approvalProfile: SkillApprovalProfile;
  readonly title: string;
  readonly reason: string;
  readonly requiredForStatuses?: readonly ChannelWorkflowStepStatus[];
}

export type WorkflowFanInMode =
  | "summarize_outputs"
  | "compare_outputs"
  | "collect_checks"
  | "memory_candidates";

export interface WorkflowFanInPolicy {
  readonly mode: WorkflowFanInMode;
  readonly requireAllBranchesTerminal: boolean;
  readonly includeFailedBranches: boolean;
  readonly createSummaryArtifact: boolean;
  readonly createMemoryCandidates: boolean;
  readonly memoryCandidateScope: "run" | "task" | "channel";
  readonly maxInputArtifacts: number;
}

export interface RunnerResolutionAudit {
  readonly requestedRunnerId: string;
  readonly effectiveRunnerId: string;
  readonly requestSource?: RunnerRequestSource;
  readonly fallbackAllowed?: boolean;
  readonly fallbackReason?: RunnerFallbackReason;
}

export interface WorkflowStepOutputRef {
  readonly workflowStepId: string;
  readonly runId?: string;
  readonly status: ChannelWorkflowStepStatus;
  readonly resultSummary?: string;
  readonly outputArtifactId?: string;
  readonly artifactIds: readonly string[];
  readonly branchGroupId?: string;
}

export type WorkflowPacketSourceRefType =
  | "channel_message"
  | "conversation_item"
  | "channel_brief"
  | "channel_decision"
  | "context_summary"
  | "task"
  | "run"
  | "attempt"
  | "workflow"
  | "workflow_step"
  | "workflow_handoff_intent"
  | "workflow_selector_decision"
  | "execution_action"
  | "artifact"
  | "approval"
  | "memory";

export interface WorkflowPacketSourceRef {
  readonly type: WorkflowPacketSourceRefType;
  readonly id: string;
  readonly label?: string;
}

export interface WorkflowAgentContextStamp {
  readonly schemaVersion: 1;
  readonly sourceItemId: string;
  readonly consumerTeammateId?: string;
  readonly contextProjection: ConversationContextProjectionMetadata;
  readonly roleEvidenceRefs: readonly WorkflowPacketSourceRef[];
  readonly roleEvidenceFingerprint: string;
}

export type WorkflowFanInContextReviewStatus =
  | "accepted_current"
  | "rebased_metadata"
  | "rejected_stale"
  | "rejected_private_leak";

export interface WorkflowFanInContextReview {
  readonly dependencyWorkflowStepId: string;
  readonly status: WorkflowFanInContextReviewStatus;
  readonly consumedProjectionVersion?: string;
  readonly currentProjectionVersion?: string;
  readonly reason: string;
}

export type WorkflowHandoffIntentStatus =
  | "proposed"
  | "validated"
  | "accepted"
  | "declined"
  | "converted"
  | "failed";

export const workflowHandoffIntentStatuses: readonly WorkflowHandoffIntentStatus[] = [
  "proposed",
  "validated",
  "accepted",
  "declined",
  "converted",
  "failed",
];

export type WorkflowHandoffIntentCreatedBy = "local-user" | "ai-teammate" | "orchestrator";

export interface WorkflowHandoffValidation {
  readonly targetTeammateExists: boolean;
  readonly targetTeammateActive: boolean;
  readonly skillExecutable: boolean;
  readonly providerRunnable: boolean;
  readonly approvalProfileCompatible: boolean;
  readonly resourceLeaseAvailable: boolean;
  readonly blockers: readonly string[];
}

export interface WorkflowHandoffIntent {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly workflowId?: string;
  readonly sourceWorkflowStepId?: string;
  readonly sourceRunId?: string;
  readonly sourceMessageId?: string;
  readonly channelHandoffId?: string;
  readonly fromParticipantId: string;
  readonly fromParticipantLabel: string;
  readonly toParticipantId: string;
  readonly toParticipantLabel?: string;
  readonly reason: string;
  readonly requiredInput: string;
  readonly expectedOutput: string;
  readonly riskSummary?: string;
  readonly sourceRefs: readonly WorkflowPacketSourceRef[];
  readonly agentContext?: WorkflowAgentContextStamp;
  readonly status: WorkflowHandoffIntentStatus;
  readonly validation?: WorkflowHandoffValidation;
  readonly createdBy: WorkflowHandoffIntentCreatedBy;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateWorkflowHandoffIntentInput {
  readonly channelId: string;
  readonly workflowId?: string;
  readonly sourceWorkflowStepId?: string;
  readonly sourceRunId?: string;
  readonly sourceMessageId?: string;
  readonly channelHandoffId?: string;
  readonly fromParticipantId: string;
  readonly fromParticipantLabel: string;
  readonly toParticipantId: string;
  readonly toParticipantLabel?: string;
  readonly reason: string;
  readonly requiredInput: string;
  readonly expectedOutput: string;
  readonly riskSummary?: string;
  readonly sourceRefs?: readonly WorkflowPacketSourceRef[];
  /** Internal-only continuity stamp derived by the daemon from the source step. */
  readonly agentContext?: WorkflowAgentContextStamp;
  readonly status?: WorkflowHandoffIntentStatus;
  readonly validation?: WorkflowHandoffValidation;
  readonly createdBy: WorkflowHandoffIntentCreatedBy;
}

export interface UpdateWorkflowHandoffIntentInput {
  readonly channelHandoffId?: string | null;
  readonly toParticipantLabel?: string | null;
  readonly reason?: string;
  readonly requiredInput?: string;
  readonly expectedOutput?: string;
  readonly riskSummary?: string | null;
  readonly sourceRefs?: readonly WorkflowPacketSourceRef[];
  /** Internal-only refreshed continuity stamp. Public PATCH routes must not accept this field. */
  readonly agentContext?: WorkflowAgentContextStamp | null;
  readonly status?: WorkflowHandoffIntentStatus;
  readonly validation?: WorkflowHandoffValidation | null;
}

export interface ListWorkflowHandoffIntentsOptions {
  readonly channelId?: string;
  readonly workflowId?: string;
  readonly channelHandoffId?: string;
  readonly sourceWorkflowStepId?: string;
  readonly sourceRunId?: string;
  readonly status?: WorkflowHandoffIntentStatus;
  readonly limit?: number;
}

export type WorkflowSelectorDecisionStatus =
  | "proposed"
  | "accepted"
  | "rejected"
  | "blocked"
  | "superseded";

export const workflowSelectorDecisionStatuses: readonly WorkflowSelectorDecisionStatus[] = [
  "proposed",
  "accepted",
  "rejected",
  "blocked",
  "superseded",
];

export type WorkflowSelectorTargetKind =
  | "workflow_step"
  | "graph_node"
  | "teammate"
  | "skill"
  | "handoff"
  | "wait";

export const workflowSelectorTargetKinds: readonly WorkflowSelectorTargetKind[] = [
  "workflow_step",
  "graph_node",
  "teammate",
  "skill",
  "handoff",
  "wait",
];

export type WorkflowSelectorDecisionCreatedBy = "deterministic" | "model" | "local-user";

export interface WorkflowSelectorAlternative {
  readonly targetKind: WorkflowSelectorTargetKind;
  readonly targetId: string;
  readonly label: string;
  readonly reason: string;
}

export interface WorkflowSelectorDecision {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly workflowId: string;
  readonly sourceWorkflowStepId?: string;
  readonly selectorNodeId?: string;
  readonly targetKind: WorkflowSelectorTargetKind;
  readonly selectedWorkflowStepId?: string;
  readonly selectedGraphNodeId?: string;
  readonly selectedTeammateId?: string;
  readonly selectedSkillId?: string;
  readonly selectedHandoffIntentId?: string;
  readonly reason: string;
  readonly alternativesConsidered: readonly WorkflowSelectorAlternative[];
  readonly confidence: "low" | "medium" | "high";
  readonly requiresUserConfirmation: boolean;
  readonly status: WorkflowSelectorDecisionStatus;
  readonly sourceRefs: readonly WorkflowPacketSourceRef[];
  readonly createdBy: WorkflowSelectorDecisionCreatedBy;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateWorkflowSelectorDecisionInput {
  readonly channelId: string;
  readonly workflowId: string;
  readonly sourceWorkflowStepId?: string;
  readonly selectorNodeId?: string;
  readonly targetKind: WorkflowSelectorTargetKind;
  readonly selectedWorkflowStepId?: string;
  readonly selectedGraphNodeId?: string;
  readonly selectedTeammateId?: string;
  readonly selectedSkillId?: string;
  readonly selectedHandoffIntentId?: string;
  readonly reason: string;
  readonly alternativesConsidered?: readonly WorkflowSelectorAlternative[];
  readonly confidence?: "low" | "medium" | "high";
  readonly requiresUserConfirmation?: boolean;
  readonly status?: WorkflowSelectorDecisionStatus;
  readonly sourceRefs?: readonly WorkflowPacketSourceRef[];
  readonly createdBy: WorkflowSelectorDecisionCreatedBy;
}

export interface UpdateWorkflowSelectorDecisionInput {
  readonly reason?: string;
  readonly alternativesConsidered?: readonly WorkflowSelectorAlternative[];
  readonly confidence?: "low" | "medium" | "high";
  readonly requiresUserConfirmation?: boolean;
  readonly status?: WorkflowSelectorDecisionStatus;
  readonly sourceRefs?: readonly WorkflowPacketSourceRef[];
}

export interface ListWorkflowSelectorDecisionsOptions {
  readonly channelId?: string;
  readonly workflowId?: string;
  readonly sourceWorkflowStepId?: string;
  readonly selectedWorkflowStepId?: string;
  readonly status?: WorkflowSelectorDecisionStatus;
  readonly limit?: number;
}

export interface ChannelWorkflowStepContextPacket {
  readonly schemaVersion: 1;
  readonly workflowId: string;
  readonly workflowStepId: string;
  readonly graphId?: string;
  readonly graphNodeId?: string;
  readonly teammateId?: string;
  readonly skillId?: string;
  readonly objective: string;
  readonly stepTitle: string;
  readonly stepPrompt: string;
  readonly dependencies: readonly WorkflowStepOutputRef[];
  readonly priorOutputArtifactIds: readonly string[];
  readonly sourceRefs?: readonly WorkflowPacketSourceRef[];
  readonly agentContext?: WorkflowAgentContextStamp;
  readonly selectorDecisionIds?: readonly string[];
  readonly handoffIntentIds?: readonly string[];
  readonly requestedRunnerId?: string;
  readonly effectiveRunnerId?: string;
  readonly providerPresetId?: string;
  readonly approvalGate?: SkillApprovalProfile;
  readonly contextPack?: WorkflowStepContextPackSnapshot;
  readonly generatedAt: string;
}

export interface WorkflowStepContextPackSnapshot {
  readonly kind: string;
  readonly providerPresetId?: string;
  readonly modelId?: string;
  readonly budget: {
    readonly mode: string;
    readonly contextWindowTokens: number;
    readonly reservedOutputTokens: number;
    readonly reservedRuntimeOverheadTokens: number;
    readonly inputBudgetTokens: number;
    readonly tokenizer?: string;
    readonly capabilitySource?: string;
    readonly capabilityConfidence?: string;
  };
  readonly estimatedInputTokens: number;
  readonly overBudget: boolean;
  readonly droppedSectionIds: readonly string[];
  readonly compactionIds: readonly string[];
  readonly sections: readonly {
    readonly id: string;
    readonly role: string;
    readonly priority: string;
    readonly compactionSurvival?: string;
    readonly estimatedTokens?: number;
    readonly sourceRefIds?: readonly string[];
    readonly metadata?: Record<string, unknown>;
  }[];
  readonly sourceRefs: readonly {
    readonly type: string;
    readonly id: string;
    readonly label?: string;
  }[];
  readonly contextProjection?: ConversationContextProjectionMetadata;
  readonly agentContext?: WorkflowAgentContextStamp;
}

export interface ChannelWorkflowStepOutputPacket {
  readonly schemaVersion: 1;
  readonly workflowId: string;
  readonly workflowStepId: string;
  readonly runId?: string;
  readonly graphId?: string;
  readonly graphNodeId?: string;
  readonly teammateId?: string;
  readonly skillId?: string;
  readonly status: ChannelWorkflowStepStatus;
  readonly resultSummary?: string;
  readonly artifactIds: readonly string[];
  readonly decisions?: readonly string[];
  readonly blockers?: readonly string[];
  readonly changedPaths?: readonly string[];
  readonly sourceRefs?: readonly WorkflowPacketSourceRef[];
  readonly agentContext?: WorkflowAgentContextStamp;
  readonly selectorDecisionIds?: readonly string[];
  readonly handoffIntentIds?: readonly string[];
  readonly runnerAudit?: RunnerResolutionAudit;
  readonly generatedAt: string;
}

export interface ChannelWorkflowStepMetadata {
  readonly participantAuthority?: WorkflowParticipantAuthorityV1;
  readonly providerBinding?: WorkflowParticipantProviderBindingV1;
  readonly workflowTemplateId?: string;
  readonly templateVersion?: string;
  readonly templateStepId?: string;
  readonly graphId?: string;
  readonly graphNodeId?: string;
  readonly dependsOnStepIds?: readonly string[];
  readonly branchGroupId?: string;
  readonly joinGroupId?: string;
  readonly dependencyMode?: "all_succeeded" | "all_terminal" | "any_succeeded";
  readonly maxParallelSiblings?: number;
  readonly teammateTemplateId?: string;
  readonly councilSlotKey?: string;
  readonly skillId?: string;
  readonly requestedRunnerId?: string;
  readonly effectiveRunnerId?: string;
  readonly providerPresetId?: string;
  readonly requiredTools?: readonly RunTool[];
  readonly executionPlan?: ChannelIntentExecutionPlanV1;
  readonly executionOperationIds?: readonly string[];
  readonly executionVerification?: WorkflowStepExecutionVerificationV1;
  readonly delegatedRequirement?: DelegatedStepRequirementV1;
  readonly delegatedOutcome?: DelegatedOutcomeV1;
  readonly delegatedOutcomeBasisFingerprint?: string;
  readonly autoStart?: boolean;
  readonly approvalGate?: SkillApprovalProfile;
  readonly preStepApprovalId?: string;
  readonly policy?: WorkflowStepPolicy;
  readonly gates?: readonly WorkflowStepGate[];
  readonly fanInPolicy?: WorkflowFanInPolicy;
  readonly activeGateStage?: "pre" | "post";
  readonly postStepApprovalId?: string;
  readonly contextArtifactId?: string;
  readonly outputArtifactId?: string;
  readonly outputArtifactIds?: readonly string[];
  readonly selectorDecisionIds?: readonly string[];
  readonly handoffIntentIds?: readonly string[];
  readonly sourceProposalId?: string;
  readonly sourceMessageId?: string;
  readonly proposalStepSources?: readonly ChannelExecutionProposalStepSource[];
  readonly fanInSummaryArtifactId?: string;
  readonly memoryCandidateIds?: readonly string[];
  readonly fanInContextReviews?: readonly WorkflowFanInContextReview[];
  readonly resultContextReview?: WorkflowFanInContextReview;
}

export interface ChannelWorkflowMetadata {
  readonly workflowGraphId?: string;
  readonly workflowGraphSchemaVersion?: number;
  readonly workflowGraphArtifactId?: string;
  readonly workflowGraph?: WorkflowGraph;
  readonly workflowGraphFingerprint?: string;
  readonly termination?: WorkflowTerminationPolicy;
  readonly maxParallelSteps?: number;
  readonly sourceProposalId?: string;
  readonly sourceMessageId?: string;
  readonly sourceTurnId?: string;
  readonly sourceIntentDecisionId?: string;
  readonly requiredParticipantManifest?: RequiredParticipantManifestV1;
  readonly completionGate?: WorkflowCompletionGateV1;
  readonly responseLanguage?: ResponseLanguagePreference;
}

export type DelegatedOutcomeV1 = import("@ling-stack/contracts").DelegatedOutcomeV1;
export type DelegatedStepRequirementV1 = import("@ling-stack/contracts").DelegatedStepRequirementV1;
export type WorkflowCompletionGateV1 = import("@ling-stack/contracts").WorkflowCompletionGateV1;

export type WorkflowStepExecutionVerificationStatusV1 = "pending" | "verified" | "blocked" | "failed";
export type WorkflowOperationVerificationStatusV1 = "succeeded" | "missing" | "failed" | "out_of_order";

export interface WorkflowOperationVerificationResultV1 {
  readonly operationId: string;
  readonly status: WorkflowOperationVerificationStatusV1;
  readonly evidenceActionIds: readonly string[];
  readonly reasonCode?: string;
}

export interface WorkflowStepExecutionVerificationV1 {
  readonly status: WorkflowStepExecutionVerificationStatusV1;
  readonly checkedAt: string;
  readonly operationResults: readonly WorkflowOperationVerificationResultV1[];
}

export interface ChannelWorkflow {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly sourceHandoffId?: string;
  readonly title: string;
  readonly objective: string;
  readonly status: ChannelWorkflowStatus;
  readonly createdBy: string;
  readonly metadata?: ChannelWorkflowMetadata;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChannelWorkflowInput {
  readonly channelId: string;
  readonly sourceHandoffId?: string;
  readonly title: string;
  readonly objective: string;
  readonly status?: ChannelWorkflowStatus;
  readonly createdBy: string;
  readonly metadata?: ChannelWorkflowMetadata;
}

export interface CreateOrReuseChannelHandoffWorkflowInput {
  readonly channelId: string;
  readonly sourceHandoffId: string;
  readonly workflow: Omit<CreateChannelWorkflowInput, "channelId" | "sourceHandoffId">;
  readonly workflowStep: Omit<CreateChannelWorkflowStepInput, "workflowId" | "sourceHandoffId">;
}

export interface CreateOrReuseChannelHandoffWorkflowResult {
  readonly workflow: ChannelWorkflow;
  readonly workflowStep: ChannelWorkflowStep;
  readonly reused: boolean;
}

export interface UpdateChannelWorkflowInput {
  readonly title?: string;
  readonly objective?: string;
  readonly status?: ChannelWorkflowStatus;
  readonly metadata?: ChannelWorkflowMetadata | null;
}

export interface ListChannelWorkflowsOptions {
  readonly channelId: string;
  readonly status?: ChannelWorkflowStatus;
  readonly limit?: number;
}

export interface ChannelWorkflowStep {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly workflowId: string;
  readonly sourceHandoffId?: string;
  readonly contextSummaryId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly position: number;
  readonly title: string;
  readonly prompt: string;
  readonly toParticipantId: string;
  readonly toParticipantLabel: string;
  readonly participantAuthority: WorkflowParticipantAuthorityV1;
  readonly status: ChannelWorkflowStepStatus;
  readonly blocker?: string;
  readonly resultSummary?: string;
  readonly metadata?: ChannelWorkflowStepMetadata;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChannelWorkflowStepInput {
  readonly workflowId: string;
  readonly sourceHandoffId?: string;
  readonly contextSummaryId?: string;
  readonly position?: number;
  readonly title: string;
  readonly prompt: string;
  readonly toParticipantId: string;
  readonly toParticipantLabel: string;
  readonly participantAuthority?: WorkflowParticipantAuthorityV1;
  readonly status?: ChannelWorkflowStepStatus;
  readonly metadata?: ChannelWorkflowStepMetadata;
}

export interface UpdateChannelWorkflowStepInput {
  readonly sourceHandoffId?: string | null;
  readonly contextSummaryId?: string | null;
  readonly taskId?: string | null;
  readonly runId?: string | null;
  readonly position?: number;
  readonly title?: string;
  readonly prompt?: string;
  readonly status?: ChannelWorkflowStepStatus;
  readonly blocker?: string | null;
  readonly resultSummary?: string | null;
  readonly metadata?: ChannelWorkflowStepMetadata | null;
}

export interface ListChannelWorkflowStepsOptions {
  readonly workflowId: string;
  readonly status?: ChannelWorkflowStepStatus;
  readonly limit?: number;
  /** Read the complete durable workflow-step history for canonical evidence paths. */
  readonly complete?: boolean;
}

export type CollaborationTaskCardMode =
  | "ready_for_confirmation"
  | "running"
  | "waiting"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type CollaborationExecutionMode = "serial" | "parallel" | "mixed";

export type CollaborationTaskStepState = "queued" | "active" | "waiting" | "blocked" | "done" | "failed" | "cancelled";

export interface CollaborationTaskCardStep {
  readonly id: string;
  readonly title: string;
  readonly ownerLabel: string;
  readonly state: CollaborationTaskStepState;
  readonly summary?: string;
  readonly branchGroupId?: string;
  readonly joinGroupId?: string;
  readonly updatedAt: string;
}

export interface CollaborationTaskBranch {
  readonly id: string;
  readonly label: string;
  readonly state: CollaborationTaskStepState;
  readonly summary?: string;
  readonly completedStepCount: number;
  readonly totalStepCount: number;
  readonly ownerLabels: readonly string[];
  readonly steps: readonly CollaborationTaskCardStep[];
}

export interface CollaborationTaskCardModel {
  readonly id: string;
  readonly workflowId: string;
  readonly title: string;
  readonly objective: string;
  readonly mode: CollaborationTaskCardMode;
  readonly executionMode: CollaborationExecutionMode;
  readonly currentOwnerLabel?: string;
  readonly blocker?: string;
  readonly nextAction?: string;
  readonly completedStepCount: number;
  readonly totalStepCount: number;
  readonly pendingApprovalCount: number;
  readonly steps: readonly CollaborationTaskCardStep[];
  readonly branches: readonly CollaborationTaskBranch[];
  readonly updatedAt: string;
}

export function createChannelId(): string {
  return `channel_${randomUUID()}`;
}

export function createChannelBranchId(): string {
  return `channel_branch_${randomUUID()}`;
}

export function createTaskId(): string {
  return `task_${randomUUID()}`;
}

export function createAiTeammateId(): string {
  return `teammate_${randomUUID()}`;
}

export function createBuiltinAiTeammateId(templateId: string): string {
  return `teammate_builtin_${templateId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

export function createTeammateMemoryScopeId(): string {
  return `memory_scope_${randomUUID()}`;
}

export function createTeammateDirectThreadId(): string {
  return `dm_thread_${randomUUID()}`;
}

export function createTeammateDirectMessageId(): string {
  return `dm_msg_${randomUUID()}`;
}

export function createTeammateDirectReplyInterventionId(): string {
  return `dm_int_${randomUUID()}`;
}

export function createTeammateDirectLinkPreviewId(): string {
  return `dm_link_${randomUUID()}`;
}

export function createChannelMessageRouteDecisionId(): string {
  return `route_${randomUUID()}`;
}

export function createChannelIntentDecisionId(): string {
  return `channel_intent_decision_${randomUUID()}`;
}

export function createChannelExecutionProposalId(): string {
  return `proposal_${randomUUID()}`;
}

export function createChannelAttachmentId(): string {
  return `att_${randomUUID()}`;
}

export function createConversationAttachmentId(): string {
  return `conv_att_${randomUUID()}`;
}

export function createTeammatePrivateAttachmentId(): string {
  return `patt_${randomUUID()}`;
}

export function createRetentionTombstoneId(): string {
  return `tombstone_${randomUUID().replaceAll("-", "")}`;
}

export function createChannelLinkPreviewId(): string {
  return `link_${randomUUID()}`;
}

export function createChannelBriefId(): string {
  return `brief_${randomUUID()}`;
}

export function createChannelDecisionId(): string {
  return `decision_${randomUUID()}`;
}

export function createChannelHandoffId(): string {
  return `handoff_${randomUUID()}`;
}

export function createWorkflowHandoffIntentId(): string {
  return `wf_handoff_intent_${randomUUID()}`;
}

export function createWorkflowSelectorDecisionId(): string {
  return `wf_selector_decision_${randomUUID()}`;
}

export function createChannelContextSummaryId(): string {
  return `summary_${randomUUID()}`;
}

export function createChannelCollaborationProtocolOverrideId(): string {
  return `channel_protocol_${randomUUID()}`;
}

export function createChannelCollaborationProtocolDraftId(): string {
  return `channel_protocol_draft_${randomUUID()}`;
}

export function createChannelPlaybookCandidateId(): string {
  return `channel_playbook_candidate_${randomUUID()}`;
}

export function createChannelWorkflowId(): string {
  return `workflow_${randomUUID()}`;
}

export function createChannelWorkflowStepId(): string {
  return `wfstep_${randomUUID()}`;
}

export function normalizeChannelRuntimePolicy(input: Partial<ChannelRuntimePolicy> | undefined): ChannelRuntimePolicy {
  return {
    ...defaultChannelRuntimePolicy,
    ...(input ?? {}),
  };
}
