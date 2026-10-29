import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDaemonServer } from "../dist/index.js";

async function withDaemon(fn) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-notifications-api-"));
  const home = await mkdtemp(join(tmpdir(), "ling-notifications-home-"));
  process.env.LING_STACK_HOME = home;
  process.env.LING_NOTIFICATIONS_POLL_WAIT_MS = "800";
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd });
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
