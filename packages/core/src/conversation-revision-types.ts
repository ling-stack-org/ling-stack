import { randomUUID } from "node:crypto";
import type { ChannelMention, ChannelMessageFileRef } from "./workspace-types.js";

export type ConversationRevisionSurfaceKind =
  | "normal_conversation"
  | "channel_root"
  | "channel_branch"
  | "topic_reply"
  | "teammate_direct";

export interface ConversationMessageRevisionContent {
  readonly body: string;
  readonly mentions: readonly ChannelMention[];
  readonly attachmentIds: readonly string[];
  readonly linkPreviewIds: readonly string[];
  readonly fileRefs: readonly ChannelMessageFileRef[];
}

export interface ConversationMessageRevision extends ConversationMessageRevisionContent {
  readonly id: string;
  readonly workspaceId: string;
  readonly surface: ConversationRevisionSurfaceKind;
  readonly ownerId: string;
  readonly laneId: string;
  readonly messageId: string;
  readonly revision: number;
  readonly supersedesRevisionId?: string;
  readonly sourceTurnId?: string;
  readonly sourceRunId?: string;
  readonly createdBy: "local-user";
  readonly createdAt: string;
}

export type ConversationReplacementStatus = "pending" | "started" | "failed";

export interface ConversationTurnSupersession {
  readonly id: string;
  readonly workspaceId: string;
  readonly surface: ConversationRevisionSurfaceKind;
  readonly ownerId: string;
  readonly laneId: string;
  readonly messageId: string;
  readonly supersededTurnId?: string;
  readonly supersededRunIds: readonly string[];
  readonly supersededResponseMessageIds: readonly string[];
  readonly replacementRevisionId: string;
  readonly replacementTurnId?: string;
  readonly reason: "latest_user_message_edited";
  readonly replacementStatus: ConversationReplacementStatus;
  readonly failureReason?: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CommitConversationMessageEditInput {
  readonly surface: ConversationRevisionSurfaceKind;
  readonly ownerId: string;
  readonly laneId: string;
  readonly messageId: string;
  readonly expectedRevision: number;
  readonly current: ConversationMessageRevisionContent;
  readonly replacement: ConversationMessageRevisionContent;
  readonly sourceTurnId?: string;
  readonly sourceRunId?: string;
  readonly supersededTurnId?: string;
  readonly supersededRunIds?: readonly string[];
  readonly supersededResponseMessageIds?: readonly string[];
  readonly idempotencyKey: string;
}

export interface CommitConversationMessageEditResult {
  readonly revision: ConversationMessageRevision;
  readonly supersession: ConversationTurnSupersession;
  readonly idempotentReplay: boolean;
}

export interface ListConversationMessageRevisionsOptions {
  readonly surface: ConversationRevisionSurfaceKind;
  readonly messageId: string;
}

export interface ListConversationTurnSupersessionsOptions {
  readonly surface?: ConversationRevisionSurfaceKind;
  readonly ownerId?: string;
  readonly laneId?: string;
  readonly messageId?: string;
  readonly replacementStatus?: ConversationReplacementStatus;
  readonly limit?: number;
}

export class ConversationMessageRevisionConflictError extends Error {
  readonly code = "message_revision_conflict";

  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`Conversation message revision conflict: expected ${expectedRevision}, actual ${actualRevision}.`);
    this.name = "ConversationMessageRevisionConflictError";
  }
}

export function createConversationMessageRevisionId(): string {
  return `cmrev_${randomUUID()}`;
}

export function createConversationTurnSupersessionId(): string {
  return `ctsup_${randomUUID()}`;
}
