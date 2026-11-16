import assert from "node:assert/strict";
import test from "node:test";
import { LingDaemonClient } from "../dist/index.js";

test("comment methods encode identities and preserve the immutable anchor body", async () => {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: async (input, init) => {
    calls.push({ url: new URL(String(input)), init }); return Response.json({});
  } });
  const input = { snapshotDigest: "a".repeat(64), path: "src/a.ts", side: "old" as const, startLine: 2, endLine: 2, body: "This caller needs investigation." };
  await client.listCodeAssessmentComments("/中文 project", "assessment / 1", "finding / 1");
  await client.createCodeAssessmentComment("/中文 project", "assessment / 1", "finding / 1", input);
  assert.deepEqual(calls.map(call => call.init?.method), ["GET", "POST"]);
  assert.ok(calls.every(call => call.url.pathname === "/workspace/code-assessments/assessment%20%2F%201/findings/finding%20%2F%201/comments"
    && call.url.searchParams.get("cwd") === "/中文 project"));
  assert.deepEqual(JSON.parse(String(calls[1]!.init?.body)), input);
});
