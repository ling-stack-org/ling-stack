import assert from "node:assert/strict";
import test from "node:test";
import { LingDaemonClient } from "../dist/index.js";
import type { ThreadWorkspaceChangeSummaryResponse } from "@ling-stack/contracts";

test("latest Turn summary uses a read-only request with encoded conversation and workspace identity", async () => {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const body: ThreadWorkspaceChangeSummaryResponse = { cwd: "/workspace 中文", threadId: "thread / 中文", turn: { id: "turn", status: "running" } };
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: async (input, init) => {
    calls.push({ url: new URL(String(input)), init }); return Response.json(body);
  } });
  assert.deepEqual(await client.getThreadWorkspaceChangeSummary(body.cwd, body.threadId), body);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url.pathname, "/threads/thread%20%2F%20%E4%B8%AD%E6%96%87/workspace-change-summary");
  assert.equal(calls[0]!.url.searchParams.get("cwd"), body.cwd);
  assert.equal(calls[0]!.init?.method, "GET");
  assert.equal(calls[0]!.init?.body, undefined);
});
