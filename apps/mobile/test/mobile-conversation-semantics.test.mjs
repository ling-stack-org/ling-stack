import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  adaptRemoteConversationMessage,
  adaptRemoteConversationMessages,
} from "../src/features/conversations/domain/MobileConversationAdapter.ts";

const source = async (path) => await readFile(new URL(path, import.meta.url), "utf8");

test("all three remote conversation kinds map to shared core surfaces", () => {
  const message = remoteMessage({ role: "teammate", authorId: "teammate-qa", authorLabel: "QA" });
  const fixtures = [
    ["channel", "channel_root"],
    ["conversation", "normal_conversation"],
    ["teammate_direct", "teammate_direct"],
  ];

  for (const [kind, surface] of fixtures) {
    const viewModel = adaptRemoteConversationMessage(kind, message);
    assert.equal(viewModel.item.surface, surface);
    assert.equal(viewModel.item.actorKind, "ai_teammate");
    assert.equal(viewModel.item.actorId, "teammate-qa");
    assert.equal(viewModel.item.actorName, "QA");
    assert.equal(viewModel.id, message.messageId);
  }
});

test("adapter applies one stable order and five-minute author grouping", () => {
  const messages = [
    remoteMessage({ messageId: "third", activitySeq: 3, createdAt: "2026-08-01T10:10:00.000Z" }),
    remoteMessage({ messageId: "second", activitySeq: 2, createdAt: "2026-08-01T10:04:00.000Z" }),
    remoteMessage({ messageId: "first", activitySeq: 1, createdAt: "2026-08-01T10:00:00.000Z" }),
  ];

  const viewModels = adaptRemoteConversationMessages("channel", messages);

  assert.deepEqual(viewModels.map((item) => item.id), ["first", "second", "third"]);
  assert.deepEqual(viewModels.map((item) => item.groupedWithPrevious), [false, true, false]);
});

test("adapter parses supported native body blocks through conversation-ui-core", () => {
  const viewModel = adaptRemoteConversationMessage("conversation", remoteMessage({
    body: [
      "# Result",
      "",
      "- **ready**",
      "- [docs](https://example.com)",
      "",
      "> quoted",
      "",
      "```ts",
      "const ready = true;",
      "```",
    ].join("\n"),
  }));

  assert.deepEqual(viewModel.blocks.map((block) => block.kind), ["heading", "list", "quote", "code"]);
  assert.equal(viewModel.item.kind, "teammate_message");
  assert.equal(viewModel.item.actorKind, "coordinator");
});

test("streaming revisions remain one item and keep incomplete fences inert", () => {
  const message = remoteMessage({
    messageId: "streaming-answer",
    status: "streaming",
    revision: 4,
    body: "```ts\nconst answer =",
  });
  const viewModel = adaptRemoteConversationMessage("conversation", message);

  assert.equal(viewModel.id, "streaming-answer");
  assert.equal(viewModel.streaming, true);
  assert.equal(viewModel.item.status, "streaming");
  assert.deepEqual(viewModel.blocks, [{ kind: "code", code: "const answer =", language: "ts", complete: false }]);
});

test("native renderer consumes semantic blocks without importing Web renderers", async () => {
  const renderer = await source("../src/features/conversations/components/NativeMessageBody.tsx");

  assert.match(renderer, /MessageBodyBlock/u);
  assert.match(renderer, /case "heading"/u);
  assert.match(renderer, /case "quote"/u);
  assert.match(renderer, /case "list"/u);
  assert.match(renderer, /case "code"/u);
  assert.match(renderer, /accessibilityRole="link"/u);
  assert.match(renderer, /token\.reference\.displayPath/u);
  assert.doesNotMatch(renderer, /apps\/web|conversation-ui-react|\.css/iu);
});

function remoteMessage(overrides = {}) {
  return {
    messageId: "message-1",
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    role: "assistant",
    authorId: "ling-agent",
    authorLabel: "Ling",
    body: "Ready",
    status: "ready",
    revision: 1,
    activitySeq: 1,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}
