export const REMOTE_PROTOCOL_VERSION = 1 as const;

export const REMOTE_SIGNING_ALGORITHM = "ES256" as const;

export const REMOTE_SUPPORTED_PROTOCOL_VERSIONS = [REMOTE_PROTOCOL_VERSION] as const;

export const REMOTE_PROTOCOL_LIMITS = {
  maxFrameBytes: 256 * 1024,
  maxTextBodyBytes: 32 * 1024,
  maxIdentifierBytes: 256,
  maxDisplayNameBytes: 128,
  maxOriginBytes: 2 * 1024,
  maxSafeMessageBytes: 2 * 1024,
  maxResumeCursors: 32,
  maxChannelsPerSnapshot: 500,
  maxMessagesPerSnapshot: 1_000,
  maxPairingLifetimeMs: 5 * 60_000,
  maxCommandLifetimeMs: 60_000,
  maxClockSkewMs: 30_000,
} as const;

export const REMOTE_CAPABILITIES_V1 = [
  "channel.read",
  "channel.send_text",
  "channel_run_summary.read",
  "channel_approval_summary.read",
] as const;

export type RemoteCapabilityV1 = (typeof REMOTE_CAPABILITIES_V1)[number];

export const REMOTE_CLIENT_COMMAND_TYPES_V1 = [
  "session.ping",
  "stream.subscribe",
  "stream.unsubscribe",
  "stream.ack",
  "snapshot.request",
  "channel.list",
  "channel.open",
  "channel.send_text",
] as const;

export type RemoteClientCommandTypeV1 = (typeof REMOTE_CLIENT_COMMAND_TYPES_V1)[number];

export const REMOTE_LIFECYCLE_COMMAND_TYPES_V1 = [
  "session.ping",
  "stream.subscribe",
  "stream.unsubscribe",
  "snapshot.request",
  "channel.list",
  "channel.open",
  "channel.send_text",
] as const;

export type RemoteLifecycleCommandTypeV1 = (typeof REMOTE_LIFECYCLE_COMMAND_TYPES_V1)[number];

export const REMOTE_SERVER_EVENT_TYPES_V1 = [
  "session.ready",
  "workspace.summary",
  "channel.list_snapshot",
  "channel.snapshot",
  "transcript.delta",
  "run.summary",
  "approval.summary",
  "command.accepted",
  "command.completed",
  "command.failed",
  "stream.resync_required",
  "security.revoked",
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
  "idempotency_conflict",
  "workspace_not_allowed",
  "channel_not_allowed",
  "capability_not_allowed",
  "payload_too_large",
  "rate_limited",
  "resync_required",
  "pc_unavailable",
] as const;

export type RemoteErrorCodeV1 = (typeof REMOTE_ERROR_CODES_V1)[number];

/**
 * Minimal public JWK representation accepted by the V1 wire protocol.
 * Optional JWK metadata is deliberately excluded from signing/fingerprint input.
 */
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

export interface RemoteAccessPolicySummaryV1 {
  readonly version: 1;
  readonly workspaceId: string;
  readonly policyVersion: number;
  readonly channelAccess:
    | { readonly mode: "selected"; readonly channelIds: readonly string[] }
    | { readonly mode: "all_in_workspace" };
  readonly capabilities: readonly RemoteCapabilityV1[];
}

export interface RemoteMessageExecutionPolicyV1 {
  readonly sourceSurface: "mobile";
  readonly authorityCeiling: "channel_comment";
  readonly allowAiReply: true;
  readonly allowToolCalls: false;
  readonly allowWorkflowAutoStart: false;
  readonly allowExecutionProposal: false;
}

export interface RemoteWorkspaceSummaryV1 {
  readonly workspaceId: string;
  readonly displayName: string;
  readonly policyVersion: number;
}

export interface RemoteChannelSummaryV1 {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly name: string;
  readonly status: "active" | "paused" | "archived";
  readonly updatedAt: string;
}

export interface RemoteTranscriptMessageV1 {
  readonly messageId: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly kind: "message" | "ai_reply" | "system";
  readonly authorType: "local-user" | "ai-teammate" | "system";
  readonly body: string;
  readonly status: "pending" | "ready" | "blocked" | "failed";
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RemoteChannelListSnapshotV1 {
  readonly workspaceId: string;
  readonly channels: readonly RemoteChannelSummaryV1[];
  readonly generatedAt: string;
}

export interface RemoteChannelSnapshotV1 {
  readonly snapshotId: string;
  readonly barrierSeq: number;
  readonly workspace: RemoteWorkspaceSummaryV1;
  readonly channel: RemoteChannelSummaryV1;
  readonly messages: readonly RemoteTranscriptMessageV1[];
  readonly hasMore: boolean;
  readonly generatedAt: string;
}

export type RemoteTranscriptDeltaV1 =
  | {
      readonly workspaceId: string;
      readonly channelId: string;
      readonly operation: "upsert";
      readonly message: RemoteTranscriptMessageV1;
    }
  | {
      readonly workspaceId: string;
      readonly channelId: string;
      readonly operation: "remove";
      readonly messageId: string;
      readonly revision: number;
    };

export interface RemoteRunSummaryV1 {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly runId: string;
  readonly status: "queued" | "running" | "waiting_for_approval" | "succeeded" | "failed" | "cancelled";
  readonly operationLabel?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminalAt?: string;
  readonly errorCode?: string;
}

export interface RemoteApprovalSummaryV1 {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly approvalId: string;
  readonly status: "pending" | "approved" | "denied" | "expired" | "cancelled";
  readonly risk: "low" | "medium" | "high" | "critical";
  readonly title: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
}

export interface RemoteSessionPingCommandV1 {
  readonly commandId: string;
  readonly nonce: string;
}

export interface RemoteStreamSubscribeCommandV1 {
  readonly commandId: string;
  readonly workspaceId: string;
  readonly channelId: string;
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
  readonly workspaceId: string;
  readonly channelId: string;
}

export interface RemoteChannelListCommandV1 {
  readonly commandId: string;
  readonly workspaceId: string;
}

export interface RemoteChannelOpenCommandV1 {
  readonly commandId: string;
  readonly workspaceId: string;
  readonly channelId: string;
}

export interface RemoteSendTextCommandV1 {
  readonly commandId: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly body: string;
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
  readonly "channel.list": { readonly kind: "channel_list_requested" };
  readonly "channel.open": { readonly kind: "channel_opened"; readonly channelId: string };
  readonly "channel.send_text": { readonly kind: "message_created"; readonly messageId: string };
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
  readonly "channel.list": RemoteChannelListCommandV1;
  readonly "channel.open": RemoteChannelOpenCommandV1;
  readonly "channel.send_text": RemoteSendTextCommandV1;
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
  readonly "channel.list_snapshot": RemoteChannelListSnapshotV1;
  readonly "channel.snapshot": RemoteChannelSnapshotV1;
  readonly "transcript.delta": RemoteTranscriptDeltaV1;
  readonly "run.summary": RemoteRunSummaryV1;
  readonly "approval.summary": RemoteApprovalSummaryV1;
  readonly "command.accepted": RemoteCommandAcceptedV1;
  readonly "command.completed": RemoteCommandCompletedV1;
  readonly "command.failed": RemoteCommandFailedV1;
  readonly "stream.resync_required": RemoteStreamResyncRequiredV1;
  readonly "security.revoked": RemoteSecurityRevokedV1;
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
  authorityCeiling: "channel_comment",
  allowAiReply: true,
  allowToolCalls: false,
  allowWorkflowAutoStart: false,
  allowExecutionProposal: false,
};
