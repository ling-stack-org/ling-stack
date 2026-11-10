import type { ConversationContextProjectionMetadata } from "@ling-stack/contracts";
import type { UserInputAcceptedAnswer, UserInputRequest, UserInputSource } from "./user-input-store-types.js";
import type { UserInputYieldCheckpoint } from "./user-input-wait-types.js";

/** Host-owned answer input, not an execution request, receiver ACK or permission grant. */
export interface UserInputContinuationSeed {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly use: "user_input_continuation_seed";
  readonly deliveryId: string;
  readonly successorRunId: string;
  readonly source: UserInputSource;
  /** Mutable request/delivery status and lease credentials are deliberately excluded. */
  readonly request: Pick<UserInputRequest, "requestId" | "requestVersion" | "itemId" | "toolCallId" | "waitMode" | "questions" | "createdAt">;
  readonly answer: UserInputAcceptedAnswer;
  readonly checkpoint: UserInputYieldCheckpoint;
  readonly checkpointFingerprint: string;
  readonly contextAssignment: { readonly id: string; readonly revision: number; readonly segmentId: string; readonly createdAt: string };
  readonly itemRefs: readonly { readonly id: string; readonly sequence: number; readonly revision: number; readonly fingerprint: string }[];
  readonly projection: ConversationContextProjectionMetadata;
  readonly createdAt: string;
  readonly fingerprint: string;
}
