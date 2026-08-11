import assert from "node:assert/strict";
import test from "node:test";
import { checkProviderPreset } from "../dist/features/providers/preflight.js";
import { extractProviderResponseText } from "../dist/features/providers/response-text.js";

test("provider response text ignores reasoning and accepts supported visible text shapes", () => {
  assert.equal(extractProviderResponseText("openai-completions", {
    choices: [{ message: { content: [{ type: "reasoning", text: "private" }, { type: "text", text: "OK" }] } }],
  }), "OK");
  assert.equal(extractProviderResponseText("openai-responses", {
    output: [{ content: [{ type: "reasoning", text: "private" }, { type: "output_text", text: "Ready" }] }],
  }), "Ready");
  assert.equal(extractProviderResponseText("anthropic-messages", {
    content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "Done" }],
  }), "Done");
  assert.equal(extractProviderResponseText("openai-completions", {
    choices: [{ message: { reasoning_content: "private", content: "" } }],
  }), "");
});

test("provider preflight rejects a successful response without displayable text", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { role: "assistant", content: "", reasoning_content: "private" }, finish_reason: "stop" }],
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const result = await checkProviderPreset({}, {
      id: "provider_empty_response",
      kind: "openai-compatible",
      displayName: "Empty response provider",
      providerId: "empty-response",
      model: "empty-model",
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      authHeader: false,
      capabilities: ["chat"],
      enabled: true,
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
    }, emptySecretResolver());

    assert.equal(result.ok, false);
    assert.equal(result.code, "empty_response");
    assert.doesNotMatch(JSON.stringify(result), /private/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider preflight accepts OpenAI-compatible text block responses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { role: "assistant", content: [{ type: "text", text: "OK" }] }, finish_reason: "stop" }],
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const result = await checkProviderPreset({}, {
      id: "provider_text_response",
      kind: "openai-compatible",
      displayName: "Text response provider",
      providerId: "text-response",
      model: "text-model",
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      authHeader: false,
      capabilities: ["chat"],
      enabled: true,
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
    }, emptySecretResolver());

    assert.equal(result.ok, true);
    assert.equal(result.code, "ready");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function emptySecretResolver() {
  return {
    resolve: (ref) => ({ ref, configured: false }),
    status: (ref) => ({ ref, kind: "env", configured: false }),
  };
}
