import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createDaemonServer } from "../dist/index.js";
import {
  addLegacyCuaProviderOwner,
  createCapturedStoreFactory,
  seedManagedCuaProvider,
} from "./computer-use-test-fixtures.mjs";

const COMPUTER_USE_ROUTE_TOKEN = "computer-use-route-test-token-0123456789";
const supportedDesktopPlatform = process.platform === "darwin" || process.platform === "win32";

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

test("Computer Use registry and HTTP sequence boundaries reject unsafe integers", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-computer-use-safe-integers-"));
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    { computerUseRouteToken: COMPUTER_USE_ROUTE_TOKEN },
  );
  try {
    assert.throws(
      () => daemon.computerUsePreviews.upsert(cwd, projection({
        revision: Number.MAX_SAFE_INTEGER + 1,
      })),
      /non-negative revision/u,
    );
    assert.throws(
      () => daemon.computerUsePreviews.registerPrivateDescriptor(cwd, privateDescriptor({
        revision: Number.MAX_SAFE_INTEGER + 1,
      })),
      /identity is invalid/u,
    );

    await daemon.start();
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/computer-use/events?cwd=${encodeURIComponent(cwd)}&afterSeq=${Number.MAX_SAFE_INTEGER + 1}`,
      { headers: { "X-Ling-Computer-Use-Token": COMPUTER_USE_ROUTE_TOKEN } },
    );
    assert.equal(response.status, 400);
    assert.match((await response.json()).message, /afterSeq must be an integer/u);
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

test("Computer Use sessions canonicalizes a relative workspace cwd", async () => {
  const cwd = resolve(".");
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    { computerUseRouteToken: COMPUTER_USE_ROUTE_TOKEN },
  );
  daemon.computerUsePreviews.upsert(cwd, projection({ status: "running" }));
  await daemon.start();
  try {
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/computer-use/sessions?cwd=.`,
      { headers: { "X-Ling-Computer-Use-Token": COMPUTER_USE_ROUTE_TOKEN } },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.cwd, cwd);
    assert.equal(body.projections[0].sessionId, "session-1");
  } finally {
    await daemon.stop().catch(() => undefined);
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
  const { capture, storeFactory } = createCapturedStoreFactory();
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    {
      desktopBridgeToken: "desktop-bridge-test-token-0123456789",
      computerUseRouteToken: COMPUTER_USE_ROUTE_TOKEN,
      computerUseStop: async (input) => {
        stopRequests.push(input);
        return { accepted: true, acknowledged: true };
      },
      storeFactory,
      mcpBroker: {
        async callTool(_server, _options, toolName, input) {
          assert.equal(toolName, "list_windows");
          assert.deepEqual(input, { pid: 4321 });
          return {
            content: [],
            details: {
              structuredContent: {
                windows: [{ pid: 4321, window_id: "7788" }],
              },
            },
          };
        },
      },
    },
  );
  await daemon.start();
  try {
    assert.ok(capture.store);
    seedManagedCuaProvider(capture.store);
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
    const handshakeBody = await handshake.json();
    assert.equal(handshakeBody.protocolVersion, 1);
    assert.deepEqual(handshakeBody.capabilities, ["preview-source", "cua-driver-lease-v1"]);
    assert.equal(handshakeBody.bridgeTokenAccepted, true);
    assert.equal(handshakeBody.routeTokenAccepted, false);
    assert.equal(handshakeBody.defaultWorkspaceCwd, cwd);
    assert.equal(typeof handshakeBody.daemonAuthorityEpoch, "string");
    assert.equal(typeof handshakeBody.bridgeConnectionId, "string");
    assert.equal(handshakeBody.desktopInstanceEpoch, 1);
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

test("Computer Use Stop restores the active projection when the runtime owner throws", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-computer-use-stop-error-"));
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    {
      computerUseRouteToken: COMPUTER_USE_ROUTE_TOKEN,
      computerUseStop: async () => {
        throw new Error("runtime owner disconnected");
      },
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
    assert.equal(response.status, 409);
    const result = await response.json();
    assert.equal(result.accepted, false);
    assert.equal(result.acknowledged, false);
    assert.equal(result.reason, "computer_use_stop_handler_failed");
    assert.equal(result.projection.status, "running");
    assert.equal(daemon.computerUsePreviews.get(cwd, "session-1")?.status, "running");

    const events = await getJson(`${baseUrl}/computer-use/events?cwd=${encodeURIComponent(cwd)}&afterSeq=0`);
    assert.deepEqual(events.events.map((event) => event.projection?.status), ["running", "stopping", "running"]);
    const audits = daemon.computerUsePreviews.listStopAudits(cwd, "session-1");
    assert.equal(audits[0].accepted, false);
    assert.equal(audits[0].acknowledged, false);
    assert.equal(audits[0].resultReason, "computer_use_stop_handler_failed");
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("concurrent Computer Use Stop requests invoke the runtime owner only once", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-computer-use-stop-single-flight-"));
  let stopCalls = 0;
  let releaseStop;
  const stopStarted = new Promise((resolveStarted) => {
    releaseStop = resolveStarted;
  });
  let allowStop;
  const stopAllowed = new Promise((resolveAllowed) => {
    allowStop = resolveAllowed;
  });
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    {
      computerUseRouteToken: COMPUTER_USE_ROUTE_TOKEN,
      computerUseStop: async () => {
        stopCalls += 1;
        releaseStop();
        await stopAllowed;
        return { accepted: true, acknowledged: true };
      },
    },
  );
  await daemon.start();
  try {
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/computer-use/sessions/session-1/stop?cwd=${encodeURIComponent(cwd)}`;
    daemon.computerUsePreviews.upsert(cwd, projection({ status: "running" }));
    const first = fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ling-Computer-Use-Token": COMPUTER_USE_ROUTE_TOKEN,
      },
      body: "{}",
    });
    await stopStarted;
    const second = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ling-Computer-Use-Token": COMPUTER_USE_ROUTE_TOKEN,
      },
      body: "{}",
    });
    assert.equal(second.status, 409);
    assert.equal((await second.json()).error, "computer_use_session_stopping");

    allowStop();
    assert.equal((await first).status, 200);
    assert.equal(stopCalls, 1);
    assert.equal(daemon.computerUsePreviews.listStopAudits(cwd, "session-1").length, 1);
  } finally {
    allowStop?.();
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Computer Use Stop remains single-flight when a newer running revision replaces stopping", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-computer-use-stop-revision-single-flight-"));
  let stopCalls = 0;
  let stoppingUpdatedAt;
  let releaseStopStarted;
  const stopStarted = new Promise((resolveStarted) => {
    releaseStopStarted = resolveStarted;
  });
  let allowStop;
  const stopAllowed = new Promise((resolveAllowed) => {
    allowStop = resolveAllowed;
  });
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    {
      computerUseRouteToken: COMPUTER_USE_ROUTE_TOKEN,
      computerUseStop: async ({ projection: stoppingProjection }) => {
        stopCalls += 1;
        stoppingUpdatedAt = stoppingProjection.updatedAt;
        releaseStopStarted();
        await stopAllowed;
        return { accepted: true, acknowledged: true };
      },
    },
  );
  await daemon.start();
  try {
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/computer-use/sessions/session-1/stop?cwd=${encodeURIComponent(cwd)}`;
    daemon.computerUsePreviews.upsert(cwd, projection({ status: "running", revision: 1 }));

    const first = fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ling-Computer-Use-Token": COMPUTER_USE_ROUTE_TOKEN,
      },
      body: "{}",
    });
    await stopStarted;
    assert.equal(typeof stoppingUpdatedAt, "string");
    daemon.computerUsePreviews.upsert(cwd, projection({
      status: "running",
      revision: 2,
      updatedAt: new Date(Date.parse(stoppingUpdatedAt) + 1).toISOString(),
    }));

    const second = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ling-Computer-Use-Token": COMPUTER_USE_ROUTE_TOKEN,
      },
      body: "{}",
    });
    assert.equal(second.status, 409);
    assert.equal((await second.json()).error, "computer_use_session_stopping");
    assert.equal(stopCalls, 1);

    allowStop();
    assert.equal((await first).status, 200);
    assert.equal(stopCalls, 1);
    assert.equal(daemon.computerUsePreviews.listStopAudits(cwd, "session-1").length, 1);
  } finally {
    allowStop?.();
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Computer Use Stop acknowledgement preserves a newer preview revision", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-computer-use-stop-revision-race-"));
  let releaseStopStarted;
  const stopStarted = new Promise((resolveStarted) => {
    releaseStopStarted = resolveStarted;
  });
  let allowStopAcknowledgement;
  const stopAcknowledgementAllowed = new Promise((resolveAllowed) => {
    allowStopAcknowledgement = resolveAllowed;
  });
  let stoppingUpdatedAt;
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    {
      computerUseRouteToken: COMPUTER_USE_ROUTE_TOKEN,
      computerUseStop: async ({ projection: stoppingProjection }) => {
        stoppingUpdatedAt = stoppingProjection.updatedAt;
        releaseStopStarted();
        await stopAcknowledgementAllowed;
        return { accepted: true, acknowledged: true };
      },
    },
  );
  await daemon.start();
  try {
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/computer-use/sessions/session-1/stop?cwd=${encodeURIComponent(cwd)}`;
    daemon.computerUsePreviews.upsert(cwd, projection({ status: "running", revision: 1 }));

    const stopResponse = fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ling-Computer-Use-Token": COMPUTER_USE_ROUTE_TOKEN,
      },
      body: "{}",
    });
    await stopStarted;
    assert.equal(typeof stoppingUpdatedAt, "string");

    const newerProjection = projection({
      status: "running",
      revision: 2,
      updatedAt: new Date(Date.parse(stoppingUpdatedAt) + 1).toISOString(),
    });
    daemon.computerUsePreviews.upsert(cwd, newerProjection);
    while (Date.now() <= Date.parse(newerProjection.updatedAt)) {
      await new Promise((resolveNextTick) => setTimeout(resolveNextTick, 2));
    }
    allowStopAcknowledgement();

    const response = await stopResponse;
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.acknowledged, true);
    assert.equal(result.projection.status, "cancelled");
    assert.equal(result.projection.preview.revision, 2);
    assert.equal(result.projection.preview.descriptorId, newerProjection.preview.descriptorId);

    const finalProjection = daemon.computerUsePreviews.get(cwd, "session-1");
    assert.equal(finalProjection?.status, "cancelled");
    assert.equal(finalProjection?.preview?.revision, 2);
    assert.equal(finalProjection?.preview?.descriptorId, newerProjection.preview.descriptorId);

    const events = await getJson(
      `http://127.0.0.1:${address.port}/computer-use/events?cwd=${encodeURIComponent(cwd)}&afterSeq=0`,
      { "X-Ling-Computer-Use-Token": COMPUTER_USE_ROUTE_TOKEN },
    );
    assert.deepEqual(
      events.events.map((event) => [event.projection?.status, event.projection?.preview?.revision]),
      [
        ["running", 1],
        ["stopping", 1],
        ["running", 2],
        ["cancelled", 2],
      ],
    );
  } finally {
    allowStopAcknowledgement?.();
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Computer Use negative Stop acknowledgement restores activity without losing a newer revision", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-computer-use-stop-negative-revision-race-"));
  let releaseStopStarted;
  const stopStarted = new Promise((resolveStarted) => {
    releaseStopStarted = resolveStarted;
  });
  let allowStopResult;
  const stopResultAllowed = new Promise((resolveAllowed) => {
    allowStopResult = resolveAllowed;
  });
  let stoppingUpdatedAt;
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    {
      computerUseRouteToken: COMPUTER_USE_ROUTE_TOKEN,
      computerUseStop: async ({ projection: stoppingProjection }) => {
        stoppingUpdatedAt = stoppingProjection.updatedAt;
        releaseStopStarted();
        await stopResultAllowed;
        return { accepted: true, acknowledged: false, reason: "runtime_ack_timeout" };
      },
    },
  );
  await daemon.start();
  try {
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/computer-use/sessions/session-1/stop?cwd=${encodeURIComponent(cwd)}`;
    daemon.computerUsePreviews.upsert(cwd, projection({ status: "running", revision: 1 }));

    const stopResponse = fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ling-Computer-Use-Token": COMPUTER_USE_ROUTE_TOKEN,
      },
      body: "{}",
    });
    await stopStarted;
    const newerStopping = projection({
      status: "stopping",
      revision: 2,
      updatedAt: new Date(Date.parse(stoppingUpdatedAt) + 1).toISOString(),
    });
    daemon.computerUsePreviews.upsert(cwd, newerStopping);
    allowStopResult();

    const response = await stopResponse;
    assert.equal(response.status, 504);
    const result = await response.json();
    assert.equal(result.acknowledged, false);
    assert.equal(result.projection.status, "running");
    assert.equal(result.projection.preview.revision, 2);
    assert.equal(result.projection.preview.descriptorId, newerStopping.preview.descriptorId);
  } finally {
    allowStopResult?.();
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Computer Use Stop preserves an authoritative run terminal status", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-computer-use-stop-terminal-"));
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    {
      computerUseRouteToken: COMPUTER_USE_ROUTE_TOKEN,
      computerUseStop: async () => ({
        accepted: true,
        acknowledged: true,
        reason: "run_already_succeeded",
        terminalStatus: "succeeded",
      }),
    },
  );
  await daemon.start();
  try {
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    daemon.computerUsePreviews.upsert(cwd, projection({ status: "running" }));

    const result = await postJson(
      `${baseUrl}/computer-use/sessions/session-1/stop?cwd=${encodeURIComponent(cwd)}`,
      { reason: "operator_requested" },
      { "X-Ling-Computer-Use-Token": COMPUTER_USE_ROUTE_TOKEN },
    );
    assert.equal(result.acknowledged, true);
    assert.equal(result.reason, "run_already_succeeded");
    assert.equal(result.projection.status, "succeeded");
    assert.equal(
      daemon.computerUsePreviews.get(cwd, "session-1")?.status,
      "succeeded",
    );

    const events = await getJson(
      `${baseUrl}/computer-use/events?cwd=${encodeURIComponent(cwd)}&afterSeq=0`,
      { "X-Ling-Computer-Use-Token": COMPUTER_USE_ROUTE_TOKEN },
    );
    assert.deepEqual(
      events.events.map((event) => event.projection?.status),
      ["running", "stopping", "succeeded"],
    );
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

test("Computer Use desktop bridge handshake proves workspace and scoped route authority", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-computer-use-handshake-authority-"));
  const sharedToken = "desktop-shared-authority-token-0123456789";
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    { desktopBridgeToken: sharedToken, computerUseRouteToken: sharedToken },
  );
  await daemon.start();
  try {
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/computer-use/desktop-bridge/handshake`, {
      headers: { "X-Ling-Desktop-Bridge-Token": sharedToken },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.protocolVersion, 1);
    assert.deepEqual(body.capabilities, ["preview-source", "cua-driver-lease-v1"]);
    assert.equal(body.bridgeTokenAccepted, true);
    assert.equal(body.routeTokenAccepted, true);
    assert.equal(body.defaultWorkspaceCwd, cwd);
    assert.equal(typeof body.daemonAuthorityEpoch, "string");
    assert.equal(typeof body.bridgeConnectionId, "string");
    assert.equal(body.desktopInstanceEpoch, 1);
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Computer Use desktop bridge handshake rejects separated or missing scoped route authority", async (t) => {
  const sharedToken = "desktop-shared-authority-token-0123456789";
  for (const testCase of [
    { label: "separated", routeToken: "different-computer-use-route-token" },
    { label: "missing", routeToken: "" },
  ]) {
    await t.test(testCase.label, async () => {
      const cwd = await mkdtemp(resolve(tmpdir(), `ling-stack-computer-use-handshake-${testCase.label}-`));
      const daemon = createDaemonServer(
        { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
        { desktopBridgeToken: sharedToken, computerUseRouteToken: testCase.routeToken },
      );
      await daemon.start();
      try {
        const address = daemon.server.address();
        assert.ok(address && typeof address === "object");
        const response = await fetch(`http://127.0.0.1:${address.port}/computer-use/desktop-bridge/handshake`, {
          headers: { "X-Ling-Desktop-Bridge-Token": sharedToken },
        });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.bridgeTokenAccepted, true);
        assert.equal(body.routeTokenAccepted, false);
        assert.equal(body.defaultWorkspaceCwd, cwd);
      } finally {
        await daemon.stop();
        await rm(cwd, { recursive: true, force: true });
      }
    });
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

test("Windows private source revalidates the current HWND owner before renewing the descriptor", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-computer-use-windows-owner-"));
  const desktopBridgeToken = "desktop-bridge-windows-owner-test-token";
  const { capture, storeFactory } = createCapturedStoreFactory();
  let ownerPid = 4321;
  const mcpBroker = {
    async callTool(_server, _options, toolName, input) {
      assert.equal(toolName, "list_windows");
      assert.deepEqual(input, { pid: 4321 });
      return {
        content: [],
        details: {
          structuredContent: {
            windows: [{ pid: ownerPid, window_id: "7788" }],
          },
        },
      };
    },
  };
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    {
      desktopBridgeToken,
      computerUseRouteToken: COMPUTER_USE_ROUTE_TOKEN,
      mcpBroker,
      storeFactory,
    },
  );
  await daemon.start();
  try {
    assert.ok(capture.store);
    seedManagedCuaProvider(capture.store, {
      pluginHealthDetails: {
        driverVersion: "0.8.3",
        platform: "win32",
        overall: "ok",
        checks: [
          "binary_version",
          "platform_supported",
          "session_active",
          "ax_capability",
          "screen_capture_capability",
        ].map((name) => ({ name, status: "pass" })),
      },
    });
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    daemon.computerUsePreviews.upsert(cwd, projection());
    daemon.computerUsePreviews.registerPrivateDescriptor(cwd, {
      descriptorId: "opaque-preview-1",
      revision: 1,
      platform: "windows",
      sourceKind: "window",
      target: { processId: 4321, nativeWindowId: "7788" },
      authorization: {
        grantId: "windows-owner-grant",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    });
    const sourceUrl = `${baseUrl}/computer-use/sessions/session-1/source?cwd=${encodeURIComponent(cwd)}`;
    const accepted = await fetch(sourceUrl, {
      headers: { "X-Ling-Desktop-Bridge-Token": desktopBridgeToken },
    });
    assert.equal(accepted.status, 200);

    ownerPid = 9999;
    const rejected = await fetch(sourceUrl, {
      headers: { "X-Ling-Desktop-Bridge-Token": desktopBridgeToken },
    });
    assert.equal(rejected.status, 404);
    assert.equal(
      (await rejected.json()).error,
      "computer_use_descriptor_target_owner_mismatch",
    );
    ownerPid = 4321;
    const revoked = await fetch(sourceUrl, {
      headers: { "X-Ling-Desktop-Bridge-Token": desktopBridgeToken },
    });
    assert.equal(revoked.status, 404);
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("bundled embedded private source revalidates ownership through the canonical lease client", {
  skip: !supportedDesktopPlatform,
}, async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-computer-use-embedded-source-"));
  const desktopBridgeToken = "desktop-bridge-embedded-source-test-token";
  const { capture, storeFactory } = createCapturedStoreFactory();
  let providerCalls = 0;
  let blockProviderCall = false;
  const providerCallStarted = deferred();
  const releaseProviderCall = deferred();
  const daemon = createDaemonServer(
    {
      host: "127.0.0.1",
      port: 0,
      defaultWorkspaceCwd: cwd,
      cuaDriver: {
        bundledEmbedded: {
          darwin: process.platform === "darwin",
          win32: process.platform === "win32",
        },
        packagedProvider: {
          darwin: process.platform === "darwin",
          win32: process.platform === "win32",
        },
      },
    },
    {
      desktopBridgeToken,
      computerUseRouteToken: COMPUTER_USE_ROUTE_TOKEN,
      storeFactory,
      cuaDriverLeaseClientFactory: {
        async connect() {
          return {
            async check(server, checkedAt) {
              return { statusSnapshot: embeddedReadyStatus(server.id, checkedAt, 0) };
            },
            async checkHealth(server, checkedAt) {
              return { statusSnapshot: embeddedReadyStatus(server.id, checkedAt, 0) };
            },
            async listTools(server, checkedAt) {
              return {
                statusSnapshot: embeddedReadyStatus(server.id, checkedAt, 1),
                tools: [embeddedListWindowsTool()],
              };
            },
            async callTool(_server, toolName, input) {
              assert.equal(toolName, "list_windows");
              assert.deepEqual(input, { pid: 4321 });
              providerCalls += 1;
              if (blockProviderCall) {
                providerCallStarted.resolve();
                await releaseProviderCall.promise;
              }
              return {
                content: [],
                details: {
                  structuredContent: {
                    windows: [{
                      pid: 4321,
                      window_id: process.platform === "darwin" ? 7788 : "7788",
                    }],
                  },
                },
              };
            },
            async close() {},
          };
        },
      },
    },
  );
  await daemon.start();
  try {
    assert.ok(capture.store);
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const requested = await fetch(
      `${baseUrl}/plugins/${encodeURIComponent("trusted-local:cua-driver")}/enable?cwd=${encodeURIComponent(cwd)}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    );
    assert.equal(requested.status, 409);

    const handshake = await fetch(`${baseUrl}/computer-use/desktop-bridge/handshake`, {
      headers: { "X-Ling-Desktop-Bridge-Token": desktopBridgeToken },
    });
    assert.equal(handshake.status, 200);
    const authority = await handshake.json();
    const lease = embeddedLease(authority, cwd);
    const published = await fetch(
      `${baseUrl}/desktop/capabilities/cua-driver/lease?cwd=${encodeURIComponent(cwd)}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Ling-Desktop-Bridge-Token": desktopBridgeToken,
        },
        body: JSON.stringify(lease),
      },
    );
    assert.equal(published.status, 200);
    await waitForCondition(
      () => capture.store.getMcpServer("mcp_cua_driver")?.enabled === true,
    );

    const targetProofUrl =
      `${baseUrl}/computer-use/provider-target/verify?cwd=${encodeURIComponent(cwd)}`;
    const unauthorizedTargetProof = await fetch(targetProofUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: process.platform === "darwin" ? "macos" : "windows",
        processId: 4321,
        nativeWindowId: "7788",
      }),
    });
    assert.equal(unauthorizedTargetProof.status, 403);
    const targetProof = await fetch(targetProofUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ling-Desktop-Bridge-Token": desktopBridgeToken,
      },
      body: JSON.stringify({
        platform: process.platform === "darwin" ? "macos" : "windows",
        processId: 4321,
        nativeWindowId: "7788",
      }),
    });
    const targetProofText = await targetProof.text();
    assert.equal(targetProof.status, 200, targetProofText);
    const targetProofBody = JSON.parse(targetProofText);
    assert.equal(targetProofBody.verified, true);
    assert.deepEqual(targetProofBody.target, {
      platform: process.platform === "darwin" ? "macos" : "windows",
      processId: 4321,
      nativeWindowId: "7788",
    });
    assert.equal(targetProofBody.runtime.desktopInstanceId, lease.desktopInstanceId);
    assert.equal(targetProofBody.runtime.desktopInstanceEpoch, lease.desktopInstanceEpoch);
    assert.equal(targetProofBody.runtime.generation, lease.generation);
    assert.equal(targetProofBody.runtime.lockDigest, lease.lockDigest);
    assert.equal(targetProofBody.runtime.providerSealDigest, lease.providerSealDigest);
    assert.equal(providerCalls, 1);

    daemon.computerUsePreviews.upsert(cwd, projection());
    daemon.computerUsePreviews.registerPrivateDescriptor(cwd, {
      ...privateDescriptor(),
      platform: process.platform === "darwin" ? "macos" : "windows",
    });
    const source = await fetch(
      `${baseUrl}/computer-use/sessions/session-1/source?cwd=${encodeURIComponent(cwd)}`,
      { headers: { "X-Ling-Desktop-Bridge-Token": desktopBridgeToken } },
    );
    assert.equal(source.status, 200, await source.text());
    assert.equal(providerCalls, 2);

    blockProviderCall = true;
    const staleTargetProofPromise = fetch(targetProofUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ling-Desktop-Bridge-Token": desktopBridgeToken,
      },
      body: JSON.stringify({
        platform: process.platform === "darwin" ? "macos" : "windows",
        processId: 4321,
        nativeWindowId: "7788",
      }),
    });
    await providerCallStarted.promise;
    const replacement = {
      ...lease,
      generation: 2,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const replaced = await fetch(
      `${baseUrl}/desktop/capabilities/cua-driver/lease?cwd=${encodeURIComponent(cwd)}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Ling-Desktop-Bridge-Token": desktopBridgeToken,
        },
        body: JSON.stringify(replacement),
      },
    );
    assert.equal(replaced.status, 200);
    releaseProviderCall.resolve();
    const staleTargetProof = await staleTargetProofPromise;
    assert.equal(staleTargetProof.status, 409);
    assert.equal(
      (await staleTargetProof.json()).error,
      "computer_use_provider_target_owner_mismatch",
    );
    assert.equal(providerCalls, 3);
  } finally {
    releaseProviderCall.resolve();
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("private source cancels provider ownership when the HTTP client disconnects", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-computer-use-source-client-abort-"));
  const desktopBridgeToken = "desktop-bridge-source-client-abort-token";
  const { capture, storeFactory } = createCapturedStoreFactory();
  let activeProviderCalls = 0;
  let markProviderCallStarted;
  const providerCallStarted = new Promise((resolveStarted) => {
    markProviderCallStarted = resolveStarted;
  });
  let markProviderCallCancelled;
  const providerCallCancelled = new Promise((resolveCancelled) => {
    markProviderCallCancelled = resolveCancelled;
  });
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    {
      desktopBridgeToken,
      storeFactory,
      mcpBroker: {
        async callTool(_server, options) {
          activeProviderCalls += 1;
          markProviderCallStarted();
          return new Promise((resolveCall, rejectCall) => {
            const cancel = () => {
              activeProviderCalls -= 1;
              markProviderCallCancelled();
              rejectCall(options.signal?.reason ?? new Error("provider ownership cancelled"));
            };
            if (options.signal?.aborted) {
              cancel();
              return;
            }
            options.signal?.addEventListener("abort", cancel, { once: true });
          });
        },
      },
    },
  );
  await daemon.start();
  try {
    assert.ok(capture.store);
    seedManagedCuaProvider(capture.store);
    daemon.computerUsePreviews.upsert(cwd, projection());
    daemon.computerUsePreviews.registerPrivateDescriptor(cwd, privateDescriptor());
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const sourceUrl = `http://127.0.0.1:${address.port}/computer-use/sessions/session-1/source?cwd=${encodeURIComponent(cwd)}`;
    const controller = new AbortController();
    const request = fetch(sourceUrl, {
      headers: { "X-Ling-Desktop-Bridge-Token": desktopBridgeToken },
      signal: controller.signal,
    }).catch((error) => error);
    await providerCallStarted;
    assert.equal(activeProviderCalls, 1);

    controller.abort();
    await withTimeout(providerCallCancelled, 1_000);
    await request;

    assert.equal(activeProviderCalls, 0);
    assert.ok(
      daemon.computerUsePreviews.resolvePrivateDescriptor(cwd, "opaque-preview-1", 1),
      "client cancellation is not evidence that the provider lost target ownership",
    );
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("private source bounds slow provider ownership with a server deadline", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-computer-use-source-provider-deadline-"));
  const desktopBridgeToken = "desktop-bridge-source-provider-deadline-token";
  const { capture, storeFactory } = createCapturedStoreFactory();
  let activeProviderCalls = 0;
  let markProviderCallCancelled;
  const providerCallCancelled = new Promise((resolveCancelled) => {
    markProviderCallCancelled = resolveCancelled;
  });
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    {
      desktopBridgeToken,
      storeFactory,
      computerUseTargetOwnershipTimeoutMs: 50,
      mcpBroker: {
        async callTool(_server, options) {
          activeProviderCalls += 1;
          return new Promise((resolveCall, rejectCall) => {
            const cancel = () => {
              activeProviderCalls -= 1;
              markProviderCallCancelled();
              rejectCall(options.signal?.reason ?? new Error("provider ownership deadline"));
            };
            if (options.signal?.aborted) {
              cancel();
              return;
            }
            options.signal?.addEventListener("abort", cancel, { once: true });
          });
        },
      },
    },
  );
  await daemon.start();
  try {
    assert.ok(capture.store);
    seedManagedCuaProvider(capture.store);
    daemon.computerUsePreviews.upsert(cwd, projection());
    daemon.computerUsePreviews.registerPrivateDescriptor(cwd, privateDescriptor());
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const sourceUrl = `http://127.0.0.1:${address.port}/computer-use/sessions/session-1/source?cwd=${encodeURIComponent(cwd)}`;

    const response = await fetch(sourceUrl, {
      headers: { "X-Ling-Desktop-Bridge-Token": desktopBridgeToken },
    });
    assert.equal(response.status, 504);
    assert.equal(
      (await response.json()).error,
      "computer_use_descriptor_target_validation_timeout",
    );
    await withTimeout(providerCallCancelled, 1_000);
    assert.equal(activeProviderCalls, 0);
    assert.ok(
      daemon.computerUsePreviews.resolvePrivateDescriptor(cwd, "opaque-preview-1", 1),
      "a provider timeout must not revoke an otherwise current descriptor",
    );
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("private source rejects a descriptor revoked while provider ownership is being checked", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-computer-use-source-revocation-race-"));
  const desktopBridgeToken = "desktop-bridge-source-revocation-race-token";
  const { capture, storeFactory } = createCapturedStoreFactory();
  let releaseOwnerCheck;
  let markOwnerCheckStarted;
  const ownerCheckStarted = new Promise((resolveStarted) => {
    markOwnerCheckStarted = resolveStarted;
  });
  const ownerCheckGate = new Promise((resolveOwnerCheck) => {
    releaseOwnerCheck = resolveOwnerCheck;
  });
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    {
      desktopBridgeToken,
      storeFactory,
      mcpBroker: {
        async callTool() {
          markOwnerCheckStarted();
          await ownerCheckGate;
          return {
            content: [],
            details: { structuredContent: { windows: [{ pid: 4321, window_id: "7788" }] } },
          };
        },
      },
    },
  );
  await daemon.start();
  try {
    assert.ok(capture.store);
    seedManagedCuaProvider(capture.store);
    daemon.computerUsePreviews.upsert(cwd, projection());
    daemon.computerUsePreviews.registerPrivateDescriptor(cwd, privateDescriptor());
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const sourceUrl = `http://127.0.0.1:${address.port}/computer-use/sessions/session-1/source?cwd=${encodeURIComponent(cwd)}`;
    const request = fetch(sourceUrl, {
      headers: { "X-Ling-Desktop-Bridge-Token": desktopBridgeToken },
    });
    await ownerCheckStarted;

    daemon.computerUsePreviews.upsert(cwd, projection({
      status: "succeeded",
      updatedAt: "2026-07-15T00:02:00.000Z",
    }));
    releaseOwnerCheck();

    const response = await request;
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, "computer_use_descriptor_not_found");
  } finally {
    releaseOwnerCheck?.();
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("private source rejects a descriptor revision replaced while provider ownership is being checked", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-computer-use-source-revision-race-"));
  const desktopBridgeToken = "desktop-bridge-source-revision-race-token";
  const { capture, storeFactory } = createCapturedStoreFactory();
  let releaseOwnerCheck;
  let markOwnerCheckStarted;
  const ownerCheckStarted = new Promise((resolveStarted) => {
    markOwnerCheckStarted = resolveStarted;
  });
  const ownerCheckGate = new Promise((resolveOwnerCheck) => {
    releaseOwnerCheck = resolveOwnerCheck;
  });
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    {
      desktopBridgeToken,
      storeFactory,
      mcpBroker: {
        async callTool() {
          markOwnerCheckStarted();
          await ownerCheckGate;
          return {
            content: [],
            details: { structuredContent: { windows: [{ pid: 4321, window_id: "7788" }] } },
          };
        },
      },
    },
  );
  await daemon.start();
  try {
    assert.ok(capture.store);
    seedManagedCuaProvider(capture.store);
    daemon.computerUsePreviews.upsert(cwd, projection());
    daemon.computerUsePreviews.registerPrivateDescriptor(cwd, privateDescriptor());
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const sourceUrl = `http://127.0.0.1:${address.port}/computer-use/sessions/session-1/source?cwd=${encodeURIComponent(cwd)}`;
    const request = fetch(sourceUrl, {
      headers: { "X-Ling-Desktop-Bridge-Token": desktopBridgeToken },
    });
    await ownerCheckStarted;

    daemon.computerUsePreviews.registerPrivateDescriptor(cwd, {
      ...privateDescriptor(),
      revision: 2,
      target: { processId: 4321, nativeWindowId: "8899" },
    });
    daemon.computerUsePreviews.upsert(cwd, projection({
      revision: 2,
      updatedAt: "2026-07-15T00:02:00.000Z",
    }));
    releaseOwnerCheck();

    const response = await request;
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, "computer_use_descriptor_not_found");
    assert.equal(
      daemon.computerUsePreviews.resolvePrivateDescriptor(cwd, "opaque-preview-1", 2)?.target.nativeWindowId,
      "8899",
    );
  } finally {
    releaseOwnerCheck?.();
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("an old owner mismatch cannot revoke a newer descriptor revision", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-computer-use-source-owner-revision-race-"));
  const desktopBridgeToken = "desktop-bridge-source-owner-revision-race-token";
  const { capture, storeFactory } = createCapturedStoreFactory();
  let releaseOwnerCheck;
  let markOwnerCheckStarted;
  const ownerCheckStarted = new Promise((resolveStarted) => {
    markOwnerCheckStarted = resolveStarted;
  });
  const ownerCheckGate = new Promise((resolveOwnerCheck) => {
    releaseOwnerCheck = resolveOwnerCheck;
  });
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    {
      desktopBridgeToken,
      storeFactory,
      mcpBroker: {
        async callTool() {
          markOwnerCheckStarted();
          await ownerCheckGate;
          return {
            content: [],
            details: { structuredContent: { windows: [] } },
          };
        },
      },
    },
  );
  await daemon.start();
  try {
    assert.ok(capture.store);
    seedManagedCuaProvider(capture.store);
    daemon.computerUsePreviews.upsert(cwd, projection());
    daemon.computerUsePreviews.registerPrivateDescriptor(cwd, privateDescriptor());
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const sourceUrl = `http://127.0.0.1:${address.port}/computer-use/sessions/session-1/source?cwd=${encodeURIComponent(cwd)}`;
    const request = fetch(sourceUrl, {
      headers: { "X-Ling-Desktop-Bridge-Token": desktopBridgeToken },
    });
    await ownerCheckStarted;

    daemon.computerUsePreviews.registerPrivateDescriptor(cwd, {
      ...privateDescriptor(),
      revision: 2,
      target: { processId: 4321, nativeWindowId: "8899" },
    });
    daemon.computerUsePreviews.upsert(cwd, projection({
      revision: 2,
      updatedAt: "2026-07-15T00:02:00.000Z",
    }));
    releaseOwnerCheck();

    const response = await request;
    assert.equal(response.status, 404);
    assert.equal(
      (await response.json()).error,
      "computer_use_descriptor_target_owner_mismatch",
    );
    assert.equal(
      daemon.computerUsePreviews.resolvePrivateDescriptor(cwd, "opaque-preview-1", 2)?.target.nativeWindowId,
      "8899",
    );
  } finally {
    releaseOwnerCheck?.();
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("private source rejects a Cua server shared by bundled and legacy plugin owners", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-computer-use-shared-provider-owner-"));
  const desktopBridgeToken = "desktop-bridge-shared-provider-owner-token";
  const { capture, storeFactory } = createCapturedStoreFactory();
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    {
      desktopBridgeToken,
      computerUseRouteToken: COMPUTER_USE_ROUTE_TOKEN,
      storeFactory,
      mcpBroker: {
        async callTool() {
          return {
            content: [],
            details: { windows: [{ pid: 4321, window_id: "7788" }] },
          };
        },
      },
    },
  );
  await daemon.start();
  try {
    assert.ok(capture.store);
    seedManagedCuaProvider(capture.store);
    addLegacyCuaProviderOwner(capture.store);
    daemon.computerUsePreviews.upsert(cwd, projection());
    daemon.computerUsePreviews.registerPrivateDescriptor(cwd, {
      descriptorId: "opaque-preview-1",
      revision: 1,
      platform: "macos",
      sourceKind: "window",
      target: { processId: 4321, nativeWindowId: "7788" },
      authorization: {
        grantId: "shared-provider-owner-grant",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    });
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const sourceUrl = `${baseUrl}/computer-use/sessions/session-1/source?cwd=${encodeURIComponent(cwd)}`;
    const rejected = await fetch(sourceUrl, {
      headers: { "X-Ling-Desktop-Bridge-Token": desktopBridgeToken },
    });
    assert.equal(rejected.status, 404);
    assert.equal((await rejected.json()).error, "computer_use_descriptor_target_owner_mismatch");
    assert.equal(
      daemon.computerUsePreviews.resolvePrivateDescriptor(cwd, "opaque-preview-1", 1),
      undefined,
    );
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

function privateDescriptor(overrides = {}) {
  return {
    descriptorId: "opaque-preview-1",
    revision: overrides.revision ?? 1,
    platform: "macos",
    sourceKind: "window",
    target: overrides.target ?? { processId: 4321, nativeWindowId: "7788" },
    authorization: { grantId: "source-race-grant", expiresAt: "2099-01-01T00:00:00.000Z" },
  };
}

function embeddedLease(authority, cwd) {
  return {
    schemaVersion: 1,
    providerId: "cua-driver",
    desktopInstanceId: "desktop-computer-use-source",
    desktopInstanceEpoch: authority.desktopInstanceEpoch,
    bridgeConnectionId: authority.bridgeConnectionId,
    generation: 1,
    daemonAuthorityEpoch: authority.daemonAuthorityEpoch,
    workspaceCwd: cwd,
    endpoint: "http://127.0.0.1:43123/mcp",
    providerVersion: "0.8.3",
    distributionRevision: "ling.1",
    integrationMode: "embedded-stdio",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    lockDigest: "a".repeat(64),
    providerSealDigest: "b".repeat(64),
    ...(process.platform === "win32" ? { providerCatalogDigest: "c".repeat(64) } : {}),
    platform: process.platform,
    architecture: process.arch === "x64" ? "x86_64" : "arm64",
    integrityCoverage: "standard",
  };
}

function embeddedReadyStatus(serverId, checkedAt, toolCount) {
  return {
    serverId,
    checkedAt,
    expiresAt: new Date(Date.parse(checkedAt) + 300_000).toISOString(),
    status: "ready",
    toolCount,
    missingSecretRefs: [],
    authStatus: { kind: "not_required", refs: [], missingRefs: [] },
  };
}

function embeddedListWindowsTool() {
  return {
    rawName: "list_windows",
    displayName: "List windows",
    inputSchema: { type: "object" },
    callableNamespace: "mcp_cua_driver",
    callableName: "list_windows",
    sideEffectLevel: "read",
    defaultApproval: "allow",
    enabled: true,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitForCondition(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.fail("Timed out waiting for bundled Cua Driver readiness");
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
