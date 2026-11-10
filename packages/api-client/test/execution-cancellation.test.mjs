import assert from "node:assert/strict";
import test from "node:test";
import { LingDaemonClient } from "../dist/index.js";

test("stop requests carry the captured execution identity unchanged on all three APIs", async () => {
  const calls = [];
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: async (url, init) => {
    calls.push({ url: new URL(url), method: init.method, body: JSON.parse(init.body) });
    return new Response("{}", { headers: { "Content-Type": "application/json" } });
  } });
  const cwd = "/workspace with spaces";
  const fence = { expectedAttemptId: "attempt/original", expectedRunId: "run/original" };
  await client.cancelRun(cwd, "run/original", fence);
  await client.cancelWorkUnit(cwd, "unit/original", fence);
  await client.cancelTeammateDirectReply(cwd, "unit/private", { ...fence, reason: "user_requested" });
  assert.deepEqual(calls.map(call => call.url.pathname), ["/runs/run%2Foriginal/cancel",
    "/work-units/unit%2Foriginal/cancel", "/teammate-direct-replies/unit%2Fprivate/cancel"]);
  assert.ok(calls.every(call => call.method === "POST" && call.url.searchParams.get("cwd") === cwd));
  assert.deepEqual(calls.map(call => call.body), [fence, fence, { ...fence, reason: "user_requested" }]);
  await client.cancelWorkUnit(cwd, "queued-unit", { expectedAttemptId: null, expectedRunId: null });
  assert.deepEqual(calls.at(-1).body, { expectedAttemptId: null, expectedRunId: null });
  await client.cancelRun(cwd, "legacy-run");
  assert.deepEqual(calls.at(-1).body, {});
});
