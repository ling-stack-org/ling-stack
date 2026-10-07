import type { ConversationContextProjectionMetadata } from "@ling-stack/contracts";

export const conversationPreparedInputUses = {
  request: "normal_conversation_prepared_request",
  execution: "normal_conversation_prepared_execution",
} as const;
export type ConversationPreparedInputStage = keyof typeof conversationPreparedInputUses;

/** Internal immutable preparation evidence, not a Run or an execution grant. */
export interface ConversationPreparedInputSnapshot {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly stage: ConversationPreparedInputStage;
  readonly use: (typeof conversationPreparedInputUses)[ConversationPreparedInputStage];
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly sourceItemId: string;
  readonly acceptedSnapshotId: string;
  readonly acceptedFingerprint: string;
  readonly parentSnapshotId: string;
  readonly parentFingerprint: string;
  readonly projection: ConversationContextProjectionMetadata;
  /** Daemon owns the stage-specific credential-free DTO and validation. */
  readonly payload: unknown;
  readonly createdAt: string;
  readonly fingerprint: string;
}

export interface SaveConversationPreparedInput {
  readonly sourceItemId: string;
  readonly stage: ConversationPreparedInputStage;
  /** Request binds acceptance; execution binds the winning prepared request. */
  readonly parentSnapshotId: string;
  readonly parentFingerprint: string;
  readonly payload: unknown;
}

export interface SaveConversationPreparedInputResult {
  readonly snapshot: ConversationPreparedInputSnapshot;
  readonly idempotentReplay: boolean;
}
