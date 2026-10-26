import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDaemonServer } from "../dist/index.js";

async function withDaemon(config, fn) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-bind-auth-"));
  const daemon = createDaemonServer({ ...config, defaultWorkspaceCwd: cwd });
  try {
    await daemon.start();
    const port = daemon.server.address().port;
    await fn(`http://127.0.0.1:${port}`, cwd);
  } finally {
    await daemon.stop().catch(() => {});
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

test("loopback binds start without an auth token", async () => {
  await withDaemon({ host: "127.0.0.1", port: 0 }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
  });
});

test("non-loopback binds are refused without an auth token", async () => {
  const daemon = createDaemonServer({ host: "0.0.0.0", port: 0 });
  await assert.rejects(daemon.start(), /daemon_bind_refused/u);
  await daemon.stop().catch(() => {});
});

test("auth token protects routes while /health stays open", async () => {
  process.env.LING_NOTIFICATIONS_POLL_WAIT_MS = "200";
  await withDaemon({ host: "127.0.0.1", port: 0, authToken: "secret-token" }, async (baseUrl) => {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);

    const unauthorized = await fetch(`${baseUrl}/notifications`);
    assert.equal(unauthorized.status, 401);
    const body = await unauthorized.json();
    assert.equal(body.error, "unauthorized");

    const wrongToken = await fetch(`${baseUrl}/notifications`, {
      headers: { authorization: "Bearer wrong-token" },
    });
    assert.equal(wrongToken.status, 401);

    const authorized = await fetch(`${baseUrl}/notifications`, {
      headers: { authorization: "Bearer secret-token" },
    });
    assert.equal(authorized.status, 200);
  });
});
