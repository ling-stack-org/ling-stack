import assert from "node:assert/strict";
import test from "node:test";
import { readConversationReadingAnchor, restoreConversationReadingAnchor } from "../src/shared/conversation/blocks/conversation-reading-anchor.ts";

function viewport(rows) {
  return { scrollTop: 100, getBoundingClientRect: () => ({ top: 50, bottom: 450 }), querySelectorAll: () => rows };
}
function row(key, top, bottom, parent) {
  return { dataset: { conversationRowKey: key, conversationParentSubAgentId: parent }, getBoundingClientRect: () => ({ top, bottom }) };
}

test("reading captures the first visible row and restores its viewport offset", () => {
  const feed = viewport([row("offscreen", -100, 40), row("visible", 30, 130), row("below", 500, 600)]);
  const anchor = readConversationReadingAnchor(feed);
  assert.deepEqual(anchor, { rowKey: "visible", offsetTop: -20, parentSubAgentId: undefined });
  feed.querySelectorAll = () => [row("visible", 230, 330)];
  assert.equal(restoreConversationReadingAnchor(feed, anchor), true);
  assert.equal(feed.scrollTop, 300);
});

test("a collapsed child returns to its own parent without opening another group", () => {
  const parent = row("parent", 90, 120);
  parent.dataset.feedItemId = "agent-1";
  parent.dataset.conversationTimelineDepth = "0";
  const feed = viewport([parent]);
  assert.equal(restoreConversationReadingAnchor(feed, { rowKey: "hidden-child", parentSubAgentId: "agent-1", offsetTop: 10 }), true);
  assert.equal(feed.scrollTop, 130);
});

test("a missing anchor does not jump to an unrelated row or to the tail", () => {
  const feed = viewport([row("another-thread", 50, 90)]);
  assert.equal(restoreConversationReadingAnchor(feed, { rowKey: "missing", offsetTop: 0 }), false);
  assert.equal(feed.scrollTop, 100);
  assert.equal(readConversationReadingAnchor(viewport([])), undefined);
});

test("an unkeyed transient row is not a reading anchor", () => {
  const feed = viewport([row(undefined, 50, 90), row("keyed", 100, 150)]);
  assert.equal(readConversationReadingAnchor(feed)?.rowKey, "keyed");
});
