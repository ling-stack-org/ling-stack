import { randomUUID } from "node:crypto";
import type { RunTool } from "./approval-policy.js";

export const DEFAULT_WORKSPACE_ID = "workspace_default";

export type TaskStatus =
  | "todo"
  | "claimed"
  | "running"
  | "blocked"
  | "review"
  | "done"
  | "failed"
  | "cancelled";

export const taskStatuses: readonly TaskStatus[] = [
  "todo",
  "claimed",
  "running",
  "blocked",
  "review",
  "done",
  "failed",
  "cancelled",
];

export type ChannelStatus = "active" | "paused" | "archived";

export const channelStatuses: readonly ChannelStatus[] = ["active", "paused", "archived"];

export type ChannelExecutionMode = "serial" | "parallel";

export type ChannelWriteLockScope = "channel" | "boundPath" | "workspace";

export interface ChannelRuntimePolicy {
  readonly maxConcurrentRuns: number;
  readonly executionMode: ChannelExecutionMode;
  readonly writeLockScope: ChannelWriteLockScope;
  readonly allowReadOnlyParallel: boolean;
  readonly queueOnConflict: boolean;
}

export const defaultChannelRuntimePolicy: ChannelRuntimePolicy = {
  maxConcurrentRuns: 1,
  executionMode: "serial",
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
  readonly defaultProviderPresetId?: string;
  readonly defaultTeammateId?: string;
  readonly allowedTools: readonly RunTool[];
  readonly runtimePolicy: ChannelRuntimePolicy;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChannelInput {
  readonly name: string;
  readonly status?: ChannelStatus;
  readonly boundPath?: string;
  readonly defaultProviderPresetId?: string;
  readonly defaultTeammateId?: string;
  readonly allowedTools?: readonly RunTool[];
  readonly runtimePolicy?: Partial<ChannelRuntimePolicy>;
}

export interface ChannelUpdateInput {
  readonly name?: string;
  readonly status?: ChannelStatus;
  readonly boundPath?: string | null;
  readonly defaultProviderPresetId?: string | null;
  readonly defaultTeammateId?: string | null;
  readonly allowedTools?: readonly RunTool[];
  readonly runtimePolicy?: Partial<ChannelRuntimePolicy>;
}

export interface ListChannelsOptions {
  readonly limit?: number;
}

export interface Task {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly title: string;
  readonly prompt: string;
  readonly status: TaskStatus;
  readonly assigneeTeammateId?: string;
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
}

export interface TaskUpdateInput {
  readonly channelId?: string;
  readonly title?: string;
  readonly prompt?: string;
  readonly status?: TaskStatus;
  readonly assigneeTeammateId?: string | null;
  readonly currentRunId?: string | null;
}

export interface ListTasksOptions {
  readonly channelId?: string;
  readonly status?: TaskStatus;
  readonly limit?: number;
}

export type ChannelMessageKind = "message" | "ai_reply" | "system" | "task_link";

export type ChannelMessageIntent = "discuss" | "task";

export type ChannelMessageAuthorType = "local-user" | "ai-teammate" | "system";

export interface ChannelMention {
  readonly id: string;
  readonly label: string;
  readonly kind: "ai-teammate" | "local-user" | "channel";
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
  readonly linkedTaskId?: string;
  readonly linkedRunId?: string;
  readonly status: "ready" | "blocked" | "failed";
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChannelMessageInput {
  readonly channelId: string;
  readonly threadId?: string;
  readonly kind?: ChannelMessageKind;
  readonly intent?: ChannelMessageIntent;
  readonly authorType: ChannelMessageAuthorType;
  readonly authorId?: string;
  readonly body: string;
  readonly mentions?: readonly ChannelMention[];
  readonly attachmentIds?: readonly string[];
  readonly linkPreviewIds?: readonly string[];
  readonly linkedTaskId?: string;
  readonly linkedRunId?: string;
  readonly status?: ChannelMessage["status"];
  readonly errorMessage?: string;
}

export interface ListChannelMessagesOptions {
  readonly channelId: string;
  readonly threadId?: string;
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

export interface UpdateChannelDecisionInput {
  readonly title?: string;
  readonly decision?: string;
  readonly rationale?: string;
  readonly alternatives?: readonly string[];
  readonly status?: ChannelDecisionStatus;
}

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

export function createChannelId(): string {
  return `channel_${randomUUID()}`;
}

export function createTaskId(): string {
  return `task_${randomUUID()}`;
}

export function createChannelMessageId(): string {
  return `msg_${randomUUID()}`;
}

export function createChannelAttachmentId(): string {
  return `att_${randomUUID()}`;
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

export function createChannelContextSummaryId(): string {
  return `summary_${randomUUID()}`;
}

export function normalizeChannelRuntimePolicy(input: Partial<ChannelRuntimePolicy> | undefined): ChannelRuntimePolicy {
  return {
    ...defaultChannelRuntimePolicy,
    ...(input ?? {}),
  };
}
