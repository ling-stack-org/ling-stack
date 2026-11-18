import assert from "node:assert/strict";
import test from "node:test";
import { createLockedControlDaemonClient } from "../dist/main/locked-computer-control/daemon-client.js";

const authority = { workspaceCwd: "/workspace", daemonAuthorityEpoch: "epoch", bridgeConnectionId: "connection", desktopInstanceEpoch: 1 };
test("current task uses the private bridge header and rejects expanded or oversized responses", async () => {
  for (const result of [{ runId: "run", computerUseSessionId: "scope" }, {},
    { runId: "run", computerUseSessionId: "scope", credential: "forbidden" }, { runId: " ", computerUseSessionId: "scope" }, "x".repeat(70_000)]) {
    const client = createLockedControlDaemonClient({
      daemonBaseUrl: "http://127.0.0.1:17891", workspaceCwd: "/workspace", bridgeToken: "bridge",
      async fetch(url, init) {
        assert.match(String(url), /desktop\/current-task$/u);
        assert.equal(new Headers(init?.headers).get("X-Ling-Desktop-Bridge-Token"), "bridge");
        assert.equal(new Headers(init?.headers).get("X-Ling-Computer-Use-Token"), null);
        assert.equal(init?.redirect, "error");
        assert.ok(init?.signal instanceof AbortSignal);
        assert.deepEqual(JSON.parse(String(init?.body)), { authority });
        return new Response(JSON.stringify(result));
      },
    });
    if (result === "x".repeat(70_000) || ("credential" in Object(result)) || Object(result).runId === " ") {
      await assert.rejects(client.currentTask(authority), /invalid_response/u);
    } else {
      assert.deepEqual(await client.currentTask(authority), Object.keys(result).length ? result : undefined);
    }
  }
});
