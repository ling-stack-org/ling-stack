export const REMOTE_PROTOCOL_VERSION = 1 as const;

export const REMOTE_SIGNING_ALGORITHM = "ES256" as const;

export const REMOTE_SUPPORTED_PROTOCOL_VERSIONS = [REMOTE_PROTOCOL_VERSION] as const;

export const REMOTE_PROTOCOL_LIMITS = {
  maxFrameBytes: 256 * 1024,
  maxTextBodyBytes: 32 * 1024,
  maxIdentifierBytes: 256,
  maxDisplayNameBytes: 320,
  maxOriginBytes: 2 * 1024,
  maxSafeMessageBytes: 2 * 1024,
  maxAvatarDataUrlBytes: 96 * 1024,
  maxResumeCursors: 32,
  maxConversationsPerSnapshot: 500,
  maxMessagesPerSnapshot: 1_000,
  maxPairingLifetimeMs: 5 * 60_000,
  maxCommandLifetimeMs: 60_000,
  maxCommandRetryWindowMs: 24 * 60 * 60_000,
  commandTombstoneRetentionMs: 7 * 24 * 60 * 60_000,
  maxClockSkewMs: 30_000,
} as const;

export const REMOTE_CONVERSATION_KINDS_V1 = [
  "channel",
  "conversation",
  "teammate_direct",
] as const;

export type RemoteConversationKindV1 = (typeof REMOTE_CONVERSATION_KINDS_V1)[number];

export const REMOTE_CAPABILITIES_V1 = [
  "conversation.read",
  "conversation.send_text",
  "conversation.mark_read",
  "profile.read",
  "profile.update",
  "security.unpair",
] as const;

export type RemoteCapabilityV1 = (typeof REMOTE_CAPABILITIES_V1)[number];

export const REMOTE_CLIENT_COMMAND_TYPES_V1 = [
  "session.ping",
  "stream.subscribe",
  "stream.unsubscribe",
  "stream.ack",
  "snapshot.request",
  "conversation.list",
  "conversation.open",
  "conversation.send_text",
  "conversation.mark_read",
  "profile.read",
  "profile.update",
  "security.unpair",
] as const;

export type RemoteClientCommandTypeV1 = (typeof REMOTE_CLIENT_COMMAND_TYPES_V1)[number];

export const REMOTE_LIFECYCLE_COMMAND_TYPES_V1 = [
  "session.ping",
  "stream.subscribe",
  "stream.unsubscribe",
  "snapshot.request",
  "conversation.list",
  "conversation.open",
  "conversation.send_text",
  "conversation.mark_read",
  "profile.read",
  "profile.update",
  "security.unpair",
] as const;

export type RemoteLifecycleCommandTypeV1 = (typeof REMOTE_LIFECYCLE_COMMAND_TYPES_V1)[number];

export const REMOTE_SERVER_EVENT_TYPES_V1 = [
  "session.ready",
  "workspace.summary",
  "conversation.list_snapshot",
  "conversation.snapshot",
  "conversation.delta",
  "profile.snapshot",
  "command.accepted",
  "command.completed",
  "command.failed",
  "stream.resync_required",
  "security.revoked",
  "workspace.binding_changed",
] as const;

export type RemoteServerEventTypeV1 = (typeof REMOTE_SERVER_EVENT_TYPES_V1)[number];

export const REMOTE_ERROR_CODES_V1 = [
  "pairing_closed",
  "pairing_expired",
  "pairing_consumed",
  "pairing_confirmation_required",
  "device_already_paired",
  "device_revoked",
  "device_epoch_mismatch",
  "challenge_expired",
  "challenge_replayed",
  "signature_invalid",
  "protocol_incompatible",
  "session_replaced",
  "sequence_invalid",
  "command_expired",
  "command_retry_window_expired",
  "idempotency_conflict",
  "workspace_not_allowed",
  "conversation_not_allowed",
  "conversation_busy",
  "capability_not_allowed",
  "profile_update_invalid",
  "payload_too_large",
  "rate_limited",
  "resync_required",
  "binding_changed",
  "pc_unavailable",
] as const;

export type RemoteErrorCodeV1 = (typeof REMOTE_ERROR_CODES_V1)[number];

/** Minimal public JWK accepted by the V1 wire protocol. */
export interface RemoteP256PublicJwkV1 {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
}

export interface RemoteGatewayIdentityV1 {
  readonly gatewayId: string;
  readonly algorithm: typeof REMOTE_SIGNING_ALGORITHM;
  readonly publicKeyJwk: RemoteP256PublicJwkV1;
  readonly publicKeyFingerprint: string;
}

export type RemoteMobilePlatformV1 = "ios" | "android";

export interface RemotePairingQrV1 {
  readonly kind: "ling_remote_pairing";
  readonly version: typeof REMOTE_PROTOCOL_VERSION;
  readonly gatewayId: string;
  readonly gatewayOrigin: string;
  readonly gatewayIdentityPublicKeyJwk: RemoteP256PublicJwkV1;
  readonly gatewayIdentityFingerprint: string;
  readonly pairingId: string;
  readonly pairingSecret: string;
  readonly expiresAt: string;
}

export interface RemotePairingChallengeV1 {
  readonly version: typeof REMOTE_PROTOCOL_VERSION;
  readonly gatewayId: string;
  readonly pairingId: string;
  readonly serverNonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly gatewaySignature: string;
}

export interface RemotePairingProofV1 {
  readonly version: typeof REMOTE_PROTOCOL_VERSION;
  readonly protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  readonly gatewayId: string;
  readonly pairingId: string;
  readonly deviceId: string;
  readonly displayName: string;
  readonly platform: RemoteMobilePlatformV1;
  readonly devicePublicKeyJwk: RemoteP256PublicJwkV1;
  readonly devicePublicKeyFingerprint: string;
  readonly serverNonce: string;
  readonly clientNonce: string;
  readonly pairingHmac: string;
  readonly deviceSignature: string;
}

export interface RemotePairingAcceptedV1 {
  readonly version: typeof REMOTE_PROTOCOL_VERSION;
  readonly gatewayId: string;
  readonly pairingId: string;
  readonly deviceId: string;
  readonly deviceEpoch: number;
  readonly protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  readonly pairedAt: string;
  readonly gatewaySignature: string;
}

export interface RemoteResumeCursorV1 {
  readonly streamId: string;
  readonly snapshotId: string;
  readonly lastAckServerSeq: number;
  readonly hasMaterializedSnapshot: true;
}

export interface RemoteAuthChallengeV1 {
  readonly version: typeof REMOTE_PROTOCOL_VERSION;
  readonly gatewayId: string;
  readonly challengeId: string;
  readonly serverNonce: string;
  readonly candidateSessionId: string;
  readonly deviceEpoch: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly supportedProtocolVersions: typeof REMOTE_SUPPORTED_PROTOCOL_VERSIONS;
  readonly gatewaySignature: string;
}

export interface RemoteAuthProofV1 {
  readonly version: typeof REMOTE_PROTOCOL_VERSION;
  readonly gatewayId: string;
  readonly challengeId: string;
  readonly candidateSessionId: string;
  readonly deviceId: string;
  readonly deviceEpoch: number;
  readonly clientNonce: string;
  readonly protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  readonly resume: readonly RemoteResumeCursorV1[];
  readonly signature: string;
}

export type RemoteConversationAccessV1 =
  | { readonly mode: "selected"; readonly conversationIds: readonly string[] }
  | { readonly mode: "all_in_workspace"; readonly kinds: readonly RemoteConversationKindV1[] };

export interface RemoteAccessPolicySummaryV1 {
  readonly version: 1;
  readonly workspaceId: string;
  readonly workspaceBindingId: string;
  readonly policyVersion: number;
  readonly conversationAccess: RemoteConversationAccessV1;
  readonly capabilities: readonly RemoteCapabilityV1[];
}

export interface RemoteMessageExecutionPolicyV1 {
  readonly sourceSurface: "mobile";
  readonly authorityCeiling: "conversation_comment";
  readonly allowAiReply: true;
  readonly allowToolCalls: false;
  readonly allowWorkflowAutoStart: false;
  readonly allowExecutionProposal: false;
}

export interface RemoteWorkspaceSummaryV1 {
  readonly workspaceId: string;
  readonly workspaceBindingId: string;
  readonly displayName: string;
  readonly policyVersion: number;
}

export interface RemoteConversationIdentityV1 {
  readonly kind: "channel" | "ling" | "teammate";
  readonly label: string;
  readonly subtitle?: string;
  readonly avatarDataUrl?: string;
}

export interface RemoteConversationSummaryV1 {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly kind: RemoteConversationKindV1;
  readonly title: string;
  readonly subtitle?: string;
  readonly identity: RemoteConversationIdentityV1;
  readonly status: "active" | "archived";
  readonly memberCount?: number;
  readonly latestPreview?: string;
  readonly latestMessageAt?: string;
  readonly activitySeq: number;
  readonly unreadCount: number;
  readonly mentioned: boolean;
  readonly updatedAt: string;
}

export interface RemoteConversationMessageV1 {
  readonly messageId: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly role: "local_user" | "assistant" | "teammate" | "system";
  readonly authorId?: string;
  readonly authorLabel: string;
  readonly authorAvatarDataUrl?: string;
  readonly body: string;
  readonly status: "pending" | "streaming" | "ready" | "blocked" | "failed";
  readonly revision: number;
  readonly activitySeq: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RemoteConversationReadStateV1 {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly readThroughActivitySeq: number;
  readonly unreadCount: number;
  readonly mentioned: boolean;
  readonly updatedAt: string;
}

export interface RemoteConversationListSnapshotV1 {
  readonly workspaceId: string;
  readonly workspaceBindingId: string;
  readonly conversations: readonly RemoteConversationSummaryV1[];
  readonly generatedAt: string;
}

export interface RemoteConversationSnapshotV1 {
  readonly snapshotId: string;
  readonly barrierSeq: number;
  readonly workspace: RemoteWorkspaceSummaryV1;
  readonly conversation: RemoteConversationSummaryV1;
  readonly readState: RemoteConversationReadStateV1;
  readonly messages: readonly RemoteConversationMessageV1[];
  readonly hasMoreOlder: boolean;
  readonly olderPageCursor?: string;
  readonly generatedAt: string;
}

export type RemoteConversationDeltaV1 =
  | { readonly operation: "conversation_upsert"; readonly conversation: RemoteConversationSummaryV1 }
  | {
      readonly operation: "conversation_remove";
      readonly workspaceId: string;
      readonly conversationId: string;
      readonly activitySeq: number;
    }
  | {
      readonly operation: "message_upsert";
      readonly workspaceId: string;
      readonly conversationId: string;
      readonly message: RemoteConversationMessageV1;
    }
  | {
      readonly operation: "message_remove";
      readonly workspaceId: string;
      readonly conversationId: string;
      readonly messageId: string;
      readonly revision: number;
      readonly activitySeq: number;
    }
  | { readonly operation: "read_state"; readonly readState: RemoteConversationReadStateV1 };

export interface RemoteUserProfileV1 {
  readonly workspaceId: string;
  readonly displayName: string;
  readonly handle?: string;
  readonly avatarDataUrl?: string;
  readonly revision: number;
  readonly updatedAt: string;
}

export type RemoteStreamScopeV1 =
  | { readonly kind: "workspace"; readonly workspaceId: string }
  | { readonly kind: "conversation"; readonly workspaceId: string; readonly conversationId: string };

export interface RemoteSessionPingCommandV1 {
  readonly commandId: string;
  readonly nonce: string;
}

export interface RemoteStreamSubscribeCommandV1 {
  readonly commandId: string;
  readonly scope: RemoteStreamScopeV1;
  readonly resume?: RemoteResumeCursorV1;
}

export interface RemoteStreamUnsubscribeCommandV1 {
  readonly commandId: string;
  readonly streamId: string;
}

export interface RemoteStreamAckV1 {
  readonly streamId: string;
  readonly ackServerSeq: number;
}

export interface RemoteSnapshotRequestCommandV1 {
  readonly commandId: string;
  readonly scope: RemoteStreamScopeV1;
}

export interface RemoteConversationListCommandV1 {
  readonly commandId: string;
  readonly workspaceId: string;
}

export interface RemoteConversationOpenCommandV1 {
  readonly commandId: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly olderPageCursor?: string;
}

export interface RemoteSendTextCommandV1 {
  readonly commandId: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly body: string;
  readonly issuedAt: string;
  readonly retryUntil: string;
}

export interface RemoteMarkConversationReadCommandV1 {
  readonly commandId: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly throughActivitySeq: number;
}

export interface RemoteProfileReadCommandV1 {
  readonly commandId: string;
  readonly workspaceId: string;
}

export interface RemoteProfileUpdateCommandV1 {
  readonly commandId: string;
  readonly workspaceId: string;
  readonly displayName?: string;
  readonly avatarDataUrl?: string | null;
}

export interface RemoteSecurityUnpairCommandV1 {
  readonly commandId: string;
}

export interface RemoteSessionReadyV1 {
  readonly deviceId: string;
  readonly protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  readonly policy: RemoteAccessPolicySummaryV1;
  readonly connectedAt: string;
}

export interface RemoteCommandAcceptedV1 {
  readonly commandId: string;
  readonly commandType: RemoteLifecycleCommandTypeV1;
  readonly acceptedAt: string;
}

export interface RemoteCommandResultMapV1 {
  readonly "session.ping": { readonly kind: "pong"; readonly nonce: string };
  readonly "stream.subscribe": { readonly kind: "subscribed"; readonly snapshotRequired: boolean };
  readonly "stream.unsubscribe": { readonly kind: "unsubscribed" };
  readonly "snapshot.request": { readonly kind: "snapshot_requested" };
  readonly "conversation.list": { readonly kind: "conversation_list_requested" };
  readonly "conversation.open": { readonly kind: "conversation_opened"; readonly conversationId: string };
  readonly "conversation.send_text": {
    readonly kind: "message_created";
    readonly conversationId: string;
    readonly messageId: string;
  };
  readonly "conversation.mark_read": {
    readonly kind: "conversation_marked_read";
    readonly conversationId: string;
    readonly readThroughActivitySeq: number;
  };
  readonly "profile.read": { readonly kind: "profile_read_requested" };
  readonly "profile.update": { readonly kind: "profile_updated"; readonly revision: number };
  readonly "security.unpair": { readonly kind: "device_unpaired" };
}

export type RemoteCommandResultV1 = RemoteCommandResultMapV1[RemoteLifecycleCommandTypeV1];

export type RemoteCommandCompletedV1 = {
  readonly [TType in RemoteLifecycleCommandTypeV1]: {
    readonly commandId: string;
    readonly commandType: TType;
    readonly result: RemoteCommandResultMapV1[TType];
    readonly completedAt: string;
  };
}[RemoteLifecycleCommandTypeV1];

export interface RemoteErrorV1 {
  readonly code: RemoteErrorCodeV1;
  readonly message: string;
  readonly retryable: boolean;
}

export type RemoteCommandFailedV1 = {
  readonly [TType in RemoteLifecycleCommandTypeV1]: {
    readonly commandId: string;
    readonly commandType: TType;
    readonly error: RemoteErrorV1;
    readonly failedAt: string;
  };
}[RemoteLifecycleCommandTypeV1];

export interface RemoteStreamResyncRequiredV1 {
  readonly reason: "cursor_missing" | "cursor_stale" | "sequence_gap" | "buffer_overflow" | "generation_changed";
  readonly requiredAt: string;
}

export interface RemoteSecurityRevokedV1 {
  readonly reason: "revoked" | "replaced" | "disabled" | "identity_reset";
  readonly revokedAt: string;
}

export interface RemoteWorkspaceBindingChangedV1 {
  readonly previousWorkspaceBindingId: string;
  readonly nextWorkspaceBindingId?: string;
  readonly changedAt: string;
}

export interface RemoteFrameBaseV1<TType extends string, TPayload> {
  readonly version: typeof REMOTE_PROTOCOL_VERSION;
  readonly type: TType;
  readonly messageId: string;
  readonly gatewayId: string;
  readonly sessionId: string;
  readonly sentAt: string;
  readonly requestId?: string;
  readonly payload: TPayload;
}

export interface RemoteClientCommandPayloadMapV1 {
  readonly "session.ping": RemoteSessionPingCommandV1;
  readonly "stream.subscribe": RemoteStreamSubscribeCommandV1;
  readonly "stream.unsubscribe": RemoteStreamUnsubscribeCommandV1;
  readonly "stream.ack": RemoteStreamAckV1;
  readonly "snapshot.request": RemoteSnapshotRequestCommandV1;
  readonly "conversation.list": RemoteConversationListCommandV1;
  readonly "conversation.open": RemoteConversationOpenCommandV1;
  readonly "conversation.send_text": RemoteSendTextCommandV1;
  readonly "conversation.mark_read": RemoteMarkConversationReadCommandV1;
  readonly "profile.read": RemoteProfileReadCommandV1;
  readonly "profile.update": RemoteProfileUpdateCommandV1;
  readonly "security.unpair": RemoteSecurityUnpairCommandV1;
}

export type RemoteClientCommandFrameV1<
  TType extends RemoteClientCommandTypeV1 = RemoteClientCommandTypeV1,
> = TType extends RemoteClientCommandTypeV1
  ? RemoteFrameBaseV1<TType, RemoteClientCommandPayloadMapV1[TType]> & {
      readonly clientSeq: number;
      readonly expiresAt: string;
    }
  : never;

export type RemoteClientFrameV1 = {
  readonly [TType in RemoteClientCommandTypeV1]: RemoteClientCommandFrameV1<TType>;
}[RemoteClientCommandTypeV1];

export interface RemoteServerEventPayloadMapV1 {
  readonly "session.ready": RemoteSessionReadyV1;
  readonly "workspace.summary": RemoteWorkspaceSummaryV1;
  readonly "conversation.list_snapshot": RemoteConversationListSnapshotV1;
  readonly "conversation.snapshot": RemoteConversationSnapshotV1;
  readonly "conversation.delta": RemoteConversationDeltaV1;
  readonly "profile.snapshot": RemoteUserProfileV1;
  readonly "command.accepted": RemoteCommandAcceptedV1;
  readonly "command.completed": RemoteCommandCompletedV1;
  readonly "command.failed": RemoteCommandFailedV1;
  readonly "stream.resync_required": RemoteStreamResyncRequiredV1;
  readonly "security.revoked": RemoteSecurityRevokedV1;
  readonly "workspace.binding_changed": RemoteWorkspaceBindingChangedV1;
}

export type RemoteServerEventFrameV1<
  TType extends RemoteServerEventTypeV1 = RemoteServerEventTypeV1,
> = TType extends RemoteServerEventTypeV1
  ? RemoteFrameBaseV1<TType, RemoteServerEventPayloadMapV1[TType]> & {
      readonly streamId: string;
      readonly eventId: string;
      readonly serverSeq: number;
      readonly occurredAt: string;
    }
  : never;

export type RemoteServerFrameV1 = {
  readonly [TType in RemoteServerEventTypeV1]: RemoteServerEventFrameV1<TType>;
}[RemoteServerEventTypeV1];

export type RemoteFrameV1 = RemoteClientFrameV1 | RemoteServerFrameV1;

export const DEFAULT_REMOTE_MESSAGE_EXECUTION_POLICY_V1: RemoteMessageExecutionPolicyV1 = {
  sourceSurface: "mobile",
  authorityCeiling: "conversation_comment",
  allowAiReply: true,
  allowToolCalls: false,
  allowWorkflowAutoStart: false,
  allowExecutionProposal: false,
};
