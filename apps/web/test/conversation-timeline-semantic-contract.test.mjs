import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const timelineCssUrl = new URL("../src/styles/shared/conversation-timeline.css", import.meta.url);
const timelineSourceUrl = new URL("../src/shared/conversation/timeline/ConversationTimeline.tsx", import.meta.url);
const factRowSourceUrl = new URL("../src/shared/conversation/timeline/TimelineFactRow.tsx", import.meta.url);
const messageSourceUrl = new URL("../src/shared/conversation/timeline/ConversationTimelineMessageRenderer.tsx", import.meta.url);

test("typed timeline keeps the feed as the only vertical scroll owner", async () => {
  const styles = await readFile(timelineCssUrl, "utf8");
  assert.match(styles, /\[data-conversation-timeline="true"\][^{]*\{[^}]*overflow:\s*visible;/su);
  assert.match(styles, /\.conversation-timeline-output\s*\{[^}]*overflow:\s*visible;/su);
  assert.doesNotMatch(styles, /\.conversation-(?:command|exploration)-batch[^}]*overflow-y:\s*(?:auto|scroll)/su);
});

test("every typed row exposes the stable renderer key semantic attribute", async () => {
  const [timeline, factRow, message] = await Promise.all([
    readFile(timelineSourceUrl, "utf8"),
    readFile(factRowSourceUrl, "utf8"),
    readFile(messageSourceUrl, "utf8"),
  ]);
  assert.match(factRow, /data-conversation-timeline-renderer-key=\{conversationTimelineRendererKey\(item\.kind\)\}/u);
  assert.match(message, /data-conversation-timeline-renderer-key=\{conversationTimelineRendererKey\(item\.kind\)\}/u);
  assert.match(timeline, /data-conversation-timeline-renderer-key=\{conversationTimelineRendererKey\("subAgentActivity"\)\}/u);
});

