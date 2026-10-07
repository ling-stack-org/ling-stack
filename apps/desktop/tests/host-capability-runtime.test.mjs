import assert from "node:assert/strict";
import test from "node:test";
import { HostCapabilityDaemonClientError } from "../dist/main/host-capabilities/daemon-client.js";
import { HostCapabilityRuntime } from "../dist/main/host-capabilities/runtime.js";

test("Host runtime publishes availability and performs claim-begin-preview-result in order", async () => {
  const calls = [];
  const command = fixtureCommand();
  let delivered = false;
  const client = {
    async publishAvailability(value) { calls.push(["availability", value]); },
    async claim(signal) {
      if (!delivered) { delivered = true; return command; }
      await untilAborted(signal);
      return undefined;
    },
    async begin(id) { calls.push(["begin", id]); },
    async complete(result) { calls.push(["complete", result]); },
  };
  let previewClosed = false;
  const previewManager = {
    async launch(value) {
      calls.push(["preview", value.id]);
      return { window: {}, close() { previewClosed = true; } };
    },
    async close() { calls.push(["preview-manager-close"]); },
  };
  const runtime = new HostCapabilityRuntime({
    daemonBaseUrl: "http://127.0.0.1:17891",
    bridgeToken: "secret",
    desktopInstanceId: "desktop-runtime",
    daemonClientFactory: () => client,
    previewManager,
    now: () => Date.parse("2026-09-10T00:00:00.000Z"),
    heartbeatMs: 60_000,
    errorBackoffMs: 1,
  });

  await runtime.start();
  await waitFor(() => calls.some(([kind]) => kind === "complete"));
  const result = calls.find(([kind]) => kind === "complete")[1];
  assert.deepEqual(calls.slice(0, 4).map(([kind]) => kind), ["availability", "begin", "preview", "complete"]);
  assert.equal(result.ok, true);
  assert.equal(result.receipt.path, "index.html");
  assert.equal(result.receipt.visibility, "unverified");
  assert.equal(previewClosed, false);
  await runtime.stop();
  assert.equal(calls.at(-1)[0], "preview-manager-close");
});

test("Host runtime rolls back a launched preview and retries a lost result acknowledgement", async () => {
  const command = fixtureCommand();
  let delivered = false;
  let completeCalls = 0;
  let launchClosed = false;
  const client = {
    async publishAvailability() {},
    async claim(signal) {
      if (!delivered) { delivered = true; return command; }
      await untilAborted(signal);
      return undefined;
    },
    async begin() {},
    async complete() {
      completeCalls += 1;
      throw new Error("host_capability_daemon_request_failed");
    },
  };
  const runtime = new HostCapabilityRuntime({
    daemonBaseUrl: "http://127.0.0.1:17891",
    bridgeToken: "secret",
    desktopInstanceId: "desktop-runtime",
    daemonClientFactory: () => client,
    previewManager: {
      async launch() { return { window: {}, close() { launchClosed = true; } }; },
      async close() {},
    },
    heartbeatMs: 60_000,
    errorBackoffMs: 1,
  });
  await runtime.start();
  await waitFor(() => completeCalls >= 6);
  assert.equal(completeCalls, 6, "three success acknowledgements and three failure acknowledgements are bounded");
  assert.equal(launchClosed, true);
  await runtime.stop();
});

test("Host runtime re-registers authority after a daemon restart before the heartbeat", async () => {
  const command = fixtureCommand();
  let availabilityCount = 0;
  let lostAuthority = false;
  let delivered = false;
  const completed = [];
  const runtime = new HostCapabilityRuntime({
    daemonBaseUrl: "http://127.0.0.1:17891",
    bridgeToken: "secret",
    desktopInstanceId: "desktop-runtime",
    daemonClientFactory: () => ({
      async publishAvailability() { availabilityCount += 1; },
      async claim(signal) {
        if (!lostAuthority) {
          lostAuthority = true;
          throw new HostCapabilityDaemonClientError("request_rejected", "host_capability_authority_invalid");
        }
        if (availabilityCount < 2) throw new HostCapabilityDaemonClientError("request_rejected", "host_capability_authority_invalid");
        if (!delivered) { delivered = true; return command; }
        await untilAborted(signal);
        return undefined;
      },
      async begin() {},
      async complete(result) { completed.push(result); },
    }),
    previewManager: { async launch() { return { window: {}, close() {} }; }, async close() {} },
    heartbeatMs: 60_000,
    errorBackoffMs: 1,
  });
  try {
    await runtime.start();
    await waitFor(() => completed.length === 1);
    assert.equal(availabilityCount, 2);
    assert.equal(completed[0].ok, true);
  } finally {
    await runtime.stop();
  }
});

test("Host runtime restart rebinds authority without closing the reusable preview manager", async () => {
  let clientCount = 0;
  let availabilityCount = 0;
  let previewCloseCount = 0;
  const previewManager = {
    async launch() { return { window: {}, close() {} }; },
    async close() { previewCloseCount += 1; },
  };
  const runtime = new HostCapabilityRuntime({
    daemonBaseUrl: "http://127.0.0.1:17891",
    bridgeToken: "secret",
    desktopInstanceId: "desktop-restart-test",
    daemonClientFactory: () => {
      clientCount += 1;
      return {
        async publishAvailability() { availabilityCount += 1; },
        async claim(signal) { return await untilAborted(signal); },
        async begin() {},
        async complete() {},
      };
    },
    previewManager,
    heartbeatMs: 60_000,
    errorBackoffMs: 1,
  });

  await runtime.start();
  await runtime.restart();
  assert.equal(clientCount, 2);
  assert.equal(availabilityCount, 2);
  assert.equal(previewCloseCount, 0);
  await runtime.stop();
  assert.equal(previewCloseCount, 1);
});

function fixtureCommand() {
  return {
    protocol: "ling-host-capability-bridge/v1",
    id: "command-1",
    capabilityId: "host.open_local_target",
    path: "index.html",
    absolutePath: "/tmp/workspace/index.html",
    workspaceRoot: "/tmp/workspace",
    presentation: "interactive_html",
    runId: "run-1",
    attemptId: "attempt-1",
    toolCallId: "tool-1",
    approvalId: "approval-1",
    deadlineAt: "2099-01-01T00:00:00.000Z",
    idempotencyKey: "idempotency-1",
  };
}

async function untilAborted(signal) {
  if (signal.aborted) return;
  await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for Host runtime.");
}
