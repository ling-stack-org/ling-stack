import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createDaemonServer } from "../dist/index.js";

const COMPUTER_USE_ROUTE_TOKEN = "computer-use-route-test-token-0123456789";

test("Computer Use registry ignores stale updates and replays ordered events", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-computer-use-registry-"));
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    { computerUseProjectionOptions: { now: () => new Date("2026-07-15T00:10:00.000Z") } },
  );
  try {
    const current = projection({ status: "running", updatedAt: "2026-07-15T00:02:00.000Z", revision: 2 });
    daemon.computerUsePreviews.upsert(cwd, current);
    daemon.computerUsePreviews.upsert(cwd, projection({ status: "starting", updatedAt: "2026-07-15T00:01:00.000Z", revision: 1 }));

    assert.equal(daemon.computerUsePreviews.get(cwd, current.sessionId).status, "running");
    assert.equal(daemon.computerUsePreviews.get(cwd, current.sessionId).preview.revision, 2);
    assert.equal(daemon.computerUsePreviews.listEvents(cwd).events.length, 1);

    daemon.computerUsePreviews.upsert(cwd, projection({ status: "succeeded", updatedAt: "2026-07-15T00:03:00.000Z", revision: 2 }));
    daemon.computerUsePreviews.upsert(cwd, projection({ status: "running", updatedAt: "2026-07-15T00:04:00.000Z", revision: 3 }));
    assert.equal(daemon.computerUsePreviews.get(cwd, current.sessionId).status, "succeeded");
    assert.deepEqual(daemon.computerUsePreviews.listEvents(cwd).events.map((event) => event.seq), [1, 2]);
  } finally {
    await daemon.stop().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Computer Use registry does not let a same-time higher revision regress runtime state", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-computer-use-monotonic-"));
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd });
  try {
    daemon.computerUsePreviews.upsert(cwd, projection({ status: "running", revision: 1 }));
    daemon.computerUsePreviews.upsert(cwd, projection({ status: "starting", revision: 2 }));
    assert.equal(daemon.computerUsePreviews.get(cwd, "session-1").status, "running");
    assert.equal(daemon.computerUsePreviews.get(cwd, "session-1").preview.revision, 1);
  } finally {
    await daemon.stop().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Computer Use registry exposes one atomic snapshot and replay boundary", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-computer-use-boundary-"));
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd });
  try {
    daemon.computerUsePreviews.upsert(cwd, projection({ status: "running" }));
    const snapshot = daemon.computerUsePreviews.snapshot(cwd);
    assert.equal(snapshot.latestSeq, 1);
    assert.equal(snapshot.projections[0].status, "running");

    const live = [];
    const replay = daemon.computerUsePreviews.subscribeFrom(cwd, snapshot.latestSeq, (event) => live.push(event));
    daemon.computerUsePreviews.upsert(cwd, projection({
      status: "paused",
      updatedAt: "2026-07-15T00:02:00.000Z",
    }));

    assert.deepEqual(replay.events, []);
    assert.deepEqual(live.map((event) => [event.seq, event.projection?.status]), [[2, "paused"]]);
    replay.subscription.close();
  } finally {
    await daemon.stop().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Computer Use SSE subscribes before replay and receives a boundary event", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-computer-use-stream-boundary-"));
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd });
  const subscribeFrom = daemon.computerUsePreviews.subscribeFrom.bind(daemon.computerUsePreviews);
  let boundaryEventScheduled = false;
  daemon.computerUsePreviews.subscribeFrom = (...args) => {
    const replay = subscribeFrom(...args);
    if (!boundaryEventScheduled) {
      boundaryEventScheduled = true;
      queueMicrotask(() => {
        daemon.computerUsePreviews.upsert(cwd, projection({ status: "running" }));
      });
    }
    return replay;
  };

  await daemon.start();
  const controller = new AbortController();
  try {
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/computer-use/stream?cwd=${encodeURIComponent(cwd)}&afterSeq=0`,
      {
        headers: { Origin: "http://127.0.0.1:5173" },
        signal: controller.signal,
      },
    );
    assert.equal(response.ok, true);
    const event = await withTimeout(readComputerUseEvent(response.body), 1_000);
    assert.equal(event.seq, 1);
    assert.equal(event.projection.status, "running");
  } finally {
    controller.abort();
    await daemon.stop().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Computer Use HTTP projection and Stop wait for runtime acknowledgement", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-computer-use-api-"));
  const stopRequests = [];
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    {
      desktopBridgeToken: "desktop-bridge-test-token-0123456789",
      computerUseRouteToken: COMPUTER_USE_ROUTE_TOKEN,
      computerUseStop: async (input) => {
        stopRequests.push(input);
        return { accepted: true, acknowledged: true };
      },
    },
  );
  await daemon.start();
  try {
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    daemon.computerUsePreviews.upsert(cwd, projection({ status: "running" }));
    daemon.computerUsePreviews.registerPrivateDescriptor(cwd, {
      descriptorId: "opaque-preview-1",
      revision: 1,
      platform: "macos",
      sourceKind: "window",
      target: { processId: 4321, nativeWindowId: "7788", applicationId: "com.example.browser" },
      authorization: { grantId: "grant-1", expiresAt: "2099-01-01T00:00:00.000Z" },
    });

    const remoteList = await fetch(`${baseUrl}/computer-use/sessions?cwd=${encodeURIComponent(cwd)}`, {
      headers: { Origin: "https://remote.example" },
    });
    assert.equal(remoteList.status, 403);
    assert.equal(remoteList.headers.get("access-control-allow-origin"), null);

    const remoteStop = await fetch(`${baseUrl}/computer-use/sessions/session-1/stop?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://remote.example" },
      body: "{}",
    });
    assert.equal(remoteStop.status, 403);

    const missingHandshakeToken = await fetch(`${baseUrl}/computer-use/desktop-bridge/handshake`);
    assert.equal(missingHandshakeToken.status, 403);
    const remoteHandshake = await fetch(`${baseUrl}/computer-use/desktop-bridge/handshake`, {
      headers: {
        Origin: "https://remote.example",
        "X-Ling-Desktop-Bridge-Token": "desktop-bridge-test-token-0123456789",
      },
    });
    assert.equal(remoteHandshake.status, 403);
    const handshake = await fetch(`${baseUrl}/computer-use/desktop-bridge/handshake`, {
      headers: { "X-Ling-Desktop-Bridge-Token": "desktop-bridge-test-token-0123456789" },
    });
    assert.equal(handshake.status, 200);
    assert.deepEqual(await handshake.json(), {
      protocolVersion: 1,
      capabilities: ["preview-source"],
      bridgeTokenAccepted: true,
    });
    assert.equal(handshake.headers.get("access-control-allow-origin"), null);
    assert.equal(handshake.headers.get("cache-control"), "no-store");

    const listed = await getJson(`${baseUrl}/computer-use/sessions?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.projections.length, 1);
    assert.equal(listed.projections[0].preview.descriptorId, "opaque-preview-1");
    assert.equal(JSON.stringify(listed).includes("window_id"), false);
    assert.equal(JSON.stringify(listed).includes("7788"), false);
    const snapshot = await getJson(`${baseUrl}/computer-use/snapshot?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(snapshot.latestSeq, 1);
    assert.equal(snapshot.projections[0].status, "running");

    const forbidden = await fetch(`${baseUrl}/computer-use/sessions/session-1/source?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(forbidden.status, 403);
    const privateSource = await fetch(`${baseUrl}/computer-use/sessions/session-1/source?cwd=${encodeURIComponent(cwd)}`, {
      headers: { "X-Ling-Desktop-Bridge-Token": "desktop-bridge-test-token-0123456789" },
    });
    assert.equal(privateSource.ok, true);
    const descriptor = await privateSource.json();
    assert.equal(descriptor.target.nativeWindowId, "7788");
    assert.equal(privateSource.headers.get("access-control-allow-origin"), null);
    assert.equal(privateSource.headers.get("cache-control"), "no-store");

    const stopped = await postJson(
      `${baseUrl}/computer-use/sessions/session-1/stop?cwd=${encodeURIComponent(cwd)}`,
      { reason: "operator_requested" },
    );
    assert.equal(stopped.accepted, true);
    assert.equal(stopped.acknowledged, true);
    assert.equal(stopped.projection.status, "cancelled");
    assert.equal(typeof stopped.auditId, "string");
    assert.equal(stopRequests.length, 1);
    assert.equal(stopRequests[0].projection.status, "stopping");

    const events = await getJson(`${baseUrl}/computer-use/events?cwd=${encodeURIComponent(cwd)}&afterSeq=0`);
    assert.deepEqual(events.events.map((event) => event.projection?.status), ["running", "stopping", "cancelled"]);
    const audits = daemon.computerUsePreviews.listStopAudits(cwd, "session-1");
    assert.equal(audits[0].acknowledged, true);
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Computer Use Stop restores the active projection when runtime acknowledgement is missing", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-computer-use-stop-timeout-"));
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    {
      computerUseRouteToken: COMPUTER_USE_ROUTE_TOKEN,
      computerUseStop: async () => ({
        accepted: true,
        acknowledged: false,
        reason: "computer_use_stop_ack_timeout",
      }),
    },
  );
  await daemon.start();
  try {
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    daemon.computerUsePreviews.upsert(cwd, projection({ status: "running" }));

    const response = await fetch(
      `${baseUrl}/computer-use/sessions/session-1/stop?cwd=${encodeURIComponent(cwd)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Ling-Computer-Use-Token": COMPUTER_USE_ROUTE_TOKEN,
        },
        body: JSON.stringify({ reason: "operator_requested" }),
      },
    );
    assert.equal(response.status, 504);
    const result = await response.json();
    assert.equal(result.accepted, true);
    assert.equal(result.acknowledged, false);
    assert.equal(result.reason, "computer_use_stop_ack_timeout");
    assert.equal(result.projection.status, "running");
    assert.equal(daemon.computerUsePreviews.get(cwd, "session-1")?.status, "running");

    const events = await getJson(`${baseUrl}/computer-use/events?cwd=${encodeURIComponent(cwd)}&afterSeq=0`);
    assert.deepEqual(events.events.map((event) => event.projection?.status), ["running", "stopping", "running"]);
    const audits = daemon.computerUsePreviews.listStopAudits(cwd, "session-1");
    assert.equal(audits[0].accepted, true);
    assert.equal(audits[0].acknowledged, false);
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Computer Use desktop bridge handshake reports an unavailable token", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-computer-use-handshake-"));
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd });
  await daemon.start();
  try {
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/computer-use/desktop-bridge/handshake`, {
      headers: { "X-Ling-Desktop-Bridge-Token": "unconfigured-token" },
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).error, "desktop_bridge_unavailable");
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Computer Use native projection routes require the scoped token when Origin is absent", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-computer-use-route-auth-"));
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    { computerUseRouteToken: COMPUTER_USE_ROUTE_TOKEN },
  );
  await daemon.start();
  try {
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const path = `/computer-use/sessions?cwd=${encodeURIComponent(cwd)}`;

    const missing = await fetch(`${baseUrl}${path}`);
    assert.equal(missing.status, 403);
    assert.equal((await missing.json()).error, "computer_use_route_unauthorized");

    const wrong = await fetch(`${baseUrl}${path}`, {
      headers: { "X-Ling-Computer-Use-Token": "wrong-token" },
    });
    assert.equal(wrong.status, 403);

    const accepted = await fetch(`${baseUrl}${path}`, {
      headers: { "X-Ling-Computer-Use-Token": COMPUTER_USE_ROUTE_TOKEN },
    });
    assert.equal(accepted.status, 200);

    const browser = await fetch(`${baseUrl}${path}`, {
      headers: { Origin: "http://localhost:5173" },
    });
    assert.equal(browser.status, 200);

    const remoteWithToken = await fetch(`${baseUrl}${path}`, {
      headers: {
        Origin: "http://evil.example",
        "X-Ling-Computer-Use-Token": COMPUTER_USE_ROUTE_TOKEN,
      },
    });
    assert.equal(remoteWithToken.status, 403);
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Computer Use native projection routes fail closed when no route token is configured", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-computer-use-route-auth-missing-"));
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd });
  await daemon.start();
  try {
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/computer-use/snapshot?cwd=${encodeURIComponent(cwd)}`,
    );
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "computer_use_route_auth_unavailable");
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

function projection(overrides = {}) {
  const revision = overrides.revision ?? 1;
  return {
    sessionId: "session-1",
    conversationId: "conversation-1",
    runId: "run-1",
    status: overrides.status ?? "running",
    target: {
      kind: "window",
      displayName: "Example Browser",
      applicationId: "com.example.browser",
    },
    preview: {
      descriptorId: "opaque-preview-1",
      revision,
      aspectRatio: 1.6,
      cursorAvailable: true,
    },
    startedAt: "2026-07-15T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-07-15T00:01:00.000Z",
    ...(overrides.status === "succeeded" ? { terminalAt: overrides.updatedAt } : {}),
  };
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { "X-Ling-Computer-Use-Token": COMPUTER_USE_ROUTE_TOKEN },
  });
  if (!response.ok) {
    assert.fail(await response.text());
  }
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Ling-Computer-Use-Token": COMPUTER_USE_ROUTE_TOKEN,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    assert.fail(await response.text());
  }
  return response.json();
}

async function readComputerUseEvent(stream) {
  assert.ok(stream);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        assert.fail("Computer Use stream ended before an event arrived.");
      }
      buffer += decoder.decode(result.value, { stream: true }).replaceAll("\r\n", "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const eventLine = block.split("\n").find((line) => line.startsWith("event:"));
        const dataLine = block.split("\n").find((line) => line.startsWith("data:"));
        if (eventLine?.slice("event:".length).trim() === "computer_use_event" && dataLine) {
          return JSON.parse(dataLine.slice("data:".length).trim());
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function withTimeout(promise, milliseconds) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Timed out waiting for Computer Use stream event")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
