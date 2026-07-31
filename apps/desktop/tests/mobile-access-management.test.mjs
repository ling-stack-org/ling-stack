import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveMobileAccessCsrfToken,
  deriveMobileAccessManagementCapability,
} from "../dist/main/mobile-access/authority.js";
import { DesktopMobileAccessClient } from "../dist/main/mobile-access/client.js";

test("mobile access management capability is stable and isolated from the Desktop bridge token", () => {
  const bridgeToken = "desktop-bridge-secret";
  const first = deriveMobileAccessManagementCapability(bridgeToken);
  const second = deriveMobileAccessManagementCapability(bridgeToken);

  assert.equal(first, second);
  assert.notEqual(first, bridgeToken);
  assert.notEqual(first, deriveMobileAccessManagementCapability("another-desktop-bridge-secret"));
  assert.throws(
    () => deriveMobileAccessManagementCapability("   "),
    /desktop_bridge_token_required_for_mobile_access/,
  );
});

test("Desktop mobile access client sends scoped authority without returning secrets to the renderer", async () => {
  const daemonBaseUrl = "http://127.0.0.1:17891";
  const bridgeToken = "desktop-bridge-secret";
  const capability = deriveMobileAccessManagementCapability(bridgeToken);
  const csrfToken = deriveMobileAccessCsrfToken(capability);
  const requests = [];
  const status = {
    enabled: true,
    gatewayOrigin: "https://ling-device.example.ts.net",
    gatewayFingerprint: "sha256:gateway-fingerprint",
    pairing: { state: "idle" },
    device: null,
  };
  const client = new DesktopMobileAccessClient({
    daemonBaseUrl,
    desktopBridgeToken: bridgeToken,
    fetch: async (input, init) => {
      requests.push({ url: String(input), init });
      return Response.json(status);
    },
  });

  const result = await client.enable(status.gatewayOrigin);
  const [{ url, init }] = requests;
  const headers = new Headers(init.headers);

  assert.equal(url, `${daemonBaseUrl}/v1/mobile-access/enable`);
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error");
  assert.equal(headers.get("Origin"), daemonBaseUrl);
  assert.equal(headers.get("X-Ling-Mobile-Management-Capability"), capability);
  assert.equal(headers.get("X-Ling-CSRF-Token"), csrfToken);
  assert.equal(headers.get("Content-Type"), "application/json");
  assert.deepEqual(JSON.parse(init.body), { gatewayOrigin: status.gatewayOrigin });
  assert.deepEqual(result, status);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${capability}|${csrfToken}|${bridgeToken}`, "u"));
});
