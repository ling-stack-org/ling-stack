import assert from "node:assert/strict";
import { test } from "node:test";
import { translatePiEvent } from "../dist/events.js";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";

for (const [name, deltas] of [
  ["Markdown whitespace", ["说明。", "\n", "\n", "### 检查结果", "\n\n", "- 已读取", "\n\n", "```ts\n", "  const x = 1;", "\n\t", "console.log(x);", "\n```"]],
  ["a missing provider newline without inventing one", ["说明。", "###", " 检查结果", "\n\n", "- 已读取"]],
]) {
  test(`SSE parsing and Ling translation preserve ${name}`, async () => {
    const records = deltas.map((content) => ({ choices: [{ index: 0, delta: { content }, finish_reason: null }] }));
    records.push({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    const bytes = new TextEncoder().encode(records.map((record) => `data: ${JSON.stringify(record)}\n\n`).join("") + "data: [DONE]\n\n");
    let fetchCount = 0;
    const model = {
      id: "markdown-fixture", name: "Markdown fixture", provider: "fixture",
      api: "openai-completions", baseUrl: "https://fixture.invalid/v1",
      reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const response = stream(model, {
      messages: [{ role: "user", content: "Return Markdown.", timestamp: 0 }],
    }, {
      apiKey: "fixture-no-network",
      fetch: async () => {
        fetchCount += 1;
        return new Response(new ReadableStream({
          start(controller) {
            // Split transport bytes independently of JSON and multibyte text boundaries.
            for (let offset = 0; offset < bytes.length; offset += 11) controller.enqueue(bytes.slice(offset, offset + 11));
            controller.close();
          },
        }), { headers: { "content-type": "text/event-stream" } });
      },
    });
    const translated = [];
    for await (const entry of response) {
      assert.notEqual(entry.type, "error", entry.error?.errorMessage);
      if (entry.type === "text_delta") {
        translated.push(translatePiEvent({ type: "message_update", assistantMessageEvent: entry }).text);
      }
    }
    const finalMessage = await response.result();
    assert.equal(fetchCount, 1);
    assert.deepEqual(translated, deltas);
    assert.equal(translatePiEvent({ type: "message_end", message: finalMessage }).text, deltas.join(""));
  });
}

test("message_end preserves final assistant text when a provider emits no text deltas", () => {
  const translated = translatePiEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "internal" },
        { type: "text", text: "Final " },
        { type: "text", text: "answer" },
      ],
    },
  });

  assert.deepEqual(translated, {
    type: "message_end",
    role: "assistant",
    text: "Final answer",
    contentKinds: ["thinking", "text"],
  });
});

test("message_end exposes only bounded terminal metadata and never reasoning text", () => {
  assert.deepEqual(translatePiEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "reasoning", text: "private reasoning" }],
      finish_reason: "length",
      error: { message: "contains provider internals" },
    },
  }), {
    type: "message_end",
    role: "assistant",
    stopReason: "length",
    errorMessage: "Provider message ended with an error.",
    contentKinds: ["reasoning"],
  });
});

test("message_end does not project user or tool content as assistant output", () => {
  assert.deepEqual(translatePiEvent({
    type: "message_end",
    message: { role: "user", content: "User prompt" },
  }), {
    type: "message_end",
    role: "user",
  });
});
