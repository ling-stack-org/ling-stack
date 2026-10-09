import assert from "node:assert/strict";
import test from "node:test";
import { LingDaemonClient, LingDaemonError } from "../dist/index.js";

const cursor = { runId: "run:a", workUnitId: "unit / 中文", createdAt: "2026-10-09T00:00:00.000Z", kind: "tool_execution", id: "tool \"1\"" };

test("diagnostic transport uses a GET with encoded scope and lossless JSON keyset cursor", async () => {
  const calls = [];
  const body = { schemaVersion: 1, cwd: "/workspace 中文", workUnitId: cursor.workUnitId, runId: cursor.runId, status: "available", items: [], observedAt: "now" };
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: async (input, init) => {
    calls.push([new URL(String(input)), init]);
    return Response.json(body);
  } });
  assert.deepEqual(await client.getWorkUnitHarnessDiagnostics(body.cwd, cursor.workUnitId, { limit: 100, cursor }), body);
  const [url, init] = calls[0];
  assert.equal(url.pathname, "/work-units/unit%20%2F%20%E4%B8%AD%E6%96%87/harness");
  assert.equal(url.searchParams.get("cwd"), body.cwd);
  assert.equal(url.searchParams.get("limit"), "100");
  assert.deepEqual(JSON.parse(url.searchParams.get("cursor")), cursor);
  assert.equal(init.method, "GET");
  assert.equal(init.body, undefined);
  assert.equal(init.headers, undefined);
});

test("initial read and explicit refresh omit cursor and let the Host own the default page size", async () => {
  const calls = [];
  const client = new LingDaemonClient({ fetch: async input => { calls.push(new URL(String(input))); return Response.json({ items: [] }); } });
  await client.getWorkUnitHarnessDiagnostics("/repo", "unit");
  await client.getWorkUnitHarnessDiagnostics("/repo", "unit", { limit: 500 });
  assert.equal(calls[0].searchParams.get("cursor"), null);
  assert.equal(calls[0].searchParams.get("limit"), null);
  assert.equal(calls[1].searchParams.get("cursor"), null);
  assert.equal(calls[1].searchParams.get("limit"), "500");
});

test("structured cold-workspace and invalid-cursor failures stay visible to the safe UI adapter", async () => {
  for (const [status, code] of [[503, "harness_workspace_uninitialized"], [400, "harness_diagnostics_invalid_query"], [500, "harness_diagnostics_unavailable"]]) {
    const client = new LingDaemonClient({ fetch: async () => Response.json({ error: code, message: "SECRET_SENTINEL" }, { status }) });
    await assert.rejects(client.getWorkUnitHarnessDiagnostics("/repo", "unit"), error => error instanceof LingDaemonError && error.status === status && error.code === code);
  }
});

test("read-only diagnostic transport does not attach the computer-use authorization token", async () => {
  let request;
  const client = new LingDaemonClient({ computerUseRouteToken: "TOKEN_SENTINEL", fetch: async (input, init) => {
    request = { input: String(input), init };
    return Response.json({ items: [] });
  } });
  await client.getWorkUnitHarnessDiagnostics("/repo", "unit", { cursor });
  assert.ok(!JSON.stringify(request).includes("TOKEN_SENTINEL"));
  assert.equal(request.init.method, "GET");
});
