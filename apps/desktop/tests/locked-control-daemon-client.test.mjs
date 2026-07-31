import assert from "node:assert/strict";
import test from "node:test";
import {
  LockedControlDaemonClientError,
  createLockedControlDaemonClient,
} from "../dist/main/locked-computer-control/daemon-client.js";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const handshake = {
  daemonAuthorityEpoch: "authority-1",
  bridgeConnectionId: "bridge-1",
  desktopInstanceEpoch: 1,
  workspaceCwd: "/workspace",
};
const grantAuthority = {
  ...handshake,
  platform: "darwin",
  desktopInstanceId: "desktop-1",
  authorizedNormalGeneration: 3,
  osSessionBindingDigest: digestA,
  authorizedLockEpoch: 1,
  allowedLockedToolIdsDigest: digestB,
  normalGeneration: 3,
  lockEpoch: 0,
};
const projection = {
  schemaVersion: 1,
  capability: "supported_restricted",
  phase: "verifying",
};
const grant = {
  schemaVersion: 1,
  grantId: "grant-1",
  issuedAt: "2099-01-01T00:00:00.000Z",
  expiresAt: "2099-01-01T00:15:00.000Z",
  ttlSeconds: 900,
  workspaceCwd: "/workspace",
  runId: "run-1",
  computerUseSessionId: "session-1",
  platform: "darwin",
  desktopInstanceId: "desktop-1",
  desktopInstanceEpoch: 1,
  daemonAuthorityEpoch: "authority-1",
  bridgeConnectionId: "bridge-1",
  authorizedNormalGeneration: 3,
  osSessionBindingDigest: digestA,
  authorizedLockEpoch: 1,
  allowedLockedToolIdsDigest: digestB,
};

test("daemon client keeps renderer and Desktop authorities on separate headers", async () => {
  const requests = [];
  const client = createLockedControlDaemonClient({
    daemonBaseUrl: "http://127.0.0.1:17891",
    workspaceCwd: "/workspace",
    bridgeToken: "bridge-token",
    routeToken: "route-token",
    async fetch(url, init) {
      requests.push({ url: String(url), init });
      if (String(url).includes("/authorize")) {
        return jsonResponse({ accepted: false, reason: "locked_control_disabled_by_build", snapshot: { revision: 0, projection: { schemaVersion: 1, capability: "disabled_by_build", phase: "off", reason: "locked_control_disabled_by_build" } } }, 409);
      }
      return jsonResponse({ revision: 0, projection: { schemaVersion: 1, capability: "disabled_by_build", phase: "off", reason: "locked_control_disabled_by_build" } });
    },
  });

  await client.snapshot();
  const denied = await client.beginAuthorization({ requestId: "request-1", expectedRevision: 0 });
  assert.equal(denied.accepted, false);
  assert.equal(requests[0].init.headers["X-Ling-Computer-Use-Token"], "route-token");
  assert.equal(requests[1].init.headers["X-Ling-Computer-Use-Token"], "route-token");
  assert.match(requests[0].url, /cwd=%2Fworkspace/u);
});

test("prepare strips runtime-only fields and validates the returned grant", async () => {
  let body;
  const client = createLockedControlDaemonClient({
    daemonBaseUrl: "http://127.0.0.1:17891",
    workspaceCwd: "/workspace",
    bridgeToken: "bridge-token",
    async fetch(_url, init) {
      body = JSON.parse(init.body);
      return jsonResponse({ accepted: true, grant, snapshot: { revision: 2, projection } });
    },
  });
  const prepared = await client.prepare({
    requestId: "request-1",
    expectedRevision: 1,
    identity: {
      schemaVersion: 1,
      requestId: "request-1",
      status: "verified",
      method: "device_owner_authentication",
      verifiedAt: "2099-01-01T00:00:00.000Z",
    },
    authority: grantAuthority,
  });
  assert.equal(prepared.accepted, true);
  assert.deepEqual(Object.keys(body.authority).sort(), [
    "allowedLockedToolIdsDigest",
    "authorizedLockEpoch",
    "authorizedNormalGeneration",
    "bridgeConnectionId",
    "daemonAuthorityEpoch",
    "desktopInstanceEpoch",
    "desktopInstanceId",
    "osSessionBindingDigest",
    "platform",
    "workspaceCwd",
  ]);
  assert.equal(body.authority.normalGeneration, undefined);
  assert.equal(body.authority.lockEpoch, undefined);
});

test("daemon client rejects malformed canonical projections", async () => {
  const client = createLockedControlDaemonClient({
    daemonBaseUrl: "http://127.0.0.1:17891",
    workspaceCwd: "/workspace",
    bridgeToken: "bridge-token",
    async fetch() {
      return jsonResponse({ revision: 0, projection: { schemaVersion: 1, capability: "supported_restricted", phase: "armed" } });
    },
  });
  await assert.rejects(
    client.snapshot(),
    (error) => error instanceof LockedControlDaemonClientError && error.clientCode === "invalid_response",
  );
});

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
