import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LingServerControlPlane } from "../dist/features/ling-server/control-plane.js";

test("self-hosted Ling Server control plane requires auth and preserves route fallback", async () => {
  const control = new LingServerControlPlane({ authToken: "server-token", now: () => "2026-11-21T00:00:00.000Z", transport: { stunUrls: ["stun:stun.ling.example:3478"], turnUrls: ["turns:turn.ling.example:443"], relaySharedSecret: "0123456789abcdef" } });
  const address = await control.start();
  try {
    const health = await fetch(`http://${address.host}:${address.port}/healthz`);
    assert.equal(health.status, 200);
    const unauthorized = await fetch(`http://${address.host}:${address.port}/v1/installations`, { method: "POST", body: "{}" });
    assert.equal(unauthorized.status, 401);
    const headers = { authorization: "Bearer server-token", "content-type": "application/json" };
    const installation = await fetch(`http://${address.host}:${address.port}/v1/installations`, { method: "POST", headers, body: JSON.stringify({ installationId: "install-1", serverOrigin: "https://ling.example", applicationKeyFingerprint: "server-fp", revision: 1, status: "active" }) });
    assert.equal(installation.status, 200);
    const binding = await fetch(`http://${address.host}:${address.port}/v1/bindings`, { method: "POST", headers, body: JSON.stringify({ bindingId: "binding-1", installationId: "install-1", gatewayId: "gateway-1", mobileDeviceId: "mobile-1", gatewayKeyFingerprint: "gateway-fp", mobileKeyFingerprint: "mobile-fp", epoch: 1, revision: 1, status: "active" }) });
    assert.equal(binding.status, 200);
    const route = await fetch(`http://${address.host}:${address.port}/v1/routes`, { method: "POST", headers, body: JSON.stringify({ action: "begin", route: { routeAttemptId: "route-1", bindingId: "binding-1", preferred: "direct", status: "checking", expiresAt: "2026-11-21T00:05:00.000Z" } }) });
    assert.equal(route.status, 200);
    const selected = await fetch(`http://${address.host}:${address.port}/v1/routes`, { method: "POST", headers, body: JSON.stringify({ action: "select", routeAttemptId: "route-1", selected: "direct" }) });
    assert.equal(selected.status, 200);
    const configUrl = `http://${address.host}:${address.port}/v1/routes/transport-config`;
    const configInput = { bindingId: "binding-1", routeAttemptId: "route-1", role: "mobile", localKeyFingerprint: "mobile-fp", remoteKeyFingerprint: "gateway-fp", expiresAt: "2026-11-21T00:04:00.000Z" };
    const config = await fetch(configUrl, { method: "POST", headers, body: JSON.stringify(configInput) });
    assert.equal(config.status, 200);
    assert.equal((await config.json()).route, "direct");
    const wrongKey = await fetch(configUrl, { method: "POST", headers, body: JSON.stringify({ ...configInput, localKeyFingerprint: "different-fingerprint" }) });
    assert.equal(wrongKey.status, 400);
    const diagnostics = await fetch(`http://${address.host}:${address.port}/v1/routes/diagnostics`, { method: "POST", headers, body: JSON.stringify({ bindingId: "binding-1", routeAttemptId: "route-1", diagnosticId: "diag-1", checks: [{ id: "control_reachability", status: "pass", code: "reachable" }] }) });
    assert.equal(diagnostics.status, 200);
    assert.equal((await diagnostics.json()).checks[0].code, "reachable");
    const failover = await fetch(`http://${address.host}:${address.port}/v1/routes`, { method: "POST", headers, body: JSON.stringify({ action: "failover", routeAttemptId: "route-1" }) });
    assert.equal((await failover.json()).preferred, "relay");
    const credentialUrl = `http://${address.host}:${address.port}/v1/routes/relay-credential`;
    const requestCredential = (role = "mobile") => fetch(credentialUrl, {
      method: "POST", headers, body: JSON.stringify({ bindingId: "binding-1", routeAttemptId: "route-1", role }),
    });
    assert.equal((await requestCredential("invalid")).status, 400);
    const relayResponse = await requestCredential();
    assert.equal(relayResponse.status, 200);
    assert.equal(relayResponse.headers.get("cache-control"), "no-store");
    const relay = await relayResponse.json() as { url: string; username: string; expiresAt: string };
    assert.equal(relay.url, "turns:turn.ling.example:443");
    assert.match(relay.username, /:[0-9a-f]{64}:mobile$/u);
    assert.equal(relay.expiresAt, "2026-11-21T00:05:00.000Z");
    const connectedRelay = await fetch(`http://${address.host}:${address.port}/v1/routes`, {
      method: "POST", headers, body: JSON.stringify({ action: "select", routeAttemptId: "route-1", selected: "relay" }),
    });
    assert.equal(connectedRelay.status, 200);
    const relayConfig = await fetch(configUrl, { method: "POST", headers, body: JSON.stringify(configInput) });
    assert.equal(relayConfig.status, 200);
    assert.deepEqual((await relayConfig.json()).relayCredential, relay);
    assert.equal((await fetch(configUrl, { method: "POST", headers, body: JSON.stringify({ ...configInput, relayCredential: {} }) })).status, 400);
    const revoke = await fetch(`http://${address.host}:${address.port}/v1/bindings/binding-1/revoke`, { method: "POST", headers, body: JSON.stringify({ revision: 2 }) });
    assert.equal(revoke.status, 200);
    assert.equal((await requestCredential()).status, 400);
    const oldRoute = await fetch(`http://${address.host}:${address.port}/v1/routes`, { method: "POST", headers, body: JSON.stringify({ action: "select", routeAttemptId: "route-1", selected: "relay" }) });
    assert.equal(oldRoute.status, 400);
  } finally {
    await control.stop();
  }
});

test("self-hosted Ling Server restores control metadata after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "ling-server-control-"));
  const databasePath = join(root, "server.sqlite");
  const first = new LingServerControlPlane({ authToken: "server-token", databasePath, now: () => "2026-11-21T00:00:00.000Z" });
  const firstAddress = await first.start();
  const headers = { authorization: "Bearer server-token", "content-type": "application/json" };
  try {
    const installation = await fetch(`http://${firstAddress.host}:${firstAddress.port}/v1/installations`, { method: "POST", headers, body: JSON.stringify({ installationId: "install-1", serverOrigin: "https://ling.example", applicationKeyFingerprint: "server-fp", revision: 1, status: "active" }) });
    assert.equal(installation.status, 200);
    const binding = await fetch(`http://${firstAddress.host}:${firstAddress.port}/v1/bindings`, { method: "POST", headers, body: JSON.stringify({ bindingId: "binding-1", installationId: "install-1", gatewayId: "gateway-1", mobileDeviceId: "mobile-1", gatewayKeyFingerprint: "gateway-fp", mobileKeyFingerprint: "mobile-fp", epoch: 1, revision: 1, status: "active" }) });
    assert.equal(binding.status, 200);
  } finally {
    await first.stop();
  }

  const second = new LingServerControlPlane({ authToken: "server-token", databasePath, now: () => "2026-11-21T00:00:00.000Z" });
  const secondAddress = await second.start();
  try {
    const route = await fetch(`http://${secondAddress.host}:${secondAddress.port}/v1/routes`, { method: "POST", headers, body: JSON.stringify({ action: "begin", route: { routeAttemptId: "route-1", bindingId: "binding-1", preferred: "direct", status: "checking", expiresAt: "2026-11-21T00:05:00.000Z" } }) });
    assert.equal(route.status, 200);
  } finally {
    await second.stop();
  }
});
