import type { ConversationContextProjectionMetadata } from "@ling-stack/contracts";
import type { AppendConversationUserTurnInput, AppendConversationUserTurnResult } from "./conversation-turn-ingest-types.js";

/** Internal private input, never part of a public conversation detail. */
export interface TeammateDirectExecutionInput {
  readonly prompt: string;
  readonly systemPrompt: string;
}

export interface TeammateDirectInputSnapshot {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly use: "teammate_direct_execution_input";
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly sourceItemId: string;
  readonly teammateId: string;
  readonly projection: ConversationContextProjectionMetadata;
  readonly payload: TeammateDirectExecutionInput;
  readonly createdAt: string;
  readonly fingerprint: string;
}

export interface AppendTeammateDirectInput extends AppendConversationUserTurnInput {
  readonly teammateId: string;
  readonly executionInput: TeammateDirectExecutionInput;
}

export interface AppendTeammateDirectInputResult extends AppendConversationUserTurnResult {
  readonly inputSnapshot: TeammateDirectInputSnapshot;
}
