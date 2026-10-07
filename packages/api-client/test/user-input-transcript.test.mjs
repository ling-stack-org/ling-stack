import assert from "node:assert/strict";
import test from "node:test";
import { LingDaemonClient } from "../dist/index.js";

test("existing read clients preserve typed user-input hydration for all three surfaces", async () => {
  const userInputs = [{
    kind: "user_input_answer", availability: "available", itemId: "answer-item",
    requestId: "request", requestVersion: 1, answerId: "answer", acceptedAt: "2026-09-07T00:00:01.000Z",
    source: { workspaceId: "default", threadId: "thread", turnId: "turn", runId: "run",
      attemptId: "attempt", workUnitId: "unit", participantId: "engineer", sourceItemId: "source" },
    answers: [{ questionId: "theme", prompt: "选择主题", kind: "text", text: "深色\n保留换行" }],
    delivery: { status: "claimed", revision: 2, updatedAt: "2026-09-07T00:00:03.000Z" },
  }];
  // Transport contract fixture only; this is not an App/Runner integration test.
  const responses = [{ userInputs }, { timeline: { userInputs } }, { items: [], userInputs, hasMore: false }];
  const calls = [];
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET" });
    return new Response(JSON.stringify(responses.shift()), { headers: { "Content-Type": "application/json" } });
  } });
  assert.deepEqual((await client.getConversation("/synthetic workspace", "thread")).userInputs, userInputs);
  assert.deepEqual((await client.getTeammateDirectThread("/synthetic workspace", "engineer")).timeline.userInputs, userInputs);
  assert.deepEqual((await client.listChannelConversationItems("/synthetic workspace", "channel", { limit: 1 })).userInputs, userInputs);
  assert.ok(calls.every(call => call.method === "GET" && call.url.includes("cwd=%2Fsynthetic+workspace")));
});
