import assert from "node:assert/strict";
import test from "node:test";
import { LingDaemonClient } from "../dist/index.js";

test("submission recovery reads only the original workspace/surface/key with encoded private ownership", async () => {
  const calls = [];
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: async (url, init = {}) => {
    calls.push({ url: new URL(String(url)), method: init.method ?? "GET" });
    return new Response(JSON.stringify({ status: "unknown" }), { headers: { "Content-Type": "application/json" } });
  } });
  const cwd = "/workspace with spaces";
  const idempotencyKey = "original & key";
  await client.getConversationSubmission(cwd, { surface: "normal", threadId: "native-thread", idempotencyKey });
  await client.getConversationSubmission(cwd, { surface: "channel", channelId: "engineering", threadId: "branch", idempotencyKey });
  await client.getTeammateDirectMessageSubmission(cwd, "teammate/owner", idempotencyKey);
  assert.ok(calls.every(call => call.method === "GET" && call.url.searchParams.get("cwd") === cwd
    && call.url.searchParams.get("idempotencyKey") === idempotencyKey));
  assert.equal(calls[0].url.pathname, "/conversation-submissions");
  assert.equal(calls[0].url.searchParams.get("surface"), "normal");
  assert.equal(calls[0].url.searchParams.get("threadId"), "native-thread");
  assert.equal(calls[1].url.searchParams.get("surface"), "channel");
  assert.equal(calls[1].url.searchParams.get("channelId"), "engineering");
  assert.equal(calls[1].url.searchParams.get("threadId"), "branch");
  assert.equal(calls[2].url.pathname, "/teammates/teammate%2Fowner/direct-messages");
});

test("guidance lookup sends an exact encoded key on existing read-only collections", async () => {
  const calls = [];
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: async (url, init = {}) => {
    calls.push({ url: new URL(String(url)), method: init.method ?? "GET" });
    return new Response(JSON.stringify({ interventions: [] }), { headers: { "Content-Type": "application/json" } });
  } });
  const cwd = "/workspace with spaces", key = "original & guidance/key";
  await client.listRunInterventions(cwd, "run/owner", 1, key);
  await client.listTeammateDirectInterventions(cwd, "teammate/owner", key);
  assert.ok(calls.every(call => call.method === "GET" && call.url.searchParams.get("cwd") === cwd
    && call.url.searchParams.get("idempotencyKey") === key));
  assert.equal(calls[0].url.pathname, "/runs/run%2Fowner/interventions");
  assert.equal(calls[0].url.searchParams.get("limit"), "1");
  assert.equal(calls[1].url.pathname, "/teammates/teammate%2Fowner/direct-interventions");
});
