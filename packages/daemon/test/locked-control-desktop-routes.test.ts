import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { handleLockedControlDesktopRoute } from "../dist/features/computer-use/locked-control-routes.js";
import type { DaemonContext } from "../dist/context.js";
import { DEFAULT_LOCKED_COMPUTER_CONTROL_POLICIES } from "@ling-stack/contracts";

const authority = { workspaceCwd: "/workspace", daemonAuthorityEpoch: "epoch", bridgeConnectionId: "bridge", desktopInstanceEpoch: 1 };

test("private current-task route requires Desktop authority and a unique live scope", async (t) => {
  let active = [{ runId: "run-1", sessionId: "session-1", status: "running" }];
  const context = {
    desktopBridgeToken: "bridge-token", config: { maxBodyBytes: 16_384 }, lockedComputerControl: {},
    cuaDriverDesktopBridgeAuthority: { isCurrentHandshake: (value: Record<string, unknown>) => Object.entries(authority).every(([key, expected]) => value[key] === expected) },
    computerUsePreviews: { list: () => active },
  } as unknown as DaemonContext;
  const server = createServer((request, response) => {
    void handleLockedControlDesktopRoute(request, response, new URL(request.url!, "http://localhost"), context)
      .catch(() => { response.writeHead(400); response.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/computer-use/locked-control/desktop/current-task`;
  const post = (body: unknown, headers: Record<string, string> = { "X-Ling-Desktop-Bridge-Token": "bridge-token" }) => fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  assert.equal((await post({ authority }, { "X-Ling-Computer-Use-Token": "bridge-token" })).status, 403);
  assert.equal((await post({ authority: { ...authority, bridgeConnectionId: "stale" } })).status, 409);
  assert.equal((await post({ authority, runId: "renderer-chosen" })).status, 400);
  const unique = await post({ authority });
  assert.equal(unique.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(await unique.json(), { runId: "run-1", computerUseSessionId: "session-1" });
  active = [...active, { runId: "run-2", sessionId: "session-2", status: "running" }];
  assert.deepEqual(await (await post({ authority })).json(), {});
  active = [{ runId: "run-1", sessionId: "session-1", status: "succeeded" }];
  assert.deepEqual(await (await post({ authority })).json(), {});
});

test("policy promotion accepts only the authenticated current Desktop handshake", async (t) => {
  const calls: unknown[] = [];
  const policy = DEFAULT_LOCKED_COMPUTER_CONTROL_POLICIES.darwin;
  const context = {
    desktopBridgeToken: "bridge-token", config: { maxBodyBytes: 16_384 },
    cuaDriverDesktopBridgeAuthority: { isCurrentHandshake: (value: Record<string, unknown>) => Object.entries(authority).every(([key, expected]) => value[key] === expected) },
    lockedComputerControl: { promotePolicy(input: unknown, buildId: string) {
      calls.push({ policy: input, buildId });
      return { accepted: true, snapshot: { revision: 1, projection: { schemaVersion: 1, capability: "disabled_by_build", phase: "off", reason: "locked_control_disabled_by_build" } } };
    } },
  } as unknown as DaemonContext;
  const server = createServer((request, response) => {
    void handleLockedControlDesktopRoute(request, response, new URL(request.url!, "http://localhost"), context)
      .catch(() => { response.writeHead(400); response.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/computer-use/locked-control/desktop/promote`;
  const post = (body: unknown, headers: Record<string, string> = { "X-Ling-Desktop-Bridge-Token": "bridge-token" }) => fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  const body = { authority, buildId: "build-1", policy };
  assert.equal((await post(body, { "X-Ling-Computer-Use-Token": "bridge-token" })).status, 403);
  assert.equal((await post(body, { "X-Ling-Desktop-Bridge-Token": "bridge-token", Origin: "https://remote.example" })).status, 403);
  assert.equal((await post({ ...body, authority: { ...authority, bridgeConnectionId: "stale" } })).status, 409);
  assert.equal((await post({ ...body, policy: { ...policy, consumeOnUnlock: false } })).status, 400);
  assert.equal((await post({ ...body, rendererApproved: true })).status, 400);
  assert.equal(calls.length, 0);
  const accepted = await post(body);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(calls, [{ policy, buildId: "build-1" }]);
});
