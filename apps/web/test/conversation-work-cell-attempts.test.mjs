import assert from "node:assert/strict";
import test from "node:test";
import { projectConversationLatestAttemptEvidence } from "../src/lib/conversation-work-cell-attempts.ts";

test("main work-cell evidence keeps Attempt 1 failure out of the Attempt 2 projection", () => {
  const firstAttempt = run("run_attempt_1", "failed");
  const secondAttempt = run("run_attempt_2", "succeeded");
  const projected = projectConversationLatestAttemptEvidence({
    threadId: "thread_retry",
    latestRun: secondAttempt,
    attemptCount: 2,
    artifactsByRun: {
      [firstAttempt.id]: [artifact("artifact_old", firstAttempt.id, "old-attempt.txt")],
      [secondAttempt.id]: [artifact("artifact_new", secondAttempt.id, "retry-once.cjs")],
    },
    executionActions: [
      action("action_old", firstAttempt.id, "echo old attempt evidence", "failed"),
      action("action_new", secondAttempt.id, "node retry-once.cjs", "succeeded"),
      { id: "action_unscoped", threadId: "thread_retry", title: "legacy thread action", status: "succeeded" },
    ],
  });

  assert.deepEqual(projected.runs.map((item) => item.id), [secondAttempt.id]);
  assert.deepEqual(projected.artifacts.map((item) => item.path), ["retry-once.cjs"]);
  assert.deepEqual(projected.actions.map((item) => [item.id, item.status]), [["action_new", "succeeded"]]);
});

function run(id, status) {
  return {
    id,
    status,
    threadId: "thread_retry",
  };
}

function artifact(id, runId, path) {
  return { id, runId, path };
}

function action(id, runId, command, status) {
  return { id, runId, threadId: "thread_retry", title: command, status };
}
