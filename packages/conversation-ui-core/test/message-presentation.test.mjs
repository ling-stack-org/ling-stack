import assert from "node:assert/strict";
import test from "node:test";
import { projectConversationMessagePresentation } from "../dist/index.js";

test("message projection keeps assistant narrative and runtime error separate", () => {
  assert.deepEqual(projectConversationMessagePresentation({
    content: "I created the files, but verification failed.",
    errorMessage: "node test.mjs exited with code 2",
    status: "failed",
  }), {
    body: "I created the files, but verification failed.",
    errorText: "node test.mjs exited with code 2",
  });
});

test("message projection removes legacy duplicate error body", () => {
  assert.deepEqual(projectConversationMessagePresentation({
    content: "Provider unavailable",
    errorMessage: "Provider unavailable",
    status: "failed",
  }), {
    body: "",
    errorText: "Provider unavailable",
  });
});

test("message projection does not repeat a typed error already narrated by a blocked sentence", () => {
  assert.deepEqual(projectConversationMessagePresentation({
    content: "AI teammate is blocked: No workspace default model is configured for this built-in teammate.",
    errorMessage: "No workspace default model is configured for this built-in teammate.",
    status: "blocked",
  }), {
    body: "AI teammate is blocked: No workspace default model is configured for this built-in teammate.",
    errorText: "",
  });
});

test("message projection preserves a legacy content-only failure as an error", () => {
  assert.deepEqual(projectConversationMessagePresentation({
    content: "Provider timed out while generating the response.",
    status: "failed",
  }), {
    body: "",
    errorText: "Provider timed out while generating the response.",
  });
});

test("message projection does not show an error for a successful message", () => {
  assert.deepEqual(projectConversationMessagePresentation({
    content: "Completed.",
    errorMessage: "stale error",
    status: "succeeded",
  }), {
    body: "Completed.",
    errorText: "",
  });
});
