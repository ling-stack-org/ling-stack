import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { handleLockedControlDesktopRoute } from "../dist/features/computer-use/locked-control-routes.js";
import type { DaemonContext } from "../dist/context.js";

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
