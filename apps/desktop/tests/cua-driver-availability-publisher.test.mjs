import assert from "node:assert/strict";
import test from "node:test";

import {
  CuaDriverAvailabilityPublisher,
  CuaDriverAvailabilityPublisherError,
  HttpCuaDriverAvailabilityClient,
  createAvailabilityReport,
} from "../dist/main/cua-driver/availability-publisher.js";

test("availability report forbids ready and removes content-bearing reasons", () => {
  const authority = darwinAuthority();
  const report = createAvailabilityReport(authority, {
    lifecycle: "failed",
    providerState: "permission_required",
    generation: 4,
    reason: "/Users/alice/private/provider failed",
  }, 2);

  assert.equal(report.providerState, "permission_required");
  assert.equal(report.reason, "availability_reason_redacted");
  assert.equal(Object.isFrozen(report), true);
  assert.throws(
    () => createAvailabilityReport(authority, {
      lifecycle: "active",
      providerState: "ready",
      generation: 4,
    }, 3),
    /availability_ready_forbidden/,
  );
});

test("availability report preserves every non-ready state and exact Win32 metadata", () => {
  for (const providerState of [
    "included",
    "permission_required",
    "interactive_session_required",
    "platform_unavailable",
    "incompatible",
    "corrupt",
    "desktop_unavailable",
  ]) {
    const report = createAvailabilityReport(darwinAuthority(), {
      lifecycle: "failed",
      providerState,
      generation: 5,
      reason: "safe.reason:1",
    }, 7);
    assert.equal(report.providerState, providerState);
    assert.equal(report.reason, "safe.reason:1");
  }

  const limitations = ["elevated_pixel_input", "uwp_send_input"];
  const win32 = createAvailabilityReport({
    ...darwinAuthority(),
    platform: "win32",
    integrityCoverage: "standard",
    limitations,
  }, {
    lifecycle: "failed",
    providerState: "interactive_session_required",
    generation: 8,
  }, 1);
  limitations.splice(0);
  assert.deepEqual(win32.limitations, ["elevated_pixel_input", "uwp_send_input"]);
  assert.equal(win32.integrityCoverage, "standard");
  assert.throws(
    () => createAvailabilityReport(darwinAuthority(), {
      lifecycle: "failed",
      providerState: "unknown",
      generation: 1,
    }, 1),
    /availability_state_invalid/,
  );
  assert.throws(
    () => createAvailabilityReport({ ...darwinAuthority(), desktopInstanceId: "" }, {
      lifecycle: "failed",
      providerState: "included",
      generation: 1,
    }, 1),
    /availability_contract_invalid/,
  );
});

test("publisher serializes same-generation reports with monotonic sequence", async () => {
  const releases = [];
  const reports = [];
  const client = {
    async publish(report) {
      reports.push(report);
      await new Promise((resolve) => releases.push(resolve));
    },
  };
  const publisher = new CuaDriverAvailabilityPublisher({
    client,
    authority: darwinAuthority(),
  });

  const first = publisher.publish({
    lifecycle: "included",
    providerState: "included",
    generation: 1,
  });
  const second = publisher.publish({
    lifecycle: "failed",
    providerState: "platform_unavailable",
    generation: 1,
    reason: "darwin_capture_unavailable",
  });
  await waitFor(() => reports.length === 1);
  assert.equal(reports[0].sequence, 1);
  releases.shift()();
  await waitFor(() => reports.length === 2);
  assert.equal(reports[1].sequence, 2);
  releases.shift()();
  await Promise.all([first, second]);

  await publisher.close();
  await publisher.publish({
    lifecycle: "failed",
    providerState: "corrupt",
    generation: 2,
  });
  assert.equal(reports.length, 2);
});

test("HTTP availability client uses only the authenticated loopback route", async () => {
  const requests = [];
  const client = new HttpCuaDriverAvailabilityClient({
    daemonBaseUrl: "http://127.0.0.1:17891",
    bridgeToken: "bridge-token",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response("{}", { status: 200 });
    },
  });
  const report = createAvailabilityReport(darwinAuthority(), {
    lifecycle: "failed",
    providerState: "permission_required",
    generation: 2,
    reason: "darwin_accessibility_permission_required",
  }, 1);

  await client.publish(report);

  assert.equal(requests.length, 1);
  const url = new URL(requests[0].url);
  assert.equal(url.pathname, "/desktop/capabilities/cua-driver/availability");
  assert.deepEqual(url.searchParams.getAll("cwd"), ["/workspace"]);
  assert.equal(requests[0].init.method, "PUT");
  assert.equal(requests[0].init.headers["X-Ling-Desktop-Bridge-Token"], "bridge-token");
  assert.deepEqual(JSON.parse(requests[0].init.body), report);
});

test("HTTP availability client fails closed on remote, unauthenticated, invalid, and unavailable calls", async () => {
  assert.throws(
    () => new HttpCuaDriverAvailabilityClient({
      daemonBaseUrl: "https://daemon.example",
      bridgeToken: "bridge-token",
    }),
    /availability_daemon_must_be_loopback/,
  );
  assert.throws(
    () => new HttpCuaDriverAvailabilityClient({
      daemonBaseUrl: "http://127.0.0.1:17891",
      bridgeToken: "",
    }),
    /availability_bridge_token_missing/,
  );

  const unavailable = new HttpCuaDriverAvailabilityClient({
    daemonBaseUrl: "http://localhost:17891/base",
    bridgeToken: "bridge-token",
    fetch: async () => { throw new Error("offline"); },
  });
  await assert.rejects(
    unavailable.publish(createAvailabilityReport(darwinAuthority(), {
      lifecycle: "failed",
      providerState: "desktop_unavailable",
      generation: 1,
    }, 1)),
    (error) => error instanceof CuaDriverAvailabilityPublisherError
      && error.code === "availability_daemon_unavailable",
  );

  const rejected = new HttpCuaDriverAvailabilityClient({
    daemonBaseUrl: "http://[::1]:17891",
    bridgeToken: "bridge-token",
    fetch: async () => new Response("{}", { status: 503 }),
  });
  await assert.rejects(
    rejected.publish(createAvailabilityReport(darwinAuthority(), {
      lifecycle: "failed",
      providerState: "corrupt",
      generation: 1,
    }, 1)),
    (error) => error instanceof CuaDriverAvailabilityPublisherError
      && error.code === "availability_http_503",
  );
  await assert.rejects(
    rejected.publish({ providerState: "ready" }),
    (error) => error instanceof CuaDriverAvailabilityPublisherError
      && error.code === "availability_contract_invalid",
  );
});

test("publisher recovers after failure, isolates diagnostics, and drains before close", async () => {
  const reports = [];
  const errors = [];
  const release = deferred();
  let calls = 0;
  const publisher = new CuaDriverAvailabilityPublisher({
    authority: darwinAuthority(),
    client: {
      async publish(report) {
        calls += 1;
        reports.push(report);
        if (calls === 1) throw new Error("first publish failed");
        await release.promise;
      },
    },
    onError(error, report) {
      errors.push({ error, report });
      throw new Error("diagnostic sink failed");
    },
  });

  await assert.rejects(publisher.publish({
    lifecycle: "failed",
    providerState: "platform_unavailable",
    generation: 1,
  }), /first publish failed/);
  const second = publisher.publish({
    lifecycle: "failed",
    providerState: "permission_required",
    generation: 1,
  });
  const closed = publisher.close();
  await waitFor(() => reports.length === 2);
  assert.equal(reports[1].sequence, 2);
  assert.equal(errors.length, 1);
  let closeSettled = false;
  void closed.then(() => { closeSettled = true; });
  await Promise.resolve();
  assert.equal(closeSettled, false);
  release.resolve();
  await Promise.all([second, closed]);

  await publisher.publish({
    lifecycle: "active",
    providerState: "ready",
    generation: 2,
  });
  assert.equal(reports.length, 2);
});

function darwinAuthority() {
  return {
    desktopInstanceId: "desktop-a",
    desktopInstanceEpoch: 2,
    bridgeConnectionId: "bridge-a",
    daemonAuthorityEpoch: "authority-a",
    workspaceCwd: "/workspace",
    platform: "darwin",
    limitations: [],
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition_not_met");
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}
