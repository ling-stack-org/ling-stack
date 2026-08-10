import type { LingThread } from "./run-types.js";
import type { CreateConversationContextSnapshotInput } from "./conversation-context-store-types.js";

interface ConversationThreadTopologyBaseInput {
  readonly id?: string;
  readonly channelId: string;
  readonly title: string;
  readonly objective: string;
}

export type ResolveOrCreateConversationThreadInput =
  | (ConversationThreadTopologyBaseInput & {
      readonly surfaceKind: "channel_root";
    })
  | (ConversationThreadTopologyBaseInput & {
      readonly surfaceKind: "topic";
      readonly anchorItemId: string;
    })
  | (ConversationThreadTopologyBaseInput & {
      readonly surfaceKind: "branch";
      readonly parentThreadId: string;
      readonly parentTurnId: string;
      readonly forkedFromRunId?: string;
      readonly forkContextSnapshot: Omit<CreateConversationContextSnapshotInput, "threadId">;
    });

export interface ResolveOrCreateConversationThreadResult {
  readonly thread: LingThread;
  readonly created: boolean;
}
