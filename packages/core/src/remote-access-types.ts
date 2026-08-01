export const remoteConversationKinds = ["channel", "conversation", "teammate_direct"] as const;

export type RemoteConversationKind = (typeof remoteConversationKinds)[number];

export type RemoteCommandReceiptState = "full" | "tombstone";

export type RemoteCommandReceiptStatus = "pending" | "completed" | "failed";

export type RemoteCommandTerminalOutcome =
  | { readonly kind: "completed"; readonly result: Record<string, unknown> }
  | {
      readonly kind: "failed";
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly retryable: boolean;
      };
    };

/** Durable idempotency record for a command accepted from a paired device. */
export interface RemoteCommandReceipt {
  readonly commandId: string;
  readonly workspaceId: string;
  readonly deviceId: string;
  readonly commandType: string;
  readonly bodyHash: string;
  readonly receiptState: RemoteCommandReceiptState;
  readonly status: RemoteCommandReceiptStatus;
  readonly issuedAt: string;
  readonly retryUntil: string;
  readonly terminalOutcome?: RemoteCommandTerminalOutcome;
  readonly messageId?: string;
  readonly dispatchIntentId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly compactedAt?: string;
}

export interface RemoteConversationAuthorityContext {
  readonly sourceSurface: "mobile";
  readonly authorityCeiling: "conversation_comment";
  readonly allowAiReply: true;
  readonly allowToolCalls: false;
  readonly allowWorkflowAutoStart: false;
  readonly allowExecutionProposal: false;
}

export const REMOTE_CONVERSATION_AUTHORITY_CONTEXT: RemoteConversationAuthorityContext = {
  sourceSurface: "mobile",
  authorityCeiling: "conversation_comment",
  allowAiReply: true,
  allowToolCalls: false,
  allowWorkflowAutoStart: false,
  allowExecutionProposal: false,
};

export type RemoteDispatchIntentStatus = "pending" | "claimed" | "dispatched" | "failed";

/** Durable hand-off from the accepted user message to the bounded reply dispatcher. */
export interface RemoteDispatchIntent {
  readonly id: string;
  readonly commandId: string;
  readonly workspaceId: string;
  readonly conversationKind: RemoteConversationKind;
  readonly conversationId: string;
  readonly messageId: string;
  readonly authority: RemoteConversationAuthorityContext;
  readonly status: RemoteDispatchIntentStatus;
  readonly attemptCount: number;
  readonly availableAt: string;
  readonly claimedBy?: string;
  readonly claimExpiresAt?: string;
  readonly lastError?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dispatchedAt?: string;
}

export type RemoteProjectionOperation = "insert" | "update" | "delete";

/** Lightweight durable change record. Projection workers re-read authoritative state. */
export interface RemoteProjectionOutboxRecord {
  readonly activitySeq: number;
  readonly workspaceId: string;
  readonly conversationKind?: RemoteConversationKind;
  readonly conversationId?: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly operation: RemoteProjectionOperation;
  readonly affectsUnread: boolean;
  readonly occurredAt: string;
  readonly processedAt?: string;
}

export interface ListRemoteProjectionOutboxOptions {
  readonly workspaceId?: string;
  readonly conversationKind?: RemoteConversationKind;
  readonly conversationId?: string;
  readonly afterActivitySeq?: number;
  readonly unprocessedOnly?: boolean;
  readonly limit?: number;
}

export interface RemoteProjectionEntityVersionInput {
  readonly workspaceId: string;
  readonly conversationKind?: RemoteConversationKind;
  readonly conversationId?: string;
  readonly entityType: string;
  readonly entityId: string;
}

export interface RemoteProjectionEntityVersion {
  readonly revision: number;
  readonly activitySeq: number;
}

export interface RemoteConversationActivityInput {
  readonly workspaceId: string;
  readonly conversationKind: RemoteConversationKind;
  readonly conversationId: string;
}

export interface ConversationReadState {
  readonly workspaceId: string;
  readonly userId: string;
  readonly conversationKind: RemoteConversationKind;
  readonly conversationId: string;
  readonly readThroughActivitySeq: number;
  readonly activitySeq: number;
  readonly unreadCount: number;
  readonly mentioned: boolean;
  readonly updatedAt: string;
}

export interface CommitRemoteConversationSendInput {
  readonly workspaceId: string;
  readonly deviceId: string;
  readonly commandId: string;
  readonly bodyHash: string;
  readonly conversationKind: RemoteConversationKind;
  readonly conversationId: string;
  readonly body: string;
  readonly issuedAt: string;
  readonly retryUntil: string;
}

export interface CommitRemoteConversationSendResult {
  readonly receipt: RemoteCommandReceipt;
  readonly dispatchIntent: RemoteDispatchIntent;
  readonly messageId: string;
  readonly idempotentReplay: boolean;
}

export interface MarkConversationReadInput {
  readonly workspaceId: string;
  readonly userId: string;
  readonly conversationKind: RemoteConversationKind;
  readonly conversationId: string;
  readonly throughActivitySeq: number;
}

export interface ListRemoteDispatchIntentsOptions {
  readonly workspaceId?: string;
  readonly conversationKind?: RemoteConversationKind;
  readonly conversationId?: string;
  readonly statuses?: readonly RemoteDispatchIntentStatus[];
  readonly limit?: number;
}

export class RemoteCommandIdempotencyConflictError extends Error {
  readonly code = "idempotency_conflict";

  constructor(readonly commandId: string) {
    super(`Remote command idempotency conflict: ${commandId}`);
    this.name = "RemoteCommandIdempotencyConflictError";
  }
}

export class RemoteCommandRetryWindowExpiredError extends Error {
  readonly code = "command_retry_window_expired";

  constructor(readonly commandId: string) {
    super(`Remote command retry window expired: ${commandId}`);
    this.name = "RemoteCommandRetryWindowExpiredError";
  }
}

export class RemoteConversationNotFoundError extends Error {
  readonly code = "conversation_not_allowed";

  constructor(
    readonly conversationKind: RemoteConversationKind,
    readonly conversationId: string,
  ) {
    super(`Remote conversation not found: ${conversationKind}/${conversationId}`);
    this.name = "RemoteConversationNotFoundError";
  }
}
