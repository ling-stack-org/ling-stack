import {
  USER_INPUT_LIMITS_V1 as limits,
  userInputRequestStatusesV1,
  type UserInputAnswerRequestContextV1,
  type UserInputAnswerSubmissionV1,
  type UserInputAnswerV1,
  type UserInputInvalidReasonV1,
  type UserInputQuestionV1,
  type UserInputToolInputV1,
  type UserInputValidationCodeV1,
  type UserInputValidationFailureV1,
  type UserInputValidationResultV1,
} from "./user-input.js";

/** Parse model-owned question content; reject every Host/permission field. */
export function parseUserInputToolInputV1(value: unknown): UserInputValidationResultV1<UserInputToolInputV1> {
  if (!record(value)) return invalid("$", "invalid_shape");
  if (!keys(value, ["schemaVersion", "waitMode", "questions"])) return invalid("$", "unknown_field");
  if (value.schemaVersion !== 1 || (value.waitMode !== "optional" && value.waitMode !== "required")) {
    return invalid("$", "invalid_value");
  }
  const questions = parseQuestions(value.questions);
  if (!questions.ok) return questions;
  if (value.waitMode === "required" && !questions.value.some((question) => question.required)) {
    return invalid("questions", "required_question_missing");
  }
  return {
    ok: true,
    value: { schemaVersion: 1, waitMode: value.waitMode, questions: questions.value },
  };
}

/** Validate wire syntax without selecting a default or interpreting answer text. */
export function parseUserInputAnswerSubmissionV1(
  value: unknown,
): UserInputValidationResultV1<UserInputAnswerSubmissionV1> {
  if (!record(value)) return invalid("$", "invalid_shape");
  if (!keys(value, ["schemaVersion", "requestId", "expectedVersion", "expectedStatusRevision", "idempotencyKey", "answers"])) {
    return invalid("$", "unknown_field");
  }
  if (value.schemaVersion !== 1 || !id(value.requestId) || !id(value.idempotencyKey)
    || !positiveInteger(value.expectedVersion) || !positiveInteger(value.expectedStatusRevision)) {
    return invalid("$", "invalid_value");
  }
  if (!boundedArray(value.answers, 1, limits.maxQuestions)) return invalid("answers", "invalid_shape");
  const answers: UserInputAnswerV1[] = [];
  const seen = new Set<string>();
  for (const [index, answer] of value.answers.entries()) {
    const field = "answers[" + index + "]";
    if (!record(answer)) return invalid(field, "invalid_shape");
    const allowed = answer.kind === "option"
      ? ["questionId", "kind", "optionId"]
      : ["questionId", "kind", "text"];
    if (!keys(answer, allowed)) return invalid(field, "unknown_field");
    if (!id(answer.questionId)) return invalid(field + ".questionId", "invalid_value");
    if (seen.has(answer.questionId)) return invalid(field + ".questionId", "duplicate_answer");
    seen.add(answer.questionId);
    if (answer.kind === "option" && id(answer.optionId)) {
      answers.push({ questionId: answer.questionId, kind: "option", optionId: answer.optionId });
    } else if (answer.kind === "text" && text(answer.text, limits.maxAnswerLength)) {
      answers.push({ questionId: answer.questionId, kind: "text", text: answer.text });
    } else {
      return invalid(field, "invalid_value");
    }
  }
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      requestId: value.requestId,
      expectedVersion: value.expectedVersion,
      expectedStatusRevision: value.expectedStatusRevision,
      idempotencyKey: value.idempotencyKey,
      answers,
    },
  };
}

/**
 * Validate an answer against a pending Host request at an explicit Host time.
 * Call under the store's CAS boundary after authorization. Equivalent committed
 * retries must return their stored receipt before this pending-only check.
 * Success means content matches, never that permission or execution was granted.
 */
export function validateUserInputAnswerForRequestV1(
  value: unknown,
  request: UserInputAnswerRequestContextV1,
  nowEpochMs: number,
): UserInputValidationResultV1<UserInputAnswerSubmissionV1> {
  const parsed = parseUserInputAnswerSubmissionV1(value);
  if (!parsed.ok) return parsed;
  if (!record(request) || !id(request.requestId)
    || !positiveInteger(request.requestVersion) || !positiveInteger(request.statusRevision)
    || !userInputRequestStatusesV1.includes(request.status)
    || !Number.isFinite(nowEpochMs) || nowEpochMs < 0) {
    return failure("invalid_request", "$");
  }
  const questions = parseQuestions(request.questions);
  if (!questions.ok) return failure("invalid_request", "questions");
  const expiresAt = request.expiresAt === undefined ? undefined : canonicalTimestamp(request.expiresAt);
  if (request.expiresAt !== undefined && expiresAt === undefined) {
    return failure("invalid_request", "expiresAt");
  }
  const answer = parsed.value;
  if (answer.requestId !== request.requestId || answer.expectedVersion !== request.requestVersion
    || answer.expectedStatusRevision !== request.statusRevision) {
    return failure("stale_request", "$");
  }
  if (request.status !== "pending") return failure("request_not_pending", "$");
  if (expiresAt !== undefined && nowEpochMs >= expiresAt) return failure("request_expired", "expiresAt");

  const byId = new Map(questions.value.map((question) => [question.questionId, question]));
  const answeredIds = new Set<string>();
  for (const [index, response] of answer.answers.entries()) {
    const field = "answers[" + index + "]";
    const question = byId.get(response.questionId);
    if (!question) return failure("unknown_question", field + ".questionId");
    if (response.kind === "option" && !question.options.some((option) => option.optionId === response.optionId)) {
      return failure("unknown_option", field + ".optionId");
    }
    if (response.kind === "text" && !question.allowFreeText) return failure("free_text_not_allowed", field + ".text");
    answeredIds.add(response.questionId);
  }
  if (questions.value.some((question) => question.required && !answeredIds.has(question.questionId))) {
    return failure("missing_required_answer", "answers");
  }
  return parsed;
}

function parseQuestions(value: unknown): UserInputValidationResultV1<readonly UserInputQuestionV1[]> {
  if (!boundedArray(value, 1, limits.maxQuestions)) return invalid("questions", "invalid_shape");
  const questions: UserInputQuestionV1[] = [];
  const seen = new Set<string>();
  for (const [index, question] of value.entries()) {
    const field = "questions[" + index + "]";
    if (!record(question)) return invalid(field, "invalid_shape");
    if (!keys(question, ["questionId", "prompt", "required", "allowFreeText", "options"])) {
      return invalid(field, "unknown_field");
    }
    if (!id(question.questionId) || !text(question.prompt, limits.maxPromptLength)
      || typeof question.required !== "boolean" || typeof question.allowFreeText !== "boolean") {
      return invalid(field, "invalid_value");
    }
    if (seen.has(question.questionId)) return invalid(field + ".questionId", "duplicate_question");
    seen.add(question.questionId);
    if (!boundedArray(question.options, 0, limits.maxOptionsPerQuestion)) return invalid(field + ".options", "invalid_shape");
    const options: { optionId: string; label: string }[] = [];
    const optionIds = new Set<string>();
    for (const [optionIndex, option] of question.options.entries()) {
      const optionField = field + ".options[" + optionIndex + "]";
      if (!record(option)) return invalid(optionField, "invalid_shape");
      if (!keys(option, ["optionId", "label"])) return invalid(optionField, "unknown_field");
      if (!id(option.optionId) || !text(option.label, limits.maxOptionLabelLength)) return invalid(optionField, "invalid_value");
      if (optionIds.has(option.optionId)) return invalid(optionField + ".optionId", "duplicate_option");
      optionIds.add(option.optionId);
      options.push({ optionId: option.optionId, label: option.label });
    }
    if (!options.length && !question.allowFreeText) return invalid(field, "unanswerable_question");
    questions.push({
      questionId: question.questionId,
      prompt: question.prompt,
      required: question.required,
      allowFreeText: question.allowFreeText,
      options,
    });
  }
  return { ok: true, value: questions };
}

function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Reflect.ownKeys(value).every((key) => typeof key === "string"
      && "value" in Object.getOwnPropertyDescriptor(value, key)!);
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.includes(key));
}

function boundedArray(value: unknown, min: number, max: number): value is unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) return false;
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !("value" in descriptor)) return false;
  }
  return true;
}

function id(value: unknown): value is string {
  return typeof value === "string" && value.length <= limits.maxIdLength
    && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value);
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && value.trim().length > 0
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function canonicalTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value ? epoch : undefined;
}

function invalid(field: string, reason: UserInputInvalidReasonV1): UserInputValidationFailureV1 {
  return { ok: false, error: { code: "invalid_input", field, reason } };
}

function failure(code: UserInputValidationCodeV1, field: string): UserInputValidationFailureV1 {
  return { ok: false, error: { code, field } };
}
