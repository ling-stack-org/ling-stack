import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { handleWorkSummary } from "../dist/features/work-summary/routes.js";

const cwd = "/work-summary-trusted-project";
const noSecrets = { resolve: () => ({ configured: false }) };

async function routeServer(t, registry) {
  const server = createServer((request, response) => {
    void handleWorkSummary(request, response, new URL(request.url, "http://127.0.0.1"), registry, noSecrets)
      .catch((error) => {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "unexpected_route_failure", message: error.message }));
      });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  return async (path, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      ...options,
      signal: AbortSignal.timeout(3000),
    });
    return { status: response.status, body: await response.json() };
  };
}

// Value: protects=route validation and authorization precede store access;
// fails_when=missing cwd, remote origin or unknown roots reach a project store;
// why_new=existing access-helper tests never exercise this route; seam=none;
// no_claim=full daemon router authentication or production filesystem trust.
test("work summary rejects missing cwd and forbidden requests before accessing a store", async (t) => {
  const calls = { trust: 0, initialized: 0, initialize: 0 };
  const request = await routeServer(t, {
    isTrustedWorkspaceRoot(root) { calls.trust++; return root === cwd; },
    getInitializedStore() { calls.initialized++; throw new Error("Forbidden request accessed a store"); },
    getStore() { calls.initialize++; throw new Error("Forbidden request initialized a store"); },
  });

  const missing = await request("/workspace/work-summary");
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, "bad_request");
  assert.deepEqual(calls, { trust: 0, initialized: 0, initialize: 0 });

  for (const method of ["GET", "POST", "DELETE"]) {
    const path = method === "GET" ? "/workspace/work-summary" : "/workspace/work-summary/pull-requests";
    const remote = await request(`${path}?cwd=${encodeURIComponent(cwd)}`, {
      method, headers: { Origin: "https://example.com" },
    });
    assert.equal(remote.status, 403, method);
    assert.equal(remote.body.error, "forbidden_origin", method);
    assert.deepEqual(calls, { trust: 0, initialized: 0, initialize: 0 });

    const untrusted = await request(`${path}?cwd=${encodeURIComponent("/unknown-project")}`, {
      method, headers: { Origin: "http://127.0.0.1:4174" },
    });
    assert.equal(untrusted.status, 403, method);
    assert.equal(untrusted.body.error, "workspace_not_trusted", method);
    assert.equal(calls.initialized, 0);
    assert.equal(calls.initialize, 0);
    calls.trust = 0;
  }
});

// Value: protects=unopened trusted projects remain unopened on summary reads/writes;
// fails_when=the route substitutes getStore or continues after a missing initialized store;
// why_new=service tests supply a store and cannot observe registry initialization; seam=none;
// no_claim=other daemon routes or real store startup and shutdown behavior.
test("work summary returns 404 for an unopened trusted project without initializing it", async (t) => {
  const calls = { initialized: [], initialize: 0 };
  const request = await routeServer(t, {
    isTrustedWorkspaceRoot(root) { return root === cwd; },
    getInitializedStore(root) { calls.initialized.push(root); return undefined; },
    getStore() { calls.initialize++; throw new Error("Summary must not initialize stores"); },
  });

  for (const method of ["GET", "POST", "DELETE"]) {
    const path = method === "GET" ? "/workspace/work-summary" : "/workspace/work-summary/pull-requests";
    const response = await request(`${path}?cwd=${encodeURIComponent(cwd)}`, { method });
    assert.equal(response.status, 404, method);
    assert.equal(response.body.error, "workspace_not_loaded", method);
  }
  assert.deepEqual(calls.initialized, [cwd, cwd, cwd]);
  assert.equal(calls.initialize, 0);
});

// Value: protects=malformed PR inputs never mutate attachments, while valid URLs normalize;
// fails_when=body/URL checks are removed, loosened or reject valid GitHub PR URLs;
// why_new=pure URL and storage tests do not exercise the HTTP parse-to-mutation boundary; seam=none;
// no_claim=GitHub connectivity or external account authorization.
test("work summary validates PR bodies and URLs before attachment mutations", async (t) => {
  const calls = { attached: [], detached: [] };
  const store = {
    attachWorkSummaryPullRequest(url, now) { calls.attached.push({ url, now }); },
    detachWorkSummaryPullRequest(url) { calls.detached.push(url); },
  };
  const request = await routeServer(t, {
    isTrustedWorkspaceRoot(root) { return root === cwd; },
    getInitializedStore() { return store; },
    getStore() { assert.fail("Summary must not initialize stores"); },
  });
  const path = `/workspace/work-summary/pull-requests?cwd=${encodeURIComponent(cwd)}`;
  const bodies = ["", "{", "null", "[]", "{}", '{"url":42}',
    JSON.stringify({ url: "https://example.com/owner/repo/pull/1" }),
    JSON.stringify({ url: "https://user@github.com/owner/repo/pull/1" }),
    JSON.stringify({ url: "https://github.com/owner/repo/pull/0" }),
    JSON.stringify({ url: "https://github.com/owner/repo/pull/1", padding: "x".repeat(4096) })];
  for (const body of bodies) {
    const response = await request(path, { method: "POST", body, headers: { "Content-Type": "application/json" } });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, "work_summary_failed");
    assert.deepEqual(calls, { attached: [], detached: [] });
  }
  const invalidDelete = await request(`${path}&url=${encodeURIComponent("https://example.com/a/b/pull/1")}`, { method: "DELETE" });
  assert.equal(invalidDelete.status, 400);
  assert.equal(invalidDelete.body.error, "work_summary_failed");
  assert.deepEqual(calls, { attached: [], detached: [] });

  const validUrl = "https://github.com/Owner/Repo/pull/7?tab=files#top";
  const attached = await request(path, { method: "POST", body: JSON.stringify({ url: validUrl }) });
  assert.equal(attached.status, 200);
  assert.deepEqual(attached.body, { ok: true });
  assert.equal(calls.attached.length, 1);
  assert.equal(calls.attached[0].url, "https://github.com/owner/repo/pull/7");
  assert.ok(Number.isFinite(Date.parse(calls.attached[0].now)));
  const detached = await request(`${path}&url=${encodeURIComponent(validUrl)}`, { method: "DELETE" });
  assert.equal(detached.status, 200);
  assert.deepEqual(calls.detached, ["https://github.com/owner/repo/pull/7"]);
});
