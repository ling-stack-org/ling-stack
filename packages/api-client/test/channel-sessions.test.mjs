import assert from "node:assert/strict";
import test from "node:test";
import { LingDaemonClient } from "../dist/index.js";

test("channel session facade keeps canonical identity, filters and idempotency key", async () => {
  const calls = [];
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: async (url, init = {}) => {
    calls.push({ url: new URL(String(url)), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify({ session: { id: "thread/one" } }), { headers: { "Content-Type": "application/json" } });
  } });
  const cwd = "/workspace with spaces", channelId = "channel/owner", threadId = "thread/one";
  await client.listChannelSessions(cwd, channelId, { archived: true, q: "原始 & 标题", limit: 10, cursor: "opaque/key" });
  await client.createChannelSession(cwd, channelId, { idempotencyKey: "creation & key" });
  await client.getChannelSession(cwd, channelId, threadId);
  await client.updateChannelSession(cwd, channelId, threadId, { title: "新标题", archived: false });
  assert.ok(calls.every(call => call.url.searchParams.get("cwd") === cwd));
  assert.equal(calls[0].url.pathname, "/channels/channel%2Fowner/sessions");
  assert.equal(calls[0].url.searchParams.get("q"), "原始 & 标题");
  assert.equal(calls[0].url.searchParams.get("cursor"), "opaque/key");
  assert.equal(calls[0].url.searchParams.get("archived"), "true");
  assert.equal(calls[0].url.searchParams.get("limit"), "10");
  assert.equal(calls[1].method, "POST");
  assert.deepEqual(calls[1].body, { idempotencyKey: "creation & key" });
  assert.equal(calls[2].url.pathname, "/channels/channel%2Fowner/sessions/thread%2Fone");
  assert.equal(calls[2].method, "GET");
  assert.equal(calls[3].method, "PATCH");
  assert.deepEqual(calls[3].body, { title: "新标题", archived: false });
});
