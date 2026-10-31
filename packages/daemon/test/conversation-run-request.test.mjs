import assert from "node:assert/strict";
import test from "node:test";
import { buildConversationRunRequest } from "../dist/features/conversations/conversation-run-request.js";
import { readNativeResponsePreferences } from "../dist/features/conversations/native-response-preferences.js";
import { parseRunRequest } from "../dist/features/runs/schemas.js";

const tools = ["read", "grep", "find", "ls", "bash", "edit", "write"];
for (const explicit of [false, true]) {
  test(`normal prompt distinguishes inferred operands from explicit file references (${explicit})`, () => {
    const message = "解释 node cli.js ../records.csv，不运行。";
    const fileRefs = [{ path: "../records.csv", source: "inferred_text" },
      ...(explicit ? [{ path: "README.md", source: "api" }] : [])];
    const request = buildConversationRunRequest({ workspaceCwd: "/fixture", thread: { id: "thread" },
      turn: { id: "turn", title: "Reference boundary", createdByActor: "local-user" },
      input: { message, fileRefs }, lingConversationTone: "none", defaultReasoningSummary: "auto",
      attachments: [], attachmentMaterializations: new Map(), normalConversationContext: { renderedHistory: "", projection: {} } });
    assert.deepEqual(request.conversationFileRefs, fileRefs, "durable request retains display provenance");
    if (explicit) {
      assert.match(request.task.prompt, /Workspace file references:\n- 1\. README\.md/);
      assert.doesNotMatch(request.task.prompt, /- \d+\. \.\.\/records\.csv/);
    } else {
      assert.equal(request.task.prompt, message, "lexical tokens remain solely in their original narrative");
    }
    assert.deepEqual(request.tools, tools);
  });
}

for (const engineId of ["kimi-acp", "openclaw-acp", "codex-app-server", "pi"]) {
  for (const language of ["follow_user", "zh-CN"]) test(`${engineId} conversation preserves ${language} presentation intent`, () => {
    const binding = engineId === "pi" ? { kind: "pi_provider", providerPresetId: "fixture" }
      : { kind: "native_profile", engineId, profileId: "fixture", profileRevision: 1,
          ...(engineId === "codex-app-server" ? { nativeModelId: "fixture" } : {}) };
    const request = buildConversationRunRequest({ workspaceCwd: "/fixture", thread: { id: "thread" },
      turn: { id: "turn", title: "Fixture", createdByActor: "local-user" },
      input: { message: "请帮我检查", executionBinding: binding, responseLanguage: language },
      lingConversationTone: "friendly", defaultReasoningSummary: "auto", attachments: [], attachmentMaterializations: new Map(),
      normalConversationContext: { renderedHistory: "", projection: {} } });
    assert.deepEqual(request.tools, tools);
    assert.equal(request.task.prompt, "请帮我检查");
    if (engineId === "kimi-acp" || engineId === "openclaw-acp") {
      assert.equal(request.appendSystemPrompt, undefined);
      assert.deepEqual(request.nativeResponsePreferences, { tone: "friendly", language });
    } else {
      assert.equal(request.nativeResponsePreferences, undefined);
      assert.ok(request.appendSystemPrompt.some(text => text.includes("friendly")));
      if (language === "follow_user") assert.ok(request.appendSystemPrompt.some(text => text.includes("most recent user message")));
    }
  });
}

test("public Run parsing cannot supply the internal ACP response preferences", () => {
  const request = parseRunRequest({ cwd: "/fixture", providerPresetId: "fixture", task: { id: "fixture", title: "Fixture", prompt: "User" },
    nativeResponsePreferences: { tone: "friendly", language: "follow_user" } });
  assert.equal(request.nativeResponsePreferences, undefined);
});

for (const invalid of [null, {}, { tone: "custom instruction", language: "follow_user" },
  { tone: "friendly", language: "custom instruction" }, { tone: "friendly", language: "zh-CN", systemPrompt: "injected" }]) {
  test(`internal native response preferences reject malformed intent: ${JSON.stringify(invalid)}`, () => {
    assert.throws(() => readNativeResponsePreferences(invalid), /Invalid native response preferences/);
  });
}
