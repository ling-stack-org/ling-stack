import assert from "node:assert/strict";
import test from "node:test";
import { extractAssistantText } from "../dist/shared/assistant-text.js";

test("extractAssistantText ignores role-aware non-assistant messages", () => {
  assert.equal(extractAssistantText([
    { role: "system", content: "internal system prompt" },
    { role: "user", content: "internal user prompt" },
  ]), undefined);
});

test("extractAssistantText reads latest role-aware assistant message", () => {
  assert.equal(extractAssistantText([
    { role: "user", content: "question" },
    { role: "assistant", content: "first answer" },
    { role: "assistant", content: [{ text: "final answer" }] },
  ]), "final answer");
});

test("extractAssistantText keeps legacy message fallback", () => {
  assert.equal(extractAssistantText(["legacy answer"]), "legacy answer");
});
