import assert from "node:assert/strict";
import test from "node:test";
import { assessChannelReplyBudget } from "../dist/features/channels/channel-reply-budget-admission.js";

const budget = {
  mode: "model_known", contextWindowTokens: 4096, reservedOutputTokens: 1024,
  reservedRuntimeOverheadTokens: 512, inputBudgetTokens: 2560,
  tokenizer: "openai-compatible", capabilitySource: "provider", capabilityConfidence: "known",
};

test("a rendered reply with system and user input inside the model budget is admitted", () => {
  assert.equal(assessChannelReplyBudget({ budget, contextPackOverBudget: false,
    systemPrompt: "Follow the channel rules.", prompt: "Answer the user's question." }).status, "admitted");
});

test("system, web and memory text are counted after rendering, not hidden behind a small context pack", () => {
  const result = assessChannelReplyBudget({ budget: { ...budget, inputBudgetTokens: 100 },
    contextPackOverBudget: false, systemPrompt: "memory ".repeat(500), prompt: "web evidence ".repeat(500) });
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "prepared_input_exceeded");
  assert.ok(result.estimatedInputTokens > 100);
});

test("an over-budget protected pack cannot be rescued by a small replacement prompt", () => {
  assert.equal(assessChannelReplyBudget({ budget, contextPackOverBudget: true,
    systemPrompt: "system", prompt: "short" }).reason, "prepared_input_exceeded");
});

test("custom providers use only the conservative fallback ceiling, not an invented exact capacity", () => {
  const fallback = { ...budget, mode: "model_unknown", inputBudgetTokens: 100 };
  assert.deepEqual(assessChannelReplyBudget({ budget: fallback, contextPackOverBudget: false,
    systemPrompt: "system", prompt: "short" }).status, "admitted");
  assert.equal(assessChannelReplyBudget({ budget: fallback, contextPackOverBudget: false,
    systemPrompt: "system", prompt: "large input ".repeat(1000) }).reason, "prepared_input_exceeded");
  assert.equal(assessChannelReplyBudget({ budget: { ...fallback, inputBudgetTokens: 0 },
    contextPackOverBudget: false, systemPrompt: "system", prompt: "short" }).reason, "capacity_unknown");
});
