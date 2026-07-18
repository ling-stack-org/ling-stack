import assert from "node:assert/strict";
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
