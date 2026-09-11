import type { UserInputDeliveryStatusV1, UserInputQuestionV1, UserInputRequestStatusV1 } from "./user-input.js";
import type { UserInputRunEventPositionV1 } from "./user-input-event-position.js";

/** Public lineage only. Runtime fence, claim, credentials and prepared authority stay on the Host. */
export interface UserInputTranscriptSourceV1 {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly workUnitId: string;
  readonly participantId: string;
  readonly sourceItemId: string;
  readonly workflowStepId?: string;
}
interface UserInputTranscriptAvailableBaseV1 {
  readonly availability: "available";
  readonly itemId: string;
  readonly requestId: string;
  readonly requestVersion: number;
  readonly source: UserInputTranscriptSourceV1;
  /** Absence permits canonical-only history, not guessed placement inside a Run. */
  readonly runEventPosition?: UserInputRunEventPositionV1;
}
export interface UserInputRequestTranscriptV1 extends UserInputTranscriptAvailableBaseV1 {
  readonly kind: "user_input_request";
  readonly status: UserInputRequestStatusV1;
  readonly statusRevision: number;
  readonly waitMode: "optional" | "required";
  readonly questions: readonly UserInputQuestionV1[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
}
/** Exact accepted option label or free text, derived from immutable question and answer records. */
export type UserInputTranscriptAnswerV1 = {
  readonly questionId: string;
  readonly prompt: string;
} & (
  | { readonly kind: "option"; readonly optionId: string; readonly label: string }
  | { readonly kind: "text"; readonly text: string }
);
export interface UserInputAnswerTranscriptV1 extends UserInputTranscriptAvailableBaseV1 {
  readonly kind: "user_input_answer";
  readonly answerId: string;
  readonly acceptedAt: string;
  readonly answers: readonly UserInputTranscriptAnswerV1[];
  /** Saved is not delivered. Only a verified receiver acknowledgment can produce applied. */
  readonly delivery: {
    readonly status: UserInputDeliveryStatusV1;
    readonly revision: number;
    readonly updatedAt: string;
  };
}
export interface UserInputTranscriptUnavailableV1 {
  readonly availability: "unavailable";
  readonly itemId: string;
  readonly kind: "user_input_request" | "user_input_answer";
}
/** Read-only hydration of canonical anchors, not messages, operation evidence or a submission API. */
export type UserInputTranscriptItemV1 =
  | UserInputRequestTranscriptV1 | UserInputAnswerTranscriptV1 | UserInputTranscriptUnavailableV1;

/** Verified bridge from a workflow delegation to the selected child's own canonical history. */
export interface UserInputTranscriptRunHistoryV1 {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly participantId: string;
  readonly workflowStepId: string;
  readonly parentItemId: string;
  readonly parentThreadId: string;
  readonly items: readonly import("./conversation-continuity.js").ConversationItemV1[];
  readonly userInputs: readonly UserInputTranscriptItemV1[];
}
