import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { createDaemonServer } from "../dist/index.js";
import { allowLocalServiceRequest } from "../dist/shared/local-workspace-access.js";

async function withDaemon(fn, options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-notifications-api-"));
  const home = await mkdtemp(join(tmpdir(), "ling-notifications-home-"));
  process.env.LING_STACK_HOME = home;
  process.env.LING_NOTIFICATIONS_POLL_WAIT_MS = "800";
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd, ...options });
  try {
    await daemon.start();
    const port = daemon.server.address().port;
    await fn(`http://127.0.0.1:${port}`, cwd);
  } finally {
    await daemon.stop().catch(() => {});
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
}

test("notification preferences round-trip through the API with validation", async () => {
  await withDaemon(async (baseUrl) => {
    const initial = await (await fetch(`${baseUrl}/notifications/preferences`)).json();
    assert.equal(initial.schemaVersion, 1);
    assert.equal(initial.preferences.globalEnabled, true);

    const updated = await fetch(`${baseUrl}/notifications/preferences`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ globalEnabled: false, events: { automation_run_finished: "all" }, quietHours: { start: "22:00", end: "08:00" } }),
    });
    assert.equal(updated.status, 200);
    const body = await updated.json();
    assert.equal(body.preferences.globalEnabled, false);
    assert.equal(body.preferences.events.automation_run_finished, "all");
    assert.equal(body.preferences.quietHours.start, "22:00");

    const rejected = await fetch(`${baseUrl}/notifications/preferences`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: { automation_run_finished: "sometimes" } }),
    });
    assert.equal(rejected.status, 400);

    const malformed = await fetch(`${baseUrl}/notifications/preferences`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quietHours: { start: "25:00", end: "08:00" } }),
    });
    assert.equal(malformed.status, 400);
  });
});

test("notification list and stream return journal records with cursor", async () => {
  await withDaemon(async (baseUrl) => {
    const empty = await (await fetch(`${baseUrl}/notifications`)).json();
    assert.deepEqual(empty.notifications, []);
    // Stream with no records waits; use a short fetch timeout to prove it
    // holds the connection rather than erroring.
    const streamStarted = Date.now();
    const streamResponse = await fetch(`${baseUrl}/notifications/stream`);
    assert.equal(streamResponse.status, 200);
    const streamBody = await streamResponse.json();
    assert.deepEqual(streamBody.notifications, []);
    assert.ok(Date.now() - streamStarted > 500, "stream should wait before returning empty window");
    assert.equal(typeof streamBody.nextSince, "string");
  });
});

test("notification routes reject unsupported methods", async () => {
  await withDaemon(async (baseUrl) => {
    const deleted = await fetch(`${baseUrl}/notifications`, { method: "DELETE" });
    assert.equal(deleted.status, 405);
  });
});

test("user-level notification and IM routes reject foreign browsers before reading or mutating", async () => {
  await withDaemon(async (baseUrl) => {
    for (const [path, method, body] of [
      ["/notifications", "GET"], ["/notifications/stream", "GET"],
      ["/startup/status", "GET"], ["/startup/refresh", "POST", {}],
      ["/diagnostics/doctor", "GET"], ["/diagnostics/logs", "GET"],
      ["/skills/marketplace/inspect?url=https%3A%2F%2Fexample.invalid%2Findex.json", "GET"],
      ["/notifications/preferences", "GET"],
      ["/notifications/preferences", "PATCH", { globalEnabled: false }],
      ["/im-destinations", "GET"],
      ["/im-destinations", "POST", { label: "foreign", provider: "slack", webhookRef: "env:SYNTHETIC" }],
      ["/im-destinations/synthetic", "PATCH", { enabled: false }],
      ["/im-destinations/synthetic", "DELETE"],
      ["/im-destinations/synthetic/test", "POST", {}],
    ]) {
      const response = await fetch(`${baseUrl}${path}`, {
        method, headers: { origin: "https://foreign.example", "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.equal((await response.json()).error, "local_service_forbidden");
    }
    const preferences = await (await fetch(`${baseUrl}/notifications/preferences`)).json();
    assert.equal(preferences.preferences.globalEnabled, true);
    assert.deepEqual((await (await fetch(`${baseUrl}/im-destinations`)).json()).destinations, []);
    assert.equal((await fetch(`${baseUrl}/notifications`, { headers: { origin: "http://localhost:5173" } })).status, 200);
  });
});

test("local service transport rejects rebinding, forwarding and missing browser Origin", () => {
  for (const patch of [
    { peer: "192.168.1.2" }, { headers: { host: "foreign.example:17891" } },
    { headers: { host: "127.0.0.1:17892" } }, { headers: { origin: "null" } },
    { headers: { origin: "http://localhost:5173/" } },
    { headers: { origin: "https://foreign.example" } },
    { headers: { forwarded: "for=127.0.0.1" } }, { headers: { "x-forwarded-host": "localhost" } },
    { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" } },
    { headers: { "sec-fetch-mode": "navigate" } },
  ]) {
    let status;
    const response = { setHeader: () => {}, writeHead: (code) => { status = code; }, end: () => {} };
    const request = { headers: { host: "127.0.0.1:17891", ...patch.headers },
      socket: { remoteAddress: patch.peer ?? "127.0.0.1", localPort: 17891 } };
    assert.equal(allowLocalServiceRequest(request, response), false, JSON.stringify(patch));
    assert.equal(status, 403);
  }
});

test("service transport checks apply to actual HTTP requests", async () => {
  await withDaemon(async (baseUrl) => {
    for (const headers of [
      { host: "foreign.example:17891" }, { forwarded: "for=127.0.0.1" },
      { "sec-fetch-site": "cross-site" }, { origin: "null" },
    ]) {
      for (const path of ["/notifications", "/im-destinations"]) {
        const status = await new Promise((resolve, reject) => {
          // Node fetch rewrites Host. Use the HTTP transport to exercise the exact wire header.
          const request = httpRequest(`${baseUrl}${path}`, { headers }, (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode));
          });
          request.once("error", reject);
          request.end();
        });
        assert.equal(status, 403, JSON.stringify(headers));
      }
    }
  });
});

test("authenticated self-host service access keeps the existing bearer authority", async () => {
  const authToken = "synthetic-notifications-service-token";
  await withDaemon(async (baseUrl) => {
    for (const path of ["/notifications", "/im-destinations"]) {
      assert.equal((await fetch(`${baseUrl}${path}`, { headers: { origin: "https://self-host.example" } })).status, 401);
      assert.equal((await fetch(`${baseUrl}${path}`, { headers: {
        origin: "https://self-host.example", authorization: `Bearer ${authToken}`,
      } })).status, 200);
    }
  }, { authToken });
});
