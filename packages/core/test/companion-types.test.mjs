import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultCompanionManifest,
  parseCompanionReply,
  parseCompanionReplyText,
  validateCompanionAction,
  validateCompanionEmotion,
} from "../dist/index.js";

test("Companion reply parsing preserves text and bounds emotion intensity", () => {
  const reply = parseCompanionReply({
    text: "你好",
    emotion: { id: "happy", intensity: 2 },
    actionRequests: [{ actionId: "greet" }, { arguments: {} }, "invalid"],
    memoryCandidates: [{ summary: "喜欢茶", reason: "用户提到" }, { reason: "缺少摘要" }],
  });
  assert.equal(reply.text, "你好");
  assert.deepEqual(reply.emotion, { id: "happy", intensity: 1 });
  assert.deepEqual(reply.actionRequests, [{ actionId: "greet" }]);
  assert.deepEqual(reply.memoryCandidates, [{ summary: "喜欢茶", reason: "用户提到" }]);
});

test("Companion manifest validation rejects undeclared presentation capabilities", () => {
  assert.throws(() => validateCompanionAction(defaultCompanionManifest, "run-command"), /not declared/);
  assert.throws(() => validateCompanionEmotion(defaultCompanionManifest, "angry"), /not declared/);
  assert.doesNotThrow(() => validateCompanionAction(defaultCompanionManifest, "greet"));
  assert.doesNotThrow(() => validateCompanionEmotion(defaultCompanionManifest, "neutral"));
});

test("Companion reply parsing keeps plain text when structured output is unavailable", () => {
  assert.deepEqual(parseCompanionReply("模型回复"), { text: "模型回复" });
  assert.deepEqual(parseCompanionReply(null), { text: "" });
});

test("Companion reply text parser strips the optional metadata suffix without losing text", () => {
  const parsed = parseCompanionReplyText(
    '你好，伙伴。\nLING_COMPANION_META: {"emotion":{"id":"happy","intensity":0.8},"actionRequests":[{"actionId":"greet"}]}',
  );
  assert.equal(parsed.displayText, "你好，伙伴。");
  assert.equal(parsed.reply.emotion.id, "happy");
  assert.deepEqual(parsed.reply.actionRequests, [{ actionId: "greet" }]);
  assert.equal(parsed.metadataError, undefined);
});
