import type { ReactNode } from "react";

export type ConversationSurface = "channel" | "teammate_direct" | "run_thread";

export type ConversationActorKind = "local_user" | "ai_teammate" | "coordinator" | "system";

export type ConversationItemKind =
  | "human_message"
  | "teammate_message"
  | "system_summary"
  | "run_summary"
  | "approval_summary"
  | "proposal"
  | "artifact_summary"
  | "deleted_reference";

export type ConversationStatus =
  | "ready"
  | "streaming"
  | "running"
  | "waiting_for_approval"
  | "blocked"
  | "failed"
  | "succeeded"
  | "cancelled"
  | "deleted";

export interface ConversationAction {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly disabled?: boolean;
  readonly danger?: boolean;
}

export interface ConversationAttachmentRef {
  readonly id: string;
  readonly label: string;
  readonly meta?: string;
}

export interface ConversationItem {
  readonly id: string;
  readonly surface: ConversationSurface;
  readonly kind: ConversationItemKind;
  readonly actorKind: ConversationActorKind;
  readonly actorId?: string;
  readonly actorName?: string;
  readonly channelId?: string;
  readonly teammateId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly threadId?: string;
  readonly title?: string;
  readonly body: string;
  readonly status: ConversationStatus;
  readonly createdAt: string;
  readonly attachments?: readonly ConversationAttachmentRef[];
  readonly actions?: readonly ConversationAction[];
}
