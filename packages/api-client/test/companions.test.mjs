import assert from "node:assert/strict";
import test from "node:test";
import { LingDaemonClient } from "../dist/index.js";

test("companion mutations preserve JSON delete and proactive responses", async () => {
  const calls = [];
  const disabled = { companion: { id: "companion-1", status: "disabled" } };
  const proactive = {
    status: "skipped",
    cwd: "/workspace with spaces",
    companion: { id: "companion-1", status: "active" },
    reason: "cooldown",
  };
  const client = new LingDaemonClient({
    baseUrl: "http://daemon.test",
    fetch: async (url, init = {}) => {
      calls.push({ url: new URL(String(url)), method: init.method ?? "GET" });
      return Response.json(calls.length === 1 ? disabled : proactive);
    },
  });

  assert.deepEqual(await client.disableCompanion("/workspace with spaces", "companion-1"), disabled);
  assert.deepEqual(await client.triggerCompanionProactive("/workspace with spaces", "companion-1"), proactive);
  assert.deepEqual(calls.map((call) => [call.method, call.url.pathname, call.url.searchParams.get("cwd")]), [
    ["DELETE", "/companions/companion-1", "/workspace with spaces"],
    ["POST", "/companions/companion-1/proactive", "/workspace with spaces"],
  ]);
});
