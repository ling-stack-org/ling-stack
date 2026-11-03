import assert from "node:assert/strict";
import test from "node:test";
import { buildContextPack, resolveProviderContextBudget } from "../dist/features/channels/context-packs.js";
import { assessChannelReplyBudget } from "../dist/features/channels/channel-reply-budget-admission.js";
import { parseProviderPresetCreateRequest, parseProviderPresetUpdateRequest,
  validateProviderPresetUpdate } from "../dist/features/providers/schemas.js";

const provider = {
  id: "output_reservation", kind: "openai-compatible", providerId: "local-relay",
  model: "custom-model", api: "openai-completions", capabilities: ["chat"], maxTokens: 8192,
};

test("an output-only override retains its reservation without inventing model capacity", () => {
  for (const kind of ["channel_reply", "intent_selector", "workflow_step"]) {
    const budget = resolveProviderContextBudget(provider, kind);
    assert.equal(budget.mode, "model_unknown");
    assert.equal(budget.capabilityConfidence, "conservative");
    assert.equal(budget.contextWindowTokens, 8192);
    assert.equal(budget.reservedOutputTokens, 8192);
    assert.equal(budget.inputBudgetTokens, 0);
    assert.equal(assessChannelReplyBudget({ budget, contextPackOverBudget: false,
      systemPrompt: "", prompt: "" }).reason, "output_reservation_exhausted");
  }
});

test("valid small windows keep their actual input capacity instead of a 1024-token floor", () => {
  const budget = resolveProviderContextBudget({ ...provider, contextWindow: 1800, maxTokens: 512 });
  assert.equal(budget.inputBudgetTokens, 776);
  const pack = buildContextPack({ kind: "channel_reply", providerPreset: { ...provider, contextWindow: 1800, maxTokens: 512 },
    sections: [{ id: "protected", role: "user", priority: "must_keep", text: "must keep", estimatedTokens: 900 }] });
  assert.equal(pack.overBudget, true);
  assert.equal(assessChannelReplyBudget({ budget, contextPackOverBudget: true,
    systemPrompt: "", prompt: "" }).reason, "prepared_input_exceeded");
});

test("lowering only the output limit leaves the conservative context window unchanged", () => {
  const budget = resolveProviderContextBudget({ ...provider, maxTokens: 1024 });
  assert.equal(budget.contextWindowTokens, 8192);
  assert.equal(budget.inputBudgetTokens, 6656);
  assert.equal(budget.mode, "model_unknown");
  assert.equal(assessChannelReplyBudget({ budget, contextPackOverBudget: false,
    systemPrompt: "Follow channel rules.", prompt: "Perform the scoped QA task." }).status, "admitted");
});

test("channel admission checks every capacity field even when derived input is a safe integer", () => {
  const budget = resolveProviderContextBudget({ ...provider, maxTokens: 1024 });
  const invalidBudgets = [
    { ...budget, contextWindowTokens: Number.MAX_SAFE_INTEGER + 1,
      inputBudgetTokens: Number.MAX_SAFE_INTEGER + 1 - 1024 - 512 },
    { ...budget, reservedOutputTokens: Number.MAX_SAFE_INTEGER + 1 },
    { ...budget, reservedOutputTokens: 0 },
    { ...budget, reservedRuntimeOverheadTokens: -1 },
    { ...budget, reservedRuntimeOverheadTokens: Number.NaN },
    { ...budget, inputBudgetTokens: budget.inputBudgetTokens + 1 },
  ];
  for (const candidate of invalidBudgets) {
    assert.equal(assessChannelReplyBudget({ budget: candidate, contextPackOverBudget: false,
      systemPrompt: "", prompt: "short" }).reason, "capacity_unknown");
  }
});

test("provider token fields reject non-positive, fractional and unsafe numbers at both save boundaries", () => {
  const input = { ...provider, displayName: "QA", baseUrl: "http://127.0.0.1:8317/v1" };
  for (const field of ["contextWindow", "maxTokens"]) {
    for (const value of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => parseProviderPresetCreateRequest({ ...input, [field]: value }), /positive safe integer/);
      assert.throws(() => parseProviderPresetUpdateRequest({ [field]: value }), /positive safe integer/);
    }
  }
  const reset = parseProviderPresetUpdateRequest({ contextWindow: null, maxTokens: null }).updateInput;
  assert.equal(reset.contextWindow, null);
  assert.equal(reset.maxTokens, null);
  assert.doesNotThrow(() => validateProviderPresetUpdate({ ...input, contextWindow: 8192, maxTokens: 1024 }, reset));
});

test("partial provider edits validate the merged token configuration without blocking repairs", () => {
  const input = { ...provider, displayName: "QA", baseUrl: "http://127.0.0.1:8317/v1", contextWindow: 8192, maxTokens: 1024 };
  assert.throws(() => parseProviderPresetCreateRequest({ ...input, maxTokens: 8192 }), /maxTokens must be less than contextWindow/);
  assert.throws(() => validateProviderPresetUpdate(input, { maxTokens: 8192 }), /maxTokens must be less than contextWindow/);
  assert.throws(() => validateProviderPresetUpdate(input, { contextWindow: 1024 }), /maxTokens must be less than contextWindow/);
  assert.doesNotThrow(() => validateProviderPresetUpdate({ ...input, maxTokens: 8192 }, { maxTokens: 1024 }));
});
