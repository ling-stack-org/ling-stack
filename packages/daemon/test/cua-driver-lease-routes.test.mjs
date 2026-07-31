import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createDaemonServer } from "../dist/index.js";
import { CuaDriverDesktopBridgeAuthority } from "../dist/features/computer-use/desktop-bridge-authority.js";

const DESKTOP_TOKEN = "desktop-lease-route-token-0123456789";
const BRIDGE_TOKEN_HEADER = "X-Ling-Desktop-Bridge-Token";

test("issuing a new handshake synchronously clears the previous registry lease", () => {
  const connectionIds = ["connection-1", "connection-2"];
  let authorityRotations = 0;
  const authority = new CuaDriverDesktopBridgeAuthority({
    workspaceCwd: "/tmp/ling-cua-authority",
    daemonAuthorityEpoch: "daemon-authority",
    createConnectionId: () => connectionIds.shift(),
    now: () => "2026-07-19T00:00:00.000Z",
    onAuthorityRotated: () => { authorityRotations += 1; },
  });
  const first = authority.issueAuthenticatedHandshake();
  assert.equal(authorityRotations, 0);
  const firstLease = lease(
    { ...first, defaultWorkspaceCwd: authority.workspaceCwd },
    { expiresAt: "2026-07-19T00:01:00.000Z" },
  );
  assert.equal(authority.publish(firstLease).accepted, true);
  assert.equal(authority.leaseRegistry.getCurrent(), firstLease);

  const unavailable = availability(
    { ...first, defaultWorkspaceCwd: authority.workspaceCwd },
    { generation: firstLease.generation, sequence: 1 },
  );
  assert.equal(authority.publishAvailability(unavailable).accepted, true);
  assert.equal(authority.leaseRegistry.getCurrent(), undefined);
  assert.equal(authority.getCurrentAvailability(), unavailable);
  assert.equal(authority.publishAvailability({ ...unavailable, sequence: 1 }).accepted, true);
  assert.equal(authority.publishAvailability({
    ...unavailable,
    sequence: 1,
    providerState: "permission_required",
  }).reason, "stale_sequence");

  const second = authority.issueAuthenticatedHandshake();
  assert.equal(authorityRotations, 1);
  assert.equal(second.desktopInstanceEpoch, 2);
  assert.equal(second.bridgeConnectionId, "connection-2");
  assert.equal(authority.leaseRegistry.getCurrent(), undefined);
  assert.equal(authority.getCurrentAvailability(), undefined);
  assert.equal(authority.isCurrentHandshake(firstLease), false);
});

test("availability authority rejects invalid identity, stale generations, and stale sequences", () => {
  const authority = new CuaDriverDesktopBridgeAuthority({
    workspaceCwd: "/tmp/ling-cua-availability-authority",
    daemonAuthorityEpoch: "daemon-availability-authority",
    createConnectionId: () => "availability-connection",
  });
  const handshakeAuthority = authority.issueAuthenticatedHandshake();
  const current = {
    ...handshakeAuthority,
    defaultWorkspaceCwd: authority.workspaceCwd,
  };
  const currentLease = lease(current, { generation: 3 });
  assert.equal(authority.publish(currentLease).accepted, true);

  assert.deepEqual(authority.publishAvailability({
    ...availability(current),
    providerState: "ready",
  }), { accepted: false, reason: "invalid" });
  assert.equal(authority.publishAvailability(availability(current, {
    desktopInstanceEpoch: 99,
  })).reason, "stale_generation");
  assert.equal(authority.publishAvailability(availability(current, {
    generation: 2,
  })).reason, "stale_generation");

  const accepted = availability(current, {
    generation: 3,
    sequence: 5,
    providerState: "permission_required",
  });
  assert.equal(authority.publishAvailability(accepted).accepted, true);
  assert.equal(authority.leaseRegistry.getCurrent(), undefined);
  assert.equal(authority.publishAvailability({
    ...accepted,
    generation: 2,
    sequence: 99,
  }).reason, "stale_generation");
  assert.equal(authority.publishAvailability({
    ...accepted,
    sequence: 4,
  }).reason, "stale_sequence");
  assert.equal(authority.publishAvailability({
    ...accepted,
    providerState: "corrupt",
  }).reason, "stale_sequence");
  const advanced = { ...accepted, sequence: 6, providerState: "corrupt" };
  assert.equal(authority.publishAvailability(advanced).accepted, true);
  assert.equal(authority.getCurrentAvailability(), advanced);
});

test("availability route authenticates, fences a current lease, and rejects stale sequence", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-cua-availability-route-"));
  const daemon = createDaemon(cwd);
  await daemon.start();
  try {
    const current = await handshake(daemon);
    const currentLease = lease(current);
    assert.equal((await putLease(daemon, currentLease)).status, 200);

    const first = availability(current, {
      generation: currentLease.generation,
      sequence: 1,
      providerState: "permission_required",
      reason: "darwin_accessibility_permission_required",
    });
    const accepted = await putAvailability(daemon, first);
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), {
      accepted: true,
      desktopInstanceEpoch: current.desktopInstanceEpoch,
      generation: currentLease.generation,
      sequence: 1,
      providerState: "permission_required",
    });

    const retried = await putAvailability(daemon, first);
    assert.equal(retried.status, 200, "an identical report retries a prior failed projection");

    const stale = await putAvailability(daemon, {
      ...first,
      providerState: "platform_unavailable",
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).reason, "stale_sequence");

    const wrongToken = await putAvailability(daemon, { ...first, sequence: 2 }, cwd, "wrong-token");
    assert.equal(wrongToken.status, 403);
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("availability route validates method, workspace, body, and current handshake", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-cua-availability-validation-"));
  const daemon = createDaemon(cwd);
  await daemon.start();
  try {
    const current = await handshake(daemon);
    const candidate = availability(current);
    const route = new URL(daemonUrl(daemon, "/desktop/capabilities/cua-driver/availability"));
    route.searchParams.set("cwd", cwd);

    const wrongMethod = await fetch(route, {
      method: "POST",
      headers: { [BRIDGE_TOKEN_HEADER]: DESKTOP_TOKEN },
    });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "PUT");

    const invalidBody = await fetch(route, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        [BRIDGE_TOKEN_HEADER]: DESKTOP_TOKEN,
      },
      body: "{",
    });
    assert.equal(invalidBody.status, 400);
    assert.equal((await invalidBody.json()).error, "invalid_cua_driver_lease_request");

    const missingWorkspace = await fetch(
      daemonUrl(daemon, "/desktop/capabilities/cua-driver/availability"),
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          [BRIDGE_TOKEN_HEADER]: DESKTOP_TOKEN,
        },
        body: JSON.stringify(candidate),
      },
    );
    assert.equal(missingWorkspace.status, 400);

    const wrongWorkspace = await putAvailability(daemon, candidate, `${cwd}-other`);
    assert.equal(wrongWorkspace.status, 409);
    assert.equal((await wrongWorkspace.json()).error, "cua_driver_lease_workspace_mismatch");

    await handshake(daemon);
    const staleHandshake = await putAvailability(daemon, candidate);
    assert.equal(staleHandshake.status, 409);
    assert.equal((await staleHandshake.json()).error, "cua_driver_lease_stale_handshake");
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("authenticated handshakes keep one daemon authority and issue monotonic unique bridge tuples", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-cua-lease-authority-"));
  const firstDaemon = createDaemon(cwd);
  await firstDaemon.start();
  let first;
  try {
    first = await handshake(firstDaemon);
    const second = await handshake(firstDaemon);
    assert.equal(first.protocolVersion, 1);
    assert.deepEqual(first.capabilities, ["preview-source", "cua-driver-lease-v1", "cua-driver-readiness-details-v1"]);
    assert.equal("workspaceCwd" in first, false);
    assert.equal(first.daemonAuthorityEpoch, second.daemonAuthorityEpoch);
    assert.equal(first.desktopInstanceEpoch, 1);
    assert.equal(second.desktopInstanceEpoch, 2);
    assert.notEqual(first.bridgeConnectionId, second.bridgeConnectionId);
  } finally {
    await firstDaemon.stop();
  }

  const restartedDaemon = createDaemon(cwd);
  await restartedDaemon.start();
  try {
    const restarted = await handshake(restartedDaemon);
    assert.notEqual(restarted.daemonAuthorityEpoch, first.daemonAuthorityEpoch);
    assert.equal(restarted.desktopInstanceEpoch, 1);
    assert.notEqual(restarted.bridgeConnectionId, first.bridgeConnectionId);

    const staleAfterRestart = await putLease(restartedDaemon, lease(first));
    assert.equal(staleAfterRestart.status, 409);
    assert.equal((await staleAfterRestart.json()).error, "cua_driver_lease_stale_handshake");
  } finally {
    await restartedDaemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("lease PUT and DELETE bind publish, renew, and revoke to the latest handshake tuple", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-cua-lease-fencing-"));
  const daemon = createDaemon(cwd);
  await daemon.start();
  try {
    const first = await handshake(daemon);
    const firstLease = lease(first);
    const published = await putLease(daemon, firstLease);
    assert.equal(published.status, 200);
    assert.deepEqual(await published.json(), {
      accepted: true,
      desktopInstanceEpoch: first.desktopInstanceEpoch,
      generation: 1,
      expiresAt: firstLease.expiresAt,
    });

    const renewedLease = {
      ...firstLease,
      expiresAt: new Date(Date.parse(firstLease.expiresAt) + 30_000).toISOString(),
    };
    const renewed = await putLease(daemon, renewedLease);
    assert.equal(renewed.status, 200);
    assert.equal((await renewed.json()).accepted, true);

    const staleGeneration = await putLease(daemon, {
      ...renewedLease,
      endpoint: "http://127.0.0.1:43124/mcp",
    });
    assert.equal(staleGeneration.status, 409);
    assert.deepEqual(await staleGeneration.json(), {
      accepted: false,
      error: "cua_driver_lease_rejected",
      reason: "stale_generation",
    });

    const expired = await putLease(daemon, {
      ...renewedLease,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    assert.equal(expired.status, 409);
    assert.deepEqual(await expired.json(), {
      accepted: false,
      error: "cua_driver_lease_rejected",
      reason: "expired",
    });

    const second = await handshake(daemon);
    const stalePublish = await putLease(daemon, { ...firstLease, generation: 2 });
    assert.equal(stalePublish.status, 409);
    assert.equal((await stalePublish.json()).error, "cua_driver_lease_stale_handshake");

    const staleRenew = await putLease(daemon, renewedLease);
    assert.equal(staleRenew.status, 409);
    assert.equal((await staleRenew.json()).error, "cua_driver_lease_stale_handshake");

    const staleRevoke = await deleteLease(daemon, revokeFor(firstLease));
    assert.equal(staleRevoke.status, 409);
    assert.equal((await staleRevoke.json()).error, "cua_driver_lease_stale_handshake");

    const wrongWorkspaceQuery = await putLease(daemon, lease(second), `${cwd}-other`);
    assert.equal(wrongWorkspaceQuery.status, 409);
    assert.equal((await wrongWorkspaceQuery.json()).error, "cua_driver_lease_workspace_mismatch");

    const wrongWorkspaceBody = await putLease(
      daemon,
      lease(second, { workspaceCwd: `${cwd}-other` }),
      cwd,
    );
    assert.equal(wrongWorkspaceBody.status, 409);
    assert.equal((await wrongWorkspaceBody.json()).error, "cua_driver_lease_stale_handshake");

    const currentLease = lease(second);
    const currentPublish = await putLease(daemon, currentLease);
    assert.equal(currentPublish.status, 200);

    const wrongRouteIdentity = await deleteLease(
      daemon,
      revokeFor(currentLease),
      { desktopInstanceEpoch: currentLease.desktopInstanceEpoch, generation: 2 },
    );
    assert.equal(wrongRouteIdentity.status, 400);
    assert.equal((await wrongRouteIdentity.json()).error, "invalid_cua_driver_lease_request");

    const revoked = await deleteLease(daemon, revokeFor(currentLease));
    assert.equal(revoked.status, 200);
    assert.deepEqual(await revoked.json(), {
      revoked: true,
      desktopInstanceEpoch: second.desktopInstanceEpoch,
      generation: 1,
    });
    const repeatedRevoke = await deleteLease(daemon, revokeFor(currentLease));
    assert.equal(repeatedRevoke.status, 200);
    assert.deepEqual(await repeatedRevoke.json(), {
      revoked: true,
      desktopInstanceEpoch: second.desktopInstanceEpoch,
      generation: 1,
    });
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("lease routes require local Desktop bridge authentication and a completed handshake", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-cua-lease-auth-"));
  const daemon = createDaemon(cwd);
  await daemon.start();
  try {
    const candidate = lease({
      defaultWorkspaceCwd: cwd,
      daemonAuthorityEpoch: "unknown-authority",
      bridgeConnectionId: "unknown-connection",
      desktopInstanceEpoch: 1,
    });
    const url = daemonUrl(daemon, "/desktop/capabilities/cua-driver/lease");
    const missing = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(candidate),
    });
    assert.equal(missing.status, 403);
    assert.equal((await missing.json()).error, "desktop_bridge_forbidden");

    const wrong = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        [BRIDGE_TOKEN_HEADER]: "wrong-token",
      },
      body: JSON.stringify(candidate),
    });
    assert.equal(wrong.status, 403);

    const remoteOrigin = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://remote.example",
        [BRIDGE_TOKEN_HEADER]: DESKTOP_TOKEN,
      },
      body: JSON.stringify(candidate),
    });
    assert.equal(remoteOrigin.status, 403);
    assert.equal((await remoteOrigin.json()).error, "forbidden_origin");

    const beforeHandshake = await putLease(daemon, candidate);
    assert.equal(beforeHandshake.status, 409);
    assert.equal((await beforeHandshake.json()).error, "cua_driver_lease_stale_handshake");

    const current = await handshake(daemon);
    const missingWorkspace = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        [BRIDGE_TOKEN_HEADER]: DESKTOP_TOKEN,
      },
      body: JSON.stringify(lease(current)),
    });
    assert.equal(missingWorkspace.status, 400);
    assert.equal((await missingWorkspace.json()).error, "invalid_cua_driver_lease_request");

    const duplicateWorkspaceUrl = new URL(url);
    duplicateWorkspaceUrl.searchParams.append("cwd", cwd);
    duplicateWorkspaceUrl.searchParams.append("cwd", cwd);
    const duplicateWorkspace = await fetch(duplicateWorkspaceUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        [BRIDGE_TOKEN_HEADER]: DESKTOP_TOKEN,
      },
      body: JSON.stringify(lease(current)),
    });
    assert.equal(duplicateWorkspace.status, 400);
    assert.equal((await duplicateWorkspace.json()).error, "invalid_cua_driver_lease_request");

    const currentUrl = new URL(url);
    currentUrl.searchParams.set("cwd", cwd);
    const invalid = await fetch(currentUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        [BRIDGE_TOKEN_HEADER]: DESKTOP_TOKEN,
      },
      body: JSON.stringify({ ...lease(current), generation: 0 }),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, "invalid_cua_driver_lease_request");
    assert.equal(invalid.headers.get("access-control-allow-origin"), null);
    assert.equal(invalid.headers.get("cache-control"), "no-store");

    for (const invalidLease of [
      lease(current, { integrityCoverage: "standard" }),
      lease(current, {
        platform: "win32",
        architecture: "x86_64",
        providerCatalogDigest: "c".repeat(64),
        integrityCoverage: undefined,
      }),
      lease(current, {
        platform: "win32",
        architecture: "x86_64",
        providerCatalogDigest: "c".repeat(64),
        integrityCoverage: "uiaccess",
      }),
    ]) {
      const response = await fetch(currentUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          [BRIDGE_TOKEN_HEADER]: DESKTOP_TOKEN,
        },
        body: JSON.stringify(invalidLease),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, "invalid_cua_driver_lease_request");
    }
  } finally {
    await daemon.stop();
  }

  const unavailable = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
    defaultWorkspaceCwd: cwd,
  });
  await unavailable.start();
  try {
    const response = await fetch(
      daemonUrl(unavailable, "/desktop/capabilities/cua-driver/lease"),
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          [BRIDGE_TOKEN_HEADER]: DESKTOP_TOKEN,
        },
        body: "{}",
      },
    );
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "desktop_bridge_unavailable");
  } finally {
    await unavailable.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

function createDaemon(cwd) {
  return createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    { desktopBridgeToken: DESKTOP_TOKEN, computerUseRouteToken: DESKTOP_TOKEN },
  );
}

async function handshake(daemon) {
  const response = await fetch(
    daemonUrl(daemon, "/computer-use/desktop-bridge/handshake"),
    { headers: { [BRIDGE_TOKEN_HEADER]: DESKTOP_TOKEN } },
  );
  assert.equal(response.status, 200);
  return response.json();
}

function lease(handshakeAuthority, overrides = {}) {
  return {
    schemaVersion: 1,
    providerId: "cua-driver",
    desktopInstanceId: "desktop-instance-a",
    desktopInstanceEpoch: handshakeAuthority.desktopInstanceEpoch,
    bridgeConnectionId: handshakeAuthority.bridgeConnectionId,
    generation: 1,
    daemonAuthorityEpoch: handshakeAuthority.daemonAuthorityEpoch,
    workspaceCwd: handshakeAuthority.defaultWorkspaceCwd,
    endpoint: "http://127.0.0.1:43123/mcp",
    providerVersion: "0.8.3",
    distributionRevision: "ling.1",
    integrationMode: "embedded-stdio",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    lockDigest: "a".repeat(64),
    providerSealDigest: "b".repeat(64),
    providerCatalogDigest: "c".repeat(64),
    platform: "darwin",
    architecture: "arm64",
    ...overrides,
  };
}

function revokeFor(value) {
  return {
    schemaVersion: 1,
    providerId: "cua-driver",
    desktopInstanceId: value.desktopInstanceId,
    desktopInstanceEpoch: value.desktopInstanceEpoch,
    bridgeConnectionId: value.bridgeConnectionId,
    generation: value.generation,
    daemonAuthorityEpoch: value.daemonAuthorityEpoch,
    workspaceCwd: value.workspaceCwd,
  };
}

function availability(handshakeAuthority, overrides = {}) {
  return {
    schemaVersion: 1,
    providerId: "cua-driver",
    desktopInstanceId: "desktop-instance-a",
    desktopInstanceEpoch: handshakeAuthority.desktopInstanceEpoch,
    bridgeConnectionId: handshakeAuthority.bridgeConnectionId,
    daemonAuthorityEpoch: handshakeAuthority.daemonAuthorityEpoch,
    workspaceCwd: handshakeAuthority.defaultWorkspaceCwd,
    generation: 1,
    sequence: 1,
    platform: "darwin",
    providerState: "platform_unavailable",
    reason: "darwin_platform_unavailable",
    limitations: [],
    ...overrides,
  };
}

function putLease(daemon, value, routeCwd = value.workspaceCwd) {
  const url = new URL(daemonUrl(daemon, "/desktop/capabilities/cua-driver/lease"));
  url.searchParams.set("cwd", routeCwd);
  return fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      [BRIDGE_TOKEN_HEADER]: DESKTOP_TOKEN,
    },
    body: JSON.stringify(value),
  });
}

function putAvailability(
  daemon,
  value,
  routeCwd = value.workspaceCwd,
  token = DESKTOP_TOKEN,
) {
  const url = new URL(daemonUrl(daemon, "/desktop/capabilities/cua-driver/availability"));
  url.searchParams.set("cwd", routeCwd);
  return fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      [BRIDGE_TOKEN_HEADER]: token,
    },
    body: JSON.stringify(value),
  });
}

function deleteLease(daemon, value, routeIdentity = value) {
  const url = new URL(
    daemonUrl(
      daemon,
      `/desktop/capabilities/cua-driver/lease/${routeIdentity.desktopInstanceEpoch}/${routeIdentity.generation}`,
    ),
  );
  url.searchParams.set("cwd", value.workspaceCwd);
  return fetch(url, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      [BRIDGE_TOKEN_HEADER]: DESKTOP_TOKEN,
    },
    body: JSON.stringify(value),
  });
}

function daemonUrl(daemon, pathname) {
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}${pathname}`;
}
