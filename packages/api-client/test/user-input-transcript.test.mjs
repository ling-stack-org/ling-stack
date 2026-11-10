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

test("answer client posts exact public authority and reports Host acceptance separately from Runner application", async () => {
  const command = {
    schemaVersion: 1,
    authority: { schemaVersion: 1, threadId: "thread", runId: "run", attemptId: "attempt",
      participantId: "engineer", requestId: "request", requestVersion: 1, statusRevision: 3,
      token: "a".repeat(64) },
    idempotencyKey: "answer:request:1",
    answers: [{ questionId: "theme", kind: "option", optionId: "dark" }],
  };
  const accepted = { accepted: true, receipt: { requestId: "request", requestVersion: 1, answerId: "answer",
    answerItemId: "answer-item", deliveryId: "delivery", acceptedAt: "2026-09-07T00:00:01.000Z", replayed: false },
  delivery: { status: "pending" } };
  const calls = [];
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
    return new Response(JSON.stringify(accepted), { status: 202, headers: { "Content-Type": "application/json" } });
  } });
  const result = await client.submitUserInputAnswer("/synthetic workspace", command);
  assert.deepEqual(result, accepted);
  assert.equal(result.delivery.status, "pending");
  assert.equal("applied" in result.delivery, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "http://daemon.test/user-input-answers?cwd=%2Fsynthetic+workspace");
  assert.deepEqual(JSON.parse(calls[0].body), command);
});
