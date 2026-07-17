import assert from "node:assert/strict";
import test from "node:test";
import { LingDaemonClient } from "../dist/index.js";

test("Computer Use client sends structured list and stop requests", async () => {
  const requests = [];
  const client = new LingDaemonClient({
    baseUrl: "http://daemon.test",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).includes("/stop")) {
        return Response.json({
          sessionId: "session-1",
          accepted: true,
          acknowledged: true,
          auditId: "audit-1",
          projection: projection("cancelled"),
          acknowledgedAt: "2026-07-15T00:02:00.000Z",
        });
      }
      return Response.json({ cwd: "/workspace", projections: [projection("running")] });
    },
  });

  const listed = await client.listComputerUsePreviews("/workspace");
  assert.equal(listed.projections[0].status, "running");
  const stopped = await client.stopComputerUse("/workspace", "session-1", { reason: "operator_requested" });
  assert.equal(stopped.acknowledged, true);
  assert.match(requests[0].url, /computer-use\/sessions\?cwd=%2Fworkspace/);
  assert.match(requests[1].url, /computer-use\/sessions\/session-1\/stop\?cwd=%2Fworkspace/);
  assert.equal(JSON.parse(requests[1].init.body).reason, "operator_requested");
});

test("Computer Use stream forwards the abort signal to fetch", async () => {
  let receivedSignal;
  const client = new LingDaemonClient({
    baseUrl: "http://daemon.test",
    fetch: async (_url, init) => {
      receivedSignal = init.signal;
      return new Response(new ReadableStream(), {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  const controller = new AbortController();
  await client.streamComputerUsePreviews("/workspace", 7, controller.signal);
  assert.equal(receivedSignal, controller.signal);
});

test("Computer Use native requests carry only the scoped route token", async () => {
  const requests = [];
  const client = new LingDaemonClient({
    baseUrl: "http://daemon.test",
    computerUseRouteToken: "route-secret",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      const pathname = new URL(String(url)).pathname;
      if (String(url).includes("/stream")) {
        return new Response(new ReadableStream(), {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      if (String(url).includes("/stop")) {
        return Response.json({
          sessionId: "session-1",
          accepted: true,
          acknowledged: true,
          auditId: "audit-1",
          projection: projection("cancelled"),
        });
      }
      if (pathname === "/computer-use/snapshot") {
        return Response.json({ cwd: "/workspace", projections: [], latestSeq: 0 });
      }
      if (pathname === "/computer-use/events") {
        return Response.json({ cwd: "/workspace", afterSeq: 3, latestSeq: 3, events: [] });
      }
      return Response.json({ cwd: "/workspace", projections: [] });
    },
  });

  await client.listComputerUsePreviews("/workspace");
  await client.getComputerUsePreviewSnapshot("/workspace");
  await client.listComputerUsePreviewEvents("/workspace", 3, 10);
  await client.streamComputerUsePreviews("/workspace", 4);
  await client.stopComputerUse("/workspace", "session-1");

  assert.equal(requests.length, 5);
  for (const request of requests) {
    const headers = new Headers(request.init?.headers);
    assert.equal(headers.get("X-Ling-Computer-Use-Token"), "route-secret");
    assert.equal(headers.get("X-Ling-Desktop-Bridge-Token"), null);
  }
});

test("Computer Use browser client does not invent a native route token", async () => {
  let receivedHeaders;
  const client = new LingDaemonClient({
    baseUrl: "http://daemon.test",
    fetch: async (_url, init) => {
      receivedHeaders = new Headers(init?.headers);
      return Response.json({ cwd: "/workspace", projections: [] });
    },
  });
  await client.listComputerUsePreviews("/workspace");
  assert.equal(receivedHeaders.get("X-Ling-Computer-Use-Token"), null);
});

test("Computer Use client rejects malformed daemon payloads before returning them", async () => {
  const client = new LingDaemonClient({
    baseUrl: "http://daemon.test",
    fetch: async (url) => {
      if (String(url).includes("/stop")) {
        return Response.json({
          sessionId: "session-1",
          accepted: true,
          acknowledged: true,
          auditId: "audit-1",
          projection: { ...projection("running"), sessionId: "other-session" },
        });
      }
      return Response.json({ cwd: "/wrong-workspace", projections: [projection("running")] });
    },
  });

  await assert.rejects(
    client.listComputerUsePreviews("/workspace"),
    /computer_use_list_response_invalid/,
  );
  await assert.rejects(
    client.stopComputerUse("/workspace", "session-1"),
    /computer_use_stop_response_invalid/,
  );
});

function projection(status) {
  return {
    sessionId: "session-1",
    conversationId: "conversation-1",
    status,
    target: { kind: "window", displayName: "Browser" },
    preview: { descriptorId: "opaque-1", revision: 1, cursorAvailable: true },
    startedAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:01:00.000Z",
  };
}
