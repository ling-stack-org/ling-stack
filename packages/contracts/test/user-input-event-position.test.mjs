import assert from "node:assert/strict";
import test from "node:test";
import { isUserInputRunEventPositionV1, parseUserInputToolInputV1, parseUserInputAnswerSubmissionV1 } from "../dist/index.js";

test("event boundary has an explicit zero origin or a positive sequence with event ID", () => {
  const base = { runId: "run", attemptId: "attempt", afterEventSequence: 0 };
  assert.equal(isUserInputRunEventPositionV1(base), true);
  assert.equal(isUserInputRunEventPositionV1({ ...base, afterEventSequence: 1, afterEventId: "event" }), true);
  for (const value of [null, [], {}, { ...base, runId: "" }, { ...base, attemptId: " " },
    { ...base, afterEventSequence: -1 }, { ...base, afterEventSequence: 1.5 }, { ...base, afterEventSequence: Infinity },
    { ...base, afterEventSequence: Number.MAX_SAFE_INTEGER + 1 }, { ...base, afterEventSequence: 1 },
    { ...base, afterEventId: "event" }, { ...base, afterEventId: null }, { ...base, claim: "PRIVATE" }]) {
    assert.equal(isUserInputRunEventPositionV1(value), false);
  }
});
test("neither the model nor an answer submission can supply Host event positions", () => {
  const runEventPosition = { runId: "run", attemptId: "attempt", afterEventSequence: 0 };
  const tool = { schemaVersion: 1, waitMode: "required", questions: [{ questionId: "q", prompt: "Choose",
    required: true, allowFreeText: true, options: [] }], runEventPosition };
  assert.equal(parseUserInputToolInputV1(tool).ok, false);
  assert.equal(parseUserInputAnswerSubmissionV1({ schemaVersion: 1, requestId: "request", expectedVersion: 1,
    expectedStatusRevision: 1, idempotencyKey: "key", answers: [{ questionId: "q", kind: "text", text: "answer" }], runEventPosition }).ok, false);
});
