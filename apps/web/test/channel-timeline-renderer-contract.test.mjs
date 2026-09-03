import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rendererSourceUrl = new URL("../src/features/workspace/ChannelMessageRenderers.tsx", import.meta.url);
const normalFeedSourceUrl = new URL("../src/features/workspace/NormalConversationFeed.tsx", import.meta.url);
const privateFeedSourceUrl = new URL("../src/features/teammates/TeammatePrivateChatFeed.tsx", import.meta.url);
const topicPanelSourceUrl = new URL("../src/features/workspace/ThreadReplyPanel.tsx", import.meta.url);

test("channel protocol activity uses the shared typed timeline", async () => {
  const source = await readFile(rendererSourceUrl, "utf8");
  assert.match(source, /channelProtocolTimelineItem/);
  assert.doesNotMatch(source, /renderProtocolActivityItem/);
  assert.match(source, /kind:\s*\"protocolEvent\"/);
  assert.doesNotMatch(source, /<MessageBubble/);
});

test("channel surface exposes only the unified Timeline root", async () => {
  const [renderer, feed, workspace] = await Promise.all([
    readFile(rendererSourceUrl, "utf8"),
    readFile(new URL("../src/features/workspace/ChannelMessageFeed.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/features/workspace/WorkspaceClientView.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(renderer, /readonly renderMessageFeedItem/);
  assert.doesNotMatch(renderer, /return \{ renderMessageFeedItem, renderUnifiedTimeline \}/);
  assert.match(feed, /renderVirtualRow=\{\(\) => unifiedTimelineNode\}/);
  assert.match(feed, /virtualRowIdentity=\{\{ id: "channel-timeline-root", kind: "timeline" \}\}/);
  assert.doesNotMatch(feed, /unifiedTimeline\??\s*[:=]/);
  assert.doesNotMatch(feed, /renderItem/);
  assert.doesNotMatch(workspace, /renderItem:\s*messageRenderers\.renderMessageFeedItem/);
});

test("protocol activity actions remain shell controls outside the fact renderer", async () => {
  const source = await readFile(rendererSourceUrl, "utf8");
  assert.doesNotMatch(source, /renderFactActions/);
  assert.doesNotMatch(source, /data-channel-protocol-activity-controls/);
  assert.doesNotMatch(source, /activityActionRow/);
  assert.match(source, /mountConversationTimeline/);
});

test("protocol activity requires a real selected LingThread id", async () => {
  const source = await readFile(rendererSourceUrl, "utf8");
  assert.match(source, /selectedChannelThreadId/);
  assert.doesNotMatch(source, /return `channel:\$\{channelId\}`/);
  assert.match(source, /buildSurfaceTimelineSnapshot/);
  assert.match(source, /threadId:\s*input\.selectedChannelThreadId/);
  assert.doesNotMatch(source, /channel:\$\{channelId\}/);
});

test("normal and private surfaces each own exactly one Timeline mount", async () => {
  const [normal, privateFeed] = await Promise.all([
    readFile(normalFeedSourceUrl, "utf8"),
    readFile(privateFeedSourceUrl, "utf8"),
  ]);
  assert.equal((normal.match(/mountConversationTimeline\(/gu) ?? []).length, 1);
  assert.equal((privateFeed.match(/mountConversationTimeline\(/gu) ?? []).length, 1);
  assert.match(privateFeed, /renderVirtualRow=\{\(\) => mountConversationTimeline/);
  assert.doesNotMatch(privateFeed, /renderItem=\{\(\) => mountConversationTimeline/);
  assert.doesNotMatch(privateFeed, /private:\$\{teammate\.id\}/u);
});

test("private Timeline rebases each message slice exactly once", async () => {
  const source = await readFile(privateFeedSourceUrl, "utf8");
  assert.match(source, /facts,\n\s*\/\/ Rebase the whole per-message slice exactly once/);
  assert.match(source, /threadSequence:\s*baseSequence \+ item\.threadSequence/);
  assert.doesNotMatch(source, /facts,\n\s*threadSequence:\s*baseSequence,/);
});

test("topic replies use the shared Timeline with the resolved LingThread scope", async () => {
  const source = await readFile(topicPanelSourceUrl, "utf8");
  assert.equal((source.match(/mountConversationTimeline\(/gu) ?? []).length, 1);
  assert.match(source, /buildSurfaceTimelineSnapshot/);
  assert.match(source, /surface:\s*"topic_reply"/);
  assert.match(source, /threadId,/);
  assert.match(source, /renderMessageChrome/);
  assert.doesNotMatch(source, /MessageBodyRenderer/);
});
