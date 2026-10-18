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
  assert.match(feed, /<ConversationTimelineFeed/);
  assert.match(feed, /timelineNode=\{unifiedTimelineNode\}/);
  assert.match(feed, /timelineId="channel-timeline-root"/);
  assert.doesNotMatch(feed, /useVirtualizer|ConversationVirtualFeed|renderVirtualRow/);
  assert.doesNotMatch(feed, /unifiedTimeline\??\s*[:=]/);
  assert.doesNotMatch(feed, /renderItem/);
  assert.doesNotMatch(workspace, /renderItem:\s*messageRenderers\.renderMessageFeedItem/);
  assert.match(renderer, /onDisclosureIntent:\s*input\.onTimelineDisclosureIntent/);
  assert.match(workspace, /onTimelineDisclosureIntent:\s*messageFeedState\.onDisclosureIntent/);
});

test("channel pending rows rebase turn-local offsets exactly once after feed index zero", async () => {
  const source = await readFile(rendererSourceUrl, "utf8");
  const renderStart = source.indexOf("  function renderUnifiedTimeline(");
  const renderEnd = source.indexOf("\n  function renderChannelMessageAssets(", renderStart);
  assert.notEqual(renderStart, -1);
  assert.notEqual(renderEnd, -1);
  const renderer = source.slice(renderStart, renderEnd);
  const pendingSendStart = renderer.indexOf('if (feedItem.kind === "pending-send")');
  const turnStart = renderer.indexOf('if (feedItem.kind === "turn")', pendingSendStart);
  const activityStart = renderer.indexOf("const activity = feedItem.item;", turnStart);
  assert.notEqual(pendingSendStart, -1);
  assert.notEqual(turnStart, -1);
  assert.notEqual(activityStart, -1);

  const pendingSend = renderer.slice(pendingSendStart, turnStart);
  const turn = renderer.slice(turnStart, activityStart);
  const pendingUserOffset = pendingSend.match(/role:\s*"user"[\s\S]*?threadSequence:\s*([^,\n]+)/)?.[1]?.trim();
  const pendingAgentOffset = pendingSend.match(/role:\s*"agent"[\s\S]*?threadSequence:\s*([^,\n]+)/)?.[1]?.trim();
  const pendingReplyOffset = turn.match(/pendingReplyPreview[\s\S]*?threadSequence:\s*([^,\n]+)/)?.[1]?.trim();

  assert.equal(pendingUserOffset, "0");
  assert.equal(pendingAgentOffset, "1");
  assert.equal(pendingReplyOffset, "999_999");
  assert.equal((renderer.match(/threadSequence:\s*sequence \+ item\.threadSequence/gu) ?? []).length, 1);

  const rebase = (feedIndex, turnLocalOffset) => feedIndex * 1_000_000 + turnLocalOffset;
  const pendingSendOrder = [
    ["pending-user", rebase(2, Number(pendingUserOffset))],
    ["pending-agent", rebase(2, Number(pendingAgentOffset))],
    ["next-durable", rebase(3, 0)],
  ].sort((left, right) => left[1] - right[1]).map(([id]) => id);
  assert.deepEqual(pendingSendOrder, ["pending-user", "pending-agent", "next-durable"]);

  const pendingReplyOrder = [
    ["turn-pending-reply", rebase(1, Number(pendingReplyOffset.replaceAll("_", "")))],
    ["next-durable", rebase(2, 0)],
  ].sort((left, right) => left[1] - right[1]).map(([id]) => id);
  assert.deepEqual(pendingReplyOrder, ["turn-pending-reply", "next-durable"]);
});

test("channel empty state and snapshot revision follow the final typed projection", async () => {
  const [renderer, workspace] = await Promise.all([
    readFile(rendererSourceUrl, "utf8"),
    readFile(new URL("../src/features/workspace/WorkspaceClientView.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(renderer, /if \(snapshot\.items\.length === 0\) return null/);
  assert.match(renderer, /canonicalRevision:\s*projectedTimelineItems\.reduce/);
  assert.match(workspace, /empty:\s*messageFeedEmpty && channelUnifiedTimelineNode === null/);
  assert.equal((workspace.match(/messageRenderers\.renderUnifiedTimeline\(messageFeedItems\)/g) ?? []).length, 1);
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
  assert.match(privateFeed, /timelineNode=\{mountConversationTimeline/);
  for (const surface of [normal, privateFeed]) {
    assert.match(surface, /<ConversationTimelineFeed/);
    assert.doesNotMatch(surface, /useVirtualizer|ConversationVirtualFeed|renderVirtualRow/);
  }
  assert.doesNotMatch(privateFeed, /renderItem=\{\(\) => mountConversationTimeline/);
  assert.doesNotMatch(privateFeed, /private:\$\{teammate\.id\}/u);
  assert.match(normal, /onDisclosureIntent:\s*pauseTimelineAutoFollow/);
  assert.match(privateFeed, /onDisclosureIntent:\s*onCancelPrivateFeedAutoFollow/);
});

test("shared surface shell delegates all display-row windowing to Timeline", async () => {
  const [shell, timeline, privateWorkspace] = await Promise.all([
    readFile(new URL("../src/shared/conversation/blocks/ConversationTimelineFeed.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/shared/conversation/timeline/ConversationTimeline.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/features/teammates/TeammateWorkspace.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(shell, /<ConversationFeed/);
  assert.doesNotMatch(shell, /useVirtualizer|ConversationVirtualFeed|renderVirtualRow/);
  assert.doesNotMatch(privateWorkspace, /useVirtualizer|privateMessageFeedVirtualizer/);
  assert.equal((timeline.match(/useVirtualizer\(/gu) ?? []).length, 1);
});

test("shared surface shell pauses auto-follow before interactive activations", async () => {
  const shell = await readFile(
    new URL("../src/shared/conversation/blocks/ConversationTimelineFeed.tsx", import.meta.url),
    "utf8",
  );

  assert.match(shell, /onKeyDownCapture:/);
  assert.match(shell, /onPointerDownCapture:/);
  assert.match(shell, /event\.key !== "Enter" && event\.key !== " "/);
  assert.equal((shell.match(/onUserScrollIntent\?\.\(\);/gu) ?? []).length, 3);
});

test("private Timeline delegates canonical merging instead of rebasing message-local facts", async () => {
  const source = await readFile(privateFeedSourceUrl, "utf8");
  assert.equal((source.match(/projectTeammatePrivateTimelineItems\(/gu) ?? []).length, 1);
  assert.match(source, /canonical:\s*canonical\.projection/);
  assert.match(source, /contextSegmentIdByItemId:\s*canonical\.projection/);
  assert.doesNotMatch(source, /privateConversationTimelineItems|baseSequence|messageIndex \* 1_000_000/);
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
