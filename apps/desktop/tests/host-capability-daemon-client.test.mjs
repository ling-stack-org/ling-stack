import assert from "node:assert/strict";
import test from "node:test";
import { HOST_CAPABILITY_BRIDGE_PROTOCOL_V1 } from "@ling-stack/contracts";
import {
  HostCapabilityDaemonClient,
  HostCapabilityDaemonClientError,
} from "../dist/main/host-capabilities/daemon-client.js";

const authority = {
  desktopInstanceId: "desktop-test",
  generation: 7,
};

test("Host capability daemon client uses the authenticated claim-begin-result protocol", async () => {
  const requests = [];
  const command = fixtureCommand();
  const client = new HostCapabilityDaemonClient({
    daemonBaseUrl: "http://127.0.0.1:17891",
    bridgeToken: "bridge-secret",
    ...authority,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      requests.push({ url, init });
      if (url.pathname.endsWith("/claim")) return Response.json({ command });
      return Response.json({ accepted: true });
    },
  });
  const availability = {
    protocol: HOST_CAPABILITY_BRIDGE_PROTOCOL_V1,
    ...authority,
    capabilities: ["host.open_local_target"],
    checkedAt: "2026-09-10T00:00:00.000Z",
  };
  await client.publishAvailability(availability);
  assert.deepEqual(await client.claim(), command);
  await client.begin(command.id);
  await client.complete({
    protocol: HOST_CAPABILITY_BRIDGE_PROTOCOL_V1,
    id: command.id,
    ok: false,
    error: { code: "fixture_failure", message: "Fixture failure." },
  });

  assert.deepEqual(requests.map(({ url }) => url.pathname), [
    "/desktop/capabilities/host/availability",
    "/desktop/capabilities/host/commands/claim",
    `/desktop/capabilities/host/commands/${command.id}/begin`,
    `/desktop/capabilities/host/commands/${command.id}/result`,
  ]);
  assert.equal(new Headers(requests[0].init.headers).get("x-ling-desktop-bridge-token"), "bridge-secret");
  assert.equal(new Headers(requests[0].init.headers).get("x-ling-host-desktop-instance"), null);
  for (const request of requests.slice(1)) {
    const headers = new Headers(request.init.headers);
    assert.equal(headers.get("x-ling-host-desktop-instance"), authority.desktopInstanceId);
    assert.equal(headers.get("x-ling-host-generation"), String(authority.generation));
  }
});

test("Host capability daemon client rejects malformed and rejected responses without leaking bodies", async () => {
  const malformed = new HostCapabilityDaemonClient({
    daemonBaseUrl: "http://127.0.0.1:17891",
    bridgeToken: "bridge-secret",
    ...authority,
    fetch: async () => Response.json({ command: { unsafe: true } }),
  });
  await assert.rejects(
    malformed.claim(),
    (error) => error instanceof HostCapabilityDaemonClientError && error.clientCode === "invalid_response",
  );

  const rejected = new HostCapabilityDaemonClient({
    daemonBaseUrl: "http://127.0.0.1:17891",
    bridgeToken: "bridge-secret",
    ...authority,
    fetch: async () => Response.json({ error: "host_capability_authority_invalid", private: "do-not-copy" }, { status: 400 }),
  });
  await assert.rejects(
    rejected.claim(),
    (error) => error instanceof HostCapabilityDaemonClientError
      && error.clientCode === "request_rejected"
      && error.daemonCode === "host_capability_authority_invalid"
      && !error.message.includes("do-not-copy"),
  );
});

function fixtureCommand() {
  return {
    protocol: HOST_CAPABILITY_BRIDGE_PROTOCOL_V1,
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
    deadlineAt: "2026-09-10T00:01:00.000Z",
    idempotencyKey: "idempotency-1",
  };
}
