import type { ConversationContextProjectionMetadata, ConversationItemV1 } from "@ling-stack/contracts";
import type { LingThread, LingTurn, RunSession } from "./run-types.js";

/** Immutable inherited context, never a child input or a provider session. */
export interface NormalConversationForkSeed {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly use: "normal_conversation_fork_seed";
  readonly workspaceId: string;
  readonly childThreadId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly sourceItemId: string;
  readonly sourceRunId?: string;
  readonly projection: ConversationContextProjectionMetadata;
  readonly payload: unknown;
  readonly createdAt: string;
  readonly fingerprint: string;
}

export interface CreateNormalConversationFork {
  readonly childThreadId: string;
  readonly parentThreadId: string;
  readonly parentTurnId: string;
  readonly sourceRunId?: string;
  readonly title: string;
  readonly objective: string;
}
export interface NormalConversationForkSource {
  readonly thread: LingThread;
  readonly turn: LingTurn;
  readonly item: Extract<ConversationItemV1, { kind: "user_message" }>;
  readonly run?: RunSession;
}
export type CaptureNormalConversationFork = (source: NormalConversationForkSource) => {
  readonly projection: ConversationContextProjectionMetadata;
  readonly payload: unknown;
};
export interface CreateNormalConversationForkResult {
  readonly thread: LingThread;
  readonly seed: NormalConversationForkSeed;
  readonly created: boolean;
}

/** Destructive source deletion must not invalidate a still-existing frozen branch. */
export class NormalConversationForkSourceInUseError extends Error {
  readonly code = "normal_fork_source_in_use";
  constructor() {
    super("This conversation is still a source of a frozen branch. Archive it, or delete its dependent branches first.");
    this.name = "NormalConversationForkSourceInUseError";
  }
}
