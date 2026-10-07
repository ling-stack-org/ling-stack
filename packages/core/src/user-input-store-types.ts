import type {
  UserInputAnswerV1,
  ConversationItemVisibilityV1, RuntimeAttemptFenceV1,
  UserInputQuestionV1, UserInputRequestStatusV1, UserInputToolInputV1, UserInputValidationCodeV1,
} from "@ling-stack/contracts";

/** Persisted Host identity. Neither model questions nor submitted answers own this scope. */
export interface UserInputSource {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly runId: string;
  /** Frozen at question creation; absence of a Task row is an explicit source kind. */
  readonly taskBinding: { readonly kind: "stored_task" | "run_snapshot"; readonly taskId: string };
  readonly itemId: string;
  readonly participantId: string;
  readonly channelId?: string;
  readonly workflowStepId?: string;
  readonly fence: RuntimeAttemptFenceV1;
  readonly cwd: string;
  readonly visibility: ConversationItemVisibilityV1;
  readonly visibilityOwnerId?: string;
}

export interface UserInputRequest {
  readonly requestId: string;
  readonly requestVersion: number;
  readonly statusRevision: number;
  readonly status: UserInputRequestStatusV1;
  readonly source: UserInputSource;
  readonly itemId: string;
  readonly toolCallId: string;
  readonly waitMode: UserInputToolInputV1["waitMode"];
  readonly questions: readonly UserInputQuestionV1[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
}

/** Host-only entry point; toolInput is the untrusted, strictly parsed model payload. */
export interface CreateUserInputRequest {
  readonly sourceRunId: string;
  readonly sourceItemId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly toolCallId: string;
  readonly idempotencyKey: string;
  readonly toolInput: unknown;
  readonly expiresAt?: string;
}
export interface CreateUserInputRequestResult {
  readonly request: UserInputRequest;
  readonly replayed: boolean;
}
/** Internal boundary lookup. The caller must use the fence captured at dispatch. */
export interface FindRequiredUserInputForAttempt {
  readonly sourceRunId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
}
export interface SubmitUserInputAnswer {
  /** Authenticated caller scope; this store does not establish API authorization. */
  readonly threadId: string;
  readonly submission: unknown;
}
/** Immutable acceptance evidence, not a delivery acknowledgment or permission grant. */
export interface UserInputAnswerReceipt {
  readonly requestId: string;
  readonly requestVersion: number;
  readonly answerId: string;
  readonly answerItemId: string;
  readonly deliveryId: string;
  readonly acceptedAt: string;
  readonly replayed: boolean;
}
/** Verified immutable answer content; never includes idempotency or authorization data. */
export interface UserInputAcceptedAnswer {
  readonly answerId: string;
  readonly itemId: string;
  readonly acceptedAt: string;
  readonly answers: readonly UserInputAnswerV1[];
}
/** Host-selected visible canonical anchors; callers must establish surface access first. */
export interface ReadUserInputTranscript {
  readonly threadId: string;
  readonly itemIds: readonly string[];
}
export interface PendingUserInputDelivery {
  readonly deliveryId: string;
  readonly requestId: string;
  readonly requestVersion: number;
  readonly answerId: string;
  readonly threadId: string;
  readonly consumerWorkUnitId: string;
  readonly status: "pending";
  readonly createdAt: string;
}
export interface CancelUserInputRequest {
  readonly threadId: string;
  readonly requestId: string;
  readonly expectedStatusRevision: number;
}
export interface ListPendingUserInputDeliveries {
  readonly threadId: string;
  readonly limit?: number;
}
export type UserInputStoreErrorCode = UserInputValidationCodeV1
  | "not_found" | "source_conflict" | "idempotency_conflict" | "sensitive_input" | "invalid_record" | "wait_conflict" | "not_quiescent"
  | "delivery_conflict" | "delivery_not_ready";
export class UserInputStoreError extends Error {
  constructor(readonly code: UserInputStoreErrorCode) {
    // Do not include model/user content, IDs or secrets in failure messages.
    super("User input operation rejected: " + code);
    this.name = "UserInputStoreError";
  }
}
