import assert from "node:assert/strict";
import test from "node:test";
import { reconcileChannelSessionMessageCache } from "../src/domains/workspace/channel-session-message-cache.ts";

const item = (id, sequence) => ({ id, sequence, revision: 1 });
const message = id => ({ id, createdAt: "2026-10-29T00:00:00.000Z" });
const media = (mediaJobId, messageId) => ({ mediaJobId, messageId, createdAt: "2026-10-29T00:00:00.000Z" });

test("refresh removes superseded items and media from its raw window while retaining older loaded pages", () => {
  const cached = { items: [item("older", 20), item("hidden-assistant", 95), item("user", 96)],
    messages: [message("older"), message("hidden-assistant"), message("user")],
    generatedMedia: [media("older-media", "older"), media("hidden-media", "hidden-assistant")], hasOlder: true, before: 20 };
  const incoming = { conversationItems: [item("user", 96)], messages: [message("user")], generatedMedia: [], hasMore: true, nextBeforeSequence: 90 };
  const result = reconcileChannelSessionMessageCache(cached, incoming, incoming.conversationItems);
  assert.deepEqual(result.items.map(item => item.id), ["older", "user"]);
  assert.deepEqual(result.messages.map(item => item.id).sort(), ["older", "user"]);
  assert.deepEqual(result.generatedMedia.map(item => item.mediaJobId), ["older-media"]);
  assert.equal(result.before, 20);
  assert.equal(result.hasOlder, true);
});

test("an empty filtered page still replaces the host raw window and an exhausted refresh drops stale cached history", () => {
  const cached = { items: [item("older", 20), item("hidden-tool", 95)], messages: [message("older")], generatedMedia: [], hasOlder: false };
  const page = { conversationItems: [], messages: [], generatedMedia: [], hasMore: true, nextBeforeSequence: 90 };
  assert.deepEqual(reconcileChannelSessionMessageCache(cached, page, []).items.map(item => item.id), ["older"]);
  assert.deepEqual(reconcileChannelSessionMessageCache(cached, { ...page, hasMore: false }, []).items, []);
});
