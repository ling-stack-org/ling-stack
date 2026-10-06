import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { providerFormWithSelectedModel } from "../src/lib/provider-model-selection.ts";

// The browser source uses emitted .js import names; resolve just this local
// dependency to its real TS source for the existing strip-types test runner.
const payloadUrl = new URL("../src/api/provider-payloads.ts", import.meta.url).href;
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === payloadUrl && specifier === "./shared.js") {
      return { url: new URL("../src/api/shared.ts", import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { providerFormToPayload } = await import(payloadUrl);
hook.deregister();

const form = {
  kind: "google",
  displayName: "Google",
  providerId: "google",
  model: "previous-chat-model",
  api: "google-generative-ai",
  providerTransport: "",
  baseUrl: "",
  apiKey: "",
  apiKeyRef: "",
  clearApiKey: false,
  secretHeaderRefsText: "",
  capabilitiesText: "chat, tool_call, reasoning",
  inputText: "text, image",
  enabled: true,
  authHeader: true,
  reasoning: true,
  thinkingModes: ["off", "auto", "high"],
  contextWindow: "1000000",
  maxTokens: "64000",
};

test("explicit empty model capabilities survive selection, real save payload, and JSON", () => {
  for (const sourceForm of [undefined, { ...form, model: "discovery-source" }]) {
    const selected = providerFormWithSelectedModel(form, {
      id: "gemini-2.5-flash-preview-tts",
      capabilities: [],
      thinkingModes: [],
    }, sourceForm).form;
    const serialized = JSON.parse(JSON.stringify(providerFormToPayload(selected)));

    assert.equal(serialized.model, "gemini-2.5-flash-preview-tts");
    assert.equal(Object.hasOwn(serialized, "capabilities"), true);
    assert.deepEqual(serialized.capabilities, []);
    assert.equal(Object.hasOwn(serialized, "thinkingModes"), true);
    assert.deepEqual(serialized.thinkingModes, []);
    assert.equal(serialized.reasoning, false);
  }
});

test("missing discovery capabilities retain the selected source form in the save payload", () => {
  const selected = providerFormWithSelectedModel(form, { id: "unknown-private-model" }, {
    ...form, capabilitiesText: "chat", thinkingModes: [], reasoning: false,
  }).form;
  const serialized = JSON.parse(JSON.stringify(providerFormToPayload(selected)));

  assert.deepEqual(serialized.capabilities, ["chat"]);
  assert.deepEqual(serialized.thinkingModes, []);
  assert.equal(serialized.reasoning, false);
});
