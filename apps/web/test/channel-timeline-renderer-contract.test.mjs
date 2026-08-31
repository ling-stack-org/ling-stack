import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rendererSourceUrl = new URL("../src/features/workspace/ChannelMessageRenderers.tsx", import.meta.url);

test("channel protocol activity uses the shared typed timeline", async () => {
  const source = await readFile(rendererSourceUrl, "utf8");
  assert.match(source, /channelProtocolTimelineItem/);
  assert.match(source, /renderProtocolActivityItem/);
  assert.match(source, /kind:\s*\"protocolEvent\"/);
  assert.doesNotMatch(source, /<MessageBubble/);
});

test("protocol activity actions are owned by the fact-row disclosure", async () => {
  const source = await readFile(rendererSourceUrl, "utf8");
  assert.match(source, /renderFactActions:\s*\(\)\s*=>\s*renderProtocolActivityActions/);
  assert.match(source, /input\.activityActionRow\(item\.id/);
});
