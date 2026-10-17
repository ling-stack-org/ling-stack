import assert from "node:assert/strict";
import test from "node:test";
import { LingDaemonClient } from "../dist/index.js";

test("approval recovery queries the original encoded ID and workspace without a mutation", async () => {
  const calls = [];
  const receipt = { approval: { id: "approval/owner", status: "approved" }, postCommitEffects: [{
    approvalId: "approval/owner", effectKind: "owner", status: "effect_unknown", revision: 2,
    attempts: 1, updatedAt: "2026-10-15T00:00:00.000Z",
  }] };
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: async (url, init = {}) => {
    calls.push({ url: new URL(String(url)), method: init.method ?? "GET" });
    return new Response(JSON.stringify(receipt), { headers: { "Content-Type": "application/json" } });
  } });
  assert.deepEqual(await client.getApproval("/workspace with spaces", "approval/owner"), receipt);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].url.pathname, "/approvals/approval%2Fowner");
  assert.equal(calls[0].url.searchParams.get("cwd"), "/workspace with spaces");
});
