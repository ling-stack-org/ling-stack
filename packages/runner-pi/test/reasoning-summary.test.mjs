import assert from "node:assert/strict";
import test from "node:test";
import { translatePiEvents } from "../dist/events.js";
import { createPiTaskBoundary } from "../dist/task-boundary.js";

function assistantMessage({ signature, api = "openai-responses", thinking = "PRIVATE RAW REASONING" }) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      api,
      content: [{ type: "thinking", thinking, thinkingSignature: signature }],
    },
  };
}

function reasoningSignature({ summary, content = "PRIVATE RAW REASONING" }) {
  return JSON.stringify({
    type: "reasoning",
    id: "rs_fixture",
    summary: summary.map((text) => ({ type: "summary_text", text })),
    content: [{ type: "reasoning_text", text: content }],
    encrypted_content: "opaque-provider-value",
  });
}

test("message_end emits only the provider-safe Responses summary before terminal metadata", () => {
  const events = translatePiEvents(assistantMessage({
    signature: reasoningSignature({ summary: ["Checked the request.", "Selected the safe path."] }),
  }));

  assert.deepEqual(events, [
    {
      type: "assistant_reasoning_summary",
      text: "Checked the request.\n\nSelected the safe path.",
      parts: ["Checked the request.", "Selected the safe path."],
      semantic: "safe_summary",
      source: "openai_responses",
      truncated: false,
    },
    {
      type: "message_end",
      role: "assistant",
      contentKinds: ["thinking"],
    },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE RAW REASONING/);
  assert.doesNotMatch(JSON.stringify(events), /opaque-provider-value/);
});

test("reasoning summary extraction fails closed for other providers and malformed signatures", () => {
  const valid = reasoningSignature({ summary: ["Safe summary"] });
  for (const event of [
    assistantMessage({ api: "anthropic-messages", signature: valid }),
    assistantMessage({ signature: "not-json" }),
    assistantMessage({ signature: JSON.stringify({ type: "reasoning", summary: [{ type: "summary_text", text: 42 }] }) }),
    assistantMessage({ signature: JSON.stringify({ type: "other", summary: [{ type: "summary_text", text: "forged" }] }) }),
  ]) {
    assert.deepEqual(translatePiEvents(event), [{
      type: "message_end",
      role: "assistant",
      contentKinds: ["thinking"],
    }]);
  }
});

test("reasoning summary is bounded without exposing omitted text", () => {
  const events = translatePiEvents(assistantMessage({
    signature: reasoningSignature({ summary: ["a".repeat(30_000), "must-not-appear"] }),
  }));
  const summary = events[0];
  assert.equal(summary.type, "assistant_reasoning_summary");
  assert.equal(summary.truncated, true);
  assert.ok(summary.text.length <= 24_001);
  assert.doesNotMatch(summary.text, /must-not-appear/);
  assert.equal(summary.parts.length, 1);
});

async function transformPayload({ mode, api = "openai-responses", payload, upstream }) {
  let requestOptions;
  const runtime = {
    streamSimple(_model, _context, options) {
      requestOptions = options;
      return { fixture: true };
    },
  };
  const boundary = createPiTaskBoundary({
    cwd: "/workspace",
    task: { id: "reasoning_fixture", title: "Reasoning fixture", prompt: "Test." },
    provider: { provider: "fixture", model: "fixture", api },
    reasoningSummary: mode,
  });
  boundary.bindModelRuntime(runtime);
  runtime.streamSimple({ api }, {}, upstream ? { onPayload: upstream } : undefined);
  return requestOptions.onPayload(payload, { api });
}

for (const mode of ["auto", "concise", "detailed"]) {
  test(`Responses payload maps ${mode} reasoning summary mode`, async () => {
    const payload = { model: "fixture", reasoning: { effort: "medium", summary: "auto" } };
    const transformed = await transformPayload({ mode, payload });
    assert.deepEqual(transformed, { model: "fixture", reasoning: { effort: "medium", summary: mode } });
    assert.deepEqual(payload, { model: "fixture", reasoning: { effort: "medium", summary: "auto" } }, "input is immutable");
  });
}

test("none removes only the public summary request and preserves reasoning effort", async () => {
  assert.deepEqual(await transformPayload({
    mode: "none",
    payload: { model: "fixture", reasoning: { effort: "high", summary: "auto" }, include: ["reasoning.encrypted_content"] },
  }), {
    model: "fixture",
    reasoning: { effort: "high" },
    include: ["reasoning.encrypted_content"],
  });
});

test("non-Responses providers are not modified", async () => {
  const payload = { model: "fixture", reasoning: { effort: "medium", summary: "auto" } };
  assert.equal(await transformPayload({ mode: "detailed", api: "anthropic-messages", payload }), undefined);
  assert.deepEqual(payload, { model: "fixture", reasoning: { effort: "medium", summary: "auto" } });
});

test("reasoning summary policy applies after an existing payload hook", async () => {
  const transformed = await transformPayload({
    mode: "concise",
    payload: { reasoning: { effort: "medium", summary: "auto" } },
    upstream: async () => ({ reasoning: { effort: "low", summary: "detailed" }, custom: true }),
  });
  assert.deepEqual(transformed, { reasoning: { effort: "low", summary: "concise" }, custom: true });
});
