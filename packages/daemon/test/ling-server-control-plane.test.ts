import assert from "node:assert/strict";
import test from "node:test";

import { LingServerControlPlane } from "../dist/features/ling-server/control-plane.js";

test("self-hosted Ling Server control plane requires auth and preserves route fallback", async () => {
  const control = new LingServerControlPlane({ authToken: "server-token", now: () => "2026-11-21T00:00:00.000Z" });
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
    const failover = await fetch(`http://${address.host}:${address.port}/v1/routes`, { method: "POST", headers, body: JSON.stringify({ action: "failover", routeAttemptId: "route-1" }) });
    assert.equal((await failover.json()).preferred, "relay");
  } finally {
    await control.stop();
  }
});
