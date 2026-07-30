import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  CuaDriverLeasePublisher,
  HttpCuaDriverLeaseClient,
} from "../dist/main/cua-driver/lease-publisher.js";

test("lease publisher single-flights publication and renews the exact generation", async () => {
  const calls = [];
  let now = new Date("2026-07-18T00:00:00.000Z");
  const client = {
    async publish(lease) {
      calls.push({ type: "publish", lease });
    },
    async revoke(revoke) {
      calls.push({ type: "revoke", revoke });
    },
  };
  const publisher = new CuaDriverLeasePublisher({
    client,
    lease: leaseTemplate(),
    ttlMs: 3_000,
    renewIntervalMs: 1_000,
    clock: () => now,
  });
  const [first, second] = await Promise.all([publisher.publish(), publisher.publish()]);
  assert.equal(first.generation, 9);
  assert.deepEqual(first, second);
  assert.equal(calls.filter((call) => call.type === "publish").length, 1);
  now = new Date("2026-07-18T00:00:01.000Z");
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.ok(calls.filter((call) => call.type === "publish").length >= 2);
  await publisher.revoke();
  assert.equal(calls.at(-1).type, "revoke");
  assert.equal(calls.at(-1).revoke.generation, 9);
});

test("revoke fences an in-flight publication and prevents stale renewal", async () => {
  let releasePublish;
  let publishStarted;
  const publishGate = new Promise((resolve) => {
    releasePublish = resolve;
  });
  const calls = [];
  const client = {
    async publish(lease) {
      publishStarted?.();
      await publishGate;
      calls.push({ type: "publish", lease });
    },
    async revoke(revoke) {
      calls.push({ type: "revoke", revoke });
    },
  };
  const publisher = new CuaDriverLeasePublisher({ client, lease: leaseTemplate(), ttlMs: 5_000, renewIntervalMs: 1_000 });
  const started = new Promise((resolve) => {
    publishStarted = resolve;
  });
  const pendingPublish = publisher.publish();
  await started;
  const pendingRevoke = publisher.revoke();
  releasePublish();
  await assert.rejects(pendingPublish, /lease_publish_superseded|lease_revoked/);
  await pendingRevoke;
  assert.equal(calls.filter((call) => call.type === "publish").length, 1);
  assert.equal(publisher.lastLease, undefined);
  assert.equal(calls.at(-1).type, "revoke");
});

test("negotiated readiness details republish the same generation without changing authority", async () => {
  const leases = [];
  const publisher = new CuaDriverLeasePublisher({
    client: {
      async publish(lease) { leases.push(lease); },
      async revoke() {},
    },
    lease: leaseTemplate(),
    ttlMs: 30_000,
    renewIntervalMs: 20_000,
  });
  await publisher.publish();
  await publisher.publishReadinessDetails({
    integrity: "verified",
    permissions: {
      accessibility: "granted",
      screenRecording: "granted",
      capturable: true,
    },
  });
  assert.equal(leases.length, 2);
  assert.equal(leases[0].generation, leases[1].generation);
  assert.equal(leases[1].integrity, "verified");
  assert.equal(leases[1].permissions.capturable, true);
  await publisher.revoke();
});

test("HTTP lease client requires loopback and sends bridge token plus workspace-bound route", async () => {
  const requests = [];
  const client = new HttpCuaDriverLeaseClient({
    daemonBaseUrl: "http://127.0.0.1:17891",
    bridgeToken: "bridge-token",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(null, { status: 204 });
    },
  });
  await client.publish({ ...leaseTemplate(), expiresAt: "2026-07-18T00:01:00.000Z" });
  await client.revoke({
    schemaVersion: 1,
    providerId: "cua-driver",
    desktopInstanceId: "desktop-1",
    desktopInstanceEpoch: 4,
    bridgeConnectionId: "bridge-1",
    generation: 9,
    daemonAuthorityEpoch: "authority-1",
    workspaceCwd: "/workspace/one",
  });
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /\/desktop\/capabilities\/cua-driver\/lease/);
  assert.match(requests[0].url, /cwd=%2Fworkspace%2Fone/);
  assert.equal(requests[0].init.headers["X-Ling-Desktop-Bridge-Token"], "bridge-token");
  assert.equal(requests[1].init.method, "DELETE");
  assert.throws(
    () => new HttpCuaDriverLeaseClient({ daemonBaseUrl: "https://example.com", bridgeToken: "x" }),
    /lease_daemon_must_be_loopback/,
  );
});

test("HTTP lease client consumes bounded success and error response bodies", async () => {
  const responses = [
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
    new Response(JSON.stringify({ error: "rejected" }), { status: 503 }),
  ];
  const client = new HttpCuaDriverLeaseClient({
    daemonBaseUrl: "http://127.0.0.1:17891",
    bridgeToken: "bridge-token",
    fetch: async () => responses.shift(),
  });
  const success = responses[0];
  await client.publish({ ...leaseTemplate(), expiresAt: "2026-07-18T00:01:00.000Z" });
  assert.equal(success.bodyUsed, true);

  const rejected = responses[0];
  await assert.rejects(
    client.publish({ ...leaseTemplate(), expiresAt: "2026-07-18T00:01:00.000Z" }),
    /lease_http_503/,
  );
  assert.equal(rejected.bodyUsed, true);
});

test("HTTP lease client rejects an oversized daemon response without buffering it", async () => {
  const response = new Response(new Uint8Array(64 * 1024 + 1), { status: 200 });
  const client = new HttpCuaDriverLeaseClient({
    daemonBaseUrl: "http://127.0.0.1:17891",
    bridgeToken: "bridge-token",
    fetch: async () => response,
  });
  await assert.rejects(
    client.publish({ ...leaseTemplate(), expiresAt: "2026-07-18T00:01:00.000Z" }),
    /lease_response_body_invalid/,
  );
  assert.equal(response.bodyUsed, true);
});

test("HTTP lease client rejects redirects without forwarding its bridge token or body", async (t) => {
  let targetRequests = 0;
  let redirectRequests = 0;
  let redirectStatus = 307;
  const target = createServer((_request, response) => {
    targetRequests += 1;
    response.writeHead(204).end();
  });
  const targetPort = await listen(target);
  const redirect = createServer((_request, response) => {
    redirectRequests += 1;
    response.writeHead(redirectStatus, { location: `http://127.0.0.1:${targetPort}/captured` }).end();
  });
  const redirectPort = await listen(redirect);
  t.after(async () => {
    await Promise.all([closeServer(redirect), closeServer(target)]);
  });
  const client = new HttpCuaDriverLeaseClient({
    daemonBaseUrl: `http://127.0.0.1:${redirectPort}`,
    bridgeToken: "super-secret-bridge-token",
  });

  for (const status of [301, 302, 307, 308]) {
    redirectStatus = status;
    await assert.rejects(
      client.publish({ ...leaseTemplate(), expiresAt: "2026-07-18T00:01:00.000Z" }),
      /lease_daemon_unavailable/,
    );
  }
  assert.equal(redirectRequests, 4);
  assert.equal(targetRequests, 0);
});

function leaseTemplate() {
  return {
    schemaVersion: 1,
    providerId: "cua-driver",
    desktopInstanceId: "desktop-1",
    desktopInstanceEpoch: 4,
    bridgeConnectionId: "bridge-1",
    generation: 9,
    daemonAuthorityEpoch: "authority-1",
    workspaceCwd: "/workspace/one",
    endpoint: "http://127.0.0.1:43123/mcp",
    providerVersion: "0.8.3",
    distributionRevision: "ling.1",
    integrationMode: "embedded-stdio",
    lockDigest: "a".repeat(64),
    providerSealDigest: "b".repeat(64),
    platform: "darwin",
    architecture: "arm64",
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}
