import assert from "node:assert/strict";
import test from "node:test";
import {
  MODEL_TOOL_CONTEXT_BYTES,
  MODEL_TOOL_RESULT_BYTES,
  boundModelToolResults,
} from "../dist/model-context-budget.js";

test("model projection bounds large text while preserving the original message", () => {
  const text = "工具结果长文本🙂".repeat(20_000);
  const source = [{ role: "toolResult", content: [{ type: "text", text }], details: { status: "failed" }, isError: true }];
  const projected = boundModelToolResults(source);
  assert.equal(source[0].content[0].text, text);
  assert.equal(projected.truncatedResults, 1);
  assert.ok(projected.originalBytes > MODEL_TOOL_RESULT_BYTES);
  assert.ok(projected.modelBytes <= MODEL_TOOL_RESULT_BYTES);
  assert.match(projected.messages[0].content[0].text, /full Host evidence retained/);
  assert.deepEqual(projected.messages[0].details, { status: "failed" });
  assert.equal(projected.messages[0].isError, true);
});

test("total model budget prefers newest tool results and emits an explicit marker", () => {
  const source = [0, 1, 2, 3, 4].map(index => ({
    role: "toolResult", content: [{ type: "text", text: `${index}:` + "x".repeat(40_000) }], details: { index },
  }));
  const projected = boundModelToolResults(source, { perResultBytes: 20_000, totalBytes: MODEL_TOOL_CONTEXT_BYTES });
  assert.ok(projected.modelBytes <= MODEL_TOOL_CONTEXT_BYTES);
  assert.equal(projected.messages.length, source.length);
  assert.ok(projected.truncatedResults >= 1);
  assert.equal(projected.messages[0].details.index, 0);
});

test("non-tool messages and image results stay typed while oversized images are replaced", () => {
  const source = [
    { role: "user", content: "keep" },
    { role: "toolResult", content: [{ type: "image", data: "A".repeat(40_000), mimeType: "image/png" }], details: { source: "fixture" } },
  ];
  const projected = boundModelToolResults(source, { perResultBytes: 100, totalBytes: 100 });
  assert.deepEqual(projected.messages[0], source[0]);
  assert.equal(projected.messages[1].content[0].type, "text");
  assert.match(projected.messages[1].content[0].text, /truncated/);
});

test("structured tool content consumes the same cumulative budget as text", () => {
  const source = [{
    role: "toolResult",
    content: [{ type: "json", value: "x".repeat(200) }, { type: "text", text: "tail" }],
  }];
  const projected = boundModelToolResults(source, { perResultBytes: 64, totalBytes: 64 });
  assert.equal(projected.truncatedResults, 1);
  assert.ok(projected.modelBytes <= 64);
  assert.match(projected.messages[0].content.at(-1).text, /truncated/);
  assert.equal(projected.remainingBytes, 64 - projected.modelBytes);
  assert.deepEqual(source[0].content[0], { type: "json", value: "x".repeat(200) });
});

test("UTF-8 result prefixes never introduce a replacement character at the budget boundary", () => {
  const text = "🙂".repeat(100);
  const projected = boundModelToolResults([
    { role: "toolResult", content: [{ type: "text", text }] },
  ], { perResultBytes: 25, totalBytes: 25 });
  const visible = projected.messages[0].content[0].text;
  assert.doesNotMatch(visible, /�/);
  assert.ok(Buffer.byteLength(visible, "utf8") <= 25);
});

test("cumulative exhaustion marks every nonempty tool result instead of silently erasing older results", () => {
  const source = [0, 1, 2].map(index => ({
    role: "toolResult", content: [{ type: "text", text: `result-${index}-` + "x".repeat(100) }],
  }));
  const projected = boundModelToolResults(source, { perResultBytes: 40, totalBytes: 40 });
  assert.equal(projected.truncatedResults, 3);
  assert.ok(projected.modelBytes <= 40);
  for (const message of projected.messages) {
    assert.match(message.content[0]?.text ?? "", /truncated/);
  }
  assert.equal(source[0].content[0].text.length, 109, "Host source remains untouched");
});

test("a budget too small to mark every nonempty result fails closed", () => {
  const source = [0, 1, 2].map(index => ({
    role: "toolResult", content: [{ type: "text", text: `result-${index}-` + "x".repeat(100) }],
  }));
  assert.throws(() => boundModelToolResults(source, { perResultBytes: 40, totalBytes: 32 }),
    /tool result markers exceed/);
});

test("small complete results fit without wasting marker reservation", () => {
  const source = [0, 1, 2].map(() => ({ role: "toolResult", content: [{ type: "text", text: "x" }] }));
  const projected = boundModelToolResults(source, { perResultBytes: 1, totalBytes: 3 });
  assert.equal(projected.modelBytes, 3);
  assert.equal(projected.truncatedResults, 0);
  assert.deepEqual(projected.messages, source);
});

test("complete multi-part content stays complete while an oversized image is still replaced", () => {
  const complete = [{ role: "toolResult", content: [
    { type: "text", text: "first" }, { type: "text", text: "second" },
  ] }];
  assert.deepEqual(boundModelToolResults(complete, { perResultBytes: 11, totalBytes: 11 }).messages, complete);

  const image = [{ role: "toolResult", content: [
    { type: "image", data: "A".repeat(MODEL_TOOL_RESULT_BYTES + 1), mimeType: "image/png" },
  ] }];
  const projected = boundModelToolResults(image, { perResultBytes: 40_000, totalBytes: 40_000 });
  assert.equal(projected.truncatedResults, 1);
  assert.match(projected.messages[0].content[0].text, /truncated/);
});
