import type { ConversationVisualization, ConversationVisualizationInput, RuntimeAttemptFenceV1 } from "@ling-stack/contracts";

export interface SavedConversationVisualization extends ConversationVisualization {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly messageId: string;
  readonly runId: string;
}

export interface SaveConversationVisualization {
  readonly runId: string;
  readonly fence: RuntimeAttemptFenceV1;
  readonly toolCallId: string;
  readonly document: ConversationVisualizationInput;
  readonly now: string;
}

export type SaveConversationVisualizationResult =
  | { readonly ok: true; readonly artifactId: string }
  | { readonly ok: false; readonly code: "visualization_invalid" | "visualization_owner_changed" | "visualization_conflict" | "visualization_limit" };
