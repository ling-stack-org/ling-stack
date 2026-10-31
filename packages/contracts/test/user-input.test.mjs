import assert from "node:assert/strict";
import test from "node:test";
import * as contract from "../dist/index.js";

const now = Date.parse("2026-09-07T00:00:00.000Z");
const question = () => ({
  questionId: "theme",
  prompt: "选择主题，或者补充你的要求。",
  required: true,
  allowFreeText: true,
  options: [{ optionId: "dark", label: "深色" }, { optionId: "light", label: "浅色" }],
});
const toolInput = () => ({ schemaVersion: 1, waitMode: "required", questions: [question()] });
const request = () => ({
  requestId: "request-1",
  requestVersion: 1,
  statusRevision: 3,
  status: "pending",
  questions: [question()],
});
const submission = () => ({
  schemaVersion: 1,
  requestId: "request-1",
  expectedVersion: 1,
  expectedStatusRevision: 3,
  idempotencyKey: "submit-1",
  answers: [{ questionId: "theme", kind: "option", optionId: "dark" }],
});
const answerCommand = () => ({
  schemaVersion: 1,
  authority: {
    schemaVersion: 1,
    threadId: "thread-1",
    runId: "run-1",
    attemptId: "attempt-1",
    participantId: "engineer",
    requestId: "request-1",
    requestVersion: 1,
    statusRevision: 3,
    token: "a".repeat(64),
  },
  idempotencyKey: "submit-1",
  answers: [{ questionId: "theme", kind: "option", optionId: "dark" }],
});
const parseTool = (value) => contract.parseUserInputToolInputV1(value);

test("canonical question/answer anchors contain references only and cannot become plain channel messages", () => {
  const base = { schemaVersion: 1, id: "item-question", workspaceId: "workspace", channelId: "channel",
    threadId: "thread", turnId: "turn", sequence: 1, status: "committed", actorType: "local_user",
    visibility: "channel", domainRefs: [], revision: 1,
    createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z",
    committedAt: "2026-09-07T00:00:00.000Z" };
  for (const kind of ["user_input_request", "user_input_answer"]) {
    const payload = { requestId: "request-1", requestVersion: 1, ...(kind === "user_input_answer" ? { answerId: "answer-1" } : {}) };
    const item = { ...base, kind, payload };
    assert.equal(contract.isConversationItemV1(item), true);
    assert.equal(contract.isChannelMessageConversationItem(item), false);
    assert.throws(() => contract.projectConversationItemToChannelMessage(item), /domain projection/);
    assert.equal(contract.isConversationItemV1({ ...item, payload: { ...payload, body: "duplicate narration" } }), false);
    assert.equal(contract.isConversationItemV1({ ...item, payload: { ...payload, requestVersion: 0 } }), false);
  }
});
const parseAnswer = (value) => contract.parseUserInputAnswerSubmissionV1(value);
const validate = (value, context = request(), clock = now) =>
  contract.validateUserInputAnswerForRequestV1(value, context, clock);
function error(result, code, reason) {
  assert.equal(result.ok, false);
  assert.equal(result.error.code, code);
  if (reason) assert.equal(result.error.reason, reason);
  assert.equal("value" in result, false);
}

test("user input exports bounded limits and separate request/delivery lifecycle contracts", () => {
  assert.deepEqual(contract.USER_INPUT_LIMITS_V1, {
    maxQuestions: 3, maxOptionsPerQuestion: 4, maxIdLength: 128,
    maxPromptLength: 4000, maxOptionLabelLength: 500, maxAnswerLength: 8000,
  });
  assert(Object.isFrozen(contract.USER_INPUT_LIMITS_V1));
  assert.deepEqual(contract.userInputRequestStatusesV1,
    ["pending", "answered", "skipped", "cancelled", "expired", "superseded"]);
  assert.deepEqual(contract.userInputDeliveryStatusesV1,
    ["pending", "claimed", "applied", "failed", "obsolete"]);
});

test("public answer command freezes exact Host lineage and rejects forged or extra authority", () => {
  const parsed = contract.parseUserInputAnswerCommandV1(answerCommand());
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, answerCommand());
  for (const override of [
    { authority: { ...answerCommand().authority, token: "short" } },
    { authority: { ...answerCommand().authority, requestVersion: 0 } },
    { authority: { ...answerCommand().authority, participantId: "" } },
    { authority: { ...answerCommand().authority, runtimeInstanceId: "private" } },
    { accepted: true },
  ]) {
    error(contract.parseUserInputAnswerCommandV1({ ...answerCommand(), ...override }), "invalid_input");
  }
});

test("question parser preserves Unicode, Markdown and caller input without selecting an answer", () => {
  const input = toolInput();
  input.questions[0].prompt = "第一行\n\n- 第二行\n    const value = 1;";
  const before = structuredClone(input);
  const parsed = parseTool(input);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, before);
  assert.notEqual(parsed.value, input);
  assert.notEqual(parsed.value.questions[0].options[0], input.questions[0].options[0]);
  input.questions[0].options[0].label = "changed";
  assert.equal(parsed.value.questions[0].options[0].label, "深色");
  assert.equal("answers" in parsed.value, false);
  assert.equal("selectedOptionId" in parsed.value.questions[0], false);
});

test("text-only and optional questions are valid but required waits need a required question", () => {
  const input = toolInput();
  input.questions[0].options = [];
  assert.equal(parseTool(input).ok, true);
  input.questions[0].allowFreeText = false;
  error(parseTool(input), "invalid_input", "unanswerable_question");
  input.questions[0] = { ...question(), required: false };
  error(parseTool(input), "invalid_input", "required_question_missing");
  input.waitMode = "optional";
  assert.equal(parseTool(input).ok, true);
});

test("question input cannot supply Host identity, grant, dependencies or an approval decision", () => {
  for (const key of ["workspaceId", "threadId", "participantId", "sourceRunId", "sourceAttemptId",
    "fencingToken", "approvalRequestId", "grant", "policyHash", "dependentWorkRefs", "answeredBy"]) {
    error(parseTool({ ...toolInput(), [key]: "foreign-or-forged" }), "invalid_input", "unknown_field");
  }
  const input = toolInput();
  input.questions[0].defaultOptionId = "dark";
  error(parseTool(input), "invalid_input", "unknown_field");
  const nested = toolInput();
  nested.questions[0].options[0].approvalDecision = "approve_once";
  error(parseTool(nested), "invalid_input", "unknown_field");
});

test("question parser rejects invalid protocol, wait mode and primitive payloads", () => {
  for (const value of [null, [], "question", 1, false, {}, { ...toolInput(), schemaVersion: 2 },
    { ...toolInput(), waitMode: "all_agents" }]) assert.equal(parseTool(value).ok, false);
  assert.equal(parseTool(Object.create(toolInput())).ok, false);
});

test("question and option ids are stable, bounded and unique, never option labels", () => {
  for (const id of ["", " ", "a b", "x".repeat(129), "\u0000", "中文"]) {
    const input = toolInput();
    input.questions[0].questionId = id;
    assert.equal(parseTool(input).ok, false);
  }
  const duplicate = toolInput();
  duplicate.questions.push(question());
  error(parseTool(duplicate), "invalid_input", "duplicate_question");
  const option = toolInput();
  option.questions[0].options.push({ optionId: "dark", label: "different label" });
  error(parseTool(option), "invalid_input", "duplicate_option");
  assert.equal(parseTool({ ...toolInput(), questions: [question(), { ...question(), questionId: "other" }] }).ok, true);
});

test("question arrays reject empty, sparse and oversized data before mapping", () => {
  for (const questions of [[], Array(1), Array.from({ length: 4 }, (_, i) => ({ ...question(), questionId: "q" + i }))]) {
    assert.equal(parseTool({ ...toolInput(), questions }).ok, false);
  }
  for (const options of [Array(1), Array.from({ length: 5 }, (_, i) => ({ optionId: "o" + i, label: "label" }))]) {
    assert.equal(parseTool({ ...toolInput(), questions: [{ ...question(), options }] }).ok, false);
  }
});

test("question text has explicit boundaries and never coerces values", () => {
  for (const prompt of ["", "  ", "x".repeat(4001), "bad\u0000text", 123, null]) {
    assert.equal(parseTool({ ...toolInput(), questions: [{ ...question(), prompt }] }).ok, false);
  }
  const input = toolInput();
  input.questions[0].prompt = "x".repeat(4000);
  input.questions[0].options[0].label = "x".repeat(500);
  assert.equal(parseTool(input).ok, true);
  input.questions[0].options[0].label += "x";
  assert.equal(parseTool(input).ok, false);
  for (const field of ["required", "allowFreeText"]) {
    assert.equal(parseTool({ ...toolInput(), questions: [{ ...question(), [field]: "true" }] }).ok, false);
  }
});

test("answer parser requires an explicit option or text and returns detached values", () => {
  for (const answer of [
    { questionId: "theme", kind: "option", optionId: "dark" },
    { questionId: "theme", kind: "text", text: "保持\n  原来的缩进" },
  ]) {
    const input = { ...submission(), answers: [answer] };
    const parsed = parseAnswer(input);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.value, input);
    assert.notEqual(parsed.value.answers[0], answer);
  }
});

test("answer parser rejects implicit/default selection, mixed responses and blank text", () => {
  for (const answers of [
    [], Array(1), [{ questionId: "theme" }],
    [{ questionId: "theme", kind: "option", optionId: "dark", text: "yes" }],
    [{ questionId: "theme", kind: "text", text: "yes", optionId: "dark" }],
    [{ questionId: "theme", kind: "text", text: " " }],
    [{ questionId: "theme", kind: "text", text: "x".repeat(8001) }],
    [{ questionId: "theme", kind: "text", text: "secret\u0000" }],
    [{ questionId: "theme", kind: "skip" }],
  ]) assert.equal(parseAnswer({ ...submission(), answers }).ok, false);
  const long = { ...submission(), answers: [{ questionId: "theme", kind: "text", text: "x".repeat(8000) }] };
  assert.equal(parseAnswer(long).ok, true);
});

test("answers cannot carry actor, permission, status, target run or delivery identity", () => {
  for (const key of ["answeredBy", "answeredAt", "status", "approvalRequestId", "decisionKind",
    "grant", "policyHash", "targetRunId", "targetAttemptId", "deliveryId"]) {
    const result = parseAnswer({ ...submission(), [key]: "do-not-echo-secret" });
    error(result, "invalid_input", "unknown_field");
    assert(!JSON.stringify(result).includes("do-not-echo-secret"));
  }
});

test("answer revision and idempotency fields are strict safe integers and bounded ids", () => {
  for (const key of ["expectedVersion", "expectedStatusRevision"]) {
    for (const value of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1"]) {
      assert.equal(parseAnswer({ ...submission(), [key]: value }).ok, false);
    }
  }
  for (const key of ["requestId", "idempotencyKey"]) {
    for (const value of ["", " ", "x".repeat(129), null]) {
      assert.equal(parseAnswer({ ...submission(), [key]: value }).ok, false);
    }
  }
  assert.equal(parseAnswer({ ...submission(), schemaVersion: 2 }).ok, false);
});

test("duplicate or excess answer entries cannot overwrite another answer", () => {
  const input = submission();
  input.answers.push({ questionId: "theme", kind: "text", text: "other" });
  error(parseAnswer(input), "invalid_input", "duplicate_answer");
  assert.equal(parseAnswer({ ...submission(), answers: Array.from({ length: 4 }, (_, i) =>
    ({ questionId: "q" + i, kind: "text", text: "answer" })) }).ok, false);
});

test("semantic validation accepts exactly the referenced option and does not grant authority", () => {
  const parsed = validate(submission());
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, submission());
  assert.equal("grant" in parsed.value, false);
  assert.equal("approved" in parsed.value, false);
  const text = { ...submission(), answers: [{ questionId: "theme", kind: "text", text: "可以，完整访问" }] };
  assert.equal(validate(text).ok, true, "text remains an answer, never an approval");
});

test("semantic validation rejects mismatched request or stale schema/status revision", () => {
  for (const value of [{ ...submission(), requestId: "other" }, { ...submission(), expectedVersion: 2 },
    { ...submission(), expectedStatusRevision: 2 }]) error(validate(value), "stale_request");
});

test("every terminal request state blocks new answers, including answered retries", () => {
  for (const status of ["answered", "skipped", "cancelled", "expired", "superseded"]) {
    error(validate(submission(), { ...request(), status }), "request_not_pending");
  }
  // A store may return a committed equivalent retry BEFORE calling this pending-only validator.
});

test("expiry is checked against an explicit Host clock with an inclusive boundary", () => {
  error(validate(submission(), { ...request(), expiresAt: new Date(now).toISOString() }), "request_expired");
  error(validate(submission(), { ...request(), expiresAt: new Date(now - 1).toISOString() }), "request_expired");
  assert.equal(validate(submission(), { ...request(), expiresAt: new Date(now + 1).toISOString() }).ok, true);
  for (const expiresAt of ["invalid", "", "2026-02-30T00:00:00.000Z"]) {
    error(validate(submission(), { ...request(), expiresAt }), "invalid_request");
  }
  for (const clock of [NaN, Infinity, -1]) error(validate(submission(), request(), clock), "invalid_request");
});

test("semantic validation rejects labels, unknown questions/options and forbidden free text", () => {
  const withAnswer = (answer) => ({ ...submission(), answers: [answer] });
  error(validate(withAnswer({ questionId: "other", kind: "text", text: "yes" })), "unknown_question");
  for (const optionId of ["unknown", "深色"]) {
    // Labels are not IDs; invalid identifier syntax fails before request matching.
    assert.equal(validate(withAnswer({ questionId: "theme", kind: "option", optionId })).ok, false);
  }
  error(validate(withAnswer({ questionId: "theme", kind: "option", optionId: "unknown" })), "unknown_option");
  error(validate(withAnswer({ questionId: "theme", kind: "text", text: "yes" }),
    { ...request(), questions: [{ ...question(), allowFreeText: false }] }), "free_text_not_allowed");
});

test("required answers cannot be omitted while optional omissions remain valid", () => {
  const second = { ...question(), questionId: "second" };
  error(validate(submission(), { ...request(), questions: [question(), second] }), "missing_required_answer");
  assert.equal(validate(submission(), { ...request(), questions: [question(), { ...second, required: false }] }).ok, true);
});

test("corrupt request context fails closed without interpreting answer text", () => {
  for (const context of [
    { ...request(), requestVersion: 0 }, { ...request(), statusRevision: NaN },
    { ...request(), status: "running" }, { ...request(), requestId: "" },
    { ...request(), questions: [] }, { ...request(), questions: [question(), question()] },
  ]) error(validate(submission(), context), "invalid_request");
});

test("non-enumerable unknown fields cannot bypass the closed input schema", () => {
  for (const location of ["root", "question", "option"]) {
    const input = toolInput();
    const target = location === "root" ? input : location === "question"
      ? input.questions[0] : input.questions[0].options[0];
    Object.defineProperty(target, "grant", { value: "forged", enumerable: false });
    error(parseTool(input), "invalid_input", "unknown_field");
  }
  const input = submission();
  Object.defineProperty(input, "answeredBy", { value: "other", enumerable: false });
  error(parseAnswer(input), "invalid_input", "unknown_field");
});

test("accessors, symbols and inherited fields are rejected without evaluating getters", () => {
  let getterCalls = 0;
  const input = toolInput();
  Object.defineProperty(input.questions[0], "prompt", { get() { getterCalls++; return "changed"; } });
  assert.equal(parseTool(input).ok, false);
  const sparse = toolInput();
  Object.defineProperty(sparse.questions, 0, { get() { getterCalls++; return question(); } });
  assert.equal(parseTool(sparse).ok, false);
  const symbol = { ...toolInput(), [Symbol("grant")]: true };
  assert.equal(parseTool(symbol).ok, false);
  assert.equal(parseAnswer(Object.create(submission())).ok, false);
  assert.equal(getterCalls, 0);
  assert.equal(parseTool(Object.assign(Object.create(null), toolInput())).ok, true);
});

test("prototype-looking ids use exact map membership, never inherited properties", () => {
  const input = toolInput();
  input.questions[0].questionId = "constructor";
  input.questions[0].options[0].optionId = "toString";
  assert.equal(parseTool(input).ok, true);
  const context = { ...request(), questions: input.questions };
  const answer = { ...submission(), answers: [{ questionId: "constructor", kind: "option", optionId: "toString" }] };
  assert.equal(validate(answer, context).ok, true);
  answer.answers[0].questionId = "toString";
  error(validate(answer, context), "unknown_question");
  const polluted = JSON.parse(JSON.stringify(toolInput()).replace('"schemaVersion":1', '"schemaVersion":1,"__proto__":{"grant":true}'));
  error(parseTool(polluted), "invalid_input", "unknown_field");
  assert.equal({}.grant, undefined);
});

test("UTF-16 and exact count/id boundaries are enforced consistently", () => {
  const input = toolInput();
  input.questions = Array.from({ length: 3 }, (_, i) => ({
    ...question(), questionId: "q".repeat(127) + i, prompt: "😀".repeat(2000),
    options: Array.from({ length: 4 }, (_, j) => ({ optionId: "o" + j, label: "选项" })),
  }));
  assert.equal(parseTool(input).ok, true);
  input.questions[0].prompt += "😀";
  assert.equal(parseTool(input).ok, false);
  input.questions[0].prompt = "恢复";
  input.questions[0].options[0].optionId = "";
  assert.equal(parseTool(input).ok, false);
  input.questions[0].options[0].optionId = "ok";
  input.questions[0].options[0].label = " ";
  assert.equal(parseTool(input).ok, false);
});
