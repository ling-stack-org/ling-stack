/** Limits shared by the model adapter, authenticated API and question UI. */
export const USER_INPUT_LIMITS_V1 = Object.freeze({
  maxQuestions: 3,
  maxOptionsPerQuestion: 4,
  maxIdLength: 128,
  maxPromptLength: 4000,
  maxOptionLabelLength: 500,
  maxAnswerLength: 8000,
});

export const userInputRequestStatusesV1 = Object.freeze([
  "pending", "answered", "skipped", "cancelled", "expired", "superseded",
] as const);
export type UserInputRequestStatusV1 = (typeof userInputRequestStatusesV1)[number];

export const userInputDeliveryStatusesV1 = Object.freeze([
  "pending", "claimed", "applied", "failed", "obsolete",
] as const);
export type UserInputDeliveryStatusV1 = (typeof userInputDeliveryStatusesV1)[number];

export interface UserInputOptionV1 {
  readonly optionId: string;
  readonly label: string;
}

export interface UserInputQuestionV1 {
  readonly questionId: string;
  readonly prompt: string;
  readonly required: boolean;
  readonly allowFreeText: boolean;
  readonly options: readonly UserInputOptionV1[];
}

/**
 * Untrusted model input only. The Host supplies ownership, dependency edges,
 * request identity and any approval association outside this payload.
 */
export interface UserInputToolInputV1 {
  readonly schemaVersion: 1;
  readonly waitMode: "optional" | "required";
  readonly questions: readonly UserInputQuestionV1[];
}

export type UserInputAnswerV1 =
  | { readonly questionId: string; readonly kind: "option"; readonly optionId: string }
  | { readonly questionId: string; readonly kind: "text"; readonly text: string };

/** User intent to submit, not a receipt, permission grant or delivery proof. */
export interface UserInputAnswerSubmissionV1 {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly expectedVersion: number;
  readonly expectedStatusRevision: number;
  readonly idempotencyKey: string;
  readonly answers: readonly UserInputAnswerV1[];
}

/**
 * Public optimistic authority for one visible question snapshot. The token is
 * Host-derived from private source lineage; it is not a runtime fence, claim,
 * permission grant or proof that a Runner received an answer.
 */
export interface UserInputAnswerAuthorityV1 {
  readonly schemaVersion: 1;
  readonly threadId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly participantId: string;
  readonly requestId: string;
  readonly requestVersion: number;
  readonly statusRevision: number;
  readonly token: string;
}

/** Authenticated local-user intent. Host revalidates every authority field. */
export interface UserInputAnswerCommandV1 {
  readonly schemaVersion: 1;
  readonly authority: UserInputAnswerAuthorityV1;
  readonly idempotencyKey: string;
  readonly answers: readonly UserInputAnswerV1[];
}

/**
 * Durable Host acceptance only. `accepted` never means delivery, continuation
 * admission, Runner receipt or task completion.
 */
export interface UserInputAnswerAcceptedResponseV1 {
  readonly accepted: true;
  readonly receipt: {
    readonly requestId: string;
    readonly requestVersion: number;
    readonly answerId: string;
    readonly answerItemId: string;
    readonly deliveryId: string;
    readonly acceptedAt: string;
    readonly replayed: boolean;
  };
  readonly delivery: { readonly status: "pending" };
}

/**
 * Read-only subset of the authoritative request used for content validation.
 * Scope authorization and an atomic status/version CAS remain Host duties.
 */
export interface UserInputAnswerRequestContextV1 {
  readonly requestId: string;
  readonly requestVersion: number;
  readonly statusRevision: number;
  readonly status: UserInputRequestStatusV1;
  readonly questions: readonly UserInputQuestionV1[];
  /** Canonical UTC ISO timestamp including milliseconds. */
  readonly expiresAt?: string;
}

export type UserInputValidationCodeV1 =
  | "invalid_input"
  | "invalid_request"
  | "stale_request"
  | "request_not_pending"
  | "request_expired"
  | "unknown_question"
  | "unknown_option"
  | "free_text_not_allowed"
  | "missing_required_answer";

export type UserInputInvalidReasonV1 =
  | "invalid_shape"
  | "unknown_field"
  | "invalid_value"
  | "duplicate_question"
  | "duplicate_option"
  | "unanswerable_question"
  | "required_question_missing"
  | "duplicate_answer";

export interface UserInputValidationFailureV1 {
  readonly ok: false;
  readonly error: {
    readonly code: UserInputValidationCodeV1;
    /** Known schema path only; never includes submitted values or unknown keys. */
    readonly field: string;
    readonly reason?: UserInputInvalidReasonV1;
  };
}

export type UserInputValidationResultV1<T> =
  | { readonly ok: true; readonly value: T }
  | UserInputValidationFailureV1;
