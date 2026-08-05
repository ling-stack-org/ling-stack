import assert from "node:assert/strict";
import { test } from "node:test";
import { translatePiEvent } from "../dist/events.js";

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
