import assert from "node:assert/strict";
import test from "node:test";
import { providerFormWithSelectedModel } from "../src/lib/provider-model-selection.ts";

const form = {
  model: "previous-chat-model",
  api: "google-generative-ai",
  capabilitiesText: "chat, tool_call, reasoning",
  inputText: "text, image",
  reasoning: true,
  thinkingModes: ["off", "auto", "high"],
  contextWindow: "1000000",
  maxTokens: "64000",
};

test("selecting an explicitly non-chat model clears previous chat capabilities before saving", () => {
  for (const sourceForm of [undefined, { ...form, model: "discovery-source" }]) {
    const selected = providerFormWithSelectedModel(form, {
      id: "gemini-2.5-flash-preview-tts",
      capabilities: [],
      thinkingModes: [],
    }, sourceForm).form;

    assert.equal(selected.capabilitiesText, "");
    assert.equal(selected.reasoning, false);
    assert.deepEqual(selected.thinkingModes, []);
    assert.equal(selected.model, "gemini-2.5-flash-preview-tts");
  }
});

test("selecting a model with missing capabilities preserves the existing form fallback", () => {
  const sourceForm = { ...form, capabilitiesText: "chat" };
  const selected = providerFormWithSelectedModel(form, { id: "unknown-private-model" }, sourceForm).form;

  assert.equal(selected.capabilitiesText, "chat");
  assert.equal(selected.reasoning, sourceForm.reasoning);
  assert.deepEqual(selected.thinkingModes, sourceForm.thinkingModes);
});
