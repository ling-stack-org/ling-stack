import assert from "node:assert/strict";
import test from "node:test";
import { resolveConversationResponseLanguage } from "../dist/features/conversations/routes.js";

test("ordinary conversations follow the current user's language unless explicitly overridden", () => {
  assert.equal(resolveConversationResponseLanguage(undefined, "请运行测试并报告结果"), "zh-CN");
  assert.equal(resolveConversationResponseLanguage("follow_user", "请运行测试并报告结果"), "zh-CN");
  assert.equal(resolveConversationResponseLanguage("follow_user", "Run the tests and report results"), "en-US");
  assert.equal(resolveConversationResponseLanguage("en-US", "请运行测试并报告结果"), "en-US");
  assert.equal(resolveConversationResponseLanguage("zh-CN", "Run the tests and report results"), "zh-CN");
});
