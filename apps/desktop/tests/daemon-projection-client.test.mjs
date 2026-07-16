import assert from "node:assert/strict";
import test from "node:test";
import { DaemonComputerUseProjectionClient } from "../dist/main/computer-use/daemon-projection-client.js";

test("Computer Use projection subscription refreshes after a daemon epoch reset", async () => {
  const firstProjection = projection("session-a", "2026-07-15T00:00:01.000Z");
  const secondProjection = projection("session-b", "2026-07-15T00:00:02.000Z");
  const requests = [];
  let daemonRestarted = false;

  const fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.pathname === "/computer-use/snapshot") {
      return Response.json({
        cwd: "/workspace",
        projections: daemonRestarted ? [secondProjection] : [firstProjection],
        latestSeq: daemonRestarted ? 0 : 5,
      });
    }
    if (url.pathname === "/computer-use/stream") {
      const afterSeq = Number(url.searchParams.get("afterSeq") ?? "0");
      if (afterSeq === 5) {
        daemonRestarted = true;
        return sse("heartbeat", { latestSeq: 0 });
      }
      if (afterSeq === 0) {
        return sse("computer_use_event", {
          seq: 1,
          kind: "upsert",
          sessionId: secondProjection.sessionId,
          projection: secondProjection,
          occurredAt: secondProjection.updatedAt,
        });
      }
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const client = new DaemonComputerUseProjectionClient(
    "/workspace",
    "http://daemon.test",
    async (_milliseconds, signal) => {
      if (signal.aborted) {
        throw signal.reason;
      }
      await Promise.resolve();
    },
    fetch,
  );
  assert.deepEqual((await client.list()).map((item) => item.sessionId), ["session-a"]);

  const received = [];
  let subscription;
  const completed = new Promise((resolve) => {
    subscription = client.subscribe((event) => {
      received.push(event);
      if (event.kind === "upsert" && event.sessionId === "session-b" && event.seq === 1) {
        subscription.close();
        resolve();
      }
    });
  });
  await withTimeout(completed, 1_000);

  assert.deepEqual(
    received.slice(0, 2).map((event) => [event.kind, event.sessionId]),
    [["remove", "session-a"], ["upsert", "session-b"]],
  );
  const streamAfterSeq = requests
    .filter((url) => url.pathname === "/computer-use/stream")
    .map((url) => url.searchParams.get("afterSeq"));
  assert.deepEqual(streamAfterSeq, ["5", "0"]);
});

test("Computer Use projection subscription resets the same session after a silent daemon restart", async () => {
  const activeProjection = projection("session-a", "2026-07-15T00:00:01.000Z");
  const requests = [];
  let daemonRestarted = false;

  const fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.pathname === "/computer-use/snapshot") {
      return Response.json({
        cwd: "/workspace",
        projections: [activeProjection],
        latestSeq: daemonRestarted ? 0 : 5,
      });
    }
    if (url.pathname === "/computer-use/stream") {
      const afterSeq = Number(url.searchParams.get("afterSeq") ?? "0");
      if (afterSeq === 5) {
        daemonRestarted = true;
        return new Response("", { headers: { "Content-Type": "text/event-stream" } });
      }
      if (afterSeq === 0) {
        return sse("computer_use_event", {
          seq: 1,
          kind: "upsert",
          sessionId: activeProjection.sessionId,
          projection: activeProjection,
          occurredAt: activeProjection.updatedAt,
        });
      }
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const client = new DaemonComputerUseProjectionClient(
    "/workspace",
    "http://daemon.test",
    async (_milliseconds, signal) => {
      if (signal.aborted) {
        throw signal.reason;
      }
      await Promise.resolve();
    },
    fetch,
  );
  await client.list();

  const received = [];
  let subscription;
  const completed = new Promise((resolve) => {
    subscription = client.subscribe((event) => {
      received.push(event);
      if (event.kind === "upsert" && event.seq === 1) {
        subscription.close();
        resolve();
      }
    });
  });
  await withTimeout(completed, 1_000);

  assert.deepEqual(
    received.slice(0, 2).map((event) => [event.kind, event.sessionId, event.seq]),
    [["remove", "session-a", 0], ["upsert", "session-a", 0]],
  );
  const streamAfterSeq = requests
    .filter((url) => url.pathname === "/computer-use/stream")
    .map((url) => url.searchParams.get("afterSeq"));
  assert.deepEqual(streamAfterSeq, ["5", "0"]);
});

test("Computer Use projection snapshot cannot advance latestSeq past unseen state", async () => {
  const staleProjection = projection("session-race", "2026-07-15T00:00:01.000Z");
  const currentProjection = {
    ...staleProjection,
    status: "paused",
    updatedAt: "2026-07-15T00:00:02.000Z",
  };
  const requests = [];

  const fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.pathname === "/computer-use/snapshot") {
      return Response.json({
        cwd: "/workspace",
        projections: [currentProjection],
        latestSeq: 2,
      });
    }

    // These responses model the old two-request race: projections were read
    // before seq 2, then latestSeq advanced to 2. A client using these routes
    // would start the stream after the unseen paused projection.
    if (url.pathname === "/computer-use/sessions") {
      return Response.json({ cwd: "/workspace", projections: [staleProjection] });
    }
    if (url.pathname === "/computer-use/events") {
      return Response.json({ cwd: "/workspace", afterSeq: 0, latestSeq: 2, events: [] });
    }
    if (url.pathname === "/computer-use/stream") {
      assert.equal(url.searchParams.get("afterSeq"), "2");
      return sse("heartbeat", { latestSeq: 2 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const client = new DaemonComputerUseProjectionClient(
    "/workspace",
    "http://daemon.test",
    async (_milliseconds, signal) => {
      if (signal.aborted) {
        throw signal.reason;
      }
      await Promise.resolve();
    },
    fetch,
  );

  let subscription;
  const received = [];
  const completed = new Promise((resolve) => {
    subscription = client.subscribe((event) => {
      received.push(event);
      if (event.projection?.status === "paused") {
        subscription.close();
        resolve();
      }
    });
  });
  await withTimeout(completed, 1_000);

  assert.equal(received[0].projection.status, "paused");
  assert.deepEqual(
    requests.filter((url) => url.pathname !== "/computer-use/stream").map((url) => url.pathname),
    ["/computer-use/snapshot"],
  );
});

test("Desktop projection client scopes native snapshot, stream, and stop requests", async () => {
  const requests = [];
  const token = "desktop-computer-use-route-token";
  const fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, headers: new Headers(init?.headers) });
    if (url.pathname === "/computer-use/snapshot") {
      return Response.json({ cwd: "/workspace", projections: [], latestSeq: 0 });
    }
    if (url.pathname === "/computer-use/stream") {
      return sse("computer_use_event", {
        seq: 1,
        kind: "upsert",
        sessionId: "session-1",
        projection: projection("session-1", "2026-07-15T00:00:01.000Z"),
        occurredAt: "2026-07-15T00:00:01.000Z",
      });
    }
    if (url.pathname.endsWith("/stop")) {
      return Response.json({
        sessionId: "session-1",
        accepted: true,
        acknowledged: true,
        auditId: "audit-1",
        projection: projection("session-1", "2026-07-15T00:00:01.000Z"),
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const client = new DaemonComputerUseProjectionClient(
    "/workspace",
    "http://daemon.test",
    async (_milliseconds, signal) => {
      if (signal.aborted) {
        throw signal.reason;
      }
      await Promise.resolve();
    },
    fetch,
    token,
  );

  await client.list();
  let subscription;
  subscription = client.subscribe((event) => {
    if (event.kind === "upsert") {
      subscription.close();
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  subscription.close();
  await client.stop("session-1", "operator_requested");

  const computerUseRequests = requests.filter(({ url }) => url.pathname.startsWith("/computer-use/"));
  assert.ok(computerUseRequests.some(({ url }) => url.pathname === "/computer-use/snapshot"));
  assert.ok(computerUseRequests.some(({ url }) => url.pathname === "/computer-use/stream"));
  assert.ok(computerUseRequests.some(({ url }) => url.pathname.endsWith("/stop")));
  for (const { headers } of computerUseRequests) {
    assert.equal(headers.get("X-Ling-Computer-Use-Token"), token);
    assert.equal(headers.get("X-Ling-Desktop-Bridge-Token"), null);
  }
});

function projection(sessionId, updatedAt) {
  return {
    sessionId,
    conversationId: "conversation-1",
    runId: `run-${sessionId}`,
    status: "running",
    target: { kind: "window", displayName: "Example Browser" },
    preview: {
      descriptorId: `descriptor-${sessionId}`,
      revision: 1,
      aspectRatio: 1.6,
      cursorAvailable: false,
    },
    startedAt: "2026-07-15T00:00:00.000Z",
    updatedAt,
  };
}

function sse(event, data) {
  return new Response(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function withTimeout(promise, milliseconds) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Timed out waiting for projection event")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
