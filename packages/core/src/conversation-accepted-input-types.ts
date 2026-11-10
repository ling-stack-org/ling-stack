import type { ConversationContextProjectionMetadata } from "@ling-stack/contracts";
import type { AppendConversationUserTurnInput, AppendConversationUserTurnResult } from "./conversation-turn-ingest-types.js";

/** Internal immutable acceptance evidence; deliberately distinct from a fork snapshot. */
export interface ConversationAcceptedInputSnapshot {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly use: "normal_conversation_accepted_input";
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly sourceItemId: string;
  readonly projection: ConversationContextProjectionMetadata;
  readonly payload: unknown;
  readonly createdAt: string;
  readonly fingerprint: string;
}

export interface AppendConversationAcceptedInput extends AppendConversationUserTurnInput {
  /** Explicit edit lineage only; ordinary sourceTurnId is not attachment reuse authority. */
  readonly replacementSourceTurnId?: string;
}

export type CaptureConversationAcceptedInput = (source: AppendConversationUserTurnResult) => {
  readonly projection: ConversationContextProjectionMetadata;
  readonly payload: unknown;
};

export interface AppendConversationAcceptedInputResult extends AppendConversationUserTurnResult {
  readonly acceptedSnapshot: ConversationAcceptedInputSnapshot;
}
